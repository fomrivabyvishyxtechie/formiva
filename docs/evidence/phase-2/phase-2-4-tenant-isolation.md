# Phase 2.4 Tenant-Isolation Verification Evidence

- Date: 2026-10-06
- Scope: currently implemented authenticated API operations and database tenant isolation
- Database: ephemeral local PostgreSQL 16, `formiva_test` on `127.0.0.1:55432`
- Fixtures: two synthetic workspaces, viewer/approver/owner/admin memberships, tenant-owned form/case rows, and synthetic documents/scan data
- Result: 10 registered protected routes have authorization coverage; 12 tenant-isolation tests and the complete validation checklist passed
- No applied migrations were modified. No OCI, production database, Clerk credential, or real personal data was used.

## Phase 2 scope inventory

| Domain/operation | Roadmap phase | Status |
| --- | --- | --- |
| Database migrations, RLS, `withTenant()`, JWT/member authorization | Phase 2 | Implemented; see database and tenant checks below |
| `POST /v1/workspaces` | Phase 2.3 | Route exists but is not operational: creators without membership fail membership resolution; existing members cannot insert a distinct workspace under `workspace_self` RLS, and `app.bootstrap_workspace` requires the new workspace as current context |
| `GET /v1/workspaces/{workspace_id}/members` | Phase 2.3 | Implemented; owner/admin + `member.manage`, selected-tenant rows only |
| `POST /v1/workspaces/{workspace_id}/members/invitations` | Phase 2.3 | Blocked pending an approved invitation lifecycle/schema: no invitation token/reference, expiry, or acceptance operation exists |
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

## Implemented route coverage

The suite reads the current Fastify route inventory and requires a matching authorization coverage entry for every registered `/v1` method/path. It injects each discovered operation without authentication and expects 401. The current inventory has 10 protected method/path entries; a future protected route fails the route-coverage comparison until explicit coverage is added.

| Registered protected operation | No-auth result | Insufficient permission |
| --- | --- | --- |
| `POST /v1/workspaces` | PASS — 401 | Not applicable to this authenticated-creator operation; authorization helper denial is separately verified as 403 |
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
| Workspace/member | Create/list/invite/change/remove | List/change/remove implemented; create and invite remain Phase 2.3 blockers due to bootstrap RLS/context mismatch and missing invitation lifecycle |
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

## Current validation results — member-management slice

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

The repository lint and format scripts do not include the root-level `tests/security/` path; the security test was separately Prettier-checked and executed by Vitest. The API suite passed all 21 tests and the tenant-isolation suite passed all 12 tests.

## Status and follow-up

Current registered-route tenant-isolation coverage has 10 protected routes and 12 passing security tests. The SQL source-package suite passed 107 assertions plus the 12-session 10/10 claim race. The separately invoked `pnpm --filter @formiva/db run test` foundation runner reports 38 assertion checks. This reconciles the older 107/99/81 counts: 107 is the current source-package SQL suite result, while 81/99 are stale.

Phase 2 is **not complete**. Prompt 2.3 still requires workspace creation and invitations, but workspace bootstrap is incompatible with current membership resolution/RLS context and the invitation schema has no acceptance lifecycle. The required technical reviewer has not signed this evidence. These blockers require approved design decisions; do not change applied migrations or proceed to Phase 3 as a workaround.

The workspace bootstrap conflict was confirmed against the disposable database with synthetic identities: a non-member creator resolves to zero workspaces, and an existing member inserting a distinct workspace under the app role is rejected by RLS (`42501`). This confirms the blocker without changing data or migrations.
