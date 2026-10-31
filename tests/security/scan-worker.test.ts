import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClamdScanner } from '../../apps/api/src/scanner/clamd.js';
import { DOCX_MIME } from '../../apps/api/src/scanner/content-checks.js';
import { processNextDocument, type ScanDeps } from '../../apps/api/src/scanner/process-document.js';
import {
  createMemoryStore,
  eicar,
  makeDocx,
  makeJpeg,
  makePdf,
  makePng,
  startFakeClamd,
} from '../../apps/api/test/support/scan-fixtures.js';
import { runMigrations } from '../../packages/db/src/index.js';

type Rows = { rows: any[]; rowCount: number };
const requireFromApi = createRequire(resolve(process.cwd(), 'apps/api/package.json'));
const { Pool } = requireFromApi('pg') as {
  Pool: new (o: { connectionString: string; max?: number }) => {
    on: (event: 'connect', cb: (c: { query: (q: string) => Promise<unknown> }) => void) => void;
    query: (q: string, v?: unknown[]) => Promise<Rows>;
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
  throw new Error('Refusing to run scanner tests outside the local formiva_test database');
}

const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
// The worker connects as formiva_worker: claim bypasses RLS, everything else stays under it.
const workerPool = new Pool({ connectionString: databaseUrl, max: 6 });
workerPool.on('connect', (c) => void c.query('SET ROLE formiva_worker'));

const QUAR = 'quarantine-test';
const DOCS = 'documents-test';
const fixture = randomUUID().slice(0, 8);
const ws = { a: randomUUID(), b: randomUUID() };
const store = createMemoryStore();
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
let deps: ScanDeps;
let caseA = '';
let caseB = '';

async function seedWorkspace(id: string, label: string): Promise<string> {
  const template = randomUUID();
  const version = randomUUID();
  const caseId = randomUUID();
  await adminPool.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $3)`, [
    id,
    `${fixture}-${label}`,
    `Synthetic ${label}`,
  ]);
  await adminPool.query(
    `INSERT INTO form_templates (id, workspace_id, key, name) VALUES ($1, $2, $3, 'Synthetic')`,
    [template, id, `scan-${label}-${fixture}`],
  );
  await adminPool.query(
    `INSERT INTO form_template_versions (id, workspace_id, template_id, version_number, status, schema_json, schema_sha256, published_at)
     VALUES ($1, $2, $3, 1, 'published', '{"fields":[],"slots":[]}', decode(repeat('ab', 32), 'hex'), now())`,
    [version, id, template],
  );
  await adminPool.query(
    `INSERT INTO cases (id, workspace_id, case_number, form_version_id, status) VALUES ($1, $2, 1, $3, 'draft')`,
    [caseId, id, version],
  );
  return caseId;
}

/** A pending document row, optionally with its uploaded object. */
async function addDocument(o: {
  workspace?: string;
  caseId?: string;
  mime: string;
  declaredSize?: number;
  body?: Buffer;
  ageHours?: number;
}): Promise<{ id: string; key: string }> {
  const workspace = o.workspace ?? ws.a;
  const caseId = o.caseId ?? (workspace === ws.a ? caseA : caseB);
  const id = randomUUID();
  const key = `ws/${workspace}/cases/${caseId}/${id}`;
  await adminPool.query(
    `INSERT INTO case_documents (id, workspace_id, case_id, bucket, object_key, original_filename, mime_type, size_bytes, doc_class, status, slot_key, created_at)
     VALUES ($1, $2, $3, $4, $5, 'synthetic.bin', $6, $7, 'other', 'pending_upload', 'cv', now() - make_interval(hours => $8))`,
    [
      id,
      workspace,
      caseId,
      QUAR,
      key,
      o.mime,
      o.declaredSize ?? o.body?.length ?? 1,
      o.ageHours ?? 0,
    ],
  );
  if (o.body) await store.put(QUAR, key, o.body, o.mime);
  return { id, key };
}
const doc = async (id: string) =>
  (await adminPool.query(`SELECT * FROM case_documents WHERE id = $1`, [id])).rows[0];
const scans = async (id: string) =>
  (
    await adminPool.query(
      `SELECT scanner, result, details FROM document_scans WHERE document_id = $1 ORDER BY scanned_at, id`,
      [id],
    )
  ).rows;
/** Park everything except this document so tests do not pick up each other's leftovers. */
async function only(id: string) {
  await adminPool.query(
    `UPDATE case_documents SET next_scan_at = now() + interval '1 day' WHERE status IN ('pending_upload','uploaded') AND id <> $1`,
    [id],
  );
  await adminPool.query(
    `UPDATE case_documents SET next_scan_at = now() - interval '1 second' WHERE id = $1`,
    [id],
  );
}
const run = async (id: string) => {
  await only(id);
  return processNextDocument(deps);
};

beforeAll(async () => {
  await runMigrations(adminPool);
  caseA = await seedWorkspace(ws.a, 'a');
  caseB = await seedWorkspace(ws.b, 'b');
  clamd = await startFakeClamd();
  deps = {
    pool: workerPool as never,
    store,
    scanner: createClamdScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 2000 }),
    documentsBucket: DOCS,
  };
});
afterAll(async () => {
  await clamd?.close();
  await workerPool.end();
  await adminPool.end();
});

describe('scanner worker (3.3b)', () => {
  it('promotes a clean PNG: stripped bytes in the documents bucket, hash and evidence recorded, quarantine copy gone', async () => {
    const original = makePng({ metadata: true });
    const d = await addDocument({ mime: 'image/png', body: original });
    expect(await run(d.id)).toBe('clean');
    const row = await doc(d.id);
    expect(row).toMatchObject({ status: 'clean', bucket: DOCS, quarantine_reason: null });
    const stored = await store.get(DOCS, d.key, 1e6);
    expect(stored.includes('synthetic-gps-data')).toBe(false);
    expect(row.sha256.equals(createHash('sha256').update(stored).digest())).toBe(true);
    expect(Number(row.size_bytes)).toBe(stored.length);
    expect(store.has(QUAR, d.key)).toBe(false);
    const kinds = (await scans(d.id)).map((s) => s.scanner);
    expect(kinds).toEqual(expect.arrayContaining(['magic_sniff', 'image_limits', 'clamav']));
    const audit = await adminPool.query(
      `SELECT payload::text AS p FROM audit_events WHERE workspace_id = $1 AND object_id = $2`,
      [ws.a, d.id],
    );
    expect(audit.rows.map((r) => r.p).join()).toContain('"status": "clean"');
    expect(audit.rows.map((r) => r.p).join()).not.toContain('synthetic.bin');
  });

  it('promotes clean JPEG, PDF (with page count) and Word files', async () => {
    const jpeg = await addDocument({ mime: 'image/jpeg', body: makeJpeg({ metadata: true }) });
    const pdf = await addDocument({ mime: 'application/pdf', body: makePdf({ pages: 2 }) });
    const docx = await addDocument({ mime: DOCX_MIME, body: makeDocx() });
    for (const d of [jpeg, pdf, docx]) expect(await run(d.id)).toBe('clean');
    expect((await doc(pdf.id)).page_count).toBe(2);
    expect(store.has(DOCS, docx.key)).toBe(true);
  });

  it('quarantines EICAR (clamd FOUND) and never promotes it', async () => {
    const d = await addDocument({ mime: 'application/pdf', body: makePdf({ payload: eicar() }) });
    expect(await run(d.id)).toBe('quarantined');
    expect(await doc(d.id)).toMatchObject({
      status: 'quarantined',
      quarantine_reason: 'malware_detected',
    });
    expect(store.has(DOCS, d.key)).toBe(false);
    expect((await scans(d.id)).find((s) => s.scanner === 'clamav')).toMatchObject({
      result: 'infected',
    });
  });

  it('quarantines hostile files: renamed exe, fake PDF, huge image, PDF script, macro Word, zip bomb', async () => {
    const hostile: Array<[string, string, Buffer, string]> = [
      [
        'renamed exe as png',
        'image/png',
        Buffer.from('MZ\x90\x00 pretend executable'),
        'type_mismatch',
      ],
      [
        'fake pdf',
        'application/pdf',
        Buffer.from('this is plain text, not a pdf'),
        'type_mismatch',
      ],
      ['oversized image', 'image/png', makePng({ width: 30_000, height: 30_000 }), 'pixel_limit'],
      ['pdf with javascript', 'application/pdf', makePdf({ js: true }), 'pdf_active_content'],
      ['macro word file', DOCX_MIME, makeDocx([{ name: 'word/vbaProject.bin' }]), 'office_macros'],
      [
        'zip bomb as word',
        DOCX_MIME,
        makeDocx([{ name: 'bomb.xml', declaredSize: 80 * 1024 * 1024 }]),
        'decompression_ratio',
      ],
    ];
    for (const [label, mime, body, reason] of hostile) {
      const d = await addDocument({ mime, body });
      expect(await run(d.id), label).toBe('quarantined');
      expect(await doc(d.id), label).toMatchObject({
        status: 'quarantined',
        quarantine_reason: reason,
      });
      expect(store.has(DOCS, d.key), label).toBe(false);
    }
  });

  it('quarantines when the stored size differs from the signed size', async () => {
    const d = await addDocument({ mime: 'image/png', body: makePng(), declaredSize: 999 });
    expect(await run(d.id)).toBe('quarantined');
    expect((await doc(d.id)).quarantine_reason).toBe('size_mismatch');
  });

  it('waits for a file that has not arrived, then rejects it after 24 hours', async () => {
    const waiting = await addDocument({ mime: 'image/png' });
    expect(await run(waiting.id)).toBe('waiting');
    expect((await doc(waiting.id)).status).toBe('pending_upload');
    const stale = await addDocument({ mime: 'image/png', ageHours: 25 });
    expect(await run(stale.id)).toBe('rejected');
    expect(await doc(stale.id)).toMatchObject({
      status: 'rejected',
      quarantine_reason: 'upload_expired',
    });
  });

  it('never promotes while the scanner is down, retries, and quarantines after the last attempt', async () => {
    const down = await startFakeClamd();
    await down.close();
    const offline: ScanDeps = {
      ...deps,
      scanner: createClamdScanner({ host: '127.0.0.1', port: down.port, timeoutMs: 500 }),
    };
    const d = await addDocument({ mime: 'image/png', body: makePng() });
    await only(d.id);
    expect(await processNextDocument(offline)).toBe('retry');
    expect((await doc(d.id)).status).toBe('pending_upload');
    expect(store.has(DOCS, d.key)).toBe(false);
    await adminPool.query(`UPDATE case_documents SET scan_attempts = 7 WHERE id = $1`, [d.id]);
    await only(d.id);
    expect(await processNextDocument(offline)).toBe('quarantined');
    expect(await doc(d.id)).toMatchObject({
      status: 'quarantined',
      quarantine_reason: 'scan_unavailable',
    });
    expect(store.has(DOCS, d.key)).toBe(false);
  });

  it('claims each document once even with many workers at the same moment', async () => {
    await adminPool.query(
      `UPDATE case_documents SET next_scan_at = now() + interval '1 day' WHERE status IN ('pending_upload','uploaded')`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push((await addDocument({ mime: 'image/png', body: makePng() })).id);
    await adminPool.query(
      `UPDATE case_documents SET next_scan_at = now() - interval '1 second' WHERE id = ANY($1)`,
      [ids],
    );
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => processNextDocument(deps)));
    expect(outcomes.filter((o) => o === 'clean')).toHaveLength(4);
    expect(outcomes.filter((o) => o === 'idle')).toHaveLength(4);
    for (const id of ids)
      expect((await scans(id)).filter((s) => s.scanner === 'clamav')).toHaveLength(1);
  });

  it('keeps tenants apart: each document is decided inside its own workspace', async () => {
    const a = await addDocument({ workspace: ws.a, mime: 'image/png', body: makePng() });
    const b = await addDocument({
      workspace: ws.b,
      mime: 'image/png',
      body: makePng({ metadata: true }),
    });
    await adminPool.query(
      `UPDATE case_documents SET next_scan_at = now() + interval '1 day' WHERE status IN ('pending_upload','uploaded') AND id NOT IN ($1, $2)`,
      [a.id, b.id],
    );
    await adminPool.query(
      `UPDATE case_documents SET next_scan_at = now() - interval '1 second' WHERE id IN ($1, $2)`,
      [a.id, b.id],
    );
    await Promise.all([processNextDocument(deps), processNextDocument(deps)]);
    for (const [d, w] of [
      [a, ws.a],
      [b, ws.b],
    ] as const) {
      const rows = await adminPool.query(
        `SELECT workspace_id FROM document_scans WHERE document_id = $1`,
        [d.id],
      );
      expect(rows.rowCount).toBeGreaterThan(0);
      for (const r of rows.rows) expect(r.workspace_id).toBe(w);
    }
  });

  it('does not let the worker role read documents outside a tenant context or touch the claim function as the app role', async () => {
    const count = await workerPool.query(`SELECT count(*)::int AS n FROM case_documents`);
    expect(count.rows[0].n).toBe(0); // RLS: no workspace set, nothing visible
    const appPool = new Pool({ connectionString: databaseUrl, max: 1 });
    appPool.on('connect', (c) => void c.query('SET ROLE formiva_app'));
    await expect(appPool.query(`SELECT * FROM ops.claim_next_document_scan(1)`)).rejects.toThrow(
      /permission denied/,
    );
    await appPool.end();
  });

  it('is safe to re-run: an already-decided document is not decided twice', async () => {
    const d = await addDocument({ mime: 'image/png', body: makePng() });
    expect(await run(d.id)).toBe('clean');
    await only(d.id); // a decided document is not claimable, so the worker has nothing to do
    expect(await processNextDocument(deps)).toBe('idle');
    expect((await scans(d.id)).filter((s) => s.scanner === 'clamav')).toHaveLength(1);
  });
});
