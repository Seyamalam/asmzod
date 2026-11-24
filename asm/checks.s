#include "port.h"
// checks.s — string format validators + check runners
// check record: u8 code + u64 msglen + msg + params
    .text
    .p2align 2

// ---------- az_utf16_units(x0=ptr, x1=len) -> x0 units ----------
// JS .length semantics: 1 unit per code point <=0xFFFF, 2 above
    .globl _az_utf16_units
    AZ_HIDDEN _az_utf16_units
_az_utf16_units:
    // units = bytes - continuation bytes (0x80-0xBF). NEON: count
    // continuations 16B/iter via (b-0x80) unsigned< 0x40
    mov x10, #0              // i
    mov x9, #0               // units
    cmp x1, #32
    b.lo .Luu_tail0
    movi v8.16b, #0x80
    movi v9.16b, #0x40
    movi v4.16b, #0          // cont accumulator
.Luu_simd:
    ldr q0, [x0, x10]
    sub v1.16b, v0.16b, v8.16b
    cmhi v1.16b, v9.16b, v1.16b   // 0xFF per continuation
    sub v4.16b, v4.16b, v1.16b
    add x10, x10, #16
    sub x11, x1, x10
    cmp x11, #16
    b.hs .Luu_simd
    uaddlv h4, v4.16b
    umov w11, v4.h[0]
    sub x9, x10, x11         // simd units = bytes - continuations
.Luu_tail0:
    mov x10, x9              // scalar tail resumes at byte = units+conts
    // recompute byte index: units so far + conts — we have x10 already at
    // the right byte offset only if x9==0; for the simd path byte index
    // IS x10 (loop left it at first tail byte). Just use x10 and keep
    // counting from x9.
    b .Luu_loop
.Luu_loop:
    cmp x10, x1
    b.hs .Luu_done
    ldrb w11, [x0, x10]
    cmp w11, #0x80
    b.lo .Luu_1
    cmp w11, #0xF0
    b.hs .Luu_4
    cmp w11, #0xE0
    b.hs .Luu_3
    // 2-byte seq
    add x10, x10, #2
    add x9, x9, #1
    b .Luu_loop
.Luu_3:
    add x10, x10, #3
    add x9, x9, #1
    b .Luu_loop
.Luu_4:
    add x10, x10, #4
    add x9, x9, #1           // code point (zod4 counts astral as 1)
    b .Luu_loop
.Luu_1:
    add x10, x10, #1
    add x9, x9, #1
    b .Luu_loop
.Luu_done:
    mov x0, x9
    ret

// ---------- az_memmem(x0=hay,x1=hlen,x2=ndl,x3=nlen) -> w0 1/0 ----------
    .globl _az_memmem
    AZ_HIDDEN _az_memmem
_az_memmem:
    cbz x3, .Lmm_yes
    cmp x3, x1
    b.hi .Lmm_no
    sub x4, x1, x3           // last start
    ldrb w7, [x2]
    dup v16.16b, w7          // broadcast first needle byte
    mov x5, #0               // i
.Lmm_vloop:
    sub x10, x1, x5
    cmp x10, #16
    b.lo .Lmm_outer          // <16 haystack bytes left → scalar tail
    ldr q0, [x0, x5]
    cmeq v1.16b, v0.16b, v16.16b
    umaxv b1, v1.16b
    umov w11, v1.b[0]
    cbnz w11, .Lmm_cand0
    add x5, x5, #16
    b .Lmm_vloop
.Lmm_cand0:
    // first-byte candidate(s) in chunk [x5,x5+16) — check each
    mov x6, x5
    add x10, x5, #16
.Lmm_cand:
    cmp x6, x10
    b.hs .Lmm_cdone
    cmp x6, x4
    b.hi .Lmm_no             // no valid start remains
    ldrb w11, [x0, x6]
    cmp w11, w7
    b.ne .Lmm_cnext
    mov x8, #0               // verify full needle
.Lmm_vfy:
    cmp x8, x3
    b.hs .Lmm_yes
    add x9, x6, x8
    ldrb w11, [x0, x9]
    ldrb w12, [x2, x8]
    cmp w11, w12
    b.ne .Lmm_cnext
    add x8, x8, #1
    b .Lmm_vfy
.Lmm_cnext:
    add x6, x6, #1
    b .Lmm_cand
.Lmm_cdone:
    mov x5, x10
    b .Lmm_vloop
.Lmm_outer:
    cmp x5, x4
    b.hi .Lmm_no
    mov x6, #0
.Lmm_inner:
    cmp x6, x3
    b.hs .Lmm_yes
    add x8, x5, x6
    ldrb w11, [x0, x8]
    ldrb w12, [x2, x6]
    cmp w11, w12
    b.ne .Lmm_next
    add x6, x6, #1
    b .Lmm_inner
.Lmm_next:
    add x5, x5, #1
    b .Lmm_outer
.Lmm_yes:
    mov w0, #1
    ret
.Lmm_no:
    mov w0, #0
    ret

// ---------- small char helpers ----------
// w9 = byte; uses w10 scratch
.isdig:  // inlined via macros below (no fn call overhead needed)
// we'll just write ranges inline in each validator.

// ---------- az_is_email(x0=ptr,x1=len) -> w0 1/0 ----------
// local[last char in A-Za-z0-9_+-, others also ' and .] @
// domain: (label '.')+ letters{2,}
    .globl _az_is_email
    AZ_HIDDEN _az_is_email
_az_is_email:
    mov x9, #0               // i
    movi v16.16b, #'0'
    movi v17.16b, #10
    movi v18.16b, #'A'
    movi v19.16b, #26
    movi v20.16b, #'a'
    movi v21.16b, #'@'
.Lem_scan:
    // NEON skip: a whole 16B chunk with no '@' and all valid local chars
    add x10, x9, #16
    cmp x10, x1
    b.hi .Lem_scalar
    ldr q0, [x0, x9]
    cmeq v4.16b, v0.16b, v21.16b   // '@' positions
    umaxv b4, v4.16b
    umov w11, v4.b[0]
    cbnz w11, .Lem_scalar          // '@' in chunk → scalar takes over
    sub v1.16b, v0.16b, v16.16b
    cmhi v1.16b, v17.16b, v1.16b   // 0-9
    sub v2.16b, v0.16b, v18.16b
    cmhi v2.16b, v19.16b, v2.16b   // A-Z
    orr v1.16b, v1.16b, v2.16b
    sub v2.16b, v0.16b, v20.16b
    cmhi v2.16b, v19.16b, v2.16b   // a-z
    orr v1.16b, v1.16b, v2.16b
    movi v5.16b, #'_'
    cmeq v2.16b, v0.16b, v5.16b
    orr v1.16b, v1.16b, v2.16b
    movi v5.16b, #'\''
    cmeq v2.16b, v0.16b, v5.16b
    orr v1.16b, v1.16b, v2.16b
    movi v5.16b, #'+'
    cmeq v2.16b, v0.16b, v5.16b
    orr v1.16b, v1.16b, v2.16b
    movi v5.16b, #'-'
    cmeq v2.16b, v0.16b, v5.16b
    orr v1.16b, v1.16b, v2.16b
    movi v5.16b, #'.'
    cmeq v2.16b, v0.16b, v5.16b
    orr v1.16b, v1.16b, v2.16b
    movi v15.16b, #0
    cmeq v2.16b, v1.16b, v15.16b   // invalid = no class matched
    umaxv b2, v2.16b
    umov w11, v2.b[0]
    cbnz w11, .Lem_no
    mov x9, x10
    b .Lem_scan
.Lem_scalar:
    cmp x9, x1
    b.hs .Lem_no             // no '@'
    ldrb w11, [x0, x9]
    cmp w11, #'@'
    b.eq .Lem_at
    // must be allowed local char: [A-Za-z0-9_'+.-]
    cmp w11, #'0'
    b.lo .Lem_l1
    cmp w11, #'9'
    b.ls .Lem_lok
    cmp w11, #'A'
    b.lo .Lem_l1
    cmp w11, #'Z'
    b.ls .Lem_lok
    cmp w11, #'a'
    b.lo .Lem_l1
    cmp w11, #'z'
    b.ls .Lem_lok
