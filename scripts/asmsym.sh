#!/bin/bash
# asmsym.sh <address|symbol> — map a crash address to the nearest asm symbol + source line.
# usage: scripts/asmsym.sh 0x1042a1f3c   (address inside the loaded image or file offset)
#        scripts/asmsym.sh _az_vsize    (locate a symbol's source line)
set -euo pipefail
cd "$(dirname "$0")/../asm"

arg="${1:?usage: asmsym.sh <hex-address|symbol>}"
obj=$(ls -t *.o 2>/dev/null | head -1)
if [ -z "$obj" ]; then echo "build first: make -C asm"; exit 1; fi

if [[ "$arg" =~ ^0x[0-9a-fA-F]+$ || "$arg" =~ ^[0-9]+$ ]]; then
  # find nearest preceding text symbol across all objects
  addr=$((arg))
  best=""
  for o in *.o; do
    [ "$o" = "aznc.o" ] && continue
    while read -r a t s; do
      [ "$t" = "t" ] || [ "$t" = "T" ] || continue
      av=$((16#$a))
      if [ "$av" -le "$addr" ]; then
        if [ -z "$best" ] || [ "$av" -gt "$ba" ]; then
          best="$s ($o)"; ba=$av
        fi
      fi
    done < <(nm -t x "$o" 2>/dev/null | awk '$2 ~ /^[tT]$/ {print $1, $2, $3}')
  done
  if [ -n "$best" ]; then
    printf "0x%x → %s +0x%x\n" "$addr" "$best" $((addr - ba))
    sym=${best%% (*}
    grep -rn "^$sym:" -- *.s | head -3
  else
    echo "no symbol ≤ 0x$(printf %x $addr) found"
  fi
else
  grep -rn "^$arg:\|^_$arg:\|\.globl.*$arg" -- *.s | head -5
fi
