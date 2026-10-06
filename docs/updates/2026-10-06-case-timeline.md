# Update: Phase 2 Tenant-Scoped Case Timeline

## Date
2026-10-06

## Summary
Implemented `GET /v1/cases/{case_id}/timeline` as a tenant-scoped, correlation-linked read.

## Why
The approved case API contract requires a redacted case timeline while prohibiting raw document text, full IDs, credentials, and hidden policy internals.

## Files/areas changed
- Added Zod path-parameter and response schemas for the case timeline.
- Added the Fastify route using `request.withTenant()`, the `case.read` permission, and both case/workspace predicates.
- Added unit redaction and parameter-validation tests plus synthetic two-workspace authorization coverage.
- Updated the API contract, Phase 2.4 verification evidence, continuation note, and changelog. This repository has no separate OpenAPI specification file.

## Tests/checks
- `pnpm --filter @formiva/db run test`: passed; script reported “Phase 2.1 database tests passed” without an assertion count.
- `pnpm --filter @formiva/api run test`: passed, 6 files / 20 tests.
- `pnpm exec vitest run tests/security/tenant-isolation.test.ts`: passed, 1 file / 6 tests.
- `pnpm run format:check` and direct Prettier check of the root-level security test: passed.
- `pnpm run lint`, `pnpm run typecheck`, `pnpm --filter @formiva/api run build`, and `git diff --check`: passed.
- An extra direct ESLint invocation cannot lint the root-level security test because the configured project service excludes it; an ad hoc standalone TypeScript invocation reports diagnostics on unchanged portions of that test. The required workspace lint/typecheck commands pass.

## Security considerations
The response only contains event time, correlation ID, and a fixed `case_activity` label. Audit actions, actor details, reasons, payloads, object IDs, and hashes are not selected or returned. Foreign cases are indistinguishable from unknown cases and return 404.

## Migration/deployment notes
No migration was added or modified. The route reads the existing tenant-scoped `audit_events` table.

## Remaining risks
The API currently has no public-safe event vocabulary, so timeline entries intentionally use a generic activity label. Other Phase 2 resource operations remain pending.
