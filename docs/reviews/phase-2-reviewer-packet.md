# Phase 2 reviewer packet

For the human technical reviewer. Status: **UNSIGNED**. Decision record: `docs/evidence/phase-2/phase-2-decision-record.md` (RESTRICTED: synthetic data only).
Everything below was read from the code at commit `f132fcc` plus the later changes in this branch; the catalog results come from a rebuilt `formiva_test` database (PostgreSQL 16).

## 1. Read in this order

1. `packages/db/src/with-tenant.ts`: transaction-local `app.workspace_id` / `app.user_id` via `set_config(..., true)`.
2. `packages/db/src/with-authorized-tenant.ts`: resolves membership, role and permission; unknown or foreign workspace is a safe 404; insufficient role or permission is 403.
3. `packages/db/src/migration-runner.ts`: ordered runner, checksum per file, refuses a changed applied file, never rewrites `schema_migrations`.
4. `apps/api/src/auth.ts`: Clerk JWT verification, `X-Workspace-Id` as selector only, early membership check hook (`withTenant({}, ...)`) for every `/v1` route except the two pre-membership routes.
5. `apps/api/src/routes/cases.ts`, `workspaces.ts`, `invitations.ts`, and `apps/api/src/services/identity.ts`.
6. Migrations `010` to `014` (invitations, identity projection, the three definer capabilities, hardening, replay and membership guards).
7. `tests/security/tenant-isolation.test.ts` and `packages/db/tests/06_security_checks.sql`.

## 2. Protected routes (13)

Permission strings are the exact ones in the code. "Early check" means the auth hook in `auth.ts` runs the membership check before the handler.

| Route | Auth | Role / permission required | Tenant scope | Early check |
| --- | --- | --- | --- | --- |
| `POST /v1/workspaces` | JWT | none (creator); verified, fresh identity enforced in `app.bootstrap_workspace` | creates one | no (pre-membership) |
| `POST /v1/invitations/accept` | JWT | none; verified-email binding enforced in `app.accept_invitation` | from stored invitation | no (pre-membership) |
| `POST /v1/workspaces/{workspace_id}/members/invitations` | JWT | roles owner/admin and `member.manage` | selected workspace | yes |
| `DELETE /v1/invitations/{invitation_id}` | JWT | roles owner/admin and `member.manage` | selected workspace | yes |
| `GET /v1/workspaces/{workspace_id}/members` | JWT | roles owner/admin and `member.manage` | selected workspace | yes |
| `PATCH /v1/workspaces/{workspace_id}/members/{member_id}` | JWT | roles owner/admin and `member.manage` | selected workspace | yes |
| `DELETE /v1/workspaces/{workspace_id}/members/{member_id}` | JWT | roles owner/admin and `member.manage` | selected workspace | yes |
| `GET /v1/cases` | JWT | `case.read` | selected workspace | yes |
| `GET /v1/cases/{case_id}` | JWT | `case.read` | selected workspace | yes |
| `GET /v1/cases/{case_id}/timeline` | JWT | `case.read` | selected workspace | yes |
| `GET /v1/cases/{case_id}/documents` | JWT | `document.read_sensitive` | selected workspace | yes |
| `POST /v1/cases/{case_id}/rework` | JWT | `case.approve` | selected workspace | yes |
| `POST /v1/cases/{case_id}/cancel` | JWT | `case.approve` | selected workspace | yes |

Coverage: `tests/security/tenant-isolation.test.ts` reads the live Fastify route list and fails if a `/v1` route has no coverage entry. All 13 return 401 without a token (tested). Foreign identifiers return 404 (tested for case, timeline, documents, rework, cancel, member, invitation).

## 3. SECURITY DEFINER functions (catalog query on a rebuilt test DB)

| Function | Owner | Owner BYPASSRLS | Pinned search_path | EXECUTE for formiva_app |
| --- | --- | --- | --- | --- |
| `app.bootstrap_workspace` | formiva_bootstrap_definer | yes | yes | yes |
| `app.accept_invitation` | formiva_acceptance_definer | yes | yes | yes |
| `app.sync_user_identity` | formiva_identity_definer | yes | yes | yes |
| `app.audit_chain` (trigger function) | migration admin role | depends on that role | yes | yes (also PUBLIC; trigger functions cannot be called directly) |
| `ops.workspaces_for_user` | formiva_definer | yes | yes | yes |
| `ops.resolve_respondent_token` | formiva_definer | yes | yes | yes |
| `ops.claim_next_ai_job`, `claim_next_interaction`, `claim_next_step`, `requeue_expired_leases` | formiva_definer | yes | yes | no (worker role only) |

Roles (all NOLOGIN groups): `formiva_app` is NOSUPERUSER, NOBYPASSRLS and owns no tables. 60 tables have row-level security enabled and forced.
One tenant-keyed table has no RLS: `workspace_bootstrap_idempotency` (no grants to `formiva_app`; reached only through `app.bootstrap_workspace`).

## 4. Questions for the reviewer (recommendations are not decisions)

| # | Risk | Evidence | Recommendation (for you to accept or reject) |
| --- | --- | --- | --- |
| 1 | Roadmap invariant "no raw DB access outside packages/db" versus SQL written in `apps/api` routes and `services/identity.ts` | `client.query(...)` in `routes/cases.ts`, `workspaces.ts`, `invitations.ts`; `pool.query` in `services/identity.ts`. SQL runs inside `withTenant`, so tenant context is set. | Either record an ADR that SQL inside the authorized-transaction callback is acceptable for now, or move SQL into `packages/db` repository functions before Phase 3. Add a test that fails on any query outside an authorized transaction. |
| 2 | `workspace_bootstrap_idempotency` has no RLS | `06_security_checks.sql` allow-lists it and asserts `formiva_app` has no privileges on it | Add forced RLS, or keep the current design and record it. New migration only; never edit applied ones. |
| 3 | Three definer roles hold BYPASSRLS (existing ADR-19 design) | `pg_roles` | Confirm each role's grants are the minimum (migrations 011-014) and EXECUTE is limited to `formiva_app`. |
| 4 | ADR-19 approvals pending; verified-email trust path (Clerk Backend API lookup, 15-minute freshness) | ADR-19; `services/identity.ts`; `app.bootstrap_workspace` | Independent re-review of that path. |
| 5 | Removed or suspended member loses access within the permission cache window (max 30 s): no test with a clock found | none | Add a test with a controllable clock before relying on a cache. |
| 6 | `app.audit_chain` is SECURITY DEFINER owned by the migration admin and executable by PUBLIC | catalog | Low risk (trigger-only); consider a dedicated owner role. |
| 7 | Every authenticated `/v1` request outside tests calls the Clerk Backend API (`syncUserIdentity` in the auth hook). Analyst inference: this adds latency and can hit provider rate limits; a Clerk outage returns 503 for all routes | `apps/api/src/auth.ts` | Verify Clerk limits for your plan; consider caching the projection within its freshness window. |

## 5. Re-run the evidence

```powershell
$env:DATABASE_URL="postgresql://formiva_test:formiva_test_only@127.0.0.1:55432/formiva_test"
pnpm --filter @formiva/db run db:reset
pnpm --filter @formiva/db run db:security-check      # PASS  18 security checks
pnpm exec vitest run tests/security                   # 12 tests
pnpm --filter @formiva/api run smoke                  # real server: /healthz 200, /v1/cases 401
pnpm run verify                                       # format, lint, typecheck, tests, build
```

## Sign-off

Reviewer name: Sreehari T P  Date: 18/10/2026  Result: PASS
