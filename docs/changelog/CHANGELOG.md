# Changelog

All meaningful engineering changes should be summarized here.

## Unreleased

- Initial Claude Full-Stack Engineering OS setup.
- Added Phase 1.1 Formiva API foundation: Fastify /healthz endpoint, safe environment validation, contract schemas, redaction helpers, and focused verification tests.
- Implemented VM1 and VM2 Docker Compose definitions with security hardening.
- Implemented robust host hardening for Oracle Linux 9 (Phase 1.3) with:
    - Safety confirmation (secondary SSH session check).
    - Idempotency with dry-run default.
    - Automatic backups with rollback on failure.
    - Configuration validation (SSHD, Sudoers, Firewalld).
    - Explicit security update application.
    - Minimal auditd implementation.
- Updated documentation and runbooks for host hardening.
