# Phase 2 Tenant-Isolation and Bootstrap/Invitation Evidence

- Date: 2026-10-09
- Scope: authenticated API operations, pre-membership workspace bootstrap/invitation operations, and database tenant isolation
- Database: ephemeral local PostgreSQL 16, `formiva_test` on `127.0.0.1:55432`
- Fixtures: two synthetic workspaces, viewer/approver/owner/admin memberships, tenant-owned form/case rows, and synthetic documents/scan data
- Result: 13 registered protected routes have authorization coverage; 12 tenant-isolation tests pass. The Phase 2 acceptance gate remains pending required human reviewer sign-off and complete validation.
- Migrations 001–009 remain unchanged; later migrations are additive. No OCI, production database, live Clerk credential, or real personal data was used.

## Phase 2 scope inventory

| Domain/operation | Roadmap phase | Status |
| --- | --- | --- |
| Database migrations, RLS, `withTenant()`, JWT/member authorization | Phase 2 | Implemented; see database and tenant checks below |
| `POST /v1/workspaces` | Phase 2.3 | Implemented with strict pre-membership auth, trusted verified identity, atomic database bootstrap, role/policy/audit creation, and idempotency |
| `GET /v1/workspaces/{workspace_id}/members` | Phase 2.3 | Implemented; owner/admin + `member.manage`, selected-tenant rows only |
| `POST /v1/workspaces/{workspace_id}/members/invitations` | Phase 2.3 | Implemented; owner/admin + `member.manage`, verified identity, idempotent hash-only token creation, role boundaries, and redacted audit |
| `POST /v1/invitations/accept` | Phase 2.3 | Implemented as a pre-membership capability; verified-email binding, row lock, one-time consumption, and atomic membership/audit |
| `DELETE /v1/invitations/{invitation_id}` | Phase 2.3 | Implemented; owner/admin + `member.manage`, admin owner-invite restriction, and atomic revocation/audit |
| `PATCH /v1/workspaces/{workspace_id}/members/{member_id}` | Phase 2.3 | Implemented; owner/admin + `member.manage`, owner/last-owner protections, atomic audit |
| `DELETE /v1/workspaces/{workspace_id}/members/{member_id}` | Phase 2.3 | Implemented; owner/admin + `member.manage`, owner/last-owner protections, idempotent soft removal and atomic audit |
| Case list/detail/timeline/rework/cancel and case document metadata | Existing verified Phase 2 surface | Implemented; route-level checks are listed below |
| Forms and immutable versions; intake/uploads and direct document actions | Phase 3 | Not Phase 2 work |
| Review tasks and approvals | Phase 4 | Not Phase 2 work |
| Durable jobs/workers | Phase 5 | Not Phase 2 work |
| AI results and routing | Phases 6–7 | No result-specific public route in the current contract; later-phase work |
| Workflow APIs | Phase 8 | Not Phase 2 work |
| Integrations | Phase 9 | Not Phase 2 work |
| Billing API | No endpoint in API Contract v1.1 | Not applicable |
| Audit read/verify APIs | Contracted governance surface; no Phase 2 route in roadmap | Not a Phase 2 endpoint; Phase 2 still requires audit writes and hash-chain enforcement |

## Protected route coverage

The suite reads the current Fastify route inventory and requires a matching authorization coverage entry for every registered `/v1` method/path. It injects each discovered operation without authentication and expects 401. The current inventory has 13 protected method/path entries; a future protected route fails the route-coverage comparison until explicit coverage is added.

| Registered protected operation | No-auth result | Insufficient permission |
| --- | --- | --- |
| `POST /v1/workspaces` | PASS — 401 | Not applicable to this authenticated-creator operation; authorization helper denial is separately verified as 403 |
| `POST /v1/workspaces/{workspace_id}/members/invitations` | PASS — 401 | PASS — owner/admin and `member.manage`; viewer and admin owner-role boundaries return 403 |
| `POST /v1/invitations/accept` | PASS — 401 | Not role-gated; stale/unverified identity returns 403 and unavailable/mismatched invitation returns 404 |
| `DELETE /v1/invitations/{invitation_id}` | PASS — 401 | PASS — owner/admin and `member.manage`; unknown/consumed/revoked invitations return 404 |
| `GET /v1/workspaces/{workspace_id}/members` | PASS — 401 | PASS — viewer receives 403; owner/admin receive selected-workspace member metadata |
| `PATCH /v1/workspaces/{workspace_id}/members/{member_id}` | PASS — 401 | PASS — viewer receives 403; foreign/unknown member 404; last-owner demotion 409 |
| `DELETE /v1/workspaces/{workspace_id}/members/{member_id}` | PASS — 401 | PASS — viewer receives 403; foreign/unknown member 404; last-owner removal 409 |
| `GET /v1/cases` | PASS — 401 | PASS — 403 without `case.read`; viewer with permission receives only selected-workspace cases |
| `GET /v1/cases/{case_id}` | PASS — 401 | PASS — 403 without `case.read`; own case is readable and foreign case returns 404 |
| `GET /v1/cases/{case_id}/timeline` | PASS — 401 | PASS — 403 without `case.read`; own timeline is readable; foreign and unknown case IDs both return 404 |
| `GET /v1/cases/{case_id}/documents` | PASS — 401 | PASS — 403 without `document.read_sensitive`; authorized response is redacted and foreign/unknown cases return 404 |
| `POST /v1/cases/{case_id}/rework` | PASS — 401 | PASS — 403 without `case.approve`; approver access is authorized, foreign/unknown case IDs return 404 |
| `POST /v1/cases/{case_id}/cancel` | PASS — 401 | PASS — 403 without `case.approve`; approver access is authorized, foreign/unknown case IDs return 404 |

