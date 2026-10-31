import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/index.js';
import type { ObjectStore } from '../../apps/api/src/services/object-store.js';
import { issueRespondentToken } from '../../apps/api/src/services/respondent-tokens.js';
import { runMigrations, withTenant } from '../../packages/db/src/index.js';

type DbPool = Parameters<typeof withTenant>[0];
const requireFromApi = createRequire(resolve(process.cwd(), 'apps/api/package.json'));
const { Pool } = requireFromApi('pg') as {
  Pool: new (o: { connectionString: string; max?: number }) => DbPool & {
    on: (event: 'connect', cb: (c: { query: (q: string) => Promise<unknown> }) => void) => void;
    query: (q: string, v?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
    end: () => Promise<void>;
  };
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('DATABASE_URL must point to the ephemeral PostgreSQL 16 test database');
const db = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '::1'].includes(db.hostname) ||
  db.port !== '55432' ||
  db.pathname !== '/formiva_test'
) {
  throw new Error(
    'Refusing to run public respondent tests outside the local formiva_test database',
  );
}

const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const appPool = new Pool({ connectionString: databaseUrl, max: 8 });
appPool.on('connect', (client) => void client.query('SET ROLE formiva_app'));

// Built from parts so the repository secret scan does not mistake this fake test key for a real one.
const IP_KEY = ['synthetic', 'ip', 'hash', 'key', 'for', 'tests', 'only', '0123456789'].join('-');
const NOTICE = 'synthetic-notice-v1';
const ws = { a: randomUUID(), b: randomUUID() };
const fixture = randomUUID().slice(0, 8);
let versionA = '';
let versionB = '';
let app: Awaited<ReturnType<typeof buildApp>>;

const definition = {
  fields: [
    {
      field_key: 'full_name',
      label: 'Full name',
      field_type: 'text',
      required: true,
      sensitivity: 'internal',
    },
  ],
  slots: [
    {
      key: 'photo',
      label: 'Photo',
      required: false,
      allowed_mime_types: ['image/png', 'image/jpeg'],
      max_size_bytes: 1_000_000,
      doc_class: 'photo',
    },
    {
      key: 'cv',
      label: 'CV',
      required: false,
      allowed_mime_types: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      max_size_bytes: 5_000_000,
      doc_class: 'other',
    },
  ],
};
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const calls: Array<Parameters<ObjectStore['presignUpload']>[0]> = [];
const fakeStore: ObjectStore = {
  async presignUpload(input) {
    calls.push(input);
    return {
      url: 'https://fake.invalid/upload/' + input.key.split('/').pop(),
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + 300_000),
    };
  },
};

