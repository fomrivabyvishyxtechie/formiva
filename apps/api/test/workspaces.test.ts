import { describe, expect, it, vi } from 'vitest';
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
  it('creates a workspace successfully', async () => {
    const mockPool = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [{ id: '00000000-0000-4000-8000-000000000001' }] }),
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
      payload: {
        name: 'Synthetic Demo Workspace',
        slug: 'synthetic-demo-workspace',
      },
    });

    expect(withAuthorizedTenant).toHaveBeenCalledWith(
      mockPool,
      'synthetic-test-user',
      undefined,
      {},
      expect.any(Function),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: 'Synthetic Demo Workspace',
      slug: 'synthetic-demo-workspace',
    });
    await app.close();
  });
});
