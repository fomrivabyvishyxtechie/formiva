#!/bin/bash
export ORACLE_RELEASE_FILE="/tmp/oracle-release"
echo "Oracle Linux Server release 9" > "$ORACLE_RELEASE_FILE"

# Patch the script temporarily to use our mock OS file
sed -i 's|/etc/oracle-release|/tmp/oracle-release|' infra/scripts/harden-oracle-linux9.sh

# Run the test
bash tests/infra/test_firewall.sh

# Revert the patch
sed -i 's|/tmp/oracle-release|/etc/oracle-release|' infra/scripts/harden-oracle-linux9.sh
