import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/index.js';
import type { RouteSecurity } from '../../apps/api/src/security-metadata.js';
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
type RawAppQuery = (query: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
const rawAppQueries = new WeakMap<DbClient, RawAppQuery>();
const appPool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  onConnect: async (client) => {
    const rawQuery = client.query.bind(client) as unknown as RawAppQuery;
    rawAppQueries.set(client, rawQuery);
    await rawQuery('SET ROLE formiva_app');
    await rawQuery('BEGIN');

    let savepointIndex = 0;
    const savepoints: string[] = [];
    const queryWithSavepoints = async (query: string, values?: unknown[]) => {
      if (query === 'BEGIN') {
        const savepoint = `tenant_isolation_${++savepointIndex}`;
        savepoints.push(savepoint);
        return rawQuery(`SAVEPOINT ${savepoint}`);
      }
      if (query === 'COMMIT') {
        const savepoint = savepoints.pop();
        if (!savepoint) throw new Error('Unexpected transaction commit in tenant test pool.');
        return rawQuery(`RELEASE SAVEPOINT ${savepoint}`);
      }
      if (query === 'ROLLBACK') {
        const savepoint = savepoints.pop();
        if (!savepoint) throw new Error('Unexpected transaction rollback in tenant test pool.');
        await rawQuery(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return rawQuery(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return rawQuery(query, values);
    };
    client.query = queryWithSavepoints as DbClient['query'];
  },
  'GET /v1/cases/:case_id/documents': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
});

const fixtureId = randomUUID();
const workspaceIds = [randomUUID(), randomUUID()];
const templateIds = [randomUUID(), randomUUID()];
const versionIds = [randomUUID(), randomUUID()];
const documentIds = [randomUUID(), randomUUID()];
const caseIds = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
];
const userId = randomUUID();
const approverUserId = randomUUID();
const ownerUserId = randomUUID();
const adminUserId = randomUUID();
const foreignMemberUserId = randomUUID();
const guestUserId = randomUUID();
const authSubject = `synthetic_tenant_isolation_${fixtureId}`;
const approverSubject = `synthetic_tenant_approver_${fixtureId}`;
const ownerSubject = `synthetic_tenant_owner_${fixtureId}`;
const adminSubject = `synthetic_tenant_admin_${fixtureId}`;
const foreignMemberSubject = `synthetic_foreign_member_${fixtureId}`;
const guestSubject = `synthetic_tenant_guest_${fixtureId}`;
const workspaceKeys = [`tenant-isolation-${fixtureId}-a`, `tenant-isolation-${fixtureId}-b`];
const roleId = randomUUID();
const approverRoleId = randomUUID();
const ownerRoleId = randomUUID();
const adminRoleId = randomUUID();
const reviewerRoleId = randomUUID();
const foreignOwnerRoleId = randomUUID();
const guestRoleId = randomUUID();
let fixturesCreated = false;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let unauthenticatedApp: Awaited<ReturnType<typeof buildApp>> | undefined;
let viewerToken: string;
let approverToken: string;
let ownerToken: string;
let adminToken: string;
let guestToken: string;
let foreignToken: string;

const authorizationCoverage: Record<
  string,
  {
    missingAuth: 401;
    insufficientRole: 403 | 'not-applicable';
    authenticatedAccess: 'tested' | 'not-applicable';
    foreignResource: 404 | 'not-applicable';
  }
> = {
  'GET /v1/document-policies': {
    missingAuth: 401,
    insufficientRole: 'not-applicable',
    authenticatedAccess: 'tested',
    foreignResource: 'not-applicable',
  },
  'PUT /v1/document-policies/:doc_subtype': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
  'POST /v1/workspaces': {
    missingAuth: 401,
    insufficientRole: 'not-applicable',
    authenticatedAccess: 'not-applicable',
    foreignResource: 'not-applicable',
  },
  'POST /v1/workspaces/:workspace_id/members/invitations': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
  'POST /v1/invitations/accept': {
    missingAuth: 401,
    insufficientRole: 'not-applicable',
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
  'DELETE /v1/invitations/:invitation_id': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
  'GET /v1/workspaces/:workspace_id/members': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
  'PATCH /v1/workspaces/:workspace_id/members/:member_id': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
  'DELETE /v1/workspaces/:workspace_id/members/:member_id': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
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
  'GET /v1/cases/:case_id/documents': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
  'GET /v1/cases/:case_id/timeline': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
  'POST /v1/cases/:case_id/rework': {
    missingAuth: 401,
    insufficientRole: 403,
    authenticatedAccess: 'tested',
    foreignResource: 404,
  },
  'POST /v1/cases/:case_id/cancel': {
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

// ---- helpers for the cases generated from route security metadata ----
type GeneratedRoute = {
  key: string;
  method: RouteMethod;
  template: string;
  security: RouteSecurity;
};

function generatedRoutes(instance: NonNullable<typeof app>): GeneratedRoute[] {
  return [...instance.routeSecurity.entries()]
    .filter(([key]) => !key.startsWith('HEAD '))
    .map(([key, security]) => {
      const [method, template] = key.split(' ');
      return { key, method: method as RouteMethod, template, security };
    });
}

function pathParamsOf(template: string): string[] {
  return [...template.matchAll(/:([A-Za-z]\w*)/g)].map((match) => match[1]);
}

function fillPath(template: string, values: Record<string, string>): string {
  return template.replace(
    /:([A-Za-z]\w*)/g,
    (_match, name: string) => values[name] ?? randomUUID(),
  );
}

// Valid body for routes that need one. "probe" uses a role that does not exist, so a request
// that passes authorization still cannot create or change anything.
function sampleBody(
  route: GeneratedRoute,
  mode: 'valid' | 'probe',
): Record<string, unknown> | undefined {
  const role = mode === 'valid' ? 'viewer' : 'synthetic-missing-role';
  if (route.key.endsWith('/members/invitations'))
    return { email: 'generated@example.invalid', role };
  if (route.key.startsWith('PATCH ') && route.template.includes('/members/')) return { role };
  if (route.template.endsWith('/rework') || route.template.endsWith('/cancel')) {
    return { reason: 'Synthetic generated isolation check' };
  }
  return undefined;
}

function authorizedToken(security: RouteSecurity): string {
  const permissions = security.permissions === 'none' ? [] : security.permissions;
  if (permissions.includes('member.manage') || permissions.includes('workspace.manage')) {
    return ownerToken;
  }
  if (permissions.includes('case.approve') || permissions.includes('document.read_sensitive')) {
    return approverToken;
  }
  if (permissions.includes('case.read')) return viewerToken;
  throw new Error(`No synthetic caller holds permissions: ${permissions.join(', ') || 'none'}`);
}

async function workspaceSnapshot(workspaceId: string): Promise<string> {
  const members = await adminPool.query(
    'SELECT user_id, role_id, status FROM workspace_members WHERE workspace_id = $1 ORDER BY user_id',
    [workspaceId],
  );
  const cases = await adminPool.query(
    'SELECT id, status FROM cases WHERE workspace_id = $1 ORDER BY id',
    [workspaceId],
  );
  const invitations = await adminPool.query(
    'SELECT id, revoked_at, consumed_at FROM workspace_invitations WHERE workspace_id = $1 ORDER BY id',
    [workspaceId],
  );
  return JSON.stringify({
    members: members.rows,
    cases: cases.rows,
    invitations: invitations.rows,
  });
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
    approverToken = await clerk.createToken(approverSubject);
    ownerToken = await clerk.createToken(ownerSubject);
    adminToken = await clerk.createToken(adminSubject);
    guestToken = await clerk.createToken(guestSubject);
    foreignToken = await clerk.createToken(foreignMemberSubject);

    await adminPool.query(
      `INSERT INTO workspaces (id, slug, name)
       VALUES ($1, $3, 'Synthetic tenant isolation A'),
              ($2, $4, 'Synthetic tenant isolation B')`,
      [workspaceIds[0], workspaceIds[1], `${fixtureId}-a`, `${fixtureId}-b`],
    );
    fixturesCreated = true;
    await adminPool.query(
      `INSERT INTO users (id, auth_subject, email, display_name)
       VALUES ($1, $2, $4, 'Synthetic Tenant Isolation User'),
              ($3, $5, $6, 'Synthetic Tenant Approver'),
              ($7, $8, $9, 'Synthetic Tenant Owner'),
              ($10, $11, $12, 'Synthetic Foreign Tenant Member'),
              ($13, $14, $15, 'Synthetic Tenant Admin'),
              ($16, $17, $18, 'Synthetic Guest Without Permissions')`,
      [
        userId,
        authSubject,
        approverUserId,
        `${fixtureId}@example.invalid`,
        approverSubject,
        `${fixtureId}-approver@example.invalid`,
        ownerUserId,
        ownerSubject,
        `${fixtureId}-owner@example.invalid`,
        foreignMemberUserId,
        foreignMemberSubject,
        `${fixtureId}-foreign@example.invalid`,
        adminUserId,
        adminSubject,
        `${fixtureId}-admin@example.invalid`,
        guestUserId,
        guestSubject,
        `${fixtureId}-guest@example.invalid`,
      ],
    );
    await adminPool.query(
      `INSERT INTO roles (id, workspace_id, name, is_system)
       VALUES ($1, $3, 'viewer', true),
              ($2, $3, 'approver', true),
              ($4, $3, 'owner', true),
              ($5, $3, 'reviewer', true),
              ($6, $7, 'owner', true),
              ($8, $3, 'admin', true),
              ($9, $3, 'guest', false)`,
      [
        roleId,
        approverRoleId,
        workspaceIds[0],
        ownerRoleId,
        reviewerRoleId,
        foreignOwnerRoleId,
        workspaceIds[1],
        adminRoleId,
        guestRoleId,
      ],
    );
    await adminPool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role_id, status, joined_at)
       VALUES ($1, $2, $3, 'active', now()),
              ($1, $4, $5, 'active', now()),
              ($1, $6, $7, 'active', now()),
              ($8, $9, $10, 'active', now()),
              ($1, $11, $12, 'active', now()),
              ($1, $13, $14, 'active', now())`,
      [
        workspaceIds[0],
        userId,
        roleId,
        approverUserId,
        approverRoleId,
        ownerUserId,
        ownerRoleId,
        workspaceIds[1],
        foreignMemberUserId,
        foreignOwnerRoleId,
        adminUserId,
        adminRoleId,
        guestUserId,
        guestRoleId,
      ],
    );
    await adminPool.query(
      `INSERT INTO role_permissions (workspace_id, role_id, permission_key)
       VALUES ($1, $2, 'case.read'),
              ($1, $3, 'case.read'),
              ($1, $3, 'case.approve'),
              ($1, $3, 'document.read_sensitive'),
              ($1, $4, 'member.manage'),
              ($1, $4, 'workspace.manage'),
              ($1, $5, 'member.manage')`,
      [workspaceIds[0], roleId, approverRoleId, ownerRoleId, adminRoleId],
    );
    await adminPool.query(
      `INSERT INTO role_permissions (workspace_id, role_id, permission_key)
       VALUES ($1, $2, 'case.read'),
              ($1, $2, 'case.approve'),
              ($1, $2, 'document.read_sensitive'),
              ($1, $2, 'member.manage'),
              ($1, $2, 'workspace.manage')`,
      [workspaceIds[1], foreignOwnerRoleId],
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
              ($2, $4, 202, $6, 'submitted'),
              ($7, $3, 103, $5, 'draft'),
              ($8, $3, 104, $5, 'approval_pending'),
              ($9, $3, 105, $5, 'ai_processing'),
              ($10, $3, 106, $5, 'review_in_progress')`,
      [
        caseIds[0],
        caseIds[1],
        workspaceIds[0],
        workspaceIds[1],
        versionIds[0],
        versionIds[1],
        caseIds[2],
        caseIds[3],
        caseIds[4],
        caseIds[5],
      ],
    );
    await adminPool.query(
      `INSERT INTO case_documents (
         id, workspace_id, case_id, bucket, object_key, original_filename,
         mime_type, size_bytes, sha256, doc_class, status, retain_until
       )
       VALUES (
         $1, $3, $5, 'synthetic-bucket',
         'ws/workspace-secret/cases/' || $7 || '/object-key-secret',
         'Synthetic ID 123456789012.pdf', 'application/pdf', 128,
         decode(repeat('ab', 32), 'hex'), 'identity', 'clean', now() + interval '30 days'
       ), (
         $2, $4, $6, 'foreign-secret-bucket',
         'ws/foreign-workspace/' || $8 || '/object-key', 'foreign.pdf',
         'application/pdf', 256, decode(repeat('cd', 32), 'hex'),
         'address', 'uploaded', null
       )`,
      [
        documentIds[0],
        documentIds[1],
        workspaceIds[0],
        workspaceIds[1],
        caseIds[0],
        caseIds[1],
        fixtureId,
        fixtureId,
      ],
    );
    await withTenant(appPool, workspaceIds[0], approverUserId, async (client) =>
      client.query(
        `INSERT INTO document_scans (workspace_id, document_id, scanner, scanner_version, result, details)
         VALUES (
           $1, $2, 'clamav', 'synthetic-1', 'clean',
           '{"ocr_text":"Synthetic raw OCR 123456789012","credential":"object-store-secret"}'
         )`,
        [workspaceIds[0], documentIds[0]],
      ),
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
    const transactionClient = await appPool.connect();
    const rawQuery = rawAppQueries.get(transactionClient);
    if (rawQuery) await rawQuery('ROLLBACK');
    transactionClient.release();
    if (fixturesCreated) {
      await adminPool.query('DELETE FROM case_documents WHERE id = ANY($1::uuid[])', [documentIds]);
      await adminPool.query('DELETE FROM cases WHERE id = ANY($1::uuid[])', [caseIds]);
      await adminPool.query('DELETE FROM form_template_versions WHERE id = ANY($1::uuid[])', [
        versionIds,
      ]);
      await adminPool.query('DELETE FROM workspace_members WHERE workspace_id = ANY($1::uuid[])', [
        workspaceIds,
      ]);
      await adminPool.query('DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])', [
        [roleId, approverRoleId, ownerRoleId, adminRoleId, reviewerRoleId, foreignOwnerRoleId],
      ]);
      await adminPool.query('DELETE FROM roles WHERE workspace_id = ANY($1::uuid[])', [
        workspaceIds,
      ]);
      await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [userId, approverUserId, ownerUserId, adminUserId, foreignMemberUserId, guestUserId],
      ]);
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

  it('authorizes case timeline access and hides foreign cases with 404', async () => {
    assert.ok(app);
    const headers = {
      authorization: `Bearer ${viewerToken}`,
      'x-workspace-id': workspaceIds[0],
    };
    const ownCaseResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${caseIds[0]}/timeline`,
      headers,
    });
    expect(ownCaseResponse.statusCode, ownCaseResponse.body).toBe(200);
    expect(ownCaseResponse.json()).toEqual({ items: [] });

    const foreignCaseResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${caseIds[1]}/timeline`,
      headers,
    });
    expect(foreignCaseResponse.statusCode).toBe(404);

    const unknownCaseResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${randomUUID()}/timeline`,
      headers,
    });
    expect(unknownCaseResponse.statusCode).toBe(404);

    try {
      await adminPool.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      const insufficientPermissionResponse = await app.inject({
        method: 'GET',
        url: `/v1/cases/${caseIds[0]}/timeline`,
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

  it('returns only authorized safe document metadata and isolates case document lists', async () => {
    assert.ok(app);
    assert.ok(unauthenticatedApp);
    const headers = {
      authorization: `Bearer ${approverToken}`,
      'x-workspace-id': workspaceIds[0],
    };

    const documentsResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${caseIds[0]}/documents`,
      headers,
    });
    expect(documentsResponse.statusCode, documentsResponse.body).toBe(200);
    const documents = documentsResponse.json();
    expect(documents.items).toHaveLength(1);
    expect(documents.items[0]).toMatchObject({
      id: documentIds[0],
      doc_class: 'identity',
      status: 'clean',
      scan_state: 'clean',
      hash_state: 'available',
      retention_state: 'scheduled',
    });
    expect(documentsResponse.body).not.toContain(documentIds[1]);
    for (const secret of [
      'Synthetic ID 123456789012.pdf',
      '123456789012',
      'synthetic-bucket',
      'object-key-secret',
      'foreign-workspace',
      'Synthetic raw OCR',
      'object-store-secret',
    ]) {
      expect(documentsResponse.body).not.toContain(secret);
    }

    const emptyListResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${caseIds[2]}/documents`,
      headers,
    });
    expect(emptyListResponse.statusCode).toBe(200);
    expect(emptyListResponse.json()).toEqual({ items: [] });

    const foreignCaseResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${caseIds[1]}/documents`,
      headers,
    });
    expect(foreignCaseResponse.statusCode).toBe(404);

    const unknownCaseResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${randomUUID()}/documents`,
      headers,
    });
    expect(unknownCaseResponse.statusCode).toBe(404);

    const insufficientPermissionResponse = await app.inject({
      method: 'GET',
      url: `/v1/cases/${caseIds[0]}/documents`,
      headers: { ...headers, authorization: `Bearer ${viewerToken}` },
    });
    expect(insufficientPermissionResponse.statusCode).toBe(403);

    const missingAuthResponse = await unauthenticatedApp.inject({
      method: 'GET',
      url: `/v1/cases/${caseIds[0]}/documents`,
    });
    expect(missingAuthResponse.statusCode).toBe(401);
  });

  it('authorizes rework requests and returns safe errors for foreign, unknown, and invalid-state cases', async () => {
    assert.ok(app);
    const headers = {
      authorization: `Bearer ${approverToken}`,
      'x-workspace-id': workspaceIds[0],
      'idempotency-key': `tenant-isolation-rework-${fixtureId}`,
    };
    const body = { reason: 'Synthetic fixture needs corrected address evidence.' };

    const foreignCaseResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[1]}/rework`,
      headers,
      payload: body,
    });
    expect(foreignCaseResponse.statusCode).toBe(404);

    const unknownCaseResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${randomUUID()}/rework`,
      headers,
      payload: body,
    });
    expect(unknownCaseResponse.statusCode).toBe(404);

    const wrongRoleResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[0]}/rework`,
      headers: { ...headers, authorization: `Bearer ${viewerToken}` },
      payload: body,
    });
    expect(wrongRoleResponse.statusCode).toBe(403);

    const missingReasonResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[0]}/rework`,
      headers,
      payload: {},
    });
    expect(missingReasonResponse.statusCode).toBe(400);

    const missingIdempotencyKeyResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[0]}/rework`,
      headers: {
        authorization: headers.authorization,
        'x-workspace-id': headers['x-workspace-id'],
      },
      payload: body,
    });
    expect(missingIdempotencyKeyResponse.statusCode).toBe(400);

    const unsafeReasonResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[0]}/rework`,
      headers,
      payload: { reason: 'Review full ID 123456789012 before rework.' },
    });
    expect(unsafeReasonResponse.statusCode).toBe(400);

    const formattedIdReasonResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[0]}/rework`,
      headers,
      payload: { reason: 'Please review ID 1234-5678-9012.' },
    });
    expect(formattedIdReasonResponse.statusCode).toBe(400);

    const invalidStateResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[2]}/rework`,
      headers,
      payload: body,
    });
    expect(invalidStateResponse.statusCode).toBe(409);
    expect(invalidStateResponse.json().detail).not.toContain('draft');

    const reworkCaseId = caseIds[3];
    const reworkCorrelationId = randomUUID();
    const idempotencyKey = `tenant-isolation-rework-${fixtureId}`;
    const reworkHeaders = {
      ...headers,
      'x-correlation-id': reworkCorrelationId,
      'idempotency-key': idempotencyKey,
    };
    const firstReworkResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${reworkCaseId}/rework`,
      headers: reworkHeaders,
      payload: body,
    });
    expect(firstReworkResponse.statusCode, firstReworkResponse.body).toBe(200);
    expect(firstReworkResponse.json()).toEqual({
      case_id: reworkCaseId,
      status: 'review_queued',
      correlation_id: reworkCorrelationId,
    });
    expect(firstReworkResponse.body).not.toContain(body.reason);
    expect(firstReworkResponse.body).not.toContain(idempotencyKey);

    const retryResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${reworkCaseId}/rework`,
      headers: { ...reworkHeaders, 'x-correlation-id': randomUUID() },
      payload: body,
    });
    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json()).toEqual(firstReworkResponse.json());

    const crossCaseKeyReuse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[0]}/rework`,
      headers: reworkHeaders,
      payload: body,
    });
    expect(crossCaseKeyReuse.statusCode).toBe(409);

    const changedBodyResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${reworkCaseId}/rework`,
      headers: reworkHeaders,
      payload: { reason: 'A different synthetic rework reason.' },
    });
    expect(changedBodyResponse.statusCode).toBe(409);

    const persistedRework = await withTenant(
      appPool,
      workspaceIds[0],
      approverUserId,
      async (client) =>
        client.query<{
          status: string;
          event_count: number;
          action: string | null;
          reason: string | null;
          actor_id: string | null;
          correlation_id: string | null;
          from_status: string | null;
          to_status: string | null;
          key_hash: string | null;
        }>(
          `SELECT c.status,
                  count(ae.id)::int AS event_count,
                  min(ae.action) AS action,
                  min(ae.reason) AS reason,
                  min(ae.actor_id) AS actor_id,
                  min(ae.correlation_id::text) AS correlation_id,
                  min(ae.payload->>'from_status') AS from_status,
                  min(ae.payload->>'to_status') AS to_status,
                  min(ae.payload->>'idempotency_key_hash') AS key_hash
             FROM cases c
             LEFT JOIN audit_events ae
               ON ae.workspace_id = c.workspace_id
              AND ae.object_type = 'case'
              AND ae.object_id = c.id::text
              AND ae.action = 'case.rework_requested'
            WHERE c.id = $1 AND c.workspace_id = $2
            GROUP BY c.status`,
          [reworkCaseId, workspaceIds[0]],
        ),
    );
    expect(persistedRework.rows).toEqual([
      {
        status: 'review_queued',
        event_count: 1,
        action: 'case.rework_requested',
        reason: body.reason,
        actor_id: approverUserId,
        correlation_id: reworkCorrelationId,
        from_status: 'approval_pending',
        to_status: 'review_queued',
        key_hash: createHash('sha256').update(idempotencyKey).digest('hex'),
      },
    ]);
  });

  it('cancels only authorized tenant cases and atomically records one idempotent audit event', async () => {
    assert.ok(app);
    assert.ok(unauthenticatedApp);
    const caseId = caseIds[4];
    const cancellationReason = 'Synthetic applicant withdrew the request.';
    const idempotencyKey = `tenant-isolation-cancel-${fixtureId}`;
    const correlationId = randomUUID();
    const headers = {
      authorization: `Bearer ${approverToken}`,
      'x-workspace-id': workspaceIds[0],
      'x-correlation-id': correlationId,
      'idempotency-key': idempotencyKey,
    };
    const body = { reason: cancellationReason };

    const missingAuthResponse = await unauthenticatedApp.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/cancel`,
      payload: body,
    });
    expect(missingAuthResponse.statusCode).toBe(401);

    const foreignCaseResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[1]}/cancel`,
      headers,
      payload: body,
    });
    expect(foreignCaseResponse.statusCode).toBe(404);

    const unknownCaseResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${randomUUID()}/cancel`,
      headers,
      payload: body,
    });
    expect(unknownCaseResponse.statusCode).toBe(404);

    const insufficientPermissionResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/cancel`,
      headers: { ...headers, authorization: `Bearer ${viewerToken}` },
      payload: body,
    });
    expect(insufficientPermissionResponse.statusCode).toBe(403);

    const missingReasonResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/cancel`,
      headers,
      payload: {},
    });
    expect(missingReasonResponse.statusCode).toBe(400);

    const unsafeReasonResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/cancel`,
      headers,
      payload: { reason: 'Cancel after ID 123456789012 was reviewed.' },
    });
    expect(unsafeReasonResponse.statusCode).toBe(400);

    const missingIdempotencyKeyResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/cancel`,
      headers: {
        authorization: headers.authorization,
        'x-workspace-id': headers['x-workspace-id'],
      },
      payload: body,
    });
    expect(missingIdempotencyKeyResponse.statusCode).toBe(400);

    const illegalStateResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseIds[5]}/cancel`,
      headers,
      payload: body,
    });
    expect(illegalStateResponse.statusCode).toBe(409);
    expect(illegalStateResponse.json().detail).not.toContain('review_in_progress');

    const cancellationResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/cancel`,
      headers,
      payload: body,
    });
    expect(cancellationResponse.statusCode, cancellationResponse.body).toBe(200);
    expect(cancellationResponse.json()).toEqual({
      case_id: caseId,
      status: 'cancelled',
      correlation_id: correlationId,
    });
    expect(cancellationResponse.body).not.toContain(cancellationReason);
    expect(cancellationResponse.body).not.toContain(idempotencyKey);

    const retryResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/cancel`,
      headers: { ...headers, 'x-correlation-id': randomUUID() },
      payload: body,
    });
    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json()).toEqual(cancellationResponse.json());

    const changedBodyResponse = await app.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/cancel`,
      headers,
      payload: { reason: 'A different synthetic cancellation reason.' },
    });
    expect(changedBodyResponse.statusCode).toBe(409);

    const persistedCancellation = await withTenant(
      appPool,
      workspaceIds[0],
      approverUserId,
      async (client) =>
        client.query<{
          status: string;
          event_count: number;
          action: string | null;
          reason: string | null;
          actor_id: string | null;
          correlation_id: string | null;
          from_status: string | null;
          to_status: string | null;
          key_hash: string | null;
        }>(
          `SELECT c.status,
                  count(ae.id)::int AS event_count,
                  min(ae.action) AS action,
                  min(ae.reason) AS reason,
                  min(ae.actor_id) AS actor_id,
                  min(ae.correlation_id::text) AS correlation_id,
                  min(ae.payload->>'from_status') AS from_status,
                  min(ae.payload->>'to_status') AS to_status,
                  min(ae.payload->>'idempotency_key_hash') AS key_hash
             FROM cases c
             LEFT JOIN audit_events ae
               ON ae.workspace_id = c.workspace_id
              AND ae.object_type = 'case'
              AND ae.object_id = c.id::text
              AND ae.action = 'case.cancelled'
            WHERE c.id = $1 AND c.workspace_id = $2
            GROUP BY c.status`,
          [caseId, workspaceIds[0]],
        ),
    );
    expect(persistedCancellation.rows).toEqual([
      {
        status: 'cancelled',
        event_count: 1,
        action: 'case.cancelled',
        reason: cancellationReason,
        actor_id: approverUserId,
        correlation_id: correlationId,
        from_status: 'ai_processing',
        to_status: 'cancelled',
        key_hash: createHash('sha256').update(idempotencyKey).digest('hex'),
      },
    ]);
  });

  it('lists only members in the selected workspace for an authorized owner', async () => {
    assert.ok(app);
    const ownerHeaders = {
      authorization: `Bearer ${ownerToken}`,
      'x-workspace-id': workspaceIds[0],
    };
    const deniedResponse = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceIds[0]}/members`,
      headers: { ...ownerHeaders, authorization: `Bearer ${viewerToken}` },
    });
    expect(deniedResponse.statusCode).toBe(403);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceIds[0]}/members`,
      headers: ownerHeaders,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        { user_id: userId, role: 'viewer', status: 'active' },
        { user_id: approverUserId, role: 'approver', status: 'active' },
        { user_id: ownerUserId, role: 'owner', status: 'active' },
      ]),
    );
    expect(response.body).not.toContain(foreignMemberUserId);
    expect(response.body).not.toContain(`${fixtureId}-foreign@example.invalid`);

    const uppercaseWorkspaceIdResponse = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceIds[0].toUpperCase()}/members`,
      headers: ownerHeaders,
    });
    expect(uppercaseWorkspaceIdResponse.statusCode).toBe(200);

    const adminResponse = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceIds[0]}/members`,
      headers: { ...ownerHeaders, authorization: `Bearer ${adminToken}` },
    });
    expect(adminResponse.statusCode, adminResponse.body).toBe(200);

    const mismatchedPathResponse = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceIds[1]}/members`,
      headers: ownerHeaders,
    });
    expect(mismatchedPathResponse.statusCode).toBe(404);

    const foreignWorkspaceResponse = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceIds[1]}/members`,
      headers: { ...ownerHeaders, 'x-workspace-id': workspaceIds[1] },
    });
    expect(foreignWorkspaceResponse.statusCode).toBe(404);
  });

  it('changes member roles, audits atomically, hides foreign members, and protects the last owner', async () => {
    assert.ok(app);
    const headers = {
      authorization: `Bearer ${ownerToken}`,
      'x-workspace-id': workspaceIds[0],
      'x-correlation-id': randomUUID(),
    };
    const url = `/v1/workspaces/${workspaceIds[0]}/members/${userId}`;
    const deniedResponse = await app.inject({
      method: 'PATCH',
      url,
      headers: { ...headers, authorization: `Bearer ${viewerToken}` },
      payload: { role: 'reviewer' },
    });
    expect(deniedResponse.statusCode).toBe(403);

    const foreignResponse = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceIds[0]}/members/${foreignMemberUserId}`,
      headers,
      payload: { role: 'reviewer' },
    });
    expect(foreignResponse.statusCode).toBe(404);

    const unknownResponse = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceIds[0]}/members/${randomUUID()}`,
      headers,
      payload: { role: 'reviewer' },
    });
    expect(unknownResponse.statusCode).toBe(404);

    const invalidRoleResponse = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { role: 'not-a-workspace-role' },
    });
    expect(invalidRoleResponse.statusCode).toBe(400);

    const adminOwnerChangeResponse = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceIds[0]}/members/${ownerUserId}`,
      headers: { ...headers, authorization: `Bearer ${adminToken}` },
      payload: { role: 'reviewer' },
    });
    expect(adminOwnerChangeResponse.statusCode).toBe(403);

    const changedResponse = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { role: 'reviewer' },
    });
    expect(changedResponse.statusCode, changedResponse.body).toBe(200);
    expect(changedResponse.json()).toEqual({
      user_id: userId,
      role: 'reviewer',
      status: 'active',
    });

    const repeatedChangeResponse = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { role: 'reviewer' },
    });
    expect(repeatedChangeResponse.statusCode).toBe(200);
    expect(repeatedChangeResponse.json()).toEqual(changedResponse.json());

    const lastOwnerResponse = await app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceIds[0]}/members/${ownerUserId}`,
      headers,
      payload: { role: 'reviewer' },
    });
    expect(lastOwnerResponse.statusCode).toBe(409);

    const auditResult = await withTenant(appPool, workspaceIds[0], ownerUserId, async (client) =>
      client.query<{ count: number; action: string; actor_id: string; correlation_id: string }>(
        `SELECT count(*)::int AS count,
                min(action) AS action,
                min(actor_id) AS actor_id,
                min(correlation_id::text) AS correlation_id
           FROM audit_events
          WHERE workspace_id = $1
            AND object_type = 'workspace_member'
            AND object_id = $2
            AND action = 'workspace.member_role_changed'`,
        [workspaceIds[0], userId],
      ),
    );
    expect(auditResult.rows[0]).toEqual({
      count: 1,
      action: 'workspace.member_role_changed',
      actor_id: ownerUserId,
      correlation_id: headers['x-correlation-id'],
    });
  });

  it('removes memberships with an immutable audit event and idempotent repeat', async () => {
    assert.ok(app);
    const headers = {
      authorization: `Bearer ${ownerToken}`,
      'x-workspace-id': workspaceIds[0],
      'x-correlation-id': randomUUID(),
    };
    const targetUrl = `/v1/workspaces/${workspaceIds[0]}/members/${approverUserId}`;

    const deniedResponse = await app.inject({
      method: 'DELETE',
      url: targetUrl,
      headers: { ...headers, authorization: `Bearer ${viewerToken}` },
    });
    expect(deniedResponse.statusCode).toBe(403);

    const foreignResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceIds[0]}/members/${foreignMemberUserId}`,
      headers,
    });
    expect(foreignResponse.statusCode).toBe(404);

    const unknownResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceIds[0]}/members/${randomUUID()}`,
      headers,
    });
    expect(unknownResponse.statusCode).toBe(404);

    const lastOwnerResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceIds[0]}/members/${ownerUserId}`,
      headers,
    });
    expect(lastOwnerResponse.statusCode).toBe(409);

    const adminOwnerRemovalResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceIds[0]}/members/${ownerUserId}`,
      headers: { ...headers, authorization: `Bearer ${adminToken}` },
    });
    expect(adminOwnerRemovalResponse.statusCode).toBe(403);

    const removedResponse = await app.inject({
      method: 'DELETE',
      url: targetUrl,
      headers,
    });
    expect(removedResponse.statusCode, removedResponse.body).toBe(200);
    expect(removedResponse.json()).toEqual({
      user_id: approverUserId,
      role: 'approver',
      status: 'left',
    });

    const repeatedResponse = await app.inject({
      method: 'DELETE',
      url: targetUrl,
      headers,
    });
    expect(repeatedResponse.statusCode).toBe(200);
    expect(repeatedResponse.json()).toEqual(removedResponse.json());

    const auditResult = await withTenant(appPool, workspaceIds[0], ownerUserId, async (client) =>
      client.query<{ count: number; action: string }>(
        `SELECT count(*)::int AS count, min(action) AS action
           FROM audit_events
          WHERE workspace_id = $1
            AND object_type = 'workspace_member'
            AND object_id = $2
            AND action = 'workspace.member_removed'`,
        [workspaceIds[0], approverUserId],
      ),
    );
    expect(auditResult.rows[0]).toEqual({ count: 1, action: 'workspace.member_removed' });
  });

  it('declares well-formed security metadata for every registered route', async () => {
    assert.ok(app);
    const routes = generatedRoutes(app);
    const printed = readProtectedRoutes(app.printRoutes({ commonPrefix: false })).map(
      routeCoverageKey,
    );
    expect(
      routes.map((route) => route.key).filter((key) => key.split(' ')[1].startsWith('/v1')),
    ).toEqual(expect.arrayContaining([...new Set(printed)]));

    for (const route of routes) {
      const { security } = route;
      expect(['jwt', 'public', 'open'], `${route.key} authKind`).toContain(security.authKind);
      expect([...security.pathParams].sort(), `${route.key} pathParams`).toEqual(
        pathParamsOf(route.template).sort(),
      );
      if (security.authKind === 'jwt' && security.tenantScope === 'workspace') {
        const requiresSomething =
          (security.roles?.length ?? 0) > 0 || security.permissions !== 'none';
        expect(requiresSomething, `${route.key} must declare a role or permission`).toBe(true);
      }
    }
  });

  it('denies, hides and never changes data for unauthenticated, wrong-permission and foreign callers on every route', async () => {
    assert.ok(app && unauthenticatedApp);
    const [snapshotA, snapshotB] = [
      await workspaceSnapshot(workspaceIds[0]),
      await workspaceSnapshot(workspaceIds[1]),
    ];
    const own = {
      workspace_id: workspaceIds[0],
      case_id: caseIds[0],
      member_id: approverUserId,
      invitation_id: randomUUID(),
    };
    const jwtRoutes = generatedRoutes(app).filter((route) => route.security.authKind === 'jwt');
    expect(jwtRoutes.length).toBeGreaterThanOrEqual(13);

    for (const route of jwtRoutes) {
      const { method, template, security, key } = route;
      const payload = sampleBody(route, 'valid');
      const send = (
        instance: NonNullable<typeof app>,
        url: string,
        headers: Record<string, string>,
      ) =>
        instance.inject({
          method,
          url,
          headers: { 'idempotency-key': `synthetic-${randomUUID()}`, ...headers },
          ...(payload ? { payload } : {}),
        });

      // 1. no token
      const noToken = await send(unauthenticatedApp, fillPath(template, own), {});
      expect(noToken.statusCode, `${key} without a token`).toBe(401);
      if (security.tenantScope !== 'workspace') continue;

      const ownUrl = fillPath(template, own);
      const asGuest = {
        authorization: `Bearer ${guestToken}`,
        'x-workspace-id': workspaceIds[0],
      };
      // 2. member of A with no role/permission for this route
      const guest = await send(app, ownUrl, asGuest);
      expect(guest.statusCode, `${key} as a member without the declared permission`).toBe(403);

      // 3. owner of workspace B that is not a member of A selects A
      const notMember = await send(app, ownUrl, {
        authorization: `Bearer ${foreignToken}`,
        'x-workspace-id': workspaceIds[0],
      });
      expect(notMember.statusCode, `${key} as a non-member of the selected workspace`).toBe(404);

      // 4. owner of B, with full rights in B, selects B but asks for A's identifiers
      const crossTenant = await send(app, ownUrl, {
        authorization: `Bearer ${foreignToken}`,
        'x-workspace-id': workspaceIds[1],
      });
      if (security.pathParams.length > 0) {
        expect(crossTenant.statusCode, `${key} with workspace A identifiers from workspace B`).toBe(
          404,
        );
      } else {
        // List route: it returns the caller's own workspace only, never A's rows.
        expect(crossTenant.statusCode, `${key} list from workspace B`).toBe(200);
      }
      for (const response of [noToken, guest, notMember, crossTenant]) {
        for (const id of [caseIds[0], documentIds[0], workspaceIds[0]]) {
          // The problem document repeats the caller's own request URL in `instance`; ignore that.
          const { instance: _instance, ...rest } = JSON.parse(response.body || '{}') as {
            instance?: string;
          };
          expect(JSON.stringify(rest), `${key} must not echo workspace A data`).not.toContain(id);
        }
      }
    }

    expect(await workspaceSnapshot(workspaceIds[0])).toBe(snapshotA);
    expect(await workspaceSnapshot(workspaceIds[1])).toBe(snapshotB);
  }, 30_000);

  it('lets the declared caller through (positive control) and ignores a workspace_id sent in the body', async () => {
    assert.ok(app);
    const [snapshotA, snapshotB] = [
      await workspaceSnapshot(workspaceIds[0]),
      await workspaceSnapshot(workspaceIds[1]),
    ];
    // Invitation routes also require a freshly synced, verified identity for the owner.
    await adminPool.query(
      `UPDATE users SET status = 'active', email_verified = true, email_verified_at = now(),
              identity_source_updated_at = now(), identity_synced_at = now()
        WHERE id = $1`,
      [ownerUserId],
    );
    // Earlier tests change roles and remove members; put the two callers back first.
    await adminPool.query(
      `UPDATE workspace_members SET role_id = $3, status = 'active'
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceIds[0], userId, roleId],
    );
    await adminPool.query(
      `UPDATE workspace_members SET role_id = $3, status = 'active'
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceIds[0], approverUserId, approverRoleId],
    );
    const jwtRoutes = generatedRoutes(app).filter(
      (route) => route.security.authKind === 'jwt' && route.security.tenantScope === 'workspace',
    );

    for (const route of jwtRoutes) {
      const { method, template, security, key } = route;
      const headers = {
        authorization: `Bearer ${authorizedToken(security)}`,
        'x-workspace-id': workspaceIds[0],
        'idempotency-key': `synthetic-${randomUUID()}`,
      };

      if (method === 'GET') {
        // Real workspace-A identifiers: the declared caller must succeed.
        const response = await app.inject({
          method,
          url: fillPath(template, {
            workspace_id: workspaceIds[0],
            case_id: caseIds[0],
            member_id: approverUserId,
          }),
          headers,
        });
        expect(response.statusCode, `${key} as the declared caller: ${response.body}`).toBe(200);
        continue;
      }

      // Mutating routes: random resource ids and a probe body, so nothing can change even if the
      // request passes authorization. The point is that it is NOT answered with 401/403/5xx.
      const url = fillPath(template, { workspace_id: workspaceIds[0] });
      const probe = sampleBody(route, 'probe');
      const allowed = [400, 404, 409, 422];
      const asDeclared = await app.inject({
        method,
        url,
        headers,
        ...(probe ? { payload: probe } : {}),
      });
      expect(
        allowed,
        `${key} as the declared caller: ${asDeclared.statusCode} ${asDeclared.body}`,
      ).toContain(asDeclared.statusCode);

      // A workspace_id for workspace B in the body must be ignored or rejected, never obeyed.
      const withForeignBody = await app.inject({
        method,
        url,
        headers,
        payload: { ...(probe ?? {}), workspace_id: workspaceIds[1], tenant_id: workspaceIds[1] },
      });
      expect(allowed, `${key} with a foreign workspace_id in the body`).toContain(
        withForeignBody.statusCode,
      );
      expect(withForeignBody.body).not.toContain(workspaceIds[1]);
    }

    expect(await workspaceSnapshot(workspaceIds[0])).toBe(snapshotA);
    expect(await workspaceSnapshot(workspaceIds[1])).toBe(snapshotB);
  }, 30_000);
  it('document policy API: owner sets a policy, viewer cannot, other workspace never sees it (3.5c)', async () => {
    assert.ok(app);
    const as = (token: string, workspace: string) => ({
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspace,
    });
    const put = (token: string, subtype: string, payload: unknown, workspace = workspaceIds[0]!) =>
      app!.inject({
        method: 'PUT',
        url: `/v1/document-policies/${subtype}`,
        headers: as(token, workspace),
        payload: payload as Record<string, unknown>,
      });
    const body = {
      collect_mode: 'required',
      require_masked: false,
      purpose: 'PAN is needed for tax deduction at source',
    };

    // Authorization comes before validation: a viewer gets 403 even with a bad body.
    expect((await put(viewerToken, 'pan', body)).statusCode).toBe(403);
    expect((await put(viewerToken, 'pan', { nonsense: 1 })).statusCode).toBe(403);

    const ok = await put(ownerToken, 'pan', body);
    expect(ok.statusCode, ok.body).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/document-policies',
      headers: as(viewerToken, workspaceIds[0]!),
    });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.doc_subtype === 'pan')).toMatchObject({
      collect_mode: 'required',
      configured: true,
    });
    expect(items.find((i) => i.doc_subtype === 'passport')).toMatchObject({
      collect_mode: 'not_collected',
      configured: false,
    });
    const names = items.map((i) => i.doc_subtype);
    expect(names).not.toContain('police_verification');
    expect(names).not.toContain('caste_community_certificate');

    // Another workspace is unaffected.
    const other = await app.inject({
      method: 'GET',
      url: '/v1/document-policies',
      headers: as(foreignToken, workspaceIds[1]!),
    });
    if (other.statusCode === 200) {
      const o = other.json().items as Array<Record<string, unknown>>;
      expect(o.find((i) => i.doc_subtype === 'pan')).toMatchObject({ configured: false });
    }

    // Rules: purpose is mandatory, Aadhaar must be masked, unknown/special types cannot be enabled.
    expect((await put(ownerToken, 'pan', { collect_mode: 'optional' })).statusCode).toBe(422);
    expect(
      (await put(ownerToken, 'aadhaar', { collect_mode: 'optional', purpose: 'x'.repeat(12) }))
        .statusCode,
    ).toBe(422);
    expect((await put(ownerToken, 'pan', { ...body, extra: 1 })).statusCode).toBe(422);
    for (const t of ['police_verification', 'caste_community_certificate', 'unknown', 'nope']) {
      expect((await put(ownerToken, t, body)).statusCode, t).toBe(404);
    }

    // The app pool in this file keeps one outer transaction, so read through it (not adminPool).
    const audit = await withTenant(appPool, workspaceIds[0]!, ownerUserId, (client) =>
      client.query(
        `SELECT payload::text AS p FROM audit_events WHERE action = 'document_policy.updated'`,
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].p).toContain('"collect_mode": "required"');
  });
});
