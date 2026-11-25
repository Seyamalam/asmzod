#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern int az_is_ulid(const char* p, uint64_t len);
extern int az_is_nanoid(const char* p, uint64_t len);
static int fails = 0;
static void tu(const char* s, int e) { int r = az_is_ulid(s, strlen(s)); if (r != e) { printf("FAIL ulid '%s': %d want %d\n", s, r, e); fails++; } }
static void tn(const char* s, int e) { int r = az_is_nanoid(s, strlen(s)); if (r != e) { printf("FAIL nanoid '%s': %d want %d\n", s, r, e); fails++; } }
int main() {
  tu("01ARZ3NDEKTSV4RRFFQ69G5FAV", 1);
  tu("01ARZ3NDEKTSV4RRFFQ69G5FA", 0);   // 25
  tu("01ARZ3NDEKTSV4RRFFQ69G5FAVX", 0);  // 27
  tu("01ARZ3NDEKTSV4RRFFQ69G5FAI", 0);   // I excluded
  tu("01ARZ3NDEKTSV4RRFFQ69G5FAL", 0);   // L excluded
  tu("01ARZ3NDEKTSV4RRFFQ69G5FAO", 0);   // O excluded
  tu("01ARZ3NDEKTSV4RRFFQ69G5FAU", 0);   // U excluded
  tu("01arz3ndektsv4rrffq69g5fav", 0);   // lowercase invalid
  tn("V1StGXR8_Z5jdHi6B-myT", 1);
  tn("V1StGXR8_Z5jdHi6B-my", 0);         // 20
  tn("V1StGXR8_Z5jdHi6B-myTT", 0);       // 22
  tn("V1StGXR8 Z5jdHi6B-myT", 0);        // space
  tn("V1StGXR8+Z5jdHi6B-myT", 0);        // plus not allowed
  if (!fails) printf("x86 ulid+nanoid: all pass\n");
  return fails;
}
