# Phase 2.4 Tenant-Isolation Verification Evidence

- Date: 2026-10-06
- Scope: currently implemented authenticated API operations and database tenant isolation
- Database: ephemeral local PostgreSQL 16, `formiva_test` on `127.0.0.1:55432`
- Fixtures: two synthetic workspaces, one synthetic viewer membership, and tenant-owned form/case rows
- Result: all applicable current-surface tests passed; unimplemented contract operations remain pending
- No applied migrations were modified. No OCI, production database, Clerk credential, or real personal data was used.

## Implemented route coverage

The suite reads the current Fastify route inventory and requires a matching authorization coverage entry for every registered `/v1` method/path. It injects each discovered operation without authentication and expects 401. A future protected route fails the route-coverage comparison until explicit coverage is added.

| Registered protected operation | No-auth result | Insufficient permission |
| --- | --- | --- |
| `POST /v1/workspaces` | PASS — 401 | Not applicable to this authenticated-creator operation; authorization helper denial is separately verified as 403 |
| `GET /v1/cases` | PASS — 401 | PASS — 403 without `case.read`; viewer with permission receives only selected-workspace cases |
| `GET /v1/cases/{case_id}` | PASS — 401 | PASS — 403 without `case.read`; own case is readable and foreign case returns 404 |
| `GET /v1/cases/{case_id}/timeline` | PASS — 401 | PASS — 403 without `case.read`; own timeline is readable; foreign and unknown case IDs both return 404 |
| `POST /v1/cases/{case_id}/rework` | PASS — 401 | PASS — 403 without `case.approve`; approver access is authorized, foreign/unknown case IDs return 404 |

The case list also returns safe 404 when the authenticated viewer selects the other workspace. Timeline access requires a valid JWT, active selected-workspace membership, and `case.read`. The response returns only timestamp, correlation ID, and a fixed event label; tests confirm audit payload, actor/object IDs, credentials, document text, full synthetic ID numbers, and policy internals are omitted. Rework requires a safe reason and idempotency key, checks the database state-transition catalog under a case row lock, then updates the status and appends the audit event atomically. The live PostgreSQL test confirms one durable transition and audit event; same-key/same-reason retries return the original result without a duplicate event. Changed-body or cross-case key reuse and illegal state transitions return 409.

## Foreign identifier coverage

The approved API contract defines the following areas, but the corresponding operations are not registered in the current API. No synthetic endpoint was added to simulate them. These cases are pending implementation and were not represented as passing 404 tests.

| Identifier domain | Current contract operations | Status |
| --- | --- | --- |
| Case | `GET /v1/cases` | Implemented and tested: JWT auth, matching workspace membership, `case.read`, pagination/status filter, selected-workspace rows only |
| Case | `GET /v1/cases/{case_id}` | Implemented and tested: JWT, membership, `case.read`, tenant-scoped lookup, foreign-case 404 |
| Case | `GET /v1/cases/{case_id}/timeline` | Implemented and tested: JWT, membership, `case.read`, correlation-linked redacted projection, foreign-case 404 |
| Case | `POST /v1/cases/{case_id}/rework` | Implemented and tested: `case.approve`, safe reason, legal `review_queued` transition, atomic audit event, idempotent replay, foreign/unknown 404 |
| Case | `POST /v1/cases/{case_id}/cancel` | Pending — not implemented |
| Document | `/v1/documents/{document_id}` and case documents/view-links/reprocess/quarantine | Pending — no document routes registered |
| Job | Internal `/v1/ai/jobs` | Pending — no AI job route registered |
| Result | No result-specific endpoint is defined in API Contract v1.1 | Not applicable to current contract; result data has no registered route |
| Workflow | `/v1/workflows` and workflow version operations | Pending — no workflow routes registered |
| Integration | `/v1/integrations/*` and `/v1/integration-interactions/*` | Pending — no integration routes registered |
| Billing | No billing endpoint is defined in API Contract v1.1 | Not applicable to current contract; no billing route registered |
| Audit | `/v1/audit-events` and audit verification | Pending — no audit routes registered |

Foreign identifiers for these unavailable operations have no live endpoint against which to verify safe 404 behavior. When an operation is implemented, its synthetic two-workspace foreign-ID case and safe 404 expectation must be added to this suite before that operation is considered covered.

## Database isolation and authorization

- No tenant context under `formiva_app`: query for a seeded tenant template returned zero rows.
- Hand-written `SELECT ... FROM form_templates WHERE id = <other-workspace-template>` under `formiva_app` with workspace A context: zero rows.
- Same app-role query for workspace A's own template: one row.
- Selecting workspace B as the synthetic user who belongs only to workspace A: authorization helper returned safe 404.
- Requiring owner for the synthetic viewer membership in workspace A: authorization helper returned 403.
- Case list issued with workspace A context contains A's synthetic case and not B's; selecting B returns 404.
- Case list requires `case.read`; removing the permission returns 403, and invalid pagination returns 400.
- Case timeline lookup filters on the authorized workspace and case, and only selects timestamp/correlation columns from matching audit events.
- Rework requires `case.approve`; a viewer without the permission receives 403. Missing reason/key returns 400; unsafe full-ID reason is rejected; an illegal state returns 409 without disclosing the state.
- Rework serializes per-case requests with `SELECT ... FOR UPDATE` and workspace-scoped idempotency keys with a transaction advisory lock; same-key/same-case/same-reason retry returns the original result without another state update or audit write; changed reason or case reuse returns 409.
- Tenant-isolation suite runtime: 3.01 seconds total; test body reported 1.78 seconds.

## Commands and results

All commands ran with the disposable local `DATABASE_URL` configured in the shell:

| Command | Result |
| --- | --- |
| `pnpm exec vitest run tests/security/tenant-isolation.test.ts` | PASS — 1 file, 7 tests |
| `pnpm --filter @formiva/db run test` | PASS — script reported “Phase 2.1 database tests passed”; it does not emit an assertion count |
| `pnpm --filter @formiva/api run test` | PASS — 6 files, 21 tests |
| `pnpm run format:check` | PASS |
| `pnpm exec prettier --check tests/security/tenant-isolation.test.ts` | PASS |
| `pnpm run lint` | PASS |
| `pnpm run typecheck` | PASS |
| `pnpm --filter @formiva/api run build` | PASS |
| `git diff --check` | PASS |

The repository lint and format scripts do not include the root-level `tests/security/` path; the security test was separately Prettier-checked and executed by Vitest. An extra direct ESLint invocation could not lint this file because the configured project service excludes it, and an ad hoc standalone TypeScript invocation reported diagnostics on unchanged portions of the existing security test. The required workspace lint/typecheck commands passed.

## Status and follow-up

Current registered-route tenant-isolation coverage, including case list, detail, timeline, and rework, is verified after the checks recorded above. Phase 2.4 is not complete for the full planned API surface: document, job, workflow, integration, audit, and future billing/result operations remain pending or not applicable until implemented. Do not treat this evidence as full endpoint-level coverage or as a Phase 2 exit sign-off.
