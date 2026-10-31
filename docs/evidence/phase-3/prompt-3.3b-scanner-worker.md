# Evidence: Prompt 3.3b scanner worker

Built by Claude (chat session). Synthetic files only. No real storage, ClamAV or credentials were used.

## Changed
- Migration `016_document_scan_queue.sql` (claim function, queue columns).
- `apps/api/src/scanner/` (`content-checks.ts`, `clamd.ts`, `process-document.ts`), `scan-worker.ts`, `ObjectStore` extended (head/get/put/delete), config `R2_DOCUMENTS_BUCKET`, `CLAMD_*`.
- Tests: `apps/api/test/scanner.test.ts` (10), `tests/security/scan-worker.test.ts` (11), fixtures in `apps/api/test/support/scan-fixtures.ts` (PNG, JPEG, PDF, DOCX/ZIP builders, EICAR assembled at run time, in-memory store, fake clamd).
- ADR-25 (PROPOSED), contract note.

## Verified (sandbox, PostgreSQL 16)
- Hostile fixtures quarantined with reason: renamed exe, fake PDF, 30000x30000 image, PDF JavaScript, macro Word, zip-bomb Word, EICAR (via fake clamd), size mismatch.
- Clean PNG/JPEG/PDF/DOCX promoted; PNG/JPEG metadata and trailing bytes removed; hash is of the stored bytes; quarantine copy removed only after the database update.
- Scanner down: not promoted, retried, quarantined after 8 attempts. Missing file: waits, rejected after 24 h.
- 8 workers claiming 4 documents: each decided once. Cross-tenant: scan rows carry the document's own workspace. `formiva_app` cannot call the claim function; `formiva_worker` sees no rows without a tenant context.

## Not verified
- Real ClamAV, real R2, real PDF/Word/image viewers. A decodable-image check does not exist.
- The process is not in docker-compose; no systemd/compose entry.
- No respondent-facing "file status" route or page control.
