import { describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { withAuthorizedTenant } from '@formiva/db';
import { buildApp } from '../src/index';

vi.mock('@formiva/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@formiva/db')>();
  return {
    ...actual,
    withAuthorizedTenant: vi.fn(),
  };
});

describe('GET /v1/cases/:case_id', () => {
  it('returns 200 for a valid case', async () => {
    const mockPool = {} as unknown as Pool;
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          case_number: '123',
          status: 'draft',
          created_at: new Date('2026-10-06T12:00:00Z'),
        },
      ],
    });

    vi.mocked(withAuthorizedTenant).mockImplementation(async (...args: any[]) => {
      return args[4](
        { query: mockQuery } as unknown as PoolClient,
        { workspaceId: '00000000-0000-4000-8000-000000000001' } as any,
      );
    });

    const app = await buildApp(
      { NODE_ENV: 'test' },
      {
        pool: mockPool,
        auth: { testMode: true },
      },
    );

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cases/00000000-0000-4000-8000-000000000001',
      headers: { 'x-workspace-id': '00000000-0000-4000-8000-000000000001' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      case_number: '123',
      status: 'draft',
    });
    await app.close();
  });

  it('returns 404 for unknown case', async () => {
    const mockPool = {} as unknown as Pool;
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [],
    });

    vi.mocked(withAuthorizedTenant).mockImplementation(async (...args: any[]) => {
      return args[4](
        { query: mockQuery } as unknown as PoolClient,
        { workspaceId: '00000000-0000-4000-8000-000000000001' } as any,
      );
    });

    const app = await buildApp(
      { NODE_ENV: 'test' },
      {
        pool: mockPool,
        auth: { testMode: true },
      },
    );

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cases/00000000-0000-4000-8000-000000000001',
      headers: { 'x-workspace-id': '00000000-0000-4000-8000-000000000001' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
