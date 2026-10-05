import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type FetchImplementation } from 'jose';
import { runMigrations } from '@formiva/db';
import { buildApp } from '../src/index';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must point to the ephemeral PostgreSQL 16 test database');
}

const url = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
  url.port !== '55432' ||
  url.pathname !== '/formiva_test' ||
  url.username !== 'formiva_test'
) {
  throw new Error('Refusing to run auth tests outside the designated local formiva_test database');
}

const adminPool = new Pool({ connectionString: databaseUrl, max: 4 });
const issuer = 'https://issuer.synthetic.invalid/';
const audience = 'formiva-api-synthetic';
const authorizedParty = 'https://formiva.synthetic.invalid';
const fixtureId = randomUUID();
const firstWorkspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const firstUserId = randomUUID();
const secondUserId = randomUUID();
const firstSubject = `user_synthetic_${randomUUID()}`;
const secondSubject = `user_synthetic_${randomUUID()}`;
const unknownSubject = `user_synthetic_${randomUUID()}`;

let app: FastifyInstance | undefined;
let authPool: Pool;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwksFetch: FetchImplementation;

async function createToken(
  subject: string,
  claims: { issuer?: string; audience?: string; azp?: string; expiration?: number } = {},
  signingKey = privateKey,
): Promise<string> {
  let token = new SignJWT({ azp: claims.azp ?? authorizedParty })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-test-key' })
    .setSubject(subject)
    .setIssuedAt();

  token = token
    .setIssuer(claims.issuer ?? issuer)
    .setAudience(claims.audience ?? audience)
    .setExpirationTime(claims.expiration ?? Math.floor(Date.now() / 1000) + 300);

  return token.sign(signingKey);
}

async function requestWithToken(
  token?: string,
  workspaceId = firstWorkspaceId,
  urlPath = '/v1/private',
) {
  if (!app) throw new Error('The auth test app has not been initialized.');
  return app.inject({
    method: 'GET',
    url: urlPath,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-workspace-id': workspaceId,
    },
  });
}

