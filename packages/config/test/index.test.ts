import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/index';

describe('loadConfig', () => {
  it('uses safe defaults when environment values are absent', () => {
    expect(loadConfig({})).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      API_NAME: 'formiva-api',
    });
  });

  it('rejects malformed environment values', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(/Invalid environment configuration/);
  });
});
