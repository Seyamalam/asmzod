#include "port.h"
// value.s — tagged value readers (see FORMAT.md)
    .text
    .p2align 2

// az_vsize(x0=val ptr) -> x0 serialized byte size
// tags: 0 undef(1) 1 null(1) 2 bool(2) 3 f64(9) 4 str(9+len)
//       5 bigint(9) 6 obj 7 arr 8 hostref(9)
    .globl _az_vsize
    AZ_HIDDEN _az_vsize
_az_vsize:
    ldrb w9, [x0]
    cmp w9, #4
    b.eq .Lvs_str
    cmp w9, #6
    b.eq .Lvs_obj
    cmp w9, #7
    b.eq .Lvs_arr
    cmp w9, #2
    b.eq .Lvs_two
    // undef null f64 bigint hostref => 1 or 9
    cmp w9, #2
    b.lo .Lvs_one
    mov x0, #9
    ret
.Lvs_one:
    mov x0, #1
    ret
.Lvs_two:
    mov x0, #2
    ret
.Lvs_str:
    ldr x0, [x0, #1]
    add x0, x0, #9
    ret
.Lvs_obj:
    stp x29, x30, [sp, #-48]!
    mov x29, sp
    stp x19, x20, [sp, #16]
    str x21, [sp, #32]
    mov x19, x0
    ldr x20, [x19, #1]     // nfields
    add x19, x19, #9       // cursor at first field
    mov x21, #9            // size so far
.Lvs_objloop:
    cbz x20, .Lvs_objdone
    ldr x9, [x19]          // keylen
    add x19, x19, #8
    add x19, x19, x9       // skip key
    add x21, x21, x9
    add x21, x21, #8
    mov x0, x19
    bl _az_vsize
    add x19, x19, x0
    add x21, x21, x0
    sub x20, x20, #1
    b .Lvs_objloop
.Lvs_objdone:
    mov x0, x21
    ldp x19, x20, [sp, #16]
    ldr x21, [sp, #32]
    ldp x29, x30, [sp], #48
    ret
.Lvs_arr:
    stp x29, x30, [sp, #-48]!
    mov x29, sp
    stp x19, x20, [sp, #16]
    str x21, [sp, #32]
    mov x19, x0
    ldr x20, [x19, #1]
    add x19, x19, #9
    mov x21, #9
.Lvs_arrloop:
    cbz x20, .Lvs_arrdone
    mov x0, x19
    bl _az_vsize
    add x19, x19, x0
    add x21, x21, x0
    sub x20, x20, #1
    b .Lvs_arrloop
.Lvs_arrdone:
    mov x0, x21
    ldp x19, x20, [sp, #16]
    ldr x21, [sp, #32]
    ldp x29, x30, [sp], #48
    ret

// az_scalar_size(x0=tag) -> x0 (1,2,or 9; string/obj/arr -> 0 = variable)
    .globl _az_scalar_size
    AZ_HIDDEN _az_scalar_size
_az_scalar_size:
    cmp x0, #2
    b.eq .Lss2
    cmp x0, #2
    b.lo .Lss1
    cmp x0, #3
    b.eq .Lss9
    cmp x0, #5
    b.eq .Lss9
    cmp x0, #8
    b.eq .Lss9
    mov x0, #0
    ret
.Lss1:
    mov x0, #1
    ret
.Lss2:
    mov x0, #2
    ret
.Lss9:
    mov x0, #9
    ret

// az_val_copy(x0=dst arena check) — copies value x1=src x2=len into val arena
// bounds-checks against x20; returns dst ptr in x0 or x0=-1 on ENOSPC
// clobbers x9-x12
    .globl _az_val_write
    AZ_HIDDEN _az_val_write
_az_val_write:
    add x9, x19, x2
    cmp x9, x20
    b.hi .Lvw_oom
    mov x10, x19           // dst
    mov x19, x9            // bump
    mov x9, x1             // src
    mov x11, x2
    // inline small copy
    cmp x11, #16
    b.lo .Lvw_tail
.Lvw16:
    ldp x12, x13, [x9], #16
    stp x12, x13, [x10], #16
    sub x11, x11, #16
    cmp x11, #16
    b.hs .Lvw16
.Lvw_tail:
    cbz x11, .Lvw_done
.Lvw1:
    ldrb w12, [x9], #1
    strb w12, [x10], #1
    subs x11, x11, #1
    b.ne .Lvw1
.Lvw_done:
    mov x0, x19
    sub x0, x0, x2         // dst start
    ret
.Lvw_oom:
    mov x0, #-1
    ret

// az_val_reserve(x0=n) -> x0 write ptr (arena grows), or -1 ENOSPC
    .globl _az_val_reserve
    AZ_HIDDEN _az_val_reserve
_az_val_reserve:
    add x9, x19, x0
    cmp x9, x20
    b.hi .Lvr_oom
    mov x10, x19
    mov x19, x9
    mov x0, x10
    ret
.Lvr_oom:
    mov x0, #-1
    ret

// pair stack (ptr,len) for pending child outputs — grows DOWN from x20
// az_pair_push(x0=ptr, x1=len): reserves 16B on pair stack; -> x0=0 ok / -1 oom
    .globl _az_pair_push
    AZ_HIDDEN _az_pair_push
_az_pair_push:
    sub x9, x20, #16
    cmp x9, x19
    b.lo .Lpp_oom
    mov x20, x9
    stp x0, x1, [x20]
    mov x0, #0
    ret
.Lpp_oom:
    mov x0, #-1
    ret

// az_pairs(x0=i) -> reads pair i above current x20: x0=ptr x1=len
// caller keeps base in a reg; helper reads [x20 + i*16]
    .globl _az_pair_get
    AZ_HIDDEN _az_pair_get
_az_pair_get:
    lsl x9, x0, #4
    add x9, x20, x9
    ldp x0, x1, [x9]
    ret

// az_vw1(w0=byte) -> 0 ok / -3 ENOSPC   (val arena byte append)
    .globl _az_vw1
    AZ_HIDDEN _az_vw1
_az_vw1:
    cmp x19, x20
    b.hs .Lvw1_oom
    strb w0, [x19], #1
    mov x0, #0
    ret
.Lvw1_oom:
    mov x0, #-3
    ret

// az_vw8(x0=u64) -> 0/-3
    .globl _az_vw8
    AZ_HIDDEN _az_vw8
_az_vw8:
    add x9, x19, #8
    cmp x9, x20
    b.hi .Lvw8_oom
    str x0, [x19], #8
    mov x0, #0
    ret
.Lvw8_oom:
    mov x0, #-3
    ret

// az_vw(x0=src, x1=len) -> 0/-3   (val arena raw append)
    .globl _az_vw
    AZ_HIDDEN _az_vw
_az_vw:
    add x9, x19, x1
    cmp x9, x20
    b.hi .Lvw_oom2
    mov x10, x19
    mov x19, x9
    mov x11, x1
    cbz x11, .Lvw_ok2
    cmp x11, #16
    b.lo .Lvw_t2
.Lvw16b:
    ldp x12, x13, [x0], #16
    stp x12, x13, [x10], #16
    sub x11, x11, #16
    cmp x11, #16
    b.hs .Lvw16b
.Lvw_t2:
    cbz x11, .Lvw_ok2
.Lvw_1b:
    ldrb w12, [x0], #1
    strb w12, [x10], #1
    subs x11, x11, #1
    b.ne .Lvw_1b
.Lvw_ok2:
    mov x0, #0
    ret
.Lvw_oom2:
    mov x0, #-3
    ret

// pair entries are 40B: {kptr,klen,vptr,vlen,flags}
// az_pair_push40(x0=kptr,x1=klen,x2=vptr,x3=vlen,x4=flags) -> 0/-3
    .globl _az_pair_push40
    AZ_HIDDEN _az_pair_push40
_az_pair_push40:
    sub x9, x20, #40
    cmp x9, x19
    b.lo .Lpp40_oom
    mov x20, x9
    stp x0, x1, [x20]
    stp x2, x3, [x20, #16]
    str x4, [x20, #32]
    mov x0, #0
    ret
.Lpp40_oom:
    mov x0, #-3
    ret

// az_pair_get40(x0=i) -> x0=kptr x1=klen x2=vptr x3=vlen x4=flags
    .globl _az_pair_get40
    AZ_HIDDEN _az_pair_get40
_az_pair_get40:
    mov x9, #40
    mul x9, x0, x9
    add x9, x20, x9
    ldp x0, x1, [x9]
    ldp x2, x3, [x9, #16]
    ldr x4, [x9, #32]
    ret
