#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern long az_utf16_units(const char* p, uint64_t len);
extern int az_memmem(const void* hay, uint64_t hlen, const void* ndl, uint64_t nlen);
static int fails = 0;
#define CHK(cond) do { if (!(cond)) { printf("FAIL line %d: %s\n", __LINE__, #cond); fails++; } } while(0)
int main() {
  CHK(az_utf16_units("hello", 5) == 5);
  CHK(az_utf16_units("", 0) == 0);
  CHK(az_utf16_units("h\xc3\xa9llo", 6) == 5);          // e-acute 2 bytes 1 unit
  CHK(az_utf16_units("\xf0\x9f\x92\xa9", 4) == 1);      // poop emoji: astral counts 1 (zod4)
  // long strings to hit the simd path
  char big[128]; memset(big, 'a', sizeof big);
  CHK(az_utf16_units(big, 128) == 128);
  memcpy(big + 40, "\xc3\xa9", 2);                      // one 2-byte char inside simd range
  CHK(az_utf16_units(big, 128) == 127);
  memcpy(big + 60, "\xf0\x9f\x92\xa9", 4);
  CHK(az_utf16_units(big, 128) == 124);
  CHK(az_memmem("hello world", 11, "world", 5) == 1);
  CHK(az_memmem("hello world", 11, "word", 4) == 0);
  CHK(az_memmem("aaaaaaaaaaaaaaaaaaaaaaaaaaaab", 29, "aaab", 4) == 1);
  CHK(az_memmem("short", 5, "longerneedle", 12) == 0);
  CHK(az_memmem("abc", 3, "", 0) == 1);
  CHK(az_memmem("xabc", 4, "abc", 3) == 1);
  CHK(az_memmem("0123456789abcdef0123456789abcdef needle here", 45, "needle", 6) == 1);
  if (!fails) printf("x86 checks chunk: all pass\n"); printf("probe: aaab=%d units128=%ld\n", az_memmem("aaaaaaaaaaaaaaaaaaaaaaaaaaaab",28,"aaab",4), az_utf16_units(big,128));
  return fails;
}