describe('Fastify auth and workspace authorization', () => {
  beforeAll(async () => {
    await runMigrations(adminPool);

    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    const jwks = JSON.stringify({
      keys: [{ ...publicJwk, kid: 'synthetic-test-key', alg: 'RS256', use: 'sig' }],
    });
    jwksFetch = async () =>
      new Response(jwks, {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
      });

    await adminPool.query(
      `INSERT INTO workspaces (id, slug, name)
       VALUES ($1, $2, 'Synthetic auth workspace'),
              ($3, $4, 'Synthetic foreign workspace')`,
      [firstWorkspaceId, `auth-${fixtureId}`, foreignWorkspaceId, `foreign-${fixtureId}`],
    );
    await adminPool.query(
      `INSERT INTO users (id, auth_subject, email)
       VALUES ($1, $2, $3),
              ($4, $5, $6)`,
      [
        firstUserId,
        firstSubject,
        `${fixtureId}-first@example.invalid`,
        secondUserId,
        secondSubject,
        `${fixtureId}-second@example.invalid`,
      ],
    );

    const viewerRoleId = randomUUID();
    const foreignRoleId = randomUUID();
    await adminPool.query(
      `INSERT INTO roles (id, workspace_id, name, is_system)
       VALUES ($1, $3, 'viewer', true),
              ($2, $4, 'owner', true)`,
      [viewerRoleId, foreignRoleId, firstWorkspaceId, foreignWorkspaceId],
    );
    await adminPool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role_id, status, joined_at)
       VALUES ($1, $2, $3, 'active', now()),
              ($4, $5, $6, 'active', now())`,
      [
        firstWorkspaceId,
        firstUserId,
        viewerRoleId,
        foreignWorkspaceId,
        secondUserId,
        foreignRoleId,
      ],
    );
    await adminPool.query(
      `INSERT INTO role_permissions (workspace_id, role_id, permission_key)
       VALUES ($1, $2, 'case.read')`,
      [firstWorkspaceId, viewerRoleId],
    );

    authPool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      onConnect: (client) => {
        void client.query('SET ROLE formiva_app');
      },
    });
    app = await buildApp(
      {
        NODE_ENV: 'test',
        CLERK_ISSUER: issuer,
        CLERK_AUDIENCE: audience,
        CLERK_JWKS_URL: 'https://issuer.synthetic.invalid/.well-known/jwks.json',
        CLERK_AUTHORIZED_PARTIES: authorizedParty,
      },
      { pool: authPool, auth: { jwksFetch } },
    );
    app.get('/v1/private', async (request) =>
      request.withTenant!(
        { roles: ['viewer'], permissions: ['case.read'] },
        async (client, context) => {
          const result = await client.query<{ workspace_id: string; user_id: string }>(
            `SELECT current_setting('app.workspace_id', true) AS workspace_id,
                  current_setting('app.user_id', true) AS user_id`,
          );
          return { ...context, context: result.rows[0] };
        },
      ),
    );
    app.get('/v1/owner', async (request) =>
      request.withTenant!({ roles: ['owner'] }, async () => ({ authorized: true })),
    );
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    await authPool.end();
    await adminPool.query('DELETE FROM workspace_members WHERE workspace_id = ANY($1::uuid[])', [
      [firstWorkspaceId, foreignWorkspaceId],
    ]);
    await adminPool.query('DELETE FROM roles WHERE workspace_id = ANY($1::uuid[])', [
      [firstWorkspaceId, foreignWorkspaceId],
    ]);
    await adminPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      [firstUserId, secondUserId],
    ]);
    await adminPool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [
      [firstWorkspaceId, foreignWorkspaceId],
    ]);
    await adminPool.end();
  });

  it('rejects a missing token', async () => {
    const response = await requestWithToken();
    expect(response.statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const response = await requestWithToken(
      await createToken(firstSubject, { expiration: Math.floor(Date.now() / 1000) - 60 }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('rejects a token with an invalid signature', async () => {
    const wrongKey = await generateKeyPair('RS256');
    const response = await requestWithToken(
      await createToken(firstSubject, {}, wrongKey.privateKey),
    );
    expect(response.statusCode).toBe(401);
  });

  it('rejects an invalid issuer', async () => {
    const response = await requestWithToken(
      await createToken(firstSubject, { issuer: 'https://wrong.synthetic.invalid/' }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('rejects an invalid audience', async () => {
    const response = await requestWithToken(
      await createToken(firstSubject, { audience: 'other-api-synthetic' }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unauthorized party', async () => {
    const response = await requestWithToken(
      await createToken(firstSubject, { azp: 'https://unapproved.synthetic.invalid' }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 when the authenticated user has no matching membership', async () => {
    const response = await requestWithToken(await createToken(unknownSubject));
    expect(response.statusCode).toBe(404);
    expect(response.json().detail).toBe('Workspace not found.');
  });

  it('returns 404 when a member selects a foreign workspace', async () => {
    const response = await requestWithToken(await createToken(firstSubject), foreignWorkspaceId);
    expect(response.statusCode).toBe(404);
    expect(response.json().detail).toBe('Workspace not found.');
  });

  it('rejects a member whose role is insufficient', async () => {
    const response = await requestWithToken(
      await createToken(firstSubject),
      firstWorkspaceId,
      '/v1/owner',
    );
    expect(response.statusCode, response.body).toBe(403);
  });

  it('authorizes valid membership and sets tenant context inside the transaction', async () => {
    const response = await requestWithToken(await createToken(firstSubject));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      workspaceId: firstWorkspaceId,
      userId: firstUserId,
      role: 'viewer',
      permissions: ['case.read'],
      context: { workspace_id: firstWorkspaceId, user_id: firstUserId },
    });
  });
});
