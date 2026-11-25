#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern int az_is_ipv6(const char* p, uint64_t len);
static int fails = 0;
static void t(const char* s, int e) { int r = az_is_ipv6(s, strlen(s)); if (r != e) { printf("FAIL ipv6 '%s': %d want %d\n", s, r, e); fails++; } }
int main() {
  t("::", 1);
  t("::1", 1);
  t("1::", 1);
  t("1::1", 1);
  t("1:2:3:4:5:6:7:8", 1);
  t("1:2:3:4:5:6:7:8:9", 0);      // 9 groups
  t("1:2:3:4:5:6:7", 0);          // 7 without compression
  t("2001:db8:85a3::8a2e:370:7334", 1);
  t("::ffff:192.168.1.1", 1);     // ipv4 tail
  t("::ffff:192.168.1.256", 0);   // octet overflow
  t("::ffff:192.168.01.1", 0);    // leading zero
  t("1:2:3:4:5:192.168.1.1", 0);  // ipv4 not in compressed/last correct count — 6 groups + 2 = 8 hmm actually valid? v4 tail counts 2 -> 5+2=7 != 8 no compression -> invalid
  t("1:2:3:4:5:6:192.168.1.1", 1);// 6+2 = 8 exact
  t("1::2::3", 0);                // two ::
  t(":::", 0);
  t("1:2:3:4:5:6:7::", 1);        // :: compresses exactly one group — valid
t("1:2:3:4:5:6:7:8::", 0);      // 8 groups + compression — nothing left to compress
  t("fe80::1%eth0", 0);           // zone not allowed
  t("", 0);
  t("gggg::1", 0);
  t("12345::", 0);                // piece too long
  t("1.2.3.4", 0);                // pure ipv4 no colons... hmm — no :: and count != 8
  if (!fails) printf("x86 ipv6: all pass\n");
  return fails;
}
