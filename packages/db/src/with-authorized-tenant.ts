import { Pool, PoolClient } from 'pg';
import { withTenant } from './with-tenant';

export interface TenantAuthorizationContext {
  workspaceId: string;
  userId: string;
  role: string;
  permissions: string[];
}

export interface TenantAuthorizationRequirements {
  roles?: readonly string[];
  permissions?: readonly string[];
}

export class TenantAuthorizationError extends Error {
  constructor(
    public readonly statusCode: 400 | 403 | 404,
    public readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'TenantAuthorizationError';
  }
}

export async function withAuthorizedTenant<T>(
  pool: Pool,
  authSubject: string,
  workspaceSelector: string | undefined,
  requirements: TenantAuthorizationRequirements,
  callback: (client: PoolClient, context: TenantAuthorizationContext) => Promise<T>,
): Promise<T> {
  const memberships = await withTenant(pool, null, null, async (client) => {
    const result = await client.query<{ ws_id: string }>(
      'SELECT ws_id FROM ops.workspaces_for_user($1)',
      [authSubject],
    );
    return result.rows;
  });

  let selectedWorkspaceId: string;
  if (workspaceSelector) {
    const membership = memberships.find(
      (candidate) => candidate.ws_id.toLowerCase() === workspaceSelector.toLowerCase(),
    );
    if (!membership) {
      throw new TenantAuthorizationError(404, 'Workspace not found.');
    }
    selectedWorkspaceId = membership.ws_id;
  } else if (memberships.length === 1) {
    const membership = memberships[0];
    if (!membership) throw new TenantAuthorizationError(404, 'Workspace not found.');
    selectedWorkspaceId = membership.ws_id;
  } else if (memberships.length > 1) {
    throw new TenantAuthorizationError(400, 'Select a workspace with X-Workspace-Id.');
  } else {
    throw new TenantAuthorizationError(404, 'Workspace not found.');
  }

  const userIds = await withTenant(pool, selectedWorkspaceId, null, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT u.id
         FROM users u
         JOIN workspace_members m ON m.user_id = u.id
        WHERE u.auth_subject = $1
          AND u.status = 'active'
          AND m.workspace_id = $2
          AND m.status = 'active'`,
      [authSubject, selectedWorkspaceId],
    );
    return result.rows;
  });

  const userId = userIds[0]?.id;
  if (userIds.length !== 1 || !userId) {
    throw new TenantAuthorizationError(404, 'Workspace not found.');
  }

  return withTenant(pool, selectedWorkspaceId, userId, async (client) => {
    const result = await client.query<{ role: string; permissions: string[] }>(
      `SELECT r.name AS role,
              coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key)
                FILTER (WHERE rp.permission_key IS NOT NULL), ARRAY[]::text[]) AS permissions
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
         JOIN workspaces w ON w.id = m.workspace_id
         JOIN roles r ON r.id = m.role_id AND r.workspace_id = m.workspace_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.workspace_id = r.workspace_id
        WHERE m.workspace_id = $1
          AND m.user_id = $2
          AND u.auth_subject = $3
          AND u.status = 'active'
          AND m.status = 'active'
          AND w.status = 'active'
        GROUP BY r.name`,
      [selectedWorkspaceId, userId, authSubject],
    );
    const membership = result.rows[0];
    if (!membership) {
      throw new TenantAuthorizationError(404, 'Workspace not found.');
    }
    if (
      (requirements.roles?.length && !requirements.roles.includes(membership.role)) ||
      requirements.permissions?.some((permission) => !membership.permissions.includes(permission))
    ) {
      throw new TenantAuthorizationError(403, 'You do not have permission to perform this action.');
    }

    return callback(client, {
      workspaceId: selectedWorkspaceId,
      userId,
      role: membership.role,
      permissions: membership.permissions,
    });
  });
}
