import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { NO_AI_SUBTYPES, visibleKeys } from '@formiva/contracts';
import { withTenant } from '@formiva/db';
import { getOrCreateCorrelationId } from '@formiva/observability';
import {
  auditSafe,
  httpError,
  loadPublishedForm,
  loadSlotPolicies,
  notFound,
  slotAllowed,
} from './public-shared.js';
import { hashRespondentToken, resolveRespondentToken } from '../services/respondent-tokens.js';

const submitBody = z
  .object({
    draft_revision: z.number().int().min(0),
    idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();

const NOT_READY = ['pending_upload', 'uploaded', 'scanning'];

const isEmptyValue = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  v === false ||
  (Array.isArray(v) && v.length === 0);

interface Submitted {
  caseId: string;
  jobs: Array<{ id: string; document_id: string }>;
  replay: boolean;
}

/** The jobs already created for a submitted case, in a stable order (used for replays). */
async function existingJobs(client: PoolClient, caseId: string) {
  const r = await client.query<{ id: string; document_id: string }>(
    'SELECT id, document_id FROM ai_jobs WHERE case_id = $1 ORDER BY created_at, id',
    [caseId],
  );
  return r.rows;
}

export function registerSubmitRoute(
  app: FastifyInstance,
  deps: {
    pool: Pool;
    security: NonNullable<import('fastify').FastifyContextConfig['security']>;
    guard: (request: FastifyRequest, reply: { header: (k: string, v: string) => unknown }) => void;
  },
) {
  app.post(
    '/public/v1/forms/:respondent_token/submit',
    { config: { security: deps.security }, bodyLimit: 4 * 1024 },
    async (request, reply) => {
      deps.guard(request, reply);
      const { respondent_token } = request.params as { respondent_token: string };
      const resolved = await resolveRespondentToken(deps.pool, respondent_token);
      if (!resolved) throw notFound();
      const parsed = submitBody.safeParse(request.body);
      if (!parsed.success) throw httpError(400, 'invalid_body', 'Submit body is invalid.');
      const { draft_revision, idempotency_key } = parsed.data;
      const correlationId = getOrCreateCorrelationId(
        request.headers as Record<string, string | string[] | undefined>,
        request.id,
      );
      const hash = hashRespondentToken(respondent_token);

      // One transaction: either the case, jobs and audit event all exist, or none do.
      const result = await withTenant(
        deps.pool,
        resolved.workspaceId,
        null,
        async (client): Promise<Submitted> => {
          const form = await loadPublishedForm(client, resolved.formVersionId);

          // Same lock order as the draft route (token row, then case row): two submits queue here.
          const lock = await client.query<{ case_id: string | null }>(
            `SELECT case_id FROM respondent_tokens
              WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
            [hash],
          );
          if (lock.rowCount !== 1) throw notFound();
          const caseId = lock.rows[0]!.case_id;
          if (!caseId) {
            throw httpError(422, 'incomplete', 'Nothing to submit yet. Save your answers first.');
          }

          const c = await client.query<{ status: string; submitted_at: Date | null }>(
            'SELECT status, submitted_at FROM cases WHERE id = $1 FOR UPDATE',
            [caseId],
          );
          const row = c.rows[0]!;
          if (row.status !== 'draft') {
            // A repeat of a successful submit returns the original outcome and creates nothing.
            if (row.submitted_at) {
              return { caseId, jobs: await existingJobs(client, caseId), replay: true };
            }
            throw httpError(409, 'not_draft', 'This form can no longer be submitted.');
          }

          const latest = await client.query<{
            field_key: string;
            revision: number;
            value_json: unknown;
          }>(
            `SELECT DISTINCT ON (field_key) field_key, revision, value_json
               FROM case_values WHERE case_id = $1 ORDER BY field_key, revision DESC`,
            [caseId],
          );
          const revision = Math.max(0, ...latest.rows.map((r) => r.revision));
          if (draft_revision !== revision) {
            throw httpError(
              409,
              'revision_conflict',
              `Draft changed elsewhere. Current revision is ${revision}.`,
            );
          }

          const consent = await client.query(
            `SELECT 1 FROM consent_records WHERE case_id = $1 AND granted AND notice_version = $2 LIMIT 1`,
            [caseId, form.noticeVersion],
          );
          if (form.noticeVersion === null || consent.rowCount !== 1) {
            throw httpError(
              422,
              'consent_required',
              'Consent to the privacy notice is required before submitting.',
            );
          }

          // Required answers: only fields that are currently shown count.
          const values = Object.fromEntries(latest.rows.map((r) => [r.field_key, r.value_json]));
          const shown = visibleKeys(form.definition.fields, values);
          const missingFields = form.definition.fields
            .filter(
              (f) => f.required && shown.has(f.field_key) && isEmptyValue(values[f.field_key]),
            )
            .map((f) => f.field_key);

          // Documents: files still being checked block the submit; only clean files go on.
          const docs = await client.query<{
            id: string;
            slot_key: string | null;
            doc_subtype: string | null;
            status: string;
            sha256: Buffer | null;
          }>(
            `SELECT id, slot_key, doc_subtype, status, sha256 FROM case_documents
              WHERE case_id = $1 AND status <> 'deleted' AND deleted_at IS NULL ORDER BY created_at, id`,
            [caseId],
          );
          const waiting = docs.rows.filter((d) => NOT_READY.includes(d.status));
          if (waiting.length > 0) {
            throw httpError(
              409,
              'documents_not_ready',
              'Some files are still being checked. Try again in a moment.',
            );
          }
          const clean = docs.rows.filter((d) => d.status === 'clean' && d.sha256);
          // Only slots this workspace still collects can be required.
          const policies = await loadSlotPolicies(client, form);
          const missingSlots = form.definition.slots
            .filter((s) => slotAllowed(s, policies))
            .filter((s) => s.required && !clean.some((d) => d.slot_key === s.key))
            .map((s) => s.key);
          if (missingFields.length > 0 || missingSlots.length > 0) {
            throw httpError(
              422,
              'incomplete',
              `Missing required answers: ${[...missingFields, ...missingSlots].join(', ')}.`,
            );
          }

          // Fail closed: without an active routing policy no job may be created.
          const policy = await client.query<{ policy_version: string }>(
            `SELECT policy_version FROM routing_policies
              WHERE status = 'active' ORDER BY activated_at DESC NULLS LAST, created_at DESC LIMIT 1`,
          );
          if (policy.rowCount !== 1) {
            throw httpError(503, 'policy_unavailable', 'Submission is not available right now.');
          }
          const policyVersion = policy.rows[0]!.policy_version;

          await client.query(
            `UPDATE cases SET status = 'submitted', submitted_at = now(), policy_version = $2 WHERE id = $1`,
            [caseId, policyVersion],
          );
          const jobs: Array<{ id: string; document_id: string }> = [];
          for (const d of clean) {
            // Special-category documents are never sent to AI extraction (ADR-14).
            if (d.doc_subtype && NO_AI_SUBTYPES.includes(d.doc_subtype)) continue;
            const j = await client.query<{ id: string }>(
              `INSERT INTO ai_jobs (workspace_id, case_id, document_id, idempotency_key, object_sha256, policy_version, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'queued') RETURNING id`,
              [
                resolved.workspaceId,
                caseId,
                d.id,
                `${idempotency_key}:${d.id}`,
                d.sha256,
                policyVersion,
              ],
            );
            jobs.push({ id: j.rows[0]!.id, document_id: d.id });
          }
          // Metadata only: no values, no file names.
          await auditSafe(
            client,
            'case.submitted',
            caseId,
            {
              revision,
              field_count: latest.rows.length,
              document_count: clean.length,
              job_count: jobs.length,
              policy_version: policyVersion,
              idempotency_key,
            },
            correlationId,
          );
          return { caseId, jobs, replay: false };
        },
      );

      reply.header('cache-control', 'no-store');
      reply.code(202);
      return {
        case_id: result.caseId,
        status: 'submitted',
        job_ids: result.jobs.map((j) => j.id),
        next_action: 'await_processing',
        replay: result.replay,
        correlation_id: correlationId,
      };
    },
  );
}
