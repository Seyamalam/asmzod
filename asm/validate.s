#include "port.h"
// validate.s — az_validate: recursive schema bytecode interpreter
//
//   az_validate(x0=node, x1=val) -> x0 status, x1=out ptr, x2=out len
//     0   ok — out is (possibly new) tagged value bytes
//     -2  invalid — issues appended to err arena
//     -3  out_val ENOSPC
//     -4  out_err ENOSPC
//     -5  host callback threw (JS rethrows stashed error)
//     -1  malformed bytecode
//
// frame: x27=node x28=val (saved per call); ctx regs x19-x25
    .text
    .p2align 2

    .globl _az_validate
    AZ_HIDDEN _az_validate
_az_validate:
    stp x29, x30, [sp, #-512]!
    mov x29, sp
    stp x27, x28, [sp, #16]
    mov x27, x0
    mov x28, x1
.Lv_dispatch:
    ldrb w9, [x27]
    cmp w9, #0x2A
    b.eq .Lv_msgnode
    cmp w9, #0x25
    b.hi .Lv_badop
    AZ_ADR x10, .Lv_jt
    ldr x11, [x10, x9, lsl #3]
    br x11

// 0x2A msgwrap: [op][u64 msglen][msg][i64 rel -> inner node]
.Lv_msgnode:
    ldr x10, [x27, #1]         // msglen
    add x11, x27, #9           // msgptr
    add x12, x11, x10          // -> rel field
    AZ_ADR x9, _az_msgstack
    ldr x13, [x9]
    cmp x13, #64
    b.hs .Lv_msg_skip
    lsl x14, x13, #1
    add x14, x14, x13
    lsl x14, x14, #3
    add x15, x9, #8
    add x15, x15, x14
    ldr x16, [x22, #8]         // path depth
    stp x16, x11, [x15]
    str x10, [x15, #16]
    add x13, x13, #1
    str x13, [x9]
    ldr x10, [x12]
    add x0, x12, x10
    mov x1, x28
    bl _az_validate
    AZ_ADR x9, _az_msgstack
    ldr x13, [x9]
    subs x13, x13, #1
    b.mi .Lv_ret
    str x13, [x9]
    b .Lv_ret
.Lv_msg_skip:
    ldr x10, [x12]
    add x27, x12, x10
    b .Lv_dispatch

// ---------- shared exits ----------
.Lv_ret:
    ldp x27, x28, [sp, #16]
    ldp x29, x30, [sp]
    add sp, sp, #512
    ret
.Lv_invalid:
    mov x0, #-2
    b .Lv_ret
.Lv_badop:
    mov x0, #-1
    b .Lv_ret
// out = whole input
.Lv_pass:
    mov x0, x28
    bl _az_vsize
    mov x2, x0
    mov x1, x28
    mov x0, #0
    b .Lv_ret
// out = scalar input, x9 = size
.Lv_passn:
    mov x2, x9
    mov x1, x28
    mov x0, #0
    b .Lv_ret
// tail-dispatch to child: x9 = addr of i64 self-rel offset field
.Lv_tail:
    ldr x10, [x9]
    add x27, x9, x10
    ldrb w9, [x27]
    cmp w9, #0x2A
    b.eq .Lv_msgnode
    cmp w9, #0x25
    b.hi .Lv_badop
    AZ_ADR x10, .Lv_jt
    ldr x11, [x10, x9, lsl #3]
    br x11
// type issue helper: x0=expptr x1=explen -> emit invalid_type then -2/-4
_az_vtype:
    ldrb w2, [x28]
    mov x3, x28
    bl _az_issue_type
    cbnz x0, .Lv_ret           // -4 propagate
    b .Lv_invalid

// ---------- 0x01 STRING ----------
.Lv_string:
    ldrb w9, [x28]
    cmp w9, #4
    b.eq .Lvs_tok
    b .Lvs_tfail
.Lvs_tok:
    ldrb w9, [x27, #1]
    cbz w9, .Lvs_ok
    add x0, x27, #2
    mov x1, x9
    add x2, x28, #9
    ldr x3, [x28, #1]
    bl _az_run_strchecks
    cbnz x0, .Lv_ret
.Lvs_ok:
    ldr x9, [x28, #1]
    add x9, x9, #9
    b .Lv_passn

// ---------- 0x02 NUMBER ----------
.Lv_number:
    ldrb w9, [x28]
    cmp w9, #3
    b.eq .Lvn_tok
    AZ_ADR x0, .Lex_number
    mov x1, #6
    b _az_vtype
.Lvn_tok:
    ldr d0, [x28, #1]
    fcmp d0, d0
    b.vc .Lvn_infchk
    // NaN -> invalid_type (issue_type detects nan -> "nan")
    AZ_ADR x0, .Lex_number
    mov x1, #6
    b _az_vtype
.Lvn_infchk:
    // zod4: +-Infinity is not a valid z.number()
    fabs d1, d0
    mov x10, #0x7FF0000000000000
    fmov d2, x10
    fcmp d1, d2
    b.ne .Lvn_fin
    AZ_ADR x0, .Lex_number
    mov x1, #6
    b _az_vtype
.Lvn_fin:
    ldrb w9, [x27, #1]
    cbz w9, .Lvn_ok
    add x0, x27, #2
    mov x1, x9
    ldr d0, [x28, #1]
    mov x2, x28
    bl _az_run_numchecks
    cbnz x0, .Lv_ret
.Lvn_ok:
    mov x9, #9
    b .Lv_passn

// ---------- 0x03 BOOLEAN ----------
.Lv_boolean:
    ldrb w9, [x28]
    cmp w9, #2
    b.eq .Lvb_ok
    AZ_ADR x0, .Lex_boolean
    mov x1, #7
    b _az_vtype
.Lvb_ok:
    mov x9, #2
    b .Lv_passn

// ---------- 0x04 BIGINT ----------
.Lv_bigint:
    ldrb w9, [x28]
    cmp w9, #5
    b.eq .Lvb_tok
    AZ_ADR x0, .Lex_bigint
    mov x1, #6
    b _az_vtype
.Lvb_tok:
    ldrb w9, [x27, #1]
    cbz w9, .Lvb_ok2
    add x0, x27, #2
    mov x1, x9
    ldr x2, [x28, #1]
    mov x3, x28
    bl _az_run_bigintchecks
    cbnz x0, .Lv_ret
.Lvb_ok2:
    mov x9, #9
    b .Lv_passn

// ---------- 0x17 NULL_T ----------
.Lv_nullt:
    ldrb w9, [x28]
    cmp w9, #1
    b.eq .Lvnul_ok
    AZ_ADR x0, .Lex_null
    mov x1, #4
    b _az_vtype
.Lvnul_ok:
    mov x9, #1
    b .Lv_passn

// ---------- 0x18 UNDEF_T ----------
.Lv_undeft:
    ldrb w9, [x28]
    cmp w9, #0
    b.eq .Lvund_ok
    AZ_ADR x0, .Lex_undefined
    mov x1, #9
    b _az_vtype
.Lvund_ok:
    mov x9, #1
    b .Lv_passn

// ---------- 0x19 NAN ----------
.Lv_nan:
    ldrb w9, [x28]
    cmp w9, #3
    b.ne .Lvnan_no
    ldr d0, [x28, #1]
    fcmp d0, d0
    b.vs .Lvnan_ok           // unordered -> NaN
.Lvnan_no:
    AZ_ADR x0, .Lex_nan
    mov x1, #3
    b _az_vtype
.Lvnan_ok:
    mov x9, #9
    b .Lv_passn

// ---------- 0x15 ANY / UNKNOWN ----------
.Lv_any:
    b .Lv_pass

// ---------- 0x16 NEVER ----------
.Lv_never:
    AZ_ADR x0, .Lex_never
    mov x1, #5
    b _az_vtype

// ---------- 0x21 SYMBOL (HOSTREF kind 1) ----------
.Lv_symbol:
    ldrb w9, [x28]
    cmp w9, #8
    b.ne .Lvsym_no
    ldr x9, [x24, #24]         // cb_host
    mov x0, #2                 // kind2 hostref-kind-check
    mov x1, #1                 // subtype symbol
    ldr x2, [x28, #1]
    mov x3, #0
    blr x9
    cmp x0, #0
    b.eq .Lvsym_no
    mov x9, #9
    b .Lv_passn
.Lvsym_no:
    AZ_ADR x0, .Lex_symbol
    mov x1, #6
    b _az_vtype

// ---------- 0x0B OPTIONAL ----------
.Lv_optional:
    ldrb w9, [x28]
    cbnz w9, .Lvopt_inner
    mov x9, #1
    b .Lv_passn
.Lvopt_inner:
    add x9, x27, #1
    b .Lv_tail

// ---------- 0x0C NULLABLE ----------
.Lv_nullable:
    ldrb w9, [x28]
    cmp w9, #1
    b.ne .Lvnull_inner
    mov x9, #1
    b .Lv_passn
.Lvnull_inner:
    add x9, x27, #1
    b .Lv_tail

// ---------- 0x0D DEFAULT ----------
// [op][inner i64][embedded Value @+9]
.Lv_default:
    ldrb w9, [x28]
    cbz w9, .Lvdef_use
    mov x1, x28
    b .Lvdef_go
.Lvdef_use:
    add x1, x27, #9            // embedded default value
.Lvdef_go:
    add x9, x27, #1
    ldr x10, [x9]
    add x0, x9, x10            // inner node
    bl _az_validate
    b .Lv_ret

// ---------- 0x0E CATCH ----------
// [op][inner i64][embedded Value @+9]
.Lv_catch:
    // snapshot
    stp x19, x20, [sp, #32]
    stp x21, x22, [sp, #48]    // x22 stays same anyway
    ldr x9, [x22]              // issue_count
    ldr x10, [x22, #8]         // depth
    stp x9, x10, [sp, #64]
    add x9, x27, #1
    ldr x10, [x9]
    add x0, x9, x10
    mov x1, x28
    bl _az_validate
    cbz x0, .Lv_ret            // ok
    cmp x0, #-2
    b.ne .Lv_ret               // -3/-4/-5 propagate
    // restore
    ldp x19, x20, [sp, #32]
    ldp x21, x9, [sp, #48]
    ldp x10, x11, [sp, #64]
    str x10, [x22]
    str x11, [x22, #8]
    // out = embedded catch value (ref into schema blob)
    add x0, x27, #9
    bl _az_vsize
    mov x2, x0
    add x1, x27, #9
    mov x0, #0
    b .Lv_ret

// ---------- 0x09 LITERAL ----------
// [op][embedded scalar Value]
.Lv_literal:
    ldrb w9, [x27, #1]         // lit tag
    ldrb w10, [x28]            // in tag
    cmp w9, w10
    b.ne .Llit_fail
    cmp w9, #0
    b.eq .Llit_ok
    cmp w9, #1
    b.eq .Llit_ok
    cmp w9, #2
    b.eq .Llit_bool
    cmp w9, #3
    b.eq .Llit_f64
    cmp w9, #4
    b.eq .Llit_str
    cmp w9, #5
    b.eq .Llit_big
    b .Llit_fail
.Llit_bool:
    ldrb w11, [x27, #2]
    ldrb w12, [x28, #1]
    cmp w11, w12
    b.eq .Llit_ok
    b .Llit_fail
.Llit_f64:
    ldr x11, [x27, #2]
    ldr x12, [x28, #1]
    cmp x11, x12
    b.eq .Llit_ok
    b .Llit_fail
.Llit_big:
    ldr x11, [x27, #2]
    ldr x12, [x28, #1]
    cmp x11, x12
    b.eq .Llit_ok
    b .Llit_fail
.Llit_str:
    ldr x11, [x27, #2]         // lit len
    ldr x12, [x28, #1]         // in len
    cmp x11, x12
    b.ne .Llit_fail
    add x0, x27, #10
    add x1, x28, #9
    mov x2, x12
    bl _az_memeq
    cbz w0, .Llit_fail
.Llit_ok:
    b .Lv_pass
.Llit_fail:
    // invalid_literal {expected: rawval} — msg supplied by TS normalizer
    mov x0, #1                 // invalid_literal
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Lv_ret
    // field expected: rawval = embedded value bytes
    AZ_ADR x0, .Lk_expected2
    mov x1, #8
    add x2, x27, #1
    mov x0, x0                 // keep
    // vsize embedded
    stp x0, x1, [sp, #80]
    str x2, [sp, #96]
    mov x0, x2
    bl _az_vsize
    mov x3, x0
    ldp x0, x1, [sp, #80]
    ldr x2, [sp, #96]
    bl _az_issue_f_rawval
    cbnz x0, .Lv_ret
    bl _az_issue_commit
    b .Lv_invalid

// ---------- 0x0A ENUM ----------
// [op][u64 n][entries: u64 len + bytes]*
.Lv_enum:
    ldrb w9, [x28]
    cmp w9, #4
    b.ne .Len_fail
    ldr x13, [x27, #1]         // n
    add x14, x27, #9           // cur entry
    ldr x15, [x28, #1]         // in len
    add x16, x28, #9           // in ptr
.Len_loop:
    cbz x13, .Len_fail
    ldr x9, [x14]
    cmp x9, x15
    b.ne .Len_next
    mov x0, x16
    add x1, x14, #8
    mov x2, x15
    bl _az_memeq
    cbnz w0, .Len_ok
.Len_next:
    ldr x9, [x14]
    add x14, x14, x9
    add x14, x14, #8
    sub x13, x13, #1
    b .Len_loop
.Len_ok:
    ldr x9, [x28, #1]
    add x9, x9, #9
    b .Lv_passn
.Len_fail:
    // invalid_enum_value {received: rawval, options: strseq}
    // msg supplied by TS normalizer
    mov x0, #4                 // invalid_enum_value
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Lv_ret
    // received: raw input value
    AZ_ADR x0, .Lk_received2
    mov x1, #8
    mov x2, x28
    mov x0, x0
    stp x0, x1, [sp, #80]
    mov x0, x28
    bl _az_vsize
    mov x3, x0
    ldp x0, x1, [sp, #80]
    mov x2, x28
    bl _az_issue_f_rawval
    cbnz x0, .Lv_ret
    // options: strseq from node+9
    AZ_ADR x0, .Lk_options
    mov x1, #7
    add x2, x27, #9
    ldr x3, [x27, #1]
    bl _az_issue_f_strseq
    cbnz x0, .Lv_ret
    bl _az_issue_commit
    b .Lv_invalid

// ---------- 0x07 UNION ----------
// [op][u64 n][n x i64 optoffs]
.Lv_union:
    ldr x13, [x27, #1]
    stp x13, x27, [sp, #32]    // nopts, node
    add x14, x27, #9
    str x14, [sp, #48]         // optseq cursor
.Lun_loop:
    ldr x13, [sp, #32]
    cbz x13, .Lun_allfail
    // snapshot
    stp x19, x20, [sp, #64]
    stp x21, xzr, [sp, #80]    // x21 + pad
    ldr x9, [x22]
    ldr x10, [x22, #8]
    stp x9, x10, [sp, #96]
    // opt node = cur + [cur]
    ldr x9, [sp, #48]
    ldr x10, [x9]
    add x0, x9, x10
    mov x1, x28
    bl _az_validate
    cbz x0, .Lv_ret            // success
    cmp x0, #-2
    b.ne .Lv_ret               // -3/-4/-5 propagate
    // rollback
    ldp x19, x20, [sp, #64]
    ldr x21, [sp, #80]
    ldp x9, x10, [sp, #96]
    str x9, [x22]
    str x10, [x22, #8]
    // next
    ldr x9, [sp, #48]
    add x9, x9, #8
    str x9, [sp, #48]
    ldr x13, [sp, #32]
    sub x13, x13, #1
    str x13, [sp, #32]
    b .Lun_loop
.Lun_allfail:
    mov x0, #3                 // invalid_union
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Lv_ret
    // `_u` = union index (trailing field) so TS can attach per-option errors
    ldr x9, [sp, #40]          // node ptr saved at union entry
    ldr x10, [sp, #32]         // wait — sp32 holds remaining count (0 now)
    ldr x10, [x9, #1]          // nopts from node
    lsl x10, x10, #3
    add x10, x10, #9
    ldr x10, [x9, x10]         // uidx
    ucvtf d0, x10
    AZ_ADR x0, .Lk_u
    mov x1, #2
    bl _az_issue_f_f64
    cbnz x0, .Lv_ret
    bl _az_issue_commit
    b .Lv_invalid

// ---------- 0x08 DISCRIMINATED UNION ----------
// [op][u64 dnamelen][dname][u64 nmap][klen+key+i64]*
.Lv_discunion:
    ldrb w9, [x28]
    cmp w9, #6
    b.eq .Ldu_obj
    cmp w9, #8
    b.eq .Ldu_hr
    cmp w9, #9
    b.eq .Ldu_hrobj            // map — object-like
    cmp w9, #10
    b.eq .Ldu_hrobj            // set — object-like
    b .Ldu_typefail
.Ldu_hr:
    // hostref: object-like kinds (date/map/set/object/unknown/Invalid Date)
    // take the no-matching-discriminator path like zod; symbol/function/
    // bigint are invalid_type
    ldr x9, [x24, #24]         // cb_host
    mov x0, #6                 // kind6 host type idx
    ldr x1, [x28, #1]
    mov x2, #0
    mov x3, #0
    blr x9
    cbz x0, .Ldu_typefail      // symbol
    cmp x0, #4
    b.eq .Ldu_typefail         // function
    cmp x0, #8
    b.eq .Ldu_typefail         // bigint
.Ldu_hrobj:
    ldr x13, [x27, #1]         // dnamelen
    add x14, x27, #9           // dname
    b .Ldu_fail
.Ldu_typefail:
    AZ_ADR x0, .Lex_object
    mov x1, #6
    b _az_vtype
.Ldu_obj:
    ldr x13, [x27, #1]         // dnamelen
    add x14, x27, #9           // dname
    // find discriminator field in input
    ldr x15, [x28, #1]         // nfields
    add x16, x28, #9
.Ldu_scan:
    cbz x15, .Ldu_fail
    ldr x9, [x16]
    cmp x9, x13
    b.ne .Ldu_next
    mov x0, x14
    add x1, x16, #8
    mov x2, x13
    stp x13, x14, [sp, #32]
    stp x15, x16, [sp, #48]
    bl _az_memeq
    cbnz w0, .Ldu_found
    ldp x13, x14, [sp, #32]
    ldp x15, x16, [sp, #48]
.Ldu_next:
    ldr x9, [x16]
    add x16, x16, x9
    add x16, x16, #8           // now at value
    mov x0, x16
    bl _az_vsize
    add x16, x16, x0
    sub x15, x15, #1
    b .Ldu_scan
.Ldu_found:
    ldp x13, x14, [sp, #32]
    // value ptr = x16+8+dnamelen... wait x16 was keystart; recompute val
    ldr x9, [x16]
    add x0, x16, x9
    add x0, x0, #8             // value ptr
    ldrb w9, [x0]
    cmp w9, #4                 // discr must be string
    b.ne .Ldu_fail
    // match map
    str x0, [sp, #64]
    add x10, x14, x13          // past dname
    ldr x11, [x10]             // nmap
    add x12, x10, #8           // map cur
    ldr x15, [x0, #1]          // in len
    add x16, x0, #9            // in ptr
.Ldu_map:
    cbz x11, .Ldu_fail
    ldr x9, [x12]
    cmp x9, x15
    b.ne .Ldu_mnext
    stp x10, x11, [sp, #80]
    stp x12, x15, [sp, #96]
    str x16, [sp, #112]
    mov x0, x16
    add x1, x12, #8
    mov x2, x15
    bl _az_memeq
    cbnz w0, .Ldu_match
    ldp x10, x11, [sp, #80]
    ldp x12, x15, [sp, #96]
    ldr x16, [sp, #112]
.Ldu_mnext:
    ldr x9, [x12]
    add x12, x12, x9
    add x12, x12, #8
    add x12, x12, #8           // skip i64 off too
    sub x11, x11, #1
    b .Ldu_map
.Ldu_match:
    ldp x10, x11, [sp, #80]
    ldp x12, x15, [sp, #96]
    ldr x9, [x12]
    add x12, x12, x9
    add x12, x12, #8           // now at i64 optoff
    ldr x10, [x12]
    add x0, x12, x10           // opt node
    mov x1, x28
    bl _az_validate
    b .Lv_ret
.Ldu_fail:
    mov x0, x14              // discriminator name ptr
    mov x1, x13              // len
    bl _az_path_push_key
    mov x0, #3
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Lv_ret
    bl _az_issue_commit
    bl _az_path_pop
    b .Lv_invalid

// ---------- 0x0F REFINE ----------
// [op][inner i64][cbid u64][msglen u64][msg]
.Lv_refine:
    add x9, x27, #1
    ldr x10, [x9]
    add x0, x9, x10
    mov x1, x28
    bl _az_validate
    cbnz x0, .Lv_ret
    // out in x1/x2 — cb_refine(cbid, outptr)
    stp x1, x2, [sp, #32]
    ldr x9, [x24]              // cb_refine = table[0]
    ldr x0, [x27, #9]          // cbid
    ldr x1, [sp, #32]
    blr x9
    cbnz w0, .Lrf_ok
    // issue custom with node msg
    ldr x2, [x27, #17]         // msglen
    add x1, x27, #25           // msg
    mov x0, #2                 // custom
    bl _az_issue_begin
    cbnz x0, .Lv_ret
    bl _az_issue_commit
    b .Lv_invalid
.Lrf_ok:
    ldp x1, x2, [sp, #32]
    mov x0, #0
    b .Lv_ret

// ---------- 0x10 TRANSFORM ----------
// [op][inner i64][cbid u64]
.Lv_transform:
    add x9, x27, #1
    ldr x10, [x9]
    add x0, x9, x10
    mov x1, x28
    bl _az_validate
    cbnz x0, .Lv_ret
    // cb_transform(cbid, outptr, x19, avail) -> i64 len | -3 enospc | -5 threw
    ldr x9, [x24, #8]          // cb_transform = table[1]
    ldr x0, [x27, #9]
    // x1 = outptr already
    mov x2, x19
    sub x3, x20, x19
    str x19, [sp, #32]         // remember dest (x13 not safe across cb)
    blr x9
    cmp x0, #0
    b.lt .Lv_ret               // -3/-5 propagate
    ldr x1, [sp, #32]
    add x19, x1, x0            // bump arena by produced len
    mov x2, x0
    mov x0, #0
    b .Lv_ret

// ---------- 0x11 PIPE ----------
// [op][in i64][out i64]
.Lv_pipe:
    // in run — tag its issues _nc; a truncated pipe judges aborted upstream
    AZ_ADR x9, az_nc_flag
    mov w10, #1
    strb w10, [x9]
    add x9, x27, #1
    ldr x10, [x9]
    add x0, x9, x10
    mov x1, x28
    bl _az_validate
    AZ_ADR x9, az_nc_flag
    strb wzr, [x9]
    cbnz x0, .Lv_ret
    // output value -> input of second; ptr in x1
    mov x28, x1
    add x9, x27, #9
    ldr x10, [x9]
    add x0, x9, x10
    mov x1, x28
    bl _az_validate
    b .Lv_ret

// ---------- 0x1A LAZY ----------
// [op][u64 cbid] : cb_lazy(id) -> node ptr
.Lv_lazy:
    ldr x9, [x24, #16]         // cb_lazy = table[2]
    ldr x0, [x27, #1]
    blr x9
    cmp x0, #0
    b.eq .Lv_badop
    mov x1, x28
    bl _az_validate            // x0=node ptr
    b .Lv_ret

// ---------- 0x1B INSTANCEOF ----------
// [op][u64 cbid][u64 namelen][name]
.Lv_instof:
    ldrb w9, [x28]
    cmp w9, #8
    b.eq .Lio_hr
    cmp w9, #9
    b.eq .Lio_tag
    cmp w9, #10
    b.ne .Lio_fail
.Lio_tag:
    // tag9/10 values are real Map/Set by construction — cb kind9 compares
    // the implied ctor to the schema's without a host slot
    ldr x9, [x24, #24]         // cb_host
    mov x0, #9
    mov w1, w9
    ldr x2, [x27, #1]          // cbid (ctor idx)
    mov x3, #0
    blr x9
    cmp x0, #0
    b.eq .Lio_fail
    mov x9, #9
    b .Lv_passn
.Lio_hr:
    ldr x9, [x24, #24]         // cb_host
    mov x0, #1                 // instanceof
    ldr x1, [x27, #1]          // cbid
    ldr x2, [x28, #1]          // hostref idx
    mov x3, #0
    blr x9
    cmp x0, #0
    b.eq .Lio_fail
    mov x9, #9
    b .Lv_passn
.Lio_fail:
    // invalid_type expected = class name
    ldr x1, [x27, #9]          // namelen
    add x0, x27, #17
    b _az_vtype

// ---------- 0x22 CUSTOM ----------
// [op][u64 cbid][u64 msglen][msg]
.Lv_custom:
    ldr x9, [x24, #24]
    mov x0, #4                 // kind4 custom
    ldr x1, [x27, #1]
    mov x2, x28
    mov x3, #0
    blr x9
    cmp x0, #0
    b.eq .Lcu_fail
    b .Lv_pass
.Lcu_fail:
    ldr x2, [x27, #9]
    add x1, x27, #17
    mov x0, #2
    bl _az_issue_begin
    cbnz x0, .Lv_ret
    bl _az_issue_commit
    b .Lv_invalid

// ---------- 0x23 NONOPTIONAL (inner) ----------
.Lv_nonopt:
    ldrb w9, [x28]
    cbnz w9, .Lno_inner
    AZ_ADR x0, .Lex_nonopt
    mov x1, #11
    b _az_vtype
.Lno_inner:
    mov x9, x27
    add x9, x9, #1
    b .Lv_tail

// ---------- az_lit_repr(x0=valptr, x1=buf) -> x0 len ----------
// repr of scalar value for messages
    .globl _az_lit_repr
    AZ_HIDDEN _az_lit_repr
_az_lit_repr:
    stp x29, x30, [sp, #-48]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    ldrb w9, [x0]
    cmp w9, #4
    b.eq .Lrp_str
    cmp w9, #3
    b.eq .Lrp_f64
    cmp w9, #5
    b.eq .Lrp_big
    cmp w9, #2
    b.eq .Lrp_bool
    cmp w9, #0
    b.eq .Lrp_undef
    cmp w9, #1
    b.eq .Lrp_null
    // object/array/hostref -> "{}"
    mov w10, #'{'
    strb w10, [x1]
    mov w10, #'}'
    strb w10, [x1, #1]
    mov x0, #2
    b .Lrp_out
.Lrp_undef:
    AZ_ADR x2, .Lrp_und
    mov x3, #9
    b .Lrp_lit
.Lrp_null:
    AZ_ADR x2, .Lrp_nul
    mov x3, #4
    b .Lrp_lit
.Lrp_bool:
    ldrb w10, [x0, #1]
    cbz w10, .Lrp_false
    AZ_ADR x2, .Lrp_tru
    mov x3, #4
    b .Lrp_lit
.Lrp_false:
    AZ_ADR x2, .Lrp_fal
    mov x3, #5
    b .Lrp_lit
.Lrp_lit:
    mov x0, x1
    mov x1, x2
    mov x2, x3
    bl _az_cat
    ldr x9, [sp, #16]          // buf start? no — cat returned cursor
    ldr x10, [sp, #24]         // original buf
    sub x0, x0, x10
    b .Lrp_out
.Lrp_str:
    mov w10, #'"'
    strb w10, [x1]
    add x10, x1, #1
    add x11, x0, #9
    ldr x12, [x0, #1]
    mov x0, x10
    mov x1, x11
    mov x2, x12
    bl _az_cat
    mov w10, #'"'
    strb w10, [x0], #1
    ldr x10, [sp, #24]
    sub x0, x0, x10
    b .Lrp_out
.Lrp_f64:
    ldr d0, [x0, #1]
    mov x0, x1
    bl _az_f64_dec
    b .Lrp_out
.Lrp_big:
    ldr x0, [x0, #1]
    // x1=buf
    bl _az_sdec
    b .Lrp_out
.Lrp_out:
    ldp x29, x30, [sp], #48
    ret

// ---------- coerce helpers ----------
// az_emit_str(x0=ptr,x1=len) -> x0 outptr (tag4 tagged str in arena) / -3
    .globl _az_emit_str
    AZ_HIDDEN _az_emit_str
_az_emit_str:
    stp x29, x30, [sp, #-48]!
    mov x29, sp
    stp x0, x1, [sp, #16]
    add x0, x1, #9
    bl _az_val_reserve
    cmp x0, #-1
    b.eq .Les_oom
    mov x10, x0
    mov w9, #4
    strb w9, [x10]
    ldr x9, [sp, #24]
    str x9, [x10, #1]
    ldp x11, x12, [sp, #16]
    add x10, x10, #9
    cbz x12, .Les_done
.Les_cp:
    ldrb w9, [x11], #1
    strb w9, [x10], #1
    subs x12, x12, #1
    b.ne .Les_cp
.Les_done:
    sub x0, x10, x9            // hmm recompute: out = dst
    ldr x9, [sp, #24]
    sub x0, x10, x9
    sub x0, x0, #9
    b .Les_out
.Les_oom:
    mov x0, #-3
.Les_out:
    ldp x29, x30, [sp], #48
    ret

// az_emit_f64(d0) -> x0 outptr / -3
    .globl _az_emit_f64
    AZ_HIDDEN _az_emit_f64
_az_emit_f64:
    stp x29, x30, [sp, #-32]!
    mov x29, sp
    str d0, [sp, #16]
    mov x0, #9
    bl _az_val_reserve
    cmp x0, #-1
    b.eq .Lef_oom
    mov w9, #3
    strb w9, [x0]
    ldr x9, [sp, #16]
    str x9, [x0, #1]
    b .Lef_out
.Lef_oom:
    mov x0, #-3
.Lef_out:
    ldp x29, x30, [sp], #32
    ret

// az_emit_i64(x0) -> x0 outptr / -3
    .globl _az_emit_i64
    AZ_HIDDEN _az_emit_i64
_az_emit_i64:
    stp x29, x30, [sp, #-32]!
    mov x29, sp
    str x0, [sp, #16]
    mov x0, #9
    bl _az_val_reserve
    cmp x0, #-1
    b.eq .Lei_oom
    mov w9, #5
    strb w9, [x0]
    ldr x9, [sp, #16]
    str x9, [x0, #1]
    b .Lei_out
.Lei_oom:
    mov x0, #-3
.Lei_out:
    ldp x29, x30, [sp], #32
    ret

// az_strtod(x0=ptr,x1=len) -> d0 (NaN on invalid)
    .globl _az_strtod
    AZ_HIDDEN _az_strtod
_az_strtod:
    // JS Number(str): trim ws, ""->0, 0x->hex, Infinity, NaN, decimal
    mov x9, #0                 // i
    mov x10, #1                // sign
    mov x14, #1                // esign
    mov x15, #0                // edigits
    mov x16, #0                // eval
    fmov d0, xzr
    // trim leading ws
.Lsd_twl:
    cmp x9, x1
    b.hs .Lsd_zero2            // all ws / empty -> 0
    ldrb w11, [x0, x9]
    cmp w11, #' '
    b.eq .Lsd_tw1
    cmp w11, #9
    b.lo .Lsd_twr              // < tab: not ws
    cmp w11, #13
    b.ls .Lsd_tw1              // 9..13 ws
    b .Lsd_twr
.Lsd_tw1:
    add x9, x9, #1
    b .Lsd_twl
.Lsd_twr:
    // trailing ws -> shrink len
.Lsd_tel:
    cbz x1, .Lsd_zero2
    sub x11, x1, #1
    ldrb w12, [x0, x11]
    cmp w12, #' '
    b.eq .Lsd_te1
    cmp w12, #9
    b.lo .Lsd_body
    cmp w12, #13
    b.ls .Lsd_te1
    b .Lsd_body
.Lsd_te1:
    sub x1, x1, #1
    b .Lsd_tel
.Lsd_body:
    cmp x9, x1
    b.hs .Lsd_zero2            // empty after trim -> 0
    ldrb w11, [x0, x9]
    cmp w11, #'-'
    b.ne .Lsd_p1
    mov x10, #-1
    add x9, x9, #1
    b .Lsd_p2
.Lsd_p1:
    cmp w11, #'+'
    b.ne .Lsd_p2
    add x9, x9, #1
.Lsd_p2:
    // "0x" hex?
    add x11, x9, #2
    cmp x11, x1
    b.gt .Lsd_lit
    ldrb w11, [x0, x9]
    cmp w11, #'0'
    b.ne .Lsd_lit
    add x2, x0, x9
    ldrb w11, [x2, #1]
    orr w11, w11, #0x20        // lowercase
    cmp w11, #'x'
    b.ne .Lsd_lit
    add x9, x9, #2
    mov x13, #0                // value
    mov x12, #0                // ndigits
.Lsd_hex:
    cmp x9, x1
    b.hs .Lsd_hexd
    ldrb w11, [x0, x9]
    sub w11, w11, #'0'
    cmp w11, #9
    b.ls .Lsd_hn
    ldrb w11, [x0, x9]
    orr w11, w11, #0x20
    sub w11, w11, #'a'
    cmp w11, #5
    b.hi .Lsd_nan
    add w11, w11, #10
.Lsd_hn:
    lsl x13, x13, #4
    add x13, x13, x11
    add x9, x9, #1
    add x12, x12, #1
    cmp x12, #16               // cap hex digits
    b.hi .Lsd_nan
    b .Lsd_hex
.Lsd_hexd:
    cbz x12, .Lsd_nan
    ucvtf d0, x13
    b .Lsd_sign
.Lsd_lit:
    // "Infinity" / "NaN"?
    sub x11, x1, x9
    cmp x11, #3
    b.lo .Lsd_int
    add x2, x0, x9             // cur = s+i
    ldrb w11, [x2]
    orr w11, w11, #0x20
    cmp w11, #'n'
    b.ne .Lsd_inftry
    // NaN
    cmp x11, #3
    b.ne .Lsd_nan
    ldrb w11, [x2, #1]
    orr w11, w11, #0x20
    cmp w11, #'a'
    b.ne .Lsd_nan
    ldrb w11, [x2, #2]
    orr w11, w11, #0x20
    cmp w11, #'n'
    b.ne .Lsd_nan
    b .Lsd_nan
.Lsd_inftry:
    cmp x11, #8
    b.ne .Lsd_int
    ldrb w11, [x2]
    orr w11, w11, #0x20
    cmp w11, #'i'
    b.ne .Lsd_int
    ldrb w11, [x2, #1]
    orr w11, w11, #0x20
    cmp w11, #'n'
    b.ne .Lsd_nan
    ldrb w11, [x2, #2]
    orr w11, w11, #0x20
    cmp w11, #'f'
    b.ne .Lsd_nan
    // "Infinity" = i n f i n i t y — check remaining 5
    ldrb w11, [x2, #3]
    orr w11, w11, #0x20
    cmp w11, #'i'
    b.ne .Lsd_nan
    ldrb w11, [x2, #4]
    orr w11, w11, #0x20
    cmp w11, #'n'
    b.ne .Lsd_nan
    ldrb w11, [x2, #5]
    orr w11, w11, #0x20
    cmp w11, #'i'
    b.ne .Lsd_nan
    ldrb w11, [x2, #6]
    orr w11, w11, #0x20
    cmp w11, #'t'
    b.ne .Lsd_nan
    ldrb w11, [x2, #7]
    orr w11, w11, #0x20
    cmp w11, #'y'
    b.ne .Lsd_nan
    b .Lsd_inf2
.Lsd_inf2:
    mov x13, #0x7FF0000000000000
    fmov d0, x13
    b .Lsd_sign
.Lsd_zero2:
    fmov d0, xzr
    ret
.Lsd_int:
    mov x12, #0                // digits
    mov x13, #10
    scvtf d1, x13              // 10.0
.Lsd_il:
    cmp x9, x1
    b.hs .Lsd_frac
    ldrb w11, [x0, x9]
    sub w14, w11, #'0'
    cmp w14, #9
    b.hi .Lsd_frac
    fmul d0, d0, d1
    scvtf d2, x14
    fadd d0, d0, d2
    add x9, x9, #1
    add x12, x12, #1
    b .Lsd_il
.Lsd_frac:
    cmp x9, x1
    b.hs .Lsd_end
    ldrb w11, [x0, x9]
    cmp w11, #'.'
    b.ne .Lsd_exp
    add x9, x9, #1
    fmov d3, #1.0
    fdiv d3, d3, d1            // 0.1 place
.Lsd_fl:
    cmp x9, x1
    b.hs .Lsd_exp
    ldrb w11, [x0, x9]
    sub w14, w11, #'0'
    cmp w14, #9
    b.hi .Lsd_exp
    scvtf d2, x14
    fmul d2, d2, d3
    fadd d0, d0, d2
    fdiv d3, d3, d1
    add x9, x9, #1
    add x12, x12, #1
    b .Lsd_fl
.Lsd_exp:
    cmp x9, x1
    b.hs .Lsd_end
    ldrb w11, [x0, x9]
    cmp w11, #'e'
    b.eq .Lsd_e
    cmp w11, #'E'
    b.ne .Lsd_end
.Lsd_e:
    add x9, x9, #1
    mov x14, #1                // esign
    mov x15, #0                // edigits
    mov x16, #0                // eval
    cmp x9, x1
    b.hs .Lsd_nan
    ldrb w11, [x0, x9]
    cmp w11, #'-'
    b.ne .Lsd_e1
    mov x14, #-1
    add x9, x9, #1
    b .Lsd_ed
.Lsd_e1:
    cmp w11, #'+'
    b.ne .Lsd_ed
    add x9, x9, #1
.Lsd_ed:
    cmp x9, x1
    b.hs .Lsd_end
    ldrb w11, [x0, x9]
    sub w13, w11, #'0'
    cmp w13, #9
    b.hi .Lsd_end
    mov x2, #10
    mul x16, x16, x2
    add x16, x16, x13
    add x9, x9, #1
    add x15, x15, #1
    b .Lsd_ed
.Lsd_end:
    cbz x12, .Lsd_nan          // no digits
    cmp x9, x1
    b.ne .Lsd_nan              // trailing junk
    // apply exponent (if any parsed): 10^(esign*eval)
    cbz x15, .Lsd_sign
    mul x16, x16, x14          // signed exp
    // scale = 10^|x16| clamp 400
    cmp x16, #400
    b.gt .Lsd_inf
    mov x13, #-400
    cmp x16, x13
    b.lt .Lsd_zero
    mov x13, #10
    scvtf d3, x13
    fmov d4, #1.0
    cbz x16, .Lsd_sign
    b.gt .Lsd_pexp
    neg x16, x16
    fmov d4, #1.0
.Lsd_nexp:
    cbz x16, .Lsd_applied
    fdiv d4, d4, d3
    sub x16, x16, #1
    b .Lsd_nexp
.Lsd_pexp:
    cbz x16, .Lsd_applied
    fmul d4, d4, d3
    sub x16, x16, #1
    b .Lsd_pexp
.Lsd_applied:
    fmul d0, d0, d4
.Lsd_sign:
    scvtf d1, x10
    fmul d0, d0, d1
    ret
.Lsd_inf:
    mov x13, #0x7FF0000000000000
    fmov d0, x13
    b .Lsd_sign
.Lsd_zero:
    fmov d0, xzr
    b .Lsd_sign
.Lsd_nan:
    mov x13, #0x7FF8000000000000
    fmov d0, x13
    ret

// az_strtoi(x0=ptr,x1=len) -> x0=i64, w1=ok
    .globl _az_strtoi
    AZ_HIDDEN _az_strtoi
_az_strtoi:
    mov x9, #0
    mov x10, #0                // val
    mov x11, #1                // sign
    cbz x1, .Lst_bad
    ldrb w12, [x0]
    cmp w12, #'-'
    b.ne .Lst_p
    mov x11, #-1
    add x9, x9, #1
    b .Lst_d
.Lst_p:
    cmp w12, #'+'
    b.ne .Lst_d
    add x9, x9, #1
.Lst_d:
    mov x13, #0                // digits
    mov x14, #10
.Lst_dl:
    cmp x9, x1
    b.hs .Lst_e
    ldrb w12, [x0, x9]
    sub w15, w12, #'0'
    cmp w15, #9
    b.hi .Lst_e
    mul x10, x10, x14
    add x10, x10, x15
    add x9, x9, #1
    add x13, x13, #1
    b .Lst_dl
.Lst_e:
    cbz x13, .Lst_bad
    cmp x9, x1
    b.ne .Lst_bad
    mul x0, x10, x11
    mov w1, #1
    ret
.Lst_bad:
    mov x0, #0
    mov w1, #0
    ret

    AZ_DATA
    .p2align 3
.Lv_jt:
    .quad .Lv_badop
    .quad .Lv_string
    .quad .Lv_number
    .quad .Lv_boolean
    .quad .Lv_bigint
    .quad .Lv_object
    .quad .Lv_array
    .quad .Lv_union
    .quad .Lv_discunion
    .quad .Lv_literal
    .quad .Lv_enum
    .quad .Lv_optional
    .quad .Lv_nullable
    .quad .Lv_default
    .quad .Lv_catch
    .quad .Lv_refine
    .quad .Lv_transform
    .quad .Lv_pipe
    .quad .Lv_intersect
    .quad .Lv_tuple
    .quad .Lv_record
    .quad .Lv_any
    .quad .Lv_never
    .quad .Lv_nullt
    .quad .Lv_undeft
    .quad .Lv_nan
    .quad .Lv_lazy
    .quad .Lv_instof
    .quad .Lv_coerce_str
    .quad .Lv_coerce_num
    .quad .Lv_coerce_bool
    .quad .Lv_coerce_bigint
    .quad .Lv_date
    .quad .Lv_symbol
    .quad .Lv_custom
    .quad .Lv_nonopt
    .quad .Lv_map
    .quad .Lv_set

    AZ_RODATA
.Lex_string:    .ascii "string"
.Lex_number:    .ascii "number"
.Lex_boolean:   .ascii "boolean"
.Lex_bigint:    .ascii "bigint"
.Lex_object:    .ascii "object"
.Lex_record:    .ascii "record"
.Lex_null:      .ascii "null"
.Lex_undefined: .ascii "undefined"
.Lex_nan:       .ascii "nan"
.Lex_never:     .ascii "never"
.Lex_symbol:    .ascii "symbol"
.Lex_date:      .ascii "date"
.Lex_array:     .ascii "array"
.Lex_tuple:     .ascii "tuple"
.Lex_nonopt:    .ascii "nonoptional"
.Lex_map:       .ascii "map"
.Lex_set:       .ascii "set"
.Lty_array:     .ascii "array"
.Lk_expected2:  .ascii "expected"
.Lk_received2:  .ascii "received"
.Lk_origin:      .ascii "origin"
.Lk_k:           .ascii "_k"
.Lk_options:    .ascii "options"
.Lk_u:          .ascii "_u"
.Lm_litpre:     .ascii "Invalid input: expected "
.Lm_enpre:      .ascii "Invalid option: expected one of "
.Lrp_und:       .ascii "undefined"
.Lrp_nul:       .ascii "null"
.Lrp_tru:       .ascii "true"
.Lrp_fal:       .ascii "false"
.Lma_atleast:   .ascii "Array must contain at least "
.Lma_atmost:    .ascii "Array must contain at most "
.Lma_exactly:   .ascii "Array must contain exactly "
.Lma_elems:     .ascii " element(s)"

    AZ_RODATA
.Lundef_val:    .byte 0
    .p2align 3
.Lproto__:      .ascii "__proto__"
    .text

// ==================== part 2: composites ====================

// ---------- 0x06 ARRAY ----------
// [op][elem i64][min u64][max u64]   (u64_MAX = absent)
.Lv_array:
    ldrb w9, [x28]
    cmp w9, #7
    b.eq .Lar_tok
    b .Lar_tfail
.Lar_tok:
    ldr x9, [x28, #1]          // n elems
    str x9, [sp, #40]
    str xzr, [sp, #72]         // failed = 0
    // elem node
    add x9, x27, #1
    ldr x10, [x9]
    add x9, x9, x10
    str x9, [sp, #48]
    // min/max
    ldr x10, [x27, #9]         // min
    ldr x11, [x27, #17]        // max
    ldr x12, [sp, #40]         // n
    mov x13, #-1
    cmp x10, x13
    b.eq .Lar_chkmax
    cmp x12, x10
    b.hs .Lar_chkmax
    // too_small array min
    str x10, [sp, #80]
    mov x7, #0             // default msg -> TS normalizer
    mov x0, #8
    AZ_ADR x1, .Lty_array
    mov x2, #5
    ldr x3, [sp, #80]
    ucvtf d0, x3
    fmov x3, d0
    mov w4, #1
    ldrb w5, [x27, #25]        // exactLen flag
    bl _az_issue_size
    cbnz x0, .Lv_ret
    mov x9, #1
    str x9, [sp, #72]          // failed
.Lar_chkmax:
    ldr x11, [x27, #17]
    ldr x12, [sp, #40]
    mov x13, #-1
    cmp x11, x13
    b.eq .Lar_size_done
    cmp x12, x11
    b.ls .Lar_size_done
    str x11, [sp, #80]
    mov x7, #0             // default msg -> TS normalizer
    mov x0, #9
    AZ_ADR x1, .Lty_array
    mov x2, #5
    ldr x3, [sp, #80]
    ucvtf d0, x3
    fmov x3, d0
    mov w4, #1
    ldrb w5, [x27, #25]        // exactLen flag
    bl _az_issue_size
    cbnz x0, .Lv_ret
    mov x9, #1
    str x9, [sp, #72]
.Lar_size_done:
    // init loop state
    str x20, [sp, #32]         // saved pair pos
    str xzr, [sp, #56]         // i
    add x9, x28, #9
    str x9, [sp, #64]          // cur elem ptr
.Lar_vloop:
    ldr x9, [sp, #56]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lar_emit
    mov x0, x9
    bl _az_path_push_idx
    ldr x0, [sp, #48]          // elem node
    ldr x1, [sp, #64]          // cur val
    bl _az_validate
    str x0, [sp, #80]          // status
    stp x1, x2, [sp, #88]      // out
    bl _az_path_pop
    ldr x0, [sp, #80]
    cbnz x0, .Lar_bad
    // push out pair
    ldp x2, x3, [sp, #88]
    mov x0, #0
    mov x1, #0
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret           // -3
    b .Lar_next
.Lar_bad:
    cmp x0, #-2
    b.ne .Lv_ret               // -3/-4/-5 propagate
    mov x9, #1
    str x9, [sp, #72]
    // push input slice as placeholder out
    ldr x1, [sp, #64]
    mov x0, x1
    bl _az_vsize
    mov x3, x0
    ldr x2, [sp, #64]
    mov x0, #0
    mov x1, #0
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret
.Lar_next:
    // advance input cursor
    ldr x0, [sp, #64]
    bl _az_vsize
    ldr x9, [sp, #64]
    add x9, x9, x0
    str x9, [sp, #64]
    ldr x9, [sp, #56]
    add x9, x9, #1
    str x9, [sp, #56]
    b .Lar_vloop
.Lar_emit:
    ldr x9, [sp, #72]
    cbnz x9, .Lar_fail_pop
    str x19, [sp, #96]         // emit start S
    // write tag7 + count
    mov w0, #7
    bl _az_vw1
    cbnz x0, .Lv_ret
    ldr x0, [sp, #40]
    bl _az_vw8
    cbnz x0, .Lv_ret
    // emit outs in order: pair j at x20 + (n-1-j)*40
    str xzr, [sp, #56]         // j
.Lar_eloop:
    ldr x9, [sp, #56]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lar_edone
    sub x11, x10, x9
    sub x11, x11, #1           // n-1-j
    mov x12, #40
    mul x11, x11, x12
    add x11, x20, x11          // pair addr
    ldp x0, x1, [x11, #16]     // vptr,vlen
    str x11, [sp, #88]
    bl _az_vw
    cbnz x0, .Lv_ret
    ldr x9, [sp, #56]
    add x9, x9, #1
    str x9, [sp, #56]
    b .Lar_eloop
.Lar_edone:
    ldr x9, [sp, #96]          // emit start S
    sub x2, x19, x9
    mov x1, x9
    mov x0, #0
    // pop pairs
    ldr x9, [sp, #40]
    mov x10, #40
    mul x9, x9, x10
    add x20, x20, x9
    b .Lv_ret
.Lar_fail_pop:
    ldr x9, [sp, #40]
    mov x10, #40
    mul x9, x9, x10
    add x20, x20, x9
    mov x0, #-2
    b .Lv_ret

// ---------- 0x13 TUPLE ----------
// [op][u64 n][n x i64 itemoffs][i64 rest]
.Lv_tuple:
    ldrb w9, [x28]
    cmp w9, #7
    b.eq .Ltu_tok
    AZ_ADR x0, .Lex_tuple
    mov x1, #5
    b _az_vtype
.Ltu_tok:
    ldr x9, [x28, #1]          // nin
    str x9, [sp, #40]
    ldr x10, [x27, #1]         // n items
    str x10, [sp, #48]
    // rest field addr = x27+9+n*8
    add x11, x27, #9
    lsl x12, x10, #3
    add x11, x11, x12
    str x11, [sp, #56]         // rest field addr
    ldr x12, [x11, #8]         // minItems (optinStart) — sits after rest field
    str x12, [sp, #176]
    ldr x12, [x11, #16]        // optoutStart — trailing optional-out count
    str x12, [sp, #184]
    // eff_n = rest ? max(nin, nitems) : nitems
    // (absent fixed slots still get validated as undefined — a catch fills
    // them, an optional accepts them)
    ldr x11, [x11]
    cbnz x11, .Ltu_effall
    mov x9, x10
    b .Ltu_eff
.Ltu_effall:
    ldr x9, [sp, #40]
    cmp x9, x10
    b.hs .Ltu_eff
    mov x9, x10               // rest: iterate missing fixed slots too
.Ltu_eff:
    str x9, [sp, #160]         // eff_n
    str xzr, [sp, #168]        // lenfail
    // length checks: emit issue + flag, still validate present elems
    ldr x9, [sp, #40]
    ldr x13, [sp, #176]
    cmp x9, x13
    b.hs .Ltu_over
    // under-length: with rest, missing fixed items are validated as
    // undefined (-> invalid_type@idx) rather than a size issue
    ldr x11, [sp, #56]
    ldr x11, [x11]
    cbnz x11, .Ltu_lenok
    // too_small, non-exact; length mismatch skips element validation
    AZ_ADR x9, az_nc_flag
    mov w10, #1
    strb w10, [x9]
    mov x7, #0             // default msg -> TS normalizer
    mov x0, #8
    AZ_ADR x1, .Lty_array
    mov x2, #5
    ldr x3, [sp, #176]
    ucvtf d0, x3
    fmov x3, d0
    mov w4, #1
    mov w5, #0
    bl _az_issue_size
    AZ_ADR x9, az_nc_flag
    strb wzr, [x9]
    cbnz x0, .Lv_ret
    mov x9, #1
    str x9, [sp, #168]
    str x20, [sp, #32]
    str xzr, [sp, #64]         // pushed count = 0 (validation skipped)
    b .Ltu_emit
.Ltu_over:
    ldr x11, [sp, #56]
    ldr x11, [x11]
    cbnz x11, .Ltu_lenok       // has rest
    ldr x9, [sp, #40]
    ldr x10, [sp, #48]
    cmp x9, x10
    b.ls .Ltu_lenok
    // too_big, non-exact; extra positions still get element-validated
    AZ_ADR x9, az_nc_flag
    mov w10, #1
    strb w10, [x9]
    mov x7, #0             // default msg -> TS normalizer
    mov x0, #9
    AZ_ADR x1, .Lty_array
    mov x2, #5
    ldr x3, [sp, #48]
    ucvtf d0, x3
    fmov x3, d0
    mov w4, #1
    mov w5, #0
    bl _az_issue_size
    AZ_ADR x9, az_nc_flag
    strb wzr, [x9]
    cbnz x0, .Lv_ret
    mov x9, #1
    str x9, [sp, #168]
    b .Ltu_lenok
.Ltu_lenok:
    str x20, [sp, #32]
    str xzr, [sp, #64]         // i
    add x9, x28, #9
    str x9, [sp, #72]          // cur val
    str xzr, [sp, #80]         // failed
.Ltu_loop:
    ldr x9, [sp, #64]
    ldr x10, [sp, #160]        // eff_n
    cmp x9, x10
    b.hs .Ltu_emit
    // schema for i: i<n -> offs[i] else rest
    ldr x10, [sp, #48]
    cmp x9, x10
    b.hs .Ltu_restitem
    add x11, x27, #9
    lsl x12, x9, #3
    add x11, x11, x12          // off field addr
    ldr x12, [x11]
    add x11, x11, x12          // item node
    b .Ltu_haveitem
.Ltu_restitem:
    ldr x11, [sp, #56]
    ldr x12, [x11]
    add x11, x11, x12          // rest node
.Ltu_haveitem:
    str x11, [sp, #88]
    ldr x0, [sp, #64]
    bl _az_path_push_idx
    ldr x0, [sp, #88]
    // val = i < nin ? cur : undef (missing fixed item with rest)
    ldr x9, [sp, #64]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Ltu_undef
    ldr x1, [sp, #72]
    b .Ltu_havev
.Ltu_undef:
    AZ_ADR x1, .Lundef_val
.Ltu_havev:
    str x1, [sp, #200]         // actual value ptr (cur or .Lundef_val)
    bl _az_validate
    str x0, [sp, #96]
    stp x1, x2, [sp, #104]
    bl _az_path_pop
    ldr x0, [sp, #96]
    cbnz x0, .Ltu_bad
    ldp x2, x3, [sp, #104]
    mov x0, #0
    mov x1, #0
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret
    b .Ltu_next
.Ltu_bad:
    cmp x0, #-2
    b.ne .Lv_ret
    mov x9, #1
    str x9, [sp, #80]
    ldr x1, [sp, #200]
    mov x0, x1
    bl _az_vsize
    mov x3, x0
    ldr x2, [sp, #200]
    mov x0, #0
    mov x1, #0
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret
.Ltu_next:
    ldr x9, [sp, #64]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Ltu_noadv            // missing slot: input cursor exhausted
    ldr x0, [sp, #72]
    bl _az_vsize
    ldr x9, [sp, #72]
    add x9, x9, x0
    str x9, [sp, #72]
.Ltu_noadv:
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Ltu_loop
.Ltu_emit:
    ldr x9, [sp, #80]
    cbnz x9, .Ltu_fail_pop
    ldr x9, [sp, #168]
    cbnz x9, .Ltu_fail_pop      // length mismatch also fails
    // emit count = max(nin, optoutStart): absent optional-out tail truncates,
    // absent slots that produced real values (catch) are kept
    ldr x9, [sp, #40]
    ldr x12, [sp, #184]
    cmp x9, x12
    b.hs .Ltu_olen
    mov x9, x12
.Ltu_olen:
    str x9, [sp, #192]
    str x19, [sp, #120]        // emit start S
    mov w0, #7
    bl _az_vw1
    cbnz x0, .Lv_ret
    ldr x0, [sp, #192]
    bl _az_vw8
    cbnz x0, .Lv_ret
    str xzr, [sp, #64]
.Ltu_eloop:
    ldr x9, [sp, #64]
    ldr x10, [sp, #192]
    cmp x9, x10
    b.hs .Ltu_edone
    ldr x10, [sp, #160]        // pair buffer holds eff_n entries
    sub x11, x10, x9
    sub x11, x11, #1
    mov x12, #40
    mul x11, x11, x12
    add x11, x20, x11
    ldp x0, x1, [x11, #16]
    bl _az_vw
    cbnz x0, .Lv_ret
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Ltu_eloop
.Ltu_edone:
    ldr x9, [sp, #120]
    sub x2, x19, x9
    mov x1, x9
    mov x0, #0
    ldr x9, [sp, #160]
    mov x10, #40
    mul x9, x9, x10
    add x20, x20, x9
    b .Lv_ret
.Ltu_fail_pop:
    ldr x9, [sp, #64]          // pop only what was actually pushed
    mov x10, #40
    mul x9, x9, x10
    add x20, x20, x9
    mov x0, #-2
    b .Lv_ret
.Ltu_fail:
    mov x0, #-2
    b .Lv_ret

// ---------- 0x14 RECORD ----------
// [op][key i64][val i64]
.Lv_record:
    ldrb w9, [x28]
    cmp w9, #6
    b.eq .Lrc_tok
    AZ_ADR x0, .Lex_record
    mov x1, #6
    b _az_vtype
.Lrc_tok:
    ldr x9, [x28, #1]
    str x9, [sp, #40]          // n fields
    add x9, x28, #9
    str x9, [sp, #48]          // cur field
    str x20, [sp, #56]         // saved pair pos
    str xzr, [sp, #64]         // i
    str xzr, [sp, #72]         // failed
    // key node ptr (0 if none)
    mov x9, #0
    ldr x10, [x27, #1]
    cbz x10, .Lrc_nokey
    add x9, x27, #1
    add x9, x9, x10
.Lrc_nokey:
    str x9, [sp, #80]
    add x9, x27, #9
    ldr x10, [x9]
    add x9, x9, x10
    str x9, [sp, #88]          // val node
.Lrc_loop:
    ldr x9, [sp, #64]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lrc_emit
    ldr x11, [sp, #48]         // field ptr
    ldr x12, [x11]             // klen
    add x13, x11, #8           // kptr
    add x14, x13, x12          // vptr (tagged value)
    stp x12, x13, [sp, #96]    // klen,kptr
    str x14, [sp, #112]        // vptr
    // key validation (if keynode)
    ldr x9, [sp, #80]
    cbz x9, .Lrc_vval
    // materialize {tag4,len,key} into arena at x19
    add x0, x12, #9
    bl _az_val_reserve
    cmp x0, #-1
    b.eq .Lrc_oom
    mov x10, x0
    mov w9, #4
    strb w9, [x10]
    ldr x9, [sp, #96]
    str x9, [x10, #1]
    ldr x11, [sp, #104]
    add x10, x10, #9
    mov x12, x9
.Lrc_kc:
    cbz x12, .Lrc_kcd
    ldrb w9, [x11], #1
    strb w9, [x10], #1
    sub x12, x12, #1
    b .Lrc_kc
.Lrc_kcd:
    // keyval ptr = x0 (reserve ret); x1 = keyval, x0 = keynode
    ldr x9, [x22]              // issue_count before key run
    str x9, [sp, #136]
    mov x1, x0
    ldr x0, [sp, #80]
    bl _az_validate
    cmp x0, #0
    b.eq .Lrc_vval
    cmp x0, #-2
    b.ne .Lv_ret
    mov x9, #1
    str x9, [sp, #72]
    // wrap: invalid_key{origin:"record",_k:delta,path:[key]}
    ldr x0, [sp, #104]         // kptr
    ldr x1, [sp, #96]          // klen
    bl _az_path_push_key
    mov x0, #13
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Lv_ret
    AZ_ADR x0, .Lk_origin
    mov x1, #6
    AZ_ADR x2, .Lex_record
    mov x3, #6
    bl _az_issue_f_str
    cbnz x0, .Lv_ret
    ldr x9, [x22]
    ldr x10, [sp, #136]
    sub x10, x9, x10
    ucvtf d0, x10
    AZ_ADR x0, .Lk_k
    mov x1, #2
    bl _az_issue_f_f64
    cbnz x0, .Lv_ret
    bl _az_issue_commit
    bl _az_path_pop
    b .Lrc_next
.Lrc_vval:
    ldr x0, [sp, #104]         // kptr
    ldr x1, [sp, #96]          // klen
    bl _az_path_push_key
    ldr x0, [sp, #88]          // val node
    ldr x1, [sp, #112]
    bl _az_validate
    str x0, [sp, #128]
    bl _az_path_pop
    ldr x0, [sp, #128]
    cbnz x0, .Lrc_bad
    // push (kptr,klen,outptr,outlen) — validate out in x1,x2
    mov x3, x2                 // vlen
    mov x2, x1                 // vptr
    ldr x0, [sp, #104]         // kptr
    ldr x1, [sp, #96]          // klen
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret
    b .Lrc_next
.Lrc_bad:
    cmp x0, #-2
    b.ne .Lv_ret
    mov x9, #1
    str x9, [sp, #72]
    // still push input value to keep pair indexing aligned? record skips emit
    // on failure anyway — push input
    ldr x0, [sp, #112]
    bl _az_vsize
    mov x3, x0
    ldr x0, [sp, #104]
    ldr x1, [sp, #96]
    ldr x2, [sp, #112]
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret
.Lrc_next:
    // advance field ptr: past klen+key+value
    ldr x0, [sp, #112]         // vptr
    bl _az_vsize
    ldr x9, [sp, #112]
    add x9, x9, x0
    str x9, [sp, #48]
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Lrc_loop
.Lrc_oom:
    mov x0, #-3
    b .Lv_ret
.Lrc_emit:
    ldr x9, [sp, #72]
    cbnz x9, .Lrc_fail_pop
    str x19, [sp, #88]         // emit start S (val node slot, free now)
    mov w0, #6
    bl _az_vw1
    cbnz x0, .Lv_ret
    ldr x0, [sp, #40]
    bl _az_vw8
    cbnz x0, .Lv_ret
    str xzr, [sp, #64]
.Lrc_eloop:
    ldr x9, [sp, #64]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lrc_edone
    sub x11, x10, x9
    sub x11, x11, #1
    mov x12, #40
    mul x11, x11, x12
    add x11, x20, x11
    ldp x0, x1, [x11]          // kptr,klen
    str x11, [sp, #120]
    mov x0, x1                 // klen
    bl _az_vw8                 // write klen
    cbnz x0, .Lv_ret
    ldr x11, [sp, #120]
    ldp x0, x1, [x11]
    bl _az_vw                  // key bytes
    cbnz x0, .Lv_ret
    ldr x11, [sp, #120]
    ldp x0, x1, [x11, #16]
    bl _az_vw                  // value bytes
    cbnz x0, .Lv_ret
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Lrc_eloop
.Lrc_edone:
    ldr x9, [sp, #88]          // emit start S
    sub x2, x19, x9
    mov x1, x9
    mov x0, #0
    ldr x9, [sp, #40]
    mov x10, #40
    mul x9, x9, x10
    add x20, x20, x9
    b .Lv_ret
.Lrc_fail_pop:
    ldr x9, [sp, #40]
    mov x10, #40
    mul x9, x9, x10
    add x20, x20, x9
    mov x0, #-2
    b .Lv_ret

// ---------- 0x24 MAP ----------
// [op][koff i64 @+1][voff i64 @+9] — input tag9: u64 n | [kTagged,vTagged]*n
// issues at path [key]; output = tag9 of validated pairs
// slots: 40 n 48 cur 56 savedpr 64 i 72 failed 80 knode 88 vnode
//        96 kptr 104 vptr 112 kst 120 kout 128 vst 136 vout
.Lv_map:
    ldrb w9, [x28]
    cmp w9, #9
    b.eq .Lmp_tok
    AZ_ADR x0, .Lex_map
    mov x1, #3
    b _az_vtype
.Lmp_tok:
    ldr x9, [x28, #1]
    str x9, [sp, #40]          // n
    add x9, x28, #9
    str x9, [sp, #48]          // cur pair ptr
    str x20, [sp, #56]         // saved pair pos
    str xzr, [sp, #64]         // i
    str xzr, [sp, #72]         // failed
    add x9, x27, #1
    ldr x10, [x9]
    add x9, x9, x10
    str x9, [sp, #80]          // key node
    add x9, x27, #9
    ldr x10, [x9]
    add x9, x9, x10
    str x9, [sp, #88]          // val node
.Lmp_loop:
    ldr x9, [sp, #64]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lmp_emit
    ldr x11, [sp, #48]
    str x11, [sp, #96]         // kptr
    mov x0, x11
    bl _az_vsize
    ldr x9, [sp, #96]
    add x9, x9, x0
    str x9, [sp, #104]         // vptr
    // path = key: str -> bytes, int-ish -> idx, else idx i
    ldr x9, [sp, #96]
    ldrb w10, [x9]
    cmp w10, #4
    b.ne .Lmp_knum
    add x0, x9, #9
    ldr x1, [x9, #1]
    bl _az_path_push_key
    b .Lmp_pk
.Lmp_knum:
    cmp w10, #3
    b.ne .Lmp_kother
    ldr d0, [x9, #1]
    fcvtzs x0, d0
    b .Lmp_ki
.Lmp_kother:
    cmp w10, #5
    b.ne .Lmp_kidx
    ldr x0, [x9, #1]
    b .Lmp_ki
.Lmp_kidx:
    ldr x0, [sp, #64]
.Lmp_ki:
    bl _az_path_push_idx
.Lmp_pk:
    ldr x0, [sp, #80]
    ldr x1, [sp, #96]
    bl _az_validate
    str x0, [sp, #112]
    stp x1, x2, [sp, #120]     // kout
    ldr x0, [sp, #88]
    ldr x1, [sp, #104]
    bl _az_validate
    str x0, [sp, #152]
    stp x1, x2, [sp, #136]     // vout
    bl _az_path_pop
    ldr x0, [sp, #112]
    ldr x9, [sp, #152]
    mov x10, #-2
    cmp x0, x10
    b.eq .Lmp_vchk
    cbnz x0, .Lv_ret           // hard error
.Lmp_vchk:
    cmp x9, x10
    b.eq .Lmp_soft
    cbnz x9, .Lv_ret
    orr x10, x0, x9
    cbnz x10, .Lmp_soft
    // both ok — stage (kout,vout)
    ldp x0, x1, [sp, #120]
    ldp x2, x3, [sp, #136]
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret
    b .Lmp_next
.Lmp_soft:
    mov x9, #1
    str x9, [sp, #72]
.Lmp_next:
    ldr x0, [sp, #104]
    bl _az_vsize
    ldr x9, [sp, #104]
    add x9, x9, x0
    str x9, [sp, #48]
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Lmp_loop
.Lmp_emit:
    ldr x9, [sp, #72]
    cbnz x9, .Lmp_fail_pop
    str x19, [sp, #88]         // emit start S
    mov w0, #9
    bl _az_vw1
    cbnz x0, .Lv_ret
    ldr x0, [sp, #40]
    bl _az_vw8
    cbnz x0, .Lv_ret
    str xzr, [sp, #64]
.Lmp_eloop:
    ldr x9, [sp, #64]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lmp_edone
    sub x11, x10, x9
    sub x11, x11, #1
    mov x12, #40
    mul x11, x11, x12
    add x11, x20, x11
    str x11, [sp, #120]
    ldp x0, x1, [x11]
    bl _az_vw                  // key tagged bytes
    cbnz x0, .Lv_ret
    ldr x11, [sp, #120]
    ldp x0, x1, [x11, #16]
    bl _az_vw                  // val tagged bytes
    cbnz x0, .Lv_ret
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Lmp_eloop
.Lmp_edone:
    ldr x9, [sp, #88]
    sub x2, x19, x9
    mov x1, x9
    mov x0, #0
    ldr x9, [sp, #40]
    mov x10, #40
    mul x9, x9, x10
    add x20, x20, x9           // consume staged pairs
    b .Lv_ret
.Lmp_fail_pop:
    ldr x20, [sp, #56]         // drop everything this map staged
    mov x0, #-2
    b .Lv_ret

// ---------- 0x25 SET ----------
// [op][voff i64 @+1] — input tag10: u64 n | [vTagged]*n
// element issues at path [] (no path push, matches zod)
// slots: 40 n 48 cur 56 savedpr 64 i 72 failed 88 vnode 104 vptr 136 vout
.Lv_set:
    ldrb w9, [x28]
    cmp w9, #10
    b.eq .Lst_tok
    AZ_ADR x0, .Lex_set
    mov x1, #3
    b _az_vtype
.Lst_tok:
    ldr x9, [x28, #1]
    str x9, [sp, #40]
    add x9, x28, #9
    str x9, [sp, #48]
    str x20, [sp, #56]
    str xzr, [sp, #64]
    str xzr, [sp, #72]
    add x9, x27, #1
    ldr x10, [x9]
    add x9, x9, x10
    str x9, [sp, #88]          // val node
.Lst_loop:
    ldr x9, [sp, #64]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lst_emit
    ldr x9, [sp, #48]
    str x9, [sp, #104]         // vptr
    ldr x0, [sp, #88]
    mov x1, x9
    bl _az_validate
    str x0, [sp, #128]
    stp x1, x2, [sp, #136]     // vout
    ldr x0, [sp, #128]
    cmp x0, #-2
    b.eq .Lst_soft
    cbnz x0, .Lv_ret
    mov x0, #0
    mov x1, #0
    ldp x2, x3, [sp, #136]
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret
    b .Lst_next
.Lst_soft:
    mov x9, #1
    str x9, [sp, #72]
.Lst_next:
    ldr x0, [sp, #104]
    bl _az_vsize
    ldr x9, [sp, #104]
    add x9, x9, x0
    str x9, [sp, #48]
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Lst_loop
.Lst_emit:
    ldr x9, [sp, #72]
    cbnz x9, .Lst_fail_pop
    str x19, [sp, #88]
    mov w0, #10
    bl _az_vw1
    cbnz x0, .Lv_ret
    ldr x0, [sp, #40]
    bl _az_vw8
    cbnz x0, .Lv_ret
    str xzr, [sp, #64]
.Lst_eloop:
    ldr x9, [sp, #64]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lst_edone
    sub x11, x10, x9
    sub x11, x11, #1
    mov x12, #40
    mul x11, x11, x12
    add x11, x20, x11
    ldp x0, x1, [x11, #16]     // vptr,vlen half
    bl _az_vw
    cbnz x0, .Lv_ret
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Lst_eloop
.Lst_edone:
    ldr x9, [sp, #88]
    sub x2, x19, x9
    mov x1, x9
    mov x0, #0
    ldr x9, [sp, #40]
    mov x10, #40
    mul x9, x9, x10
    add x20, x20, x9
    b .Lv_ret
.Lst_fail_pop:
    ldr x20, [sp, #56]
    mov x0, #-2
    b .Lv_ret

// ---------- 0x05 OBJECT ----------
// [op][mode u8][catchall i64 @+2][nfields u64 @+10][fields @+18]
// field: u64 namelen + name + i64 off. pair40: {kptr,klen,vptr,vlen,flags}
// slots: 32 savedpr 40 nf 48 mode 56 fail 64 fcur 72 i 80 canode
//        88 namelen 96 name 104 unk 112 child 120 fval 128 icur 136 icnt
//        144 S/stat 152 ecnt/outp 160 outl 168 sc; msg buf sp+256 (256B)
.Lv_object:
    ldrb w9, [x28]
    cmp w9, #6
    b.eq .Lob_tok
    cmp w9, #8
    b.eq .Lob_hr
    cmp w9, #9
    b.eq .Lob_empty            // map — object-like, no own keys
    cmp w9, #10
    b.eq .Lob_empty            // set — same
    b .Lob_tfail
.Lob_hr:
    // hostref: zod treats Date/Map/Set/class instances as {} —
    // but functions and symbols are not objects
    ldr x9, [x24, #24]
    mov x0, #6                 // host type name idx
    ldr x1, [x28, #1]
    mov x2, #0
    mov x3, #0
    blr x9
    cbz x0, .Lob_tfail         // symbol
    cmp x0, #4
    b.eq .Lob_tfail            // function
.Lob_empty:
    // materialize empty object in arena, validate normally
    mov x0, #9
    bl _az_val_reserve
    cmp x0, #-1
    b.eq .Lob_oom
    mov w9, #6
    strb w9, [x0]
    str xzr, [x0, #1]
    mov x28, x0
    b .Lob_tok
.Lob_tfail:
    AZ_ADR x0, .Lex_object
    mov x1, #6
    b _az_vtype
.Lob_oom:
    mov x0, #-3
    b .Lv_ret
.Lob_tok:
    ldr x9, [x27, #10]
    str x9, [sp, #40]
    ldrb w9, [x27, #1]
    str x9, [sp, #48]
    add x9, x27, #2
    ldr x10, [x9]
    cbz x10, .Lob_nca
    add x9, x9, x10
    b .Lob_sc
.Lob_nca:
    mov x9, #0
.Lob_sc:
    str x9, [sp, #80]
    str x20, [sp, #32]
    str xzr, [sp, #56]
    str xzr, [sp, #72]
    add x9, x27, #18
    str x9, [sp, #64]
// pass1: schema fields
.Lob_fl:
    ldr x9, [sp, #72]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lob_fd
    ldr x11, [sp, #64]
    ldrb w16, [x11]             // optin flag (0=absent->nonoptional issue)
    str x16, [sp, #176]
    ldr x12, [x11, #1]          // namelen
    add x13, x11, #9            // name
    // a declared "__proto__" field is never validated or written — zod
    // strips it everywhere; it only counts as a known key in pass-2
    cmp x12, #9
    b.ne .Lob_nproto
    ldr x14, [x13]
    AZ_ADR x15, .Lproto__
    ldr x15, [x15]
    cmp x14, x15
    b.ne .Lob_nproto
    ldrb w14, [x13, #8]
    cmp w14, #0x5F              // '_'
    b.eq .Lob_fnext
.Lob_nproto:
    add x14, x13, x12           // off addr
    stp x12, x13, [sp, #88]     // 88=len 96=ptr? store len@88 ptr@96
    add x15, x14, #8
    str x15, [sp, #64]          // next field
    ldr x15, [x14]
    add x15, x14, x15
    str x15, [sp, #112]         // child node
    // scan input for key
    ldr x9, [x28, #1]
    str x9, [sp, #136]
    add x9, x28, #9
    str x9, [sp, #128]
    str xzr, [sp, #120]         // fval=0
.Lob_scan:
    ldr x9, [sp, #136]
    cbz x9, .Lob_sd
    ldr x10, [sp, #128]         // icur
    ldr x11, [x10]              // klen
    add x12, x10, #8            // kptr
    add x13, x12, x11           // vptr
    ldr x14, [sp, #88]          // namelen
    cmp x11, x14
    b.ne .Lob_sn
    // inline key compare: name(#96) vs key(x12), len x11
    ldr x14, [sp, #96]
    mov x15, #0
.Lob_kc:
    cmp x15, x11
    b.hs .Lob_match
    ldrb w16, [x14, x15]
    ldrb w17, [x12, x15]
    cmp w16, w17
    b.ne .Lob_sn
    add x15, x15, #1
    b .Lob_kc
.Lob_match:
    str x13, [sp, #120]         // fval = vptr
    b .Lob_sd
.Lob_sn:
    // advance icur past vptr + vsize(vptr)
    str x13, [sp, #168]
    mov x0, x13
    bl _az_vsize
    ldr x13, [sp, #168]
    add x13, x13, x0
    str x13, [sp, #128]
    ldr x9, [sp, #136]
    sub x9, x9, #1
    str x9, [sp, #136]
    b .Lob_scan
.Lob_sd:
    // val = fval or undef; absent + exactOptional -> skip field
    ldr x1, [sp, #120]
    cbnz x1, .Lob_gv
    ldr x9, [sp, #176]
    cmp x9, #2
    b.eq .Lob_fnext
    AZ_ADR x1, .Lundef_val
.Lob_gv:
    str x1, [sp, #144]          // val to validate
    ldr x0, [sp, #96]           // keyptr
    ldr x1, [sp, #88]           // keylen
    bl _az_path_push_key
    // snapshot the issue region — an absent omittable field's failure gets
    // swallowed whole (issues rolled back, value dropped), like zod
    str x21, [sp, #208]
    ldr x9, [x22]
    str x9, [sp, #216]
    ldr x0, [sp, #112]
    ldr x1, [sp, #144]
    bl _az_validate
    str x0, [sp, #144]
    stp x1, x2, [sp, #152]
    bl _az_path_pop
    ldr x0, [sp, #144]
    cbnz x0, .Lob_fbad
    // absent + required but inner accepted undefined -> nonoptional issue
    ldr x9, [sp, #120]
    cbnz x9, .Lob_gpush
    ldr x9, [sp, #176]
    cbnz x9, .Lob_gpush
    ldr x0, [sp, #96]
    ldr x1, [sp, #88]
    bl _az_path_push_key
    AZ_ADR x0, .Lex_nonopt
    mov x1, #11
    mov x2, #0                  // undef tag -> received "undefined"
    AZ_ADR x3, .Lundef_val
    bl _az_issue_type
    str x0, [sp, #144]
    bl _az_path_pop
    ldr x0, [sp, #144]
    cbnz x0, .Lv_ret
    mov x0, #-2
    b .Lob_fbad
.Lob_gpush:
    // push pair(name,namelen,out,len,found)
    ldp x2, x3, [sp, #152]
    ldr x0, [sp, #96]
    ldr x1, [sp, #88]
    ldr x4, [sp, #120]
    cbz x4, .Lob_nf
    mov x4, #1
.Lob_nf:
    bl _az_pair_push40
    cbnz x0, .Lv_ret
    b .Lob_fnext
.Lob_fbad:
    cmp x0, #-2
    b.ne .Lv_ret
    // absent + optin flag -> best-effort run: swallow issues + drop the field
    ldr x9, [sp, #120]
    cbnz x9, .Lob_fmark
    ldr x9, [sp, #176]
    cbz x9, .Lob_fmark
    ldr x21, [sp, #208]        // restore issue cursor
    ldr x9, [sp, #216]
    str x9, [x22]              // restore issue count
    b .Lob_fnext
.Lob_fmark:
    mov x9, #1
    str x9, [sp, #56]
    ldp x2, x3, [sp, #152]
    ldr x0, [sp, #96]
    ldr x1, [sp, #88]
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret
.Lob_fnext:
    ldr x9, [sp, #72]
    add x9, x9, #1
    str x9, [sp, #72]
    b .Lob_fl
.Lob_fd:
// pass2: unknown keys (mode!=0 or catchall)
    str xzr, [sp, #104]
    ldr x9, [sp, #48]
    cbnz x9, .Lob_u2
    ldr x9, [sp, #80]
    cbz x9, .Lob_udone
.Lob_u2:
    ldr x9, [x28, #1]
    str x9, [sp, #136]
    add x9, x28, #9
    str x9, [sp, #128]
.Lob_ul:
    ldr x9, [sp, #136]
    cbz x9, .Lob_udone
    ldr x10, [sp, #128]
    ldr x11, [x10]              // klen
    add x12, x10, #8            // kptr
    add x13, x12, x11           // vptr
    stp x11, x12, [sp, #168]    // klen@168 kptr@176
    str x13, [sp, #184]
    // is key a schema name? walk field seq
    add x14, x27, #18
    ldr x15, [sp, #40]
    mov x16, #0                 // known=0
.Lob_kn:
    cbz x15, .Lob_unk2
    ldr x9, [x14, #1]           // slen (after optin byte)
    cmp x9, x11
    b.ne .Lob_knn
    add x9, x14, #9             // sname
    mov x17, #0
.Lob_kcmp:
    cmp x17, x11
    b.hs .Lob_known
    ldrb w0, [x9, x17]
    ldrb w1, [x12, x17]
    cmp w0, w1
    b.ne .Lob_knn
    add x17, x17, #1
    b .Lob_kcmp
.Lob_knn:
    // advance: cur = cur+1+8+slen+8
    ldr x9, [x14, #1]
    add x14, x14, x9
    add x14, x14, #17
    sub x15, x15, #1
    b .Lob_kn
.Lob_known:
    b .Lob_unext
.Lob_unk2:
    // unknown key — "__proto__" is dropped in loose/passthrough/catchall
    // but still reported by strict as unrecognized
    ldr x9, [sp, #48]
    cmp x9, #1
    b.eq .Lob_unk2c
    ldp x9, x10, [sp, #168]    // klen, kptr
    cmp x9, #9
    b.ne .Lob_unk2c
    ldr x9, [x10]
    AZ_ADR x11, .Lproto__
    ldr x11, [x11]
    cmp x9, x11
    b.ne .Lob_unk2c
    ldrb w9, [x10, #8]
    cmp w9, #0x5F
    b.eq .Lob_unext            // drop it
.Lob_unk2c:
    ldr x9, [sp, #104]
    add x9, x9, #1
    str x9, [sp, #104]
    ldr x9, [sp, #48]
    cmp x9, #1
    b.eq .Lob_upush            // strict: collect for keys list
    ldr x9, [sp, #80]
    cbz x9, .Lob_upush          // passthrough: collect verbatim
    // catchall: validate value against catchall node
    ldr x0, [sp, #176]         // kptr
    ldr x1, [sp, #168]         // klen
    bl _az_path_push_key
    ldr x0, [sp, #80]
    ldr x1, [sp, #184]
    bl _az_validate
    stp x1, x2, [sp, #144]     // outptr@144 outlen@152
    str x0, [sp, #160]         // status
    bl _az_path_pop
    ldr x0, [sp, #160]
    cbnz x0, .Lob_ubad
    ldp x2, x3, [sp, #144]     // out ptr,len -> x2,x3
    b .Lob_up2
.Lob_ubad:
    cmp x0, #-2
    b.ne .Lv_ret
    mov x9, #1
    str x9, [sp, #56]
    ldr x0, [sp, #184]
    bl _az_vsize
    mov x3, x0
    ldr x2, [sp, #184]
    b .Lob_up2
.Lob_upush:
    ldr x0, [sp, #184]
    bl _az_vsize
    mov x3, x0
    ldr x2, [sp, #184]
.Lob_up2:
    ldr x0, [sp, #176]         // kptr
    ldr x1, [sp, #168]         // klen
    mov x4, #0
    bl _az_pair_push40
    cbnz x0, .Lv_ret
.Lob_unext:
    // advance input field
    ldr x0, [sp, #184]
    bl _az_vsize
    ldr x9, [sp, #184]
    add x9, x9, x0
    str x9, [sp, #128]
    ldr x9, [sp, #136]
    sub x9, x9, #1
    str x9, [sp, #136]
    b .Lob_ul
.Lob_udone:
    // strict + unk>0 -> unrecognized_keys
    ldr x9, [sp, #48]
    cmp x9, #1
    b.ne .Lob_emit
    ldr x9, [sp, #104]
    cbz x9, .Lob_emit
    // msg: "Unrecognized key(s) in object: 'a', 'b'"
    add x10, sp, #256
    AZ_ADR x11, .Lm_unk
    mov x12, #31
.Lob_m1:
    ldrb w13, [x11], #1
    strb w13, [x10], #1
    subs x12, x12, #1
    b.ne .Lob_m1
    // join keys: u_k at x20+(unk-1-k)*40
    ldr x14, [sp, #104]
    mov x15, #0
.Lob_mj:
    cbz x14, .Lob_md
    cbz x15, .Lob_mj1
    mov w13, #','
    strb w13, [x10], #1
    mov w13, #' '
    strb w13, [x10], #1
.Lob_mj1:
    mov w13, #'\''
    strb w13, [x10], #1
    // u_k addr
    ldr x9, [sp, #104]
    sub x9, x9, x15
    sub x9, x9, #1
    mov x13, #40
    mul x9, x9, x13
    add x9, x20, x9
    ldp x16, x17, [x9]         // kptr,klen
.Lob_mk:
    cbz x17, .Lob_mk2
    ldrb w13, [x16], #1
    strb w13, [x10], #1
    sub x17, x17, #1
    b .Lob_mk
.Lob_mk2:
    mov w13, #'\''
    strb w13, [x10], #1
    add x15, x15, #1
    sub x14, x14, #1
    b .Lob_mj
.Lob_md:
    mov x0, #5                 // unrecognized_keys — msg from TS normalizer
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Lv_ret
    // keys field: strarr2(base=u0=x20+(unk-1)*40, stride=-40, count=unk)
    AZ_ADR x0, .Lk_keys
    mov x1, #4
    ldr x9, [sp, #104]
    sub x9, x9, #1
    mov x13, #40
    mul x9, x9, x13
    add x2, x20, x9
    mov x3, #-40
    ldr x4, [sp, #104]
    bl _az_issue_f_strarr2
    cbnz x0, .Lv_ret
    bl _az_issue_commit
    mov x9, #1
    str x9, [sp, #56]
.Lob_emit:
    ldr x9, [sp, #56]
    cbz x9, .Lob_e0
    ldr x20, [sp, #32]
    b .Lv_invalid
.Lob_e0:
    str x19, [sp, #144]        // S
    // emitcount over fields
    str xzr, [sp, #152]
    str xzr, [sp, #72]
.Lob_c1:
    ldr x9, [sp, #72]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lob_c1d
    // f_j = saved_pairs - (j+1)*40
    add x11, x9, #1
    mov x12, #40
    mul x11, x11, x12
    ldr x13, [sp, #32]
    sub x11, x13, x11
    ldr x14, [x11, #16]        // vptr
    ldrb w15, [x14]
    cbnz w15, .Lob_cinc
    ldr x14, [x11, #32]        // flags
    cbnz x14, .Lob_cinc
    b .Lob_cnext
.Lob_cinc:
    ldr x14, [sp, #152]
    add x14, x14, #1
    str x14, [sp, #152]
.Lob_cnext:
    ldr x9, [sp, #72]
    add x9, x9, #1
    str x9, [sp, #72]
    b .Lob_c1
.Lob_c1d:
    // extra = (mode==0 && no catchall) ? 0 : unk
    ldr x9, [sp, #48]
    cbnz x9, .Lob_xall
    ldr x9, [sp, #80]
    cbz x9, .Lob_xnone
.Lob_xall:
    ldr x9, [sp, #104]
    b .Lob_xadd
.Lob_xnone:
    mov x9, #0
.Lob_xadd:
    ldr x10, [sp, #152]
    add x10, x10, x9
    str x10, [sp, #152]
    mov w0, #6
    bl _az_vw1
    cbnz x0, .Lv_ret
    ldr x0, [sp, #152]
    bl _az_vw8
    cbnz x0, .Lv_ret
    // emit fields
    str xzr, [sp, #72]
.Lob_e1:
    ldr x9, [sp, #72]
    ldr x10, [sp, #40]
    cmp x9, x10
    b.hs .Lob_e1d
    add x11, x9, #1
    mov x12, #40
    mul x11, x11, x12
    ldr x13, [sp, #32]
    sub x11, x13, x11
    str x11, [sp, #168]
    ldr x14, [x11, #16]
    ldrb w15, [x14]
    cbnz w15, .Lob_ew
    ldr x14, [x11, #32]
    cbz x14, .Lob_eskip
.Lob_ew:
    ldr x0, [x11, #8]          // klen
    bl _az_vw8
    cbnz x0, .Lv_ret
    ldr x11, [sp, #168]
    ldp x0, x1, [x11]
    bl _az_vw
    cbnz x0, .Lv_ret
    ldr x11, [sp, #168]
    ldp x0, x1, [x11, #16]
    bl _az_vw
    cbnz x0, .Lv_ret
.Lob_eskip:
    ldr x9, [sp, #72]
    add x9, x9, #1
    str x9, [sp, #72]
    b .Lob_e1
.Lob_e1d:
    // emit unknowns (input order)
    str xzr, [sp, #72]
.Lob_e2:
    ldr x9, [sp, #72]
    ldr x10, [sp, #104]
    cmp x9, x10
    b.hs .Lob_e2d
    sub x11, x10, x9
    sub x11, x11, #1
    mov x12, #40
    mul x11, x11, x12
    add x11, x20, x11
    str x11, [sp, #168]
    ldr x0, [x11, #8]
    bl _az_vw8
    cbnz x0, .Lv_ret
    ldr x11, [sp, #168]
    ldp x0, x1, [x11]
    bl _az_vw
    cbnz x0, .Lv_ret
    ldr x11, [sp, #168]
    ldp x0, x1, [x11, #16]
    bl _az_vw
    cbnz x0, .Lv_ret
    ldr x9, [sp, #72]
    add x9, x9, #1
    str x9, [sp, #72]
    b .Lob_e2
.Lob_e2d:
    ldr x20, [sp, #32]
    ldr x9, [sp, #144]
    sub x2, x19, x9
    mov x1, x9
    mov x0, #0
    b .Lv_ret

// ---------- 0x12 INTERSECT ----------
// [op][L i64 @+1][R i64 @+9]
// slots: 32 statL 40 outLp 48 outLl 56 statR 64 outRp 72 outRl 80 S
.Lv_intersect:
    add x9, x27, #1
    ldr x10, [x9]
    add x0, x9, x10
    mov x1, x28
    bl _az_validate
    str x0, [sp, #32]
    stp x1, x2, [sp, #40]
    add x9, x27, #9
    ldr x10, [x9]
    add x0, x9, x10
    mov x1, x28
    bl _az_validate
    str x0, [sp, #56]
    stp x1, x2, [sp, #64]
    // propagate hard errors
    ldr x9, [sp, #32]
    cmp x9, #-3
    b.eq .Lv_ret
    cmp x9, #-4
    b.eq .Lv_ret
    cmp x9, #-5
    b.eq .Lv_ret
    cmp x9, #-1
    b.eq .Lv_ret
    ldr x10, [sp, #56]
    cmp x10, #-3
    b.eq .Lv_ret
    cmp x10, #-4
    b.eq .Lv_ret
    cmp x10, #-5
    b.eq .Lv_ret
    cmp x10, #-1
    b.eq .Lv_ret
    cbnz x9, .Lv_invalid       // L failed
    cbnz x10, .Lv_invalid      // R failed
    // both ok: both objects?
    ldr x11, [sp, #40]
    ldr x12, [sp, #64]
    ldrb w13, [x11]
    ldrb w14, [x12]
    cmp w13, #6
    b.ne .Lin_scalar
    cmp w14, #6
    b.ne .Lin_scalar
    // merge objects: emit L fields not in R + all R fields
    str x19, [sp, #80]         // S
    // count = Lf + Rf - dups; dups counted by scanning
    ldr x15, [x11, #1]         // Lf
    mov x17, #0                // dups
    str x15, [sp, #88]         // L remaining
    add x13, x11, #9
    str x13, [sp, #96]         // L cur
.Lin_dl:
    ldr x15, [sp, #88]
    cbz x15, .Lin_dd
    sub x15, x15, #1
    str x15, [sp, #88]
    ldr x13, [sp, #96]
    ldr x9, [x13]              // Lklen
    add x10, x13, #8           // Lkptr
    add x11, x10, x9           // Lvptr
    stp x9, x10, [sp, #104]    // 104=Lklen 112=Lkptr
    str x11, [sp, #120]        // 120=Lvptr
    ldr x12, [sp, #64]         // R base (reload each iter)
    ldr x14, [x12, #1]
    str x14, [sp, #128]        // R remaining
    add x16, x12, #9
    str x16, [sp, #136]        // R cur
.Lin_dscan:
    ldr x14, [sp, #128]
    cbz x14, .Lin_dnext
    sub x14, x14, #1
    str x14, [sp, #128]
    ldr x16, [sp, #136]
    ldr x9, [x16]              // Rklen
    add x10, x16, #8           // Rkptr
    add x11, x10, x9           // Rvptr
    stp x10, x11, [sp, #144]   // 144=Rkptr 152=Rvptr
    ldr x0, [sp, #104]         // Lklen
    cmp x9, x0
    b.ne .Lin_dadv
    ldr x0, [sp, #112]         // Lkptr
    mov x1, x10                // Rkptr
    mov x2, x9                 // len
    bl _az_memeq
    cbz w0, .Lin_dadv
    add x17, x17, #1           // dup found
    b .Lin_dnext
.Lin_dadv:
    ldr x0, [sp, #152]         // Rvptr
    bl _az_vsize
    ldr x16, [sp, #152]
    add x16, x16, x0
    str x16, [sp, #136]
    b .Lin_dscan
.Lin_dnext:
    // advance L cur past its value
    ldr x0, [sp, #120]
    bl _az_vsize
    ldr x13, [sp, #120]
    add x13, x13, x0
    str x13, [sp, #96]
    b .Lin_dl
.Lin_dd:
    // emitcount = Lf + Rf - dups
    ldr x11, [sp, #40]
    ldr x12, [sp, #64]
    ldr x15, [x11, #1]
    ldr x16, [x12, #1]
    add x15, x15, x16
    sub x15, x15, x17
    str x15, [sp, #88]
    mov w0, #6
    bl _az_vw1
    cbnz x0, .Lv_ret
    ldr x0, [sp, #88]
    bl _az_vw8
    cbnz x0, .Lv_ret
    // emit L fields whose key NOT in R
    ldr x11, [sp, #40]
    ldr x12, [sp, #64]
    ldr x15, [x11, #1]
    str x15, [sp, #96]         // remaining L
    add x13, x11, #9
    str x13, [sp, #104]        // L cur
.Lin_el:
    ldr x15, [sp, #96]
    cbz x15, .Lin_er
    sub x15, x15, #1
    str x15, [sp, #96]
    ldr x13, [sp, #104]
    ldr x9, [x13]              // klen
    add x10, x13, #8           // kptr
    add x11, x10, x9           // vptr
    stp x9, x10, [sp, #112]
    str x11, [sp, #128]
    // in R?
    ldr x14, [x12, #1]
    add x16, x12, #9
    mov x17, #0                // found
.Lin_es:
    cbz x14, .Lin_esd
    ldr x0, [x16]
    cmp x0, x9
    b.ne .Lin_esn
    add x1, x16, #8
    mov x0, x10
    mov x2, x9
    stp x14, x16, [sp, #136]
    str x17, [sp, #152]
    bl _az_memeq
    cbnz w0, .Lin_efound
    ldp x14, x16, [sp, #136]
    ldr x17, [sp, #152]
    ldr x0, [x16]
.Lin_esn:
    ldr x0, [x16]
    add x16, x16, x0
    add x16, x16, #8
    stp x14, x16, [sp, #136]
    mov x0, x16
    bl _az_vsize
    ldp x14, x16, [sp, #136]
    add x16, x16, x0
    sub x14, x14, #1
    b .Lin_es
.Lin_efound:
    ldp x14, x16, [sp, #136]
    mov x17, #1
.Lin_esd:
    cbz x17, .Lin_ew
    b .Lin_enext               // dup: R wins, skip L field
.Lin_ew:
    ldp x9, x10, [sp, #112]
    mov x0, x9
    bl _az_vw8
    cbnz x0, .Lv_ret
    ldp x9, x10, [sp, #112]
    mov x0, x10
    mov x1, x9
    bl _az_vw
    cbnz x0, .Lv_ret
    ldr x11, [sp, #128]
    mov x0, x11
    bl _az_vsize
    mov x1, x0
    ldr x0, [sp, #128]
    bl _az_vw
    cbnz x0, .Lv_ret
.Lin_enext:
    ldr x11, [sp, #128]
    mov x0, x11
    bl _az_vsize
    ldr x9, [sp, #128]
    add x9, x9, x0
    str x9, [sp, #104]
    b .Lin_el
.Lin_er:
    // emit all R fields
    ldr x12, [sp, #64]
    ldr x15, [x12, #1]
    str x15, [sp, #96]
    add x13, x12, #9
    str x13, [sp, #104]
.Lin_rl:
    ldr x15, [sp, #96]
    cbz x15, .Lin_done
    sub x15, x15, #1
    str x15, [sp, #96]
    ldr x13, [sp, #104]
    ldr x9, [x13]
    add x10, x13, #8
    add x11, x10, x9
    stp x9, x10, [sp, #112]
    str x11, [sp, #128]
    mov x0, x9
    bl _az_vw8
    cbnz x0, .Lv_ret
    ldp x9, x10, [sp, #112]
    mov x0, x10
    mov x1, x9
    bl _az_vw
    cbnz x0, .Lv_ret
    ldr x11, [sp, #128]
    mov x0, x11
    bl _az_vsize
    mov x1, x0
    ldr x0, [sp, #128]
    bl _az_vw
    cbnz x0, .Lv_ret
    ldr x11, [sp, #128]
    mov x0, x11
    bl _az_vsize
    ldr x9, [sp, #128]
    add x9, x9, x0
    str x9, [sp, #104]
    b .Lin_rl
.Lin_done:
    ldr x9, [sp, #80]
    sub x2, x19, x9
    mov x1, x9
    mov x0, #0
    b .Lv_ret
.Lin_scalar:
    // both ok non-object: byte-compare outputs
    ldr x11, [sp, #40]
    ldr x12, [sp, #64]
    ldr x13, [sp, #48]         // Llen
    ldr x14, [sp, #72]         // Rlen
    cmp x13, x14
    b.ne .Lin_isfail
    mov x0, x11
    mov x1, x12
    mov x2, x13
    bl _az_memeq
    cbz w0, .Lin_isfail
    ldp x1, x2, [sp, #40]
    mov x0, #0
    b .Lv_ret
.Lin_isfail:
    mov x0, #10                // invalid_intersection_results
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Lv_ret
    bl _az_issue_commit
    b .Lv_invalid

// ---------- 0x20 DATE ----------
// [op][nchecks u8][checks: u8 code + u64 msglen + msg + f64 bound]
.Lv_date:
    ldrb w9, [x28]
    cmp w9, #8
    b.ne .Ldt_fail
    ldr x9, [x24, #24]
    mov x0, #2                 // kind2 hostref-kind
    mov x1, #2                 // date
    ldr x2, [x28, #1]
    mov x3, #0
    blr x9
    cmp x0, #0
    b.eq .Ldt_fail
    // getTime
    ldr x9, [x24, #24]
    mov x0, #3
    ldr x1, [x28, #1]
    mov x2, #0
    mov x3, #0
    blr x9
    fmov d0, x0                // t bits
    fcmp d0, d0
    b.vs .Ldt_nanfail          // NaN time = Invalid Date
    str d0, [sp, #32]
    // checks
    ldrb w9, [x27, #1]
    cbz w9, .Ldt_ok
    mov x10, x9
    add x11, x27, #2
    str x11, [sp, #40]
    str x10, [sp, #48]
.Ldt_cl:
    ldr x10, [sp, #48]
    cbz x10, .Ldt_ok
    ldr x11, [sp, #40]
    ldrb w9, [x11]             // code
    ldr x12, [x11, #1]         // msglen
    add x13, x11, #9
    add x14, x13, x12          // params (f64)
    stp x13, x12, [sp, #56]
    str x14, [sp, #72]
    ldr d0, [sp, #32]
    ldr d1, [x14]
    cmp w9, #1
    b.eq .Ldt_min
    cmp w9, #2
    b.eq .Ldt_max
    b .Ldt_cnext
.Ldt_min:
    fcmp d0, d1
    b.ge .Ldt_cnext
    // too_small type date, bound d1, incl=1
    fmov x9, d1
    str x9, [sp, #80]
    ldp x6, x7, [sp, #56]
    b .Ldt_mh
.Ldt_mh:
    mov x0, #8
    AZ_ADR x1, .Lty_date
    mov x2, #4
    ldr x3, [sp, #80]
    mov w4, #1
    mov w5, #0
    bl _az_issue_size
    cbnz x0, .Lv_ret
    b .Lv_invalid
.Ldt_max:
    fcmp d0, d1
    b.le .Ldt_cnext
    fmov x9, d1
    str x9, [sp, #80]
    ldp x6, x7, [sp, #56]
    b .Ldt_xh
.Ldt_xh:
    mov x0, #9
    AZ_ADR x1, .Lty_date
    mov x2, #4
    ldr x3, [sp, #80]
    mov w4, #1
    mov w5, #0
    bl _az_issue_size
    cbnz x0, .Lv_ret
    b .Lv_invalid
.Ldt_cnext:
    ldr x14, [sp, #72]
    add x11, x14, #8
    str x11, [sp, #40]
    ldr x10, [sp, #48]
    sub x10, x10, #1
    str x10, [sp, #48]
    b .Ldt_cl
.Ldt_ok:
    mov x9, #9
    b .Lv_passn
.Ldt_fail:
    AZ_ADR x0, .Lex_date
    mov x1, #4
    b _az_vtype
.Ldt_nanfail:
    bl _az_issue_invalid_date
    cbnz x0, .Lv_ret
    b .Lv_invalid

// ---------- coerces ----------
// shared: produce primitive in arena, then inner(node+1)
// .Lcz_inner: x0 = new val ptr -> tail validate(inner)
.Lcz_inner:
    mov x1, x0
    add x9, x27, #1
    ldr x10, [x9]
    add x0, x9, x10
    bl _az_validate
    b .Lv_ret

// ---------- 0x1C COERCE_STR ----------
.Lv_coerce_str:
    ldrb w9, [x28]
    cmp w9, #4
    b.eq .Lczs_inner           // already string
    cmp w9, #3
    b.eq .Lczs_f64
    cmp w9, #2
    b.eq .Lczs_bool
    cmp w9, #1
    b.eq .Lczs_null
    cmp w9, #0
    b.eq .Lczs_und
    cmp w9, #5
    b.eq .Lczs_big
    // obj/arr/hostref -> cb kind5 target 1
    b .Lczs_cb
.Lczs_inner:
    add x9, x27, #1
    b .Lv_tail
.Lczs_f64:
    ldr d0, [x28, #1]
    add x0, sp, #256
    bl _az_f64_dec
    add x1, sp, #256
    mov x2, x0
    mov x0, x1
    mov x1, x2
    bl _az_emit_str
    cmp x0, #-3
    b.eq .Lv_ret
    b .Lcz_inner
.Lczs_bool:
    ldrb w9, [x28, #1]
    cbz w9, .Lczs_f
    AZ_ADR x0, .Lrp_tru
    mov x1, #4
    b .Lczs_e
.Lczs_f:
    AZ_ADR x0, .Lrp_fal
    mov x1, #5
    b .Lczs_e
.Lczs_null:
    AZ_ADR x0, .Lrp_nul
    mov x1, #4
    b .Lczs_e
.Lczs_und:
    AZ_ADR x0, .Lrp_und
    mov x1, #9
    b .Lczs_e
.Lczs_big:
    ldr x0, [x28, #1]
    add x1, sp, #256
    bl _az_sdec
    add x1, sp, #256
    mov x2, x0
    mov x0, x1
    mov x1, x2
    bl _az_emit_str
    cmp x0, #-3
    b.eq .Lv_ret
    b .Lcz_inner
.Lczs_e:
    bl _az_emit_str
    cmp x0, #-3
    b.eq .Lv_ret
    b .Lcz_inner
.Lczs_cb:
    // cb_host(5, valptr, target=1, outptr=x19) -> len|-3|-5
    ldr x9, [x24, #24]
    mov x0, #5
    mov x1, x28
    mov x2, #1
    mov x3, x19
    blr x9
    cmp x0, #0
    b.eq .Lczs_cbfail          // coercion threw -> invalid_type w/ original type
    b.lt .Lv_ret
    mov x1, x19
    add x19, x19, x0
    mov x0, x1
    b .Lcz_inner
.Lczs_cbfail:
    AZ_ADR x0, .Lex_string
    mov x1, #6
    b _az_vtype

// ---------- 0x1D COERCE_NUM ----------
.Lv_coerce_num:
    ldrb w9, [x28]
    cmp w9, #3
    b.eq .Lczn_inner
    cmp w9, #4
    b.eq .Lczn_str
    cmp w9, #2
    b.eq .Lczn_bool
    cmp w9, #1
    b.eq .Lczn_null
    cmp w9, #0
    b.eq .Lczn_nan
    cmp w9, #5
    b.eq .Lczn_big
    b .Lczn_cb
.Lczn_inner:
    add x9, x27, #1
    b .Lv_tail
.Lczn_str:
    add x0, x28, #9
    ldr x1, [x28, #1]
    bl _az_strtod
    b .Lczn_emit
.Lczn_bool:
    ldrb w9, [x28, #1]
    ucvtf d0, x9
    b .Lczn_emit
.Lczn_null:
    fmov d0, xzr
    b .Lczn_emit
.Lczn_nan:
    mov x9, #0x7FF8000000000000
    fmov d0, x9
    b .Lczn_emit
.Lczn_big:
    ldr x9, [x28, #1]
    scvtf d0, x9
    b .Lczn_emit
.Lczn_emit:
    bl _az_emit_f64
    cmp x0, #-3
    b.eq .Lv_ret
    b .Lcz_inner
.Lczn_cb:
    ldr x9, [x24, #24]
    mov x0, #5
    mov x1, x28
    mov x2, #2
    mov x3, x19
    blr x9
    cmp x0, #0
    b.eq .Lczn_cbfail
    b.lt .Lv_ret
    mov x1, x19
    add x19, x19, x0
    mov x0, x1
    b .Lcz_inner
.Lczn_cbfail:
    AZ_ADR x0, .Lex_number
    mov x1, #6
    b _az_vtype

// ---------- 0x1E COERCE_BOOL ----------
.Lv_coerce_bool:
    ldrb w9, [x28]
    mov w10, #1                // result
    cmp w9, #0
    b.eq .Lcb_f
    cmp w9, #1
    b.eq .Lcb_f
    cmp w9, #2
    b.eq .Lcb_inner            // already bool
    cmp w9, #3
    b.eq .Lcb_num
    cmp w9, #4
    b.eq .Lcb_str
    cmp w9, #5
    b.eq .Lcb_big
    b .Lcb_emit                // obj/arr/hostref -> truthy
.Lcb_inner:
    add x9, x27, #1
    b .Lv_tail
.Lcb_f:
    mov w10, #0
    b .Lcb_emit
.Lcb_num:
    ldr d0, [x28, #1]
    fcmp d0, #0.0
    b.eq .Lcb_f
    fcmp d0, d0
    b.vs .Lcb_f                // NaN -> false
    b .Lcb_emit
.Lcb_str:
    ldr x9, [x28, #1]
    cbz x9, .Lcb_f
    b .Lcb_emit
.Lcb_big:
    ldr x9, [x28, #1]
    cbz x9, .Lcb_f
    b .Lcb_emit
.Lcb_emit:
    str w10, [sp, #32]
    mov x0, #2
    bl _az_val_reserve
    cmp x0, #-1
    b.eq .Lcb_oom
    mov w9, #2
    strb w9, [x0]
    ldr w10, [sp, #32]
    strb w10, [x0, #1]
    b .Lcz_inner
.Lcb_oom:
    mov x0, #-3
    b .Lv_ret

// ---------- 0x1F COERCE_BIGINT ----------
.Lv_coerce_bigint:
    ldrb w9, [x28]
    cmp w9, #5
    b.eq .Lcbi_inner
    cmp w9, #4
    b.eq .Lcbi_str
    cmp w9, #3
    b.eq .Lcbi_num
    cmp w9, #2
    b.eq .Lcbi_bool
    cmp w9, #8
    b.eq .Lcbi_cb
    cmp w9, #6
    b.eq .Lcbi_cb
    cmp w9, #7
    b.eq .Lcbi_cb
    b .Lcbi_fail
.Lcbi_inner:
    add x9, x27, #1
    b .Lv_tail
.Lcbi_str:
    add x0, x28, #9
    ldr x1, [x28, #1]
    bl _az_strtoi
    cbz w1, .Lcbi_fail
    bl _az_emit_i64
    cmp x0, #-3
    b.eq .Lv_ret
    b .Lcz_inner
.Lcbi_num:
    ldr d0, [x28, #1]
    frintz d1, d0
    fcmp d0, d1
    b.ne .Lcbi_fail
    fcvtzs x0, d0
    bl _az_emit_i64
    cmp x0, #-3
    b.eq .Lv_ret
    b .Lcz_inner
.Lcbi_bool:
    ldrb w0, [x28, #1]
    bl _az_emit_i64
    cmp x0, #-3
    b.eq .Lv_ret
    b .Lcz_inner
.Lcbi_cb:
    ldr x9, [x24, #24]
    mov x0, #5
    mov x1, x28
    mov x2, #4
    mov x3, x19
    blr x9
    cmp x0, #0
    b.eq .Lcbi_fail
    b.lt .Lv_ret
    mov x1, x19
    add x19, x19, x0
    mov x0, x1
    b .Lcz_inner
.Lcbi_fail:
    AZ_ADR x0, .Lex_bigint
    mov x1, #6
    b _az_vtype

    AZ_RODATA
.Lk_keys:   .ascii "keys"
.Lm_unk:    .ascii "Unrecognized key(s) in object: "
.Lty_date:  .ascii "date"
    .text

// ---------- uniform ".length" semantics (zod4) ----------
// non-string input to string schema: emit invalid_type, then still run
// size checks (codes 1-3) against .length; format checks are skipped.
.Lvs_tfail:
    AZ_ADR x0, .Lex_string
    mov x1, #6
    ldrb w2, [x28]
    mov x3, x28
    bl _az_issue_type
    cbnz x0, .Lv_ret
    mov x0, x28
    bl _az_input_len
    cmp x0, #-1
    b.eq .Lv_invalid
    mov x13, x0                // units
    ldrb w9, [x27, #1]         // nchecks
    cbz w9, .Lv_invalid
    add x14, x27, #2           // chkptr
    mov x15, x9
.Lvs_alchk:
    cbz x15, .Lv_invalid
    ldrb w9, [x14]
    ldr x10, [x14, #1]         // msglen
    add x11, x14, #9
    add x11, x11, x10          // params
    cmp w9, #1
    b.eq .Lvs_amin
    cmp w9, #2
    b.eq .Lvs_amax
    cmp w9, #3
    b.eq .Lvs_alen
    // non-size check: stride past param (skip in non-string mode)
    cmp w9, #7
    b.lo .Lvs_afmt             // 4,5,6: small fixed params
    cmp w9, #10
    b.ls .Lvs_avar             // 7,8,9: varlen (u64 len + bytes)
    cmp w9, #11
    b.eq .Lvs_a8               // 10: regex u64 cbid
    mov x12, #0                // every other format: no params
    b .Lvs_anext
.Lvs_afmt:
    mov x12, #0                // email/url: no params
    cmp w9, #5
    b.ne .Lvs_anext
    mov x12, #1                // uuid: u8 version
    b .Lvs_anext
.Lvs_avar:
    ldr x12, [x11]
    add x12, x12, #8
    b .Lvs_anext
.Lvs_a8:
    mov x12, #8
.Lvs_anext:
    add x14, x11, x12
    sub x15, x15, #1
    b .Lvs_alchk
.Lvs_amin:
    ldr x12, [x11]
    mov w5, #0
    cmp x13, x12
    b.hs .Lvs_an8
    mov x0, #8                 // too_small
    b .Lvs_asize
.Lvs_amax:
    ldr x12, [x11]
    mov w5, #0
    cmp x13, x12
    b.ls .Lvs_an8
    mov x0, #9                 // too_big
    b .Lvs_asize
.Lvs_alen:
    ldr x12, [x11]
    mov w5, #1                 // exact
    cmp x13, x12
    b.eq .Lvs_an8
    mov x0, #8
    b.lo .Lvs_asize
    mov x0, #9
.Lvs_asize:
    // (x0=code, x12=n, w5=exact) origin = received type (string|array)
    str x12, [sp, #480]
    str x11, [sp, #472]        // params ptr survives issue_size
    ucvtf d0, x12
    fmov x3, d0
    ldrb w8, [x28]
    cmp w8, #7
    b.eq .Lss_origin_arr
    cmp w8, #8
    b.eq .Lss_origin_unk
    AZ_ADR x1, .Lty_as_str
    mov x2, #6
    b .Lss_go
.Lss_origin_arr:
    AZ_ADR x1, .Lty_as_arr
    mov x2, #5
    b .Lss_go
.Lss_origin_unk:
    AZ_ADR x1, .Lty_as_unk
    mov x2, #7
.Lss_go:
    mov w4, #1
    mov x6, #0
    mov x7, #0
    bl _az_issue_size
    cbnz x0, .Lv_ret
    ldr x12, [sp, #480]
    ldr x11, [sp, #472]
.Lvs_an8:
    add x14, x11, #8
    sub x15, x15, #1
    b .Lvs_alchk

// non-array input to array schema: invalid_type + size vs min/max
.Lar_tfail:
    AZ_ADR x0, .Lex_array
    mov x1, #5
    ldrb w2, [x28]
    mov x3, x28
    bl _az_issue_type
    cbnz x0, .Lv_ret
    mov x0, x28
    bl _az_input_len
    cmp x0, #-1
    b.eq .Lv_invalid
    mov x13, x0
    mov x10, #-1
    ldr x12, [x27, #9]         // min
    cmp x12, x10
    b.eq .Lar_amaxc
    cmp x13, x12
    b.hs .Lar_amaxc
    mov x0, #8
    ldrb w5, [x27, #25]        // exactLen flag
    b .Lar_asize
.Lar_amaxc:
    ldr x12, [x27, #17]        // max
    cmp x12, x10
    b.eq .Lv_invalid
    cmp x13, x12
    b.ls .Lv_invalid
    mov x0, #9
    ldrb w5, [x27, #25]        // exactLen flag
.Lar_asize:
    ucvtf d0, x12
    fmov x3, d0
    ldrb w8, [x28]
    cmp w8, #4               // string input -> origin "string"
    b.ne .Las_ns
    AZ_ADR x1, .Lty_as_str
    mov x2, #6
    b .Las_go
.Las_ns:
    cmp w8, #8               // hostref with .length -> origin "unknown"
    b.ne .Las_origin_arr
    AZ_ADR x1, .Lty_as_unk
    mov x2, #7
    b .Las_go
.Las_origin_arr:
    AZ_ADR x1, .Lty_as_arr
    mov x2, #5
.Las_go:
    mov w4, #1
    mov x6, #0
    mov x7, #0
    bl _az_issue_size
    cbnz x0, .Lv_ret
    b .Lv_invalid

    AZ_RODATA
.Lty_as_str: .ascii "string"
.Lty_as_arr: .ascii "array"
.Lty_as_unk: .ascii "unknown"
    .text
