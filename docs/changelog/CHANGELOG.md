# Changelog

All meaningful engineering changes should be summarized here.

## Unreleased

- Implemented tenant-scoped `GET /v1/cases/{case_id}/timeline` with JWT, workspace membership, `case.read`, correlation-linked redacted output, and two-workspace authorization coverage; see the updated Phase 2.4 evidence and 2026-10-06 case-timeline update.
- Implemented the first Phase 2 tenant-scoped resource read: `GET /v1/cases`, protected by JWT, workspace membership, `case.read`, tenant context, and RLS; added two-workspace integration coverage. Remaining resource domains are tracked in the Phase 2.4 evidence and 2026-10-05 engineering update.
- Added the Phase 2.4 tenant-isolation suite for registered API routes and app-role RLS checks. The current route and database checks pass; unimplemented contract operations are documented as pending/not applicable in `docs/evidence/phase-2/phase-2-4-tenant-isolation.md`.
- Hardened API Clerk configuration: missing configuration now fails startup outside test, and synthetic auth bypass is gated on both `NODE_ENV=test` and explicit `testMode`.
- Updated workspace authentication to use the typed authenticated identity and added coverage for missing configuration, disabled production test mode, unauthenticated requests, and synthetic workspace requests.
- Verified Phase 2.3 against disposable local PostgreSQL 16: database tests passed, all 16 API tests passed, and format, lint, typecheck, API build, and `git diff --check` passed. See `docs/evidence/phase-2/phase-2-3-verification.md`.
- Implemented the Phase 2.2 Fastify auth plugin: Clerk JWT verification, database-backed workspace membership/role checks, selector-only workspace headers, and tenant-scoped transaction callbacks.
- Fixed repository-wide formatting issues in `packages/db/test/foundation.test.ts`.
- Added synthetic auth tests covering missing/expired tokens, invalid issuer/audience/authorized party, unknown identity, foreign workspace, insufficient role, and valid membership.
- Implemented Phase 2.1 Database Foundation: migration runner with checksums and tenant-scoped transaction helper.
- Verified Phase 2.1 against ephemeral local PostgreSQL 16: migration ordering/reruns/checksum rejection, rollback, tenant context and cleanup, RLS isolation, and runtime-role privileges all pass.
- Added Phase 1.1 Formiva API foundation: Fastify /healthz endpoint, safe environment validation, contract schemas, redaction helpers, and focused verification tests.
- Implemented VM1 and VM2 Docker Compose definitions with security hardening.
- Implemented robust host hardening for Oracle Linux 9 (Phase 1.3):
    - Safety confirmation and robust SSH session detection under sudo.
    - Idempotency with dry-run default.
    - Flexible firewall management (`defer` vs `configure`) for Cloudflare Tunnel compatibility.
    - Automatic backups with rollback on failure.
    - Configuration validation (SSHD, Sudoers, Firewalld, Auditd).
    - Explicit security update application.
    - Comprehensive auditd rules for sensitive OS events.
- Updated documentation and runbooks for host hardening.
- Implemented CI pipeline (Phase 1.4) with robust security and infrastructure validation.
