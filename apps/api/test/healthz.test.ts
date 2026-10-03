import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/index';

describe('GET /healthz', () => {
  it('returns a healthy payload and preserves correlation ids', async () => {
    const app = buildApp({ NODE_ENV: 'test' });
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-correlation-id': 'corr-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.headers['x-correlation-id']).toBe('corr-123');

    const payload = response.json();
    expect(payload).toMatchObject({
      status: 'ok',
      service: 'formiva-api',
      environment: 'test',
      correlationId: 'corr-123',
    });
  });
});
