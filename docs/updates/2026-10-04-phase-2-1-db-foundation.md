# Update: Phase 2.1 Database Foundation

## Summary
Implemented database foundation package `packages/db` with migration runner and tenancy helper.

## Why
Phase 2.1 requires database foundation to support tenant-level authorization and ordered migrations.

## Files changed
- `packages/db/package.json`
- `packages/db/src/index.ts`
- `packages/db/src/migration-runner.ts`
- `packages/db/src/with-tenant.ts`
- `packages/db/migrations/009_migration_metadata.sql`
- `packages/db/tsconfig.json`
- `packages/db/test/foundation.test.ts`
- `packages/db/README.md`

## Tests/checks
- `pnpm --filter @formiva/db run test` passed against the local ephemeral PostgreSQL 16 test database. Verified numbered migration order, applied checksums, safe rerun, checksum mismatch rejection, transaction rollback, transaction-local `withTenant` context, zero rows without tenant context, context cleanup, two-workspace RLS isolation, and runtime-role privilege flags.
- `pnpm run typecheck` passed for all configured workspace packages, including `packages/db`.
- `pnpm run lint` passed for all configured workspace packages, including `packages/db` source and tests.
- `git diff --check` passed.
- Sanitized run evidence: `docs/evidence/phase-2/phase-2-1-verification.md`.

## Security considerations
- Tests used synthetic data only and connected only to the ephemeral local PostgreSQL 16 database; no OCI or production endpoints were used.
- Tenant context is transaction-local and was verified not to survive the transaction.
- Runtime roles `formiva_app`, `formiva_worker`, `formiva_readonly`, and `formiva_ops` were verified to have neither SUPERUSER nor BYPASSRLS.
- The ephemeral test database role has migration privileges; that role is not an application runtime role.

## Remaining risks
- Integration verification requires an ephemeral PostgreSQL 16 instance and privileged setup credentials; keep test credentials isolated from deployment credentials.
- Verification covers the Phase 2.1 migration and tenancy foundation only, not production deployment configuration.

## Next recommended task
Phase 2.1 verification is complete. Phase 2.2 remains a separate follow-up and was not started in this update.
