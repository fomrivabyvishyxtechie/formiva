import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { withAuthorizedTenant } from '@formiva/db';
import { buildApp } from '../src/index';

vi.mock('@formiva/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@formiva/db')>();
  return {
    ...actual,
    withAuthorizedTenant: vi.fn(async (...args: Parameters<typeof actual.withAuthorizedTenant>) =>
      args[4](
        {
          query: vi.fn().mockResolvedValue({
            rows: [{ id: '00000000-0000-4000-8000-000000000001' }],
          }),
        } as unknown as PoolClient,
        {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          userId: '00000000-0000-4000-8000-000000000002',
          role: 'owner',
          permissions: [],
        },
      ),
    ),
  };
});

describe('POST /v1/workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a workspace successfully', async () => {
    const mockPool = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            workspace_id: '00000000-0000-4000-8000-000000000001',
            name: 'Synthetic Demo Workspace',
            slug: 'synthetic-demo-workspace',
            replay: false,
          },
        ],
      }),
    } as unknown as Pool;

    const app = await buildApp(
      { NODE_ENV: 'test' },
      {
        pool: mockPool,
        auth: { testMode: true },
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { 'idempotency-key': 'synthetic-bootstrap-key' },
      payload: {
        name: 'Synthetic Demo Workspace',
        slug: 'synthetic-demo-workspace',
      },
    });

    expect(withAuthorizedTenant).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({
      name: 'Synthetic Demo Workspace',
      slug: 'synthetic-demo-workspace',
    });
    await app.close();
  });

  it('rejects caller-supplied workspace or owner IDs before database access', async () => {
    const query = vi.fn();
    const app = await buildApp(
      { NODE_ENV: 'test' },
      { pool: { query, connect: vi.fn() } as unknown as Pool, auth: { testMode: true } },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { 'idempotency-key': 'synthetic-bootstrap-key' },
      payload: {
        name: 'Synthetic Workspace',
        slug: 'synthetic-workspace',
        id: '00000000-0000-4000-8000-000000000001',
        owner_id: '00000000-0000-4000-8000-000000000002',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(query).not.toHaveBeenCalled();
    expect(withAuthorizedTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects workspace selectors on pre-membership bootstrap routes', async () => {
    const query = vi.fn();
    const app = await buildApp(
      { NODE_ENV: 'test' },
      { pool: { query, connect: vi.fn() } as unknown as Pool, auth: { testMode: true } },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: {
        'idempotency-key': 'synthetic-bootstrap-key',
        'x-workspace-id': '00000000-0000-4000-8000-000000000001',
      },
      payload: { name: 'Synthetic Workspace', slug: 'synthetic-workspace' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['P0001', 409],
    ['23505', 409],
    ['28000', 403],
  ])('maps database code %s to a safe problem response', async (code, statusCode) => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error('database details'), { code }));
    const app = await buildApp(
      { NODE_ENV: 'test' },
      { pool: { query, connect: vi.fn() } as unknown as Pool, auth: { testMode: true } },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { 'idempotency-key': 'synthetic-bootstrap-key' },
      payload: { name: 'Synthetic Workspace', slug: 'synthetic-workspace' },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).not.toContain('database details');
    await app.close();
  });
});
