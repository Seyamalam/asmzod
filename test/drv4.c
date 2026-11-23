#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>

// schema: STRING nchecks=1: [code7][msglen=0][u64 len=2]["ab"]
static uint8_t schema[] = {
  0x01, 0x01,                       // op=string, nchecks=1
  0x07,                             // startsWith
  0,0,0,0,0,0,0,0,                  // msglen=0
  2,0,0,0,0,0,0,0, 'a','b',         // needle
};
static uint8_t input[] = { 0x04, 5,0,0,0,0,0,0,0, 'h','e','l','l','o' };

int main() {
  void *h = dlopen("asm/libasmzod.dylib", RTLD_NOW);
  if (!h) { printf("dlopen fail\n"); return 1; }
  int64_t (*az_parse)(const uint8_t*,const uint8_t*,void*,uint64_t,void*,uint64_t,const void*)
    = dlsym(h, "az_parse");
  static uint8_t outv[65536], oute[1<<20];
  int64_t st = az_parse(schema, input, outv, sizeof outv, oute, sizeof oute, NULL);
  printf("status=%lld\n", (long long)st);
  if (st == -2) {
    uint64_t cnt; memcpy(&cnt, oute, 8);
    printf("issues=%llu\n", (unsigned long long)cnt);
    for (int i = 0; i < 200; i++) printf("%02x ", oute[i]);
    printf("\n");
  }
  return 0;
}
