#!/bin/bash
# Harden Oracle Linux 9
# Idempotent, --dry-run supported

set -euo pipefail

# Configuration
DRY_RUN=true
APPLY_UPDATES=false
FIREWALL_MODE="defer"
BACKUP_DIR="/etc/formiva/backup/$(date +%Y%m%d_%H%M%S)"

# Help/Usage
show_help() {
    echo "Usage: sudo $0 [--dry-run | --apply] [--apply-updates] [--firewall-mode=defer|configure]"
    echo "  --dry-run        (Default) Simulate actions without changes."
    echo "  --apply          Actually apply hardening changes (requires safety confirmation)."
    echo "  --apply-updates  Also apply package security updates (requires --apply)."
    echo "  --firewall-mode  'defer' (default) or 'configure' (requires --apply)."
    exit 0
}

# Parse Args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --apply) DRY_RUN=false; shift ;;
        --apply-updates) APPLY_UPDATES=true; shift ;;
        --firewall-mode=*) FIREWALL_MODE="${1#*=}"; shift ;;
        --help) show_help ;;
        *) echo "FAIL: Unknown option: $1"; show_help; exit 1 ;;
    esac
done

# Validate Argument Logic
if [[ "$APPLY_UPDATES" == true && "$DRY_RUN" == true ]]; then
    echo "FAIL: --apply-updates requires --apply and cannot be used in dry-run mode."
    exit 1
fi
if [[ "$FIREWALL_MODE" == "configure" && "$DRY_RUN" == true ]]; then
    echo "FAIL: --firewall-mode=configure requires --apply and cannot be used in dry-run mode."
    exit 1
fi

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
    IS_SSH=false
    if [[ -n "${XDG_SESSION_ID:-}" ]]; then
        if [[ "$(loginctl show-session "${XDG_SESSION_ID}" -p Remote --value 2>/dev/null)" == "yes" ]]; then
            IS_SSH=true
        fi
    fi
    if [[ "$IS_SSH" == false ]]; then
        TTY=$(readlink /proc/self/fd/0 2>/dev/null | sed 's|^/dev/||' || echo "unknown")
        if who | grep -qE "^.*$TTY.*\(.*\).*$"; then
            IS_SSH=true
        fi
    fi

    if [[ "$IS_SSH" == false ]]; then
        echo "FAIL: Not running over SSH or SSH session not detectable. Hardening aborted."
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
log_warn() { echo "WARN: $1"; }
log_skip() { echo "SKIP: $1"; }

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
echo "Configuring Firewall (Mode: $FIREWALL_MODE)..."
if [[ "$FIREWALL_MODE" == "defer" ]]; then
    log_warn "Host firewall protection is PENDING. Cloudflare Tunnel ingress active but host-level firewall protection is deferred."
elif [[ "$FIREWALL_MODE" == "configure" ]]; then
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
        log_fail "Firewalld not installed, but configure mode requested."
    fi
else
    log_fail "Invalid firewall mode: $FIREWALL_MODE"
fi

# Control: Auditd
echo "Configuring Auditd..."
AUDIT_RULES="/etc/audit/rules.d/formiva.rules"
FORMIVA_DIR="/etc/formiva"

if command -v auditctl >/dev/null; then
    # Base mandatory rules
    if [[ "$DRY_RUN" == false ]]; then
        backup_file "$AUDIT_RULES" || true
        TEMP_RULES=$(mktemp)

        cat <<EOF > "$TEMP_RULES"
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
EOF

        # Optional Formiva path rules
        if [[ -d "$FORMIVA_DIR" ]]; then
            echo "-w $FORMIVA_DIR/ -p wa -k formiva_config" >> "$TEMP_RULES"
        fi

        # Validate before loading
        if ! auditctl -R "$TEMP_RULES" 2>/dev/null; then
             echo "FAIL: Generated audit rules invalid. Rolling back."
             rm -f "$TEMP_RULES"
             exit 1
        fi

        # Apply
        mv "$TEMP_RULES" "$AUDIT_RULES"
        augenrules --load
    fi
    log_pass "Host auditd rules loaded."

    # Report on optional rules
    if [[ -d "$FORMIVA_DIR" ]]; then
        log_pass "Formiva path (/etc/formiva/) audit rules enabled."
    else
        log_skip "Formiva path (/etc/formiva/) not found; audit rules skipped."
    fi
else
    log_skip "auditd (auditctl) not installed."
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
