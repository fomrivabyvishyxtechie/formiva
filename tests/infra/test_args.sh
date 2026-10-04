#!/bin/bash
# Test argument parsing logic for harden-oracle-linux9.sh

set -euo pipefail

SCRIPT="infra/scripts/harden-oracle-linux9.sh"

test_arg() {
    local args="$1"
    local expected_msg="$2"
    local description="$3"

    echo -n "Testing: $description ($args)... "
    # We want to check output messages
    output=$(bash "$SCRIPT" $args 2>&1 || true)

    if [[ "$output" == *"$expected_msg"* ]]; then
        echo "PASSED"
        return 0
    else
        echo "FAILED (Expected '$expected_msg' in output, got: $output)"
        return 1
    fi
}

# 1. No arguments (should trigger OS check failure, which is past arg parsing)
test_arg "" "FAIL: OS is not Oracle Linux 9" "No arguments"

# 2. --dry-run
test_arg "--dry-run" "FAIL: OS is not Oracle Linux 9" "--dry-run"

# 3. --apply
test_arg "--apply" "FAIL: OS is not Oracle Linux 9" "--apply"

# 4. --apply --apply-updates
test_arg "--apply --apply-updates" "FAIL: OS is not Oracle Linux 9" "--apply --apply-updates"

# 5. --apply-updates alone (should fail logic)
test_arg "--apply-updates" "FAIL: --apply-updates requires --apply" "--apply-updates alone"

# 6. Unknown option (should fail)
test_arg "--unknown" "FAIL: Unknown option: --unknown" "Unknown option"

echo "All argument tests completed."
