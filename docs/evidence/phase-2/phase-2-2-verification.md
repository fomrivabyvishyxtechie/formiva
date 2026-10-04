# Phase 2.2 Verification Evidence

- Date: 2026-10-04
- Result: PASS for the Phase 2.2 auth plugin scope
- Database: PostgreSQL 16 in the ephemeral local `formiva-db-test` container, database `formiva_test`.
- Connection scope: loopback only; test credentials omitted. No OCI or production connection was used.
- Identity fixtures: generated RSA key pair and synthetic JWTs; no Clerk credentials or external JWKS requests. Membership queries ran under `formiva_app`.
- Migrations: existing migrations were run by the integration test; no applied migration was edited.

## Auth cases

| Case | Result |
| --- | --- |
| Missing token | PASS — 401 |
| Expired token | PASS — 401 |
| Invalid signature | PASS — 401 |
| Invalid issuer | PASS — 401 |
| Invalid audience | PASS — 401 |
| Unauthorized party | PASS — 401 |
| Authenticated identity with no matching membership | PASS — 404 |
| Foreign workspace selector | PASS — 404 |
| Insufficient role | PASS — 403 |
| Valid membership and role/permission | PASS — 200, transaction-local workspace/user context |

## Checks

| Check | Result |
| --- | --- |
| Local PostgreSQL 16 database integration tests | PASS |
| API health and auth tests | PASS — 11 total |
| Workspace typecheck | PASS |
| Workspace lint | PASS |
| API package build | PASS |
| Targeted formatting check for changed TypeScript auth files | PASS |
| `git diff --check` | PASS |

The repository-wide formatting check remains blocked by pre-existing formatting in unchanged `packages/db/test/foundation.test.ts`.

## Commands

```powershell
$env:DATABASE_URL='<redacted loopback URL for formiva_test on localhost:55432>'
pnpm --filter @formiva/db run test
pnpm --filter @formiva/api run test
pnpm run typecheck
pnpm run lint
pnpm --filter @formiva/api run build
git diff --check
```

Phase 2.2 auth tests do not verify later workspace/member endpoints or resource-level foreign-ID handling, which remain outside this phase.
