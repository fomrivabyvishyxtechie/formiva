# Changelog

All meaningful engineering changes should be summarized here.

## Unreleased

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
