#!/bin/bash
# Harden Oracle Linux 9
# Idempotent, --dry-run supported

set -euo pipefail

# Configuration
DRY_RUN=true
APPLY_UPDATES=false
BACKUP_DIR="/etc/formiva/backup/$(date +%Y%m%d_%H%M%S)"

# Help/Usage
show_help() {
    echo "Usage: sudo $0 [--dry-run | --apply] [--apply-updates]"
    echo "  --dry-run        (Default) Simulate actions without changes."
    echo "  --apply          Actually apply hardening changes (requires safety confirmation)."
    echo "  --apply-updates  Also apply package security updates (requires --apply)."
    exit 0
}

# Parse Args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --apply) DRY_RUN=false; shift ;;
        --apply-updates) APPLY_UPDATES=true; shift ;;
        --help) show_help ;;
        *) echo "Unknown option: $1"; show_help ;;
    esac
done

# OS Validation
if ! grep -q "Oracle Linux Server release 9" /etc/oracle-release 2>/dev/null; then
    echo "FAIL: OS is not Oracle Linux 9."
    exit 1
fi

# Safety Checks
if [[ "$DRY_RUN" == false ]]; then
    if [[ $EUID -ne 0 ]]; then
        echo "FAIL: Must run as root to apply changes."
        exit 1
    fi
    # SSH Operator Safety
    if [[ -z "${SSH_CONNECTION:-}" ]]; then
        echo "FAIL: Not running over SSH. Hardening aborted to prevent lockout."
        exit 1
    fi
    echo "WARNING: Applying hardening to the host."
    read -p "Have you verified a secondary administrative SSH session? [y/N]: " confirm
    if [[ "$confirm" != "y" ]]; then
        echo "Aborted."
        exit 1
    fi
    mkdir -p "$BACKUP_DIR"
fi

# Helpers
log_pass() { echo "PASS: $1"; }
log_fail() { echo "FAIL: $1"; exit 1; }

backup_file() {
    local file=$1
    if [[ "$DRY_RUN" == false && -f "$file" ]]; then
        cp "$file" "$BACKUP_DIR/$(basename "$file")"
        echo "Backup of $file created in $BACKUP_DIR"
    fi
}

restore_file() {
    local file=$1
    if [[ -f "$BACKUP_DIR/$(basename "$file")" ]]; then
        cp "$BACKUP_DIR/$(basename "$file")" "$file"
        echo "Restored $file from backup."
    fi
}

# Control: SSH Configuration
echo "Configuring SSH..."
SSHD_CONF="/etc/ssh/sshd_config"
backup_file "$SSHD_CONF"

declare -A ssh_changes=(
    ["PermitRootLogin"]="PermitRootLogin no"
    ["PasswordAuthentication"]="PasswordAuthentication no"
    ["PubkeyAuthentication"]="PubkeyAuthentication yes"
)

for key in "${!ssh_changes[@]}"; do
    if grep -q "^#*$key" "$SSHD_CONF"; then
        if [[ "$DRY_RUN" == false ]]; then
            sed -i "s/^#*$key.*/${ssh_changes[$key]}/" "$SSHD_CONF"
        fi
        echo "SKIP: $key already configured (verified in dry-run)."
    else
        if [[ "$DRY_RUN" == false ]]; then
            echo "${ssh_changes[$key]}" >> "$SSHD_CONF"
        fi
        echo "PASS: $key added."
    fi
done

if [[ "$DRY_RUN" == false ]]; then
    if ! sshd -t; then
        echo "FAIL: SSHD config invalid. Rolling back."
        restore_file "$SSHD_CONF"
        exit 1
    fi
    systemctl restart sshd
fi
log_pass "SSH hardened."

# Control: Sudo Configuration
echo "Configuring Sudo..."
SUDOERS_FILE="/etc/sudoers.d/formiva"
if [[ "$DRY_RUN" == false ]]; then
    echo "Defaults requiretty" > "$SUDOERS_FILE"
    chmod 0440 "$SUDOERS_FILE"
    if ! visudo -c -f "$SUDOERS_FILE"; then
        echo "FAIL: Sudoers config invalid. Rolling back."
        rm -f "$SUDOERS_FILE"
        exit 1
    fi
fi
log_pass "Sudoers drop-in configured."

# Control: Firewall (firewalld)
echo "Configuring Firewalld..."
if command -v firewall-cmd >/dev/null; then
    if [[ "$DRY_RUN" == false ]]; then
        # Preserve SSH
        firewall-cmd --permanent --add-service=ssh
        if ! firewall-cmd --check-config; then
            echo "FAIL: Firewalld config invalid. Rolling back."
            firewall-cmd --reload # Reload to last known good
            exit 1
        fi
        firewall-cmd --reload
    fi
    log_pass "Firewalld configured."
else
    echo "SKIP: firewalld not installed."
fi

# Control: Auditd
echo "Configuring Auditd..."
AUDIT_RULES="/etc/audit/rules.d/formiva.rules"
if command -v auditctl >/dev/null; then
    if [[ "$DRY_RUN" == false ]]; then
        backup_file "$AUDIT_RULES" || true
        # Essential events for Oracle Linux 9
        cat <<EOF > "$AUDIT_RULES"
# Remove existing rules
-D
# Buffer size
-b 8192
# Failure mode: 1=log, 2=panic
-f 1

# Authentication & SSH
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/security/opasswd -p wa -k identity

# Sudoers
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d/ -p wa -k sudoers

# Privilege Escalation
-a always,exit -F arch=b64 -S setuid -S setgid -S setreuid -S setregid -k priv_esc

# Firewall
-w /etc/firewalld/ -p wa -k firewalld

# Service/Unit Changes
-w /usr/lib/systemd/system/ -p wa -k systemd
-w /etc/systemd/system/ -p wa -k systemd

# Formiva Hardening Changes
-w /infra/scripts/harden-oracle-linux9.sh -p wa -k formiva_harden
-w /etc/formiva/ -p wa -k formiva_config
EOF
        if ! augenrules --check; then
            echo "FAIL: Audit rules invalid. Rolling back."
            restore_file "$AUDIT_RULES" || rm -f "$AUDIT_RULES"
            exit 1
        fi
        augenrules --load
    fi
    log_pass "Auditd configured."
else
    echo "SKIP: auditd (auditctl) not installed."
fi

# Control: Security Updates
if [[ "$APPLY_UPDATES" == true ]]; then
    if [[ "$DRY_RUN" == false ]]; then
        dnf update --security -y
        log_pass "Security updates applied."
    else
        echo "SKIP: Updates not applied (dry-run)."
    fi
else
    echo "SKIP: Security updates disabled."
fi

echo "Hardening complete. DRY_RUN=$DRY_RUN"
