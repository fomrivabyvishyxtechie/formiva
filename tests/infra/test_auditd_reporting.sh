#!/bin/bash
# Mock test for auditd rule reporting in harden-oracle-linux9.sh

set -euo pipefail

# Mock environment
MOCK_ROOT="$(mktemp -d)"
MOCK_FORMIVA="$MOCK_ROOT/etc/formiva"
mkdir -p "$MOCK_ROOT/etc/audit/rules.d"
export AUDIT_RULES="$MOCK_ROOT/etc/audit/rules.d/formiva.rules"
export DRY_RUN=false
# Inject mock paths into script via environment if possible,
# or just mock tools
export PATH="$MOCK_ROOT/bin:$PATH"
mkdir -p "$MOCK_ROOT/bin"

# Mock tools
cat <<'EOF' > "$MOCK_ROOT/bin/auditctl"
#!/bin/bash
if [[ "$1" == "-R" ]]; then exit 0; fi
EOF
cat <<'EOF' > "$MOCK_ROOT/bin/augenrules"
#!/bin/bash
exit 0
EOF
chmod +x "$MOCK_ROOT/bin/"*

echo "Testing: Missing optional path (/etc/formiva)..."
output=$(./infra/scripts/harden-oracle-linux9.sh --apply 2>&1 || true)
echo "$output" | grep -q "SKIP: Formiva path (/etc/formiva/) not found; audit rules skipped." || { echo "FAIL: Missing optional path not skipped correctly"; exit 1; }
echo "PASS: Missing optional path reported as SKIP."

echo "Testing: Existing optional path (/etc/formiva)..."
mkdir -p "$MOCK_FORMIVA"
output=$(./infra/scripts/harden-oracle-linux9.sh --apply 2>&1 || true)
echo "$output" | grep -q "PASS: Formiva path (/etc/formiva/) audit rules enabled." || { echo "FAIL: Existing optional path not passed correctly"; exit 1; }
echo "PASS: Existing optional path reported as PASS."

rm -rf "$MOCK_ROOT"
