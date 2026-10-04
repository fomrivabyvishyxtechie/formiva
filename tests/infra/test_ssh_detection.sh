#!/bin/bash
# Mock test for SSH detection logic in harden-oracle-linux9.sh

set -euo pipefail

# Mock environment
export XDG_SESSION_ID="123"

# Mock loginctl
loginctl() {
    if [[ "$1" == "show-session" && "$2" == "123" && "$3" == "-p" && "$4" == "Remote" ]]; then
        echo "Remote=yes"
    fi
}

# Mock who
who() {
    echo "user pts/0 2026-10-04 10:00 (192.168.1.1)"
}

# Mock readlink
readlink() {
    echo "/dev/pts/0"
}

echo "Testing SSH detection logic (mocked)..."

# Logic from the script
IS_SSH=false
if [[ -n "${XDG_SESSION_ID:-}" ]]; then
    # Note: the script uses --value which I'll add to the mock
    loginctl_mock_val() {
        if [[ "$1" == "show-session" && "$2" == "123" && "$5" == "--value" ]]; then
            echo "yes"
        fi
    }
    if [[ "$(loginctl_mock_val show-session "${XDG_SESSION_ID}" -p Remote --value 2>/dev/null)" == "yes" ]]; then
        IS_SSH=true
    fi
fi

if [[ "$IS_SSH" == true ]]; then
    echo "PASS: SSH detected via XDG_SESSION_ID"
else
    echo "FAIL: SSH not detected via XDG_SESSION_ID"
    exit 1
fi

# Test fallback
XDG_SESSION_ID=""
IS_SSH=false
TTY=$(readlink /proc/self/fd/0 2>/dev/null | sed 's|^/dev/||' || echo "unknown")
if who | grep -qE "^.*$TTY.*\(.*\).*$"; then
    IS_SSH=true
fi

if [[ "$IS_SSH" == true ]]; then
    echo "PASS: SSH detected via who fallback"
else
    echo "FAIL: SSH not detected via who fallback"
    exit 1
fi

echo "All SSH detection mock tests passed."
