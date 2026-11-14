import type { Pool } from 'pg';
import { withTenant } from '@formiva/db';
import type { ObjectStore } from '../services/object-store.js';

export interface PurgeDeps {
  pool: Pool;
  store: ObjectStore;
  /** Every bucket the file could be in: quarantine and documents. Deleting a missing object is a no-op. */
  buckets: string[];
}
export type PurgeOutcome = 'idle' | 'purged' | 'retry';

/** Deletes the stored file of one removed document, then records it. A failure leaves the retry to the claim's 10-minute delay. */
export async function purgeNextDocument(deps: PurgeDeps): Promise<PurgeOutcome> {
  const claim = await withTenant(deps.pool, null, null, async (client) => {
    const result = await client.query<{ document_id: string; ws_id: string; object_key: string }>(
      'SELECT * FROM ops.claim_next_document_purge()',
    );
    return result.rows[0];
  });
  if (!claim) return 'idle';
  try {
    for (const bucket of deps.buckets) await deps.store.delete(bucket, claim.object_key);
  } catch {
    return 'retry';
  }
  await withTenant(deps.pool, claim.ws_id, null, async (client) => {
    await client.query(
      'UPDATE case_documents SET storage_purged_at = now() WHERE id = $1 AND storage_purged_at IS NULL',
      [claim.document_id],
    );
    // Metadata only: no file name, no object key.
    await client.query(
      `SELECT app.audit('document.storage_purged', 'document', $1, NULL, '{}'::jsonb, 'worker', NULL, NULL)`,
      [claim.document_id],
    );
  });
  return 'purged';
}
