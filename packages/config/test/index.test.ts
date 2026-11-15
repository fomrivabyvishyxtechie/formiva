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

  it('accepts bucket names and an account id, and refuses a pasted web address', () => {
    const ok = {
      R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      R2_QUARANTINE_BUCKET: 'formiva-quarantine-dev',
      R2_DOCUMENTS_BUCKET: 'formiva-documents-dev',
    };
    expect(loadConfig(ok)).toMatchObject(ok);
    const address =
      'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/formiva-quarantine-dev';
    expect(() => loadConfig({ R2_QUARANTINE_BUCKET: address })).toThrow(/bucket name only/);
    expect(() => loadConfig({ R2_DOCUMENTS_BUCKET: 'Has Space' })).toThrow(/bucket name only/);
    expect(() => loadConfig({ R2_ACCOUNT_ID: address })).toThrow(/account id/);
  });

  it('rejects malformed environment values', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(/Invalid environment configuration/);
  });
});
