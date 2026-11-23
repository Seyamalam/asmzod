// util.s — leaf helpers: memory ops, integer to decimal
    .text
    .p2align 2

// az_memcpy(x0=dst, x1=src, x2=n) — forward copy, dst may not overlap lower src
    .globl _az_memcpy
_az_memcpy:
    cbz x2, .Lmcdone
    cmp x2, #16
    b.lo .Lmctail
.Lmc16:
    ldp x9, x10, [x1], #16
    stp x9, x10, [x0], #16
    sub x2, x2, #16
    cmp x2, #16
    b.hs .Lmc16
.Lmctail:
    cbz x2, .Lmcdone
.Lmc1:
    ldrb w9, [x1], #1
    strb w9, [x0], #1
    subs x2, x2, #1
    b.ne .Lmc1
.Lmcdone:
    ret

// az_memeq(x0=a, x1=b, x2=n) -> w0 1 if equal else 0
    .globl _az_memeq
_az_memeq:
    cbz x2, .Lmeq1
    cmp x2, #8
    b.lo .Lmeqtail
.Lmeq8:
    ldr x9, [x0], #8
    ldr x10, [x1], #8
    cmp x9, x10
    b.ne .Lmeq0
    sub x2, x2, #8
    cmp x2, #8
    b.hs .Lmeq8
.Lmeqtail:
    cbz x2, .Lmeq1
.Lmeq1b:
    ldrb w9, [x0], #1
    ldrb w10, [x1], #1
    cmp w9, w10
    b.ne .Lmeq0
    subs x2, x2, #1
    b.ne .Lmeq1b
.Lmeq1:
    mov w0, #1
    ret
.Lmeq0:
    mov w0, #0
    ret

// az_u64_dec(x0=u64 value) -> writes decimal into 32-byte stack buf passed in x1
// returns x0 = length written
    .globl _az_u64_dec
_az_u64_dec:
    mov x9, x0
    mov x10, x1
    mov x11, #0              // digit count
    mov x12, #10
.Ldc_loop:
    udiv x13, x9, x12
    msub x14, x13, x12, x9   // x14 = x9 % 10
    add w14, w14, #'0'
    strb w14, [x10, x11]
    add x11, x11, #1
    mov x9, x13
    cbnz x9, .Ldc_loop
    // reverse in place
    mov x12, #0
    sub x13, x11, #1
.Ldc_rev:
    cmp x12, x13
    b.hs .Ldc_done
    ldrb w14, [x10, x12]
    ldrb w15, [x10, x13]
    strb w15, [x10, x12]
    strb w14, [x10, x13]
    add x12, x12, #1
    sub x13, x13, #1
    b .Ldc_rev
.Ldc_done:
    mov x0, x11
    ret

// az_cat(x0=dst, x1=src, x2=len) -> x0 = dst+len  (append copy, returns new pos)
    .globl _az_cat
_az_cat:
    cbz x2, .Lcat_done
.Lcat_l:
    ldrb w9, [x1], #1
    strb w9, [x0], #1
    subs x2, x2, #1
    b.ne .Lcat_l
.Lcat_done:
    ret

// az_sdec(x0=i64, x1=buf) -> x0 len  (signed decimal)
    .globl _az_sdec
_az_sdec:
    stp x29, x30, [sp, #-16]!
    mov x29, sp
    cmp x0, #0
    b.ge .Lsd_pos
    mov w9, #'-'
    strb w9, [x1], #1
    neg x0, x0
    bl _az_u64_dec
    add x0, x0, #1
    b .Lsd_out
.Lsd_pos:
    bl _az_u64_dec
.Lsd_out:
    ldp x29, x30, [sp], #16
    ret

// az_f64_dec(d0=val, x0=buf) -> x0=len
// NaN->"NaN", integral->int digits, else int.frac up to 6 digits trimmed
    .globl _az_f64_dec
_az_f64_dec:
    stp x29, x30, [sp, #-48]!
    mov x29, sp
    str x0, [sp, #16]        // buf
    mov x10, x0              // cursor
    fcmp d0, d0
    b.vc .Lfd_notnan
    mov w13, #'N'
    strb w13, [x10], #1
    mov w13, #'a'
    strb w13, [x10], #1
    strb w13, [x10], #1
    b .Lfd_done
.Lfd_notnan:
    fcmp d0, #0.0
    b.pl .Lfd_pos
    mov w13, #'-'
    strb w13, [x10], #1
    fneg d0, d0
.Lfd_pos:
    frintm d1, d0
    fcmp d0, d1
    b.eq .Lfd_int
    mov x13, #0x4330000000000000   // 2^52
    fmov d2, x13
    fcmp d0, d2
    b.hs .Lfd_int
    fcvtzs x14, d0
    mov x0, x14
    mov x1, x10
    bl _az_u64_dec
    add x10, x10, x0
    mov w13, #'.'
    strb w13, [x10], #1
    scvtf d1, x14
    fsub d1, d0, d1
    mov x15, #6
.Lfd_frac:
    cbz x15, .Lfd_trim
    mov x13, #10
    scvtf d2, x13
    fmul d1, d1, d2
    fcvtzs x14, d1
    scvtf d3, x14
    fsub d1, d1, d3
    add w13, w14, #'0'
    strb w13, [x10], #1
    sub x15, x15, #1
    b .Lfd_frac
.Lfd_trim:
    ldrb w13, [x10, #-1]
    cmp w13, #'0'
    b.ne .Lfd_trimdot
    sub x10, x10, #1
    b .Lfd_trim
.Lfd_trimdot:
    ldrb w13, [x10, #-1]
    cmp w13, #'.'
    b.ne .Lfd_done
    sub x10, x10, #1
    b .Lfd_done
.Lfd_int:
    // integral (or huge): fcvtzs clamps — fine for messages
    fcvtzs x14, d0
    mov x0, x14
    mov x1, x10
    bl _az_u64_dec
    add x10, x10, x0
.Lfd_done:
    ldr x9, [sp, #16]
    sub x0, x10, x9
    ldp x29, x30, [sp], #48
    ret
