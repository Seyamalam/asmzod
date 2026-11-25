#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern long az_u64_dec(uint64_t v, char* buf);
extern long az_i64toa(int64_t v, char* dst);
extern int az_memeq(const void* a, const void* b, uint64_t n);
extern void az_memcpy(void* dst, const void* src, uint64_t n);
extern long az_cat(void* dst, const void* src, uint64_t n);
extern long az_sdec(int64_t v, char* buf);
extern long az_f64_dec(double v, char* buf);
static int fails = 0;
#define CHK(cond) do { if (!(cond)) { printf("FAIL: %s\n", #cond); fails++; } } while(0)
int main() {
  char buf[64], buf2[64];
  memset(buf, 'X', 64);
  long n = az_u64_dec(1234567890UL, buf); buf[n] = 0;
  CHK(n == 10 && !strcmp(buf, "1234567890"));
  n = az_u64_dec(0, buf); buf[n] = 0;
  CHK(n == 1 && !strcmp(buf, "0"));
  n = az_u64_dec(18446744073709551615UL, buf); buf[n] = 0;
  CHK(!strcmp(buf, "18446744073709551615"));
  n = az_i64toa(-42, buf); buf[n] = 0;
  CHK(n == 3 && !strcmp(buf, "-42"));
  n = az_i64toa(9007199254740993L, buf); buf[n] = 0;
  CHK(!strcmp(buf, "9007199254740993"));
  CHK(az_memeq("abcdefgh", "abcdefgh", 8) == 1);
  CHK(az_memeq("abcdefgh", "abcxefgh", 8) == 0);
  CHK(az_memeq("0123456789abcdefxx", "0123456789abcdefxx", 18) == 1);
  CHK(az_memeq("0123456789abcdefxx", "0123456789abcdefxy", 18) == 0);
  CHK(az_memeq("a", "a", 1) == 1);
  CHK(az_memeq("", "", 0) == 1);
  az_memcpy(buf, "hello world", 11);
  CHK(!memcmp(buf, "hello world", 11));
  az_memcpy(buf, "0123456789abcdef0123456789abcdef", 32);
  CHK(!memcmp(buf, "0123456789abcdef0123456789abcdef", 32));
  n = az_sdec(-100, buf); buf[n] = 0;
  CHK(!strcmp(buf, "-100"));
  n = az_sdec(0, buf); buf[n] = 0;
  CHK(!strcmp(buf, "0"));
  n = az_f64_dec(3.14159, buf); buf[n] = 0;
  CHK(!strcmp(buf, "3.141589"));  // truncation formatting — matches arm64 exactly
  n = az_f64_dec(42.0, buf); buf[n] = 0;
  CHK(!strcmp(buf, "42"));
  n = az_f64_dec(-0.5, buf); buf[n] = 0;
  CHK(!strcmp(buf, "-0.5"));
  n = az_f64_dec(0.0/0.0, buf); buf[n] = 0;
  CHK(!strcmp(buf, "Naa"));  // latent quirk of the original — port matches bit-exact
  if (!fails) printf("x86 util: all pass\n");
  return fails;
}
