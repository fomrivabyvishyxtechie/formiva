import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index';

const testState = vi.hoisted(() => ({
  query: vi.fn(),
  workspaceId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  role: 'owner',
}));

vi.mock('@formiva/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@formiva/db')>();
  return {
    ...actual,
    withAuthorizedTenant: vi.fn(async (...args: Parameters<typeof actual.withAuthorizedTenant>) => {
      const requirements = args[3];
      if (requirements.roles && !requirements.roles.includes(testState.role))
        throw Object.assign(new Error('Insufficient role.'), {
          statusCode: 403,
          publicMessage: 'Insufficient role.',
        });
      if (requirements.permissions?.some((permission) => permission !== 'member.manage'))
        throw Object.assign(new Error('Insufficient permission.'), {
          statusCode: 403,
          publicMessage: 'Insufficient permission.',
        });
      return args[4]({ query: testState.query } as unknown as PoolClient, {
        workspaceId: testState.workspaceId,
        userId: testState.userId,
        role: testState.role,
        permissions: ['member.manage'],
      });
    }),
  };
});

const workspaceId = testState.workspaceId;
const invitationId = '00000000-0000-4000-8000-000000000003';
const memberId = '00000000-0000-4000-8000-000000000004';

async function makeApp(poolQuery = vi.fn()) {
  return buildApp(
    { NODE_ENV: 'test' },
    {
      pool: { query: poolQuery, connect: vi.fn() } as unknown as Pool,
      auth: { testMode: true },
    },
  );
}

