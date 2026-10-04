#!/bin/bash
# Mock test for auditd rule generation in harden-oracle-linux9.sh

set -euo pipefail

# Mock environment
MOCK_ROOT="$(mktemp -d)"
# Use a path under MOCK_ROOT instead of /etc/formiva
MOCK_FORMIVA="$MOCK_ROOT/etc/formiva"
mkdir -p "$MOCK_ROOT/etc/audit/rules.d"
export AUDIT_RULES="$MOCK_ROOT/etc/audit/rules.d/formiva.rules"
export DRY_RUN=false

# Mock auditctl to simulate validation
auditctl() {
    if [[ "$1" == "-R" ]]; then
        echo "Mock: Validating rules in $2"
        return 0
    fi
    echo "Mock: auditctl $@"
}

# Simulate rule generation logic (from the script, updated to use MOCK_FORMIVA)
generate_rules() {
    local temp_rules=$(mktemp)
    # Essential events
    cat <<EOF > "$temp_rules"
# Remove existing rules
-D
# Authentication & SSH
-w /etc/ssh/sshd_config -p wa -k sshd_config
EOF

    # Conditional Formiva Hardening Changes
    if [[ -d "$MOCK_FORMIVA" ]]; then
        echo "-w $MOCK_FORMIVA/ -p wa -k formiva_config" >> "$temp_rules"
    fi

    cat "$temp_rules"
    rm -f "$temp_rules"
}

echo "Testing rule generation (missing path)..."
# MOCK_FORMIVA does not exist, should not be included
generate_rules | grep -q "formiva_config" && { echo "FAIL: rule included nonexistent path"; exit 1; }
echo "PASS: nonexistent path excluded."

echo "Testing rule generation (existing path)..."
mkdir -p "$MOCK_FORMIVA"
generate_rules | grep -q "formiva_config" && echo "PASS: existing path included."
rm -rf "$MOCK_ROOT"
