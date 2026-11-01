import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClamdScanner } from '../../apps/api/src/scanner/clamd.js';
import { runContentChecks } from '../../apps/api/src/scanner/content-checks.js';
import { processNextDocument, type ScanDeps } from '../../apps/api/src/scanner/process-document.js';
import { checkUpload } from '../../apps/api/src/services/upload-policy.js';
import { createMemoryStore, startFakeClamd } from '../../apps/api/test/support/scan-fixtures.js';
import { runMigrations } from '../../packages/db/src/index.js';

// Phase 0 corpus (tests/fixtures/generator) pushed through the real upload policy, content checks and scanner worker.
// ClamAV itself is a fake here (see scan-worker.test.ts); real-ClamAV proof is a separate manual/integration step.

const GEN = resolve(process.cwd(), 'tests/fixtures/generator');
const pythonCandidates = [process.env.PYTHON, 'python3', 'python'].filter(Boolean) as string[];
const python = pythonCandidates.find(
  (p) => spawnSync(p, ['--version'], { encoding: 'utf8' }).status === 0,
);
if (!python && process.env.CI) throw new Error('Python 3 is required in CI for the corpus tests');
if (!python)
  console.warn('SKIPPING corpus tests: Python 3 not found (set PYTHON). CI always runs them.');

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
const dbUrl = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '::1'].includes(dbUrl.hostname) ||
  dbUrl.port !== '55432' ||
  dbUrl.pathname !== '/formiva_test'
) {
  throw new Error('Refusing to run corpus tests outside the local formiva_test database');
}
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const workerPool = new Pool({ connectionString: databaseUrl, max: 6 });
workerPool.on('connect', (c) => void c.query('SET ROLE formiva_worker'));

const QUAR = 'quarantine-test';
const DOCS = 'documents-test';
const store = createMemoryStore();
const wsId = randomUUID();
let caseId = '';
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
let deps: ScanDeps;
let root = '';
let manifest: any;

const bytesOf = (file: string) => readFileSync(join(root, file));
const slotAccepts = (mime: string) => [mime, 'application/pdf', 'image/png', 'image/jpeg'];

