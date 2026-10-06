# Update: Phase 2 Tenant-Scoped Case Cancellation

## Date
2026-10-06

## Summary
Implemented `POST /v1/cases/{case_id}/cancel` using the approved case cancellation contract operation.

## Why
Cases need a tenant-authorized cancellation action that follows the database's legal state machine, records an immutable audit event, and safely handles retries.

## Files/areas changed
- Added cancellation path, reason, and response schemas, reusing the safe action-reason and idempotency conventions from case rework.
- Added the authenticated route using `request.withTenant()`, existing `case.approve` permission, a tenant-scoped row lock, `app.state_transitions`, and an atomic status/audit transaction.
- Added synthetic route and PostgreSQL tenant-isolation tests for authorization, foreign/unknown IDs, invalid input/state, safe idempotent replay, changed-body conflict, and persisted audit behavior.
- Updated the API contract, Phase 2.4 evidence, and changelog.

## Tests/checks
- `pnpm --filter @formiva/db run test`: passed; script reported “Phase 2.1 database tests passed” without an assertion count.
- `pnpm --filter @formiva/api run test`: passed, 6 files / 21 tests.
- `pnpm exec vitest run tests/security/tenant-isolation.test.ts`: passed, 1 file / 8 tests; 3.73 seconds total (2.28 seconds in tests).
- `pnpm run format:check` and direct Prettier check of the root-level security test: passed.
- `pnpm run lint`, `pnpm run typecheck`, `pnpm --filter @formiva/api run build`, and `git diff --check`: passed.

All required checks passed against the disposable local PostgreSQL 16 database.

## Security considerations
The route returns only case ID, resulting status, and correlation ID. Reason and idempotency key are not returned; only the SHA-256 key fingerprint is stored in audit metadata. Foreign and unknown case IDs share a safe 404, and the test transaction rolls back synthetic state and audit data.

## Migration/deployment notes
No migration was added or modified. Existing `app.state_transitions` and append-only audit storage are used.

## Remaining risks
The route uses the existing `case.approve` permission because the current permission catalog defines no separate cancellation permission. Other unimplemented Phase 2 resource domains remain out of scope.
