#!/bin/bash
# Test firewall mode logic for harden-oracle-linux9.sh

set -euo pipefail

SCRIPT="infra/scripts/harden-oracle-linux9.sh"

test_firewall() {
    local args="$1"
    local expected_msg="$2"
    local description="$3"

    echo -n "Testing: $description ($args)... "
    output=$(bash "$SCRIPT" $args 2>&1 || true)

    if [[ "$output" == *"$expected_msg"* ]]; then
        echo "PASSED"
        return 0
    else
        echo "FAILED (Expected '$expected_msg' in output, got: $output)"
        return 1
    fi
}

# 1. Default (defer)
test_firewall "--dry-run" "Host firewall protection is PENDING" "Default mode (defer)"

# 2. Explicit defer
test_firewall "--dry-run --firewall-mode=defer" "Host firewall protection is PENDING" "Explicit defer"

# 3. Configure mode in dry-run (should fail logic)
test_firewall "--dry-run --firewall-mode=configure" "FAIL: --firewall-mode=configure requires --apply" "Configure mode in dry-run"

# 4. Invalid mode
test_firewall "--dry-run --firewall-mode=invalid" "Invalid firewall mode: invalid" "Invalid mode"

echo "All firewall logic tests completed."
