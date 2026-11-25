#include <stdio.h>
extern long az_f64_dec(double v, char* buf);
int main() {
  char buf[64];
  long n = az_f64_dec(3.14159, buf); buf[n]=0;
  printf("pi: len=%ld '%s'\n", n, buf);
  n = az_f64_dec(0.0/0.0, buf); buf[n]=0;
  printf("nan: len=%ld '%s'\n", n, buf);
  n = az_f64_dec(42.0, buf); buf[n]=0;
  printf("42: len=%ld '%s'\n", n, buf);
  n = az_f64_dec(-0.5, buf); buf[n]=0;
  printf("neg: len=%ld '%s'\n", n, buf);
  return 0;
}
