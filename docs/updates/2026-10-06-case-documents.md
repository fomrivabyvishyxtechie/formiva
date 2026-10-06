# Update: Phase 2 Safe Case Document Listing

## Date
2026-10-06

## Summary
Implemented `GET /v1/cases/{case_id}/documents` as a tenant-scoped, redacted metadata read.

## Why
The API contract requires case document metadata while avoiding exposure of document content and storage coordinates.

## Files/areas changed
- Added Zod schemas for the path and safe metadata response.
- Added the authenticated route using `request.withTenant()`, `document.read_sensitive`, RLS, and workspace-qualified case/document/scan joins.
- Added synthetic PostgreSQL coverage for authorized metadata, empty lists, permission/auth errors, foreign/unknown case IDs, tenant isolation, and redaction.
- Updated the API contract, Phase 2.4 evidence, and changelog.

## Tests/checks
- `pnpm --filter @formiva/db run test`: passed; script reported “Phase 2.1 database tests passed” without an assertion count.
- `pnpm --filter @formiva/api run test`: passed, 6 files / 21 tests.
- `pnpm exec vitest run tests/security/tenant-isolation.test.ts`: passed, 1 file / 9 tests; 3.88 seconds total (2.61 seconds in tests).
- `pnpm run format:check` and direct Prettier check of the root-level security test: passed.
- `pnpm run lint`, `pnpm run typecheck`, `pnpm --filter @formiva/api run build`, and `git diff --check`: passed.

All required checks passed against the disposable local PostgreSQL 16 database.

## Security considerations
The response excludes original filenames, MIME types, hash values, bucket names, object keys, quarantine reason, scan details/OCR, extracted values, and policy internals. Only latest scan result/time and hash availability are returned. Deleted documents are omitted. No view links are created.

## Migration/deployment notes
No migration was added or modified. The endpoint reads the existing `case_documents` and append-only `document_scans` tables.

## Remaining risks
Other document operations, including direct document detail, view links, upload, reprocess, and quarantine, remain unimplemented and out of scope.
