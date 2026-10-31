import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTenant } from '@formiva/db';
import { getOrCreateCorrelationId } from '@formiva/observability';
import { resolveRespondentToken, hashRespondentToken } from '../services/respondent-tokens.js';
import type { UploadSigner } from '../services/object-store.js';
import { MAX_DOCUMENTS_PER_CASE, checkUpload } from '../services/upload-policy.js';
import { auditSafe, httpError, loadPublishedForm, notFound } from './public-shared.js';

const UPLOAD_LINK_SECONDS = 300;

const body = z
  .object({
    idempotency_key: z.string().min(8).max(200),
    slot_key: z.string().min(1).max(64),
    filename: z.string().min(1).max(300),
    mime_type: z.string().min(1).max(100),
    size_bytes: z.number().int().positive(),
  })
  .strict();

export interface UploadRouteDeps {
  pool: Pool;
  store?: UploadSigner;
  quarantineBucket?: string;
  security: NonNullable<import('fastify').FastifyContextConfig['security']>;
  guard: (request: FastifyRequest, reply: { header: (k: string, v: string) => unknown }) => void;
}

export function registerUploadRoute(app: FastifyInstance, deps: UploadRouteDeps) {
  app.post(
    '/public/v1/forms/:respondent_token/upload-requests',
    { config: { security: deps.security }, bodyLimit: 16 * 1024 },
    async (request, reply) => {
      deps.guard(request, reply);
      const { respondent_token } = request.params as { respondent_token: string };
      const resolved = await resolveRespondentToken(deps.pool, respondent_token);
      if (!resolved) throw notFound();
      const parsed = body.safeParse(request.body);
      if (!parsed.success) throw httpError(400, 'invalid_body', 'Upload request is invalid.');
      const input = parsed.data;
      if (!deps.store || !deps.quarantineBucket) {
        throw httpError(503, 'uploads_unavailable', 'Uploads are not available right now.');
      }
      const store = deps.store;
      const bucket = deps.quarantineBucket;
      const correlationId = getOrCreateCorrelationId(
        request.headers as Record<string, string | string[] | undefined>,
        request.id,
      );
      const keyHash = createHash('sha256').update(input.idempotency_key, 'utf8').digest();
      const tokenHash = hashRespondentToken(respondent_token);

      const row = await withTenant(deps.pool, resolved.workspaceId, null, async (client) => {
        const form = await loadPublishedForm(client, resolved.formVersionId);
        const slot = form.definition.slots.find((s) => s.key === input.slot_key);
        if (!slot) throw httpError(422, 'unknown_slot', 'Unknown upload slot.');
        const check = checkUpload({
          filename: input.filename,
          mimeType: input.mime_type,
          sizeBytes: input.size_bytes,
          slotMimeTypes: slot.allowed_mime_types,
          slotMaxBytes: slot.max_size_bytes,
        });
        if (!check.ok) throw httpError(422, 'invalid_file', check.message);

        const lock = await client.query<{ case_id: string | null }>(
          `SELECT case_id FROM respondent_tokens
            WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
          [tokenHash],
        );
        if (lock.rowCount !== 1) throw notFound();
        const caseId = lock.rows[0]!.case_id;
        if (!caseId)
          throw httpError(409, 'draft_required', 'Save your answers before uploading files.');
        const status = await client.query<{ status: string }>(
          'SELECT status FROM cases WHERE id = $1 FOR UPDATE',
          [caseId],
        );
        if (status.rows[0]?.status !== 'draft') {
          throw httpError(409, 'not_draft', 'This form has already been submitted.');
        }
        const consent = await client.query(
          `SELECT 1 FROM consent_records WHERE case_id = $1 AND granted AND notice_version = $2 LIMIT 1`,
          [caseId, form.noticeVersion],
        );
        if (form.noticeVersion === null || consent.rowCount !== 1) {
          throw httpError(
            422,
            'consent_required',
            'Consent to the privacy notice is required before uploading.',
          );
        }

        // Same key, same request: hand back the same document. Same key, different request: conflict.
        const existing = await client.query<{
          id: string;
          slot_key: string;
          mime_type: string;
          size_bytes: string;
          object_key: string;
          status: string;
        }>(
          `SELECT id, slot_key, mime_type, size_bytes::text, object_key, status FROM case_documents
            WHERE case_id = $1 AND idempotency_key_hash = $2`,
          [caseId, keyHash],
        );
        const prior = existing.rows[0];
        if (prior) {
          if (
            prior.slot_key !== input.slot_key ||
            prior.mime_type !== input.mime_type ||
            Number(prior.size_bytes) !== input.size_bytes
          ) {
            throw httpError(
              409,
              'idempotency_conflict',
              'That idempotency key was used for a different request.',
            );
          }
          if (prior.status !== 'pending_upload') {
            throw httpError(409, 'already_uploaded', 'This file was already uploaded.');
          }
          return { documentId: prior.id, objectKey: prior.object_key, replay: true };
        }

        const count = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM case_documents WHERE case_id = $1 AND status <> 'deleted'`,
          [caseId],
        );
        if (count.rows[0]!.n >= MAX_DOCUMENTS_PER_CASE) {
          throw httpError(422, 'too_many_files', 'Too many files for this form.');
        }

        const documentId = randomUUID();
        const objectKey = `ws/${resolved.workspaceId}/cases/${caseId}/${documentId}`;
        await client.query(
          `INSERT INTO case_documents
             (id, workspace_id, case_id, bucket, object_key, original_filename, mime_type, size_bytes,
              doc_class, status, slot_key, idempotency_key_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_upload', $10, $11)`,
          [
            documentId,
            resolved.workspaceId,
            caseId,
            bucket,
            objectKey,
            check.name,
            input.mime_type,
            input.size_bytes,
            slot.doc_class,
            input.slot_key,
            keyHash,
          ],
        );
        // Metadata only: no file name (it can hold personal data).
        await auditSafe(
          client,
          'document.upload_requested',
          caseId,
          {
            document_id: documentId,
            slot_key: input.slot_key,
            mime_type: input.mime_type,
            size_bytes: input.size_bytes,
          },
          correlationId,
        );
        return { documentId, objectKey, replay: false };
      });

      const signed = await store.presignUpload({
        bucket,
        key: row.objectKey,
        contentType: input.mime_type,
        contentLength: input.size_bytes,
        expiresInSeconds: UPLOAD_LINK_SECONDS,
      });
      reply.header('cache-control', 'no-store');
      reply.code(row.replay ? 200 : 201);
      return {
        upload_id: row.documentId,
        document_id: row.documentId,
        method: signed.method,
        url: signed.url,
        headers: signed.headers,
        expires_at: signed.expiresAt.toISOString(),
        status: 'quarantine_pending',
        correlation_id: correlationId,
      };
    },
  );
}
