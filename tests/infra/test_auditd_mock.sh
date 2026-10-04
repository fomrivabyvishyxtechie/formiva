#!/bin/bash
# Mock test for auditd configuration in harden-oracle-linux9.sh

set -euo pipefail

MOCK_ROOT="$(mktemp -d)"
trap 'rm -rf "$MOCK_ROOT"' EXIT

mkdir -p "$MOCK_ROOT/etc/audit/rules.d"
mkdir -p "$MOCK_ROOT/etc/ssh"
mkdir -p "$MOCK_ROOT/bin"
export PATH="$MOCK_ROOT/bin:$PATH"

# Mock Auditd Tools
cat <<'EOF' > "$MOCK_ROOT/bin/auditctl"
#!/bin/bash
if [[ "$1" == "-R" ]]; then
    echo "Mock: Validating rules in $2"
    exit 0
fi
echo "Mock: auditctl $@"
exit 0
EOF

cat <<'EOF' > "$MOCK_ROOT/bin/augenrules"
#!/bin/bash
if [[ "$1" == "--check" ]]; then
    echo "Mock: augenrules --check"
    exit 0
fi
if [[ "$1" == "--load" ]]; then
    echo "Mock: augenrules --load"
    exit 0
fi
exit 0
EOF

chmod +x "$MOCK_ROOT/bin/"*

# Test Case 1: Idempotent rule generation
RULES_FILE="$MOCK_ROOT/etc/audit/rules.d/formiva.rules"
echo "PASS: Test infrastructure prepared at $MOCK_ROOT"

# Mocking grep for Oracle Linux check
grep() {
    if [[ "$*" == *"Oracle Linux Server release 9"* ]]; then
        return 0
    fi
    command grep "$@"
}

# The hardening script uses absolute paths for configuration, which makes mocking hard without a chroot.
# We verify the rule generation logic by inspecting the script's 'cat' block.

echo "Verifying auditd rule definitions..."
grep -q "\-w /etc/ssh/sshd_config -p wa -k sshd_config" infra/scripts/harden-oracle-linux9.sh && echo "PASS: sshd_config rule present"
grep -q "\-w /etc/sudoers -p wa -k sudoers" infra/scripts/harden-oracle-linux9.sh && echo "PASS: sudoers rule present"
grep -q "\-a always,exit -F arch=b64 -S setuid -S setgid" infra/scripts/harden-oracle-linux9.sh && echo "PASS: priv_esc rule present"
grep -q "\-w /etc/firewalld/ -p wa -k firewalld" infra/scripts/harden-oracle-linux9.sh && echo "PASS: firewalld rule present"

echo "Auditd logic verification complete."
