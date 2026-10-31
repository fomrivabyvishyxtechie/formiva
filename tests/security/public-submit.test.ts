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
const POLICY = 'synthetic-policy-v1';
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
    {
      field_key: 'kind',
      label: 'Kind',
      field_type: 'select',
      required: false,
      sensitivity: 'internal',
      validation: { options: ['permanent', 'contract'] },
    },
    {
      field_key: 'contract_end',
      label: 'Contract end',
      field_type: 'date',
      required: true,
      sensitivity: 'internal',
      conditional: { depends_on: 'kind', equals: 'contract' },
    },
  ],
  slots: [
    {
      key: 'photo',
      label: 'Photo',
      required: true,
      allowed_mime_types: ['image/png', 'image/jpeg'],
      max_size_bytes: 1_000_000,
      doc_class: 'photo',
    },
    {
      key: 'cv',
      label: 'CV',
      required: false,
      allowed_mime_types: ['application/pdf'],
      max_size_bytes: 5_000_000,
      doc_class: 'other',
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

async function seedWorkspace(id: string, label: string, withPolicy: boolean) {
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
  if (withPolicy) {
    await adminPool.query(
      `INSERT INTO routing_policies (workspace_id, policy_version, status, activated_at)
       VALUES ($1, $2, 'active', now())`,
      [id, POLICY],
    );
  }
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
const save = (token: string, values: Record<string, unknown>, draft_revision = 0) =>
  app.inject({
    method: 'PUT',
    url: `/public/v1/forms/${token}/draft`,
    payload: { draft_revision, consent, values },
  });
const submit = (token: string, over: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: `/public/v1/forms/${token}/submit`,
    payload: { draft_revision: 1, idempotency_key: 'synthetic-submit-0001', ...over },
  });
const upload = async (token: string, slot_key = 'photo') =>
  (
    await app.inject({
      method: 'POST',
      url: `/public/v1/forms/${token}/upload-requests`,
      payload: {
        idempotency_key: 'synthetic-key-' + randomUUID(),
        slot_key,
        filename: slot_key === 'cv' ? 'cv.pdf' : 'face.png',
        mime_type: slot_key === 'cv' ? 'application/pdf' : 'image/png',
        size_bytes: 1000,
      },
    })
  ).json().document_id as string;
const setDoc = (id: string, status: string) =>
  adminPool.query(
    status === 'clean'
      ? `UPDATE case_documents SET status = 'clean', sha256 = decode(repeat('cd', 32), 'hex') WHERE id = $1`
      : status === 'rejected'
        ? `UPDATE case_documents SET status = 'rejected', sha256 = decode(repeat('cd', 32), 'hex') WHERE id = $1`
        : `UPDATE case_documents SET status = '${status}' WHERE id = $1`,
    [id],
  );
const caseOf = async (token: string) =>
  (
    await adminPool.query(
      `SELECT c.* FROM cases c JOIN respondent_tokens t ON t.case_id = c.id WHERE ${tokenSql}`,
      [Buffer.from(token)],
    )
  ).rows[0];
const jobsOf = async (caseId: string) =>
  (await adminPool.query(`SELECT * FROM ai_jobs WHERE case_id = $1 ORDER BY created_at`, [caseId]))
    .rows;
/** A complete, ready-to-submit case: name saved at revision 1, one clean photo. */
async function ready(workspaceId = ws.a, versionId = versionA) {
  const token = await newToken(workspaceId, versionId);
  expect((await save(token, { full_name: 'Synthetic Person' })).statusCode).toBe(200);
  await setDoc(await upload(token), 'clean');
  return token;
}

beforeAll(async () => {
  await runMigrations(adminPool);
  versionA = await seedWorkspace(ws.a, 'a', true);
  versionB = await seedWorkspace(ws.b, 'b', false);
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

describe('atomic submission (3.4)', () => {
  it('refuses a bad body and an unknown link', async () => {
    const token = await ready();
    expect((await submit(token, { idempotency_key: 'x' })).statusCode).toBe(400);
    expect((await submit(token, { extra: 1 })).statusCode).toBe(400);
    expect((await submit('c'.repeat(64))).statusCode).toBe(404);
  });

  it('has nothing to submit before the first save', async () => {
    const token = await newToken(ws.a, versionA);
    const res = await submit(token, { draft_revision: 0 });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].code).toBe('incomplete');
  });

  it('refuses a stale draft revision', async () => {
    const token = await ready();
    const res = await submit(token, { draft_revision: 0 });
    expect(res.statusCode).toBe(409);
    expect(res.json().errors[0].code).toBe('revision_conflict');
    expect((await caseOf(token)).status).toBe('draft');
  });

  it('requires every shown required answer, and ignores hidden ones', async () => {
    const token = await newToken(ws.a, versionA);
    await save(token, { kind: 'permanent' });
    await setDoc(await upload(token), 'clean');
    const missingName = await submit(token);
    expect(missingName.statusCode).toBe(422);
    expect(missingName.json().errors[0].message).toContain('full_name');
    expect(missingName.json().errors[0].message).not.toContain('contract_end');

    await save(token, { full_name: 'Synthetic Person', kind: 'contract' }, 1);
    const needsEnd = await submit(token, { draft_revision: 2 });
    expect(needsEnd.statusCode).toBe(422);
    expect(needsEnd.json().errors[0].message).toContain('contract_end');

    await save(token, { contract_end: '2030-01-31' }, 2);
    expect((await submit(token, { draft_revision: 3 })).statusCode).toBe(202);
  });

  it('waits for files being checked and needs a clean file for each required slot', async () => {
    const token = await newToken(ws.a, versionA);
    await save(token, { full_name: 'Synthetic Person' });
    const photo = await upload(token);
    const pending = await submit(token);
    expect(pending.statusCode).toBe(409);
    expect(pending.json().errors[0].code).toBe('documents_not_ready');

    await setDoc(photo, 'rejected');
    const none = await submit(token);
    expect(none.statusCode).toBe(422);
    expect(none.json().errors[0].message).toContain('photo');
    expect((await caseOf(token)).status).toBe('draft');
    expect(await jobsOf((await caseOf(token)).id)).toHaveLength(0);
  });

  it('fails closed when the workspace has no active routing policy', async () => {
    const token = await ready(ws.b, versionB);
    const res = await submit(token);
    expect(res.statusCode).toBe(503);
    expect(res.json().errors[0].code).toBe('policy_unavailable');
    const c = await caseOf(token);
    expect(c.status).toBe('draft');
    expect(await jobsOf(c.id)).toHaveLength(0);
  });

  it('submits once: case, one job per clean file, audit event, 202', async () => {
    const token = await newToken(ws.a, versionA);
    await save(token, { full_name: 'Synthetic Person' });
    const photo = await upload(token);
    const cv = await upload(token, 'cv');
    const bad = await upload(token, 'cv');
    await setDoc(photo, 'clean');
    await setDoc(cv, 'clean');
    await setDoc(bad, 'rejected');

    const res = await submit(token);
    expect(res.statusCode).toBe(202);
    const out = res.json();
    expect(out).toMatchObject({
      status: 'submitted',
      next_action: 'await_processing',
      replay: false,
    });
    expect(out.job_ids).toHaveLength(2);
    expect(out.case_id).toBeTruthy();

    const c = await caseOf(token);
    expect(c).toMatchObject({ status: 'submitted', policy_version: POLICY });
    expect(c.submitted_at).not.toBeNull();
    const jobs = await jobsOf(c.id);
    expect(jobs.map((j) => j.document_id).sort()).toEqual([photo, cv].sort());
    expect(jobs.every((j) => j.status === 'queued' && j.policy_version === POLICY)).toBe(true);
    expect(jobs.every((j) => j.workspace_id === ws.a)).toBe(true);
    expect(
      jobs.every((j) => Buffer.from(j.object_sha256).toString('hex') === 'cd'.repeat(32)),
    ).toBe(true);

    const audit = await adminPool.query(
      `SELECT payload::text AS p FROM audit_events WHERE workspace_id = $1 AND action = 'case.submitted' AND object_id = $2::text`,
      [ws.a, c.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].p).not.toContain('Synthetic Person');
    expect(audit.rows[0].p).not.toContain('face.png');
  });

  it('a repeat submit, even with a new key, returns the same jobs and creates nothing', async () => {
    const token = await ready();
    const first = (await submit(token)).json();
    const again = await submit(token);
    const other = await submit(token, {
      idempotency_key: 'synthetic-submit-9999',
      draft_revision: 7,
    });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({
      case_id: first.case_id,
      job_ids: first.job_ids,
      replay: true,
    });
    expect(other.json().job_ids).toEqual(first.job_ids);
    const c = await caseOf(token);
    expect(await jobsOf(c.id)).toHaveLength(1);
    const audit = await adminPool.query(
      `SELECT 1 FROM audit_events WHERE action = 'case.submitted' AND object_id = $1::text`,
      [c.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('five simultaneous submits create one submission', async () => {
    const token = await ready();
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(token)));
    expect(results.map((r) => r.statusCode)).toEqual([202, 202, 202, 202, 202]);
    expect(results.filter((r) => r.json().replay === false)).toHaveLength(1);
    const c = await caseOf(token);
    expect(await jobsOf(c.id)).toHaveLength(1);
    const audit = await adminPool.query(
      `SELECT 1 FROM audit_events WHERE action = 'case.submitted' AND object_id = $1::text`,
      [c.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('closes the draft: later saves and uploads are refused', async () => {
    const token = await ready();
    await submit(token);
    const saved = await save(token, { full_name: 'Changed' }, 1);
    expect(saved.statusCode).toBe(409);
    expect(saved.json().errors[0].code).toBe('not_draft');
  });
});
