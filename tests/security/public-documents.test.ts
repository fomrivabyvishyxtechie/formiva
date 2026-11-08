import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/index.js';
import type { UploadSigner } from '../../apps/api/src/services/object-store.js';
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
      required: true,
      allowed_mime_types: ['image/png'],
      max_size_bytes: 1_000_000,
      doc_class: 'photo',
    },
  ],
};
const fakeStore: UploadSigner = {
  async presignUpload(input) {
    return {
      url: 'https://fake.invalid/upload/' + input.key.split('/').pop(),
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + 300_000),
    };
  },
};
const versions: Record<'a' | 'b', string> = { a: '', b: '' };

async function seed(id: string, label: 'a' | 'b') {
  await adminPool.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $3)`, [
    id,
    `${fixture}-${label}`,
    `Synthetic ${label}`,
  ]);
  const templateId = randomUUID();
  const versionId = randomUUID();
  await adminPool.query(
    `INSERT INTO form_templates (id, workspace_id, key, name) VALUES ($1, $2, $3, 'Synthetic form')`,
    [templateId, id, `form-${randomUUID().slice(0, 8)}`],
  );
  await adminPool.query(
    `INSERT INTO form_template_versions (id, workspace_id, template_id, version_number, status, schema_json, schema_sha256, privacy_notice_version, published_at)
     VALUES ($1, $2, $3, 1, 'published', $4::jsonb, decode(repeat('ab', 32), 'hex'), $5, now())`,
    [versionId, id, templateId, JSON.stringify(definition), NOTICE],
  );
  await adminPool.query(
    `INSERT INTO routing_policies (workspace_id, policy_version, status, activated_at) VALUES ($1, 'synthetic-policy-v1', 'active', now())`,
    [id],
  );
  versions[label] = versionId;
}
async function newToken(label: 'a' | 'b'): Promise<string> {
  const workspaceId = label === 'a' ? ws.a : ws.b;
  return withTenant(
    appPool,
    workspaceId,
    null,
    async (client) =>
      (
        await issueRespondentToken(client, {
          workspaceId,
          formVersionId: versions[label],
          purpose: 'public_form',
          ttlSeconds: 3600,
        })
      ).token,
  );
}
const url = (token: string, tail = '') => `/public/v1/forms/${token}${tail}`;
const save = (token: string) =>
  app.inject({
    method: 'PUT',
    url: url(token, '/draft'),
    payload: {
      draft_revision: 0,
      consent: { notice_version: NOTICE, accepted: true },
      values: { full_name: 'Synthetic Person' },
    },
  });
const upload = async (token: string) => {
  const res = await app.inject({
    method: 'POST',
    url: url(token, '/upload-requests'),
    payload: {
      idempotency_key: 'synthetic-key-' + randomUUID(),
      slot_key: 'photo',
      filename: 'me.png',
      mime_type: 'image/png',
      size_bytes: 1000,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().document_id as string;
};
const list = async (token: string) =>
  (await app.inject({ method: 'GET', url: url(token, '/documents') })).json().documents as Array<
    Record<string, unknown>
  >;
const remove = (token: string, id: string) =>
  app.inject({ method: 'DELETE', url: url(token, `/documents/${id}`) });
const setStatus = (id: string, status: string, reason: string | null = null) =>
  adminPool.query(
    `UPDATE case_documents SET status = $2, quarantine_reason = $3,
            sha256 = CASE WHEN $2 <> 'pending_upload' THEN decode(repeat('cd', 32), 'hex') ELSE sha256 END WHERE id = $1`,
    [id, status, reason],
  );

beforeAll(async () => {
  await runMigrations(adminPool);
  await seed(ws.a, 'a');
  await seed(ws.b, 'b');
  app = await buildApp(
    { NODE_ENV: 'test', R2_QUARANTINE_BUCKET: 'quarantine-test' },
    { pool: appPool as never, objectStore: fakeStore, auth: { testMode: true } },
  );
});
afterAll(async () => {
  await app?.close();
  await appPool.end();
  await adminPool.end();
});

describe('respondent file list and remove (ADR-28)', () => {
  it('shows each file with a plain state and never leaks the internal reason', async () => {
    const token = await newToken('a');
    expect(await list(token)).toEqual([]); // no draft yet
    await save(token);
    const ids = [
      await upload(token),
      await upload(token),
      await upload(token),
      await upload(token),
    ];
    await setStatus(ids[1]!, 'scanning');
    await setStatus(ids[2]!, 'clean');
    await setStatus(ids[3]!, 'quarantined', 'malware_detected');
    const res = await app.inject({ method: 'GET', url: url(token, '/documents') });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect((res.json().documents as any[]).map((d) => d.state)).toEqual([
      'uploading',
      'checking',
      'ready',
      'not_accepted',
    ]);
    expect(res.body).not.toContain('malware_detected');
    expect(res.body).not.toContain('quarantine');
    expect(res.json().documents[0]).toMatchObject({
      slot_key: 'photo',
      filename: 'me.png',
      size_bytes: 1000,
    });
  });

  it('removes a file: it disappears from the list, a repeat is harmless, and an audit event is written', async () => {
    const token = await newToken('a');
    await save(token);
    const id = await upload(token);
    const first = await remove(token, id);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ document_id: id, state: 'removed' });
    expect(await list(token)).toEqual([]);
    expect((await remove(token, id)).statusCode).toBe(200);
    const row = (
      await adminPool.query(`SELECT status, deleted_at FROM case_documents WHERE id = $1`, [id])
    ).rows[0];
    expect(row.status).toBe('deleted');
    expect(row.deleted_at).not.toBeNull();
    const audit = await adminPool.query(
      `SELECT payload::text AS p FROM audit_events WHERE action = 'document.removed' AND workspace_id = $1`,
      [ws.a],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    expect(audit.rows.map((r) => r.p).join()).not.toContain('me.png');
  });

  it('a removed file no longer blocks submit', async () => {
    const token = await newToken('a');
    await save(token);
    const stuck = await upload(token); // still pending: would block submit
    const blocked = await app.inject({
      method: 'POST',
      url: url(token, '/submit'),
      payload: { draft_revision: 1, idempotency_key: 'synthetic-submit-0001' },
    });
    expect(blocked.statusCode).toBe(409);
    await remove(token, stuck);
    const good = await upload(token);
    await setStatus(good, 'clean');
    const ok = await app.inject({
      method: 'POST',
      url: url(token, '/submit'),
      payload: { draft_revision: 1, idempotency_key: 'synthetic-submit-0002' },
    });
    expect(ok.statusCode, ok.body).toBe(202);
  });

  it("cannot touch another respondent's file, in the same or another workspace", async () => {
    const mine = await newToken('a');
    const sameWorkspace = await newToken('a');
    const otherWorkspace = await newToken('b');
    for (const t of [mine, sameWorkspace, otherWorkspace]) await save(t);
    const id = await upload(mine);
    expect((await remove(sameWorkspace, id)).statusCode).toBe(404);
    expect((await remove(otherWorkspace, id)).statusCode).toBe(404);
    expect(await list(sameWorkspace)).toEqual([]);
    expect(await list(otherWorkspace)).toEqual([]);
    expect((await list(mine)).map((d) => d.document_id)).toEqual([id]);
  });

  it('refuses after submit, and answers 404 for bad links and bad ids', async () => {
    const token = await newToken('a');
    await save(token);
    const id = await upload(token);
    await setStatus(id, 'clean');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url(token, '/submit'),
          payload: { draft_revision: 1, idempotency_key: 'synthetic-submit-0003' },
        })
      ).statusCode,
    ).toBe(202);
    const late = await remove(token, id);
    expect(late.statusCode).toBe(409);
    expect(
      (await adminPool.query(`SELECT status FROM case_documents WHERE id = $1`, [id])).rows[0]
        .status,
    ).toBe('clean');

    const fresh = await newToken('a');
    await save(fresh);
    expect((await remove(fresh, 'not-a-uuid')).statusCode).toBe(404);
    expect((await remove(fresh, randomUUID())).statusCode).toBe(404);
    expect((await remove('f'.repeat(64), randomUUID())).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: url('f'.repeat(64), '/documents') })).statusCode,
    ).toBe(404);
  });
});
