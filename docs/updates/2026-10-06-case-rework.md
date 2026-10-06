# Update: Phase 2 Tenant-Scoped Case Rework

## Date
2026-10-06

## Summary
Implemented `POST /v1/cases/{case_id}/rework` for the approved case rework operation.

## Why
The approved API contract requires authorized rework requests with a reason, legal state handling, durable audit, and idempotent create-work behavior.

## Files/areas changed
- Added Zod schemas for the route path, safe reason, required idempotency key, and safe response.
- Added the Fastify operation using `request.withTenant()`, `case.approve`, a locked tenant-scoped case row, `app.state_transitions`, and `app.audit`.
- Added synthetic JWT route tests for state/audit/idempotency behavior and two-workspace tests for missing auth, wrong role, foreign/unknown cases, validation, and illegal states.
- Updated the API contract, Phase 2.4 evidence, changelog, and engineering memory.

## Tests/checks
- `pnpm --filter @formiva/db run test`: passed; script reported “Phase 2.1 database tests passed” without an assertion count.
- `pnpm --filter @formiva/api run test`: passed, 6 files / 21 tests.
- `pnpm exec vitest run tests/security/tenant-isolation.test.ts`: passed, 1 file / 7 tests; 3.01 seconds total (1.78 seconds in tests).
- `pnpm run format:check` and direct Prettier check of the root-level security test: passed.
- `pnpm run lint`, `pnpm run typecheck`, `pnpm --filter @formiva/api run build`, and `git diff --check`: passed.

All listed checks passed on the final implementation, including the PostgreSQL-backed atomic transition/audit and idempotent retry coverage.

## Security considerations
The endpoint does not return the reason or audit internals. Reasons are bounded, printable, and reject contiguous or conventionally grouped full numeric IDs and PAN-shaped values. Idempotency keys are hashed before persistence and serialize per-workspace key lookups. Foreign and unknown IDs return the same 404. The state change and immutable audit append share the authorization helper's transaction, verified against local PostgreSQL inside a rollback-only test transaction.

## Migration/deployment notes
No migration was added or modified. The existing case state-transition catalog and append-only audit table provide the required behavior.

## Remaining risks
The endpoint uses the database transition catalog as the source of legal rework states. Rework commands without an idempotency key are rejected; repeating a completed request with the same key/body returns the original safe response.