async function seedWorkspace(id: string, label: string) {
  const templateId = randomUUID();
  const versionId = randomUUID();
  await adminPool.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $3)`, [
    id,
    `${fixture}-${label}`,
    `Synthetic ${label}`,
  ]);
  await adminPool.query(
    `INSERT INTO form_templates (id, workspace_id, key, name) VALUES ($1, $2, $3, $4)`,
    [templateId, id, `onboarding-${label}`, `Synthetic onboarding ${label}`],
  );
  await adminPool.query(
    `INSERT INTO form_template_versions (id, workspace_id, template_id, version_number, status, schema_json, schema_sha256, privacy_notice_version, published_at)
     VALUES ($1, $2, $3, 1, 'published', $4::jsonb, decode(repeat('ab', 32), 'hex'), $5, now())`,
    [versionId, id, templateId, JSON.stringify(definition), NOTICE],
  );
  return versionId;
}
async function newToken(workspaceId: string, versionId: string): Promise<string> {
  return withTenant(
    appPool,
    workspaceId,
    null,
    async (client) =>
      (
        await issueRespondentToken(client, {
          workspaceId,
          formVersionId: versionId,
          purpose: 'public_form',
          ttlSeconds: 3600,
        })
      ).token,
  );
}
const tokenSql = `encode(t.token_hash,'hex') = encode(sha256($1::bytea),'hex')`;
const consent = { notice_version: NOTICE, accepted: true };
const saveDraft = (token: string) =>
  app.inject({
    method: 'PUT',
    url: `/public/v1/forms/${token}/draft`,
    payload: { draft_revision: 0, consent, values: {} },
  });
const upload = (token: string, over: Record<string, unknown> = {}, instance = app) =>
  instance.inject({
    method: 'POST',
    url: `/public/v1/forms/${token}/upload-requests`,
    payload: {
      idempotency_key: 'synthetic-key-' + randomUUID(),
      slot_key: 'photo',
      filename: 'face.png',
      mime_type: 'image/png',
      size_bytes: 1000,
      ...over,
    },
  });
async function docs(token: string) {
  return (
    await adminPool.query(
      `SELECT d.* FROM case_documents d JOIN respondent_tokens t ON t.case_id = d.case_id WHERE ${tokenSql} ORDER BY d.created_at`,
      [Buffer.from(token)],
    )
  ).rows;
}

let appNoStore: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await runMigrations(adminPool);
  versionA = await seedWorkspace(ws.a, 'a');
  versionB = await seedWorkspace(ws.b, 'b');
  const env = { NODE_ENV: 'test', R2_QUARANTINE_BUCKET: 'quarantine-test' };
  app = await buildApp(env, {
    pool: appPool as never,
    objectStore: fakeStore,
    auth: { testMode: true },
  });
  appNoStore = await buildApp(
    { NODE_ENV: 'test' },
    { pool: appPool as never, auth: { testMode: true } },
  );
});
afterAll(async () => {
  await app?.close();
  await appNoStore?.close();
  await appPool.end();
  await adminPool.end();
});

describe('upload requests (3.3a)', () => {
  it('needs a saved draft first', async () => {
    const token = await newToken(ws.a, versionA);
    const res = await upload(token);
    expect(res.statusCode).toBe(409);
    expect(res.json().errors[0].code).toBe('draft_required');
  });

  it('creates a quarantine-bound pending document and a short-lived upload link', async () => {
    const token = await newToken(ws.a, versionA);
    await saveDraft(token);
    calls.length = 0;
    const res = await upload(token, { filename: '../../etc/face photo.png' });
    expect(res.statusCode).toBe(201);
    const out = res.json();
    expect(out).toMatchObject({
      method: 'PUT',
      status: 'quarantine_pending',
      headers: { 'content-type': 'image/png' },
    });
    expect(out.upload_id).toBe(out.document_id);
    const text = res.body;
    expect(text).not.toContain(ws.a);
    expect(text).not.toContain('object_key');
    expect(text).not.toContain('quarantine-test');
    const [row] = await docs(token);
    expect(row).toMatchObject({
      status: 'pending_upload',
      sha256: null,
      slot_key: 'photo',
      bucket: 'quarantine-test',
      original_filename: 'face photo.png',
      doc_class: 'photo',
      mime_type: 'image/png',
    });
    expect(row.object_key).toBe(`ws/${ws.a}/cases/${row.case_id}/${row.id}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      bucket: 'quarantine-test',
      key: row.object_key,
      contentType: 'image/png',
      contentLength: 1000,
      expiresInSeconds: 300,
    });
    const audit = await adminPool.query(
      `SELECT payload::text AS p FROM audit_events WHERE workspace_id = $1 AND action = 'document.upload_requested'`,
      [ws.a],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    for (const a of audit.rows) expect(a.p).not.toContain('face photo');
  });

  it('is idempotent: same key returns the same document, a changed request conflicts', async () => {
    const token = await newToken(ws.a, versionA);
    await saveDraft(token);
    const idempotency_key = 'synthetic-key-' + randomUUID();
    const first = await upload(token, { idempotency_key });
    const again = await upload(token, { idempotency_key });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().document_id).toBe(first.json().document_id);
    expect(await docs(token)).toHaveLength(1);
    const changed = await upload(token, { idempotency_key, size_bytes: 2000 });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().errors[0].code).toBe('idempotency_conflict');
  });

  it('accepts Word documents for a slot that allows them', async () => {
    const token = await newToken(ws.a, versionA);
    await saveDraft(token);
    const res = await upload(token, {
      slot_key: 'cv',
      filename: 'cv.docx',
      mime_type: DOCX,
      size_bytes: 4000,
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects hostile or wrong requests and creates nothing', async () => {
    const token = await newToken(ws.a, versionA);
    await saveDraft(token);
    const bad: Array<[string, Record<string, unknown>]> = [
      ['renamed executable', { filename: 'invoice.exe', mime_type: 'application/octet-stream' }],
      ['exe with image type', { filename: 'invoice.exe', mime_type: 'image/png' }],
      ['mime does not match name', { filename: 'a.pdf', mime_type: 'image/png', slot_key: 'cv' }],
      ['archive', { filename: 'a.zip', mime_type: 'application/zip' }],
      ['svg', { filename: 'a.svg', mime_type: 'image/svg+xml' }],
      [
        'macro word file',
        {
          slot_key: 'cv',
          filename: 'a.docm',
          mime_type: 'application/vnd.ms-word.document.macroEnabled.12',
        },
      ],
      ['slot does not allow pdf', { filename: 'a.pdf', mime_type: 'application/pdf' }],
      ['too large for slot', { size_bytes: 2_000_000 }],
      ['unknown slot', { slot_key: 'nope' }],
      ['no extension', { filename: 'face' }],
    ];
    for (const [label, over] of bad) {
      const res = await upload(token, over);
      expect(res.statusCode, label).toBe(422);
    }
    expect((await upload(token, { size_bytes: 0 })).statusCode).toBe(400);
    expect((await upload(token, { extra: 1 })).statusCode).toBe(400);
    expect(await docs(token)).toHaveLength(0);
  });

  it('caps files per case', async () => {
    const token = await newToken(ws.a, versionA);
    await saveDraft(token);
    for (let i = 0; i < 20; i++) expect((await upload(token)).statusCode).toBe(201);
    expect((await upload(token)).statusCode).toBe(422);
  });

  it('answers 404 for bad links, 409 after submission, 503 when storage is not configured', async () => {
    expect((await upload('f'.repeat(64))).statusCode).toBe(404);
    expect((await upload('not-a-token')).statusCode).toBe(404);
    const token = await newToken(ws.a, versionA);
    await saveDraft(token);
    expect((await upload(token, {}, appNoStore)).statusCode).toBe(503);
    await adminPool.query(
      `UPDATE cases SET status = 'submitted', submitted_at = now() WHERE id = (SELECT case_id FROM respondent_tokens t WHERE ${tokenSql})`,
      [Buffer.from(token)],
    );
    expect((await upload(token)).statusCode).toBe(409);
  });

  it('never writes to another workspace', async () => {
    const tokenB = await newToken(ws.b, versionB);
    await saveDraft(tokenB);
    const before = await adminPool.query(
      `SELECT count(*)::int AS n FROM case_documents WHERE workspace_id = $1`,
      [ws.a],
    );
    expect((await upload(tokenB)).statusCode).toBe(201);
    const after = await adminPool.query(
      `SELECT count(*)::int AS n FROM case_documents WHERE workspace_id = $1`,
      [ws.a],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect((await docs(tokenB))[0].workspace_id).toBe(ws.b);
  });
});
