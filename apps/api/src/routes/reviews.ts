import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import {
  caseRevealParamsSchema,
  caseRevealRequestSchema,
  caseValuesParamsSchema,
  reviewClaimRequestSchema,
  reviewCorrectRequestSchema,
  reviewResolveRequestSchema,
  reviewTaskListQuerySchema,
  reviewTaskParamsSchema,
} from '@formiva/contracts';
import { decryptValue, type KeyProvider } from '@formiva/crypto';
import { storeSensitiveValue } from '../services/sensitive-values.js';
import { audit, correlationOf, fail, jwtRoute, parse } from './route-helpers.js';

const ACTIVITY_ACTIONS = [
  'review_task.claimed',
  'review_task.released',
  'review_task.corrected',
  'review_task.resolved',
  'approval.round_created',
  'approval.decided',
  'approval.delegated',
  'case.rework_requested',
  'case.cancelled',
];
const LEASE = `interval '15 minutes'`;
const OPEN_LEVELS = ['public', 'internal', 'confidential'];

type ValueRow = {
  field_key: string;
  revision: number;
  sensitivity: string;
  value_json: unknown;
  masked_preview: string | null;
  source: string;
};

/** Sensitive and highly sensitive values leave the API masked. Reveal is a separate, audited call. */
const shown = (v: ValueRow) => {
  const masked = !OPEN_LEVELS.includes(v.sensitivity);
  return {
    field_key: v.field_key,
    revision: v.revision,
    sensitivity: v.sensitivity,
    source: v.source,
    masked,
    value: masked ? null : v.value_json,
    masked_preview: masked ? v.masked_preview : null,
  };
};

const latestValues = (client: PoolClient, workspaceId: string, caseId: string) =>
  client.query<ValueRow>(
    `SELECT DISTINCT ON (field_key) field_key, revision, sensitivity, value_json, masked_preview, source
       FROM case_values WHERE workspace_id = $1 AND case_id = $2
      ORDER BY field_key, revision DESC`,
    [workspaceId, caseId],
  );

