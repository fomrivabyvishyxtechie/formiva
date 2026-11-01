import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decryptValue,
  encryptValue,
  maskedPreview,
  rewrapValue,
  staticKeyProvider,
  type ValueContext,
} from '../src/index';

const ctx: ValueContext = { workspaceId: 'ws-1', caseId: 'case-1', fieldKey: 'id_no', revision: 1 };
const provider = staticKeyProvider({ k1: randomBytes(32) }, 'k1');
const SECRET = 'SYNTH-0000-1111-2222';

describe('envelope encryption', () => {
  it('round trips and keeps the plaintext out of the blob', () => {
    const { ciphertext, keyId } = encryptValue(provider, ctx, SECRET);
    expect(keyId).toBe('k1');
    expect(ciphertext.toString('latin1')).not.toContain('SYNTH');
    expect(decryptValue(provider, keyId, ctx, ciphertext)).toBe(SECRET);
  });

  it('uses a fresh key and nonce every time', () => {
    const a = encryptValue(provider, ctx, SECRET).ciphertext;
    const b = encryptValue(provider, ctx, SECRET).ciphertext;
    expect(a.equals(b)).toBe(false);
  });

  it('rejects tampering anywhere in the blob', () => {
    const { ciphertext } = encryptValue(provider, ctx, SECRET);
    for (const i of [1, 20, 50, 70, ciphertext.length - 1]) {
      const bad = Buffer.from(ciphertext);
      bad[i] = bad[i]! ^ 1;
      expect(() => decryptValue(provider, 'k1', ctx, bad), `byte ${i}`).toThrow();
    }
    expect(() => decryptValue(provider, 'k1', ctx, ciphertext.subarray(0, 40))).toThrow();
  });

  it('is bound to workspace, case, field and revision', () => {
    const { ciphertext } = encryptValue(provider, ctx, SECRET);
    for (const other of [
      { ...ctx, workspaceId: 'ws-2' },
      { ...ctx, caseId: 'case-2' },
      { ...ctx, fieldKey: 'other' },
      { ...ctx, revision: 2 },
    ]) {
      expect(() => decryptValue(provider, 'k1', other, ciphertext)).toThrow();
    }
  });

  it('fails with the wrong or an unknown key', () => {
    const { ciphertext } = encryptValue(provider, ctx, SECRET);
    const wrong = staticKeyProvider({ k1: randomBytes(32) }, 'k1');
    expect(() => decryptValue(wrong, 'k1', ctx, ciphertext)).toThrow();
    expect(() => decryptValue(provider, 'nope', ctx, ciphertext)).toThrow(/unknown key id/);
  });

  it('rewraps to a new master key without changing the data part', () => {
    const old = encryptValue(provider, ctx, SECRET);
    const rotated = staticKeyProvider({ k1: provider.masterKey('k1'), k2: randomBytes(32) }, 'k2');
    const re = rewrapValue(rotated, 'k1', ctx.workspaceId, old.ciphertext);
    expect(re.keyId).toBe('k2');
    expect(decryptValue(rotated, 'k2', ctx, re.ciphertext)).toBe(SECRET);
    expect(() => decryptValue(rotated, 'k1', ctx, re.ciphertext)).toThrow();
  });

  it('rejects a master key that is not 32 bytes', () => {
    const bad = staticKeyProvider({ k1: randomBytes(16) }, 'k1');
    expect(() => encryptValue(bad, ctx, SECRET)).toThrow(/32 bytes/);
  });
});

describe('maskedPreview', () => {
  it('shows only the last four, and nothing for short values', () => {
    expect(maskedPreview('SYNTH-0000-1111-2222')).toBe('••••2222');
    expect(maskedPreview('1234567')).toBe('••••');
    expect(maskedPreview('1234 5678')).toBe('••••5678');
  });
});
