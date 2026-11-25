#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern int az_is_uuid(const char* p, uint64_t len, uint64_t version);
static int fails = 0;
static void t(const char* s, uint64_t v, int expect) {
  int r = az_is_uuid(s, strlen(s), v);
  if (r != expect) { printf("FAIL '%s' v%lu: got %d want %d\n", s, v, r, expect); fails++; }
}
int main() {
  t("550e8400-e29b-41d4-a716-446655440000", 0, 1);
  t("550e8400-e29b-41d4-a716-446655440000", 4, 1);
  t("550e8400-e29b-41d4-a716-446655440000", 3, 0);
  t("550E8400-E29B-41D4-A716-446655440000", 0, 1);  // uppercase hex ok
  t("550e8400e29b41d4a716446655440000", 0, 0);      // no dashes
  t("550e8400-e29b-41d4-a716-44665544000", 0, 0);   // len 35
  t("550e8400-e29b-41d4-a716-4466554400000", 0, 0); // len 37
  t("550e8400-e29b-41d4-a716-44665544000g", 0, 0);  // bad hex
  t("550e8400-e29b-11d4-a716-446655440000", 1, 1);
  t("550e8400-e29b-11d4-a716-446655440000", 0, 1);
  if (!fails) printf("x86 uuid: all pass\n");
  return fails;
}
