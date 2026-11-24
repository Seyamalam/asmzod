#!/usr/bin/env bash
# full local CI: asm build -> typecheck -> bun suite -> portable -> node -> deno
set -euo pipefail
cd "$(dirname "$0")/.."
make ci
