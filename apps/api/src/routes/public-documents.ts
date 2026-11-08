import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { withTenant } from '@formiva/db';
import { getOrCreateCorrelationId } from '@formiva/observability';
import { auditSafe, httpError, notFound } from './public-shared.js';
import { hashRespondentToken, resolveRespondentToken } from '../services/respondent-tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the respondent may know about a file. Internal reasons (why a scan failed) are never shown. */
export type DocumentState = 'uploading' | 'checking' | 'ready' | 'not_accepted';
const STATE: Record<string, DocumentState | undefined> = {
  pending_upload: 'uploading',
  uploaded: 'checking',
  scanning: 'checking',
  clean: 'ready',
  quarantined: 'not_accepted',
  rejected: 'not_accepted',
};

type Deps = {
  pool: Pool;
  security: NonNullable<import('fastify').FastifyContextConfig['security']>;
  guard: (request: FastifyRequest, reply: { header: (k: string, v: string) => unknown }) => void;
};

/** List and remove the files on a respondent's own draft (ADR-28). */
export function registerDocumentRoutes(app: FastifyInstance, deps: Deps) {
  app.get(
    '/public/v1/forms/:respondent_token/documents',
    { config: { security: deps.security } },
    async (request, reply) => {
      deps.guard(request, reply);
      const { respondent_token } = request.params as { respondent_token: string };
      const resolved = await resolveRespondentToken(deps.pool, respondent_token);
      if (!resolved) throw notFound();
      const documents = await withTenant(deps.pool, resolved.workspaceId, null, async (client) => {
        if (!resolved.caseId) return [];
        const r = await client.query<{
          id: string;
          slot_key: string | null;
          original_filename: string | null;
          size_bytes: string;
          status: string;
        }>(
          `SELECT id, slot_key, original_filename, size_bytes::text, status FROM case_documents
            WHERE case_id = $1 AND status <> 'deleted' AND deleted_at IS NULL ORDER BY created_at, id`,
          [resolved.caseId],
        );
        return r.rows.map((d) => ({
          document_id: d.id,
          slot_key: d.slot_key,
          filename: d.original_filename,
          size_bytes: Number(d.size_bytes),
          state: STATE[d.status] ?? 'checking',
        }));
      });
      reply.header('cache-control', 'no-store');
      return { documents };
    },
  );

  app.delete(
    '/public/v1/forms/:respondent_token/documents/:document_id',
    {
      config: {
        security: { ...deps.security, pathParams: ['respondent_token', 'document_id'] },
      },
    },
    async (request, reply) => {
      deps.guard(request, reply);
      const { respondent_token, document_id } = request.params as {
        respondent_token: string;
        document_id: string;
      };
      const resolved = await resolveRespondentToken(deps.pool, respondent_token);
      if (!resolved || !UUID.test(document_id)) throw notFound();
      const correlationId = getOrCreateCorrelationId(
        request.headers as Record<string, string | string[] | undefined>,
        request.id,
      );
      const tokenHash = hashRespondentToken(respondent_token);
      await withTenant(deps.pool, resolved.workspaceId, null, async (client) => {
        // Same lock order as the other routes: token row, then case row.
        const lock = await client.query<{ case_id: string | null }>(
          `SELECT case_id FROM respondent_tokens
            WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
          [tokenHash],
        );
        const caseId = lock.rows[0]?.case_id;
        if (lock.rowCount !== 1 || !caseId) throw notFound();
        const c = await client.query<{ status: string }>(
          'SELECT status FROM cases WHERE id = $1 FOR UPDATE',
          [caseId],
        );
        if (c.rows[0]?.status !== 'draft') {
          throw httpError(409, 'not_draft', 'This form has already been submitted.');
        }
        // Only this case's own files can be removed; anything else looks like "not found".
        const doc = await client.query<{ status: string; legal_hold: boolean }>(
          'SELECT status, legal_hold FROM case_documents WHERE id = $1 AND case_id = $2 FOR UPDATE',
          [document_id, caseId],
        );
        const row = doc.rows[0];
        if (!row) throw notFound();
        if (row.status === 'deleted') return; // already removed: repeating is harmless
        if (row.legal_hold) throw httpError(409, 'locked', 'This file cannot be removed.');
        await client.query(
          `UPDATE case_documents SET status = 'deleted', deleted_at = now() WHERE id = $1`,
          [document_id],
        );
        await auditSafe(
          client,
          'document.removed',
          caseId,
          { document_id, previous_status: row.status },
          correlationId,
        );
      });
      reply.header('cache-control', 'no-store');
      return { document_id, state: 'removed' };
    },
  );
}
