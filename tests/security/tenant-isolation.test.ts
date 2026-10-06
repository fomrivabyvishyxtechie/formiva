import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/index.js';
import { createSyntheticClerk } from '../../apps/api/test/support/synthetic-clerk.js';
import { runMigrations, withAuthorizedTenant, withTenant } from '../../packages/db/src/index.js';

type DbPool = Parameters<typeof withTenant>[0];
type DbClient = Parameters<Parameters<typeof withTenant>[3]>[0];
type RouteMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

const requireFromApi = createRequire(resolve(process.cwd(), 'apps/api/package.json'));
const { Pool } = requireFromApi('pg') as {
  Pool: new (options: {
    connectionString: string;
    max?: number;
    onConnect?: (client: DbClient) => void;
  }) => DbPool;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must point to the ephemeral PostgreSQL 16 test database');
}

const database = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '::1'].includes(database.hostname) ||
  database.port !== '55432' ||
  database.pathname !== '/formiva_test' ||
  database.username !== 'formiva_test'
) {
  throw new Error('Refusing to run tenant isolation tests outside the local formiva_test database');
}

const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const appPool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  onConnect: (client) => {
    void client.query('SET ROLE formiva_app');
  },
});

const fixtureId = randomUUID();
const workspaceIds = [randomUUID(), randomUUID()];
const templateIds = [randomUUID(), randomUUID()];
const versionIds = [randomUUID(), randomUUID()];
const caseIds = [randomUUID(), randomUUID()];
const userId = randomUUID();
const authSubject = `synthetic_tenant_isolation_${fixtureId}`;
const workspaceKeys = [`tenant-isolation-${fixtureId}-a`, `tenant-isolation-${fixtureId}-b`];
const roleId = randomUUID();
let fixturesCreated = false;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let unauthenticatedApp: Awaited<ReturnType<typeof buildApp>> | undefined;
let viewerToken: string;

const authorizationCoverage: Record<
  string,
  {
    missingAuth: 401;
    insufficientRole: 403 | 'not-applicable';
    authenticatedAccess: 'tested' | 'not-applicable';
    foreignResource: 404 | 'not-applicable';
  }
> = {
  'POST /v1/workspaces': {
    missingAuth: 401,
    insufficientRole: 'not-applicable',
    authenticatedAccess: 'not-applicable',
    foreignResource: 'not-applicable',
  },
  'GET /v1/cases': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 'not-applicable',
  },
  'GET /v1/cases/:case_id': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
};

function readProtectedRoutes(routeTree: string): { method: RouteMethod; path: string }[] {
  const ancestors: string[] = [];
  return routeTree.split('\n').flatMap((line) => {
    const match = line.match(/^((?:(?:│   )|(?:    ))*)(?:[├└]── )(.+?) \(([^)]+)\)$/);
    const depth = (match?.[1].length ?? 0) / 4;
    const routeSegment = match?.[2];
    const methods = match?.[3];
    if (!routeSegment || !methods) return [];

    const routePath =
      depth > 0 && routeSegment.startsWith('/')
        ? `${ancestors[depth - 1] ?? ''}${routeSegment}`
        : routeSegment;
    ancestors[depth] = routePath;
    ancestors.length = depth + 1;
    if ((!routePath.startsWith('/v1/') && routePath !== '/v1') || !methods) return [];

    return methods.split(', ').map((method) => {
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
        throw new Error(`Unsupported method in Fastify route inventory: ${method}`);
      }
      return { method: method as RouteMethod, path: routePath };
    });
  });
}

function routeCoverageKey(route: { method: RouteMethod; path: string }): string {
  return `${route.method === 'HEAD' ? 'GET' : route.method} ${route.path}`;
}

function injectPath(routePath: string): string {
  return routePath
    .replace(/\{([^}]+)\}/g, () => randomUUID())
    .replace(/:([A-Za-z][\w]*)/g, () => randomUUID());
}