export async function registerReviewRoutes(
  app: FastifyInstance,
  options: { keyProvider?: KeyProvider } = {},
) {
  const { keyProvider } = options;

  app.get('/v1/review-tasks', jwtRoute(['case.review']), async (request) => {
    const q = parse(reviewTaskListQuerySchema, request.query, 'Review task query is invalid.');
    return request.withTenant!({ permissions: ['case.review'] }, async (client, ctx) => {
      const v: unknown[] = [ctx.workspaceId];
      const where: string[] = [];
      const add = (sql: string, value: unknown) =>
        where.push(sql.replace('?', `$${v.push(value)}`));
      if (q.status) add('t.status = ?', q.status);
      else where.push(`t.status IN ('open','claimed')`);
      if (q.priority) add('t.priority = ?', q.priority);
      if (q.due_before) add('t.due_at < ?', q.due_before);
      if (q.assignee) add('t.assignee_user_id = ?', ctx.userId);
      if (q.reason) add('? = ANY(t.reason_codes)', q.reason);
      if (q.sensitivity) add('c.sensitivity = ?', q.sensitivity);
      v.push(q.limit, q.offset);
      const rows = await client.query(
        `SELECT t.id, t.case_id, t.status, t.priority, t.due_at, t.reason_codes, t.assignee_user_id,
                t.lease_until, t.row_version, t.created_at, c.case_number, c.sensitivity
           FROM review_tasks t JOIN cases c ON c.id = t.case_id AND c.workspace_id = t.workspace_id
          WHERE t.workspace_id = $1 ${where.map((w) => `AND ${w}`).join(' ')}
          ORDER BY t.priority, t.due_at NULLS LAST, t.created_at
          LIMIT $${v.length - 1} OFFSET $${v.length}`,
        v,
      );
      return { items: rows.rows };
    });
  });

  app.get('/v1/review-tasks/:task_id', jwtRoute(['case.review'], ['task_id']), async (request) => {
    const { task_id } = parse(reviewTaskParamsSchema, request.params, 'Task ID is invalid.');
    return request.withTenant!({ permissions: ['case.review'] }, async (client, ctx) => {
      const task = (
        await client.query(
          `SELECT t.id, t.case_id, t.document_id, t.status, t.priority, t.due_at, t.reason_codes,
                  t.assignee_user_id, t.lease_until, t.row_version, t.resolution, t.routing_decision_id,
                  c.case_number, c.status AS case_status, c.sensitivity
             FROM review_tasks t JOIN cases c ON c.id = t.case_id AND c.workspace_id = t.workspace_id
            WHERE t.id = $1 AND t.workspace_id = $2`,
          [task_id, ctx.workspaceId],
        )
      ).rows[0];
      if (!task) fail(404, 'Review task not found.', 'not_found');

      const decisions = await client.query(
        `SELECT id, route, action, reasons, rule_version, policy_version, thresholds_applied,
                supersedes_id, ai_result_id, created_at
           FROM routing_decisions WHERE workspace_id = $1 AND case_id = $2 ORDER BY created_at`,
        [ctx.workspaceId, task.case_id],
      );
      // The original AI result is read from the decision that created the task, never from a correction.
      const aiResultId = (
        await client.query(`SELECT ai_result_id FROM routing_decisions WHERE id = $1`, [
          task.routing_decision_id,
        ])
      ).rows[0]?.ai_result_id as string | null | undefined;
      const aiResult = aiResultId
        ? ((
            await client.query(
              `SELECT r.id, r.document_class, r.detected_language, r.confidence, r.confidence_components,
                      r.sensitivity, r.routing_recommendation, r.routing_reasons, r.schema_version,
                      e.engine_version, e.ocr_runtime_version, e.prompt_template_version,
                      e.model_registry_id, e.status AS execution_status, e.duration_ms
                 FROM ai_results r JOIN ai_executions e ON e.id = r.ai_execution_id AND e.workspace_id = r.workspace_id
                WHERE r.id = $1 AND r.workspace_id = $2`,
              [aiResultId, ctx.workspaceId],
            )
          ).rows[0] ?? null)
        : null;
      const evidence = aiResultId
        ? (
            await client.query(
              `SELECT id, document_id, evidence_type, page, region, redacted_excerpt
                 FROM source_evidence WHERE ai_result_id = $1 AND workspace_id = $2 ORDER BY page, created_at`,
              [aiResultId, ctx.workspaceId],
            )
          ).rows
        : [];
      const values = await latestValues(client, ctx.workspaceId, task.case_id);
      // previous/corrected values are shown without the encrypted envelope.
      const corrections = await client.query(
        `SELECT id, actor_user_id, reason, created_at,
                previous_value->>'field_key' AS field_key,
                previous_value - 'enc' - 'kid' AS previous_value,
                corrected_value - 'enc' - 'kid' AS corrected_value
           FROM human_corrections WHERE case_id = $1 AND workspace_id = $2 ORDER BY created_at`,
        [task.case_id, ctx.workspaceId],
      );
      return {
        task,
        routing_decisions: decisions.rows,
        ai_result: aiResult,
        source_evidence: evidence,
        values: values.rows.map(shown),
        corrections: corrections.rows,
      };
    });
  });

  app.post(
    '/v1/review-tasks/:task_id/claim',
    jwtRoute(['case.review'], ['task_id']),
    async (request) => {
      const { task_id } = parse(reviewTaskParamsSchema, request.params, 'Task ID is invalid.');
      const body = parse(reviewClaimRequestSchema, request.body ?? {}, 'Claim request is invalid.');
      const correlationId = correlationOf(request);
      return request.withTenant!({ permissions: ['case.review'] }, async (client, ctx) => {
        // One statement decides the race: only an open task, or one whose lease has run out, can be taken.
        const won = await client.query(
          `UPDATE review_tasks
            SET status = 'claimed', assignee_user_id = $3::uuid, lease_owner = $3::text,
                lease_until = now() + ${LEASE}, row_version = row_version + 1, updated_at = now()
          WHERE id = $1 AND workspace_id = $2
            AND ($4::int IS NULL OR row_version = $4)
            AND (status = 'open' OR (status = 'claimed' AND lease_until < now()))
        RETURNING case_id, row_version, lease_until`,
          [task_id, ctx.workspaceId, ctx.userId, body.row_version ?? null],
        );
        const row = won.rows[0];
        if (!row) {
          const exists = await client.query(
            `SELECT 1 FROM review_tasks WHERE id = $1 AND workspace_id = $2`,
            [task_id, ctx.workspaceId],
          );
          if (!exists.rowCount) fail(404, 'Review task not found.', 'not_found');
          fail(409, 'This task is already taken or has changed.', 'task_not_claimable');
        }
        await client.query(
          `UPDATE cases SET status = 'review_in_progress' WHERE id = $1 AND workspace_id = $2 AND status = 'review_queued'`,
          [row.case_id, ctx.workspaceId],
        );
        await audit(
          client,
          ctx.userId,
          correlationId,
          'review_task.claimed',
          'review_task',
          task_id,
          null,
          {
            case_id: row.case_id,
          },
        );
        return { task_id, row_version: row.row_version, lease_until: row.lease_until };
      });
    },
  );

  app.post(
    '/v1/review-tasks/:task_id/release',
    jwtRoute(['case.review'], ['task_id']),
    async (request) => {
      const { task_id } = parse(reviewTaskParamsSchema, request.params, 'Task ID is invalid.');
      const correlationId = correlationOf(request);
      return request.withTenant!({ permissions: ['case.review'] }, async (client, ctx) => {
        const mayReassign = ctx.permissions.includes('case.reassign');
        const out = await client.query(
          `UPDATE review_tasks
            SET status = 'open', assignee_user_id = NULL, lease_owner = NULL, lease_until = NULL,
                row_version = row_version + 1, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND status = 'claimed'
            AND (assignee_user_id = $3::uuid OR $4::boolean)
        RETURNING case_id, row_version`,
          [task_id, ctx.workspaceId, ctx.userId, mayReassign],
        );
        const row = out.rows[0];
        if (!row) {
          const exists = await client.query(
            `SELECT 1 FROM review_tasks WHERE id = $1 AND workspace_id = $2`,
            [task_id, ctx.workspaceId],
          );
          if (!exists.rowCount) fail(404, 'Review task not found.', 'not_found');
          fail(409, 'Only the reviewer who claimed this task can release it.', 'not_releasable');
        }
        await client.query(
          `UPDATE cases SET status = 'review_queued'
          WHERE id = $1 AND workspace_id = $2 AND status = 'review_in_progress'
            AND NOT EXISTS (SELECT 1 FROM review_tasks WHERE case_id = $1 AND status = 'claimed')`,
          [row.case_id, ctx.workspaceId],
        );
        await audit(
          client,
          ctx.userId,
          correlationId,
          'review_task.released',
          'review_task',
          task_id,
          null,
          {
            case_id: row.case_id,
          },
        );
        return { task_id, row_version: row.row_version };
      });
    },
  );

  app.post(
    '/v1/review-tasks/:task_id/correct',
    jwtRoute(['case.correct'], ['task_id']),
    async (request) => {
      const { task_id } = parse(reviewTaskParamsSchema, request.params, 'Task ID is invalid.');
      const body = parse(
        reviewCorrectRequestSchema,
        request.body,
        'A reason and corrections are required.',
      );
      const correlationId = correlationOf(request);
      return request.withTenant!({ permissions: ['case.correct'] }, async (client, ctx) => {
        const task = (
          await client.query(
            `SELECT case_id, document_id, routing_decision_id, status, assignee_user_id, row_version
             FROM review_tasks WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
            [task_id, ctx.workspaceId],
          )
        ).rows[0];
        if (!task) fail(404, 'Review task not found.', 'not_found');
        if (task.status !== 'claimed' || task.assignee_user_id !== ctx.userId)
          fail(409, 'Claim this task before correcting it.', 'claim_required');
        if (task.row_version !== body.row_version)
          fail(409, 'This task changed. Reload it and try again.', 'stale_row_version');

        const aiResultId =
          (
            await client.query(`SELECT ai_result_id FROM routing_decisions WHERE id = $1`, [
              task.routing_decision_id,
            ])
          ).rows[0]?.ai_result_id ?? null;

        for (const c of body.corrections) {
          const prev = (
            await client.query(
              `SELECT revision, sensitivity, value_json, value_ciphertext, key_id FROM case_values
              WHERE case_id = $1 AND workspace_id = $2 AND field_key = $3 ORDER BY revision DESC LIMIT 1`,
              [task.case_id, ctx.workspaceId, c.field],
            )
          ).rows[0];
          if (!prev) fail(422, `Unknown field: ${c.field}.`, 'unknown_field');
          const revision = prev.revision + 1;
          const previous: Record<string, unknown> = { field_key: c.field, revision: prev.revision };
          const corrected: Record<string, unknown> = { field_key: c.field, revision };
          if (prev.sensitivity === 'highly_sensitive') {
            if (!keyProvider)
              fail(503, 'Sensitive corrections are unavailable.', 'keys_unavailable');
            previous.enc = Buffer.from(prev.value_ciphertext).toString('base64');
            previous.kid = prev.key_id;
            const stored = await storeSensitiveValue(client, keyProvider, {
              workspaceId: ctx.workspaceId,
              caseId: task.case_id,
              fieldKey: c.field,
              revision,
              plaintext: c.value,
              source: 'human_correction',
            });
            corrected.enc = stored.ciphertext.toString('base64');
            corrected.kid = stored.keyId;
          } else {
            previous.value = prev.value_json;
            corrected.value = c.value;
            await client.query(
              `INSERT INTO case_values (workspace_id, case_id, field_key, revision, sensitivity, value_json, source, created_by)
             VALUES ($1, $2, $3, $4, $5, to_jsonb($6::text), 'human_correction', $7)`,
              [
                ctx.workspaceId,
                task.case_id,
                c.field,
                revision,
                prev.sensitivity,
                c.value,
                ctx.userId,
              ],
            );
          }
          await client.query(
            `INSERT INTO human_corrections (workspace_id, case_id, document_id, ai_result_id, review_task_id,
                                          actor_user_id, previous_value, corrected_value, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
            [
              ctx.workspaceId,
              task.case_id,
              task.document_id,
              aiResultId,
              task_id,
              ctx.userId,
              JSON.stringify(previous),
              JSON.stringify(corrected),
              body.reason,
            ],
          );
        }

        // A correction supersedes the latest routing decision; the old one stays as it was.
        const latest = (
          await client.query(
            `SELECT id, rule_version, policy_version FROM routing_decisions
            WHERE case_id = $1 AND workspace_id = $2 ORDER BY created_at DESC, id LIMIT 1`,
            [task.case_id, ctx.workspaceId],
          )
        ).rows[0];
        const newVersion = task.row_version + 1;
        await client.query(
          `INSERT INTO routing_decisions (workspace_id, case_id, document_id, ai_result_id, decision_key,
                                        rule_version, policy_version, action, route, reasons, supersedes_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'human_correction', 'human_review', '["human_correction"]'::jsonb, $8)`,
          [
            ctx.workspaceId,
            task.case_id,
            task.document_id,
            aiResultId,
            `correction:${task_id}:${newVersion}`,
            latest.rule_version,
            latest.policy_version,
            latest.id,
          ],
        );
        await client.query(
          `UPDATE review_tasks SET row_version = $3, lease_until = now() + ${LEASE}, updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
          [task_id, ctx.workspaceId, newVersion],
        );
        await audit(
          client,
          ctx.userId,
          correlationId,
          'review_task.corrected',
          'review_task',
          task_id,
          body.reason,
          {
            case_id: task.case_id,
            fields: body.corrections.map((c) => c.field),
          },
        );
        return { task_id, row_version: newVersion, corrected_fields: body.corrections.length };
      });
    },
  );

  app.post(
    '/v1/review-tasks/:task_id/resolve',
    jwtRoute(['case.review'], ['task_id']),
    async (request) => {
      const { task_id } = parse(reviewTaskParamsSchema, request.params, 'Task ID is invalid.');
      const body = parse(reviewResolveRequestSchema, request.body, 'Resolution is invalid.');
      if (body.resolution !== 'approved' && !body.reason)
        fail(400, 'A reason is required.', 'reason_required');
      const correlationId = correlationOf(request);
      return request.withTenant!({ permissions: ['case.review'] }, async (client, ctx) => {
        const task = (
          await client.query(
            `SELECT case_id, status, resolution, resolved_by, assignee_user_id, row_version
             FROM review_tasks WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
            [task_id, ctx.workspaceId],
          )
        ).rows[0];
        if (!task) fail(404, 'Review task not found.', 'not_found');
        const finished = task.status === 'resolved' || task.status === 'escalated';
        if (finished) {
          if (task.resolution === body.resolution && task.resolved_by === ctx.userId)
            return { task_id, resolution: task.resolution, replayed: true };
          fail(409, 'This task is already resolved.', 'already_resolved');
        }
        if (task.status !== 'claimed' || task.assignee_user_id !== ctx.userId)
          fail(409, 'Claim this task before resolving it.', 'claim_required');
        if (body.row_version && body.row_version !== task.row_version)
          fail(409, 'This task changed. Reload it and try again.', 'stale_row_version');
        if (body.resolution === 'corrected') {
          const n = await client.query(
            `SELECT 1 FROM human_corrections WHERE review_task_id = $1 LIMIT 1`,
            [task_id],
          );
          if (!n.rowCount) fail(409, 'Record a correction first.', 'no_correction');
        }

        await client.query(
          `UPDATE review_tasks SET status = $3, resolution = $4, resolved_by = $5, resolved_at = now(),
                lease_owner = NULL, lease_until = NULL, row_version = row_version + 1, updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
          [
            task_id,
            ctx.workspaceId,
            body.resolution === 'escalated' ? 'escalated' : 'resolved',
            body.resolution,
            ctx.userId,
          ],
        );
        if (body.resolution === 'quarantined') {
          await client.query(
            `UPDATE cases SET status = 'quarantined' WHERE id = $1 AND workspace_id = $2`,
            [task.case_id, ctx.workspaceId],
          );
        } else if (body.resolution !== 'escalated') {
          // Only when this was the last open task does the case move on.
          await client.query(
            `UPDATE cases SET status = 'workflow_ready'
            WHERE id = $1 AND workspace_id = $2 AND status = 'review_in_progress'
              AND NOT EXISTS (SELECT 1 FROM review_tasks WHERE case_id = $1 AND status IN ('open','claimed'))`,
            [task.case_id, ctx.workspaceId],
          );
        }
        await audit(
          client,
          ctx.userId,
          correlationId,
          'review_task.resolved',
          'review_task',
          task_id,
          body.reason ?? null,
          { case_id: task.case_id, resolution: body.resolution },
        );
        return { task_id, resolution: body.resolution, replayed: false };
      });
    },
  );

  // The existing /timeline stays a deliberately redacted projection (its unit test forbids action, reason and
  // actor). This route adds the review and approval state changes, with a fixed list of safe action names.
  app.get('/v1/cases/:case_id/activity', jwtRoute(['case.read'], ['case_id']), async (request) => {
    const { case_id } = parse(caseValuesParamsSchema, request.params, 'Case ID is invalid.');
    return request.withTenant!({ permissions: ['case.read'] }, async (client, ctx) => {
      const found = await client.query(`SELECT 1 FROM cases WHERE id = $1 AND workspace_id = $2`, [
        case_id,
        ctx.workspaceId,
      ]);
      if (!found.rowCount) fail(404, 'Case not found.', 'not_found');
      const rows = await client.query(
        `SELECT occurred_at, correlation_id, action, payload->>'from_status' AS from_status, payload->>'to_status' AS to_status
           FROM audit_events
          WHERE workspace_id = $1 AND correlation_id IS NOT NULL
            AND action = ANY($3::text[])
            AND (object_id = $2 OR payload->>'case_id' = $2)
          ORDER BY occurred_at, chain_seq`,
        [ctx.workspaceId, case_id, ACTIVITY_ACTIONS],
      );
      return { items: rows.rows };
    });
  });

  app.get('/v1/cases/:case_id/values', jwtRoute(['case.read'], ['case_id']), async (request) => {
    const { case_id } = parse(caseValuesParamsSchema, request.params, 'Case ID is invalid.');
    return request.withTenant!({ permissions: ['case.read'] }, async (client, ctx) => {
      const found = await client.query(`SELECT 1 FROM cases WHERE id = $1 AND workspace_id = $2`, [
        case_id,
        ctx.workspaceId,
      ]);
      if (!found.rowCount) fail(404, 'Case not found.', 'not_found');
      return { items: (await latestValues(client, ctx.workspaceId, case_id)).rows.map(shown) };
    });
  });

  app.post(
    '/v1/cases/:case_id/values/:field_key/reveal',
    jwtRoute(['document.read_sensitive'], ['case_id', 'field_key']),
    async (request, reply) => {
      const p = parse(caseRevealParamsSchema, request.params, 'Reveal request is invalid.');
      const body = parse(caseRevealRequestSchema, request.body, 'A reason is required.');
      const correlationId = correlationOf(request);
      reply.header('cache-control', 'no-store');
      return request.withTenant!(
        { permissions: ['document.read_sensitive'] },
        async (client, ctx) => {
          const v = (
            await client.query(
              `SELECT revision, sensitivity, value_json, value_ciphertext, key_id FROM case_values
              WHERE case_id = $1 AND workspace_id = $2 AND field_key = $3 ORDER BY revision DESC LIMIT 1`,
              [p.case_id, ctx.workspaceId, p.field_key],
            )
          ).rows[0];
          if (!v) fail(404, 'Value not found.', 'not_found');
          let value: unknown = v.value_json;
          if (v.sensitivity === 'highly_sensitive') {
            if (!keyProvider) fail(503, 'Reveal is unavailable.', 'keys_unavailable');
            value = decryptValue(
              keyProvider,
              v.key_id,
              {
                workspaceId: ctx.workspaceId,
                caseId: p.case_id,
                fieldKey: p.field_key,
                revision: v.revision,
              },
              v.value_ciphertext,
            );
          }
          // The audit row records who looked and why, never the value.
          await audit(
            client,
            ctx.userId,
            correlationId,
            'case_value.revealed',
            'case',
            p.case_id,
            body.reason,
            {
              case_id: p.case_id,
              field_key: p.field_key,
              revision: v.revision,
            },
          );
          return { field_key: p.field_key, revision: v.revision, value };
        },
      );
    },
  );
}
