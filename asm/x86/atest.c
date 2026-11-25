// atest.c — end-to-end array opcode test: drives az_parse with hand-built
// bytecode + tagged input values, exercising the full ctx machinery.
#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern int64_t az_parse(void* node, void* input, void* outval, uint64_t outvalcap,
                        void* outerr, uint64_t outerrcap, void* cbtable);
static int fails = 0;
static uint8_t outval[65536], outerr[65536];

// bytecode: array node (26B) then boolean leaf node (1B)
// [0x06][elem-rel i64 @+1][min u64 @+9][max u64 @+17][exactlen @+25]
static void build_array_schema(uint8_t* buf, int64_t minv, int64_t maxv, uint8_t exactlen) {
  buf[0] = 0x06;
  int64_t rel = 25;           // bool node sits at +26; rel field base is +1
  memcpy(buf + 1, &rel, 8);
  memcpy(buf + 9, &minv, 8);
  memcpy(buf + 17, &maxv, 8);
  buf[25] = exactlen;
  buf[26] = 0x03;             // boolean leaf
}
// tagged input: array of booleans — byte7, u64 n, then n x (byte2, byteval)
static uint64_t build_input(uint8_t* buf, const int* vals, uint64_t n) {
  uint8_t* p = buf;
  *p++ = 7;
  memcpy(p, &n, 8); p += 8;
  for (uint64_t i = 0; i < n; i++) { *p++ = 2; *p++ = (uint8_t)vals[i]; }
  return (uint64_t)(p - buf);
}
// input with a wrong-type element at idx (uses number tag3 instead)
static uint64_t build_input_bad(uint8_t* buf, uint64_t n, uint64_t badidx) {
  uint8_t* p = buf;
  *p++ = 7;
  memcpy(p, &n, 8); p += 8;
  for (uint64_t i = 0; i < n; i++) {
    if (i == badidx) { *p++ = 3; double z = 0; memcpy(p, &z, 8); p += 8; }
    else { *p++ = 2; *p++ = 1; }
  }
  return (uint64_t)(p - buf);
}
static void run(const char* name, uint8_t* schema, uint8_t* input, int64_t want) {
  memset(outval, 0, 65536); memset(outerr, 0, 65536);
  int64_t st = az_parse(schema, input, outval, 65536, outerr, 65536, 0);
  if (st != want) { printf("FAIL %s: status %ld want %ld\n", name, (long)st, (long)want); fails++; }
  else printf("ok %s: %ld\n", name, (long)st);
}
int main() {
  uint8_t schema[64], input[512];
  int vals3[3] = {1, 0, 1};
  // 1. plain array(bool) no bounds -> success
  build_array_schema(schema, -1, -1, 0);
  build_input(input, vals3, 3);
  run("array-no-bounds", schema, input, 0);
  // 2. min satisfied
  build_array_schema(schema, 2, -1, 0);
  build_input(input, vals3, 3);
  run("array-min-ok", schema, input, 0);
  // 3. min violated (deferred too_small) -> invalid
  build_array_schema(schema, 4, -1, 0);
  build_input(input, vals3, 3);
  run("array-too-small", schema, input, -2);
  // 4. max violated (precheck abort) -> invalid
  build_array_schema(schema, -1, 2, 0);
  build_input(input, vals3, 3);
  run("array-too-big", schema, input, -2);
  // 5. element type failure -> invalid
  build_array_schema(schema, -1, -1, 0);
  build_input_bad(input, 3, 1);
  run("array-elem-type", schema, input, -2);
  // 6. empty array, min 0 -> success
  build_array_schema(schema, -1, -1, 0);
  build_input(input, vals3, 0);
  run("array-empty", schema, input, 0);
  // 7. wrong input type entirely: a boolean where array expected -> invalid
  build_array_schema(schema, -1, -1, 0);
  input[0] = 2; input[1] = 1;
  run("array-vs-bool", schema, input, -2);
  if (!fails) printf("x86 array e2e: all pass\n");
  return fails;
}