describe('Phase 2.4 tenant isolation', () => {
  beforeAll(async () => {
    await runMigrations(adminPool);
    const databaseInfo = await adminPool.query<{
      version: string;
      current_database: string;
    }>('SELECT version(), current_database()');
    assert.match(databaseInfo.rows[0].version, /^PostgreSQL 16\./);
    assert.equal(databaseInfo.rows[0].current_database, 'formiva_test');

    const clerk = await createSyntheticClerk();
    viewerToken = await clerk.createToken(authSubject);

    await adminPool.query(
      `INSERT INTO workspaces (id, slug, name)
       VALUES ($1, $3, 'Synthetic tenant isolation A'),
              ($2, $4, 'Synthetic tenant isolation B')`,
      [workspaceIds[0], workspaceIds[1], `${fixtureId}-a`, `${fixtureId}-b`],
    );
    fixturesCreated = true;
    await adminPool.query(
      `INSERT INTO users (id, auth_subject, email, display_name)
       VALUES ($1, $2, $3, 'Synthetic Tenant Isolation User')`,
      [userId, authSubject, `${fixtureId}@example.invalid`],
    );
    await adminPool.query(
      `INSERT INTO roles (id, workspace_id, name, is_system)
       VALUES ($1, $2, 'viewer', true)`,
      [roleId, workspaceIds[0]],
    );
    await adminPool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role_id, status, joined_at)
       VALUES ($1, $2, $3, 'active', now())`,
      [workspaceIds[0], userId, roleId],
    );
    await adminPool.query(
      `INSERT INTO role_permissions (workspace_id, role_id, permission_key)
       VALUES ($1, $2, 'case.read')`,
      [workspaceIds[0], roleId],
    );
    await adminPool.query(
      `INSERT INTO form_templates (id, workspace_id, key, name)
       VALUES ($1, $3, $5, 'Synthetic tenant A template'),
              ($2, $4, $6, 'Synthetic tenant B template')`,
      [
        templateIds[0],
        templateIds[1],
        workspaceIds[0],
        workspaceIds[1],
        workspaceKeys[0],
        workspaceKeys[1],
      ],
    );
    await adminPool.query(
      `INSERT INTO form_template_versions (id, workspace_id, template_id, version_number)
       VALUES ($1, $3, $5, 1),
              ($2, $4, $6, 1)`,
      [
        versionIds[0],
        versionIds[1],
        workspaceIds[0],
        workspaceIds[1],
        templateIds[0],
        templateIds[1],
      ],
    );
    await adminPool.query(
      `INSERT INTO cases (id, workspace_id, case_number, form_version_id, status)
       VALUES ($1, $3, 101, $5, 'submitted'),
              ($2, $4, 202, $6, 'submitted')`,
      [caseIds[0], caseIds[1], workspaceIds[0], workspaceIds[1], versionIds[0], versionIds[1]],
    );

    app = await buildApp(
      {
        NODE_ENV: 'test',
        CLERK_ISSUER: clerk.issuer,
        CLERK_AUDIENCE: clerk.audience,
        CLERK_JWKS_URL: 'https://tenant-isolation.synthetic.invalid/.well-known/jwks.json',
        CLERK_AUTHORIZED_PARTIES: clerk.authorizedParty,
      },
      { pool: appPool, auth: { jwksFetch: clerk.jwksFetch } },
    );
    await app.ready();
    unauthenticatedApp = await buildApp({ NODE_ENV: 'test' }, { pool: appPool });
    await unauthenticatedApp.ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (unauthenticatedApp) await unauthenticatedApp.close();
    if (fixturesCreated) {
      await adminPool.query('DELETE FROM cases WHERE id = ANY($1::uuid[])', [caseIds]);
      await adminPool.query('DELETE FROM form_template_versions WHERE id = ANY($1::uuid[])', [
        versionIds,
      ]);
      await adminPool.query('DELETE FROM workspace_members WHERE workspace_id = ANY($1::uuid[])', [
        workspaceIds,
      ]);
      await adminPool.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      await adminPool.query('DELETE FROM roles WHERE workspace_id = ANY($1::uuid[])', [
        workspaceIds,
      ]);
      await adminPool.query('DELETE FROM users WHERE id = $1', [userId]);
      await adminPool.query('DELETE FROM form_templates WHERE workspace_id = ANY($1::uuid[])', [
        workspaceIds,
      ]);
      await adminPool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaceIds]);
    }
    await appPool.end();
    await adminPool.end();
  });

  it('requires explicit authorization coverage for every registered protected route', async () => {
    assert.ok(app);
    const routes = readProtectedRoutes(app.printRoutes({ commonPrefix: false }));
    const discoveredCoverage = [...new Set(routes.map(routeCoverageKey))].sort();
    expect(discoveredCoverage).toEqual(Object.keys(authorizationCoverage).sort());

    for (const route of routes) {
      const coverage = authorizationCoverage[routeCoverageKey(route)];
      assert.ok(coverage, `Missing authorization coverage for ${routeCoverageKey(route)}`);
      assert.ok(unauthenticatedApp);
      const response = await unauthenticatedApp.inject({
        method: route.method,
        url: injectPath(route.path),
      });
      expect(response.statusCode, `${route.method} ${route.path} without authentication`).toBe(
        coverage.missingAuth,
      );
    }
  });

  it('returns zero rows without tenant context and hides another workspace in an app-role query', async () => {
    const noContextRows = await withTenant(adminPool, null, null, async (client) => {
      await client.query('SET LOCAL ROLE formiva_app');
      return client.query('SELECT id FROM form_templates WHERE id = $1', [templateIds[1]]);
    });
    expect(noContextRows.rowCount).toBe(0);

    const foreignRows = await withTenant(adminPool, workspaceIds[0], userId, async (client) => {
      await client.query('SET LOCAL ROLE formiva_app');
      return client.query('SELECT id FROM form_templates WHERE id = $1', [templateIds[1]]);
    });
    expect(foreignRows.rowCount).toBe(0);

    const ownRows = await withTenant(adminPool, workspaceIds[0], userId, async (client) => {
      await client.query('SET LOCAL ROLE formiva_app');
      return client.query('SELECT id FROM form_templates WHERE id = $1', [templateIds[0]]);
    });
    expect(ownRows.rows.map((row) => row.id)).toEqual([templateIds[0]]);
  });

  it('returns safe 404 for a foreign workspace and 403 for an insufficient role', async () => {
    await expect(
      withAuthorizedTenant(appPool, authSubject, workspaceIds[1], {}, async () => undefined),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      withAuthorizedTenant(
        appPool,
        authSubject,
        workspaceIds[0],
        { roles: ['owner'] },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('lists only the selected workspace cases using the authenticated membership and case.read permission', async () => {
    assert.ok(app);
    const ownWorkspaceResponse = await app.inject({
      method: 'GET',
      url: '/v1/cases?status=submitted&limit=10',
      headers: {
        authorization: `Bearer ${viewerToken}`,
        'x-workspace-id': workspaceIds[0],
      },
    });
    expect(ownWorkspaceResponse.statusCode, ownWorkspaceResponse.body).toBe(200);
    expect(ownWorkspaceResponse.json()).toMatchObject({
      limit: 10,
      offset: 0,
      items: [{ id: caseIds[0], case_number: '101', status: 'submitted' }],
    });
    expect(ownWorkspaceResponse.body).not.toContain(caseIds[1]);

    const foreignWorkspaceResponse = await app.inject({
      method: 'GET',
      url: '/v1/cases',
      headers: {
        authorization: `Bearer ${viewerToken}`,
        'x-workspace-id': workspaceIds[1],
      },
    });
    expect(foreignWorkspaceResponse.statusCode).toBe(404);

    const invalidQueryResponse = await app.inject({
      method: 'GET',
      url: '/v1/cases?limit=101',
      headers: {
        authorization: `Bearer ${viewerToken}`,
        'x-workspace-id': workspaceIds[0],
      },
    });
    expect(invalidQueryResponse.statusCode).toBe(400);

    try {
      await adminPool.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      const insufficientRoleResponse = await app.inject({
        method: 'GET',
        url: '/v1/cases',
        headers: {
          authorization: `Bearer ${viewerToken}`,
          'x-workspace-id': workspaceIds[0],
        },
      });
      expect(insufficientRoleResponse.statusCode).toBe(403);
    } finally {
      await adminPool.query(
        `INSERT INTO role_permissions (workspace_id, role_id, permission_key)
         VALUES ($1, $2, 'case.read')`,
        [workspaceIds[0], roleId],
      );
    }
  });

  it('authorizes case detail access and hides foreign cases with 404', async () => {
    assert.ok(app);
    const headers = {
      authorization: `Bearer ${viewerToken}`,
      'x-workspace-id': workspaceIds[0],
    };
    const ownCaseResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${caseIds[0]}`,
      headers,
    });
    expect(ownCaseResponse.statusCode, ownCaseResponse.body).toBe(200);
    expect(ownCaseResponse.json()).toMatchObject({ id: caseIds[0], case_number: '101' });

    const foreignCaseResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${caseIds[1]}`,
      headers,
    });
    expect(foreignCaseResponse.statusCode).toBe(404);

    try {
      await adminPool.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      const insufficientPermissionResponse = await app.inject({
        method: 'GET',
        url: `/v1/cases/${caseIds[0]}`,
        headers,
      });
      expect(insufficientPermissionResponse.statusCode).toBe(403);
    } finally {
      await adminPool.query(
        `INSERT INTO role_permissions (workspace_id, role_id, permission_key)
         VALUES ($1, $2, 'case.read')`,
        [workspaceIds[0], roleId],
      );
    }
  });
});
