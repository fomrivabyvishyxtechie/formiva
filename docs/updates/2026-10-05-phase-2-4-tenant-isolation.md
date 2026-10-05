# Update: Phase 2.4 Tenant-Isolation Suite

## Date
2026-10-05

## Summary
Added a tenant-isolation security suite for currently registered protected routes and app-role RLS behavior. Recorded missing contract operations as pending/not applicable instead of creating stand-in endpoints.

## Why
Tenant isolation must be exercised against actual routes and the PostgreSQL app role, while making authorization coverage omissions visible when new protected routes are registered.

## Files/areas changed
- `tests/security/tenant-isolation.test.ts`: protected route inventory/authorization coverage, synthetic two-workspace fixtures, no-context and foreign-row RLS assertions, and insufficient-role/foreign-workspace checks.
- `docs/evidence/phase-2/phase-2-4-tenant-isolation.md`: verification results and explicit future endpoint coverage status.
- `docs/changelog/CHANGELOG.md`: Phase 2.4 suite summary.

## Tests/checks
- Tenant-isolation suite: passed, 1 file and 3 tests (1.57 seconds total).
- DB test script: passed; output confirms Phase 2.1 database tests.
- API tests: passed, 5 files and 16 tests.
- Repository format check and direct Prettier check for the root test: passed.
- Lint: passed.
- Strict NodeNext type check of the root-level security test: passed.
- Workspace typecheck and API build: passed.
- `git diff --check`: passed.

## Security considerations
- Only an ephemeral loopback PostgreSQL 16 database, synthetic IDs, and synthetic rows were used.
- RLS was queried after `SET LOCAL ROLE formiva_app`.
- The suite fails when a registered `/v1` route lacks an explicit authorization coverage entry.
- The implemented API currently has only `POST /v1/workspaces`; no fake business endpoints were introduced.
- Contracted case, document, job, workflow, integration, and audit operations remain pending; result and billing routes are not defined in API Contract v1.1. Their identifier-isolation responses are not claimed as tested.
- No applied migration was modified.

## Remaining risks
- Foreign-ID safe 404 behavior cannot be exercised for operations that do not exist yet.
- Phase 2.4 is only verified against the current API surface; it is not a Phase 2 exit sign-off.
- The repository lint/format scripts do not include root-level `tests/security/`; the new test received direct formatting and strict type checks.

## Migration/deployment notes
None. No schema or migration changes were made.

## Follow-up work
When each pending protected operation is implemented, add its no-auth, role, and two-workspace foreign-ID cases to the route coverage map and require safe 404 responses for foreign resource identifiers.
