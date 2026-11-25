#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern int az_is_cuid2(const char* p, uint64_t len);
extern int az_is_base64(const char* p, uint64_t len);
extern int az_is_hex(const char* p, uint64_t len);
static int fails = 0;
static void tc(const char* s, int e) { int r = az_is_cuid2(s, strlen(s)); if (r != e) { printf("FAIL cuid2 '%s': %d want %d\n", s, r, e); fails++; } }
static void tb(const char* s, int e) { int r = az_is_base64(s, strlen(s)); if (r != e) { printf("FAIL base64 '%s': %d want %d\n", s, r, e); fails++; } }
static void th(const char* s, int e) { int r = az_is_hex(s, strlen(s)); if (r != e) { printf("FAIL hex '%s': %d want %d\n", s, r, e); fails++; } }
int main() {
  tc("abc123", 1); tc("a", 0); tc("1abc", 0); tc("aBc", 0); tc("zz", 1);
  tb("aGVsbG8=", 1); tb("aGVsbG8", 0); tb("aGVsbG9==", 0); tb("", 0);
  tb("AAAA", 1); tb("AA==", 1); tb("AAA=", 1); tb("A===", 0); tb("A!AA", 0);
  tb("aGVsbG8gd29ybGQh", 1);  // 16 chars exercises longer body
  th("", 1); th("deadBEEF", 1); th("0123456789abcdefABCDEF", 1); th("xyz", 0); th("ffg", 0);
  if (!fails) printf("x86 cuid2+base64+hex: all pass\n");
  return fails;
}