async function seedWorkspace() {
  const template = randomUUID();
  const version = randomUUID();
  caseId = randomUUID();
  const slug = `corpus-${randomUUID().slice(0, 8)}`;
  await adminPool.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'Synthetic')`, [
    wsId,
    slug,
  ]);
  await adminPool.query(
    `INSERT INTO form_templates (id, workspace_id, key, name) VALUES ($1, $2, $3, 'Synthetic')`,
    [template, wsId, slug],
  );
  await adminPool.query(
    `INSERT INTO form_template_versions (id, workspace_id, template_id, version_number, status, schema_json, schema_sha256, published_at)
     VALUES ($1, $2, $3, 1, 'published', '{"fields":[],"slots":[]}', decode(repeat('ab', 32), 'hex'), now())`,
    [version, wsId, template],
  );
  await adminPool.query(
    `INSERT INTO cases (id, workspace_id, case_number, form_version_id, status) VALUES ($1, $2, 1, $3, 'draft')`,
    [caseId, wsId, version],
  );
}

/** Stores the file in quarantine, then lets the real worker decide. Returns the outcome and the final row. */
async function scan(body: Buffer, mime: string) {
  const id = randomUUID();
  const key = `ws/${wsId}/cases/${caseId}/${id}`;
  await adminPool.query(
    `INSERT INTO case_documents (id, workspace_id, case_id, bucket, object_key, original_filename, mime_type, size_bytes, doc_class, status, slot_key)
     VALUES ($1, $2, $3, $4, $5, 'synthetic.bin', $6, $7, 'other', 'pending_upload', 'cv')`,
    [id, wsId, caseId, QUAR, key, mime, body.length],
  );
  await store.put(QUAR, key, body, mime);
  await adminPool.query(
    `UPDATE case_documents SET next_scan_at = now() + interval '1 day' WHERE status IN ('pending_upload','uploaded') AND id <> $1`,
    [id],
  );
  await adminPool.query(
    `UPDATE case_documents SET next_scan_at = now() - interval '1 second' WHERE id = $1`,
    [id],
  );
  const outcome = await processNextDocument(deps);
  const row = (await adminPool.query(`SELECT * FROM case_documents WHERE id = $1`, [id])).rows[0];
  return { outcome, row, key };
}

describe.skipIf(!python)('Phase 0 corpus through the real scanner (3.x hardening)', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'formiva-corpus-'));
    const gen = spawnSync(python!, [join(GEN, 'generate.py'), '--out', root], { encoding: 'utf8' });
    if (gen.status !== 0) throw new Error(`generator failed: ${gen.stderr}`);
    manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    await runMigrations(adminPool);
    await seedWorkspace();
    clamd = await startFakeClamd();
    deps = {
      pool: workerPool as never,
      store,
      scanner: createClamdScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 2000 }),
      documentsBucket: DOCS,
    };
  }, 120_000);
  afterAll(async () => {
    await clamd?.close();
    await workerPool.end();
    await adminPool.end();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('generator unit tests pass', () => {
    const r = spawnSync(python!, ['-m', 'unittest'], { cwd: GEN, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  }, 180_000);

  it('validator accepts the generated corpus and its pinned hash is stable', () => {
    const r = spawnSync(python!, [join(GEN, 'validate.py'), root, '--regenerate-check'], {
      encoding: 'utf8',
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // Pinned hash: change it only together with a generator_version bump and a decision record.
    const pinned = readFileSync(join(GEN, 'CORPUS_SHA256'), 'utf8').trim();
    expect(manifest.corpus_sha256).toBe(pinned);
  }, 120_000);

  it('accepts and promotes all 100 normal documents (no false positives)', async () => {
    expect(manifest.cases).toHaveLength(100);
    for (const c of manifest.cases) {
      const body = bytesOf(c.file);
      const filename = c.file.split('/').pop() as string;
      const up = checkUpload({
        filename,
        mimeType: c.declared_mime,
        sizeBytes: body.length,
        slotMimeTypes: slotAccepts(c.declared_mime),
        slotMaxBytes: 25 * 1024 * 1024,
      });
      expect(up.ok, `${c.id} upload policy`).toBe(true);
      const { outcome, row, key } = await scan(body, c.declared_mime);
      expect(outcome, `${c.id} (${c.scenario})`).toBe('clean');
      expect(row.status).toBe('clean');
      expect(await store.get(DOCS, key, 1e8)).toBeTruthy();
    }
  }, 120_000);

  it('stops every hostile file at the layer the manifest names, with the expected reason', async () => {
    const files = manifest.hostile.filter((h: any) => h.file);
    expect(files.length).toBeGreaterThanOrEqual(10);
    const stopped: string[] = [];
    for (const h of files) {
      if (h.defence_layer === 'upload_policy') {
        const body = bytesOf(h.file);
        const up = checkUpload({
          filename: h.filename,
          mimeType: h.declared_mime,
          sizeBytes: body.length,
          slotMimeTypes: slotAccepts(h.declared_mime),
          slotMaxBytes: 25 * 1024 * 1024,
        });
        expect(up.ok, `${h.kind} must be refused at upload time`).toBe(false);
        stopped.push(h.kind);
      } else if (h.defence_layer === 'content_checks') {
        const body = bytesOf(h.file);
        // It must get past the upload-time policy (that is what makes the scanner the last line)...
        const up = checkUpload({
          filename: h.filename,
          mimeType: h.declared_mime,
          sizeBytes: body.length,
          slotMimeTypes: slotAccepts(h.declared_mime),
          slotMaxBytes: 25 * 1024 * 1024,
        });
        expect(up.ok, `${h.kind} upload policy`).toBe(true);
        // ... and the pure checks and the real worker must agree.
        const checks = runContentChecks(body, h.declared_mime);
        const bad = checks.checks.find((c) => c.result !== 'clean');
        const { outcome, row, key } = await scan(body, h.declared_mime);
        if (h.expected_scanner === 'clean') {
          expect(bad, `${h.kind} should pass`).toBeUndefined();
          expect(outcome).toBe('clean');
          if (h.must_strip_marker) {
            const stored = await store.get(DOCS, key, 1e8);
            expect(stored.includes(h.must_strip_marker), `${h.kind} metadata stripped`).toBe(false);
            expect(stored.length).toBeLessThan(body.length);
          }
        } else {
          expect(bad?.result, `${h.kind} check result`).toBe(h.expected_scanner);
          expect(bad?.reason, `${h.kind} reason`).toBe(h.expected_reason);
          expect(outcome, `${h.kind} outcome`).toBe('quarantined');
          expect(row).toMatchObject({
            status: 'quarantined',
            quarantine_reason: h.expected_reason,
          });
          expect(store.has(DOCS, key), `${h.kind} not in documents bucket`).toBe(false);
          stopped.push(h.kind);
        }
      }
    }
    expect(stopped.length).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it('lists the hostile classes that belong to other layers, so none is forgotten', () => {
    const other = manifest.hostile.filter(
      (h: any) => h.defence_layer === 'antivirus' || h.defence_layer === 'ai_engine',
    );
    expect(other.map((h: any) => `${h.kind}:${h.defence_layer}`).sort()).toEqual([
      'malware_test_string:antivirus',
      'prompt_injection:ai_engine',
    ]);
  });
});
