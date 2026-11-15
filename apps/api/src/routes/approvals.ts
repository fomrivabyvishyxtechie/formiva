import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  approvalDecideRequestSchema,
  approvalDelegateRequestSchema,
  approvalListQuerySchema,
  approvalParamsSchema,
  approvalRoundRequestSchema,
  caseValuesParamsSchema,
} from '@formiva/contracts';
import { audit, correlationOf, fail, jwtRoute, parse } from './route-helpers.js';

const DECISION = { approve: 'approved', reject: 'rejected', rework: 'rework_requested' } as const;

type Approval = {
  id: string;
  case_id: string;
  approver_user_id: string;
  workflow_step_key: string;
  round: number;
  decision: string;
};

/** Locks the case, then the approval row (always in this order), and checks the caller owns it. */
async function lockApproval(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  approvalId: string,
) {
  const first = await client.query(
    `SELECT case_id FROM approvals WHERE id = $1 AND workspace_id = $2`,
    [approvalId, workspaceId],
  );
  if (!first.rows[0]) fail(404, 'Approval not found.', 'not_found');
  const caseRow = (
    await client.query(`SELECT status FROM cases WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [
      first.rows[0].case_id,
      workspaceId,
    ])
  ).rows[0];
  const a = (
    await client.query<Approval>(
      `SELECT id, case_id, approver_user_id, workflow_step_key, round, decision
         FROM approvals WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [approvalId, workspaceId],
    )
  ).rows[0]!;
  if (a.approver_user_id !== userId)
    fail(403, 'This approval is assigned to someone else.', 'not_your_approval');
  return { a, caseStatus: caseRow.status as string };
}

/** The round is open only for the newest round of a case that is still waiting for approval. */
async function assertRoundOpen(client: PoolClient, a: Approval, caseStatus: string) {
  const r = await client.query(
    `SELECT max(round) AS latest,
            bool_or(decision IN ('rejected','rework_requested') AND round = $2) AS closed
       FROM approvals WHERE case_id = $1`,
    [a.case_id, a.round],
  );
  if (caseStatus !== 'approval_pending' || r.rows[0].latest !== a.round || r.rows[0].closed)
    fail(409, 'This approval round is closed.', 'round_closed');
}

/** Rework: a new backend routing decision and an open review task, so the case is not left without a queue entry. */
async function reopenForReview(
  client: PoolClient,
  workspaceId: string,
  caseId: string,
  key: string,
) {
  const latest = (
    await client.query(
      `SELECT id, rule_version, policy_version, document_id, ai_result_id FROM routing_decisions
        WHERE case_id = $1 AND workspace_id = $2 ORDER BY created_at DESC, id LIMIT 1`,
      [caseId, workspaceId],
    )
  ).rows[0];
  const id = randomUUID();
  await client.query(
    `INSERT INTO routing_decisions (id, workspace_id, case_id, document_id, ai_result_id, decision_key,
                                    rule_version, policy_version, action, route, reasons, supersedes_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approval_rework', 'human_review', '["approval_rework"]'::jsonb, $9)`,
    [
      id,
      workspaceId,
      caseId,
      latest?.document_id ?? null,
      latest?.ai_result_id ?? null,
      key,
      latest?.rule_version ?? 'approval-rework-v1',
      latest?.policy_version ?? 'approval-rework-v1',
      latest?.id ?? null,
    ],
  );
  await client.query(
    `INSERT INTO review_tasks (workspace_id, case_id, document_id, routing_decision_id, reason_codes, priority)
     VALUES ($1, $2, $3, $4, ARRAY['approval_rework'], 2)`,
    [workspaceId, caseId, latest?.document_id ?? null, id],
  );
}

async function validApprovers(client: PoolClient, workspaceId: string, ids: string[]) {
  const r = await client.query(
    `SELECT DISTINCT m.user_id FROM workspace_members m
       JOIN role_permissions rp ON rp.role_id = m.role_id AND rp.workspace_id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.status = 'active' AND rp.permission_key = 'case.approve'
        AND m.user_id = ANY($2::uuid[])`,
    [workspaceId, ids],
  );
  return r.rows.length;
}

