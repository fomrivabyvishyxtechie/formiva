import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  idempotencyKeySchema,
  invitationAcceptRequestSchema,
  invitationAcceptResponseSchema,
  invitationDeleteParamsSchema,
  invitationParamsSchema,
  invitationRequestSchema,
  invitationResponseSchema,
} from '@formiva/contracts';

function routeError(statusCode: number, publicMessage: string) {
  return Object.assign(new Error(publicMessage), { statusCode, publicMessage });
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function requestHash(value: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(value)).digest();
}

export async function registerInvitationRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/v1/workspaces/:workspace_id/members/invitations', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) throw routeError(401, 'Authentication is required.');
    const params = invitationParamsSchema.safeParse(request.params);
    const body = invitationRequestSchema.safeParse(request.body);
    const idempotencyKey = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!params.success || !body.success || !idempotencyKey.success)
      throw routeError(400, 'Invalid invitation request.');

    const email = normalizedEmail(body.data.email);
    const roleName = body.data.role.trim().toLowerCase();
    const keyHash = createHash('sha256').update(idempotencyKey.data).digest();
    const bodyHash = requestHash({ email, role: roleName });

    return withTenant(
      { roles: ['owner', 'admin'], permissions: ['member.manage'] },
      async (client, context) => {
        if (context.workspaceId !== params.data.workspace_id.toLowerCase())
          throw routeError(404, 'Workspace not found.');

        const actor = await client.query<{ id: string }>(
          `SELECT id
             FROM users
            WHERE id = $1 AND status = 'active' AND email_verified
              AND email_verified_at IS NOT NULL
              AND identity_source_updated_at IS NOT NULL
              AND identity_synced_at >= now() - interval '15 minutes'
            FOR UPDATE`,
          [context.userId],
        );
        if (!actor.rows[0]) throw routeError(403, 'A fresh verified identity is required.');

        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 23))', [
          `${context.workspaceId}:${context.userId}:${keyHash.toString('hex')}`,
        ]);
        const prior = await client.query<{ id: string; expires_at: Date; request_hash: Buffer }>(
          `SELECT id, expires_at, request_hash
             FROM workspace_invitations
            WHERE workspace_id = $1 AND created_by = $2 AND idempotency_key_hash = $3
            FOR UPDATE`,
          [context.workspaceId, context.userId, keyHash],
        );
        const existing = prior.rows[0];
        if (existing) {
          if (!existing.request_hash.equals(bodyHash))
            throw routeError(409, 'Idempotency key was already used for a different invitation.');
          return reply.send(
            invitationResponseSchema.parse({
              id: existing.id,
              expires_at: existing.expires_at.toISOString(),
            }),
          );
        }

        if (context.role === 'admin' && roleName === 'owner')
          throw routeError(403, 'Administrators cannot grant the owner role.');
        const role = await client.query<{ id: string }>(
          'SELECT id FROM roles WHERE workspace_id = $1 AND name = $2',
          [context.workspaceId, roleName],
        );
        if (!role.rows[0]) throw routeError(400, 'Workspace role is invalid.');

        const token = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(token).digest();
        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
        const created = await client.query<{ id: string; expires_at: Date }>(
          `INSERT INTO workspace_invitations
             (workspace_id, role_id, email, token_hash, expires_at, created_by, idempotency_key_hash, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, expires_at`,
          [
            context.workspaceId,
            role.rows[0].id,
            email,
            tokenHash,
            expiresAt,
            context.userId,
            keyHash,
            bodyHash,
          ],
        );
        const invitation = created.rows[0];
        if (!invitation) throw routeError(500, 'Invitation creation failed.');
        await client.query(
          "SELECT app.audit('workspace.invitation_created', 'workspace_invitation', $1, NULL, '{}'::jsonb, 'user', $2, NULL)",
          [invitation.id, context.userId],
        );

        const response = {
          id: invitation.id,
          expires_at: invitation.expires_at.toISOString(),
          ...(process.env.NODE_ENV === 'development' &&
          process.env.SYNTHETIC_INTEGRATIONS === 'true'
            ? { token }
            : {}),
        };
        return reply.code(201).send(invitationResponseSchema.parse(response));
      },
    );
  });

  app.post('/v1/invitations/accept', async (request, reply) => {
    if (!request.authIdentity) throw routeError(401, 'Authentication is required.');
    const body = invitationAcceptRequestSchema.safeParse(request.body);
    if (!body.success) throw routeError(400, 'Invalid invitation request.');
    try {
      const result = await pool.query<{ workspace_id: string; user_id: string; role: string }>(
        'SELECT * FROM app.accept_invitation($1, $2)',
        [request.authIdentity.subject, createHash('sha256').update(body.data.token).digest()],
      );
      const membership = result.rows[0];
      if (!membership) throw routeError(404, 'Invitation not found.');
      return reply.send(invitationAcceptResponseSchema.parse(membership));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P0002') throw routeError(404, 'Invitation not found.');
      if (code === '28000') throw routeError(403, 'A fresh verified identity is required.');
      throw error;
    }
  });

  app.delete('/v1/invitations/:invitation_id', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) throw routeError(401, 'Authentication is required.');
    const params = invitationDeleteParamsSchema.safeParse(request.params);
    if (!params.success) throw routeError(400, 'Invitation ID is invalid.');
    return withTenant(
      { roles: ['owner', 'admin'], permissions: ['member.manage'] },
      async (client, context) => {
        const invitation = await client.query<{ id: string; role: string }>(
          `SELECT i.id, r.name AS role
             FROM workspace_invitations i
             JOIN roles r ON r.id = i.role_id AND r.workspace_id = i.workspace_id
            WHERE i.id = $1 AND i.workspace_id = $2
              AND i.revoked_at IS NULL AND i.consumed_at IS NULL
            FOR UPDATE OF i`,
          [params.data.invitation_id, context.workspaceId],
        );
        const target = invitation.rows[0];
        if (!target) throw routeError(404, 'Invitation not found.');
        if (context.role === 'admin' && target.role === 'owner')
          throw routeError(403, 'Administrators cannot revoke an owner invitation.');

        const revoked = await client.query<{ id: string }>(
          `UPDATE workspace_invitations
              SET revoked_at = now()
            WHERE id = $1 AND workspace_id = $2
              AND revoked_at IS NULL AND consumed_at IS NULL
          RETURNING id`,
          [target.id, context.workspaceId],
        );
        if (!revoked.rows[0]) throw routeError(404, 'Invitation not found.');
        await client.query(
          "SELECT app.audit('workspace.invitation_revoked', 'workspace_invitation', $1, NULL, '{}'::jsonb, 'user', $2, NULL)",
          [target.id, context.userId],
        );
        return reply.code(204).send();
      },
    );
  });
}
