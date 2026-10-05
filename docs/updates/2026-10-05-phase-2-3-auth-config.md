# Update: Phase 2.3 Authentication Configuration

## Date
2026-10-05

## Summary
Made Clerk configuration fail closed outside the test environment and restricted synthetic auth bypass to explicitly opted-in tests. Workspace routes now consume the verified typed identity.

## Why
Missing Clerk credentials must never silently disable authentication, and protected API routes must not accept synthetic identities in production.

## Files/areas changed
- API startup and auth plugin configuration.
- Workspace route identity handling and auth/workspace tests.
- Contract exports used by the workspace response.
- Changelog and engineering lessons.

## Tests/checks
- `pnpm --filter @formiva/db run test`: passed against the disposable local PostgreSQL 16 `formiva_test` database.
- `pnpm --filter @formiva/api run test`: passed (5 files, 16 tests), including Clerk auth, workspace bootstrap with synthetic auth, production test-mode rejection, and missing-auth 401.
- `pnpm run format:check`: passed.
- `pnpm run lint`: passed.
- `pnpm run typecheck`: passed.
- `pnpm --filter @formiva/api run build`: passed.
- `git diff --check`: passed.
- All database-backed test commands used the disposable local test URL supplied for this verification; no credential value is recorded here.

## Security considerations
- Production and other non-test startup fails if required Clerk settings are missing.
- Test bypass requires both `NODE_ENV=test` and `dependencies.auth.testMode === true`; production test mode was verified to return 401 without a bearer token.
- No Clerk credentials, OCI endpoints, or production databases were used.

## Remaining risks
- No migration or database behavior was changed.

## Migration/deployment notes
No migration is required. Configure the Clerk issuer, audience, JWKS URL, and authorized-party allowlist in non-test API environments.

## Follow-up work
Proceed to the next approved Phase 2 task after review; Phase 2.4 was not started as part of this work.
