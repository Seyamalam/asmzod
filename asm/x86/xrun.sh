#!/bin/bash
# x86-64 semantic test runner — executes inside the asmzod-x86 container.
# Assembles every ported .s, then links and runs each *test.c against the
# objects it needs. every test binary must exit 0; failures tally.
cd /tmp/azx 2>/dev/null || { mkdir -p /tmp/azx && cd /tmp/azx; }
cp /x/*.s /x/*.h /x/*.c . 2>/dev/null
fail=0
# assemble all ported units
OBJS=""
for f in util engine value checks issues validate runners; do
  if [ -f "$f.s" ]; then
    if clang -x assembler-with-cpp -I. -fPIC -c -o "$f.o" "$f.s" 2>assemble_err.txt; then
      OBJS="$OBJS $f.o"
    else
      echo "ASSEMBLE FAIL: $f.s"; cat assemble_err.txt; fail=1
    fi
  fi
done
# test name -> required objects (validate/issues need ctx machinery so most
# unit tests link only the leaf objects they exercise)
run() { # name objects...
  local name="$1"; shift
  if [ -f "$name.c" ]; then
    if clang -o "$name.bin" "$name.c" "$@" 2>link_err.txt; then
      if ./"$name.bin"; then echo "PASS $name"; else echo "FAIL $name (runtime)"; fail=1; fi
    else
      echo "LINK FAIL $name:"; cat link_err.txt; fail=1
    fi
  fi
}
run xtest util.o
run ctest util.o checks.o issues.o
run mtest util.o checks.o issues.o
run untest util.o checks.o issues.o
run utest util.o checks.o issues.o
run itest util.o checks.o issues.o
run v6test util.o checks.o issues.o
run btest util.o checks.o issues.o
run dtest util.o checks.o issues.o
run etest util.o checks.o issues.o
run gtest util.o checks.o issues.o
run atest util.o checks.o issues.o value.o validate.o runners.o engine.o
echo "---"
[ $fail -eq 0 ] && echo "x86 tests: all pass" || echo "x86 tests: FAILURES"
exit $fail
