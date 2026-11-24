#!/usr/bin/env bash
# enable AsmZod's git hooks
set -e
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
echo "hooks enabled (.githooks/)"
