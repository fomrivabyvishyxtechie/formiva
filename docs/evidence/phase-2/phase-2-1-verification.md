# Phase 2.1 Verification Evidence

- Date: 2026-10-04
- Result: PASS
- Database: PostgreSQL 16.14 in the local ephemeral `formiva-db-test` container, database `formiva_test`.
- Connection scope: local loopback only; credentials intentionally omitted. No OCI or production connection was used.
- Test data: synthetic workspace/template records; test cleanup left no synthetic templates behind.

## Checks

| Check | Result |
| --- | --- |
| Numbered migration execution order | PASS |
| Applied migration versions and SHA-256 checksums recorded | PASS |
| Safe rerun preserves migration records | PASS |
| Checksum mismatch rejected | PASS |
| Failed migration transaction rolls back | PASS |
| `withTenant` sets workspace/user context transaction-locally | PASS |
| Missing tenant context returns zero rows | PASS |
| Context does not survive transaction completion | PASS |
| Two-workspace RLS isolation | PASS |
| `formiva_app`, `formiva_worker`, `formiva_readonly`, `formiva_ops` have neither SUPERUSER nor BYPASSRLS | PASS |
| Workspace typecheck, including DB package and tests | PASS |
| Workspace lint, including DB package and tests | PASS |
| `git diff --check` | PASS |

## Commands

```powershell
$env:DATABASE_URL='<redacted local test URL for formiva_test on localhost:55432>'
pnpm --filter @formiva/db run test
pnpm run typecheck
pnpm run lint
git diff --check
```

The integration test output was `Phase 2.1 database tests passed`. No Phase 2.2 changes were made.
