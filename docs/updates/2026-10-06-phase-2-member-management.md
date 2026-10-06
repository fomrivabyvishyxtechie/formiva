# Update: Phase 2 Workspace Member Management

## Date
2026-10-06

## Summary
Implemented tenant-scoped workspace member listing, role changes, and removal.

## Why
Roadmap Prompt 2.3 requires workspace member operations to use authorized tenant context, protect the last owner, audit changes, and have two-workspace integration coverage.

## Files/areas changed
- Added Zod path, request, and response validation for member management.
- Added owner/admin routes for member listing, role changes, and soft removal. Every operation requires `member.manage` and uses `request.withTenant()`.
- Serialized owner-sensitive changes, prevented admins from modifying owner memberships, protected the last active owner, and wrote audit events atomically with changes.
- Extended the synthetic two-workspace security suite and protected-route inventory.
- Updated the API contract, Phase 2 evidence inventory, and changelog.

## Tests/checks
- `pnpm --filter @formiva/db run test`: passed; script emitted “Phase 2.1 database tests passed (38 assertion checks)”.
- Source SQL package tests (`01_fixtures_and_tests.sql`, `02_queues_roles.sql`, `04_government_documents.sql`, `05_generic_connectors.sql`): passed, 107 assertions total.
- 12-session queue-claim concurrency race: passed, 10 jobs claimed once each.
- `pnpm --filter @formiva/api run test`: passed, 6 files / 21 tests.
- `pnpm exec vitest run tests/security/tenant-isolation.test.ts`: passed, 1 file / 12 tests; 5.85 seconds total / 4.40 seconds in tests.
- `pnpm run format:check`: passed.
- `pnpm exec prettier --check tests/security/tenant-isolation.test.ts`: passed.
- `pnpm run lint`: passed.
- `pnpm run typecheck`: passed.
- `pnpm --filter @formiva/api run build`: passed.
- `git diff --check`: passed.

## Security considerations
Member queries are constrained to the selected workspace and RLS. Foreign and unknown member IDs return 404. Responses omit email and other profile data. Owner-sensitive changes are serialized; only an owner may change/remove an owner, and the last active owner cannot be demoted or removed. Audit events are written in the same transaction as successful state changes. Repeating an unchanged operation does not duplicate the audit event.

## Migration/deployment notes
No migrations were added or changed. Workspace bootstrap and invitations remain blocked on approved schema/authorization design; see the Phase 2 evidence. No protected files were edited.

## Remaining risks
The existing workspace creation route cannot bootstrap a new creator under current membership lookup, RLS, and `app.bootstrap_workspace` context requirements. `workspace_members.status = 'invited'` is insufficient for invitations without a durable invitation/acceptance flow. The Phase 2 reviewer sign-off is also outstanding.
