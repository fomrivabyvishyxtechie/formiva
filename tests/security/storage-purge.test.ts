import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClamdScanner } from '../../apps/api/src/scanner/clamd.js';
import { processNextDocument, type ScanDeps } from '../../apps/api/src/scanner/process-document.js';
import { purgeNextDocument } from '../../apps/api/src/scanner/purge-documents.js';
import {
  createMemoryStore,
  makePng,
  startFakeClamd,
} from '../../apps/api/test/support/scan-fixtures.js';
import { runMigrations } from '../../packages/db/src/index.js';

// Removed documents lose their stored file (ADR-29), and a file whose size differs from what was declared is refused
// by the scanner itself (so the upload does not depend on R2 enforcing the signed size).

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
  throw new Error('Refusing to run purge tests outside the local formiva_test database');
}
const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
const workerPool = new Pool({ connectionString: databaseUrl, max: 4 });
workerPool.on('connect', (c) => void c.query('SET ROLE formiva_worker'));

const QUAR = 'quarantine-test';
const DOCS = 'documents-test';
const store = createMemoryStore();
const wsId = randomUUID();
let caseId = '';
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;

async function seedWorkspace() {
  const template = randomUUID();
  const version = randomUUID();
  caseId = randomUUID();
  const slug = `purge-${randomUUID().slice(0, 8)}`;
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

/** A document row with its file in both buckets, as after a scan that raced with a removal. */
async function removedDoc(opts: { removedAgo: string; hold?: boolean; status?: string }) {
  const id = randomUUID();
  const key = `ws/${wsId}/cases/${caseId}/${id}`;
  const status = opts.status ?? 'deleted';
  await adminPool.query(
    `INSERT INTO case_documents (id, workspace_id, case_id, bucket, object_key, original_filename, mime_type, size_bytes, sha256,
        doc_class, status, slot_key, legal_hold, deleted_at, next_scan_at)
     VALUES ($1, $2, $3, $4, $5, 'synthetic-name.png', 'image/png', 10, decode(repeat('cd', 32), 'hex'), 'other', $6, 'cv', $7,
        CASE WHEN $6 = 'deleted' THEN now() - $8::interval END, now() + interval '1 day')`,
    [id, wsId, caseId, DOCS, key, status, opts.hold ?? false, opts.removedAgo],
  );
  await store.put(QUAR, key, Buffer.from('synthetic bytes'), 'image/png');
  await store.put(DOCS, key, Buffer.from('synthetic bytes'), 'image/png');
  return { id, key };
}
const row = async (id: string) =>
  (await adminPool.query(`SELECT * FROM case_documents WHERE id = $1`, [id])).rows[0];
// Other tests (and earlier runs) leave removed rows in the shared test database; make this the only one the purge may claim.
const only = (id: string) =>
  adminPool.query(
    `UPDATE case_documents SET storage_purge_after = CASE WHEN id = $1 THEN now() - interval '1 second' ELSE now() + interval '1 day' END
      WHERE status = 'deleted' AND storage_purged_at IS NULL`,
    [id],
  );
const run = () => purgeNextDocument({ pool: workerPool as never, store, buckets: [QUAR, DOCS] });

beforeAll(async () => {
  await runMigrations(adminPool);
  await seedWorkspace();
  clamd = await startFakeClamd();
});
afterAll(async () => {
  await clamd?.close();
  await workerPool.end();
  await adminPool.end();
});

describe('storage purge (ADR-29)', () => {
  it('deletes the file from both buckets, records it, audits without the key or file name, and does not repeat', async () => {
    const d = await removedDoc({ removedAgo: '1 hour' });
    await only(d.id);
    expect(await run()).toBe('purged');
    expect(store.has(QUAR, d.key)).toBe(false);
    expect(store.has(DOCS, d.key)).toBe(false);
    expect((await row(d.id)).storage_purged_at).not.toBeNull();
    const audit = (
      await adminPool.query(
        `SELECT * FROM audit_events WHERE action = 'document.storage_purged' AND object_id = $1`,
        [d.id],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain('synthetic-name');
    expect(JSON.stringify(audit[0])).not.toContain(d.key);
    expect(await run()).toBe('idle');
  });

  it('waits 10 minutes after removal, so a scan already running cannot restore the file afterwards', async () => {
    const d = await removedDoc({ removedAgo: '1 minute' });
    await only(d.id);
    expect(await run()).toBe('idle');
    expect(store.has(DOCS, d.key)).toBe(true);
    expect((await row(d.id)).storage_purged_at).toBeNull();
  });

  it('never purges a document under legal hold, or one that was not removed', async () => {
    const held = await removedDoc({ removedAgo: '1 hour', hold: true });
    const clean = await removedDoc({ removedAgo: '1 hour', status: 'clean' });
    await adminPool.query(
      `UPDATE case_documents SET storage_purge_after = now() - interval '1 second' WHERE id IN ($1, $2)`,
      [held.id, clean.id],
    );
    expect(await run()).toBe('idle');
    expect(store.has(DOCS, held.key)).toBe(true);
    expect(store.has(DOCS, clean.key)).toBe(true);
  });

  it('a failing delete is reported as retry, keeps the row unpurged, and is not retried at once', async () => {
    const d = await removedDoc({ removedAgo: '1 hour' });
    await only(d.id);
    const failing = {
      ...store,
      delete: async () => Promise.reject(new Error('synthetic storage outage')),
    };
    expect(
      await purgeNextDocument({
        pool: workerPool as never,
        store: failing as never,
        buckets: [QUAR, DOCS],
      }),
    ).toBe('retry');
    expect((await row(d.id)).storage_purged_at).toBeNull();
    expect(await run()).toBe('idle');
    // After the delay passes, the next run finishes the job.
    await adminPool.query(
      `UPDATE case_documents SET storage_purge_after = now() - interval '1 second' WHERE id = $1`,
      [d.id],
    );
    expect(await run()).toBe('purged');
    expect(store.has(DOCS, d.key)).toBe(false);
  });
});

describe('declared size is enforced by the scanner', () => {
  it('quarantines a file whose stored size differs from what the upload declared', async () => {
    const png = makePng();
    const id = randomUUID();
    const key = `ws/${wsId}/cases/${caseId}/${id}`;
    await adminPool.query(
      `INSERT INTO case_documents (id, workspace_id, case_id, bucket, object_key, original_filename, mime_type, size_bytes, doc_class, status, slot_key)
       VALUES ($1, $2, $3, $4, $5, 'synthetic.png', 'image/png', $6, 'other', 'pending_upload', 'cv')`,
      [id, wsId, caseId, QUAR, key, png.length + 7],
    );
    await store.put(QUAR, key, png, 'image/png');
    await adminPool.query(
      `UPDATE case_documents SET next_scan_at = now() + interval '1 day' WHERE status IN ('pending_upload','uploaded') AND id <> $1`,
      [id],
    );
    await adminPool.query(
      `UPDATE case_documents SET next_scan_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const deps: ScanDeps = {
      pool: workerPool as never,
      store,
      scanner: createClamdScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 2000 }),
      documentsBucket: DOCS,
    };
    expect(await processNextDocument(deps)).toBe('quarantined');
    const after = await row(id);
    expect(after).toMatchObject({ status: 'quarantined', quarantine_reason: 'size_mismatch' });
    expect(store.has(DOCS, key)).toBe(false);
  });
});
