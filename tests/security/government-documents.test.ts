import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/index.js';
import type { UploadSigner } from '../../apps/api/src/services/object-store.js';
import { issueRespondentToken } from '../../apps/api/src/services/respondent-tokens.js';
import { decryptValue, staticKeyProvider } from '../../packages/crypto/src/index.js';
import { storeSensitiveValue } from '../../apps/api/src/services/sensitive-values.js';
import { DOC_SUBTYPES } from '../../packages/contracts/src/index.js';
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

const name = {
  field_key: 'full_name',
  label: 'Full name',
  field_type: 'text',
  required: true,
  sensitivity: 'internal',
};
const slot = (
  key: string,
  doc_subtype: string,
  doc_class: string,
  label = key,
  required = false,
) => ({
  key,
  label,
  required,
  allowed_mime_types: ['image/png', 'application/pdf'],
  max_size_bytes: 1_000_000,
  doc_class,
  doc_subtype,
});
const mainDefinition = {
  fields: [name],
  slots: [
    slot('aadhaar_masked', 'aadhaar', 'identity', 'Aadhaar (masked copy)'),
    slot('pan_card', 'pan', 'identity', 'PAN card'),
    slot('licence', 'driving_licence', 'identity', 'Driving licence'),
    slot('passport_scan', 'passport', 'identity', 'Passport'),
    slot('profile_photo', 'photo', 'photo', 'Photo'),
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

async function seedWorkspace(id: string, label: string) {
  await adminPool.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $3)`, [
    id,
    `${fixture}-${label}`,
    `Synthetic ${label}`,
  ]);
}
async function seedForm(workspaceId: string, definition: unknown): Promise<string> {
  const templateId = randomUUID();
  const versionId = randomUUID();
  await adminPool.query(
    `INSERT INTO form_templates (id, workspace_id, key, name) VALUES ($1, $2, $3, 'Synthetic form')`,
    [templateId, workspaceId, `form-${randomUUID().slice(0, 8)}`],
  );
  await adminPool.query(
    `INSERT INTO form_template_versions (id, workspace_id, template_id, version_number, status, schema_json, schema_sha256, privacy_notice_version, published_at)
     VALUES ($1, $2, $3, 1, 'published', $4::jsonb, decode(repeat('ab', 32), 'hex'), $5, now())`,
    [versionId, workspaceId, templateId, JSON.stringify(definition), NOTICE],
  );
  return versionId;
}
const policy = (
  workspaceId: string,
  subtype: string,
  mode: string,
  masked = false,
  purpose = 'Synthetic lawful purpose for tests',
) =>
  adminPool.query(
    `INSERT INTO document_type_policies (workspace_id, doc_subtype, collect_mode, require_masked, purpose)
     VALUES ($1, $2, $3, $4, $5)`,
    [workspaceId, subtype, mode, masked, mode === 'not_collected' ? '' : purpose],
  );
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
const consent = { notice_version: NOTICE, accepted: true };
const save = (token: string) =>
  app.inject({
    method: 'PUT',
    url: `/public/v1/forms/${token}/draft`,
    payload: { draft_revision: 0, consent, values: { full_name: 'Synthetic Person' } },
  });
const getForm = (token: string) => app.inject({ method: 'GET', url: `/public/v1/forms/${token}` });
const upload = (token: string, slot_key: string, over: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: `/public/v1/forms/${token}/upload-requests`,
    payload: {
      idempotency_key: 'synthetic-key-' + randomUUID(),
      slot_key,
      filename: 'scan.png',
      mime_type: 'image/png',
      size_bytes: 1000,
      ...over,
    },
  });
const submit = (token: string) =>
  app.inject({
    method: 'POST',
    url: `/public/v1/forms/${token}/submit`,
    payload: { draft_revision: 1, idempotency_key: 'synthetic-submit-0001' },
  });
const tokenSql = `encode(t.token_hash,'hex') = encode(sha256($1::bytea),'hex')`;
const rowsOf = async (table: string, token: string) =>
  (
    await adminPool.query(
      `SELECT d.* FROM ${table} d JOIN respondent_tokens t ON t.case_id = d.case_id WHERE ${tokenSql} ORDER BY d.created_at`,
      [Buffer.from(token)],
    )
  ).rows;

let versionA = '';
let versionB = '';

beforeAll(async () => {
  await runMigrations(adminPool);
  await seedWorkspace(ws.a, 'a');
  await seedWorkspace(ws.b, 'b');
  versionA = await seedForm(ws.a, mainDefinition);
  versionB = await seedForm(ws.b, mainDefinition); // same form, but this workspace set no policies
  await adminPool.query(
    `INSERT INTO routing_policies (workspace_id, policy_version, status, activated_at) VALUES ($1, 'synthetic-policy-v1', 'active', now())`,
    [ws.a],
  );
  await policy(
    ws.a,
    'aadhaar',
    'optional',
    true,
    'Statutory identity onboarding (masked copy only)',
  );
  await policy(ws.a, 'pan', 'required', false, 'PAN is needed for tax deduction at source');
  await policy(ws.a, 'driving_licence', 'not_collected');
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

describe('Government Documents Policy (3.5)', () => {
  it('asks only for document types the workspace collects, with the stated purpose', async () => {
    const token = await newToken(ws.a, versionA);
    const res = await getForm(token);
    expect(res.statusCode).toBe(200);
    const slots = res.json().form.slots as Array<{ key: string; policy?: Record<string, unknown> }>;
    expect(slots.map((s) => s.key).sort()).toEqual(['aadhaar_masked', 'pan_card', 'profile_photo']);
    const aadhaar = slots.find((s) => s.key === 'aadhaar_masked')!;
    expect(aadhaar.policy).toMatchObject({
      collect_mode: 'optional',
      require_masked: true,
      purpose: 'Statutory identity onboarding (masked copy only)',
      retain_days: null,
    });
    expect(slots.find((s) => s.key === 'profile_photo')!.policy).toBeUndefined();
  });

  it('fails closed: a workspace with no policy is not asked for any government document', async () => {
    const token = await newToken(ws.b, versionB);
    const slots = (await getForm(token)).json().form.slots as Array<{ key: string }>;
    expect(slots.map((s) => s.key)).toEqual(['profile_photo']);
    await save(token);
    for (const key of ['aadhaar_masked', 'pan_card', 'licence', 'passport_scan']) {
      const res = await upload(token, key, { masked_copy_confirmed: true });
      expect(res.statusCode, key).toBe(422);
      expect(res.json().errors[0].code).toBe('document_type_not_collected');
    }
    expect(await rowsOf('case_documents', token)).toHaveLength(0);
  });

  it('refuses a type the workspace switched off, and a type with no policy row', async () => {
    const token = await newToken(ws.a, versionA);
    await save(token);
    for (const key of ['licence', 'passport_scan']) {
      const res = await upload(token, key);
      expect(res.statusCode, key).toBe(422);
      expect(res.json().errors[0].code).toBe('document_type_not_collected');
    }
  });

  it('accepts only a confirmed masked copy for Aadhaar, and files it as highly sensitive', async () => {
    const token = await newToken(ws.a, versionA);
    await save(token);
    const none = await upload(token, 'aadhaar_masked');
    expect(none.statusCode).toBe(422);
    expect(none.json().errors[0].code).toBe('masked_copy_required');
    const no = await upload(token, 'aadhaar_masked', { masked_copy_confirmed: false });
    expect(no.statusCode).toBe(422);
    expect(await rowsOf('case_documents', token)).toHaveLength(0);

    const ok = await upload(token, 'aadhaar_masked', { masked_copy_confirmed: true });
    expect(ok.statusCode).toBe(201);
    const [doc] = await rowsOf('case_documents', token);
    expect(doc).toMatchObject({
      doc_subtype: 'aadhaar',
      sensitivity: 'highly_sensitive',
      doc_class: 'identity',
    });
  });

  it('files other collected types with the catalog sensitivity; no confirmation needed', async () => {
    const token = await newToken(ws.a, versionA);
    await save(token);
    expect((await upload(token, 'pan_card')).statusCode).toBe(201);
    expect((await upload(token, 'profile_photo')).statusCode).toBe(201);
    const docs = await rowsOf('case_documents', token);
    expect(docs.map((d) => [d.doc_subtype, d.sensitivity])).toEqual([
      ['pan', 'highly_sensitive'],
      ['photo', 'sensitive'],
    ]);
  });

  it('cannot express caste, community or police documents: such a form is never shown or accepted', async () => {
    const definition = {
      fields: [name],
      slots: [slot('police_check', 'police_verification', 'other', 'Police verification')],
    };
    const version = await seedForm(ws.a, definition);
    const token = await newToken(ws.a, version);
    expect((await getForm(token)).statusCode).toBe(404);
    expect((await upload(token, 'police_check')).statusCode).toBe(404);
    expect(DOC_SUBTYPES).not.toHaveProperty('caste_community_certificate');
    expect(DOC_SUBTYPES).not.toHaveProperty('police_verification');
  });

  it('does not require a slot the workspace does not collect', async () => {
    const version = await seedForm(ws.a, {
      fields: [name],
      slots: [slot('passport_scan', 'passport', 'identity', 'Passport', true)],
    });
    const token = await newToken(ws.a, version);
    await save(token);
    expect((await submit(token)).statusCode).toBe(202);
  });

  it('never creates an AI job for a special-category document, even if one exists', async () => {
    await policy(
      ws.a,
      'police_verification',
      'optional',
      false,
      'Synthetic documented need for tests',
    );
    const token = await newToken(ws.a, versionA);
    await save(token);
    const pan = await upload(token, 'pan_card');
    const { rows } = await adminPool.query(`SELECT case_id FROM case_documents WHERE id = $1`, [
      pan.json().document_id,
    ]);
    const caseId = rows[0].case_id;
    await adminPool.query(
      `UPDATE case_documents SET status = 'clean', sha256 = decode(repeat('cd', 32), 'hex') WHERE id = $1`,
      [pan.json().document_id],
    );
    // A police-verification file placed directly in the database (the form cannot create one).
    const police = randomUUID();
    await adminPool.query(
      `INSERT INTO case_documents (id, workspace_id, case_id, bucket, object_key, mime_type, size_bytes, sha256,
          doc_class, doc_subtype, sensitivity, status, slot_key)
       VALUES ($1, $2, $3, 'docs', $4, 'image/png', 1000, decode(repeat('ef', 32), 'hex'),
          'other', 'police_verification', 'highly_sensitive', 'clean', 'pan_card')`,
      [police, ws.a, caseId, `ws/${ws.a}/cases/${caseId}/${police}`],
    );
    const res = await submit(token);
    expect(res.statusCode).toBe(202);
    const jobs = await adminPool.query(`SELECT document_id FROM ai_jobs WHERE case_id = $1`, [
      caseId,
    ]);
    expect(jobs.rows.map((r) => r.document_id)).toEqual([pan.json().document_id]);
  });

  it('matches the database catalog (permitted types, classes, sensitivity)', async () => {
    const { rows } = await adminPool.query(
      `SELECT key, doc_class, government_issued, default_sensitivity FROM document_subtypes ORDER BY key`,
    );
    const db = new Map(rows.map((r) => [r.key, r]));
    for (const [key, meta] of Object.entries(DOC_SUBTYPES)) {
      expect(db.get(key), key).toMatchObject(meta);
    }
    const missing = [...db.keys()].filter((k) => !(k in DOC_SUBTYPES)).sort();
    expect(missing).toEqual(['caste_community_certificate', 'police_verification', 'unknown']);
  });
});

describe('highly sensitive values are stored as ciphertext (3.5b)', () => {
  it('writes ciphertext + key id + last-four preview, and no plaintext anywhere in the row', async () => {
    const provider = staticKeyProvider({ k1: randomBytes(32) }, 'k1');
    const SECRET = 'SYNTH-9999-8888-7777';
    const token = await newToken(ws.a, versionA);
    await save(token);
    const [{ case_id: caseId }] = (
      await adminPool.query(`SELECT case_id FROM respondent_tokens t WHERE ${tokenSql}`, [
        Buffer.from(token),
      ])
    ).rows;
    await withTenant(appPool, ws.a, null, (client) =>
      storeSensitiveValue(client, provider, {
        workspaceId: ws.a,
        caseId,
        fieldKey: 'extracted_id',
        revision: 5,
        plaintext: SECRET,
        source: 'system',
      }),
    );
    const { rows } = await adminPool.query(
      `SELECT value_json, value_ciphertext, key_id, masked_preview, to_jsonb(v)::text AS whole
         FROM case_values v WHERE case_id = $1 AND field_key = 'extracted_id'`,
      [caseId],
    );
    expect(rows[0]).toMatchObject({ value_json: null, key_id: 'k1', masked_preview: '••••7777' });
    expect(rows[0].whole).not.toContain('SYNTH');
    expect(rows[0].value_ciphertext.toString('latin1')).not.toContain('SYNTH');
    expect(
      decryptValue(
        provider,
        'k1',
        { workspaceId: ws.a, caseId, fieldKey: 'extracted_id', revision: 5 },
        rows[0].value_ciphertext,
      ),
    ).toBe(SECRET);
  });
});
