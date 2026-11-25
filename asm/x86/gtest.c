#include <stdio.h>
#include <stdint.h>
extern int az_memmem(const void* hay, uint64_t hlen, const void* ndl, uint64_t nlen);
int main() {
  int r = az_memmem("aaaaaaaaaaaaaaaaaaaaaaaaaaaab", 28, "aaab", 4);
  printf("result: %d\n", r);
  return 0;
}
