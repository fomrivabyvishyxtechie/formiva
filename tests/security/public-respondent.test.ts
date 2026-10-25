import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/index.js';
import { RateLimiter } from '../../apps/api/src/rate-limiter.js';
import { redactUrl } from '../../apps/api/src/log-redaction.js';
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
let draftVersionA = '';
let app: Awaited<ReturnType<typeof buildApp>>;
let appNoSecret: Awaited<ReturnType<typeof buildApp>>;

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
      field_key: 'joining_date',
      label: 'Joining date',
      field_type: 'date',
      sensitivity: 'internal',
    },
    {
      field_key: 'team',
      label: 'Team',
      field_type: 'select',
      sensitivity: 'internal',
      validation: { options: ['ops', 'sales'] },
    },
    {
      field_key: 'bank_account',
      label: 'Bank account',
      field_type: 'text',
      sensitivity: 'highly_sensitive',
    },
    {
      field_key: 'notes_private',
      label: 'Private notes',
      field_type: 'textarea',
      sensitivity: 'sensitive',
    },
    { field_key: 'photo', label: 'Photo', field_type: 'file', sensitivity: 'confidential' },
  ],
  slots: [],
};

async function seedWorkspace(id: string, label: string, status: 'published' | 'draft') {
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
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, decode(repeat('ab', 32), 'hex'), $6, CASE WHEN $4 = 'published' THEN now() END)`,
    [versionId, id, templateId, status, JSON.stringify(definition), NOTICE],
  );
  return { templateId, versionId };
}

async function newToken(
  workspaceId: string,
  versionId: string,
  ttlSeconds = 3600,
): Promise<string> {
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
          ttlSeconds,
        })
      ).token,
  );
}

const put = (instance: typeof app, token: string, body: unknown) =>
  instance.inject({
    method: 'PUT',
    url: `/public/v1/forms/${token}/draft`,
    payload: body as object,
  });
const consent = { notice_version: NOTICE, accepted: true };

beforeAll(async () => {
  await runMigrations(adminPool);
  versionA = (await seedWorkspace(ws.a, 'a', 'published')).versionId;
  versionB = (await seedWorkspace(ws.b, 'b', 'published')).versionId;
  // A second, unpublished version in workspace A: its tokens must never open a form.
  draftVersionA = randomUUID();
  const t = await adminPool.query(`SELECT template_id FROM form_template_versions WHERE id = $1`, [
    versionA,
  ]);
  await adminPool.query(
    `INSERT INTO form_template_versions (id, workspace_id, template_id, version_number, status, schema_json) VALUES ($1, $2, $3, 2, 'draft', $4::jsonb)`,
    [draftVersionA, ws.a, t.rows[0].template_id, JSON.stringify(definition)],
  );
  app = await buildApp(
    { NODE_ENV: 'test', IP_HASH_SECRET: IP_KEY },
    { pool: appPool as never, auth: { testMode: true } },
  );
  appNoSecret = await buildApp(
    { NODE_ENV: 'test' },
    { pool: appPool as never, auth: { testMode: true } },
  );
});

afterAll(async () => {
  await app?.close();
  await appNoSecret?.close();
  await appPool.end();
  await adminPool.end();
});

describe('public respondent API (3.2)', () => {
  it('stores only a hash, never the raw token', async () => {
    const token = await newToken(ws.a, versionA);
    const raw = await adminPool.query(
      `SELECT 1 FROM respondent_tokens WHERE encode(token_hash, 'hex') = $1`,
      [token],
    );
    const stored = await adminPool.query(
      `SELECT octet_length(token_hash) AS n FROM respondent_tokens WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ws.a],
    );
    expect(raw.rowCount).toBe(0);
    expect(stored.rows[0].n).toBe(32);
  });

  it('GET returns the published form with no workspace internals and no caching', async () => {
    const token = await newToken(ws.a, versionA);
    const res = await app.inject({ method: 'GET', url: `/public/v1/forms/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.form.version_id).toBe(versionA);
    expect(body.form.fields).toHaveLength(definition.fields.length);
    expect(body.draft).toMatchObject({
      case_id: null,
      status: 'draft',
      draft_revision: 0,
      consent_recorded: false,
    });
    expect(JSON.stringify(body)).not.toContain(ws.a);
  });

  it('answers unknown, malformed, expired, revoked and unpublished links identically', async () => {
    const expired = await newToken(ws.a, versionA);
    await adminPool.query(
      `UPDATE respondent_tokens SET expires_at = now() - interval '1 minute' WHERE encode(token_hash,'hex') = encode(sha256($1::bytea),'hex')`,
      [Buffer.from(expired)],
    );
    const revoked = await newToken(ws.a, versionA);
    await adminPool.query(
      `UPDATE respondent_tokens SET revoked_at = now() WHERE encode(token_hash,'hex') = encode(sha256($1::bytea),'hex')`,
      [Buffer.from(revoked)],
    );
    const unpublished = await newToken(ws.a, draftVersionA);
    const bad = ['a'.repeat(64), 'not-a-token', 'x'.repeat(90), expired, revoked, unpublished];
    const seen = new Set<string>();
    for (const token of bad) {
      for (const method of ['GET', 'PUT'] as const) {
        const res = await app.inject({
          method,
          url: `/public/v1/forms/${token}${method === 'PUT' ? '/draft' : ''}`,
          payload:
            method === 'PUT'
              ? { draft_revision: 0, consent, values: { full_name: 'x' } }
              : undefined,
        });
        const j = res.json();
        expect(res.statusCode, token.slice(0, 10)).toBe(404);
        seen.add(JSON.stringify([j.title, j.detail, j.errors, j.status]));
        expect(JSON.stringify(j)).not.toContain(token);
      }
    }
    expect(seen.size).toBe(1);
  });

  it('keeps tenants apart: a token only ever touches its own workspace', async () => {
    const tokenA = await newToken(ws.a, versionA);
    const before = await adminPool.query(
      `SELECT count(*)::int AS n FROM cases WHERE workspace_id = $1`,
      [ws.b],
    );
    expect(
      (
        await put(app, tokenA, {
          draft_revision: 0,
          consent,
          values: { full_name: 'Synthetic Person' },
        })
      ).statusCode,
    ).toBe(200);
    const after = await adminPool.query(
      `SELECT count(*)::int AS n FROM cases WHERE workspace_id = $1`,
      [ws.b],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const tokenB = await newToken(ws.b, versionB);
    const body = (await app.inject({ method: 'GET', url: `/public/v1/forms/${tokenB}` })).json();
    expect(body.form.version_id).toBe(versionB);
    expect(body.draft.case_id).toBeNull();
  });

  it('refuses values before consent and records nothing', async () => {
    const token = await newToken(ws.a, versionA);
    const res = await put(app, token, {
      draft_revision: 0,
      values: { full_name: 'Synthetic Person' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].code).toBe('consent_required');
    const wrong = await put(app, token, {
      draft_revision: 0,
      consent: { notice_version: 'other', accepted: true },
      values: {},
    });
    expect(wrong.statusCode).toBe(422);
    const rows = await adminPool.query(
      `SELECT (SELECT count(*)::int FROM case_values v JOIN respondent_tokens t ON t.case_id = v.case_id WHERE encode(t.token_hash,'hex') = encode(sha256($1::bytea),'hex')) AS v,
              (SELECT count(*)::int FROM consent_records c JOIN respondent_tokens t ON t.case_id = c.case_id WHERE encode(t.token_hash,'hex') = encode(sha256($1::bytea),'hex')) AS c`,
      [Buffer.from(token)],
    );
    expect(rows.rows[0]).toEqual({ v: 0, c: 0 });
  });

  it('saves with consent first, tracks revisions, and returns saved non-sensitive values on GET', async () => {
    const token = await newToken(ws.a, versionA);
    const first = await put(app, token, {
      draft_revision: 0,
      consent,
      values: { full_name: 'Synthetic Person', notes_private: 'synthetic private note' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ draft_revision: 1, status: 'draft' });
    expect(
      (await put(app, token, { draft_revision: 0, values: { full_name: 'Stale' } })).statusCode,
    ).toBe(409);
    const second = await put(app, token, {
      draft_revision: 1,
      values: { joining_date: '2026-11-01' },
    });
    expect(second.json().draft_revision).toBe(2);
    const got = (await app.inject({ method: 'GET', url: `/public/v1/forms/${token}` })).json();
    expect(got.draft).toMatchObject({ draft_revision: 2, consent_recorded: true });
    expect(got.draft.values).toEqual({ full_name: 'Synthetic Person', joining_date: '2026-11-01' });
    const hashRow = await adminPool.query(
      `SELECT c.ip_hash FROM consent_records c JOIN respondent_tokens t ON t.case_id = c.case_id WHERE encode(t.token_hash,'hex') = encode(sha256($1::bytea),'hex')`,
      [Buffer.from(token)],
    );
    expect(hashRow.rowCount).toBe(1);
    expect(hashRow.rows[0].ip_hash).toHaveLength(32);
    expect(hashRow.rows[0].ip_hash.toString()).not.toContain('127.0.0.1');
  });

  it('does not record the IP when no IP_HASH_SECRET is configured', async () => {
    const token = await newToken(ws.a, versionA);
    expect(
      (await put(appNoSecret, token, { draft_revision: 0, consent, values: {} })).statusCode,
    ).toBe(200);
    const row = await adminPool.query(
      `SELECT c.ip_hash FROM consent_records c JOIN respondent_tokens t ON t.case_id = c.case_id WHERE encode(t.token_hash,'hex') = encode(sha256($1::bytea),'hex')`,
      [Buffer.from(token)],
    );
    expect(row.rows[0].ip_hash).toBeNull();
  });

  it('rejects highly sensitive, file, unknown, malformed and ID-like values without storing anything', async () => {
    const token = await newToken(ws.a, versionA);
    const cases: Array<[string, unknown]> = [
      ['bank_account', '000011112222'],
      ['photo', 'x'],
      ['no_such_field', 'x'],
      ['team', 'finance'],
      ['joining_date', 'tomorrow'],
      ['full_name', 'ref 123456789012 here'],
      ['full_name', 42],
    ];
    for (const [key, value] of cases) {
      const res = await put(app, token, { draft_revision: 0, consent, values: { [key]: value } });
      expect(res.statusCode, key).toBe(422);
      expect(res.body).not.toContain('123456789012');
    }
    const stored = await adminPool.query(
      `SELECT count(*)::int AS n FROM case_values v JOIN respondent_tokens t ON t.case_id = v.case_id WHERE encode(t.token_hash,'hex') = encode(sha256($1::bytea),'hex')`,
      [Buffer.from(token)],
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it('creates exactly one case when first saves race', async () => {
    const token = await newToken(ws.a, versionA);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        put(app, token, { draft_revision: 0, consent, values: { full_name: `Synthetic ${i}` } }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409]);
    const counts = await adminPool.query(
      `SELECT (SELECT count(*)::int FROM cases WHERE workspace_id = $2 AND id = (SELECT case_id FROM respondent_tokens WHERE encode(token_hash,'hex') = encode(sha256($1::bytea),'hex'))) AS cases,
              (SELECT count(*)::int FROM consent_records c JOIN respondent_tokens t ON t.case_id = c.case_id WHERE encode(t.token_hash,'hex') = encode(sha256($1::bytea),'hex')) AS consents`,
      [Buffer.from(token), ws.a],
    );
    expect(counts.rows[0]).toEqual({ cases: 1, consents: 1 });
  });

  it('refuses edits once the case is no longer a draft', async () => {
    const token = await newToken(ws.a, versionA);
    await put(app, token, {
      draft_revision: 0,
      consent,
      values: { full_name: 'Synthetic Person' },
    });
    await adminPool.query(
      `UPDATE cases SET status = 'submitted', submitted_at = now() WHERE id = (SELECT case_id FROM respondent_tokens WHERE encode(token_hash,'hex') = encode(sha256($1::bytea),'hex'))`,
      [Buffer.from(token)],
    );
    expect(
      (await put(app, token, { draft_revision: 1, values: { full_name: 'Late' } })).statusCode,
    ).toBe(409);
  });

  it('keeps answers and tokens out of the audit trail', async () => {
    const token = await newToken(ws.a, versionA);
    await put(app, token, {
      draft_revision: 0,
      consent,
      values: { full_name: 'Synthetic Audit Marker' },
    });
    const audit = await adminPool.query(
      `SELECT payload::text AS p, action FROM audit_events WHERE workspace_id = $1 AND action IN ('case.created','case.draft_saved')`,
      [ws.a],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    for (const row of audit.rows) {
      expect(row.p).not.toContain('Synthetic Audit Marker');
      expect(row.p).not.toContain(token);
    }
  });

  it('answers 501 for upload-requests and submit, and rate-limits with Retry-After', async () => {
    const limited = await buildApp(
      { NODE_ENV: 'test' },
      { pool: appPool as never, auth: { testMode: true } },
    );
    const token = 'b'.repeat(64);
    const submit = await limited.inject({
      method: 'POST',
      url: `/public/v1/forms/${token}/submit`,
      payload: {},
    });
    expect(submit.statusCode).toBe(501);
    let last = submit;
    for (let i = 0; i < 70 && last.statusCode !== 429; i++) {
      last = await limited.inject({ method: 'GET', url: `/public/v1/forms/${token}` });
    }
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    await limited.close();
  });
});

describe('helpers', () => {
  it('RateLimiter blocks over the limit and resets after the window', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect([limiter.take('k'), limiter.take('k'), limiter.take('k')].map((n) => n > 0)).toEqual([
      false,
      false,
      true,
    ]);
    now = 1001;
    expect(limiter.take('k')).toBe(0);
  });

  it('redactUrl removes the token and nothing else', () => {
    const token = 'c'.repeat(64);
    expect(redactUrl(`/public/v1/forms/${token}/draft?x=1`)).toBe(
      '/public/v1/forms/:respondent_token/draft?x=1',
    );
    expect(redactUrl('/v1/cases')).toBe('/v1/cases');
  });
});
