import { describe, expect, it } from 'vitest';

import {
  generateCorrelationId,
  generateRequestId,
  redactSensitiveData,
  safeSerializeError,
} from '../src/index';

describe('observability', () => {
  it('generates request and correlation ids in UUID format', () => {
    const requestId = generateRequestId();
    const correlationId = generateCorrelationId();

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('redacts sensitive values from nested payloads', () => {
    const payload = {
      authorization: 'Bearer super-secret-token',
      nested: {
        password: 'hunter2',
        token: 'abc123',
        keep: 'safe',
      },
    };

    expect(redactSensitiveData(payload)).toEqual({
      authorization: '[REDACTED]',
      nested: {
        password: '[REDACTED]',
        token: '[REDACTED]',
        keep: 'safe',
      },
    });
  });

  it('serializes errors without exposing secret values', () => {
    const serialized = safeSerializeError(new Error('Authorization: Bearer secret-value'));

    expect(serialized.message).toContain('[REDACTED]');
    expect(serialized.message).not.toContain('secret-value');
  });
});
