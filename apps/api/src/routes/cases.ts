import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getOrCreateCorrelationId } from '@formiva/observability';
import {
  caseListQuerySchema,
  caseListResponseSchema,
  caseCancelParamsSchema,
  caseCancelRequestSchema,
  caseCancelResponseSchema,
  caseDocumentsParamsSchema,
  caseDocumentsResponseSchema,
  caseReworkIdempotencyKeySchema,
  caseReworkParamsSchema,
  caseReworkRequestSchema,
  caseReworkResponseSchema,
  caseSchema,
  caseTimelineParamsSchema,
  caseTimelineResponseSchema,
} from '@formiva/contracts';

export async function registerCaseRoutes(app: FastifyInstance) {
  app.get('/v1/cases', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) {
      return reply.code(401).send({ error: 'Authentication is required.' });
    }

    const parsedQuery = caseListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      const error = new Error('Case list query is invalid.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'Case list query is invalid.';
      throw error;
    }

    const { status, limit, offset } = parsedQuery.data;
    const response = await withTenant({ permissions: ['case.read'] }, async (client, context) => {
      const values: (string | number)[] = [context.workspaceId];
      const statusFilter = status ? `AND status = $${values.push(status)}` : '';
      values.push(limit, offset);
      const limitParameter = values.length - 1;
      const offsetParameter = values.length;
      const result = await client.query<{
        id: string;
        case_number: string;
        status: string;
        created_at: Date;
      }>(
        `SELECT id, case_number::text AS case_number, status, created_at
             FROM cases
            WHERE workspace_id = $1 ${statusFilter}
            ORDER BY created_at DESC, id DESC
            LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        values,
      );
      return caseListResponseSchema.parse({
        items: result.rows.map((row) => ({
          ...row,
          created_at: row.created_at.toISOString(),
        })),
        limit,
        offset,
      });
    });

    return reply.send(response);
  });

  app.get('/v1/cases/:case_id', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) {
      return reply.code(401).send({ error: 'Authentication is required.' });
    }

    const { case_id } = request.params as { case_id: string };
    const parsedId = z.string().uuid().safeParse(case_id);
    if (!parsedId.success) {
      const error = new Error('Case ID is invalid.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'Case ID is invalid.';
      throw error;
    }

    const response = await withTenant({ permissions: ['case.read'] }, async (client, context) => {
      const result = await client.query<{
        id: string;
        case_number: string;
        status: string;
        created_at: Date;
      }>(
        `SELECT id, case_number::text AS case_number, status, created_at
             FROM cases
            WHERE id = $1 AND workspace_id = $2`,
        [parsedId.data, context.workspaceId],
      );

      const row = result.rows[0];
      if (!row) {
        return null;
      }

      return caseSchema.parse({
        ...row,
        created_at: row.created_at.toISOString(),
      });
    });

    if (!response) {
      return reply.code(404).send({ error: 'Case not found.' });
    }

    return reply.send(response);
  });

  app.get('/v1/cases/:case_id/timeline', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) {
      return reply.code(401).send({ error: 'Authentication is required.' });
    }

    const parsedParams = caseTimelineParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      const error = new Error('Case ID is invalid.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'Case ID is invalid.';
      throw error;
    }

    const response = await withTenant({ permissions: ['case.read'] }, async (client, context) => {
      const result = await client.query<{
        id: string;
        occurred_at: Date | null;
        correlation_id: string | null;
      }>(
        `SELECT c.id, ae.occurred_at, ae.correlation_id
           FROM cases c
           LEFT JOIN audit_events ae
             ON ae.workspace_id = c.workspace_id
            AND ae.object_type = 'case'
            AND ae.object_id = c.id::text
            AND ae.correlation_id IS NOT NULL
          WHERE c.id = $1 AND c.workspace_id = $2
          ORDER BY ae.occurred_at ASC`,
        [parsedParams.data.case_id, context.workspaceId],
      );

      if (result.rows.length === 0) {
        return null;
      }

      return caseTimelineResponseSchema.parse({
        items: result.rows.flatMap((row) =>
          row.occurred_at && row.correlation_id
            ? [
                {
                  occurred_at: row.occurred_at.toISOString(),
                  correlation_id: row.correlation_id,
                  event: 'case_activity' as const,
                },
              ]
            : [],
        ),
      });
    });

    if (!response) {
      return reply.code(404).send({ error: 'Case not found.' });
    }

    return reply.send(response);
  });

  app.get('/v1/cases/:case_id/documents', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) {
      return reply.code(401).send({ error: 'Authentication is required.' });
    }

    const parsedParams = caseDocumentsParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      const error = new Error('Case ID is invalid.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'Case ID is invalid.';
      throw error;
    }

    const response = await withTenant(
      { permissions: ['document.read_sensitive'] },
      async (client, context) => {
        const result = await client.query<{
          case_id: string;
          document_id: string | null;
          doc_class: string | null;
          status: string | null;
          scan_state: string | null;
          hash_state: string | null;
          retention_state: string | null;
          retain_until: Date | null;
          scanned_at: Date | null;
          created_at: Date | null;
          updated_at: Date | null;
        }>(
          `SELECT c.id AS case_id,
                  d.id AS document_id,
                  d.doc_class,
                  d.status,
                  coalesce(scan.result, 'not_scanned') AS scan_state,
                  CASE WHEN d.sha256 IS NULL THEN 'unavailable' ELSE 'available' END AS hash_state,
                  CASE
                    WHEN d.legal_hold THEN 'held'
                    WHEN d.retain_until IS NULL THEN 'unspecified'
                    WHEN d.retain_until <= now() THEN 'expired'
                    ELSE 'scheduled'
                  END AS retention_state,
                  d.retain_until,
                  scan.scanned_at,
                  d.created_at,
                  d.updated_at
             FROM cases c
             LEFT JOIN case_documents d
               ON d.case_id = c.id
              AND d.workspace_id = c.workspace_id
              AND d.deleted_at IS NULL
             LEFT JOIN LATERAL (
               SELECT ds.result, ds.scanned_at
                 FROM document_scans ds
                WHERE ds.document_id = d.id
                  AND ds.workspace_id = d.workspace_id
                ORDER BY ds.scanned_at DESC, ds.id DESC
                LIMIT 1
             ) scan ON true
            WHERE c.id = $1
              AND c.workspace_id = $2
            ORDER BY d.created_at ASC, d.id ASC`,
          [parsedParams.data.case_id, context.workspaceId],
        );

        if (result.rows.length === 0) {
          return null;
        }

        return caseDocumentsResponseSchema.parse({
          items: result.rows.flatMap((row) =>
            row.document_id
              ? [
                  {
                    id: row.document_id,
                    doc_class: row.doc_class,
                    status: row.status,
                    scan_state: row.scan_state,
                    hash_state: row.hash_state,
                    retention_state: row.retention_state,
                    retain_until: row.retain_until?.toISOString() ?? null,
                    scanned_at: row.scanned_at?.toISOString() ?? null,
                    created_at: row.created_at?.toISOString(),
                    updated_at: row.updated_at?.toISOString(),
                  },
                ]
              : [],
          ),
        });
      },
    );

    if (!response) {
      return reply.code(404).send({ error: 'Case not found.' });
    }

    return reply.send(response);
  });

  app.post('/v1/cases/:case_id/rework', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) {
      return reply.code(401).send({ error: 'Authentication is required.' });
    }

    const parsedParams = caseReworkParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      const error = new Error('Case ID is invalid.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'Case ID is invalid.';
      throw error;
    }

    const parsedBody = caseReworkRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      const error = new Error('A safe rework reason is required.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'A safe rework reason is required.';
      throw error;
    }

    const parsedIdempotencyKey = caseReworkIdempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );
    if (!parsedIdempotencyKey.success) {
      const error = new Error('A valid Idempotency-Key is required.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'A valid Idempotency-Key is required.';
      throw error;
    }

    const correlationId = getOrCreateCorrelationId(
      request.headers as Record<string, string | string[] | undefined>,
    );
    if (!z.string().uuid().safeParse(correlationId).success) {
      const error = new Error('X-Correlation-Id must be a UUID.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'X-Correlation-Id must be a UUID.';
      throw error;
    }

    const keyHash = createHash('sha256').update(parsedIdempotencyKey.data).digest('hex');
    const response = await withTenant(
      { permissions: ['case.approve'] },
      async (client, context) => {
        const caseResult = await client.query<{ status: string }>(
          `SELECT status
             FROM cases
            WHERE id = $1 AND workspace_id = $2
            FOR UPDATE`,
          [parsedParams.data.case_id, context.workspaceId],
        );
        const currentCase = caseResult.rows[0];
        if (!currentCase) {
          return { kind: 'not-found' as const };
        }

        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 42))`, [
          `${context.workspaceId}:${keyHash}`,
        ]);

        const priorResult = await client.query<{
          object_id: string | null;
          reason: string | null;
          correlation_id: string | null;
        }>(
          `SELECT object_id, reason, correlation_id
             FROM audit_events
            WHERE workspace_id = $1
              AND object_type = 'case'
              AND action = 'case.rework_requested'
              AND payload->>'idempotency_key_hash' = $2
            LIMIT 1`,
          [context.workspaceId, keyHash],
        );
        const priorEvent = priorResult.rows[0];
        if (priorEvent) {
          if (
            priorEvent.object_id !== parsedParams.data.case_id ||
            priorEvent.reason !== parsedBody.data.reason ||
            !priorEvent.correlation_id
          ) {
            return { kind: 'conflict' as const };
          }
          return {
            kind: 'success' as const,
            value: caseReworkResponseSchema.parse({
              case_id: parsedParams.data.case_id,
              status: 'review_queued',
              correlation_id: priorEvent.correlation_id,
            }),
          };
        }

        const transitionResult = await client.query<{ allowed: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM app.state_transitions
              WHERE entity = 'case'
                AND from_status = $1
                AND to_status = 'review_queued'
           ) AS allowed`,
          [currentCase.status],
        );
        if (!transitionResult.rows[0]?.allowed) {
          return { kind: 'conflict' as const };
        }

        const updateResult = await client.query<{ status: string }>(
          `UPDATE cases
              SET status = 'review_queued'
            WHERE id = $1 AND workspace_id = $2
            RETURNING status`,
          [parsedParams.data.case_id, context.workspaceId],
        );
        if (!updateResult.rows[0]) {
          return { kind: 'not-found' as const };
        }

        await client.query(
          `SELECT app.audit(
             'case.rework_requested',
             'case',
             $1,
             $2,
             $3::jsonb,
             'user',
             $4,
             $5
           )`,
          [
            parsedParams.data.case_id,
            parsedBody.data.reason,
            JSON.stringify({
              from_status: currentCase.status,
              to_status: 'review_queued',
              idempotency_key_hash: keyHash,
            }),
            context.userId,
            correlationId,
          ],
        );

        return {
          kind: 'success' as const,
          value: caseReworkResponseSchema.parse({
            case_id: parsedParams.data.case_id,
            status: 'review_queued',
            correlation_id: correlationId,
          }),
        };
      },
    );

    if (response.kind === 'not-found') {
      return reply.code(404).send({ error: 'Case not found.' });
    }
    if (response.kind === 'conflict') {
      const error = new Error('Case cannot be moved to rework with this request.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 409;
      error.publicMessage = 'Case cannot be moved to rework with this request.';
      throw error;
    }

    return reply.code(200).send(response.value);
  });

  app.post('/v1/cases/:case_id/cancel', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) {
      return reply.code(401).send({ error: 'Authentication is required.' });
    }

    const parsedParams = caseCancelParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      const error = new Error('Case ID is invalid.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'Case ID is invalid.';
      throw error;
    }

    const parsedBody = caseCancelRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      const error = new Error('A safe cancellation reason is required.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'A safe cancellation reason is required.';
      throw error;
    }

    const parsedIdempotencyKey = caseReworkIdempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );
    if (!parsedIdempotencyKey.success) {
      const error = new Error('A valid Idempotency-Key is required.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'A valid Idempotency-Key is required.';
      throw error;
    }

    const correlationId = getOrCreateCorrelationId(
      request.headers as Record<string, string | string[] | undefined>,
    );
    if (!z.string().uuid().safeParse(correlationId).success) {
      const error = new Error('X-Correlation-Id must be a UUID.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 400;
      error.publicMessage = 'X-Correlation-Id must be a UUID.';
      throw error;
    }

    const keyHash = createHash('sha256').update(parsedIdempotencyKey.data).digest('hex');
    const response = await withTenant(
      { permissions: ['case.approve'] },
      async (client, context) => {
        const caseResult = await client.query<{ status: string }>(
          `SELECT status
             FROM cases
            WHERE id = $1 AND workspace_id = $2
            FOR UPDATE`,
          [parsedParams.data.case_id, context.workspaceId],
        );
        const currentCase = caseResult.rows[0];
        if (!currentCase) {
          return { kind: 'not-found' as const };
        }

        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 42))`, [
          `${context.workspaceId}:${keyHash}`,
        ]);

        const priorResult = await client.query<{
          object_id: string | null;
          reason: string | null;
          correlation_id: string | null;
        }>(
          `SELECT object_id, reason, correlation_id
             FROM audit_events
            WHERE workspace_id = $1
              AND object_type = 'case'
              AND action = 'case.cancelled'
              AND payload->>'idempotency_key_hash' = $2
            LIMIT 1`,
          [context.workspaceId, keyHash],
        );
        const priorEvent = priorResult.rows[0];
        if (priorEvent) {
          if (
            priorEvent.object_id !== parsedParams.data.case_id ||
            priorEvent.reason !== parsedBody.data.reason ||
            !priorEvent.correlation_id
          ) {
            return { kind: 'conflict' as const };
          }
          return {
            kind: 'success' as const,
            value: caseCancelResponseSchema.parse({
              case_id: parsedParams.data.case_id,
              status: 'cancelled',
              correlation_id: priorEvent.correlation_id,
            }),
          };
        }

        const transitionResult = await client.query<{ allowed: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM app.state_transitions
              WHERE entity = 'case'
                AND from_status = $1
                AND to_status = 'cancelled'
           ) AS allowed`,
          [currentCase.status],
        );
        if (!transitionResult.rows[0]?.allowed) {
          return { kind: 'conflict' as const };
        }

        const updateResult = await client.query<{ status: string }>(
          `UPDATE cases
              SET status = 'cancelled'
            WHERE id = $1 AND workspace_id = $2
            RETURNING status`,
          [parsedParams.data.case_id, context.workspaceId],
        );
        if (!updateResult.rows[0]) {
          return { kind: 'not-found' as const };
        }

        await client.query(
          `SELECT app.audit(
             'case.cancelled',
             'case',
             $1,
             $2,
             $3::jsonb,
             'user',
             $4,
             $5
           )`,
          [
            parsedParams.data.case_id,
            parsedBody.data.reason,
            JSON.stringify({
              from_status: currentCase.status,
              to_status: 'cancelled',
              idempotency_key_hash: keyHash,
            }),
            context.userId,
            correlationId,
          ],
        );

        return {
          kind: 'success' as const,
          value: caseCancelResponseSchema.parse({
            case_id: parsedParams.data.case_id,
            status: 'cancelled',
            correlation_id: correlationId,
          }),
        };
      },
    );

    if (response.kind === 'not-found') {
      return reply.code(404).send({ error: 'Case not found.' });
    }
    if (response.kind === 'conflict') {
      const error = new Error('Case cannot be cancelled with this request.') as Error & {
        statusCode: number;
        publicMessage: string;
      };
      error.statusCode = 409;
      error.publicMessage = 'Case cannot be cancelled with this request.';
      throw error;
    }

    return reply.code(200).send(response.value);
  });
}
