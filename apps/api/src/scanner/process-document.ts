import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '@formiva/db';
import type { ObjectStore } from '../services/object-store.js';
import { MAX_UPLOAD_BYTES } from '../services/upload-policy.js';
import type { FileScanner } from './clamd.js';
import { runContentChecks, type CheckResult } from './content-checks.js';

export const SCAN_MAX_ATTEMPTS = 8;
export const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;
const CHECKS_VERSION = 'formiva-checks-1';

export interface ScanDeps {
  pool: Pool;
  store: ObjectStore;
  scanner: FileScanner;
  documentsBucket: string;
}
interface Claim {
  document_id: string;
  ws_id: string;
  case_id: string;
  bucket: string;
  object_key: string;
  mime_type: string;
  size_bytes: string;
  attempts: number;
  created_at: Date;
}
type ScanRow = {
  scanner: CheckResult['scanner'] | 'clamav';
  version: string;
  result: string;
  details: object;
};
export type ScanOutcome = 'idle' | 'waiting' | 'retry' | 'clean' | 'quarantined' | 'rejected';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/** Claims one document and decides it. Never promotes anything that was not read, checked and scanned. */
export async function processNextDocument(deps: ScanDeps): Promise<ScanOutcome> {
  const claim = await withTenant(deps.pool, null, null, async (client) => {
    const result = await client.query<Claim>('SELECT * FROM ops.claim_next_document_scan(300)');
    return result.rows[0];
  });
  if (!claim) return 'idle';

  const finalAttempt = claim.attempts >= SCAN_MAX_ATTEMPTS;
  try {
    const head = await deps.store.head(claim.bucket, claim.object_key);
    if (!head) {
      if (Date.now() - claim.created_at.getTime() > UPLOAD_EXPIRY_MS) {
        await finish(deps, claim, { status: 'rejected', reason: 'upload_expired', rows: [] });
        return 'rejected';
      }
      await release(deps, claim);
      return 'waiting';
    }
    if (head.size !== Number(claim.size_bytes) || head.size > MAX_UPLOAD_BYTES) {
      const reason = head.size > MAX_UPLOAD_BYTES ? 'too_large' : 'size_mismatch';
      await finish(deps, claim, {
        status: 'quarantined',
        reason,
        rows: [
          row('magic_sniff', 'rejected', {
            reason,
            declared: Number(claim.size_bytes),
            actual: head.size,
          }),
        ],
      });
      return 'quarantined';
    }

    const original = await deps.store.get(claim.bucket, claim.object_key, MAX_UPLOAD_BYTES);
    const checked = runContentChecks(original, claim.mime_type);
    const av = await deps.scanner.scan(original);
    if (av.result === 'error') throw new Error('scanner unavailable');

    const rows: ScanRow[] = checked.checks.map((c) =>
      row(c.scanner, c.result, { ...c.details, reason: c.reason }),
    );
    rows.push(
      av.result === 'infected'
        ? {
            scanner: 'clamav',
            version: av.version,
            result: 'infected',
            details: { signature: av.signature },
          }
        : { scanner: 'clamav', version: av.version, result: 'clean', details: {} },
    );
    const bad = checked.checks.find((c) => c.result !== 'clean');
    const reason = av.result === 'infected' ? 'malware_detected' : bad?.reason;
    if (reason) {
      await finish(deps, claim, { status: 'quarantined', reason, sha: sha256(original), rows });
      return 'quarantined';
    }

    // Clean: store the (metadata-stripped) bytes in the documents bucket first, then record it, then drop the quarantine copy.
    const output = checked.output;
    await deps.store.put(deps.documentsBucket, claim.object_key, output, claim.mime_type);
    const done = await finish(deps, claim, {
      status: 'clean',
      sha: sha256(output),
      size: output.length,
      bucket: deps.documentsBucket,
      pages: checked.pageCount,
      rows: [
        ...rows,
        row('magic_sniff', 'clean', {
          originalSha256: sha256(original).toString('hex'),
          stripped: output !== original,
        }),
      ],
    });
    if (done) await deps.store.delete(claim.bucket, claim.object_key).catch(() => undefined);
    return 'clean';
  } catch {
    // Nothing is promoted on any error. Retry with the claim's backoff; give up safely after the last attempt.
    if (finalAttempt) {
      await finish(deps, claim, {
        status: 'quarantined',
        reason: 'scan_unavailable',
        rows: [{ scanner: 'clamav', version: 'unknown', result: 'error', details: {} }],
      });
      return 'quarantined';
    }
    await release(deps, claim);
    return 'retry';
  }
}

function row(scanner: ScanRow['scanner'], result: string, details: object): ScanRow {
  return { scanner, version: CHECKS_VERSION, result, details };
}

async function release(deps: ScanDeps, claim: Claim): Promise<void> {
  await withTenant(deps.pool, claim.ws_id, null, (client) =>
    client.query('UPDATE case_documents SET scan_lease_until = NULL WHERE id = $1', [
      claim.document_id,
    ]),
  );
}

interface Decision {
  status: 'clean' | 'quarantined' | 'rejected';
  reason?: string;
  sha?: Buffer;
  size?: number;
  bucket?: string;
  pages?: number;
  rows: ScanRow[];
}

/** One transaction: status, hash, evidence rows and audit event. Returns false if someone else already decided. */
async function finish(deps: ScanDeps, claim: Claim, d: Decision): Promise<boolean> {
  return withTenant(deps.pool, claim.ws_id, null, async (client) => {
    const updated = await client.query(
      `UPDATE case_documents
          SET status = $2, quarantine_reason = $3,
              sha256 = COALESCE($4, sha256), size_bytes = COALESCE($5, size_bytes),
              bucket = COALESCE($6, bucket), page_count = COALESCE($7, page_count),
              scan_lease_until = NULL
        WHERE id = $1 AND status IN ('pending_upload', 'uploaded')`,
      [
        claim.document_id,
        d.status,
        d.reason ?? null,
        d.sha ?? null,
        d.size ?? null,
        d.bucket ?? null,
        d.pages ?? null,
      ],
    );
    if (updated.rowCount !== 1) return false;
    for (const r of d.rows) {
      await client.query(
        `INSERT INTO document_scans (workspace_id, document_id, scanner, scanner_version, result, details)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [claim.ws_id, claim.document_id, r.scanner, r.version, r.result, JSON.stringify(r.details)],
      );
    }
    // Metadata only: no file name, no content.
    await client.query(
      `SELECT app.audit($1, 'document', $2, NULL, $3::jsonb, 'worker', NULL, NULL)`,
      [
        d.status === 'clean' ? 'document.scan_clean' : 'document.scan_blocked',
        claim.document_id,
        JSON.stringify({ status: d.status, reason: d.reason ?? null, mime_type: claim.mime_type }),
      ],
    );
    return true;
  });
}
