#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>
typedef int64_t (*az_parse_fn)(void*, void*, void*, uint64_t, void*, uint64_t, void*);
int main(void) {
    setbuf(stdout, NULL);
    void* h = dlopen("asm/libasmzod.dylib", RTLD_NOW);
    az_parse_fn az_parse = (az_parse_fn)dlsym(h, "az_parse");
    uint8_t node[1] = {0x02};                 // NUMBER
    const char* s = "hello";
    uint8_t input[64]; memset(input,0,sizeof input);
    input[0] = 4;
    uint64_t n = strlen(s);
    memcpy(input+1,&n,8); memcpy(input+9,s,n);
    static uint8_t outv[1<<20], oute[1<<20];
    static uint64_t cbtab[4];
    int64_t st = az_parse(node,input,outv,sizeof outv,oute,sizeof oute,cbtab);
    printf("status=%lld issue_count=%llu\n",(long long)st,*(uint64_t*)oute);
    for (int i=0;i<160;i++){ printf("%02x ",oute[3104+i]); if(i%16==15)printf("\n"); }
    printf("\n");
    return 0;
}
