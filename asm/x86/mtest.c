#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern int az_memmem(const void* hay, uint64_t hlen, const void* ndl, uint64_t nlen);
int main() {
  // force scalar region: match beyond byte 16 in haystacks of len 20-44
  char h[64]; memset(h, 'x', sizeof h);
  for (int pos = 14; pos < 40; pos += 4) {
    for (int hl = 20; hl <= 48; hl += 4) {
      if (pos + 6 > hl) continue;
      memset(h, 'x', 64);
      memcpy(h + pos, "needle", 6);
      int r = az_memmem(h, hl, "needle", 6);
      printf("pos %2d hlen %2d: %d\n", pos, hl, r);
    }
  }
  return 0;
}