Member responses contain only user ID, role, and status. Owner/admin routes require `member.manage`, and the workspace path must match the authorized tenant. Audit events are transactionally coupled to role changes and soft removals. Tests verify repeat operations do not duplicate events, admins cannot modify/remove owners, and the last active owner cannot be demoted or removed.

The case list also returns safe 404 when the authenticated viewer selects the other workspace. Timeline access requires a valid JWT, active selected-workspace membership, and `case.read`. The response returns only timestamp, correlation ID, and a fixed event label; tests confirm audit payload, actor/object IDs, credentials, document text, full synthetic ID numbers, and policy internals are omitted. Case document listing requires `document.read_sensitive` and returns only document ID, class, processing status, scan result/time, hash availability, retention state/deadline, and timestamps. Tenant-qualified case/document/scan joins ensure the list is scoped to the selected workspace; deleted documents are omitted and a valid case without documents returns an empty list. Tests confirm foreign document rows, filenames, full synthetic IDs, buckets, object keys, OCR/scan details, and object-store secrets are not exposed. Rework and cancellation require `case.approve`, a safe reason and idempotency key, and a legal transition from the database state-transition catalog under a case row lock. Each operation updates status and appends its audit event atomically. Live PostgreSQL tests confirm the transition, exactly one audit event, and replay of the original safe result for the same key/reason; changed-body/key reuse and illegal state transitions return 409. Cancellation returns only case ID, `cancelled`, and correlation ID.

## Foreign identifier coverage

The inventory below separates implemented routes from future-phase operations. No synthetic endpoint was added to simulate an unavailable operation. Foreign-ID behavior is claimed only for live routes with explicit tests.

| Identifier domain | Current contract operations | Status / roadmap scope |
| --- | --- | --- |
| Workspace/member | Create/list/invite/change/remove/accept/revoke | Implemented and tested with restricted bootstrap/acceptance capabilities, workspace RLS, verified identity, hash-only token persistence, atomic audit, and safe 404 behavior |
| Case | List/detail/timeline/rework/cancel | Implemented and tested: JWT, membership, permissions, tenant-scoped access, foreign 404s; state changes are audited/idempotent |
| Case documents | `GET /v1/cases/{case_id}/documents` | Implemented and tested: `document.read_sensitive`, safe metadata projection, redaction, empty list, tenant isolation, unknown/foreign case 404 |
| Document | `/v1/documents/{document_id}`, view-links, reprocess, quarantine, and uploads | Phase 3 intake/file-safety scope or later; not Phase 2 |
| Job | Internal durable job/worker operations | Phase 5; not Phase 2 |
| Result | No result-specific endpoint is defined in API Contract v1.1 | No current public route; AI result/routing work is Phases 6–7 |
| Workflow | `/v1/workflows` and workflow version operations | Phase 8; not Phase 2 |
| Integration | `/v1/integrations/*` and `/v1/integration-interactions/*` | Phase 9; not Phase 2 |
| Billing | No billing endpoint is defined in API Contract v1.1 | Not applicable to current contract |
| Audit | `/v1/audit-events` and audit verification | No Phase 2 read route; Phase 2 requires durable audit writes and hash-chain enforcement |

Foreign identifiers for unavailable operations have no live endpoint against which to verify safe 404 behavior. When a later-phase operation is implemented, its synthetic two-workspace foreign-ID case and safe 404 expectation must be added before that operation is considered covered.

## Database isolation and authorization

