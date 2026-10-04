# Database Foundation (Phase 2.1)

## Migration Runner
The `runMigrations` function in `src/migration-runner.ts` executes SQL files in `migrations/` in numeric order, verifying checksums against a `schema_migrations` table to ensure idempotency.

## Tenancy Helper
The `withTenant` function in `src/with-tenant.ts` manages PostgreSQL `set_config` context (`app.workspace_id`, `app.user_id`) within a transaction for RLS enforcement. It supports workspace-only context with a blank user ID while resolving an authenticated membership; the context is still transaction-local.

## Authorized Tenant Transactions
`withAuthorizedTenant` in `src/with-authorized-tenant.ts` accepts a verified identity-provider subject and an optional workspace selector. It resolves active memberships through `ops.workspaces_for_user`, resolves the internal user UUID under the selected workspace's RLS context, and rechecks the active membership and database role inside the final `withTenant` transaction.

Callers pass required roles and/or permissions before their database callback. A workspace outside the verified user's active memberships produces a safe `404`; insufficient roles or permissions produce `403`. Tenant context is available to the callback only through the transaction helper.
