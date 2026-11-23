#include "port.h"
// engine.s — az_parse entry point + engine context
//
// ctx registers (callee-saved, stable across JS callbacks):
//   x19 = val arena write pos (grows up)
//   x20 = pair-stack frontier  (grows down, shares out_val buffer top)
//   x21 = err issue write pos  (grows up from err_base+3104)
//   x22 = err base
//   x23 = err limit (err_base + cap)
//   x24 = cb table ptr
//   x25 = out_val base (result header at +0: u64 ptr, u64 len)
//   x26 = spare
//
// az_validate(x0=node, x1=val) -> x0 status (0 ok, -2 invalid, -3/-4 enospc),
//                               x1=out ptr, x2=out len
    .text
    .p2align 2

    .globl _az_version
_az_version:
    mov w0, #1
    ret

    .globl _az_parse
_az_parse:
    // x0 node, x1 input, x2 outval, x3 outvalcap, x4 outerr, x5 outerrcap, x6 cbtable
    stp x29, x30, [sp, #-112]!
    mov x29, sp
    stp x19, x20, [sp, #16]
    stp x21, x22, [sp, #32]
    stp x23, x24, [sp, #48]
    stp x25, x26, [sp, #64]
    stp x27, x28, [sp, #80]
    mov x25, x2              // val base
    add x19, x2, #16         // val pos (skip 16B result header)
    add x20, x2, x3          // pair pos (top of val buffer)
    mov x22, x4              // err base
    add x21, x4, #3104       // err pos (past header+path stack)
    add x23, x4, x5          // err limit
    mov x24, x6              // cb table
    str xzr, [x22]           // issue_count = 0
    str xzr, [x22, #8]       // path_depth = 0
    str xzr, [x22, #16]      // open patch ptr
    str xzr, [x22, #24]      // open issue start
    // x0=node x1=val already in place
    bl _az_validate
    cbnz x0, .Lep_out        // nonzero -> status code already in x0
    stp x1, x2, [x25]        // success: store result ptr/len
    mov x0, #0
.Lep_out:
    ldp x19, x20, [sp, #16]
    ldp x21, x22, [sp, #32]
    ldp x23, x24, [sp, #48]
    ldp x25, x26, [sp, #64]
    ldp x27, x28, [sp, #80]
    ldp x29, x30, [sp], #112
    ret
