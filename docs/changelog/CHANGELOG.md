# Changelog

All meaningful engineering changes should be summarized here.

## Unreleased

- Initial Claude Full-Stack Engineering OS setup.
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
