#include "portx.h"
// runners.s — x86-64 port. SCAFFOLDING ONLY: fail-fast stubs.
// correct behavior for zero-check schemas (count==0 -> pass); anything with
// real checks hits ud2 immediately so no test can silently pass against a
// stub. the real port replaces this file wholesale — do not extend it.
    .text
    .p2align 4

// az_run_strchecks(rdi=chkptr, rsi=count, rdx=strptr, rcx=strlen) -> rax 0/-2/-4
    .globl AZX_NAPI(az_run_strchecks)
    AZX_HIDDEN AZX_NAPI(az_run_strchecks)
AZX_NAPI(az_run_strchecks):
    test rsi, rsi
    jnz .Lxrs_stub
    xor eax, eax
    ret
.Lxrs_stub:
    ud2

// az_run_numchecks(rdi=chkptr, rsi=count, xmm0=val, rdx=valptr) -> rax
    .globl AZX_NAPI(az_run_numchecks)
    AZX_HIDDEN AZX_NAPI(az_run_numchecks)
AZX_NAPI(az_run_numchecks):
    test rsi, rsi
    jnz .Lxrn_stub
    xor eax, eax
    ret
.Lxrn_stub:
    ud2

// az_run_bigintchecks(rdi=chkptr, rsi=count, rdx=val, rcx=valptr) -> rax
    .globl AZX_NAPI(az_run_bigintchecks)
    AZX_HIDDEN AZX_NAPI(az_run_bigintchecks)
AZX_NAPI(az_run_bigintchecks):
    test rsi, rsi
    jnz .Lxrb_stub
    xor eax, eax
    ret
.Lxrb_stub:
    ud2
