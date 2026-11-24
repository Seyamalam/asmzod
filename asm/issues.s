#include "port.h"
// issues.s — path stack + issue emission into err arena
//
// err buffer header:
//   +0    u64 issue_count (committed issues)
//   +8    u64 path_depth
//   +16   u64 open-issue field-count patch ptr
//   +24   u64 open-issue start ptr (rollback on overflow)
//   +32   path stack: 128 entries x 24B {u64 kind(0=key,1=idx), u64 a, u64 b}
//   +3104 issue blobs
//
// issue blob = tagged OBJECT value: {code, path, message, ...extras}
    .text
    .p2align 2

// ---------- path stack ----------
// az_path_push_key(x0=keyptr, x1=keylen)
    .globl _az_path_push_key
    AZ_HIDDEN _az_path_push_key
_az_path_push_key:
    ldr x9, [x22, #8]
    cmp x9, #128
    b.hs .Lpk_done
    mov x10, #24
    mul x10, x9, x10
    add x10, x10, #32
    add x10, x22, x10
    str xzr, [x10]          // kind=key
    stp x0, x1, [x10, #8]
    add x9, x9, #1
    str x9, [x22, #8]
.Lpk_done:
    ret

// az_path_push_idx(x0=idx)
    .globl _az_path_push_idx
    AZ_HIDDEN _az_path_push_idx
_az_path_push_idx:
    ldr x9, [x22, #8]
    cmp x9, #128
    b.hs .Lpi_done
    mov x10, #24
    mul x10, x9, x10
    add x10, x10, #32
    add x10, x22, x10
    mov x11, #1
    str x11, [x10]          // kind=idx
    str x0, [x10, #8]
    add x9, x9, #1
    str x9, [x22, #8]
.Lpi_done:
    ret

    .globl _az_path_pop
    AZ_HIDDEN _az_path_pop
_az_path_pop:
    ldr x9, [x22, #8]
    cbz x9, .Lpp_done
    sub x9, x9, #1
    str x9, [x22, #8]
.Lpp_done:
    ret

// ---------- low-level err writers ----------
// _ew(x0=ptr, x1=len): append bytes at x21 -> x0=0 or -4 ENOSPC
    .globl _az_ew
    AZ_HIDDEN _az_ew
_az_ew:
    add x9, x21, x1
    cmp x9, x23
    b.hi .Lew_oom
    mov x10, x21
    mov x21, x9
    mov x11, x1
    cbz x11, .Lew_ok
    cmp x11, #16
    b.lo .Lew_tail
.Lew16:
    ldp x12, x13, [x0], #16
    stp x12, x13, [x10], #16
    sub x11, x11, #16
    cmp x11, #16
    b.hs .Lew16
.Lew_tail:
    cbz x11, .Lew_ok
.Lew1:
    ldrb w12, [x0], #1
    strb w12, [x10], #1
    subs x11, x11, #1
    b.ne .Lew1
.Lew_ok:
    mov x0, #0
    ret
.Lew_oom:
    mov x0, #-4
    ret

// _ew1(w0=byte)
    .globl _az_ew1
    AZ_HIDDEN _az_ew1
_az_ew1:
    cmp x21, x23
    b.hs .Lew1_oom
    strb w0, [x21], #1
    mov x0, #0
    ret
.Lew1_oom:
    mov x0, #-4
    ret

// _ew8(x0=u64)
    .globl _az_ew8
    AZ_HIDDEN _az_ew8
_az_ew8:
    add x9, x21, #8
    cmp x9, x23
    b.hi .Lew8_oom
    str x0, [x21], #8
    mov x0, #0
    ret
.Lew8_oom:
    mov x0, #-4
    ret

// ---------- issue fields ----------
// each f_* appends "u64 klen + key + tagged value" and bumps open-issue count

// az_issue_f_str(x0=kptr,x1=klen, x2=vptr,x3=vlen) -> x0 0/-4
    .globl _az_issue_f_str
    AZ_HIDDEN _az_issue_f_str
_az_issue_f_str:
    stp x29, x30, [sp, #-64]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    stp x2, x3, [sp, #32]
    // bump field count
    ldr x9, [x22, #16]
    ldr x10, [x9]
    add x10, x10, #1
    str x10, [x9]
    // u64 klen
    mov x0, x1
    bl _az_ew8
    cbnz x0, .Lfs_fail
    ldp x0, x1, [sp, #16]
    bl _az_ew
    cbnz x0, .Lfs_fail
    mov w0, #4                 // STRING tag
    bl _az_ew1
    cbnz x0, .Lfs_fail
    ldr x0, [sp, #40]          // vlen
    bl _az_ew8
    cbnz x0, .Lfs_fail
    ldp x0, x1, [sp, #32]
    bl _az_ew
    cbnz x0, .Lfs_fail
    mov x0, #0
.Lfs_fail:
    ldp x29, x30, [sp], #64
    ret

// az_issue_f_f64(x0=kptr,x1=klen, d0=val) -> 0/-4
    .globl _az_issue_f_f64
    AZ_HIDDEN _az_issue_f_f64
_az_issue_f_f64:
    stp x29, x30, [sp, #-48]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    str d0, [sp, #32]
    ldr x9, [x22, #16]
    ldr x10, [x9]
    add x10, x10, #1
    str x10, [x9]
    mov x0, x1
    bl _az_ew8
    cbnz x0, .Lff_fail
    ldp x0, x1, [sp, #16]
    bl _az_ew
    cbnz x0, .Lff_fail
    mov w0, #3
    bl _az_ew1
    cbnz x0, .Lff_fail
    ldr x0, [sp, #32]
    bl _az_ew8
    cbnz x0, .Lff_fail
    mov x0, #0
.Lff_fail:
    ldp x29, x30, [sp], #48
    ret

// az_issue_f_bool(x0=kptr,x1=klen, w2=val)
    .globl _az_issue_f_bool
    AZ_HIDDEN _az_issue_f_bool
_az_issue_f_bool:
    stp x29, x30, [sp, #-48]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    str w2, [sp, #32]
    ldr x9, [x22, #16]
    ldr x10, [x9]
    add x10, x10, #1
    str x10, [x9]
    mov x0, x1
    bl _az_ew8
    cbnz x0, .Lfb_fail
    ldp x0, x1, [sp, #16]
    bl _az_ew
    cbnz x0, .Lfb_fail
    mov w0, #2
    bl _az_ew1
    cbnz x0, .Lfb_fail
    ldr w0, [sp, #32]
    bl _az_ew1
    cbnz x0, .Lfb_fail
    mov x0, #0
.Lfb_fail:
    ldp x29, x30, [sp], #48
    ret

// az_issue_f_rawval(x0=kptr,x1=klen, x2=vptr,x3=vlen): value bytes already tagged
    .globl _az_issue_f_rawval
    AZ_HIDDEN _az_issue_f_rawval
_az_issue_f_rawval:
    stp x29, x30, [sp, #-48]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    stp x2, x3, [sp, #32]
    ldr x9, [x22, #16]
    ldr x10, [x9]
    add x10, x10, #1
    str x10, [x9]
    mov x0, x1
    bl _az_ew8
    cbnz x0, .Lfrv_fail
    ldp x0, x1, [sp, #16]
    bl _az_ew
    cbnz x0, .Lfrv_fail
    ldp x0, x1, [sp, #32]
    bl _az_ew
    cbnz x0, .Lfrv_fail
    mov x0, #0
.Lfrv_fail:
    ldp x29, x30, [sp], #48
    ret

// az_issue_f_strarr(x0=kptr,x1=klen, x2=pairptr,x3=count)
// pairptr -> array of {u64 ptr, u64 len}
    .globl _az_issue_f_strarr
    AZ_HIDDEN _az_issue_f_strarr
_az_issue_f_strarr:
    stp x29, x30, [sp, #-80]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    stp x2, x3, [sp, #32]
    str x27, [sp, #48]
    str x28, [sp, #64]
    ldr x9, [x22, #16]
    ldr x10, [x9]
    add x10, x10, #1
    str x10, [x9]
    mov x0, x1
    bl _az_ew8
    cbnz x0, .Lfsa_fail
    ldp x0, x1, [sp, #16]
    bl _az_ew
    cbnz x0, .Lfsa_fail
    mov w0, #7                  // ARRAY tag
    bl _az_ew1
    cbnz x0, .Lfsa_fail
    ldr x0, [sp, #32 + 8]       // count
    bl _az_ew8
    cbnz x0, .Lfsa_fail
    ldr x27, [sp, #32]          // pairptr
    ldr x28, [sp, #40]          // count
.Lfsa_loop:
    cbz x28, .Lfsa_done
    mov w0, #4
    bl _az_ew1
    cbnz x0, .Lfsa_fail
    ldr x0, [x27, #8]           // len
    bl _az_ew8
    cbnz x0, .Lfsa_fail
    ldp x0, x1, [x27]
    bl _az_ew
    cbnz x0, .Lfsa_fail
    add x27, x27, #16
    sub x28, x28, #1
    b .Lfsa_loop
.Lfsa_done:
    mov x0, #0
.Lfsa_fail:
    ldr x27, [sp, #48]
    ldr x28, [sp, #64]
    ldp x29, x30, [sp], #80
    ret

// ---------- issue begin/commit ----------


// _az_msgcat(x0=dst, x1=src, x2=n) -> x0 = dst+n
    .globl _az_msgcat
    AZ_HIDDEN _az_msgcat
_az_msgcat:
    stp x30, xzr, [sp, #-16]!
    add x9, x0, x2
    str x9, [sp, #8]
    bl _az_memcpy
    ldr x0, [sp, #8]
    ldp x30, xzr, [sp], #16
    ret

// az_issue_begin(x0=code_idx, x1=msgptr, x2=msglen) -> x0 0/-4
// writes {tag obj, cnt=0 patch, code, path, message}; count starts at 3
    .globl _az_issue_begin
    AZ_HIDDEN _az_issue_begin
_az_issue_begin:
    stp x29, x30, [sp, #-96]!
    mov x29, sp
    // pending-msg cell: fail paths whose issue helpers take no msg arg
    // stash the check's custom message here; consumed (and cleared) on read
    AZ_ADR x9, _az_pending_msg
    ldp x10, x11, [x9]
    stp xzr, xzr, [x9]
    cbnz x2, .Lib_havemsg        // explicit msg (len>0) wins
    mov x1, x10
    mov x2, x11
    cbnz x2, .Lib_havemsg        // pending msg (len>0)
    // msg-stack top: when the top entry's recorded path depth equals the
    // current depth, this issue was raised by the wrapped node itself
    AZ_ADR x9, _az_msgstack
    ldr x13, [x9]
    cbz x13, .Lib_havemsg
    sub x13, x13, #1
    lsl x14, x13, #1
    add x14, x14, x13
    lsl x14, x14, #3            // slot = 24B
    add x15, x9, #8
    add x15, x15, x14
    ldr x16, [x22, #8]          // path depth
    ldr x17, [x15]
    cmp x16, x17
    b.ne .Lib_havemsg
    ldp x1, x2, [x15, #8]
.Lib_havemsg:
    stp x0, x1, [sp, #16]      // code, msgptr
    str x2, [sp, #32]          // msglen
    str x27, [sp, #48]
    str x28, [sp, #64]
    mov x27, x0                // code idx
    // reserve check: need >= msglen + 2048 slack
    add x9, x21, x2
    add x9, x9, #4096
    cmp x9, x23
    b.hi .Lib_oom
    str x21, [x22, #24]        // open-issue start
    mov w0, #6
    bl _az_ew1                 // OBJECT tag
    cbnz x0, .Lib_fail
    mov x0, #0
    bl _az_ew8                 // field count placeholder
    cbnz x0, .Lib_fail
    sub x9, x21, #8
    str x9, [x22, #16]         // patch ptr
    // field "code"
    AZ_ADR x0, .Lk_code
    mov x1, #4
    // value = code name from table (stride 32)
    AZ_ADR x2, _az_code_table
    lsl x10, x27, #5
    add x14, x2, x10
    ldp x2, x3, [x14]
    bl _az_issue_f_str
    cbnz x0, .Lib_fail
    // field "path" -> ARRAY
    ldr x9, [x22, #16]
    ldr x10, [x9]
    add x10, x10, #1
    str x10, [x9]
    mov x0, #4
    bl _az_ew8                  // klen
    cbnz x0, .Lib_fail
    AZ_ADR x0, .Lk_path
    mov x1, #4
    bl _az_ew
    cbnz x0, .Lib_fail
    mov w0, #7
    bl _az_ew1                  // ARRAY tag
    cbnz x0, .Lib_fail
    ldr x0, [x22, #8]           // depth
    bl _az_ew8
    cbnz x0, .Lib_fail
    ldr x27, [x22, #8]          // remaining = depth
    mov x28, #0                 // i
.Lib_pathloop:
    cbz x27, .Lib_pathdone
    mov x10, #24
    mul x10, x28, x10
    add x10, x10, #32
    add x10, x22, x10           // entry
    ldr x9, [x10]
    cbnz x9, .Lib_pathidx
    // key -> STRING
    mov w0, #4
    bl _az_ew1
    cbnz x0, .Lib_fail
    ldr x0, [x10, #16]          // keylen
    bl _az_ew8
    cbnz x0, .Lib_fail
    ldp x0, x1, [x10, #8]
    bl _az_ew
    cbnz x0, .Lib_fail
    b .Lib_pathnext
.Lib_pathidx:
    mov w0, #3                  // F64 tag
    bl _az_ew1
    cbnz x0, .Lib_fail
    ldr x0, [x10, #8]
    ucvtf d0, x0
    fmov x0, d0
    bl _az_ew8
    cbnz x0, .Lib_fail
.Lib_pathnext:
    add x28, x28, #1
    sub x27, x27, #1
    b .Lib_pathloop
.Lib_pathdone:
    // field "message" — emitted only for custom messages (msglen>0);
    // the TS layer supplies zod-style defaults when absent
    ldr x2, [sp, #32]           // msglen
    cbz x2, .Lib_done
    ldr x1, [sp, #16 + 8]       // msgptr
    mov x3, x2
    mov x2, x1
    AZ_ADR x0, .Lk_message
    mov x1, #7
    bl _az_issue_f_str
    cbnz x0, .Lib_fail
.Lib_done:
    mov x0, #0
    b .Lib_out
.Lib_oom:
.Lib_fail:
    mov x0, #-4
.Lib_out:
    ldr x27, [sp, #48]
    ldr x28, [sp, #64]
    ldp x29, x30, [sp], #96
    ret

// az_issue_commit: ++issue_count
    .globl _az_issue_commit
    AZ_HIDDEN _az_issue_commit
_az_issue_commit:
    ldr x9, [x22]
    add x9, x9, #1
    str x9, [x22]
    ret

// az_issue_rollback_open: restore x21 to open-issue start (uncommitted bytes)
    .globl _az_issue_rollback_open
    AZ_HIDDEN _az_issue_rollback_open
_az_issue_rollback_open:
    ldr x9, [x22, #24]
    cbz x9, .Lro_done
    mov x21, x9
.Lro_done:
    ret

// ---------- az_issue_type: invalid_type helper ----------
// (x0=exp_ptr, x1=exp_len, x2=got_tag, x3=val_ptr) -> x0 0/-4
// emits code=invalid_type, msg "Expected X, received Y" (or "Required"),
// fields expected/received
    .globl _az_issue_type
    AZ_HIDDEN _az_issue_type
_az_issue_type:
    stp x29, x30, [sp, #-128]!
    mov x29, sp
    stp x0, x1, [sp, #16]       // exp ptr/len
    stp x2, x3, [sp, #32]       // tag, valptr
    // resolve received-name ptr/len -> [sp,#48/#56]
    cmp x2, #3
    b.ne .Lit_notf64
    // NaN check: tag f64 + val NaN => "nan"
    ldr d0, [x3, #1]
    fcmp d0, d0
    b.vc .Lit_f64fin
    AZ_ADR x9, .Ln_nan
    str x9, [sp, #48]
    mov x10, #3
    str x10, [sp, #56]
    b .Lit_gotname
.Lit_f64fin:
    // +-Infinity => "Infinity"/"-Infinity"
    fabs d1, d0
    mov x9, #0x7FF0000000000000
    fmov d2, x9
    fcmp d1, d2
    b.ne .Lit_notf64
    fcmp d0, #0.0
    AZ_ADR x9, .Ln_inf
    mov x10, #8
    b.mi .Lit_infneg
    b .Lit_infstore
.Lit_infneg:
    AZ_ADR x9, .Ln_ninf
    mov x10, #9
.Lit_infstore:
    stp x9, x10, [sp, #48]
    b .Lit_gotname
.Lit_notf64:
    cmp x2, #8
    b.ne .Lit_named
    // HOSTREF -> ask JS for type name index (cb_host kind 6: a=hostref idx)
    ldr x9, [x24, #24]          // cb_host = table[3]
    mov x0, #6
    ldr x1, [x3, #1]            // hostref idx
    mov x2, #0
    mov x3, #0
    blr x9
    // idx 5 = other object -> zod uses constructor.name; fetch it (cb kind 8)
    cmp x0, #5
    b.ne .Lit_tabname
    ldr x9, [x24, #24]
    mov x0, #8
    ldr x10, [sp, #40]          // valptr (x3 clobbered by blr)
    ldr x1, [x10, #1]           // hostref idx
    sub x2, x23, #256           // scratch name buffer at err-arena tail
    mov x3, #255
    blr x9
    // x0 = name len written at x23-256 (0 -> fall back to "object")
    cbz x0, .Lit_tabname5
    sub x9, x23, #256
    stp x9, x0, [sp, #48]
    b .Lit_gotname
.Lit_tabname5:
    mov x0, #5
.Lit_tabname:
    // x0 = host type idx into host_names table
    AZ_ADR x9, _az_hosttype_table
    mov x10, #16
    mul x10, x0, x10
    add x13, x9, x10
    ldp x11, x12, [x13]
    stp x11, x12, [sp, #48]
    b .Lit_gotname
.Lit_named:
    AZ_ADR x9, _az_tagname_table
    mov x10, #16
    mul x10, x2, x10
    add x13, x9, x10
    ldp x11, x12, [x13]
    stp x11, x12, [sp, #48]
.Lit_gotname:
    // build zod default "Invalid input: expected X, received Y" in
    // _az_msgbuf -> _az_default_msg (lowest-priority msg slot in begin)
    ldp x10, x11, [sp, #16]     // exp
    cmp x11, #3
    b.ne .Lit_e_ok
    ldrb w12, [x10]
    cmp w12, #'n'
    b.ne .Lit_e_ok
    ldrb w12, [x10, #1]
    cmp w12, #'a'
    b.ne .Lit_e_ok
    ldrb w12, [x10, #2]
    cmp w12, #'n'
    b.ne .Lit_e_ok
    AZ_ADR x10, .Lhv_nan
    mov x11, #3
.Lit_e_ok:
    stp x10, x11, [sp, #72]
    ldp x10, x11, [sp, #48]     // recv
    cmp x11, #12
    b.ne .Lit_r_ok
    mov x0, x10
    AZ_ADR x1, .Lh7
    mov x2, #12
    bl _az_memeq
    cbz w0, .Lit_r_ok
    AZ_ADR x10, .Lhv_dname
    mov x11, #4
    stp x10, x11, [sp, #88]
    b .Lit_r_done
.Lit_r_ok:
    ldp x10, x11, [sp, #48]
    stp x10, x11, [sp, #88]
.Lit_r_done:
    AZ_ADR x13, _az_msgbuf
    str x13, [sp, #104]         // cursor
    ldr x0, [sp, #104]
    AZ_ADR x1, .Lm_invexp
    mov x2, #24
    bl _az_msgcat
    str x0, [sp, #104]
    ldr x0, [sp, #104]
    ldp x1, x2, [sp, #72]
    bl _az_msgcat
    str x0, [sp, #104]
    ldr x0, [sp, #104]
    AZ_ADR x1, .Lm_rcv
    mov x2, #11
    bl _az_msgcat
    str x0, [sp, #104]
    ldr x0, [sp, #104]
    ldp x1, x2, [sp, #88]
    bl _az_msgcat
    AZ_ADR x9, _az_msgbuf
    sub x10, x0, x9
    AZ_ADR x11, _az_default_msg
    stp x9, x10, [x11]
    mov x1, #0
    mov x2, #0
    mov x0, #0                  // code = invalid_type
    bl _az_issue_begin
    cbnz x0, .Lit_out
.Lit_fields:
    // expected
    AZ_ADR x0, .Lk_expected
    mov x1, #8
    ldp x2, x3, [sp, #16]
    bl _az_issue_f_str
    cbnz x0, .Lit_out
    // received
    AZ_ADR x0, .Lk_received
    mov x1, #8
    ldp x2, x3, [sp, #48]
    bl _az_issue_f_str
    cbnz x0, .Lit_out
    bl _az_issue_commit
    mov x0, #0
.Lit_out:
    ldp x29, x30, [sp], #128
    ret

// ---------- az_issue_invalid_date: invalid_type for NaN-time Dates ----------
// zod exposes received:"Invalid Date" while the message shows "Date"
    .globl _az_issue_invalid_date
    AZ_HIDDEN _az_issue_invalid_date
_az_issue_invalid_date:
    stp x29, x30, [sp, #-64]!
    mov x29, sp
    mov x1, #0
    mov x2, #0
    mov x0, #0                  // code = invalid_type
    bl _az_issue_begin
    cbnz x0, .Lid_out
    AZ_ADR x0, .Lk_expected
    mov x1, #8
    AZ_ADR x2, .Lhv_date
    mov x3, #4
    bl _az_issue_f_str
    cbnz x0, .Lid_out
    AZ_ADR x0, .Lk_received
    mov x1, #8
    AZ_ADR x2, .Lh7
    mov x3, #12
    bl _az_issue_f_str
    cbnz x0, .Lid_out
    bl _az_issue_commit
    mov x0, #0
.Lid_out:
    ldp x29, x30, [sp], #64
    ret

// ---------- tables ----------
    AZ_DATA
    .p2align 3

// code table: {name ptr, name len, default msg ptr, default msg len} x14
// stride 32
    .globl _az_code_table
    AZ_HIDDEN _az_code_table
_az_code_table:
    .quad .Lc0, 12, .Ld0, 8     // invalid_type / "Required"
    .quad .Lc1, 15, .Ld1, 21
    .quad .Lc2, 6,  .Ld2, 13
    .quad .Lc3, 13, .Ld3, 13
    .quad .Lc4, 18, .Ld4, 18
    .quad .Lc5, 17, .Ld5, 26
    .quad .Lc6, 12, .Ld6, 12
    .quad .Lc7, 14, .Ld7, 7
    .quad .Lc8, 9,  .Ld8, 9
    .quad .Lc9, 7,  .Ld9, 7
    .quad .Lc10, 28, .Ld10, 28
    .quad .Lc11, 15, .Ld11, 15
    .quad .Lc12, 10, .Ld12, 18
    .quad .Lc13, 11, .Ld13, 15

// tag names
    .globl _az_tagname_table
    AZ_HIDDEN _az_tagname_table
_az_tagname_table:
    .quad .Lt0, 9               // undefined
    .quad .Lt1, 4               // null
    .quad .Lt2, 7               // boolean
    .quad .Lt3, 6               // number
    .quad .Lt4, 6               // string
    .quad .Lt5, 6               // bigint
    .quad .Lt6, 6               // object
    .quad .Lt7, 5               // array
    .quad .Lt8, 7               // hostref -> "unknown" (overridden via cb)
    .quad .Lt9, 3               // map
    .quad .Lt10, 3              // set

// host type names (cb kind 6 returns idx)
    .globl _az_hosttype_table
    AZ_HIDDEN _az_hosttype_table
_az_hosttype_table:
    .quad .Lh0, 6               // symbol
    .quad .Lh1, 4               // date
    .quad .Lh2, 3               // map
    .quad .Lh3, 3               // set
    .quad .Lh4, 8               // function
    .quad .Lh5, 5               // class / object
    .quad .Lh6, 7               // unknown
    .quad .Lh7, 12              // Invalid Date
    .quad .Lh8, 6               // bigint

    AZ_RODATA
.Lc0:  .ascii "invalid_type"
.Lc1:  .ascii "invalid_literal"
.Lc2:  .ascii "custom"
.Lc3:  .ascii "invalid_union"
.Lc4:  .ascii "invalid_enum_value"
.Lc5:  .ascii "unrecognized_keys"
.Lc6:  .ascii "invalid_date"
.Lc7:  .ascii "invalid_string"
.Lc8:  .ascii "too_small"
.Lc9:  .ascii "too_big"
.Lc10: .ascii "invalid_intersection_results"
.Lc11: .ascii "not_multiple_of"
.Lc12: .ascii "not_finite"
.Lc13: .ascii "invalid_key"
.Ld0:  .ascii "Required"
.Ld1:  .ascii "Invalid literal value"
.Ld2:  .ascii "Invalid input"
.Ld3:  .ascii "Invalid input"
.Ld4:  .ascii "Invalid enum value"
.Ld5:  .ascii "Unrecognized key(s) in object"
.Ld6:  .ascii "Invalid date"
.Ld7:  .ascii "Invalid"
.Ld8:  .ascii "Too small"
.Ld9:  .ascii "Too big"
.Ld10: .ascii "Invalid intersection results"
.Ld11: .ascii "Not a multiple"
.Ld12: .ascii "Number must be finite"
.Ld13: .ascii "Invalid key ..."
.Lt0:  .ascii "undefined"
.Lt1:  .ascii "null"
.Lt2:  .ascii "boolean"
.Lt3:  .ascii "number"
.Lt4:  .ascii "string"
.Lt5:  .ascii "bigint"
.Lt6:  .ascii "object"
.Lt7:  .ascii "array"
.Lt8:  .ascii "unknown"
.Lt9:  .ascii "Map"
.Lt10: .ascii "Set"
.Lh0:  .ascii "symbol"
.Lh1:  .ascii "Date"
.Lh2:  .ascii "Map"
.Lh3:  .ascii "Set"
.Lh4:  .ascii "function"
.Lh5:  .ascii "object"
.Lh6:  .ascii "unknown"
.Lh7:  .ascii "Invalid Date"
.Lh8:  .ascii "bigint"
.Lhv_date: .ascii "date"
.Lk_code:     .ascii "code"
.Lk_path:     .ascii "path"
.Lk_message:  .ascii "message"
.Lk_expected: .ascii "expected"
.Lk_received: .ascii "received"
.Lm_invexp: .ascii "Invalid input: expected "
.Lm_rcv:    .ascii ", received "
.Lhv_nan:   .ascii "NaN"
.Lhv_dname: .ascii "Date"
.Lm_expected: .ascii "Expected "
.Lm_received: .ascii ", received "
.Lm_required: .ascii "Required"
.Ln_nan:      .ascii "NaN"
.Ln_inf:      .ascii "Infinity"
.Ln_ninf:     .ascii "-Infinity"

    .text
    .p2align 2
// az_issue_f_i64(x0=kptr,x1=klen,x2=val) — writes field with BIGINT tagged value
    .globl _az_issue_f_i64
    AZ_HIDDEN _az_issue_f_i64
_az_issue_f_i64:
    stp x29, x30, [sp, #-48]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    str x2, [sp, #32]
    ldr x9, [x22, #16]
    ldr x10, [x9]
    add x10, x10, #1
    str x10, [x9]
    mov x0, x1
    bl _az_ew8
    cbnz x0, .Lfi_fail
    ldp x0, x1, [sp, #16]
    bl _az_ew
    cbnz x0, .Lfi_fail
    mov w0, #5
    bl _az_ew1
    cbnz x0, .Lfi_fail
    ldr x0, [sp, #32]
    bl _az_ew8
    cbnz x0, .Lfi_fail
    mov x0, #0
.Lfi_fail:
    ldp x29, x30, [sp], #48
    ret

// az_issue_f_strseq(x0=kptr,x1=klen,x2=seqptr,x3=count)
// seq = [u64 len + bytes]*count — for enum "options"
    .globl _az_issue_f_strseq
    AZ_HIDDEN _az_issue_f_strseq
_az_issue_f_strseq:
    stp x29, x30, [sp, #-80]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    stp x2, x3, [sp, #32]
    str x27, [sp, #48]
    str x28, [sp, #64]
    ldr x9, [x22, #16]
    ldr x10, [x9]
    add x10, x10, #1
    str x10, [x9]
    mov x0, x1
    bl _az_ew8
    cbnz x0, .Lfsq_fail
    ldp x0, x1, [sp, #16]
    bl _az_ew
    cbnz x0, .Lfsq_fail
    mov w0, #7
    bl _az_ew1
    cbnz x0, .Lfsq_fail
    ldr x0, [sp, #40]          // count
    bl _az_ew8
    cbnz x0, .Lfsq_fail
    ldr x27, [sp, #32]         // seqptr
    ldr x28, [sp, #40]         // count
.Lfsq_loop:
    cbz x28, .Lfsq_done
    mov w0, #4
    bl _az_ew1
    cbnz x0, .Lfsq_fail
    ldr x9, [x27]              // len
    mov x0, x9
    bl _az_ew8
    cbnz x0, .Lfsq_fail
    add x0, x27, #8
    ldr x1, [x27]
    bl _az_ew
    cbnz x0, .Lfsq_fail
    ldr x9, [x27]
    add x27, x27, x9
    add x27, x27, #8
    sub x28, x28, #1
    b .Lfsq_loop
.Lfsq_done:
    mov x0, #0
.Lfsq_fail:
    ldr x27, [sp, #48]
    ldr x28, [sp, #64]
    ldp x29, x30, [sp], #80
    ret

    .text
    .p2align 2
// az_issue_f_strarr2(x0=kptr,x1=klen,x2=base,x3=stride(i64),x4=count)
// strided (ptr,len) pairs -> ARRAY of STRINGs
    .globl _az_issue_f_strarr2
    AZ_HIDDEN _az_issue_f_strarr2
_az_issue_f_strarr2:
    stp x29, x30, [sp, #-80]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    stp x2, x3, [sp, #32]
    str x4, [sp, #48]
    str x27, [sp, #56]
    ldr x9, [x22, #16]
    ldr x10, [x9]
    add x10, x10, #1
    str x10, [x9]
    mov x0, x1
    bl _az_ew8
    cbnz x0, .Lfs2_fail
    ldp x0, x1, [sp, #16]
    bl _az_ew
    cbnz x0, .Lfs2_fail
    mov w0, #7
    bl _az_ew1
    cbnz x0, .Lfs2_fail
    ldr x0, [sp, #48]
    bl _az_ew8
    cbnz x0, .Lfs2_fail
    ldr x27, [sp, #48]         // count
    ldr x14, [sp, #32]         // base
    ldr x15, [sp, #40]         // stride
.Lfs2_loop:
    cbz x27, .Lfs2_done
    mov w0, #4
    bl _az_ew1
    cbnz x0, .Lfs2_fail
    ldr x0, [x14, #8]          // len
    bl _az_ew8
    cbnz x0, .Lfs2_fail
    ldp x0, x1, [x14]
    bl _az_ew
    cbnz x0, .Lfs2_fail
    add x14, x14, x15
    sub x27, x27, #1
    b .Lfs2_loop
.Lfs2_done:
    mov x0, #0
.Lfs2_fail:
    ldr x27, [sp, #56]
    ldp x29, x30, [sp], #80
    ret

// ---------- pending check-message cell ----------
    .data
    .p2align 3
    .globl _az_pending_msg
    AZ_HIDDEN _az_pending_msg
_az_pending_msg:      .quad 0
_az_pending_msglen:   .quad 0
    .globl _az_default_msg
    AZ_HIDDEN _az_default_msg
_az_default_msg:      .quad 0, 0
    .bss
    .p2align 3
    .globl _az_msgbuf
    AZ_HIDDEN _az_msgbuf
_az_msgbuf:           .space 512

// scoped schema-message stack: [count][slots x64 {depth,msgptr,msglen}]
    .p2align 3
    .globl _az_msgstack
    AZ_HIDDEN _az_msgstack
_az_msgstack:         .quad 0
                      .zero 64*24
