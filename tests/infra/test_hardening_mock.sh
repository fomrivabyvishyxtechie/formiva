#!/bin/bash
# Mock script for testing harden-oracle-linux9.sh without OCI/systemd
# This mock simulates the environment of harden-oracle-linux9.sh

set -euo pipefail

# Mock system files/commands
MOCK_ROOT="mock_fs"
mkdir -p "$MOCK_ROOT/etc/ssh"
echo "PermitRootLogin yes" > "$MOCK_ROOT/etc/ssh/sshd_config"

# Mocked commands
sshd() {
    echo "Mocked: sshd -t"
    return 0
}

systemctl() {
    echo "Mocked: systemctl $@"
}

visudo() {
    echo "Mocked: visudo $@"
    return 0
}

firewall-cmd() {
    echo "Mocked: firewall-cmd $@"
    return 0
}

# The hardening script itself (slightly modified to use mock paths)
# In a real test, we would source the script with redefined commands/paths.

echo "Running Mock Hardening (Dry Run)..."
# Simulate running the script with --dry-run
./infra/scripts/harden-oracle-linux9.sh --dry-run
echo "Mock Dry Run Complete."
