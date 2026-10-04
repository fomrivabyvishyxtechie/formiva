# Formiva API

## Authenticated workspace requests

The Fastify auth plugin protects `/v1` routes. It verifies Clerk JWT signatures against the configured HTTPS JWKS URL and requires the configured issuer, audience, unexpired `exp`, `sub`, and an `azp` authorized-party value from the explicit allowlist.

Authentication configuration:

- `CLERK_ISSUER`: exact JWT issuer.
- `CLERK_AUDIENCE`: required JWT audience.
- `CLERK_JWKS_URL`: HTTPS JWKS endpoint.
- `CLERK_AUTHORIZED_PARTIES`: comma-separated `azp` allowlist.
- `DATABASE_URL`: PostgreSQL connection used for membership and role authorization.

`X-Workspace-Id` selects a workspace; it never grants access. It may be omitted only when the authenticated identity has exactly one active workspace membership. Routes perform tenant-owned database work through `request.withTenant(requirements, callback)`, which rechecks membership and roles/permissions and exposes the transaction client only within `withTenant()`. Unknown or foreign workspaces return `404`.

The auth tests require the isolated local PostgreSQL 16 test database at `localhost:55432/formiva_test` with the `formiva_test` role. They generate synthetic RSA keys and JWTs and do not use Clerk credentials or external JWKS requests.
