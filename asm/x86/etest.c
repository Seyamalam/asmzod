#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern int az_is_email(const char* p, uint64_t len);
static int fails = 0;
static void t(const char* s, int expect) {
  int r = az_is_email(s, strlen(s));
  if (r != expect) { printf("FAIL '%s': got %d want %d\n", s, r, expect); fails++; }
}
int main() {
  t("a@b.co", 1);
  t("user@example.com", 1);
  t("u_s+e-r'x.y@sub.dom-ain.org", 1);
  t("a@ab.cd", 1);
  t("", 0);
  t("plain", 0);
  t("@x.com", 0);           // empty local
  t("a@x.com", 1);
  t(".a@x.com", 1);         // dot allowed mid-local even first (zod4 check semantics)
  t("a.@x.com", 0);         // ends in dot — not in end set
  t("a@x", 0);              // no dot in domain
  t("a@x.c", 0);            // tld len 1
  t("a@x.comm", 1);
  t("a@x..com", 0);         // empty label
  t("a@-x.com", 0);         // leading dash label
  t("a@x-.com", 1);         // trailing dash fine
  t("a@x.c0", 0);           // digit in tld
  t("a b@x.com", 0);        // space
  t("verylonglocalpartthatexceedssixteenchars@domain.com", 1); // simd-skip territory
  if (!fails) printf("x86 email: all pass\n");
  return fails;
}
