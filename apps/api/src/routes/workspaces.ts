import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { getOrCreateCorrelationId } from '@formiva/observability';
import { withAuthorizedTenant } from '@formiva/db';
import {
  memberRoleChangeRequestSchema,
  memberSchema,
  workspaceCreateRequestSchema,
  workspaceCreateResponseSchema,
  workspaceMemberListResponseSchema,
  workspaceMemberParamsSchema,
  workspaceMembersParamsSchema,
} from '@formiva/contracts';

function routeError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode, publicMessage: message });
}

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

  app.get('/v1/workspaces/:workspace_id/members', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) return reply.code(401).send({ error: 'Authentication is required.' });

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

    if (!response) return reply.code(404).send({ error: 'Workspace not found.' });
    return reply.send(response);
  });

  app.patch('/v1/workspaces/:workspace_id/members/:member_id', async (request, reply) => {
    const withTenant = request.withTenant;
    if (!withTenant) return reply.code(401).send({ error: 'Authentication is required.' });

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

    if (!response) return reply.code(404).send({ error: 'Workspace member not found.' });
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
    if (!withTenant) return reply.code(401).send({ error: 'Authentication is required.' });

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

    if (!response) return reply.code(404).send({ error: 'Workspace member not found.' });
    if (response.kind === 'forbidden') {
      throw routeError(403, 'You do not have permission to remove an owner.');
    }
    if (response.kind === 'last-owner') {
      throw routeError(409, 'The last active owner cannot be removed.');
    }
    return reply.send(response.member);
  });
}
