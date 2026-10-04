# Database Foundation (Phase 2.1)

## Migration Runner
The `runMigrations` function in `src/migration-runner.ts` executes SQL files in `migrations/` in numeric order, verifying checksums against a `schema_migrations` table to ensure idempotency.

## Tenancy Helper
The `withTenant` function in `src/with-tenant.ts` manages PostgreSQL `set_config` context (`app.workspace_id`, `app.user_id`) within a transaction for RLS enforcement.
