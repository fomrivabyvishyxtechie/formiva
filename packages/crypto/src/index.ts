import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for highly sensitive values (Technical Documentation 7.5/7.11).
 * Each value gets a random data key (DEK). The DEK is wrapped with a per-workspace key (KEK)
 * derived from a master key that lives outside the database. Everything is AES-256-GCM.
 *
 * shortcut: the wrapped DEK is stored inside the blob, not in a key table (none exists in the
 * schema). Rotating the master key means re-wrapping each blob with `rewrapValue`.
 */

/** Where master keys come from. A real provider (OCI Vault, SOPS) is decision D-4, still open. */
export interface KeyProvider {
  /** Id stored next to the ciphertext, so the right master key can be found later. */
  readonly currentKeyId: string;
  /** 32 bytes. Throws if the id is unknown. */
  masterKey(keyId: string): Buffer;
}

/** In-memory provider for tests and local runs. Never reads the environment. */
export function staticKeyProvider(keys: Record<string, Buffer>, currentKeyId: string): KeyProvider {
  if (!keys[currentKeyId]) throw new Error('current key id has no key');
  return {
    currentKeyId,
    masterKey(id) {
      const k = keys[id];
      if (!k) throw new Error(`unknown key id: ${id}`);
      return k;
    },
  };
}

/** Binds a ciphertext to the place it belongs, so it cannot be moved to another value. */
export interface ValueContext {
  workspaceId: string;
  caseId: string;
  fieldKey: string;
  revision: number;
}

const VERSION = 1;
const NONCE = 12;
const TAG = 16;
const KEY = 32;
// version | wrapNonce | wrappedDek | wrapTag | dataNonce | dataTag | ciphertext
const HEADER = 1 + NONCE + KEY + TAG + NONCE + TAG;

const dataAad = (c: ValueContext) =>
  Buffer.from(`formiva:v1:value|${c.workspaceId}|${c.caseId}|${c.fieldKey}|${c.revision}`);
const wrapAad = (workspaceId: string) => Buffer.from(`formiva:v1:wrap|${workspaceId}`);

function kekFor(master: Buffer, workspaceId: string): Buffer {
  if (master.length !== KEY) throw new Error('master key must be 32 bytes');
  return Buffer.from(
    hkdfSync('sha256', master, Buffer.alloc(0), `formiva:kek:v1|${workspaceId}`, KEY),
  );
}

function seal(key: Buffer, aad: Buffer, plain: Buffer) {
  const nonce = randomBytes(NONCE);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return { nonce, body, tag: c.getAuthTag() };
}

function open(key: Buffer, aad: Buffer, nonce: Buffer, tag: Buffer, body: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

export function encryptValue(
  provider: KeyProvider,
  ctx: ValueContext,
  plaintext: string,
): { ciphertext: Buffer; keyId: string } {
  const keyId = provider.currentKeyId;
  const kek = kekFor(provider.masterKey(keyId), ctx.workspaceId);
  const dek = randomBytes(KEY);
  const wrapped = seal(kek, wrapAad(ctx.workspaceId), dek);
  const data = seal(dek, dataAad(ctx), Buffer.from(plaintext, 'utf8'));
  dek.fill(0);
  return {
    keyId,
    ciphertext: Buffer.concat([
      Buffer.from([VERSION]),
      wrapped.nonce,
      wrapped.body,
      wrapped.tag,
      data.nonce,
      data.tag,
      data.body,
    ]),
  };
}

function split(blob: Buffer) {
  if (blob.length < HEADER || blob[0] !== VERSION) throw new Error('unsupported ciphertext');
  let o = 1;
  const take = (n: number) => blob.subarray(o, (o += n));
  return {
    wrapNonce: take(NONCE),
    wrappedDek: take(KEY),
    wrapTag: take(TAG),
    dataNonce: take(NONCE),
    dataTag: take(TAG),
    body: blob.subarray(o),
  };
}

/** Throws if the blob was changed, the key is wrong, or the context does not match. */
export function decryptValue(
  provider: KeyProvider,
  keyId: string,
  ctx: ValueContext,
  blob: Buffer,
): string {
  const p = split(blob);
  const kek = kekFor(provider.masterKey(keyId), ctx.workspaceId);
  const dek = open(kek, wrapAad(ctx.workspaceId), p.wrapNonce, p.wrapTag, p.wrappedDek);
  try {
    return open(dek, dataAad(ctx), p.dataNonce, p.dataTag, p.body).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/** Moves a blob to the provider's current master key without touching the data part. */
export function rewrapValue(
  provider: KeyProvider,
  oldKeyId: string,
  workspaceId: string,
  blob: Buffer,
): { ciphertext: Buffer; keyId: string } {
  const p = split(blob);
  const oldKek = kekFor(provider.masterKey(oldKeyId), workspaceId);
  const dek = open(oldKek, wrapAad(workspaceId), p.wrapNonce, p.wrapTag, p.wrappedDek);
  const keyId = provider.currentKeyId;
  const w = seal(kekFor(provider.masterKey(keyId), workspaceId), wrapAad(workspaceId), dek);
  dek.fill(0);
  return {
    keyId,
    ciphertext: Buffer.concat([
      Buffer.from([VERSION]),
      w.nonce,
      w.body,
      w.tag,
      p.dataNonce,
      p.dataTag,
      p.body,
    ]),
  };
}

/** What may be shown without revealing the value: the last four characters, or nothing if short. */
export function maskedPreview(plaintext: string): string {
  const s = plaintext.replace(/\s+/g, '');
  return s.length < 8 ? '••••' : `••••${s.slice(-4)}`;
}