export async function registerApprovalRoutes(app: FastifyInstance) {
  app.post(
    '/v1/cases/:case_id/approvals',
    jwtRoute(['case.reassign'], ['case_id']),
    async (request, reply) => {
      const { case_id } = parse(caseValuesParamsSchema, request.params, 'Case ID is invalid.');
      const body = parse(
        approvalRoundRequestSchema,
        request.body,
        'A step and approvers are required.',
      );
      const approvers = [...new Set(body.approver_user_ids)];
      const correlationId = correlationOf(request);
      const out = await request.withTenant!(
        { permissions: ['case.reassign'] },
        async (client, ctx) => {
          const c = (
            await client.query(
              `SELECT status FROM cases WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
              [case_id, ctx.workspaceId],
            )
          ).rows[0];
          if (!c) fail(404, 'Case not found.', 'not_found');
          if (c.status !== 'workflow_ready')
            fail(409, 'This case is not ready for approval.', 'not_ready');
          if ((await validApprovers(client, ctx.workspaceId, approvers)) !== approvers.length)
            fail(
              422,
              'Every approver must be an active member who can approve.',
              'invalid_approver',
            );
          const round = (
            await client.query(
              `SELECT coalesce(max(round), 0) + 1 AS n FROM approvals WHERE case_id = $1`,
              [case_id],
            )
          ).rows[0].n;
          for (const approver of approvers)
            await client.query(
              `INSERT INTO approvals (workspace_id, case_id, workflow_step_key, approver_user_id, round)
           VALUES ($1, $2, $3, $4, $5)`,
              [ctx.workspaceId, case_id, body.workflow_step_key, approver, round],
            );
          await client.query(
            `UPDATE cases SET status = 'approval_pending' WHERE id = $1 AND workspace_id = $2`,
            [case_id, ctx.workspaceId],
          );
          await audit(
            client,
            ctx.userId,
            correlationId,
            'approval.round_created',
            'case',
            case_id,
            null,
            {
              case_id,
              round,
              workflow_step_key: body.workflow_step_key,
              approvers: approvers.length,
            },
          );
          return { case_id, round, approvers: approvers.length };
        },
      );
      return reply.code(201).send(out);
    },
  );

  app.get('/v1/cases/:case_id/approvals', jwtRoute(['case.read'], ['case_id']), async (request) => {
    const { case_id } = parse(caseValuesParamsSchema, request.params, 'Case ID is invalid.');
    return request.withTenant!({ permissions: ['case.read'] }, async (client, ctx) => {
      const found = await client.query(`SELECT 1 FROM cases WHERE id = $1 AND workspace_id = $2`, [
        case_id,
        ctx.workspaceId,
      ]);
      if (!found.rowCount) fail(404, 'Case not found.', 'not_found');
      const rows = await client.query(
        `SELECT id, round, workflow_step_key, approver_user_id, decision, reason, decided_at, delegated_from
           FROM approvals WHERE case_id = $1 AND workspace_id = $2 ORDER BY round, created_at`,
        [case_id, ctx.workspaceId],
      );
      return { items: rows.rows };
    });
  });

  app.get('/v1/approvals', jwtRoute(['case.approve']), async (request) => {
    const q = parse(approvalListQuerySchema, request.query, 'Approval query is invalid.');
    return request.withTenant!({ permissions: ['case.approve'] }, async (client, ctx) => {
      const rows = await client.query(
        `SELECT a.id, a.case_id, c.case_number, a.workflow_step_key, a.round, a.created_at
           FROM approvals a JOIN cases c ON c.id = a.case_id AND c.workspace_id = a.workspace_id
          WHERE a.workspace_id = $1 AND a.approver_user_id = $2 AND a.decision = 'pending'
            AND c.status = 'approval_pending'
            AND a.round = (SELECT max(round) FROM approvals WHERE case_id = a.case_id)
            AND NOT EXISTS (SELECT 1 FROM approvals x WHERE x.case_id = a.case_id AND x.round = a.round
                              AND x.decision IN ('rejected','rework_requested'))
          ORDER BY a.created_at LIMIT $3 OFFSET $4`,
        [ctx.workspaceId, ctx.userId, q.limit, q.offset],
      );
      return { items: rows.rows };
    });
  });

  app.post(
    '/v1/approvals/:approval_id/decide',
    jwtRoute(['case.approve'], ['approval_id']),
    async (request) => {
      const { approval_id } = parse(
        approvalParamsSchema,
        request.params,
        'Approval ID is invalid.',
      );
      const body = parse(approvalDecideRequestSchema, request.body, 'Decision is invalid.');
      if (body.decision !== 'approve' && !body.reason)
        fail(400, 'A reason is required.', 'reason_required');
      const correlationId = correlationOf(request);
      const decision = DECISION[body.decision];
      return request.withTenant!({ permissions: ['case.approve'] }, async (client, ctx) => {
        const { a, caseStatus } = await lockApproval(
          client,
          ctx.workspaceId,
          ctx.userId,
          approval_id,
        );
        if (a.decision !== 'pending') {
          if (a.decision === decision) return { approval_id, decision, replayed: true };
          fail(409, 'This approval was already decided.', 'already_decided');
        }
        await assertRoundOpen(client, a, caseStatus);
        await client.query(
          `UPDATE approvals SET decision = $2, reason = $3, decided_at = now() WHERE id = $1`,
          [approval_id, decision, body.reason ?? null],
        );
        let roundComplete = false;
        let nextStatus = caseStatus;
        if (decision === 'rejected') {
          nextStatus = 'rejected';
        } else if (decision === 'rework_requested') {
          nextStatus = 'review_queued';
        } else {
          const open = await client.query(
            `SELECT count(*) FILTER (WHERE decision = 'pending') AS pending FROM approvals WHERE case_id = $1 AND round = $2`,
            [a.case_id, a.round],
          );
          roundComplete = Number(open.rows[0].pending) === 0;
        }
        if (nextStatus !== caseStatus) {
          await client.query(`UPDATE cases SET status = $3 WHERE id = $1 AND workspace_id = $2`, [
            a.case_id,
            ctx.workspaceId,
            nextStatus,
          ]);
          if (nextStatus === 'review_queued')
            await reopenForReview(
              client,
              ctx.workspaceId,
              a.case_id,
              `approval_rework:${approval_id}`,
            );
        }
        await audit(
          client,
          ctx.userId,
          correlationId,
          'approval.decided',
          'approval',
          approval_id,
          body.reason ?? null,
          {
            case_id: a.case_id,
            round: a.round,
            decision,
            from_status: caseStatus,
            to_status: nextStatus,
            round_complete: roundComplete,
          },
        );
        return {
          approval_id,
          decision,
          round_complete: roundComplete,
          case_status: nextStatus,
          replayed: false,
        };
      });
    },
  );

  app.post(
    '/v1/approvals/:approval_id/delegate',
    jwtRoute(['case.approve'], ['approval_id']),
    async (request) => {
      const { approval_id } = parse(
        approvalParamsSchema,
        request.params,
        'Approval ID is invalid.',
      );
      const body = parse(
        approvalDelegateRequestSchema,
        request.body,
        'A delegate and a reason are required.',
      );
      const correlationId = correlationOf(request);
      return request.withTenant!({ permissions: ['case.approve'] }, async (client, ctx) => {
        const { a, caseStatus } = await lockApproval(
          client,
          ctx.workspaceId,
          ctx.userId,
          approval_id,
        );
        if (a.decision !== 'pending')
          fail(409, 'This approval was already decided.', 'already_decided');
        await assertRoundOpen(client, a, caseStatus);
        if (body.delegate_user_id === ctx.userId)
          fail(422, 'You cannot delegate to yourself.', 'invalid_delegate');
        const taken = await client.query(
          `SELECT 1 FROM approvals WHERE case_id = $1 AND round = $2 AND approver_user_id = $3`,
          [a.case_id, a.round, body.delegate_user_id],
        );
        if (
          taken.rowCount ||
          (await validApprovers(client, ctx.workspaceId, [body.delegate_user_id])) !== 1
        )
          fail(
            422,
            'The delegate must be another active approver for this case.',
            'invalid_delegate',
          );
        await client.query(
          `UPDATE approvals SET decision = 'delegated', reason = $2, decided_at = now() WHERE id = $1`,
          [approval_id, body.reason],
        );
        const created = await client.query(
          `INSERT INTO approvals (workspace_id, case_id, workflow_step_key, approver_user_id, round, delegated_from)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            ctx.workspaceId,
            a.case_id,
            a.workflow_step_key,
            body.delegate_user_id,
            a.round,
            ctx.userId,
          ],
        );
        await audit(
          client,
          ctx.userId,
          correlationId,
          'approval.delegated',
          'approval',
          approval_id,
          body.reason,
          {
            case_id: a.case_id,
            round: a.round,
            new_approval_id: created.rows[0].id,
          },
        );
        return { approval_id, new_approval_id: created.rows[0].id };
      });
    },
  );
}
