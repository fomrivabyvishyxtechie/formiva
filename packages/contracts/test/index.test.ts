import { describe, expect, it } from 'vitest';

import { createProblemDetails, healthResponseSchema, problemDetailsSchema } from '../src/index';

describe('contracts', () => {
  it('accepts a valid health payload', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'formiva-api',
      version: '0.1.0',
      timestamp: '2026-10-03T00:00:00.000Z',
      uptimeMs: 42,
      environment: 'test',
    });

    expect(result.success).toBe(true);
  });

  it('builds an RFC 9457 problem payload', () => {
    const result = problemDetailsSchema.safeParse(
      createProblemDetails({
        type: 'https://api.formiva.invalid/problems/validation-error',
        title: 'Request validation failed',
        status: 400,
        detail: 'One or more fields are invalid.',
        correlation_id: '00000000-0000-4000-8000-000000000001',
        errors: [
          { field: 'document_id', code: 'invalid_uuid', message: 'document_id must be a UUID.' },
        ],
      }),
    );

    expect(result.success).toBe(true);
  });
});
