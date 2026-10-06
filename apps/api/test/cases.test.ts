import { describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { withAuthorizedTenant } from '@formiva/db';
import { buildApp } from '../src/index';
import { createSyntheticClerk } from './support/synthetic-clerk';

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

describe('GET /v1/cases/:case_id/timeline', () => {
  it('returns only the redacted, correlation-linked timeline projection', async () => {
    const mockPool = {} as unknown as Pool;
    const correlationId = '00000000-0000-4000-8000-000000000099';
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          occurred_at: new Date('2026-10-06T12:00:00Z'),
          correlation_id: correlationId,
          action: 'policy.internal_sensitive_detail',
          actor_id: 'synthetic-user-id',
          object_id: 'synthetic-object-id',
          reason: 'Synthetic full ID number 123456789',
          payload: { document_text: 'Synthetic raw document text', credential: 'synthetic-secret' },
        },
      ],
    });

    vi.mocked(withAuthorizedTenant).mockImplementation(async (...args: any[]) => {
      return args[4](
        { query: mockQuery } as unknown as PoolClient,
        { workspaceId: '00000000-0000-4000-8000-000000000002' } as any,
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
      url: '/v1/cases/00000000-0000-4000-8000-000000000001/timeline',
      headers: { 'x-workspace-id': '00000000-0000-4000-8000-000000000002' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          occurred_at: '2026-10-06T12:00:00.000Z',
          correlation_id: correlationId,
          event: 'case_activity',
        },
      ],
    });
    expect(response.body).not.toContain('00000000-0000-4000-8000-000000000001');
    expect(response.body).not.toContain('policy.internal_sensitive_detail');
    expect(response.body).not.toContain('synthetic-user-id');
    expect(response.body).not.toContain('synthetic-object-id');
    expect(response.body).not.toContain('123456789');
    expect(response.body).not.toContain('Synthetic raw document text');
    expect(response.body).not.toContain('synthetic-secret');
    expect(mockQuery.mock.calls[0]?.[0]).not.toMatch(/payload|reason|actor_id/i);
    await app.close();
  });

  it('rejects a malformed case ID', async () => {
    const app = await buildApp(
      { NODE_ENV: 'test' },
      {
        pool: {} as unknown as Pool,
        auth: { testMode: true },
      },
    );

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cases/not-a-uuid/timeline',
      headers: { 'x-workspace-id': '00000000-0000-4000-8000-000000000002' },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /v1/cases/:case_id/rework', () => {
  it('uses a valid JWT and atomically reworks once with idempotent safe retries', async () => {
    const mockPool = {} as unknown as Pool;
    const clerk = await createSyntheticClerk();
    const token = await clerk.createToken('synthetic_rework_approver');
    const caseId = '00000000-0000-4000-8000-000000000001';
    const workspaceId = '00000000-0000-4000-8000-000000000002';
    const correlationId = '00000000-0000-4000-8000-000000000003';
    const idempotencyKey = 'synthetic-rework-operation-1';
    const reason = 'Synthetic address evidence needs correction.';
    const requirementsSeen: { permissions?: readonly string[] }[] = [];
    let currentStatus = 'approval_pending';
    let priorEvent:
      | {
          object_id: string;
          reason: string;
          correlation_id: string;
          idempotency_key_hash: string;
        }
      | undefined;
    let auditPayload:
      { from_status: string; to_status: string; idempotency_key_hash: string } | undefined;
    let updateCount = 0;
    let auditCount = 0;

    const mockQuery = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM cases') && sql.includes('FOR UPDATE')) {
        return { rows: [{ status: currentStatus }] };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [{}] };
      }
      if (sql.includes("payload->>'idempotency_key_hash'")) {
        return { rows: priorEvent ? [priorEvent] : [] };
      }
      if (sql.includes('FROM app.state_transitions')) {
        return { rows: [{ allowed: currentStatus === 'approval_pending' }] };
      }
      if (sql.includes('UPDATE cases')) {
        currentStatus = 'review_queued';
        updateCount += 1;
        return { rows: [{ status: currentStatus }] };
      }
      if (sql.includes('SELECT app.audit')) {
        auditPayload = JSON.parse(String(values?.[2])) as {
          from_status: string;
          to_status: string;
          idempotency_key_hash: string;
        };
        priorEvent = {
          object_id: String(values?.[0]),
          reason: String(values?.[1]),
          correlation_id: String(values?.[4]),
          idempotency_key_hash: auditPayload.idempotency_key_hash,
        };
        auditCount += 1;
        return { rows: [{ id: '00000000-0000-4000-8000-000000000004' }] };
      }
      throw new Error(`Unexpected query in rework test: ${sql}`);
    });
    const mockClient = { query: mockQuery } as unknown as PoolClient;

    vi.mocked(withAuthorizedTenant).mockImplementation(async (...args: any[]) => {
      requirementsSeen.push(args[3]);
      return args[4](mockClient, {
        workspaceId,
        userId: '00000000-0000-4000-8000-000000000005',
        role: 'approver',
        permissions: ['case.approve'],
      });
    });

    const app = await buildApp(
      {
        NODE_ENV: 'test',
        CLERK_ISSUER: clerk.issuer,
        CLERK_AUDIENCE: clerk.audience,
        CLERK_JWKS_URL: 'https://tenant-isolation.synthetic.invalid/.well-known/jwks.json',
        CLERK_AUTHORIZED_PARTIES: clerk.authorizedParty,
      },
      { pool: mockPool, auth: { jwksFetch: clerk.jwksFetch } },
    );
    const headers = {
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspaceId,
      'x-correlation-id': correlationId,
      'idempotency-key': idempotencyKey,
    };
    const request = {
      method: 'POST' as const,
      url: `/v1/cases/${caseId}/rework`,
      headers,
      payload: { reason },
    };

    const firstResponse = await app.inject(request);
    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    expect(firstResponse.json()).toEqual({
      case_id: caseId,
      status: 'review_queued',
      correlation_id: correlationId,
    });
    expect(firstResponse.body).not.toContain(reason);

    const retryResponse = await app.inject(request);
    expect(retryResponse.statusCode, retryResponse.body).toBe(200);
    expect(retryResponse.json()).toEqual(firstResponse.json());
    expect(updateCount).toBe(1);
    expect(auditCount).toBe(1);
    expect(auditPayload).toMatchObject({
      from_status: 'approval_pending',
      to_status: 'review_queued',
    });
    expect(auditPayload?.idempotency_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(auditPayload?.idempotency_key_hash).not.toBe(idempotencyKey);
    expect(priorEvent?.reason).toBe(reason);
    expect(
      requirementsSeen.some((requirements) => requirements.permissions?.includes('case.approve')),
    ).toBe(true);

    const crossCaseKeyReuse = await app.inject({
      ...request,
      url: '/v1/cases/00000000-0000-4000-8000-000000000006/rework',
    });
    expect(crossCaseKeyReuse.statusCode).toBe(409);

    const changedBodyRetry = await app.inject({
      ...request,
      payload: { reason: 'A different synthetic reason.' },
    });
    expect(changedBodyRetry.statusCode).toBe(409);
    expect(changedBodyRetry.json().detail).not.toContain('approval_pending');
    expect(updateCount).toBe(1);
    expect(auditCount).toBe(1);
    await app.close();
  });
});
