#!/usr/bin/env bash
# real workerd verification: bundle the example worker, assert no node:/bun:
# imports, boot wrangler dev, and check a success + a shaped failure.
# Skips silently when wrangler isn't installed (it's a devDep).
set -euo pipefail
cd "$(dirname "$0")/../examples/worker"
WRANGLE=../../node_modules/.bin/wrangler
if [ ! -x "$WRANGLE" ]; then echo "workerd: wrangler not installed — skipping"; exit 0; fi
OUT="$(mktemp -d)"
"$WRANGLE" deploy --dry-run --outdir "$OUT" >/dev/null 2>&1
if grep -qE 'from *"(node:|bun:)|require\("node:|require\("bun:' "$OUT"/*.js; then
  echo "workerd: forbidden runtime import in bundle"; exit 1
fi
PORT=8797
WRANGLER_SEND_METRICS=false "$WRANGLE" dev --port $PORT --local >/tmp/az-wrk.log 2>&1 &
WK=$!
trap 'kill $WK 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  R=$(curl -s -m 2 -X POST "http://localhost:$PORT/" -H 'content-type: application/json' -d '{"name":"a","email":"a@b.com"}' 2>/dev/null || true)
  [ -n "$R" ] && break; sleep 0.5
done
echo "$R" | grep -q '"ok":true' || { echo "workerd: good input failed: $R"; exit 1; }
R=$(curl -s -m 2 -X POST "http://localhost:$PORT/" -H 'content-type: application/json' -d '{"name":"","email":"bad"}')
echo "$R" | grep -q '"code":"too_small"' || { echo "workerd: bad input not shaped: $R"; exit 1; }
echo "$R" | grep -q '"code":"invalid_format"' || { echo "workerd: bad input not shaped: $R"; exit 1; }
echo "workerd: ok"
