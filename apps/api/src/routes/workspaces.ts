import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { withAuthorizedTenant } from '@formiva/db';
import { workspaceCreateRequestSchema, workspaceCreateResponseSchema } from '@formiva/contracts';

export async function registerWorkspaceRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/v1/workspaces', async (request, reply) => {
    const identity = request.authIdentity;
    if (!identity) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const body = workspaceCreateRequestSchema.parse(request.body);

    return await withAuthorizedTenant(
      pool,
      identity.subject,
      undefined,
      {},
      async (client, context) => {
        // Bootstrap workspace
        const result = await client.query(
          'INSERT INTO workspaces (name, slug, status) VALUES ($1, $2, $3) RETURNING id',
          [body.name, body.slug, 'active'],
        );
        const workspaceId = result.rows[0].id;

        // Bootstrap workspace using system function
        await client.query('SELECT app.bootstrap_workspace($1, $2)', [workspaceId, context.userId]);

        const response = workspaceCreateResponseSchema.parse({
          id: workspaceId,
          name: body.name,
          slug: body.slug,
        });

        return reply.code(201).send(response);
      },
    );
  });
}