.Lem_l1:
    cmp w11, #'_'
    b.eq .Lem_lok
    cmp w11, #'\''
    b.eq .Lem_lok
    cmp w11, #'+'
    b.eq .Lem_lok
    cmp w11, #'-'
    b.eq .Lem_lok
    cmp w11, #'.'
    b.eq .Lem_lok
    b .Lem_no
.Lem_lok:
    add x9, x9, #1
    b .Lem_scan
.Lem_at:
    // local part: x9 chars [0..x9). must be nonempty and last char in end set
    cbz x9, .Lem_no
    sub x13, x9, #1
    ldrb w11, [x0, x13]
    // end set: A-Za-z0-9_+-
    mov w12, #1
    cmp w11, #'0'
    b.lo .Lem_e1
    cmp w11, #'9'
    b.ls .Lem_eok
    cmp w11, #'A'
    b.lo .Lem_e1
    cmp w11, #'Z'
    b.ls .Lem_eok
    cmp w11, #'a'
    b.lo .Lem_e1
    cmp w11, #'z'
    b.ls .Lem_eok
.Lem_e1:
    cmp w11, #'_'
    b.eq .Lem_eok
    cmp w11, #'+'
    b.eq .Lem_eok
    cmp w11, #'-'
    b.eq .Lem_eok
    mov w12, #0
.Lem_eok:
    cbz w12, .Lem_no
    // domain: i=x9+1 .. end ; labels sep by '.'; last label all letters >=2
    add x9, x9, #1
    mov x10, #0              // labels seen
    mov x13, x9              // label start
.Lem_dlabel:
    cmp x13, x1
    b.hs .Lem_no             // ran out mid-label
    // scan one label: chars [alnum][alnum-]* until '.' or end
    mov x14, x13             // cur
    mov x15, #0              // label len
.Lem_dchar:
    cmp x14, x1
    b.hs .Lem_dend
    ldrb w11, [x0, x14]
    cmp w11, #'.'
    b.eq .Lem_dend
    // allowed: alnum or '-' (but not leading '-' -> pos0 must be alnum)
    mov w12, #1
    cmp w11, #'0'
    b.lo .Lem_d2
    cmp w11, #'9'
    b.ls .Lem_dok
    cmp w11, #'A'
    b.lo .Lem_d2
    cmp w11, #'Z'
    b.ls .Lem_dok
    cmp w11, #'a'
    b.lo .Lem_d2
    cmp w11, #'z'
    b.ls .Lem_dok
.Lem_d2:
    cmp w11, #'-'
    b.eq .Lem_dok
    mov w12, #0
.Lem_dok:
    cbz w12, .Lem_no
    // first char can't be '-'
    cbnz x15, .Lem_dok2
    cmp w11, #'-'
    b.eq .Lem_no
.Lem_dok2:
    add x14, x14, #1
    add x15, x15, #1
    b .Lem_dchar
.Lem_dend:
    cbz x15, .Lem_no          // empty label
    cmp x14, x1
    b.hs .Lem_tld             // hit end -> last label must be letters>=2
    // label was non-final: continue at x14+1
    add x10, x10, #1
    add x13, x14, #1
    b .Lem_dlabel
.Lem_tld:
    // last label [x13, x14): all letters, len>=2, and must have had >=1 dot
    cbz x10, .Lem_no
    cmp x15, #2
    b.lo .Lem_no
    mov x14, x13
.Lem_tldl:
    cmp x14, x1
    b.hs .Lem_yes
    ldrb w11, [x0, x14]
    cmp w11, #'A'
    b.lo .Lem_no
    cmp w11, #'Z'
    b.ls .Lem_tldn
    cmp w11, #'a'
    b.lo .Lem_no
    cmp w11, #'z'
    b.hi .Lem_no
.Lem_tldn:
    add x14, x14, #1
    b .Lem_tldl
.Lem_yes:
    mov w0, #1
    ret
.Lem_no:
    mov w0, #0
    ret

// ---------- az_is_uuid(x0=ptr,x1=len,x2=version) -> w0 ----------
// 8-4-4-4-12 hex; version 0=any else nibble at pos 14 == version
    .globl _az_is_uuid
    AZ_HIDDEN _az_is_uuid
