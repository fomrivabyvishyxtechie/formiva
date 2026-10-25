import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { FormDefinition } from '@formiva/contracts';
import { withTenant } from '@formiva/db';
import { getOrCreateCorrelationId } from '@formiva/observability';
import { auditSafe, httpError, loadPublishedForm, notFound } from './public-shared.js';
import { registerUploadRoute } from './public-uploads.js';
import type { ObjectStore } from '../services/object-store.js';
import { RateLimiter } from '../rate-limiter.js';
import { hashRespondentToken, resolveRespondentToken } from '../services/respondent-tokens.js';

const draftBody = z
  .object({
    draft_revision: z.number().int().min(0),
    consent: z
      .object({ notice_version: z.string().min(1).max(100), accepted: z.literal(true) })
      .strict()
      .optional(),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

const FULL_ID = /(?<!\d)\d{12}(?!\d)/; // Government Documents Policy: no full ID numbers in free text
const TEXT_TYPES = new Set(['text', 'textarea', 'email', 'phone', 'date', 'select']);

type Field = FormDefinition['fields'][number];

function optionList(field: Field): string[] {
  const raw = field.validation['options'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o) =>
    typeof o === 'string'
      ? [o]
      : o && typeof o === 'object' && typeof (o as { value?: unknown }).value === 'string'
        ? [(o as { value: string }).value]
        : [],
  );
}

/** Returns a problem description, or null when the value is acceptable for a draft. */
function valueProblem(field: Field, value: unknown): string | null {
  if (field.sensitivity === 'highly_sensitive') {
    // Encryption arrives in Prompt 3.5; until then these values are refused, never stored in clear.
    return 'This field cannot be saved yet.';
  }
  if (field.field_type === 'file' || field.field_type === 'signature') {
    return 'Use the upload flow for this field.';
  }
  const t = field.field_type;
  if (t === 'number')
    return typeof value === 'number' && Number.isFinite(value) ? null : 'Must be a number.';
  if (t === 'checkbox') return typeof value === 'boolean' ? null : 'Must be true or false.';
  if (t === 'multiselect') {
    const allowed = optionList(field);
    return Array.isArray(value) &&
      value.length <= 50 &&
      value.every((v) => typeof v === 'string' && allowed.includes(v))
      ? null
      : 'Must be a list of allowed options.';
  }
  if (typeof value !== 'string') return 'Must be text.';
  const configuredMax = field.validation['max_length'];
  const max =
    typeof configuredMax === 'number' && configuredMax > 0
      ? configuredMax
      : t === 'textarea'
        ? 5000
        : 1000;
  if (value.length > max) return 'Too long.';
  if (t === 'email' && value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    return 'Not a valid email.';
  if (
    t === 'date' &&
    value !== '' &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
  ) {
    return 'Not a valid date.';
  }
  if (t === 'select' && value !== '' && !optionList(field).includes(value))
    return 'Not an allowed option.';
  if (t !== 'phone' && TEXT_TYPES.has(t) && FULL_ID.test(value)) {
    return 'Looks like a full ID number. Do not type ID numbers here.';
  }
  return null;
}

export interface PublicRouteOptions {
  /** HMAC key for consent_records.ip_hash. Without it the IP is not recorded at all. */
  ipHashSecret?: string;
  ipLimiter?: RateLimiter;
  tokenLimiter?: RateLimiter;
  objectStore?: ObjectStore;
  quarantineBucket?: string;
}

export async function registerPublicRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: PublicRouteOptions = {},
) {
  const ipLimiter = options.ipLimiter ?? new RateLimiter(120, 60_000);
  const tokenLimiter = options.tokenLimiter ?? new RateLimiter(60, 60_000);

  const security = {
    authKind: 'public',
    permissions: 'none',
    tenantScope: 'workspace',
    pathParams: ['respondent_token'],
  } as const;

  const guard = (request: FastifyRequest, reply: { header: (k: string, v: string) => unknown }) => {
    const raw = (request.params as { respondent_token?: string }).respondent_token ?? '';
    const waits = [
      ipLimiter.take(`ip:${request.ip}`),
      tokenLimiter.take(`tok:${hashRespondentToken(raw).toString('hex')}`),
    ];
    const wait = Math.max(...waits);
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      throw httpError(429, 'rate_limited', 'Too many requests. Try again shortly.');
    }
  };

  const ipHash = (request: FastifyRequest): Buffer | null =>
    options.ipHashSecret
      ? createHmac('sha256', options.ipHashSecret).update(request.ip).digest()
      : null;

  app.get(
    '/public/v1/forms/:respondent_token',
    { config: { security } },
    async (request, reply) => {
      guard(request, reply);
      const { respondent_token } = request.params as { respondent_token: string };
      const resolved = await resolveRespondentToken(pool, respondent_token);
      if (!resolved) throw notFound();
      const correlationId = getOrCreateCorrelationId(
        request.headers as Record<string, string | string[] | undefined>,
        request.id,
      );

      const body = await withTenant(pool, resolved.workspaceId, null, async (client) => {
        const form = await loadPublishedForm(client, resolved.formVersionId);
        let draft = {
          case_id: null as string | null,
          status: 'draft',
          draft_revision: 0,
          consent_recorded: false,
          values: {} as Record<string, unknown>,
        };
        if (resolved.caseId) {
          const c = await client.query<{ status: string }>(
            'SELECT status FROM cases WHERE id = $1',
            [resolved.caseId],
          );
          const rows = await client.query<{
            field_key: string;
            revision: number;
            value_json: unknown;
            sensitivity: string;
          }>(
            `SELECT DISTINCT ON (field_key) field_key, revision, value_json, sensitivity
               FROM case_values WHERE case_id = $1 ORDER BY field_key, revision DESC`,
            [resolved.caseId],
          );
          const consent = await client.query(
            `SELECT 1 FROM consent_records WHERE case_id = $1 AND granted AND notice_version = $2 LIMIT 1`,
            [resolved.caseId, form.noticeVersion],
          );
          draft = {
            case_id: resolved.caseId,
            status: c.rows[0]?.status ?? 'draft',
            draft_revision: Math.max(0, ...rows.rows.map((r) => r.revision)),
            consent_recorded: consent.rowCount === 1,
            // Sensitive answers are never sent back to the browser (same rule as browser drafts, ADR-21).
            values: Object.fromEntries(
              rows.rows
                .filter(
                  (r) =>
                    !['sensitive', 'highly_sensitive'].includes(r.sensitivity) &&
                    r.value_json !== null,
                )
                .map((r) => [r.field_key, r.value_json]),
            ),
          };
        }
        return {
          form: {
            id: form.id,
            version_id: form.versionId,
            slug: form.slug,
            name: form.name,
            status: 'published',
            privacy_notice_version: form.noticeVersion,
            fields: form.definition.fields,
            slots: form.definition.slots,
          },
          draft,
          correlation_id: correlationId,
        };
      });
      reply.header('cache-control', 'no-store');
      return body;
    },
  );

  app.put(
    '/public/v1/forms/:respondent_token/draft',
    { config: { security }, bodyLimit: 256 * 1024 },
    async (request, reply) => {
      guard(request, reply);
      const { respondent_token } = request.params as { respondent_token: string };
      const resolved = await resolveRespondentToken(pool, respondent_token);
      if (!resolved) throw notFound();
      const parsed = draftBody.safeParse(request.body);
      if (!parsed.success) throw httpError(400, 'invalid_body', 'Draft body is invalid.');
      const { draft_revision, consent, values } = parsed.data;
      const correlationId = getOrCreateCorrelationId(
        request.headers as Record<string, string | string[] | undefined>,
        request.id,
      );
      const hash = hashRespondentToken(respondent_token);

      const result = await withTenant(pool, resolved.workspaceId, null, async (client) => {
        const form = await loadPublishedForm(client, resolved.formVersionId);

        // Lock the token row: concurrent first saves queue here, so only one case is ever created.
        const lock = await client.query<{ case_id: string | null }>(
          `SELECT case_id FROM respondent_tokens
            WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
          [hash],
        );
        if (lock.rowCount !== 1) throw notFound();

        // Validate before writing anything.
        const fields = new Map(form.definition.fields.map((f) => [f.field_key, f]));
        const problems: string[] = [];
        for (const [key, value] of Object.entries(values)) {
          const field = fields.get(key);
          const problem = field ? valueProblem(field, value) : 'Unknown field.';
          if (problem) problems.push(`${key}: ${problem}`);
        }
        if (Object.keys(values).length > 100) problems.push('Too many values.');
        if (problems.length) throw httpError(422, 'invalid_values', problems.join(' '));
        if (consent && consent.notice_version !== form.noticeVersion) {
          throw httpError(
            422,
            'notice_version_mismatch',
            'Privacy notice version does not match this form.',
          );
        }

        let caseId = lock.rows[0]!.case_id;
        if (!caseId) {
          const created = await client.query<{ id: string }>(
            `INSERT INTO cases (workspace_id, case_number, form_version_id, status, source)
             VALUES ($1, app.next_counter($1, 'case'), $2, 'draft', 'public_link') RETURNING id`,
            [resolved.workspaceId, resolved.formVersionId],
          );
          caseId = created.rows[0]!.id;
          await client.query('UPDATE respondent_tokens SET case_id = $1 WHERE token_hash = $2', [
            caseId,
            hash,
          ]);
          await auditSafe(client, 'case.created', caseId, { source: 'public_link' }, correlationId);
        }

        const caseRow = await client.query<{ status: string }>(
          'SELECT status FROM cases WHERE id = $1 FOR UPDATE',
          [caseId],
        );
        if (caseRow.rows[0]?.status !== 'draft') {
          throw httpError(409, 'not_draft', 'This form has already been submitted.');
        }

        const current = await client.query<{ revision: number }>(
          'SELECT COALESCE(MAX(revision), 0)::int AS revision FROM case_values WHERE case_id = $1',
          [caseId],
        );
        const currentRevision = current.rows[0]!.revision;
        if (draft_revision !== currentRevision) {
          throw httpError(
            409,
            'revision_conflict',
            `Draft changed elsewhere. Current revision is ${currentRevision}.`,
          );
        }

        // Consent is recorded before any value is written (DPDP: notice evidence first).
        if (consent) {
          await client.query(
            `INSERT INTO consent_records (workspace_id, case_id, notice_version, purpose, granted, ip_hash)
             VALUES ($1, $2, $3, 'form_submission', true, $4)`,
            [resolved.workspaceId, caseId, consent.notice_version, ipHash(request)],
          );
        }
        const entries = Object.entries(values);
        if (entries.length > 0) {
          const has = await client.query(
            `SELECT 1 FROM consent_records WHERE case_id = $1 AND granted AND notice_version = $2 LIMIT 1`,
            [caseId, form.noticeVersion],
          );
          if (form.noticeVersion === null || has.rowCount !== 1) {
            throw httpError(
              422,
              'consent_required',
              'Consent to the privacy notice is required before saving answers.',
            );
          }
        }

        const newRevision = entries.length > 0 ? currentRevision + 1 : currentRevision;
        for (const [key, value] of entries) {
          await client.query(
            `INSERT INTO case_values (workspace_id, case_id, field_key, revision, sensitivity, value_json, source)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'respondent')`,
            [
              resolved.workspaceId,
              caseId,
              key,
              newRevision,
              fields.get(key)!.sensitivity,
              JSON.stringify(value),
            ],
          );
        }
        // Metadata only: never the values themselves.
        await auditSafe(
          client,
          'case.draft_saved',
          caseId,
          {
            revision: newRevision,
            field_count: entries.length,
            consent_recorded: Boolean(consent),
          },
          correlationId,
        );
        const saved = await client.query<{ saved_at: Date }>('SELECT now() AS saved_at');
        return { caseId, revision: newRevision, savedAt: saved.rows[0]!.saved_at };
      });

      reply.header('cache-control', 'no-store');
      return {
        case_id: result.caseId,
        draft_revision: result.revision,
        status: 'draft',
        saved_at: result.savedAt.toISOString(),
        correlation_id: correlationId,
      };
    },
  );

  registerUploadRoute(app, {
    pool,
    store: options.objectStore,
    quarantineBucket: options.quarantineBucket,
    security,
    guard,
  });

  // Later prompt (3.4 atomic submit). Registered now so the routes, limits and metadata exist.
  for (const [path, phase] of [['submit', '3.4']] as const) {
    app.post(
      `/public/v1/forms/:respondent_token/${path}`,
      { config: { security } },
      async (request, reply) => {
        guard(request, reply);
        throw httpError(501, 'not_implemented', `Not available yet (Prompt ${phase}).`);
      },
    );
  }
}
