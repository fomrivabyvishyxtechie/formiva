/**
 * Declarative security metadata that every route must carry in `config.security`.
 * It is documentation the tests can read: the handlers still enforce authorization
 * themselves (withTenant / withAuthorizedTenant). tests/security/tenant-isolation.test.ts
 * generates its cross-tenant cases from this table and fails if it disagrees with behavior.
 */
export interface RouteSecurity {
  /** jwt = Clerk token required; public = respondent token (Phase 3); open = no auth (health). */
  authKind: 'jwt' | 'public' | 'open';
  /** Workspace roles the handler requires (any of). Omit when the handler checks no role. */
  roles?: readonly string[];
  /** Permission keys the handler requires, or 'none' for pre-membership/open routes. */
  permissions: readonly string[] | 'none';
  /** workspace = tenant context is set from membership; none = no tenant context. */
  tenantScope: 'workspace' | 'none';
  /** Path parameters that hold tenant-owned identifiers (used to build foreign-id cases). */
  pathParams: readonly string[];
}

declare module 'fastify' {
  interface FastifyContextConfig {
    security?: RouteSecurity;
  }
  interface FastifyInstance {
    /** Every registered route's metadata, keyed by "METHOD /path/:param". */
    routeSecurity: ReadonlyMap<string, RouteSecurity>;
  }
}
