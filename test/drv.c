#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>

typedef int64_t (*az_parse_fn)(void*, void*, void*, uint64_t, void*, uint64_t, void*);

int main(void) {
    setbuf(stdout, NULL);
    void* h = dlopen("asm/libasmzod.dylib", RTLD_NOW);
    if (!h) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    az_parse_fn az_parse = (az_parse_fn)dlsym(h, "az_parse");
    if (!az_parse) { fprintf(stderr, "dlsym fail\n"); return 1; }

    uint8_t node[2] = {0x01, 0x00};          // STRING, 0 checks
    const char* s = "hello";
    uint8_t input[64]; memset(input, 0, sizeof input);
    input[0] = 4;
    uint64_t n = strlen(s);
    memcpy(input+1, &n, 8);
    memcpy(input+9, s, n);

    static uint8_t outv[1<<20], oute[1<<20];
    static uint64_t cbtab[4];

    int64_t st = az_parse(node, input, outv, sizeof outv, oute, sizeof oute, cbtab);
    printf("status=%lld\n", (long long)st);
    uint64_t op, ol;
    memcpy(&op, outv, 8); memcpy(&ol, outv+8, 8);
    printf("out ptr=%llx len=%llu\n", (unsigned long long)op, (unsigned long long)ol);
    if (st == 0) {
        printf("tag=%d len=%llu str=%.*s\n", ((uint8_t*)op)[0],
               (unsigned long long)*(uint64_t*)((uint8_t*)op+1), 5, (char*)op+9);
    }
    return 0;
}
