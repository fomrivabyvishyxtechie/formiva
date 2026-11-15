# ADR-29: Delete the stored file when a document is removed (PROPOSED)

Status: PROPOSED. Written by the agent; needs the founder's acceptance (same rule as ADR-27).
Date: 2026-11-14
Phase: 3 (hardening after Test 3)

## Why
Test 3 on real R2 (2026-11-08) showed that "Remove" in the form only marks the row `deleted`. The file stayed in the documents bucket. For a real respondent that is a privacy gap: they believe the file is gone. ADR-28 recorded this as a known limit; this ADR closes it.

## Decision
1. **Migration 017** (additive) adds `case_documents.storage_purged_at` and `storage_purge_after`, and a definer function `ops.claim_next_document_purge()` executable only by `formiva_worker` (same pattern as the scan claim in 016).
2. **The scanner worker** deletes the stored object of removed documents whenever it has nothing to scan. It deletes the same key from both buckets (quarantine and documents), because a scan that was running at removal time can leave a copy in either. Deleting a missing object is a no-op. It then sets `storage_purged_at` and writes the audit event `document.storage_purged` (no file name, no object key).
3. **10-minute grace.** A file is purged only 10 minutes after removal. A scan holds a 5-minute lease, so by then no scan can still be about to put the file back.
4. **Failures retry later.** Each claim pushes the next try 10 minutes out, so a failing delete neither blocks other work nor hammers storage.
5. **Legal hold is never purged.** (Removal itself is already refused under legal hold.)
6. **Config checks at start-up.** `R2_ACCOUNT_ID` must be the 32-character id and bucket settings must be bucket names only. A pasted web address (which crashed uploads in Test 3) is refused with a clear message.
7. **A failed upload leaves no unfinished row.** If signing fails the API soft-deletes the row it just made; if the browser cannot send the file, the form removes the row.

## Not covered (known limits)
- Quarantined (refused) files stay in quarantine on purpose, for review. Their retention is not built.
- A clean file whose quarantine copy could not be deleted after promotion is not retried (the delete result is ignored in `process-document.ts`). Needs a follow-up.
- Rows abandoned in `pending_upload` are closed by the scanner after its retries; no file exists for them, so nothing is purged.
- Backups and R2 object versioning (if ever turned on) are outside this mechanism. Vendor behaviour of R2 delete is a vendor claim, checked only by manual observation.
