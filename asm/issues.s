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

// az_issue_begin(x0=code_idx, x1=msgptr, x2=msglen) -> x0 0/-4
// writes {tag obj, cnt=0 patch, code, path, message}; count starts at 3
    .globl _az_issue_begin
_az_issue_begin:
    stp x29, x30, [sp, #-96]!
    mov x29, sp
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
    adrp x0, .Lk_code@PAGE
    add x0, x0, .Lk_code@PAGEOFF
    mov x1, #4
    // value = code name from table (stride 32)
    adrp x2, _az_code_table@PAGE
    add x2, x2, _az_code_table@PAGEOFF
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
    adrp x0, .Lk_path@PAGE
    add x0, x0, .Lk_path@PAGEOFF
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
    // field "message"
    ldr x1, [sp, #16 + 8]       // msgptr
    ldr x2, [sp, #32]           // msglen
    cbnz x2, .Lib_havemsg
    // default message from table: stride 32, msg pair at +16
    ldr x27, [sp, #16]          // code idx (x27 was reused as loop counter)
    adrp x9, _az_code_table@PAGE
    add x9, x9, _az_code_table@PAGEOFF
    lsl x10, x27, #5
    add x9, x9, x10
    ldp x1, x2, [x9, #16]
.Lib_havemsg:
    mov x3, x2
    mov x2, x1
    adrp x0, .Lk_message@PAGE
    add x0, x0, .Lk_message@PAGEOFF
    mov x1, #7
    bl _az_issue_f_str
    cbnz x0, .Lib_fail
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
_az_issue_commit:
    ldr x9, [x22]
    add x9, x9, #1
    str x9, [x22]
    ret

// az_issue_rollback_open: restore x21 to open-issue start (uncommitted bytes)
    .globl _az_issue_rollback_open
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
    b.vc .Lit_notf64
    adrp x9, .Ln_nan@PAGE
    add x9, x9, .Ln_nan@PAGEOFF
    str x9, [sp, #48]
    mov x10, #3
    str x10, [sp, #56]
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
    // x0 = host type idx into host_names table
    adrp x9, _az_hosttype_table@PAGE
    add x9, x9, _az_hosttype_table@PAGEOFF
    mov x10, #16
    mul x10, x0, x10
    add x13, x9, x10
    ldp x11, x12, [x13]
    stp x11, x12, [sp, #48]
    b .Lit_gotname
.Lit_named:
    adrp x9, _az_tagname_table@PAGE
    add x9, x9, _az_tagname_table@PAGEOFF
    mov x10, #16
    mul x10, x2, x10
    add x13, x9, x10
    ldp x11, x12, [x13]
    stp x11, x12, [sp, #48]
.Lit_gotname:
    // build message into stack buf at sp+64 (cap 240)
    ldr x9, [sp, #32]           // tag
    cbnz x9, .Lit_buildmsg
    // tag==0 (undefined) -> "Required"
    adrp x1, .Lm_required@PAGE
    add x1, x1, .Lm_required@PAGEOFF
    mov x2, #8
    mov x0, #0                  // code = invalid_type
    bl _az_issue_begin
    cbnz x0, .Lit_out
    b .Lit_fields
.Lit_buildmsg:
    add x10, sp, #64
    // "Expected " (9)
    adrp x11, .Lm_expected@PAGE
    add x11, x11, .Lm_expected@PAGEOFF
    mov x12, #9
.Lit_c1:
    ldrb w13, [x11], #1
    strb w13, [x10], #1
    subs x12, x12, #1
    b.ne .Lit_c1
    // exp
    ldp x11, x12, [sp, #16]
.Lit_c2:
    cbz x12, .Lit_c2d
    ldrb w13, [x11], #1
    strb w13, [x10], #1
    sub x12, x12, #1
    b .Lit_c2
.Lit_c2d:
    // ", received " (11)
    adrp x11, .Lm_received@PAGE
    add x11, x11, .Lm_received@PAGEOFF
    mov x12, #11
.Lit_c3:
    ldrb w13, [x11], #1
    strb w13, [x10], #1
    subs x12, x12, #1
    b.ne .Lit_c3
    // name
    ldp x11, x12, [sp, #48]
.Lit_c4:
    cbz x12, .Lit_c4d
    ldrb w13, [x11], #1
    strb w13, [x10], #1
    sub x12, x12, #1
    b .Lit_c4
.Lit_c4d:
    add x0, sp, #64
    sub x1, x10, x0             // msglen... wait x0 must be ptr: set regs
    mov x2, x1
    mov x1, x0                  // x1=msgptr (sp+64)
    mov x0, #0                  // code=invalid_type
    bl _az_issue_begin
    cbnz x0, .Lit_out
.Lit_fields:
    // expected
    adrp x0, .Lk_expected@PAGE
    add x0, x0, .Lk_expected@PAGEOFF
    mov x1, #8
    ldp x2, x3, [sp, #16]
    bl _az_issue_f_str
    cbnz x0, .Lit_out
    // received
    adrp x0, .Lk_received@PAGE
    add x0, x0, .Lk_received@PAGEOFF
    mov x1, #8
    ldp x2, x3, [sp, #48]
    bl _az_issue_f_str
    cbnz x0, .Lit_out
    bl _az_issue_commit
    mov x0, #0
.Lit_out:
    ldp x29, x30, [sp], #128
    ret

// ---------- tables ----------
    .section __DATA,__const
    .p2align 3

// code table: {name ptr, name len, default msg ptr, default msg len} x14
// stride 32
    .globl _az_code_table
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

// tag names
    .globl _az_tagname_table
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

// host type names (cb kind 6 returns idx)
    .globl _az_hosttype_table
_az_hosttype_table:
    .quad .Lh0, 6               // symbol
    .quad .Lh1, 4               // date
    .quad .Lh2, 3               // map
    .quad .Lh3, 3               // set
    .quad .Lh4, 8               // function
    .quad .Lh5, 5               // class / object
    .quad .Lh6, 7               // unknown

    .section __TEXT,__const
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
.Lt0:  .ascii "undefined"
.Lt1:  .ascii "null"
.Lt2:  .ascii "boolean"
.Lt3:  .ascii "number"
.Lt4:  .ascii "string"
.Lt5:  .ascii "bigint"
.Lt6:  .ascii "object"
.Lt7:  .ascii "array"
.Lt8:  .ascii "unknown"
.Lh0:  .ascii "symbol"
.Lh1:  .ascii "date"
.Lh2:  .ascii "map"
.Lh3:  .ascii "set"
.Lh4:  .ascii "function"
.Lh5:  .ascii "object"
.Lh6:  .ascii "unknown"
.Lk_code:     .ascii "code"
.Lk_path:     .ascii "path"
.Lk_message:  .ascii "message"
.Lk_expected: .ascii "expected"
.Lk_received: .ascii "received"
.Lm_expected: .ascii "Expected "
.Lm_received: .ascii ", received "
.Lm_required: .ascii "Required"
.Ln_nan:      .ascii "nan"

    .text
    .p2align 2
// az_issue_f_i64(x0=kptr,x1=klen,x2=val) — writes field with BIGINT tagged value
    .globl _az_issue_f_i64
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
