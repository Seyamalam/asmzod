#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern int az_is_ipv4(const char* p, uint64_t len);
static int fails = 0;
static void t(const char* s, int e) { int r = az_is_ipv4(s, strlen(s)); if (r != e) { printf("FAIL ipv4 '%s': %d want %d\n", s, r, e); fails++; } }
int main() {
  t("0.0.0.0", 1); t("255.255.255.255", 1); t("192.168.1.1", 1);
  t("256.1.1.1", 0); t("1.2.3", 0); t("1.2.3.4.5", 0);
  t("01.2.3.4", 0); t("1.2.3.04", 0); t("0.2.3.4", 1);
  t("1..3.4", 0); t("1.2.3.", 0); t(".1.2.3", 0);
  t("1.2.3.4x", 0); t("", 0); t("1.2.3.456", 0);
  if (!fails) printf("x86 ipv4: all pass\n");
  return fails;
}