- No tenant context under `formiva_app`: query for a seeded tenant template returned zero rows.
- Hand-written `SELECT ... FROM form_templates WHERE id = <other-workspace-template>` under `formiva_app` with workspace A context: zero rows.
- Same app-role query for workspace A's own template: one row.
- Selecting workspace B as the synthetic user who belongs only to workspace A: authorization helper returned safe 404.
- Requiring owner for the synthetic viewer membership in workspace A: authorization helper returned 403.
- Case list issued with workspace A context contains A's synthetic case and not B's; selecting B returns 404.
- Case list requires `case.read`; removing the permission returns 403, and invalid pagination returns 400.
- Case timeline lookup filters on the authorized workspace and case, and only selects timestamp/correlation columns from matching audit events.
- Case document listing requires `document.read_sensitive`; viewer membership without that permission receives 403. Unknown and foreign case IDs both return 404, while a valid case with no non-deleted documents returns an empty list.
- The PostgreSQL-backed document fixture confirms only selected tenant documents are returned; response excludes synthetic full IDs, original filename, bucket/object key, OCR/scan details, and object-store secrets.
- Rework requires `case.approve`; a viewer without the permission receives 403. Missing reason/key returns 400; unsafe full-ID reason is rejected; an illegal state returns 409 without disclosing the state.
- Rework serializes per-case requests with `SELECT ... FOR UPDATE` and workspace-scoped idempotency keys with a transaction advisory lock; same-key/same-case/same-reason retry returns the original result without another state update or audit write; changed reason or case reuse returns 409.
- Cancellation requires `case.approve`; missing auth returns 401, a viewer without permission receives 403, and foreign/unknown cases return identical 404s. Missing/unsafe reason or missing idempotency key returns 400; an illegal transition returns 409 without disclosing the current state.
- Cancellation's live PostgreSQL test verifies a legal `submitted` → `cancelled` transition and exactly one immutable audit record with the reason, actor, correlation ID, state pair, and key fingerprint. Same-key/same-reason replay returns the original correlation ID; changed-body key reuse returns 409. The fixture transaction rolls back after the test.
- Tenant-isolation suite runtime: 5.85 seconds total; test body reported 4.40 seconds.

## Previous validation results — member-management slice (2026-10-06)

All commands ran on 2026-10-06 with the disposable local `DATABASE_URL` configured in the shell:

| Command | Result |
| --- | --- |
| `pnpm --filter @formiva/db run test` | PASS — “Phase 2.1 database tests passed (38 assertion checks)” |
| Source SQL package tests `01_fixtures_and_tests.sql`, `02_queues_roles.sql`, `04_government_documents.sql`, `05_generic_connectors.sql` | PASS — 107 assertions total (50 + 31 + 18 + 8), executed statement-by-statement against the disposable local PostgreSQL database |
| 12-session `03_concurrency.sh` queue-claim race (equivalent Node/pg runner on Windows) | PASS — 10 claims, 10 distinct jobs |
| `pnpm --filter @formiva/api run test` | PASS — 6 files, 21 tests |
| `pnpm exec vitest run tests/security/tenant-isolation.test.ts` | PASS — 1 file, 12 tests; 5.85 seconds total / 4.40 seconds in tests |
| `pnpm run format:check` | PASS |
| `pnpm exec prettier --check tests/security/tenant-isolation.test.ts` | PASS |
| `pnpm run lint` | PASS |
| `pnpm run typecheck` | PASS |
| `pnpm --filter @formiva/api run build` | PASS |
| `git diff --check` | PASS |

The repository lint and format scripts do not include the root-level `tests/security/` path; the security test was separately Prettier-checked and executed by Vitest. This table is the 2026-10-06 member-management baseline; current bootstrap/invitation validation follows.

## Current validation results — bootstrap and invitations (2026-10-09)

All commands ran sequentially in one PowerShell process with `DATABASE_URL=postgresql://formiva_test:formiva_test_only@127.0.0.1:55432/formiva_test`:

| Command | Result |
| --- | --- |
| `pnpm install` | PASS — lockfile up to date |
| `pnpm run format:check` | PASS |
| `pnpm run lint` | PASS |
| `pnpm run typecheck` | PASS |
| `pnpm --filter @formiva/api run build` | PASS |
| `pnpm --filter @formiva/db run test` | PASS — 105 assertion checks |
| `pnpm --filter @formiva/api run test` | PASS — 8 files, 39 tests |
| `pnpm exec vitest run tests/security/tenant-isolation.test.ts` | PASS — 1 file, 12 tests; inventory now covers 13 protected routes |
| `pnpm run verify` | PASS — repository format, lint, typecheck, tests, and build |
| `git diff --check` | PASS |

## Status and follow-up

All 13 currently registered protected routes are included in the auth inventory; the tenant-isolation suite passes 12 tests. The database foundation runner passes 105 assertions, including bootstrap idempotency/replay/conflict/concurrency/rollback, RLS, invitation lifecycle, verified-email mismatch, and concurrent acceptance. The full requested validation sequence passed.

Phase 2 bootstrap/invitation implementation and local validation are complete, but Phase 2 acceptance remains **blocked** until human security and technical reviewers approve ADR-19 and the Phase 2 exit evidence. No Phase 3 work has started.

No production database, real Clerk credentials, or real personal data were used. External invitation delivery and production token delivery remain out of scope and require a separately approved channel.
