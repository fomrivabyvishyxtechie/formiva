import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getOrCreateCorrelationId } from '@formiva/observability';
import {
  memberRoleChangeRequestSchema,
  memberSchema,
  workspaceCreateRequestSchema,
  workspaceCreateResponseSchema,
  workspaceMemberListResponseSchema,
  workspaceMemberParamsSchema,
  workspaceMembersParamsSchema,
  idempotencyKeySchema,
} from '@formiva/contracts';

function routeError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode, publicMessage: message });
}

export async function registerWorkspaceRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/v1/workspaces', async (request, reply) => {
    const identity = request.authIdentity;
    if (!identity) throw routeError(401, 'Authentication is required.');

    const body = workspaceCreateRequestSchema.safeParse(request.body);
    if (!body.success) throw routeError(400, 'Invalid request body.');
    const idempotencyKey = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!idempotencyKey.success) throw routeError(400, 'Idempotency-Key is required.');
    const keyHash = createHash('sha256').update(idempotencyKey.data).digest();
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({ name: body.data.name.trim(), slug: body.data.slug.trim().toLowerCase() }),
      )
      .digest();

    try {
      const result = await pool.query<{
        workspace_id: string;
        name: string;
        slug: string;
        replay: boolean;
      }>('SELECT * FROM app.bootstrap_workspace($1, $2, $3::citext, $4, $5)', [
        identity.subject,
        body.data.name,
        body.data.slug,
        keyHash,
        requestHash,
      ]);
      const workspace = result.rows[0];
      if (!workspace) throw routeError(500, 'Workspace bootstrap failed.');
      return reply.code(workspace.replay ? 200 : 201).send(
        workspaceCreateResponseSchema.parse({
          id: workspace.workspace_id,
          name: workspace.name,
          slug: workspace.slug,
        }),
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505' || code === 'P0001')
        throw routeError(
          409,
          'Workspace slug or idempotency key conflicts with an existing request.',
        );
      if (code === '22023') throw routeError(400, 'Invalid workspace bootstrap request.');
      if (code === '28000')
        throw routeError(403, 'A verified identity is required to create a workspace.');
      throw error;
    }
  });

  app.get('/v1/workspaces/:workspace_id/members', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) throw routeError(401, 'Authentication is required.');

    const parsedParams = workspaceMembersParamsSchema.safeParse(request.params);
    if (!parsedParams.success) throw routeError(400, 'Workspace ID is invalid.');

    const response = await withTenant(
      { roles: ['owner', 'admin'], permissions: ['member.manage'] },
      async (client, context) => {
        if (context.workspaceId !== parsedParams.data.workspace_id.toLowerCase()) return null;
        const result = await client.query<{
          user_id: string;
          role: string;
          status: string;
        }>(
          `SELECT m.user_id, r.name AS role, m.status
             FROM workspace_members m
             JOIN roles r ON r.id = m.role_id AND r.workspace_id = m.workspace_id
            WHERE m.workspace_id = $1
              AND m.status <> 'left'
            ORDER BY m.created_at, m.user_id`,
          [context.workspaceId],
        );
        return workspaceMemberListResponseSchema.parse(result.rows);
      },
    );

    if (!response) throw routeError(404, 'Workspace not found.');
    return reply.send(response);
  });

  app.patch('/v1/workspaces/:workspace_id/members/:member_id', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) throw routeError(401, 'Authentication is required.');

    const parsedParams = workspaceMemberParamsSchema.safeParse(request.params);
    if (!parsedParams.success) throw routeError(400, 'Workspace member ID is invalid.');
    const parsedBody = memberRoleChangeRequestSchema.safeParse(request.body);
    if (!parsedBody.success) throw routeError(400, 'A valid workspace member role is required.');

    const correlationId = getOrCreateCorrelationId(
      request.headers as Record<string, string | string[] | undefined>,
    );
    if (!z.string().uuid().safeParse(correlationId).success) {
      throw routeError(400, 'X-Correlation-Id must be a UUID.');
    }
    const response = await withTenant(
      { roles: ['owner', 'admin'], permissions: ['member.manage'] },
      async (client, context) => {
        if (context.workspaceId !== parsedParams.data.workspace_id.toLowerCase()) return null;

        const lockedOwners = await client.query<{ user_id: string }>(
          `SELECT m.user_id
             FROM workspace_members m
             JOIN roles r ON r.id = m.role_id AND r.workspace_id = m.workspace_id
            WHERE m.workspace_id = $1
              AND m.status = 'active'
              AND r.name = 'owner'
            ORDER BY m.user_id
            FOR UPDATE OF m`,
          [context.workspaceId],
        );
        const targetResult = await client.query<{
          user_id: string;
          role: string;
          status: string;
        }>(
          `SELECT m.user_id, r.name AS role, m.status
             FROM workspace_members m
             JOIN roles r ON r.id = m.role_id AND r.workspace_id = m.workspace_id
            WHERE m.workspace_id = $1 AND m.user_id = $2
            FOR UPDATE OF m`,
          [context.workspaceId, parsedParams.data.member_id],
        );
        const target = targetResult.rows[0];
        if (!target || target.status === 'left') return null;

        const roleResult = await client.query<{ id: string }>(
          'SELECT id FROM roles WHERE workspace_id = $1 AND name = $2',
          [context.workspaceId, parsedBody.data.role],
        );
        const roleId = roleResult.rows[0]?.id;
        if (!roleId) return { kind: 'invalid-role' as const };
        if (
          context.role === 'admin' &&
          (target.role === 'owner' || parsedBody.data.role === 'owner')
        ) {
          return { kind: 'forbidden' as const };
        }
        if (
          target.status === 'active' &&
          target.role === 'owner' &&
          parsedBody.data.role !== 'owner' &&
          lockedOwners.rows.length <= 1
        ) {
          return { kind: 'last-owner' as const };
        }
        if (target.role === parsedBody.data.role) {
          return {
            kind: 'success' as const,
            member: memberSchema.parse(target),
          };
        }

        const updated = await client.query<{
          user_id: string;
          role: string;
          status: string;
        }>(
          `UPDATE workspace_members m
              SET role_id = $1
             FROM roles r
            WHERE m.workspace_id = $2
              AND m.user_id = $3
              AND r.id = $1
              AND r.workspace_id = m.workspace_id
            RETURNING m.user_id, r.name AS role, m.status`,
          [roleId, context.workspaceId, parsedParams.data.member_id],
        );
        const member = updated.rows[0];
        if (!member) return null;

        await client.query(
          `SELECT app.audit(
             'workspace.member_role_changed',
             'workspace_member',
             $1,
             NULL,
             $2::jsonb,
             'user',
             $3,
             $4
           )`,
          [
            member.user_id,
            JSON.stringify({ from_role: target.role, to_role: member.role }),
            context.userId,
            correlationId,
          ],
        );
        return { kind: 'success' as const, member: memberSchema.parse(member) };
      },
    );

    if (!response) throw routeError(404, 'Workspace member not found.');
    if (response.kind === 'invalid-role') throw routeError(400, 'Workspace role is invalid.');
    if (response.kind === 'forbidden') {
      throw routeError(403, 'You do not have permission to assign or change an owner role.');
    }
    if (response.kind === 'last-owner') {
      throw routeError(409, 'The last active owner cannot be demoted.');
    }
    return reply.send(response.member);
  });

  app.delete('/v1/workspaces/:workspace_id/members/:member_id', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) throw routeError(401, 'Authentication is required.');

    const parsedParams = workspaceMemberParamsSchema.safeParse(request.params);
    if (!parsedParams.success) throw routeError(400, 'Workspace member ID is invalid.');

    const correlationId = getOrCreateCorrelationId(
      request.headers as Record<string, string | string[] | undefined>,
    );
    if (!z.string().uuid().safeParse(correlationId).success) {
      throw routeError(400, 'X-Correlation-Id must be a UUID.');
    }
    const response = await withTenant(
      { roles: ['owner', 'admin'], permissions: ['member.manage'] },
      async (client, context) => {
        if (context.workspaceId !== parsedParams.data.workspace_id.toLowerCase()) return null;

        const lockedOwners = await client.query<{ user_id: string }>(
          `SELECT m.user_id
             FROM workspace_members m
             JOIN roles r ON r.id = m.role_id AND r.workspace_id = m.workspace_id
            WHERE m.workspace_id = $1
              AND m.status = 'active'
              AND r.name = 'owner'
            ORDER BY m.user_id
            FOR UPDATE OF m`,
          [context.workspaceId],
        );
        const targetResult = await client.query<{
          user_id: string;
          role: string;
          status: string;
        }>(
          `SELECT m.user_id, r.name AS role, m.status
             FROM workspace_members m
             JOIN roles r ON r.id = m.role_id AND r.workspace_id = m.workspace_id
            WHERE m.workspace_id = $1 AND m.user_id = $2
            FOR UPDATE OF m`,
          [context.workspaceId, parsedParams.data.member_id],
        );
        const target = targetResult.rows[0];
        if (!target) return null;
        if (target.status === 'left') {
          return { kind: 'success' as const, member: memberSchema.parse(target) };
        }
        if (context.role === 'admin' && target.role === 'owner') {
          return { kind: 'forbidden' as const };
        }
        if (
          target.status === 'active' &&
          target.role === 'owner' &&
          lockedOwners.rows.length <= 1
        ) {
          return { kind: 'last-owner' as const };
        }

        const updated = await client.query<{
          user_id: string;
          role: string;
          status: string;
        }>(
          `UPDATE workspace_members m
              SET status = 'left', left_at = now()
             FROM roles r
            WHERE m.workspace_id = $1
              AND m.user_id = $2
              AND r.id = m.role_id
              AND r.workspace_id = m.workspace_id
            RETURNING m.user_id, r.name AS role, m.status`,
          [context.workspaceId, parsedParams.data.member_id],
        );
        const member = updated.rows[0];
        if (!member) return null;

        await client.query(
          `SELECT app.audit(
             'workspace.member_removed',
             'workspace_member',
             $1,
             NULL,
             $2::jsonb,
             'user',
             $3,
             $4
           )`,
          [member.user_id, JSON.stringify({ role: member.role }), context.userId, correlationId],
        );
        return { kind: 'success' as const, member: memberSchema.parse(member) };
      },
    );

    if (!response) throw routeError(404, 'Workspace member not found.');
    if (response.kind === 'forbidden') {
      throw routeError(403, 'You do not have permission to remove an owner.');
    }
    if (response.kind === 'last-owner') {
      throw routeError(409, 'The last active owner cannot be removed.');
    }
    return reply.send(response.member);
  });
}
