import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { caseListQuerySchema, caseListResponseSchema, caseSchema } from '@formiva/contracts';

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
}
