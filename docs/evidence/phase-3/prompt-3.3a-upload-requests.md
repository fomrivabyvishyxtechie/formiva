# Evidence: Prompt 3.3a upload requests

Built by Claude (chat session). Synthetic data only. No real storage account or credentials were used.

## Changed
- Migration `015_upload_requests.sql`; `apps/api/src/routes/public-uploads.ts`, `public-shared.ts` (helpers moved out of `public.ts`), `services/object-store.ts`, `services/upload-policy.ts`; config `R2_*`; `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` added to `apps/api`.
- Tests: `tests/security/public-uploads.test.ts` (8), `apps/api/test/object-store.test.ts` (5).
- ADR-24 (PROPOSED), contract section 5.3 note.

## Verified (sandbox, PostgreSQL 16)
- `pnpm run verify` exit 0; `tests/security --no-file-parallelism` 38 pass (tenant isolation 15, drift 1, public 14, uploads 8).
- Repository secret-scan command finds nothing (including the lockfile).
- Hostile requests refused: renamed exe, archive, SVG, macro Word, MIME/name mismatch, slot mismatch, oversize, unknown slot, path-traversal names are sanitized.
- Link signing checked offline with fake credentials (host, path, 300 s expiry, content-type and content-length signed).

## Not verified
- No real R2 request (needs buckets and an API token). Behaviour of R2 on signed headers is a vendor claim.
- No file was ever uploaded, scanned or promoted: that is 3.3b.
- The web page has no upload control yet (later step).
- `docs/database` schema copy and the source SQL package were not updated for migration 015.

## Settings (not set anywhere yet)
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_QUARANTINE_BUCKET` (API environment).
