# Formiva Phase 2 Continuation Note

Updated: 2026-10-06

## Current position

Continue Phase 2 only. Do not start Phase 3.

- Phase 2.1–2.3 database, authentication, workspace, and auth-configuration work is implemented.
- Phase 2.4 tenant-isolation suite exists and passes against the current API surface.
- First tenant-scoped resource operation is implemented: `GET /v1/cases` in `apps/api/src/routes/cases.ts`. It requires a verified Clerk JWT, membership-matched `X-Workspace-Id`, `case.read`, and `request.withTenant()`. SQL also filters on the authorized workspace.
- Synthetic two-workspace tests cover case list isolation, foreign workspace 404, missing auth 401, insufficient permission 403, invalid pagination, no-context zero rows, app-role RLS, and route coverage inventory.
- The API does not yet implement case detail/timeline/actions, documents, jobs, workflows, integrations, or audit endpoints. The schema has `ai_results` and billing tables, but API Contract v1.1 defines no standalone result or billing endpoint.
- Phase 2 is **not complete**. No commit was made.

## Last verification

All passed with the disposable local PostgreSQL 16 test database:

- `pnpm --filter @formiva/db run test`
- `pnpm --filter @formiva/api run test` — 5 files, 16 tests
- `pnpm exec vitest run tests/security/tenant-isolation.test.ts` — 1 file, 4 tests
- `pnpm run format:check`
- `pnpm run lint`
- `pnpm run typecheck`
- `pnpm --filter @formiva/api run build`
- `git diff --check`

The repository lint/format scripts do not include root-level `tests/security/`; the security test has direct Prettier and strict TypeScript checks.

## Credentials and environment

Do not put credentials in this note, source control, test fixtures, or logs. The only database needed for Phase 2 verification is the disposable local PostgreSQL 16 database (`formiva_test` on loopback port `55432`). Set its approved test-only `DATABASE_URL` in the shell for the test process; obtain the current value from the user/local secure environment rather than assuming it persists. Never request or use OCI, production database, production Clerk, or real personal-data credentials for this work. Auth integration tests generate synthetic signing keys at runtime.

## Next task

Implement only `GET /v1/cases/{case_id}` using the approved API contract and existing `cases` schema. Require verified JWT, membership-matched workspace selector, `case.read`, and `request.withTenant()`. Query by both case ID and tenant context; return the contract-safe 404 for absent/foreign cases without revealing existence. Add synthetic two-workspace integration coverage for own case, foreign case 404, no auth 401, and insufficient permission 403. Do not modify applied migrations unless strictly necessary and approved.

Afterward, rerun the DB tests, API tests, tenant-isolation suite, formatting, lint, typecheck, API build, and `git diff --check`. Update Phase 2 evidence to reflect only implemented, tested endpoints. Continue one resource at a time; do not claim all of Phase 2 complete until required domains have coverage.

## Source files

- `HANDOFF.md`
- `CLAUDE.md`
- `docs/roadmap/Formiva_Master_Build_Roadmap.md`, sections 7.2–7.3
- `docs/api/Formiva_API_Contract_v1.1.md`
- `packages/db/migrations/`
- `apps/api/src/auth.ts`
- `packages/db/src/with-tenant.ts`
- `packages/db/src/with-authorized-tenant.ts`
- `tests/security/tenant-isolation.test.ts`
- `docs/evidence/phase-2/phase-2-4-tenant-isolation.md`
- `docs/updates/2026-10-05-phase-2-case-list.md`
