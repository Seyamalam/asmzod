#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>
// schema: ENUM n=3: 'a' 'b' 'c'
static uint8_t schema[] = {
  0x0A, 3,0,0,0,0,0,0,0,
  1,0,0,0,0,0,0,0,'a',
  1,0,0,0,0,0,0,0,'b',
  1,0,0,0,0,0,0,0,'c',
};
// input: array [f64 1]
static uint8_t input[] = { 0x07, 1,0,0,0,0,0,0,0, 0x03, 0,0,0,0,0,0,0xF0,0x3F };
int main() {
  void *h = dlopen("asm/libasmzod.dylib", RTLD_NOW);
  int64_t (*az_parse)(const uint8_t*,const uint8_t*,void*,uint64_t,void*,uint64_t,const void*)
    = dlsym(h, "az_parse");
  static uint8_t outv[65536], oute[1<<20];
  int64_t st = az_parse(schema, input, outv, sizeof outv, oute, sizeof oute, NULL);
  printf("status=%lld\n", (long long)st);
  return 0;
}
