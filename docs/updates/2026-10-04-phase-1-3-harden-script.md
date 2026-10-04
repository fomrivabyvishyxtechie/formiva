# Update: Phase 1.3 Host Hardening Script
Date: 2026-10-04

## Summary
Completed implementation of `infra/scripts/harden-oracle-linux9.sh` for Oracle Linux 9. The script now includes robust safety checks, idempotent configuration management, comprehensive auditing, and flexible firewall management to accommodate Cloudflare Tunnel deployments.

## Why
Phase 1.3 requires a secure, automated, and idempotent baseline for host hardening. Flexible firewall management is necessary where Cloudflare Tunnel handles ingress, but host-level protection must remain an explicit requirement for production.

## Files changed
- `infra/scripts/harden-oracle-linux9.sh`
- `docs/runbooks/harden-oracle-linux9.md`
- `docs/changelog/CHANGELOG.md`
- `tests/infra/test_firewall.sh` (new)
- `tests/infra/test_ssh_detection.sh` (new)
- `tests/infra/test_args.sh` (new)

## Tests/checks
- `bash -n` confirmed.
- Mocked tests for argument parsing, SSH session detection, and firewall logic.
- Dry-run mode verified as the default safety behavior.
- Configuration validation (`sshd -t`, `visudo -c`, `firewall-cmd --check-config`, `augenrules --check`) implemented.
- Backup and restore logic implemented for critical configurations.

## Security considerations
- SSH: Disabled root and password authentication; enforced Key-based SSH.
- Safety: Mandatory secondary SSH session confirmation; fail-closed if not on SSH.
- Firewall: Default to `defer` mode with WARN reporting; explicit `configure` mode required for host-level protection.
- Auditd: Monitored authentication, privilege escalation, and configuration changes.
- Updates: Explicit security-only updates application.

## Remaining risks/follow-ups
- Perform end-to-end verification in a non-production disposable OCI VM.
- Host firewall (`firewalld`) must be explicitly enabled before any sensitive-data pilot or production use, even with Cloudflare Tunnels.
