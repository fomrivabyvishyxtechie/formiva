import { Pool } from 'pg';
import { loadConfig } from '@formiva/config';
import { createClamdScanner } from './scanner/clamd.js';
import { processNextDocument, type ScanDeps } from './scanner/process-document.js';
import { createS3ObjectStore } from './services/object-store.js';

/** Runs until stopped: claim, scan, decide; sleep only when there is nothing to do. */
export async function runScanLoop(
  deps: ScanDeps,
  opts: { intervalMs: number; stop: () => boolean },
) {
  while (!opts.stop()) {
    let outcome;
    try {
      outcome = await processNextDocument(deps);
    } catch (error) {
      console.error('scan worker error:', error instanceof Error ? error.message : 'unknown');
      outcome = 'idle';
    }
    if (outcome === 'idle') await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

async function main() {
  const config = loadConfig(process.env);
  if (
    !process.env.DATABASE_URL ||
    !config.R2_ACCOUNT_ID ||
    !config.R2_ACCESS_KEY_ID ||
    !config.R2_SECRET_ACCESS_KEY ||
    !config.R2_QUARANTINE_BUCKET ||
    !config.R2_DOCUMENTS_BUCKET
  ) {
    throw new Error('Scan worker needs DATABASE_URL and the R2_* settings (both buckets).');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let stopping = false;
  process.on('SIGTERM', () => (stopping = true));
  process.on('SIGINT', () => (stopping = true));
  await runScanLoop(
    {
      pool,
      store: createS3ObjectStore({
        accountId: config.R2_ACCOUNT_ID,
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      }),
      scanner: createClamdScanner({ host: config.CLAMD_HOST, port: config.CLAMD_PORT }),
      documentsBucket: config.R2_DOCUMENTS_BUCKET,
    },
    { intervalMs: 5_000, stop: () => stopping },
  );
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Scan worker failed to start', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
