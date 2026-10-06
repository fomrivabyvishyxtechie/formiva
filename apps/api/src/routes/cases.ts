import type { FastifyInstance } from 'fastify';
import { caseListQuerySchema, caseListResponseSchema } from '@formiva/contracts';

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
}
