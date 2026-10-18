# Phase 2 decision record (DRAFT, unsigned)

Template: Master Build Roadmap, Appendix A. Numbers marked (re-run) were observed once by the assistant on a rebuilt Linux PostgreSQL 16; replace them with the output of your own run before signing.

```text
Phase: 2 - Database and tenant authorization
Release/fixture version: migrations 001-014; synthetic data only
Date and time UTC: 2026-10-10 (fill in at sign-off)
Owner: Founder (VishyxTechie.in)
Technical reviewer: ______ (UNSIGNED - required by the roadmap)
Scope completed: Prompts 2.1 (DB package), 2.2 (auth/authorization), 2.3 (bootstrap, members, invitations), 2.4 (tenant-isolation suite)

Controls implemented: ordered migration runner with checksums; transaction-local tenant context (withTenant);
  forced RLS on all tenant tables; Clerk JWT verification; membership/role/permission checks; foreign IDs return 404;
  last-owner protection; append-only audit with hash chain; narrow definer functions for the 3 pre-membership operations.
Controls planned: permission-cache invalidation window test (30 s max) with a controllable clock; ADR-19 reviewer approval.
Controls assessment-required: security review of the 3 BYPASSRLS definer roles; independent review of pre-membership routes.

Tests run and results (re-run):
  pnpm --filter @formiva/db run test      -> 105 assertion checks PASS (twice, no reset between)
  SQL suites 01/02/04/05                  -> 107 assertions PASS (50 + 31 + 18 + 8); 03_concurrency.sh not re-run
  06_security_checks.sql (new)            -> 18 checks PASS, rolls back, fails when FORCE RLS is removed
  pnpm --filter @formiva/api run test     -> 39 PASS
  tests/security/tenant-isolation.test.ts -> 12 PASS; 13 protected routes covered; fails if a route lacks coverage
  format:check, lint, typecheck, build    -> PASS
Attack/negative tests: no auth 401; wrong role 403; foreign workspace/case/member/invitation 404; no tenant context = 0 rows;
  hand-written SELECT/UPDATE as formiva_app against the other workspace = 0 rows; cross-tenant INSERT refused by RLS;
  UPDATE/DELETE/TRUNCATE on audit_events refused (privilege for app role, trigger for admin); audit chain verifies for both workspaces.
Evidence paths: docs/evidence/phase-2/ (phase-2-1..2-4 files; add your own dated run logs)
Failed checks: migration 011 edited after being applied (restored, SHA-256 940475277ebe701dbc242e9904fb17bec576ff68af8e1fd6c0521f85471302fe);
  invented migrations 015/016 removed (015 reverted ADR-19 hardening); migration runner read schema_migrations before 009 created it (fixed).
Changed assumptions: SQL assertion count is 107 (the 99 and 81 figures are stale); formiva_test is the Postgres superuser by design.
Open risks:
  1. Roadmap invariant "no raw DB access outside packages/db": apps/api routes and services run SQL via client.query/pool.query. Needs a reviewer ruling or a refactor.
  2. workspace_bootstrap_idempotency has no RLS; protected only by having no grants to formiva_app.
  3. Definer roles hold BYPASSRLS (existing design); app.audit_chain is SECURITY DEFINER owned by the migration admin and executable by PUBLIC (trigger-only).
  4. ADR-19 security/technical approvals pending; verified-email trust path needs independent re-review.
  5. (Resolved) API could not start with `pnpm dev` (ESM importing CJS @formiva/db); fixed with explicit named exports in packages/db/src/index.ts; `pnpm --filter @formiva/api run smoke` starts the real server.
  6. Permission-cache expiry for removed/suspended members is not tested with a clock.
  7. Prompt 2.4 wording differs between the Roadmap and the Coding Plan; the stricter Coding Plan wording (route security metadata plus generated cross-tenant tests, foreign ids in path/query/body, lower-role caller) is now met by `config.security` metadata and the generated tests in tests/security/tenant-isolation.test.ts. Reviewer to confirm which wording governs.
  8. The API contract is handwritten, not generated from OpenAPI. tests/security/openapi-drift.test.ts only reports live routes missing from it and never fails the build.
  9. Route security metadata is declarative and verified by tests; it is not enforced per request. Handlers still call withTenant / withAuthorizedTenant themselves, and the startup hook only refuses routes that have no metadata.
Decision: RESTRICTED
If restricted, allowed use: synthetic-data development and demos only; no customer data; no Phase 3 until reviewer signs.
Next action and owner: Technical reviewer reads auth/RLS code and ADR-19, signs this record or lists required changes - reviewer; founder commits the work.
```

## Reviewer Packet
Reviewer instructions and evidence: [../../reviews/phase-2-reviewer-packet.md](../../reviews/phase-2-reviewer-packet.md)
