# Phase 2.4 Tenant-Isolation Verification Evidence

- Date: 2026-10-05
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

The case list also returns safe 404 when the authenticated viewer selects the other workspace. The route inventory at verification time contained no other `/v1` operations.

## Foreign identifier coverage

The approved API contract defines the following areas, but the corresponding operations are not registered in the current API. No synthetic endpoint was added to simulate them. These cases are pending implementation and were not represented as passing 404 tests.

| Identifier domain | Current contract operations | Status |
| --- | --- | --- |
| Case | `GET /v1/cases` | Implemented and tested: JWT auth, matching workspace membership, `case.read`, pagination/status filter, selected-workspace rows only |
| Case | `/v1/cases/{case_id}` and case timeline/rework/cancel | Pending — no case-specific operations registered |
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
- Suite runtime: 1.94 seconds total; test body reported 713 ms.

## Commands and results

All commands ran with the disposable local `DATABASE_URL` configured in the shell:

| Command | Result |
| --- | --- |
| `pnpm exec vitest run tests/security/tenant-isolation.test.ts` | PASS — 1 file, 4 tests |
| `pnpm --filter @formiva/db run test` | PASS — script reported “Phase 2.1 database tests passed”; it does not emit an assertion count |
| `pnpm --filter @formiva/api run test` | PASS — 5 files, 16 tests |
| `pnpm run format:check` | PASS |
| `pnpm exec prettier --check tests/security/tenant-isolation.test.ts` | PASS |
| `pnpm run lint` | PASS |
| Strict NodeNext type check of the root-level security test | PASS |
| `pnpm run typecheck` | PASS |
| `pnpm --filter @formiva/api run build` | PASS |
| `git diff --check` | PASS |

The repository lint and format scripts do not include the root-level `tests/security/` path; the new test was separately Prettier-checked and strict-TypeScript-checked.

## Status and follow-up

Current registered-route tenant-isolation coverage, including `GET /v1/cases`, is verified. Phase 2.4 is not complete for the full planned API surface: foreign case-detail, document, job, workflow, integration, audit, and future billing/result operations remain pending or not applicable until implemented. Do not treat this evidence as full endpoint-level coverage or as a Phase 2 exit sign-off.
