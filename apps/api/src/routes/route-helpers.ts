import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z, type ZodType } from 'zod';
import { getOrCreateCorrelationId } from '@formiva/observability';

export function fail(status: number, message: string, code?: string): never {
  throw Object.assign(new Error(message), { statusCode: status, publicMessage: message, code });
}

export function parse<T>(schema: ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) fail(400, message, 'invalid_request');
  return result.data;
}

export function correlationOf(request: FastifyRequest): string {
  const id = getOrCreateCorrelationId(
    request.headers as Record<string, string | string[] | undefined>,
  );
  if (!z.string().uuid().safeParse(id).success) fail(400, 'X-Correlation-Id must be a UUID.');
  return id;
}

export function audit(
  client: PoolClient,
  userId: string,
  correlationId: string,
  action: string,
  objectType: string,
  objectId: string,
  reason: string | null,
  payload: Record<string, unknown>,
) {
  return client.query(`SELECT app.audit($1, $2, $3, $4, $5::jsonb, 'user', $6, $7)`, [
    action,
    objectType,
    objectId,
    reason,
    JSON.stringify(payload),
    userId,
    correlationId,
  ]);
}

export const jwtRoute = (permissions: string[], pathParams: string[] = []) => ({
  config: {
    security: {
      authKind: 'jwt' as const,
      permissions,
      tenantScope: 'workspace' as const,
      pathParams,
    },
  },
});
