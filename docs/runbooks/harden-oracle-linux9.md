# Host Hardening Runbook – Oracle Linux 9

## Purpose
This runbook explains how to execute the `infra/scripts/harden-oracle-linux9.sh` script to securely harden Oracle Linux 9 servers for the Formiva environment.

## Safety & Prerequisites
- **Operator Rights**: `sudo` access to the target VM is required.
- **Lockout Prevention**: **A secondary administrative SSH session must be active** before applying changes to SSH, firewall, or sudo.
- **OCI Console**: Have access to the OCI console terminal as a final fallback if SSH access is lost.

## Usage
1.  **Preparation**: Upload the script and ensure it is executable: `chmod +x harden-oracle-linux9.sh`
2.  **Dry Run** (Default): Execute the script to simulate changes and verify the current system state without modification:
    `./harden-oracle-linux9.sh`
3.  **Apply Hardening**: Apply hardening controls. You will be prompted to confirm a secondary session is active:
    `sudo ./harden-oracle-linux9.sh --apply`
4.  **Security Updates** (Optional): Apply security updates (use with caution):
    `sudo ./harden-oracle-linux9.sh --apply --apply-updates`
5.  **Firewall Configuration** (Optional): By default, firewall configuration is deferred. To explicitly configure:
    `sudo ./harden-oracle-linux9.sh --apply --firewall-mode=configure`

## Controls Implemented
- **SSH**: Root/Password login disabled; Key-based access enforced. Config validated before restart.
- **Sudo**: Syntax validated via `visudo`. Minimal `requiretty` configured via drop-in (`/etc/sudoers.d/formiva`).
- **Firewall**:
    - Default (`defer`): Host firewall protection is pending. Cloudflare Tunnel ingress active but host-level firewall protection is deferred. **Must be enabled before production/sensitive-data use.**
    - `configure` mode: Configures `firewalld` to preserve SSH, validated before reload.
- **Auditd**: Rules configured for sensitive OS events (Auth, Sudoers, PrivEsc, Firewall, Config changes). Only existing paths are audited. Validated via `augenrules`.
- **Updates**: Explicit `--apply-updates` flag required.

## Rollback
If SSH access is lost:
1.  Connect via OCI Console terminal.
2.  Restore the configuration files from the backup directory created during execution: `/etc/formiva/backup/<timestamp>/`.
3.  Restart services (`systemctl restart sshd`).
4.  If firewalld or auditd reload caused issues, reload to last known good configuration.