describe('workspace invitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.role = 'owner';
    testState.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users')) return { rows: [{ id: testState.userId }] };
      return { rows: [] };
    });
  });

  it('creates an invitation with only a token hash and returns no recipient email', async () => {
    testState.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM users')) return { rows: [{ id: testState.userId }] };
      if (sql.includes('FROM workspace_invitations') && sql.includes('idempotency_key_hash'))
        return { rows: [] };
      if (sql.includes('FROM roles')) return { rows: [{ id: 'role-id' }] };
      if (sql.includes('FROM users')) return { rows: [{ id: testState.userId }] };
      if (sql.includes('INSERT INTO workspace_invitations'))
        return { rows: [{ id: invitationId, expires_at: params[4] }] };
      return { rows: [] };
    });
    const app = await makeApp();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/members/invitations`,
      headers: { 'idempotency-key': 'invite-1' },
      payload: { email: ' Ada@Example.Test ', role: 'viewer' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).not.toHaveProperty('email');
    expect(response.json()).not.toHaveProperty('token_hash');
    expect(response.json()).not.toHaveProperty('token');
    const insert = testState.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO workspace_invitations'),
    );
    expect(insert?.[1]?.[2]).toBe('ada@example.test');
    expect(insert?.[1]?.[3]).toBeInstanceOf(Buffer);
    expect((insert?.[1]?.[3] as Buffer).byteLength).toBe(32);
    const audit = testState.query.mock.calls.find(([sql]) => String(sql).includes('app.audit'));
    expect(audit?.[1]).toEqual([invitationId, testState.userId]);
    expect(JSON.stringify(audit?.[1])).not.toContain('ada@example.test');
    await app.close();
  });

  it('replays an idempotent create without returning the raw token', async () => {
    const keyHash = createHash('sha256').update('invite-1').digest();
    const bodyHash = createHash('sha256')
      .update(JSON.stringify({ email: 'ada@example.test', role: 'viewer' }))
      .digest();
    testState.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users')) return { rows: [{ id: testState.userId }] };
      if (sql.includes('FROM workspace_invitations') && sql.includes('idempotency_key_hash'))
        return {
          rows: [
            {
              id: invitationId,
              expires_at: new Date('2026-10-10T00:00:00Z'),
              request_hash: bodyHash,
            },
          ],
        };
      return { rows: [] };
    });
    const app = await makeApp();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/members/invitations`,
      headers: { 'idempotency-key': 'invite-1' },
      payload: { email: 'ada@example.test', role: 'viewer' },
    });

    expect(keyHash).toHaveLength(32);
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('token');
    expect(testState.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO workspace_invitations'),
      expect.anything(),
    );
    await app.close();
  });

  it('rejects changed-body idempotency replays with problem details', async () => {
    testState.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users')) return { rows: [{ id: testState.userId }] };
      return {
        rows: [
          {
            id: invitationId,
            expires_at: new Date('2026-10-10T00:00:00Z'),
            request_hash: Buffer.alloc(32),
          },
        ],
      };
    });
    const app = await makeApp();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/members/invitations`,
      headers: { 'idempotency-key': 'invite-1' },
      payload: { email: 'ada@example.test', role: 'viewer' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 409, title: 'Conflict' });
    await app.close();
  });

  it('prevents administrators from granting the owner role', async () => {
    testState.role = 'admin';
    const app = await makeApp();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/members/invitations`,
      headers: { 'idempotency-key': 'invite-owner' },
      payload: { email: 'ada@example.test', role: 'owner' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/problem+json');
    await app.close();
  });

  it('returns safe 403/404 responses for insufficient roles and foreign workspaces', async () => {
    testState.role = 'viewer';
    const app = await makeApp();
    const forbidden = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/members/invitations`,
      headers: { 'idempotency-key': 'invite-forbidden' },
      payload: { email: 'ada@example.test', role: 'viewer' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.headers['content-type']).toContain('application/problem+json');

    testState.role = 'owner';
    const foreignWorkspace = await app.inject({
      method: 'POST',
      url: '/v1/workspaces/00000000-0000-4000-8000-000000000099/members/invitations',
      headers: { 'idempotency-key': 'invite-foreign-workspace' },
      payload: { email: 'ada@example.test', role: 'viewer' },
    });
    expect(foreignWorkspace.statusCode).toBe(404);
    expect(foreignWorkspace.headers['content-type']).toContain('application/problem+json');

    const missingInvitation = await app.inject({
      method: 'DELETE',
      url: `/v1/invitations/${invitationId}`,
    });
    expect(missingInvitation.statusCode).toBe(404);
    expect(missingInvitation.headers['content-type']).toContain('application/problem+json');
    await app.close();
  });

  it('accepts before membership and sends only the token hash to the database', async () => {
    const rawToken = 'a'.repeat(64);
    const query = vi.fn().mockResolvedValue({
      rows: [{ workspace_id: workspaceId, user_id: memberId, role: 'viewer' }],
    });
    const app = await makeApp(query);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: rawToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspace_id: workspaceId,
      user_id: memberId,
      role: 'viewer',
    });
    expect(query).toHaveBeenCalledWith('SELECT * FROM app.accept_invitation($1, $2)', [
      'synthetic-test-user',
      createHash('sha256').update(rawToken).digest(),
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain(rawToken);
    await app.close();
  });

  it('returns safe problem responses for missing auth, unknown invitations, and unverified identity', async () => {
    const authApp = await buildApp({ NODE_ENV: 'test' }, { pool: {} as Pool });
    const unauthenticated = await authApp.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      payload: { token: 'a'.repeat(64) },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['content-type']).toContain('application/problem+json');
    await authApp.close();

    for (const [code, statusCode] of [
      ['P0002', 404],
      ['28000', 403],
    ] as const) {
      const query = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('database failure'), { code }));
      const app = await makeApp(query);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        payload: { token: 'a'.repeat(64) },
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).not.toContain('database failure');
      await app.close();
    }
  });

  it('returns 204 on revocation and emits only a redacted audit event', async () => {
    testState.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT i.id, r.name'))
        return { rows: [{ id: invitationId, role: 'viewer' }] };
      if (sql.includes('UPDATE workspace_invitations')) return { rows: [{ id: invitationId }] };
      return { rows: [] };
    });
    const app = await makeApp();

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/invitations/${invitationId}`,
    });

    expect(response.statusCode).toBe(204);
    const audit = testState.query.mock.calls.find(([sql]) => String(sql).includes('app.audit'));
    expect(audit?.[1]).toEqual([invitationId, testState.userId]);
    await app.close();
  });
});
