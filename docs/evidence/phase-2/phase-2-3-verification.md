# Phase 2.3 Verification Evidence

- Date: 2026-10-05
- Result: PASS for Phase 2.3 authentication configuration
- Database: disposable local PostgreSQL 16 container, database `formiva_test`, over loopback (`127.0.0.1:55432`).
- Credentials: disposable test-only URL provided for this run; not recorded.
- No Clerk credentials, OCI endpoints, or production databases were used.
- No database migrations were changed.

## Verification

| Command | Result |
| --- | --- |
| `pnpm --filter @formiva/db run test` | PASS — Phase 2.1 database tests |
| `pnpm --filter @formiva/api run test` | PASS — 5 files, 16 tests |
| `pnpm run format:check` | PASS |
| `pnpm run lint` | PASS |
| `pnpm run typecheck` | PASS |
| `pnpm --filter @formiva/api run build` | PASS |
| `git diff --check` | PASS |

## Authentication cases

- Missing Clerk configuration outside test fails startup.
- Missing Clerk configuration in test without explicit `testMode` does not bypass authentication.
- Synthetic test authentication works only when `NODE_ENV=test` and `dependencies.auth.testMode=true`.
- Production cannot enable synthetic `testMode`; protected routes reject missing authentication with 401.
- A valid synthetic identity reaches the workspace route.
- Missing authentication returns 401.
- Existing synthetic JWT tests continue to verify valid and invalid token, issuer, audience, and authorized-party behavior.

## Security and deployment notes

Non-test API environments must set `CLERK_ISSUER`, `CLERK_AUDIENCE`, `CLERK_JWKS_URL`, and `CLERK_AUTHORIZED_PARTIES`. Synthetic auth remains test-only. No migration or deployment data change is required.
