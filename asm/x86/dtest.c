#include <stdio.h>
#include <string.h>
#include <stdint.h>
extern int az_is_hash(const char* p, uint64_t len, uint64_t bodylen, uint64_t alpha, uint64_t padlen);
extern int az_is_datestr(const char* p, uint64_t len);
extern int az_is_timestr(const char* p, uint64_t len);
extern int az_is_datetime(const char* p, uint64_t len, uint64_t flags);
static int fails = 0;
static void th(const char* s, uint64_t bl, uint64_t al, uint64_t pl, int e) { int r = az_is_hash(s, strlen(s), bl, al, pl); if (r != e) { printf("FAIL hash '%s': %d want %d\n", s, r, e); fails++; } }
static void td(const char* s, int e) { int r = az_is_datestr(s, strlen(s)); if (r != e) { printf("FAIL date '%s': %d want %d\n", s, r, e); fails++; } }
static void tt(const char* s, int e) { int r = az_is_timestr(s, strlen(s)); if (r != e) { printf("FAIL time '%s': %d want %d\n", s, r, e); fails++; } }
static void tdt(const char* s, uint64_t f, int e) { int r = az_is_datetime(s, strlen(s), f); if (r != e) { printf("FAIL datetime '%s' f%lu: %d want %d\n", s, f, r, e); fails++; } }
int main() {
  th("d41d8cd98f00b204e9800998ecf8427e", 32, 0, 0, 1);  // md5 hex
  th("d41d8cd98f00b204e9800998ecf8427g", 32, 0, 0, 0);
  th("d41d8cd98f00b204e9800998ecf8427", 32, 0, 0, 0);   // len 31
  th("aGVsbG8=", 7, 1, 1, 1);                            // b64 pad 2
  th("aGVsbG8=", 7, 1, 1, 1);
  td("2024-01-15", 1); td("2024-13-15", 0); td("2024-00-15", 0);
  td("2024-01-32", 0); td("2024-01-00", 0); td("2024-01-31", 1);
  td("2024/01/15", 0); td("24-01-15", 0); td("2024-1-15", 0);
  tt("23:59", 1); tt("24:00", 0); tt("12:60", 0); tt("12:30", 1);
  tt("12:30:45", 1); tt("12:30:60", 0); tt("12:30:45.123", 1);
  tt("12:30:45.", 0); tt("12:30:", 0); tt("1:30", 0);
  tdt("2024-01-15T12:30:45Z", 0, 1);
  tdt("2024-01-15T12:30:45z", 0, 1);
  tdt("2024-01-15T12:30:45+05:30", 0, 0);  // offset not allowed
  tdt("2024-01-15T12:30:45+05:30", 1, 1);  // allowed
  tdt("2024-01-15T12:30:45-08:00", 1, 1);
  tdt("2024-01-15T12:30:45+24:00", 1, 0);  // hour overflow
  tdt("2024-01-15T12:30:45+05:60", 1, 0);  // minute overflow
  tdt("2024-01-15 12:30:45Z", 0, 0);       // space not T
  tdt("2024-13-15T12:30:45Z", 0, 0);       // bad date
  tdt("2024-01-15T25:30:45Z", 0, 0);       // bad time
  tdt("2024-01-15T12:30:45.123Z", 0, 1);
  if (!fails) printf("x86 hash+date+time+datetime: all pass\n");
  return fails;
}
