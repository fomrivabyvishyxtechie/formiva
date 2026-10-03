#!/usr/bin/env bash
set -euo pipefail

PROJECT="$(pwd)"
mkdir -p "$PROJECT/.claude/skills" "$PROJECT/.claude/memory" "$PROJECT/.claude/commands"

echo "Claude Full-Stack Engineering OS base structure is installed in $PROJECT"
echo "Install third-party skills using INSTALL-SKILLS.md"