_az_is_uuid:
    cmp x1, #36
    b.ne .Luid_no
    stp x29, x30, [sp, #-32]!
    mov x29, sp
    mov x9, x0                 // keep ptr in x9 — .Luid_scan clobbers x0
    // NEON: 3 masked 16B scans — hex digits everywhere, '-' allowed only
    // at mask positions {8,13} / {18,23} / {23} (loads at 0, 16, 20)
    movi v8.16b, #'0'
    movi v9.16b, #10
    movi v10.16b, #'A'
    movi v11.16b, #'a'
    movi v12.16b, #6
    movi v13.16b, #'-'
    movi v15.16b, #0
    AZ_ADR x11, .Luid_mA
    ldr q14, [x11]
    ldr q0, [x9]
    bl .Luid_scan
    cbnz w0, .Luid_fail
    AZ_ADR x11, .Luid_mB
    ldr q14, [x11]
    ldr q0, [x9, #16]
    bl .Luid_scan
    cbnz w0, .Luid_fail
    AZ_ADR x11, .Luid_mC
    ldr q14, [x11]
    ldr q0, [x9, #20]
    bl .Luid_scan
    cbnz w0, .Luid_fail
    // version nibble at pos 14
    cbz x2, .Luid_ver
    ldrb w14, [x9, #14]
    sub w15, w14, #'0'
    cmp w15, w2
    b.ne .Luid_fail
.Luid_ver:
    mov w0, #1
    ldp x29, x30, [sp], #32
    ret
.Luid_fail:
    mov w0, #0
    ldp x29, x30, [sp], #32
    ret
// .Luid_scan: q0=bytes, q14=dash-mask -> w0=1 if any invalid
.Luid_scan:
    sub v1.16b, v0.16b, v8.16b
    cmhi v1.16b, v9.16b, v1.16b    // 0-9
    sub v2.16b, v0.16b, v10.16b
    cmhi v2.16b, v12.16b, v2.16b   // A-F
    sub v3.16b, v0.16b, v11.16b
    cmhi v3.16b, v12.16b, v3.16b   // a-f
    orr v1.16b, v1.16b, v2.16b
    orr v1.16b, v1.16b, v3.16b
    cmeq v4.16b, v0.16b, v13.16b   // '-'
    and v4.16b, v4.16b, v14.16b    // '-' only at mask positions
    orr v1.16b, v1.16b, v4.16b
    cmeq v4.16b, v1.16b, v15.16b
    umaxv b4, v4.16b
    umov w0, v4.b[0]
    ret
.Luid_slow:
    mov x9, #0
    mov x10, #0              // group idx 0..4
    // group lengths
    AZ_ADR x11, .Luid_groups
.Luid_grp:
    cmp x10, #5
    b.hs .Luid_sver
    ldrb w12, [x11, x10]     // group len
    mov x13, #0
.Luid_hex:
    cmp x13, x12
    b.hs .Luid_grp_end
    ldrb w14, [x0, x9]
    // hex?
    cmp w14, #'0'
    b.lo .Luid_no
    cmp w14, #'9'
    b.ls .Luid_hok
    cmp w14, #'A'
    b.lo .Luid_no
    cmp w14, #'F'
    b.ls .Luid_hok
    cmp w14, #'a'
    b.lo .Luid_no
    cmp w14, #'f'
    b.hi .Luid_no
.Luid_hok:
    // version check at pos 14
    cmp x9, #14
    b.ne .Luid_hn
    cbz x2, .Luid_hn
    sub w15, w14, #'0'
    cmp w15, w2
    b.ne .Luid_no
.Luid_hn:
    add x9, x9, #1
    add x13, x13, #1
    b .Luid_hex
.Luid_grp_end:
    add x10, x10, #1
    cmp x10, #5
    b.hs .Luid_sver
    // expect '-'
    ldrb w14, [x0, x9]
    cmp w14, #'-'
    b.ne .Luid_no
    add x9, x9, #1
    b .Luid_grp
.Luid_sver:
    mov w0, #1
    ret
.Luid_no:
    mov w0, #0
    ret
    AZ_RODATA
    .p2align 4
.Luid_mA: .byte 0,0,0,0,0,0,0,0,0xff,0,0,0,0,0xff,0,0   // pos 8,13
.Luid_mB: .byte 0,0,0xff,0,0,0,0,0xff,0,0,0,0,0,0,0,0   // pos 18,23 (base 16)
.Luid_mC: .byte 0,0,0,0xff,0,0,0,0,0,0,0,0,0,0,0,0,0    // pos 23 (base 20)
.Luid_groups: .byte 8,4,4,4,12
    .text

// ---------- az_is_ulid(x0,x1) : 26 chars crockford b32 ----------
    .globl _az_is_ulid
    AZ_HIDDEN _az_is_ulid
_az_is_ulid:
    cmp x1, #26
    b.ne .Lul_no
    // 26 bytes = two overlapping 16B loads (0 and 10)
    movi v8.16b, #'0'
    movi v9.16b, #10
    movi v10.16b, #'A'
    movi v11.16b, #26
    movi v12.16b, #'I'
    movi v13.16b, #'L'
    movi v14.16b, #'O'
    movi v15.16b, #'U'
    mov x9, #0
.Lul_v:
    ldr q0, [x0, x9]
    sub v1.16b, v0.16b, v8.16b
    cmhi v1.16b, v9.16b, v1.16b      // digit
    sub v2.16b, v0.16b, v10.16b
    cmhi v2.16b, v11.16b, v2.16b     // A-Z
    cmeq v3.16b, v0.16b, v12.16b     // I
    cmeq v4.16b, v0.16b, v13.16b     // L
    cmeq v5.16b, v0.16b, v14.16b     // O
    cmeq v6.16b, v0.16b, v15.16b     // U
    orr v3.16b, v3.16b, v4.16b
    orr v3.16b, v3.16b, v5.16b
    orr v3.16b, v3.16b, v6.16b       // ILOU mask
    bic v2.16b, v2.16b, v3.16b       // letter & !ILOU
    orr v1.16b, v1.16b, v2.16b       // valid
    movi v7.16b, #0
    cmeq v7.16b, v1.16b, v7.16b      // FF where invalid
    umaxv b7, v7.16b
    umov w11, v7.b[0]
    cbnz w11, .Lul_no
    cmp x9, #10
    b.eq .Lul_yes
    mov x9, #10
    b .Lul_v
    mov x9, #0
.Lul_l:
    cmp x9, #26
    b.hs .Lul_yes
    ldrb w11, [x0, x9]
    mov w12, #0
    cmp w11, #'0'
    b.lo .Lul_c
    cmp w11, #'9'
    b.ls .Lul_ok
.Lul_c:
    cmp w11, #'A'
    b.lo .Lul_no
    cmp w11, #'Z'
    b.hi .Lul_no
    // exclude I L O U
    cmp w11, #'I'
    b.eq .Lul_no
    cmp w11, #'L'
    b.eq .Lul_no
    cmp w11, #'O'
    b.eq .Lul_no
    cmp w11, #'U'
    b.eq .Lul_no
.Lul_ok:
    add x9, x9, #1
    b .Lul_l
.Lul_yes:
    mov w0, #1
    ret
.Lul_no:
    mov w0, #0
    ret

// ---------- az_is_nanoid: 21 chars [A-Za-z0-9_-] ----------
    .globl _az_is_nanoid
    AZ_HIDDEN _az_is_nanoid
_az_is_nanoid:
    cmp x1, #21
    b.ne .Lnn_no
    // 21 bytes = two overlapping 16B loads (0 and 5)
    movi v8.16b, #'0'
    movi v9.16b, #10
    movi v10.16b, #'A'
    movi v11.16b, #'a'
    movi v12.16b, #26
    movi v13.16b, #'_'
    movi v14.16b, #'-'
    movi v15.16b, #0
    mov x9, #0
.Lnn_v:
    ldr q0, [x0, x9]
    sub v1.16b, v0.16b, v8.16b
    cmhi v1.16b, v9.16b, v1.16b      // 0-9
    sub v2.16b, v0.16b, v10.16b
    cmhi v2.16b, v12.16b, v2.16b     // A-Z
    sub v3.16b, v0.16b, v11.16b
    cmhi v3.16b, v12.16b, v3.16b     // a-z
    cmeq v4.16b, v0.16b, v13.16b     // _
    cmeq v5.16b, v0.16b, v14.16b     // -
    orr v1.16b, v1.16b, v2.16b
    orr v1.16b, v1.16b, v3.16b
    orr v4.16b, v4.16b, v5.16b
    orr v1.16b, v1.16b, v4.16b
    cmeq v6.16b, v1.16b, v15.16b
    umaxv b6, v6.16b
    umov w11, v6.b[0]
    cbnz w11, .Lnn_no
    cmp x9, #5
    b.eq .Lnn_yes
    mov x9, #5
    b .Lnn_v
    mov x9, #0
.Lnn_l:
    cmp x9, #21
    b.hs .Lnn_yes
    ldrb w11, [x0, x9]
    cmp w11, #'0'
    b.lo .Lnn_c
    cmp w11, #'9'
    b.ls .Lnn_ok
.Lnn_c:
    cmp w11, #'A'
    b.lo .Lnn_c2
    cmp w11, #'Z'
    b.ls .Lnn_ok
.Lnn_c2:
    cmp w11, #'a'
    b.lo .Lnn_c3
    cmp w11, #'z'
    b.ls .Lnn_ok
.Lnn_c3:
    cmp w11, #'_'
    b.eq .Lnn_ok
    cmp w11, #'-'
    b.eq .Lnn_ok
    b .Lnn_no
.Lnn_ok:
    add x9, x9, #1
    b .Lnn_l
.Lnn_yes:
    mov w0, #1
    ret
.Lnn_no:
    mov w0, #0
    ret

// ---------- az_is_cuid2: [a-z][a-z0-9]* len>=2 ----------
    .globl _az_is_cuid2
    AZ_HIDDEN _az_is_cuid2
_az_is_cuid2:
    cmp x1, #2
    b.lo .Lcu_no
    ldrb w11, [x0]
    cmp w11, #'a'
    b.lo .Lcu_no
    cmp w11, #'z'
    b.hi .Lcu_no
    mov x9, #1
.Lcu_l:
    sub x11, x1, x9
    cmp x11, #16
    b.lo .Lcu_sc
    movi v8.16b, #'0'
    movi v9.16b, #10
    movi v10.16b, #'a'
    movi v11.16b, #26
    movi v12.16b, #0
.Lcu_v:
    ldr q0, [x0, x9]
    sub v1.16b, v0.16b, v8.16b
    cmhi v1.16b, v9.16b, v1.16b
    sub v2.16b, v0.16b, v10.16b
    cmhi v2.16b, v11.16b, v2.16b
    orr v1.16b, v1.16b, v2.16b
    cmeq v3.16b, v1.16b, v12.16b
    umaxv b3, v3.16b
    umov w11, v3.b[0]
    cbnz w11, .Lcu_no
    add x9, x9, #16
    sub x11, x1, x9
    cmp x11, #16
    b.hs .Lcu_v
.Lcu_sc:
    cmp x9, x1
    b.hs .Lcu_yes
    ldrb w11, [x0, x9]
    cmp w11, #'0'
    b.lo .Lcu_c
    cmp w11, #'9'
    b.ls .Lcu_ok
.Lcu_c:
    cmp w11, #'a'
    b.lo .Lcu_no
    cmp w11, #'z'
    b.hi .Lcu_no
.Lcu_ok:
    add x9, x9, #1
    b .Lcu_sc
.Lcu_yes:
    mov w0, #1
    ret
.Lcu_no:
    mov w0, #0
    ret

// ---------- az_is_base64: len%4==0, alphabet, <=2 '=' at end ----------
    .globl _az_is_base64
    AZ_HIDDEN _az_is_base64
_az_is_base64:
    cbz x1, .Lb64_no
    and x9, x1, #3
    cbnz x9, .Lb64_no
    // body = len minus trailing '=' (max 2). SIMD alphabet-scan body,
    // then pad bytes must all be '='.
    mov x13, x1               // body end
    sub x10, x1, #1
    ldrb w11, [x0, x10]
    cmp w11, #'='
    b.ne .Lb64_body
    sub x13, x13, #1
    sub x10, x1, #2
    ldrb w11, [x0, x10]
    cmp w11, #'='
    b.ne .Lb64_body
    sub x13, x13, #1
.Lb64_body:
    mov x9, #0
    cmp x13, #16
    b.lo .Lb64_l
    movi v8.16b, #'A'
    movi v9.16b, #26
    movi v10.16b, #'a'
    movi v11.16b, #'0'
    movi v12.16b, #10
    movi v13.16b, #'+'
    movi v14.16b, #'/'
    movi v15.16b, #0
.Lb64_v:
    ldr q0, [x0, x9]
    sub v1.16b, v0.16b, v8.16b
    cmhi v1.16b, v9.16b, v1.16b    // A-Z
    sub v2.16b, v0.16b, v10.16b
    cmhi v2.16b, v9.16b, v2.16b    // a-z
    sub v3.16b, v0.16b, v11.16b
    cmhi v3.16b, v12.16b, v3.16b   // 0-9
    cmeq v4.16b, v0.16b, v13.16b   // '+'
    cmeq v5.16b, v0.16b, v14.16b   // '/'
    orr v1.16b, v1.16b, v2.16b
    orr v1.16b, v1.16b, v3.16b
    orr v4.16b, v4.16b, v5.16b
    orr v1.16b, v1.16b, v4.16b
    cmeq v4.16b, v1.16b, v15.16b   // FF where NOT base64
    umaxv b4, v4.16b
    umov w11, v4.b[0]
    cbnz w11, .Lb64_no
    add x9, x9, #16
    sub x11, x13, x9
    cmp x11, #16
    b.hs .Lb64_v
    b .Lb64_l
.Lb64_l:
    cmp x9, x13
    b.hs .Lb64_pad
    ldrb w11, [x0, x9]
    cmp w11, #'0'
    b.lo .Lb64_c
    cmp w11, #'9'
    b.ls .Lb64_ok
.Lb64_c:
    cmp w11, #'A'
    b.lo .Lb64_c2
    cmp w11, #'Z'
    b.ls .Lb64_ok
.Lb64_c2:
    cmp w11, #'a'
    b.lo .Lb64_c3
    cmp w11, #'z'
    b.ls .Lb64_ok
.Lb64_c3:
    cmp w11, #'+'
    b.eq .Lb64_ok
    cmp w11, #'/'
    b.eq .Lb64_ok
    b .Lb64_no
.Lb64_ok:
    add x9, x9, #1
    b .Lb64_l
.Lb64_pad:
    // pad region [x13, x1) must be all '='
    mov x9, x13
.Lb64_pl:
    cmp x9, x1
    b.hs .Lb64_yes
    ldrb w11, [x0, x9]
    cmp w11, #'='
    b.ne .Lb64_no
    add x9, x9, #1
    b .Lb64_pl
.Lb64_yes:
    mov w0, #1
    ret
.Lb64_no:
    mov w0, #0
    ret

// ---------- az_is_hex ----------
    .globl _az_is_hex
    AZ_HIDDEN _az_is_hex
_az_is_hex:
    cbz x1, .Lhx_yes           // zod: "" is valid hex (*)
    mov x9, #0
    cmp x1, #16
    b.lo .Lhx_l
    // NEON: in-range(b,'0','9') | ('A','F') | ('a','f') per byte
    movi v8.16b, #'0'
    movi v9.16b, #10
    movi v10.16b, #'A'
    movi v11.16b, #'a'
    movi v12.16b, #6
    movi v13.16b, #0
.Lhx_v:
    ldr q0, [x0, x9]
    sub v1.16b, v0.16b, v8.16b
    cmhi v1.16b, v9.16b, v1.16b    // digit
    sub v2.16b, v0.16b, v10.16b
    cmhi v2.16b, v12.16b, v2.16b   // A-F
    sub v3.16b, v0.16b, v11.16b
    cmhi v3.16b, v12.16b, v3.16b   // a-f
    orr v1.16b, v1.16b, v2.16b
    orr v1.16b, v1.16b, v3.16b
    cmeq v4.16b, v1.16b, v13.16b   // FF where NOT hex
    umaxv b4, v4.16b
    umov w11, v4.b[0]
    cbnz w11, .Lhx_no
    add x9, x9, #16
    sub x11, x1, x9
    cmp x11, #16
    b.hs .Lhx_v
.Lhx_l:
    cmp x9, x1
    b.hs .Lhx_yes
    ldrb w11, [x0, x9]
    cmp w11, #'0'
    b.lo .Lhx_no
    cmp w11, #'9'
    b.ls .Lhx_ok
    cmp w11, #'A'
    b.lo .Lhx_no
    cmp w11, #'F'
    b.ls .Lhx_ok
    cmp w11, #'a'
    b.lo .Lhx_no
    cmp w11, #'f'
    b.hi .Lhx_no
.Lhx_ok:
    add x9, x9, #1
    b .Lhx_l
.Lhx_yes:
    mov w0, #1
    ret
.Lhx_no:
    mov w0, #0
    ret

// ---------- az_is_ipv4: a.b.c.d, 1-3 digits each, <=255, no leading 0 ----------
    .globl _az_is_ipv4
    AZ_HIDDEN _az_is_ipv4
_az_is_ipv4:
    mov x9, #0               // pos
    mov x10, #0              // part idx
.Lip4_part:
    cmp x10, #4
    b.hs .Lip4_yes
    mov x11, #0              // digits
    mov x12, #0              // value
.Lip4_d:
    cmp x9, x1
    b.hs .Lip4_no
    ldrb w13, [x0, x9]
    cmp w13, #'0'
    b.lo .Lip4_no
    cmp w13, #'9'
    b.hi .Lip4_no
    sub w14, w13, #'0'
    mov x15, #10
    mul x12, x12, x15
    add x12, x12, x14
    add x9, x9, #1
    add x11, x11, #1
    cmp x11, #3
    b.lo .Lip4_d2
    // 3 digits max: next must be '.' or end
    b .Lip4_pend
.Lip4_d2:
    // peek next: continue if digit
    cmp x9, x1
    b.hs .Lip4_pend
    ldrb w13, [x0, x9]
    cmp w13, #'0'
    b.lo .Lip4_pend
    cmp w13, #'9'
    b.ls .Lip4_d
.Lip4_pend:
    cbz x11, .Lip4_no
    cmp x12, #255
    b.hi .Lip4_no
    // leading zero check: >1 digit and first digit was '0'
    cmp x11, #1
    b.eq .Lip4_sep
    sub x14, x9, x11
    ldrb w13, [x0, x14]
    cmp w13, #'0'
    b.eq .Lip4_no
.Lip4_sep:
    cmp x10, #3
    b.hs .Lip4_last
    cmp x9, x1
    b.hs .Lip4_no
    ldrb w13, [x0, x9]
    cmp w13, #'.'
    b.ne .Lip4_no
    add x9, x9, #1
    add x10, x10, #1
    b .Lip4_part
.Lip4_last:
    // must be end
    cmp x9, x1
    b.ne .Lip4_no
.Lip4_yes:
    mov w0, #1
    ret
.Lip4_no:
    mov w0, #0
    ret

// ---------- az_is_ipv6: WHATWG-style parser ----------
// alphabet [0-9a-fA-F:.], at most one "::", pieces 1-4 hex digits,
// optional trailing IPv4 piece (counts as 2 groups). no "::" -> exactly
// 8 groups; "::" -> fewer than 8 (it must compress at least one).
    .globl _az_is_ipv6
    AZ_HIDDEN _az_is_ipv6
_az_is_ipv6:
    stp x29, x30, [sp, #-48]!
    stp x19, x20, [sp, #16]
    stp x21, x22, [sp, #32]
    cbz x1, .L6no
    mov x9, #0               // i
    mov x10, #-1             // "::" index
.L6a:
    ldrb w11, [x0, x9]
    cmp w11, #':'
    b.eq .L6a_col
    cmp w11, #'.'
    b.eq .L6a_next
    sub w12, w11, #'0'
    cmp w12, #9
    b.ls .L6a_next
    orr w12, w11, #0x20
    sub w12, w12, #'a'
    cmp w12, #5
    b.hi .L6no
    b .L6a_next
.L6a_col:
    add w12, w9, #1
    cmp w12, w1
    b.hs .L6a_next
    ldrb w13, [x0, x12]
    cmp w13, #':'
    b.ne .L6a_next
    cmn x10, #1
    b.ne .L6no               // second "::" -> invalid
    mov x10, x9
    add x9, x9, #1           // skip the pair's second ':'
.L6a_next:
    add x9, x9, #1
    cmp x9, x1
    b.lo .L6a
    cmn x10, #1
    b.ne .L6split
    mov x2, #1               // whole string is the last part
    bl .L6count
    cmp x0, #8
    b.eq .L6yes
    b .L6no
.L6split:
    mov x19, x0
    mov x20, x1
    mov x21, x10             // dc index
    mov x1, x10              // left = [0, dc)
    mov x2, #0               // not the final part
    bl .L6count
    cmn x0, #1
    b.eq .L6no
    mov x22, x0              // ln
    add x9, x21, #2
    add x0, x19, x9          // right ptr
    sub x1, x20, x9          // right len
    mov x2, #1
    bl .L6count
    cmn x0, #1
    b.eq .L6no
    add x0, x0, x22
    cmp x0, #8
    b.lo .L6yes
.L6no:
    mov w0, #0
    b .L6out
.L6yes:
    mov w0, #1
.L6out:
    ldp x19, x20, [sp, #16]
    ldp x21, x22, [sp, #32]
    ldp x29, x30, [sp], #48
    ret

// .L6count(x0=ptr, x1=len, x2=isLast) -> x0 = group count or -1
// groups are 1-4 hex digits (+1); a piece containing '.' must be the
// last group of a last part and parse as IPv4 (+2). empty -> 0.
.L6count:
    cbz x1, .L6c_ret0
    mov x9, #0               // group start
    mov x14, #0              // total
.L6c_grp:
    mov x10, x9              // scan cursor
    mov x16, #-1             // dot position inside piece
.L6c_scan:
    cmp x10, x1
    b.hs .L6c_gend
    ldrb w11, [x0, x10]
    cmp w11, #':'
    b.eq .L6c_gend
    cmp w11, #'.'
    b.ne .L6c_sn
    mov x16, x10
.L6c_sn:
    add x10, x10, #1
    b .L6c_scan
.L6c_gend:
    sub x11, x10, x9         // glen
    cbz x11, .L6c_fail       // empty group
    cmn x16, #1
    b.ne .L6c_v4
    cmp x11, #4
    b.hi .L6c_fail           // hex piece > 4 digits
    mov x12, x9
.L6c_hx:
    ldrb w13, [x0, x12]
    sub w15, w13, #'0'
    cmp w15, #9
    b.ls .L6c_hxn
    orr w15, w13, #0x20
    sub w15, w15, #'a'
    cmp w15, #5
    b.hi .L6c_fail
.L6c_hxn:
    add x12, x12, #1
    cmp x12, x10
    b.lo .L6c_hx
    add x14, x14, #1
    b .L6c_gn
.L6c_v4:
    cmp x10, x1
    b.ne .L6c_fail           // dotted piece must be the last group
    cbz x2, .L6c_fail        // and only in the final part
    mov x12, x9              // pos
    mov x13, #0              // dot count
    mov w15, #0              // octet value
    mov x17, #0              // octet digits
.L6c_v4l:
    cmp x12, x10
    b.hs .L6c_v4e
    ldrb w11, [x0, x12]
    cmp w11, #'.'
    b.eq .L6c_v4dot
    sub w11, w11, #'0'
    cmp w11, #9
    b.hi .L6c_fail
    cbnz x17, .L6c_v4dig
    cmp w11, #0
    cset x2, eq              // leading zero flag for this octet
    b .L6c_v4acc
.L6c_v4dig:
    cbnz x2, .L6c_fail       // leading zero + more digits (WHATWG)
.L6c_v4acc:
    mov w16, #10
    mul w15, w15, w16
    add w15, w15, w11
    add x17, x17, #1
    cmp x17, #3
    b.hi .L6c_fail           // octet > 3 digits
    add x12, x12, #1
    b .L6c_v4l
.L6c_v4dot:
    cbz x17, .L6c_fail       // empty octet
    cmp w15, #255
    b.hi .L6c_fail
    mov w15, #0
    mov x17, #0
    add x13, x13, #1
    cmp x13, #3
    b.hi .L6c_fail           // more than 3 dots
    add x12, x12, #1
    b .L6c_v4l
.L6c_v4e:
    cbz x17, .L6c_fail       // trailing octet empty
    cmp w15, #255
    b.hi .L6c_fail
    cmp x13, #3
    b.ne .L6c_fail           // need exactly 3 dots
    add x14, x14, #2         // IPv4 tail counts as two groups
.L6c_gn:
    cmp x10, x1
    b.hs .L6c_done
    add x9, x10, #1          // skip ':'
    b .L6c_grp
.L6c_done:
    mov x0, x14
    ret
.L6c_ret0:
    mov x0, #0
    ret
.L6c_fail:
    mov x0, #-1
    ret

// ---------- az_is_hash: fixed-length hash digest ----------
// (x0=str, x1=len, x2=bodylen, w3=alpha 0hex/1b64/2b64url, x4=padlen) -> w0
// exact length bodylen+padlen; pad tail is '=' x padlen; body in alphabet
    .globl _az_is_hash
    AZ_HIDDEN _az_is_hash
_az_is_hash:
    add x9, x2, x4
    cmp x1, x9
    b.ne .Lhz_no
    mov x10, x1
.Lhz_pad:
    cbz x4, .Lhz_body
    sub x4, x4, #1
    sub x10, x10, #1
    ldrb w11, [x0, x10]
    cmp w11, #'='
    b.ne .Lhz_no
    b .Lhz_pad
.Lhz_body:
    mov x9, #0
.Lhz_l:
    cmp x9, x2
    b.hs .Lhz_yes
    ldrb w11, [x0, x9]
    cmp w3, #0
    b.eq .Lhz_hex
    sub w12, w11, #'0'
    cmp w12, #9
    b.ls .Lhz_ok
    orr w12, w11, #0x20
    sub w12, w12, #'a'
    cmp w12, #25
    b.ls .Lhz_ok
    cmp w3, #1
    b.eq .Lhz_b64x
    cmp w11, #'-'
    b.eq .Lhz_ok
    cmp w11, #'_'
    b.eq .Lhz_ok
    b .Lhz_no
.Lhz_b64x:
    cmp w11, #'+'
    b.eq .Lhz_ok
    cmp w11, #'/'
    b.eq .Lhz_ok
    b .Lhz_no
.Lhz_hex:
    sub w12, w11, #'0'
    cmp w12, #9
    b.ls .Lhz_ok
    orr w12, w11, #0x20
    sub w12, w12, #'a'
    cmp w12, #5
    b.hi .Lhz_no
.Lhz_ok:
    add x9, x9, #1
    b .Lhz_l
.Lhz_yes:
    mov w0, #1
    ret
.Lhz_no:
    mov w0, #0
    ret

// ---------- az_is_datetime / datestr / timestr ----------
// digits helper: w14=w13-'0' valid if <=9 — inline

// az_is_datestr(x0,x1): YYYY-MM-DD
    .globl _az_is_datestr
    AZ_HIDDEN _az_is_datestr
_az_is_datestr:
    cmp x1, #10
    b.ne .Lds_no
    // NEON: two overlapping 8B loads cover "YYYY-MM-DD"
    ldr d0, [x0]               // pos 0-7
    ldr d1, [x0, #2]           // pos 2-9
    movi v16.16b, #'0'
    movi v17.16b, #10
    movi v18.16b, #'-'
    sub v2.8b, v0.8b, v16.8b
    cmhi v2.8b, v17.8b, v2.8b  // digit mask (d0)
    AZ_ADR x9, .Lds_E0
    ldr d3, [x9]
    bic v4.8b, v3.8b, v2.8b    // required digits missing
    AZ_ADR x9, .Lds_D0
    ldr d5, [x9]
    cmeq v6.8b, v0.8b, v18.8b
    bic v7.8b, v5.8b, v6.8b    // required dashes missing
    orr v4.8b, v4.8b, v7.8b
    sub v2.8b, v1.8b, v16.8b
    cmhi v2.8b, v17.8b, v2.8b
    AZ_ADR x9, .Lds_E1
    ldr d3, [x9]
    bic v5.8b, v3.8b, v2.8b
    orr v4.8b, v4.8b, v5.8b
    AZ_ADR x9, .Lds_D1
    ldr d5, [x9]
    cmeq v6.8b, v1.8b, v18.8b
    bic v7.8b, v5.8b, v6.8b
    orr v4.8b, v4.8b, v7.8b
    umaxv b4, v4.8b
    umov w9, v4.b[0]
    cbnz w9, .Lds_no
    // MM
    ldrb w11, [x0, #5]
    sub w12, w11, #'0'
    cmp w12, #9
    b.hi .Lds_no
    ldrb w11, [x0, #6]
    sub w13, w11, #'0'
    cmp w13, #9
    b.hi .Lds_no
    mov w14, #10
    mul w12, w12, w14
    add w12, w12, w13        // month
    cmp w12, #1
    b.lo .Lds_no
    cmp w12, #12
    b.hi .Lds_no
    // DD
    ldrb w11, [x0, #8]
    sub w12, w11, #'0'
    cmp w12, #9
    b.hi .Lds_no
    ldrb w11, [x0, #9]
    sub w13, w11, #'0'
    cmp w13, #9
    b.hi .Lds_no
    mul w12, w12, w14
    add w12, w12, w13
    cmp w12, #1
    b.lo .Lds_no
    cmp w12, #31
    b.hi .Lds_no
    mov w0, #1
    ret
.Lds_no:
    mov w0, #0
    ret
    AZ_RODATA
.Lds_E0: .byte 0xFF,0xFF,0xFF,0xFF,0x00,0xFF,0xFF,0x00
.Lds_D0: .byte 0x00,0x00,0x00,0x00,0xFF,0x00,0x00,0xFF
.Lds_E1: .byte 0x00,0x00,0x00,0xFF,0xFF,0x00,0xFF,0xFF
.Lds_D1: .byte 0x00,0x00,0x00,0x00,0x00,0xFF,0x00,0x00
    .text

// az_is_timestr(x0,x1): HH:MM[:SS[.frac]]  len 5|8|>8
    .globl _az_is_timestr
    AZ_HIDDEN _az_is_timestr
_az_is_timestr:
    cmp x1, #5
    b.lo .Lts_no
    // HH
    ldrb w11, [x0]
    sub w12, w11, #'0'
    cmp w12, #9
    b.hi .Lts_no
    ldrb w11, [x0, #1]
    sub w13, w11, #'0'
    cmp w13, #9
    b.hi .Lts_no
    mov w14, #10
    mul w12, w12, w14
    add w12, w12, w13
    cmp w12, #23
    b.hi .Lts_no
    ldrb w11, [x0, #2]
    cmp w11, #':'
    b.ne .Lts_no
    // MM
    ldrb w11, [x0, #3]
    sub w12, w11, #'0'
    cmp w12, #9
    b.hi .Lts_no
    ldrb w11, [x0, #4]
    sub w13, w11, #'0'
    cmp w13, #9
    b.hi .Lts_no
    mul w12, w12, w14
    add w12, w12, w13
    cmp w12, #59
    b.hi .Lts_no
    cmp x1, #5
    b.eq .Lts_yes
    // :SS
    cmp x1, #8
    b.lo .Lts_no
    ldrb w11, [x0, #5]
    cmp w11, #':'
    b.ne .Lts_no
    ldrb w11, [x0, #6]
    sub w12, w11, #'0'
    cmp w12, #9
    b.hi .Lts_no
    ldrb w11, [x0, #7]
    sub w13, w11, #'0'
    cmp w13, #9
    b.hi .Lts_no
    mul w12, w12, w14
    add w12, w12, w13
    cmp w12, #59
    b.hi .Lts_no
    cmp x1, #8
    b.eq .Lts_yes
    // .frac : '.' + 1+ digits
    ldrb w11, [x0, #8]
    cmp w11, #'.'
    b.ne .Lts_no
    mov x9, #9
    mov x10, #0
.Lts_fl:
    cmp x9, x1
    b.hs .Lts_fend
    ldrb w11, [x0, x9]
    cmp w11, #'0'
    b.lo .Lts_no
    cmp w11, #'9'
    b.hi .Lts_no
    add x9, x9, #1
    add x10, x10, #1
    b .Lts_fl
.Lts_fend:
    cbz x10, .Lts_no
.Lts_yes:
    mov w0, #1
    ret
.Lts_no:
    mov w0, #0
    ret

// az_is_datetime(x0=ptr, x1=len, x2=flags) -> w0
// flags bit0: allow ±HH:MM offset (zod3 datetime({offset:true}))
// format: datestr 'T' timestr tz ; tz = 'Z'|'z' or ±HH:MM (if allowed)
    .globl _az_is_datetime
    AZ_HIDDEN _az_is_datetime
_az_is_datetime:
    stp x29, x30, [sp, #-64]!
    mov x29, sp
    stp x0, x1, [sp, #16]     // ptr,len
    str x2, [sp, #32]         // flags
    cmp x1, #17               // min: 10+T+HH:MM+Z
    b.lo .Ldt_no
    mov x1, #10
    bl _az_is_datestr
    cbz w0, .Ldt_no
    ldp x0, x1, [sp, #16]
    ldrb w11, [x0, #10]
    cmp w11, #'T'
    b.ne .Ldt_no
    // tz: last char 'Z'/'z' -> 1 ; else ±HH:MM (6, needs flag)
    sub x13, x1, #1
    ldrb w11, [x0, x13]
    mov x14, #0               // tz len
    cmp w11, #'Z'
    b.eq .Ldt_tz1
    cmp w11, #'z'
    b.eq .Ldt_tz1
    ldr x9, [sp, #32]
    tbz x9, #0, .Ldt_no       // offset not allowed
    cmp x1, #23               // need room for ±HH:MM
    b.lo .Ldt_no
    sub x13, x1, #6
    ldrb w11, [x0, x13]
    cmp w11, #'+'
    b.eq .Ldt_tz6
    cmp w11, #'-'
    b.eq .Ldt_tz6
    b .Ldt_no
.Ldt_tz1:
    mov x14, #1
    b .Ldt_tzval
.Ldt_tz6:
    mov x14, #6
    // validate "±HH:MM" digits at len-5..len-1
    ldp x0, x1, [sp, #16]
    sub x13, x1, #5
    add x13, x0, x13
    ldrb w11, [x13]
    sub w12, w11, #'0'
    cmp w12, #9
    b.hi .Ldt_no
    ldrb w11, [x13, #1]
    sub w15, w11, #'0'
    cmp w15, #9
    b.hi .Ldt_no
    mov w9, #10
    mul w12, w12, w9
    add w12, w12, w15
    cmp w12, #23
    b.hi .Ldt_no
    ldrb w11, [x13, #2]
    cmp w11, #':'
    b.ne .Ldt_no
    ldrb w11, [x13, #3]
    sub w12, w11, #'0'
    cmp w12, #9
    b.hi .Ldt_no
    ldrb w11, [x13, #4]
    sub w15, w11, #'0'
    cmp w15, #9
    b.hi .Ldt_no
    mul w12, w12, w9
    add w12, w12, w15
    cmp w12, #59
    b.hi .Ldt_no
.Ldt_tzval:
    // time = [11, len-tzlen)
    ldp x0, x1, [sp, #16]
    sub x15, x1, x14
    add x0, x0, #11
    sub x1, x15, #11
    bl _az_is_timestr
    cbz w0, .Ldt_no
    mov w0, #1
    b .Ldt_out
.Ldt_no:
    mov w0, #0
.Ldt_out:
    ldp x29, x30, [sp], #64
    ret

// ---------- az_issue_invstr ----------
// (x0=validation ptr, x1=len, x2=msgptr, x3=msglen,
//  x4=extraKey ptr, x5=extraKeyLen, x6=extraVal ptr, x7=extraValLen) -> x0 0/-4
// issue code 7 (invalid_string) + field "validation" (+optional extra field)
    .globl _az_issue_invstr
    AZ_HIDDEN _az_issue_invstr
_az_issue_invstr:
    stp x29, x30, [sp, #-96]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    stp x4, x5, [sp, #48]       // extra key
    stp x6, x7, [sp, #64]       // extra val
    mov x1, x2
    mov x2, x3
    mov x0, #7
    bl _az_issue_begin
    cbnz x0, .Lis_out
    AZ_ADR x0, ak_validation
    mov x1, #10
    ldp x2, x3, [sp, #16]
    bl _az_issue_f_str
    cbnz x0, .Lis_out
    ldr x1, [sp, #56]           // extra key len
    cbz x1, .Lis_commit
    ldr x0, [sp, #48]
    ldp x2, x3, [sp, #64]
    bl _az_issue_f_str
    cbnz x0, .Lis_out
.Lis_commit:
    bl _az_issue_commit
    mov x0, #0
.Lis_out:
    ldp x29, x30, [sp], #96
    ret

// ---------- az_issue_size ----------
// too_small(8)/too_big(9)
// x0=code, x1=typeptr, x2=typelen, x3=bound f64 bits, w4=inclusive, w5=exact,
// x6=msgptr, x7=msglen  -> x0 0/-4
    .globl _az_issue_size
    AZ_HIDDEN _az_issue_size
_az_issue_size:
    stp x29, x30, [sp, #-96]!
    mov x29, sp
    stp x1, x2, [sp, #16]    // type
    str x3, [sp, #32]        // bound bits
    stp x4, x5, [sp, #40]    // incl/exact (w's in x slots)
    str x0, [sp, #56]        // code
    // zod default message, when no custom msg: "Too small|big: expected
    // <type> to have|be [exactly|op]<bound>[ characters|items]"
    cbnz x7, .Lsz_begin
    // bound integral? f64 -> i64 round-trip; non-integral/huge -> skip msg
    ldr x3, [sp, #32]
    fmov d1, x3
    fcvtzs x9, d1
    scvtf d2, x9
    fcmp d1, d2
    b.ne .Lsz_begin
    // -0 and bounds needing exponent text -> let TS build it
    mov x10, #0x7ff
    lsl x10, x10, #52
    and x11, x3, x10
    lsr x11, x11, #52            // exp field
    cmp x11, #0x43c              // >=2^61ish -> bail (JS uses e+nn)
    b.hs .Lsz_begin
    str x9, [sp, #64]            // bound i64
    AZ_ADR x13, _az_msgbuf
    str x13, [sp, #72]           // cursor
    // "Too small: expected " / "Too big: expected "
    ldr x0, [sp, #72]
    ldr x10, [sp, #56]
    cmp x10, #9
    b.eq .Lsz_pmax
    AZ_ADR x1, .Lm_toosmall
    mov x2, #20
    b .Lsz_pref
.Lsz_pmax:
    AZ_ADR x1, .Lm_toobig
    mov x2, #18
.Lsz_pref:
    bl _az_msgcat
    str x0, [sp, #72]
    // type
    ldr x0, [sp, #72]
    ldp x1, x2, [sp, #16]
    bl _az_msgcat
    str x0, [sp, #72]
    // string|array -> " to have " + unit; else " to be "
    ldp x10, x11, [sp, #16]
    mov x14, #0                  // have=0
    cmp x11, #6
    b.ne .Lsz_tarr
    mov x0, x10
    AZ_ADR x1, ak_str6
    mov x2, #6
    bl _az_memeq
    cbz w0, .Lsz_tarr
    mov x14, #1
    b .Lsz_thave
.Lsz_tarr:
    ldp x10, x11, [sp, #16]
    cmp x11, #5
    b.ne .Lsz_tbe
    mov x0, x10
    AZ_ADR x1, ak_arr5
    mov x2, #5
    bl _az_memeq
    cbz w0, .Lsz_tbe
    mov x14, #1
.Lsz_thave:
    str x14, [sp, #80]
    ldr x0, [sp, #72]
    AZ_ADR x1, .Lm_tohave
    mov x2, #9
    b .Lsz_mid
.Lsz_tbe:
    str x14, [sp, #80]
    ldr x0, [sp, #72]
    AZ_ADR x1, .Lm_tobe
    mov x2, #7
.Lsz_mid:
    bl _az_msgcat
    str x0, [sp, #72]
    // exactly | op
    ldr w10, [sp, #48]
    cbz w10, .Lsz_op
    ldr x0, [sp, #72]
    AZ_ADR x1, .Lm_exactly
    mov x2, #8
    bl _az_msgcat
    str x0, [sp, #72]
    b .Lsz_num
.Lsz_op:
    // code8: incl -> ">=" else ">"; code9: incl -> "<=" else "<"
    ldr x0, [sp, #72]
    ldr x10, [sp, #56]
    ldr w11, [sp, #40]           // inclusive
    cmp x10, #9
    b.eq .Lsz_opmax
    cbz w11, .Lsz_gt
    AZ_ADR x1, .Lm_gte
    mov x2, #2
    b .Lsz_opc
.Lsz_gt:
    AZ_ADR x1, .Lm_gt
    mov x2, #1
    b .Lsz_opc
.Lsz_opmax:
    cbz w11, .Lsz_lt
    AZ_ADR x1, .Lm_lte
    mov x2, #2
    b .Lsz_opc
.Lsz_lt:
    AZ_ADR x1, .Lm_lt
    mov x2, #1
.Lsz_opc:
    bl _az_msgcat
    str x0, [sp, #72]
.Lsz_num:
    ldr x0, [sp, #72]
    ldr x1, [sp, #64]
    mov x9, x0
    mov x0, x1
    mov x1, x9
    bl _az_i64toa
    ldr x9, [sp, #72]
    add x9, x9, x0
    str x9, [sp, #72]
    // unit for string|array origins
    ldr x10, [sp, #80]
    cbz x10, .Lsz_setd
    ldr x0, [sp, #72]
    ldp x10, x11, [sp, #16]
    cmp x11, #6
    b.ne .Lsz_items
    AZ_ADR x1, .Lm_chars
    mov x2, #11
    b .Lsz_unit
.Lsz_items:
    AZ_ADR x1, .Lm_items
    mov x2, #6
.Lsz_unit:
    bl _az_msgcat
    str x0, [sp, #72]
.Lsz_setd:
    AZ_ADR x9, _az_msgbuf
    ldr x10, [sp, #72]
    sub x10, x10, x9
    AZ_ADR x11, _az_default_msg
    stp x9, x10, [x11]
.Lsz_begin:
    ldr x0, [sp, #56]
    mov x1, x6
    mov x2, x7
    bl _az_issue_begin
    cbnz x0, .Lsz_out
    // minimum|maximum field by code
    ldr x10, [sp, #56]
    cmp x10, #9
    b.eq .Lsz_max
    AZ_ADR x0, ak_minimum
    mov x1, #7
    b .Lsz_bound
.Lsz_max:
    AZ_ADR x0, ak_maximum
    mov x1, #7
.Lsz_bound:
    ldr d0, [sp, #32]
    bl _az_issue_f_f64
    cbnz x0, .Lsz_out
    // type
    AZ_ADR x0, ak_type
    mov x1, #6
    ldp x2, x3, [sp, #16]
    bl _az_issue_f_str
    cbnz x0, .Lsz_out
    // inclusive
    AZ_ADR x0, ak_inclusive
    mov x1, #9
    ldr w2, [sp, #40]
    bl _az_issue_f_bool
    cbnz x0, .Lsz_out
    // exact (only if set)
    ldr w9, [sp, #48]
    cbz w9, .Lsz_nc
    AZ_ADR x0, ak_exact
    mov x1, #5
    mov w2, #1
    bl _az_issue_f_bool
    cbnz x0, .Lsz_out
.Lsz_nc:
    // _nc marker for payload-level (non-check) size issues, e.g. tuple arity —
    // zod counts such failures as aborted for union best-match purposes
    AZ_ADR x9, az_nc_flag
    ldrb w9, [x9]
    cbz w9, .Lsz_arity
    AZ_ADR x0, ak_nc
    mov x1, #3
    mov w2, #1
    bl _az_issue_f_bool
    cbnz x0, .Lsz_out
.Lsz_arity:
    // _arity marker — tuple arity issues order code-first in zod, unlike
    // check issues (origin-first); the TS normalizer keys on this
    AZ_ADR x9, az_arity_flag
    ldrb w9, [x9]
    cbz w9, .Lsz_commit
    AZ_ADR x0, ak_arity
    mov x1, #6
    mov w2, #1
    bl _az_issue_f_bool
    cbnz x0, .Lsz_out
.Lsz_commit:
    bl _az_issue_commit
    mov x0, #0
.Lsz_out:
    ldp x29, x30, [sp], #96
    ret

    AZ_RODATA
.Lm_toosmall: .ascii "Too small: expected "
.Lm_toobig:   .ascii "Too big: expected "
.Lm_tohave:   .ascii " to have "
.Lm_tobe:     .ascii " to be "
.Lm_exactly:  .ascii "exactly "
.Lm_gte:      .ascii ">="
.Lm_gt:       .ascii ">"
.Lm_lte:      .ascii "<="
.Lm_lt:       .ascii "<"
.Lm_chars:    .ascii " characters"
.Lm_items:    .ascii " items"
ak_str6:      .ascii "string"
ak_arr5:      .ascii "array"
    .globl ams_atleast
    AZ_HIDDEN ams_atleast
    .globl ams_atmost
    AZ_HIDDEN ams_atmost
    .globl ams_exactly
    AZ_HIDDEN ams_exactly
    .globl ams_chars
    AZ_HIDDEN ams_chars
    .globl ama_atleast
    AZ_HIDDEN ama_atleast
    .globl ama_atmost
    AZ_HIDDEN ama_atmost
    .globl ama_exactly
    AZ_HIDDEN ama_exactly
    .globl ama_elems
    AZ_HIDDEN ama_elems
    .globl amn_gt
    AZ_HIDDEN amn_gt
    .globl amn_gte
    AZ_HIDDEN amn_gte
    .globl amn_lt
    AZ_HIDDEN amn_lt
    .globl amn_lte
    AZ_HIDDEN amn_lte
    .globl amn_mult
    AZ_HIDDEN amn_mult
    .globl amb_gt
    AZ_HIDDEN amb_gt
    .globl amb_gte
    AZ_HIDDEN amb_gte
    .globl amb_lt
    AZ_HIDDEN amb_lt
    .globl amb_lte
    AZ_HIDDEN amb_lte
    .globl amb_mult
    AZ_HIDDEN amb_mult
    .globl amd_min
    AZ_HIDDEN amd_min
    .globl amd_max
    AZ_HIDDEN amd_max
    .globl ak_validation
    AZ_HIDDEN ak_validation
ak_validation: .ascii "validation"
    .globl ak_minimum
    AZ_HIDDEN ak_minimum
ak_minimum:    .ascii "minimum"
    .globl ak_maximum
    AZ_HIDDEN ak_maximum
ak_maximum:    .ascii "maximum"
    .globl ak_type
    AZ_HIDDEN ak_type
ak_type:       .ascii "origin"
    .globl ak_inclusive
    AZ_HIDDEN ak_inclusive
ak_inclusive:  .ascii "inclusive"
    .globl ak_exact
    AZ_HIDDEN ak_exact
ak_exact:      .ascii "exact"
    .globl ak_nc
    AZ_HIDDEN ak_nc
ak_nc:         .ascii "_nc"
    .globl ak_arity
    AZ_HIDDEN ak_arity
ak_arity:      .ascii "_arity"
    AZ_WDATA
    .globl az_nc_flag
    AZ_HIDDEN az_nc_flag
az_nc_flag:    .byte 0
    .globl az_arity_flag
    AZ_HIDDEN az_arity_flag
az_arity_flag: .byte 0
    .text
ams_atleast:   .ascii "String must contain at least "
ams_atmost:    .ascii "String must contain at most "
ams_exactly:   .ascii "String must contain exactly "
ams_chars:     .ascii " character(s)"
ama_atleast:   .ascii "Array must contain at least "
ama_atmost:    .ascii "Array must contain at most "
ama_exactly:   .ascii "Array must contain exactly "
ama_elems:     .ascii " element(s)"
amn_gt:        .ascii "Number must be greater than "
amn_gte:       .ascii "Number must be greater than or equal to "
amn_lt:        .ascii "Number must be less than "
amn_lte:       .ascii "Number must be less than or equal to "
amn_mult:      .ascii "Number must be a multiple of "
amb_gt:        .ascii "Bigint must be greater than "
amb_gte:       .ascii "Bigint must be greater than or equal to "
amb_lt:        .ascii "Bigint must be less than "
amb_lte:       .ascii "Bigint must be less than or equal to "
amb_mult:      .ascii "Bigint must be a multiple of "
amd_min:       .ascii "Date must be later than "
amd_max:       .ascii "Date must be earlier than "

    .text
    .p2align 2

// ---------- message builders ----------
// az_msg_size(x0=outbuf, x1=prefixptr, x2=prefixlen, x3=n u64, x4=suffixptr, x5=suffixlen)
// -> x0 = msglen. "prefix<n>suffix"
    .globl _az_msg_size
    AZ_HIDDEN _az_msg_size
_az_msg_size:
    stp x29, x30, [sp, #-64]!
    mov x29, sp
    stp x0, x3, [sp, #16]
    stp x4, x5, [sp, #32]
    mov x10, x0
    // prefix
    mov x11, x1
    mov x12, x2
.Lmsb1:
    cbz x12, .Lmsb2
    ldrb w13, [x11], #1
    strb w13, [x10], #1
    sub x12, x12, #1
    b .Lmsb1
.Lmsb2:
    // n
    ldr x0, [sp, #24]
    mov x1, x10
    bl _az_u64_dec
    add x10, x10, x0
    // suffix
    ldp x11, x12, [sp, #32]
.Lmsb3:
    cbz x12, .Lmsb4
    ldrb w13, [x11], #1
    strb w13, [x10], #1
    sub x12, x12, #1
    b .Lmsb3
.Lmsb4:
    ldr x9, [sp, #16]
    sub x0, x10, x9
    ldp x29, x30, [sp], #64
    ret

// az_msg_f64(x0=outbuf, x1=prefixptr, x2=prefixlen, d0=n, x3=suffixptr, x4=suffixlen)
// -> x0 = msglen
    .globl _az_msg_f64
    AZ_HIDDEN _az_msg_f64
_az_msg_f64:
    stp x29, x30, [sp, #-64]!
    mov x29, sp
    stp x0, x3, [sp, #16]
    stp x4, xzr, [sp, #32]
    str d0, [sp, #48]
    mov x10, x0
    mov x11, x1
    mov x12, x2
.Lmfb1:
    cbz x12, .Lmfb2
    ldrb w13, [x11], #1
    strb w13, [x10], #1
    sub x12, x12, #1
    b .Lmfb1
.Lmfb2:
    ldr d0, [sp, #48]
    mov x0, x10
    str x10, [sp, #56]         // x10 is caller-saved; f64_dec clobbers it
    bl _az_f64_dec
    ldr x10, [sp, #56]
    add x10, x10, x0
    ldp x11, x12, [sp, #24]
.Lmfb3:
    cbz x12, .Lmfb4
    ldrb w13, [x11], #1
    strb w13, [x10], #1
    sub x12, x12, #1
    b .Lmfb3
.Lmfb4:
    ldr x9, [sp, #16]
    sub x0, x10, x9
    ldp x29, x30, [sp], #64
    ret

// ---------- az_input_len ----------
// az_input_len(x0=valptr) -> x0 = ".length" of value or -1
// str -> codepoints, arr -> count, hostref -> cb kind7, else -1
    .globl _az_input_len
    AZ_HIDDEN _az_input_len
_az_input_len:
    stp x29, x30, [sp, #-16]!
    mov x29, sp
    ldrb w9, [x0]
    cmp w9, #4
    b.eq .Lil_str
    cmp w9, #7
    b.eq .Lil_arr
    cmp w9, #8
    b.eq .Lil_host
    mov x0, #-1
    b .Lil_out
.Lil_str:
    ldr x1, [x0, #1]
    add x0, x0, #9
    bl _az_utf16_units
    b .Lil_out
.Lil_arr:
    ldr x0, [x0, #1]
    b .Lil_out
.Lil_host:
    ldr x1, [x0, #1]         // hostidx
    ldr x9, [x24, #24]       // cb_host
    mov x0, #7               // kind7: .length
    mov x2, #0
    mov x3, #0
    blr x9
.Lil_out:
    ldp x29, x30, [sp], #16
    ret
