# Update: Phase 2 Tenant-Scoped Case Listing

## Date
2026-10-05

## Summary
Implemented the first tenant-scoped resource operation, `GET /v1/cases`, with pagination, status filtering, `case.read` permission enforcement, and explicit workspace-scoped SQL inside `request.withTenant()`.

## Resource inventory

| Domain | Current contract/schema state | Implementation state |
| --- | --- | --- |
| Cases | Contracted case list/detail/timeline/rework/cancel; tenant-owned `cases` table | `GET /v1/cases` implemented; case identifier operations pending |
| Documents | Contracted document metadata/view/reprocess/quarantine; document schema exists | Pending |
| Jobs | Internal AI job operation contracted; `ai_jobs` schema exists | Pending |
| Results | `ai_results` schema exists; no standalone result operation in API Contract v1.1 | No endpoint defined |
| Workflows | Workflow operations contracted; workflow schema exists | Pending |
| Integrations | Connection and interaction operations contracted; schemas exist | Pending |
| Billing | Billing plan/subscription schema exists; no billing endpoint in API Contract v1.1 | No endpoint defined |
| Audit | Audit resource operations contracted; `audit_events` schema exists | Pending |

No other resource domains or endpoints were implemented.

## Why
The case list is the first resource operation in the approved case section, uses the existing case schema, and can exercise workspace membership, RBAC, and row-level isolation without adding a migration.

## Files/areas changed
- Case-list route and Zod request/response schemas.
- Phase 2.4 tenant-isolation suite: generated synthetic JWT, two-workspace case rows, permission denial, foreign workspace selection, and route coverage.
- Minimal synthetic Clerk test helper.
- Phase 2.4 verification evidence and changelog.

## Tests/checks
- `pnpm --filter @formiva/db run test`: passed (Phase 2.1 DB test script).
- `pnpm --filter @formiva/api run test`: passed (5 files, 16 tests).
- `pnpm exec vitest run tests/security/tenant-isolation.test.ts`: passed (1 file, 4 tests; 1.94 seconds total).
- `pnpm run format:check` and direct root test Prettier check: passed.
- `pnpm run lint`: passed.
- Strict NodeNext typecheck for the root security suite and `pnpm run typecheck`: passed.
- `pnpm --filter @formiva/api run build`: passed.
- `git diff --check`: passed.

## Security considerations
- The route requires a valid JWT, a workspace selected from actual membership, and `case.read`.
- SQL includes the authorized context workspace ID as well as relying on PostgreSQL RLS.
- Foreign workspace selection produces 404; insufficient permission produces 403.
- Test JWT keys and records are generated synthetic values; tests use only the ephemeral local PostgreSQL database.
- No applied migration, OCI endpoint, production database, or real Clerk credential was used.

## Remaining risks
- Case detail/timeline/mutation, document, job, workflow, integration, audit, and future billing/result operations still need implementation and tenant-isolation coverage.
- This is not full Phase 2 completion or a Phase 3 start.

## Migration/deployment notes
No migration required. The endpoint uses the existing `cases` table and `case.read` permission catalog.

## Follow-up work
Implement the next approved tenant-scoped resource operation separately, adding its foreign-ID and authorization cases before considering it covered.
