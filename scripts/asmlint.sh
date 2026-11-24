#!/bin/bash
# asmlint.sh — sanity checks over asm/*.s:
#  - no `bl _napi_*` direct calls outside the register entry
#  - every AZ_NAPI(sym) is covered by an _aznc_sym thunk in aznc.s
#    (required for AZ_COUNT instrumented builds)
set -euo pipefail
cd "$(dirname "$0")/../asm"

fail=0

# raw _napi_* call sites (.globl decls are fine — register_module_v1 is
# the addon entry point)
raw=$(grep -n 'bl *_napi_' *.s | grep -v '_napi_register_module_v1' || true)
if [ -n "$raw" ]; then
  echo "raw _napi_* call sites:"
  echo "$raw"
  fail=1
fi

# every AZ_NAPI(sym) must have an AZNC thunk in aznc.s (AZ_COUNT mode)
if [ -f aznc.s ]; then
  for sym in $(grep -oh 'AZ_NAPI([a-zA-Z_0-9]*)' *.s | sed 's/AZ_NAPI(//;s/)//' | sort -u); do
    if ! grep -q "AZNC $sym" aznc.s; then
      echo "AZ_NAPI($sym) has no AZNC thunk in aznc.s"
      fail=1
    fi
  done
fi

[ "$fail" -eq 0 ] && echo "asmlint: ok"
exit "$fail"
