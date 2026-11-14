# Prompt 3.7: hardening after Test 3 (ADR-29 PROPOSED)

Date: 2026-11-14. Synthetic data only.

## Found by the founder's Test 3 on real R2 (2026-11-08)
1. API and scanner worker exited silently on Windows (entry check `import.meta.url === file://${argv[1]}`). Fixed with `pathToFileURL` in `index.ts` and `scan-worker.ts`.
2. A bucket setting holding a web address made every upload request return 500 with no reason in the log. Fixed: config refuses it at start-up (`packages/config`), and 500s are now logged (redacted) with the correlation id.
3. A failed upload left a row showing "uploading". Fixed on both sides: the API soft-deletes the row if signing fails; the form removes it if the file cannot be sent.
4. "Remove" left the stored file in the bucket. Fixed by migration 017 and the worker purge (ADR-29, PROPOSED).

## Tests added or changed
- `tests/security/storage-purge.test.ts` (5): purge from both buckets, audit without key or name, not repeated; 10-minute grace; legal hold and non-removed rows untouched; failing delete retried later; scanner refuses a size that differs from the declared size (`size_mismatch`). Mutation check: removing the grace and legal-hold rules in the database made two of these fail.
- `tests/security/public-uploads.test.ts` (+1): signing failure gives 500 with no leaked reason and leaves only a `deleted` row.
- `packages/config/test/index.test.ts` (+1), `apps/web/src/lib/upload.test.ts` (changed), `apps/web/tests/e2e/public-form.spec.ts` (+1, runs at 375 px and 1280 px).

## Run (Linux sandbox, PostgreSQL 16, synthetic)
format:check, lint, typecheck, build PASS; db test 108 checks; db security checks 18; API 55; config 3; web unit 27; tests/security 86 passed and 4 skipped (real-ClamAV tests need a daemon); web e2e 50 (desktop, mobile, production build).

## Not proven
Real R2 behaviour of the new purge (delete of a missing key, timing); Windows run of the entry-point fix; a clean file whose quarantine copy failed to delete is still not retried; quarantine retention not built.
