import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from '../src/index';

describe('POST /v1/workspaces unauthenticated', () => {
  it('returns 401 when no synthetic auth is enabled', async () => {
    const mockPool = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [{ id: '00000000-0000-4000-8000-000000000001' }] }),
    } as unknown as Pool;

    const app = await buildApp({ NODE_ENV: 'test' }, { pool: mockPool });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { name: 'My WS', slug: 'myws' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
