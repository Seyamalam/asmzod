#include "port.h"
// napi.s — N-API direct-validation front-end.
// No value encoding: the validator walks napi_values via napi_* calls and
// builds output values the same way. Issues go to the shared err arena and
// are handed back as an ArrayBuffer for the JS-side decoder.
//
// exports:
//   init(cbTableBuffer)            -> true   (grab JSCallback table ptr)
//   parse(blobUint8Array, value)   -> parsed value | {ok:false,err:ArrayBuffer} | undefined (fallback)
//
// engine ctx registers (mirror az_parse):
//   x26 = napi_env   x27 = node ptr   x28 = napi_value in   x19 = out-slot ptr
//   x22 = err base   x21 = err cursor x23 = err limit       x24 = cb table
//   x25 = blob base  x20 = scratch base (string fetch buf)
// scratch: static .bss 2MB — strings larger than scratch force -10 fallback.

    .text
    .p2align 2

AZ_WDATA
    .p2align 3
_azn_errbase:   .quad 0          // err arena base (static)
_azn_cbtab:     .quad 0          // cb table ptr (from init())
    .bss
    .p2align 3
_azn_errbuf:    .space 1048576   // 1MB err arena
_azn_scratch:   .space 2097152   // 2MB string scratch
    .text

#define NAPI_UNDEF 0
#define NAPI_NULL  1
#define NAPI_BOOL  2
#define NAPI_NUM   3
#define NAPI_STR   4
#define NAPI_SYM   5
#define NAPI_OBJ   6
#define NAPI_FN    7
#define NAPI_EXT   8
#define NAPI_BIG   9

// ================= napi_register_module_v1(env, exports) -> exports =================
    .globl _napi_register_module_v1
_napi_register_module_v1:
    stp x29, x30, [sp, #-64]!
    mov x29, sp
    stp x19, x20, [sp, #16]
    mov x19, x0
    mov x20, x1
    // init static err arena ptr
    AZ_ADR x9, _azn_errbuf
    AZ_ADR x10, _azn_errbase
    str x9, [x10]
    // create "parse" fn
    mov x0, x19
    AZ_ADR x1, .Lnm_parse
    mov x2, #5
    AZ_ADR x3, _aznapi_parse
    mov x4, #0
    add x5, sp, #32
    bl _napi_create_function
    ldr x3, [sp, #32]
    mov x0, x19
    mov x1, x20
    AZ_ADR x2, .Lnm_parse
    bl _napi_set_named_property
    // create "init" fn
    mov x0, x19
    AZ_ADR x1, .Lnm_init
    mov x2, #4
    AZ_ADR x3, _aznapi_init
    mov x4, #0
    add x5, sp, #32
    bl _napi_create_function
    ldr x3, [sp, #32]
    mov x0, x19
    mov x1, x20
    AZ_ADR x2, .Lnm_init
    bl _napi_set_named_property
    mov x0, x20
    ldp x19, x20, [sp, #16]
    ldp x29, x30, [sp], #64
    ret
.Lnm_parse: .ascii "parse\0"
.Lnm_init:  .ascii "init\0"
    .p2align 2

// ================= init(cbTableBuf) -> true =================
_aznapi_init:
    stp x29, x30, [sp, #-96]!
    mov x29, sp
    stp x19, x20, [sp, #16]
    mov x19, x0               // env
    mov x20, x1               // info
    mov w9, #1
    str x9, [sp, #32]         // argc=1
    // napi_get_cb_info(env, info, &argc, argv, NULL, NULL)
    mov x0, x19
    mov x1, x20
    add x2, sp, #32           // &argc
    add x3, sp, #40           // argv
    mov x4, #0
    mov x5, #0
    bl _napi_get_cb_info
    // get_typedarray_info(env, argv[0], &type,&len,&data,&ab,&off)
    ldr x1, [sp, #40]
    mov x0, x19
    add x2, sp, #48           // type
    add x3, sp, #56           // len
    add x4, sp, #64           // data
    mov x5, #0
    mov x6, #0
    bl _napi_get_typedarray_info
    ldr x9, [sp, #64]
    AZ_ADR x10, _azn_cbtab
    str x9, [x10]
    // return true
    mov x0, x19
    mov x1, #1
    add x2, sp, #72
    bl _napi_get_boolean
    ldr x0, [sp, #72]
    ldp x19, x20, [sp, #16]
    ldp x29, x30, [sp], #96
    ret

// ================= parse(blobTA, value) =================
// -> value | {ok:false,err} | undefined(fallback)
_aznapi_parse:
    stp x29, x30, [sp, #-160]!
    mov x29, sp
    stp x19, x20, [sp, #16]
    stp x21, x22, [sp, #32]
    stp x23, x24, [sp, #48]
    stp x25, x26, [sp, #64]
    stp x27, x28, [sp, #80]
    mov x26, x0               // env
    mov x27, x1               // info
    // argc=2, argv[2] at sp+96
    mov x9, #2
    str x9, [sp, #112]        // argc
    mov x0, x26
    mov x1, x27
    add x2, sp, #112          // &argc
    add x3, sp, #96           // argv[0]@96, argv[1]@104
    mov x4, #0
    mov x5, #0
    bl _napi_get_cb_info
    // typedarray info -> blob ptr into x25, node
    ldr x1, [sp, #96]
    mov x0, x26
    add x2, sp, #112          // type
    add x3, sp, #120          // len
    add x4, sp, #128          // data
    mov x5, #0
    mov x6, #0
    bl _napi_get_typedarray_info
    ldr x25, [sp, #128]       // blob base
    // err arena ctx
    AZ_ADR x9, _azn_errbase
    ldr x22, [x9]
    add x21, x22, #3104
    add x23, x22, #1048576
    AZ_ADR x9, _azn_cbtab
    ldr x24, [x9]
    cbz x24, .Lnparse_undef   // init() never ran
    AZ_ADR x20, _azn_scratch
    str xzr, [x22]
    str xzr, [x22, #8]
    str xzr, [x22, #16]
    str xzr, [x22, #24]
    // run
    mov x0, x25               // node
    ldr x1, [sp, #104 - 8]    // argv[1] at sp+104? argv is at 96,104
    ldr x1, [sp, #104]        // argv[1]
    add x2, sp, #136          // outslot
    bl _aznapi_run
    cmp x0, #0
    b.eq .Lnparse_ok
    cmp x0, #-2
    b.eq .Lnparse_fail
    b .Lnparse_undef          // -10 fallback / -4 enospc
.Lnparse_ok:
    // {ok:true, value:out}
    mov x0, x26
    add x1, sp, #144          // &obj
    bl _napi_create_object
    mov x0, x26
    mov x1, #1
    add x2, sp, #152          // &true
    bl _napi_get_boolean
    ldr x1, [sp, #144]
    AZ_ADR x2, .Lnm_ok
    ldr x3, [sp, #152]
    mov x0, x26
    bl _napi_set_named_property
    ldr x1, [sp, #144]
    AZ_ADR x2, .Lnm_value
    ldr x3, [sp, #136]
    mov x0, x26
    bl _napi_set_named_property
    ldr x0, [sp, #144]
    b .Lnparse_ret
.Lnparse_fail:
    // {ok:false, err:ArrayBuffer(issues)}
    mov x0, x26
    add x1, sp, #144
    bl _napi_create_object
    mov x0, x26
    mov x1, #0
    add x2, sp, #152
    bl _napi_get_boolean
    ldr x1, [sp, #144]
    AZ_ADR x2, .Lnm_ok
    ldr x3, [sp, #152]
    mov x0, x26
    bl _napi_set_named_property
    // copy whole err region [x22, x21) into a new ArrayBuffer —
    // same layout the JS decoder expects (cnt@0, issues at +3104)
    sub x12, x21, x22         // bytes
    mov x0, x26
    mov x1, x12
    add x2, sp, #152          // &data
    add x3, sp, #136          // &ab
    bl _napi_create_arraybuffer
    mov x1, x22               // src
    ldr x0, [sp, #152]        // dst
    sub x2, x21, x22          // len
    bl _az_memcpy
    ldr x1, [sp, #144]
    AZ_ADR x2, .Lnm_err
    ldr x3, [sp, #136]
    mov x0, x26
    bl _napi_set_named_property
    ldr x0, [sp, #144]
    b .Lnparse_ret
.Lnparse_undef:
    // dbg: return {ok:null, code:status} — JS treats ok===null as fallback
    str x0, [sp, #104]
    mov x0, x26
    add x1, sp, #144
    bl _napi_create_object
    mov x0, x26
    add x1, sp, #152
    bl _napi_get_null
    ldr x1, [sp, #144]
    AZ_ADR x2, .Lnm_ok
    ldr x3, [sp, #152]
    mov x0, x26
    bl _napi_set_named_property
    ldr x0, [sp, #104]
    scvtf d0, x0
    mov x0, x26
    add x1, sp, #152
    bl _napi_create_double
    ldr x1, [sp, #144]
    AZ_ADR x2, .Lnm_code
    ldr x3, [sp, #152]
    mov x0, x26
    bl _napi_set_named_property
    ldr x0, [sp, #144]
.Lnparse_ret:
    ldp x19, x20, [sp, #16]
    ldp x21, x22, [sp, #32]
    ldp x23, x24, [sp, #48]
    ldp x25, x26, [sp, #64]
    ldp x27, x28, [sp, #80]
    ldp x29, x30, [sp], #160
    ret
.Lnm_ok:    .ascii "ok\0"
.Lnm_value: .ascii "value\0"
.Lnm_err:   .ascii "err\0"
.Lnm_code:  .ascii "code\0"
    .p2align 2

// ================= aznapi_run(x0=node, x1=val, x2=outslot) =================
// ctx: x26 env, x25 blob base, x24 cbtab, x22/x21/x23 err, x20 scratch
// -> x0: 0 ok (out written) / -2 invalid / -4 enospc / -10 unsupported
    .globl _aznapi_run
    .globl _aznapi_run
    AZ_HIDDEN _aznapi_run
// local slots (all >= 64; saved regs at 16-63)
.equ LN_A, 64
.equ LN_B, 72
.equ LN_C, 80
.equ LN_D, 88
.equ LN_E, 96
.equ LN_F, 104
.equ LN_G, 112
.equ LN_H, 120
.equ LN_I, 128
.equ LN_J, 136
.equ LN_K, 144
.equ LN_L, 152
.equ LN_M, 160
.equ LN_N, 168
.equ LN_O, 176
.equ LN_P, 184
_aznapi_run:
    stp x29, x30, [sp, #-256]!
    mov x29, sp
    stp x27, x28, [sp, #16]
    stp x19, x20, [sp, #32]
    stp x23, x24, [sp, #48]
    mov x27, x0
    mov x28, x1
    mov x19, x2
    ldrb w9, [x27]
    cmp w9, #0x01
    b.eq .Ln_str
    cmp w9, #0x02
    b.eq .Ln_num
    cmp w9, #0x03
    b.eq .Ln_bool
    cmp w9, #0x04
    b.eq .Ln_big
    cmp w9, #0x05
    b.eq .Ln_obj
    cmp w9, #0x06
    b.eq .Ln_arr
    cmp w9, #0x07
    b.eq .Ln_union
    cmp w9, #0x09
    b.eq .Ln_lit
    cmp w9, #0x0a
    b.eq .Ln_enum
    cmp w9, #0x0b
    b.eq .Ln_opt
    cmp w9, #0x0c
    b.eq .Ln_nul
    cmp w9, #0x0d
    b.eq .Ln_def
    cmp w9, #0x0e
    b.eq .Ln_cat
    cmp w9, #0x13
    b.eq .Ln_tup
    cmp w9, #0x15
    b.eq .Ln_any
    cmp w9, #0x16
    b.eq .Ln_never
    cmp w9, #0x17
    b.eq .Ln_nulls
    cmp w9, #0x18
    b.eq .Ln_undef
    cmp w9, #0x19
    b.eq .Ln_nanop
    cmp w9, #0x21
    b.eq .Ln_sym
    cmp w9, #0x23
    b.eq .Ln_nonopt
    mov x0, #-1000
    sub x0, x0, x9            // -1000-op reveals the unknown opcode
    b .Ln_ret
.Ln_ret:
    ldp x27, x28, [sp, #16]
    ldp x19, x20, [sp, #32]
    ldp x23, x24, [sp, #48]
    ldp x29, x30, [sp], #256
    ret

// ================= helpers (own frames, locals at 16+) =================
// _azn_typeof(x0=val) -> w0 napi_valuetype
_azn_typeof:
    stp x29, x30, [sp, #-32]!
    mov x29, sp
    mov x1, x0
    mov x0, x26
    add x2, sp, #16
    bl _napi_typeof
    ldr w0, [sp, #16]
    ldp x29, x30, [sp], #32
    ret

// _azn_getstr(x0=val) -> [x20..] utf8 bytes; x0=len or -1 if >cap
_azn_getstr:
    stp x29, x30, [sp, #-32]!
    mov x29, sp
    mov x0, x26
    mov x1, x28
    mov x2, #0
    mov x3, #0
    add x4, sp, #16
    bl _napi_get_value_string_utf8
    ldr x9, [sp, #16]
    mov x10, #2097152
    cmp x9, x10
    b.hs .Lgs_big
    mov x0, x26
    mov x1, x28
    mov x2, x20
    mov x3, #2097152
    add x4, sp, #16
    bl _napi_get_value_string_utf8
    ldr x0, [sp, #16]
    b .Lgs_ret
.Lgs_big:
    mov x0, #-1
.Lgs_ret:
    ldp x29, x30, [sp], #32
    ret

// _azn_origin(x0=val) -> x0=nameptr, x1=namelen  (size-issue origin name)
_azn_origin:
    stp x29, x30, [sp, #-96]!
    mov x29, sp
    str x0, [sp, #16]
    bl _azn_typeof
    cmp w0, #NAPI_STR
    b.ne .Lor_nstr
    AZ_ADR x9, .Lex_string
    mov x10, #6
    b .Lor_out
.Lor_nstr:
    cmp w0, #NAPI_OBJ
    b.ne .Lor_unk
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #24
    bl _napi_is_array
    ldrb w9, [sp, #24]
    cbz w9, .Lor_unk
    AZ_ADR x9, .Ls_array
    mov x10, #5
    b .Lor_out
.Lor_unk:
    AZ_ADR x9, .Ls_unknown
    mov x10, #7
.Lor_out:
    mov x0, x9
    mov x1, x10
    ldp x29, x30, [sp], #96
    ret

// _azn_issue_type(x0=expptr, x1=explen) -> -2/-4  (invalid_type w/ received name)
// ctx: x28=napi val, x20=scratch, x26=env, x22/x21/x23 err, x24 cbtab
// _azn_recvname(x0=val) -> x0=nameptr, x1=namelen
_azn_recvname:
    stp x29, x30, [sp, #-160]!
    mov x29, sp
    str x0, [sp, #80]         // val
    bl _azn_typeof
    str w0, [sp, #72]         // type
    cmp w0, #NAPI_NUM
    b.ne .Lrn_notnum
    mov x0, x26
    ldr x1, [sp, #80]
    add x2, sp, #64
    bl _napi_get_value_double
    ldr d0, [sp, #64]
    fcmp d0, d0
    b.vc .Lrn_numfin
    AZ_ADR x9, .Ls_nan
    mov x10, #3
    b .Lrn_store
.Lrn_numfin:
    fabs d1, d0
    mov x9, #0x7FF0000000000000
    fmov d2, x9
    fcmp d1, d2
    b.ne .Lrn_notnum
    fcmp d0, #0.0
    AZ_ADR x9, .Ls_inf
    mov x10, #8
    b.mi .Lrn_inneg
    b .Lrn_store
.Lrn_inneg:
    AZ_ADR x9, .Ls_ninf
    mov x10, #9
    b .Lrn_store
.Lrn_notnum:
    ldr w0, [sp, #72]
    cmp w0, #NAPI_OBJ
    b.ne .Lrn_tabname
    mov x0, x26
    ldr x1, [sp, #80]
    add x2, sp, #64
    bl _napi_is_array
    ldrb w9, [sp, #64]
    cbz w9, .Lrn_ctor
    AZ_ADR x9, .Ls_array
    mov x10, #5
    b .Lrn_store
.Lrn_ctor:
    // proto = get_prototype(v); plain (Object.prototype|null) -> "object";
    // exotic -> ctor = proto.constructor; name = ctor.name
    mov x0, x26
    ldr x1, [sp, #80]
    add x2, sp, #64
    bl _napi_get_prototype
    ldr x1, [sp, #64]
    cbz x1, .Lrn_plain
    str x1, [sp, #88]          // proto
    mov x0, x26
    add x1, sp, #64
    bl _napi_get_global
    ldr x1, [sp, #64]
    mov x0, x26
    AZ_ADR x2, .Ls_Objstr
    add x3, sp, #64
    bl _napi_get_named_property
    ldr x1, [sp, #64]
    mov x0, x26
    AZ_ADR x2, .Ls_protoname
    add x3, sp, #64
    bl _napi_get_named_property
    ldr x1, [sp, #88]
    ldr x2, [sp, #64]
    mov x0, x26
    add x3, sp, #96
    bl _napi_strict_equals
    ldrb w9, [sp, #96]
    cbnz w9, .Lrn_plain
    ldr x1, [sp, #88]          // proto
    mov x0, x26
    AZ_ADR x2, .Ls_ctor
    add x3, sp, #64
    bl _napi_get_named_property
    cbnz x0, .Lrn_plain
    ldr x1, [sp, #64]
    mov x0, x26
    AZ_ADR x2, .Ls_name
    add x3, sp, #64
    bl _napi_get_named_property
    cbnz x0, .Lrn_plain
    ldr x1, [sp, #64]
    mov x0, x26
    mov x2, x20
    mov x3, #2097152
    add x4, sp, #72
    bl _napi_get_value_string_utf8
    ldr x10, [sp, #72]
    cbz x10, .Lrn_plain
    mov x9, x20
    b .Lrn_store
.Lrn_plain:
    AZ_ADR x9, .Ls_object
    mov x10, #6
    b .Lrn_store
.Lrn_tabname:
    AZ_ADR x9, _azn_vtype_table
    mov x10, #16
    mul x10, x0, x10
    add x13, x9, x10
    ldp x9, x10, [x13]
.Lrn_store:
    mov x0, x9
    mov x1, x10
    ldp x29, x30, [sp], #160
    ret

// _azn_input_len(x0=val) -> x0 = units or -1
_azn_input_len:
    stp x29, x30, [sp, #-96]!
    mov x29, sp
    str x0, [sp, #16]
    bl _azn_typeof
    cmp w0, #NAPI_STR
    b.eq .Lilen_str
    cmp w0, #NAPI_OBJ
    b.eq .Lilen_obj
    cmp w0, #NAPI_FN
    b.eq .Lilen_len
    b .Lilen_neg
.Lilen_str:
    mov x0, x26
    ldr x1, [sp, #16]
    mov x2, x20
    mov x3, #1048576
    add x4, sp, #24
    bl _napi_get_value_string_utf16
    cbnz x0, .Lilen_neg
    ldr x0, [sp, #24]
    b .Lilen_out
.Lilen_obj:
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #24
    bl _napi_is_array
    ldrb w9, [sp, #24]
    cbz w9, .Lilen_plain
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #24
    bl _napi_get_array_length
    ldr w0, [sp, #24]
    b .Lilen_out
.Lilen_plain:
    // non-plain objects (proto != Object.prototype, != null) may have .length
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #24
    bl _napi_get_prototype
    ldr x9, [sp, #24]
    cbz x9, .Lilen_neg
    mov x0, x26
    add x1, sp, #32
    bl _napi_get_global
    ldr x1, [sp, #32]
    mov x0, x26
    AZ_ADR x2, .Ls_Objstr
    add x3, sp, #32
    bl _napi_get_named_property
    ldr x1, [sp, #32]
    mov x0, x26
    AZ_ADR x2, .Ls_protoname
    add x3, sp, #32
    bl _napi_get_named_property
    ldr x1, [sp, #24]           // proto
    ldr x2, [sp, #32]           // Object.prototype
    mov x0, x26
    add x3, sp, #40
    bl _napi_strict_equals
    ldrb w9, [sp, #40]
    cbnz w9, .Lilen_neg         // plain object -> -1
.Lilen_len:
    mov x0, x26
    ldr x1, [sp, #16]
    AZ_ADR x2, .Ls_length
    add x3, sp, #24
    bl _napi_get_named_property
    cbnz x0, .Lilen_neg
    ldr x0, [sp, #24]
    bl _azn_typeof
    cmp w0, #NAPI_NUM
    b.ne .Lilen_neg
    mov x0, x26
    ldr x1, [sp, #24]
    add x2, sp, #32
    bl _napi_get_value_uint32
    cbnz x0, .Lilen_neg
    ldr w0, [sp, #32]
    b .Lilen_out
.Lilen_neg:
    mov x0, #-1
.Lilen_out:
    ldp x29, x30, [sp], #96
    ret

// _azn_strsize(x0=units, x1=chkptr@node+2, x2=ncount, x3=originptr, x4=originlen)
// runs only cbid 1(min)/2(max)/3(len) against `units`; emits az_issue_size
_azn_strsize:
    stp x29, x30, [sp, #-160]!
    mov x29, sp
    stp x0, x1, [sp, #16]       // units, cursor
    stp x2, x3, [sp, #32]       // n, originptr
    str x4, [sp, #48]           // originlen
.Lnss_loop:
    ldr x9, [sp, #32]
    cbz x9, .Lnss_out
    ldr x14, [sp, #24]          // cursor
    ldrb w9, [x14]              // cbid
    ldr x10, [x14, #1]          // msglen
    add x11, x14, #9
    add x11, x11, x10           // params
    str x11, [sp, #56]
    // paramsize
    cmp w9, #4
    b.lo .Lnss_sz8            // cbid 1,2,3: u64 bound
    cmp w9, #7
    b.lo .Lnss_fmt
    cmp w9, #10
    b.ls .Lnss_var
    cmp w9, #11
    b.eq .Lnss_r8
    mov x12, #0
    b .Lnss_disp
.Lnss_fmt:
    mov x12, #0
    cmp w9, #5
    b.ne .Lnss_disp
    mov x12, #1
    b .Lnss_disp
.Lnss_sz8:
    mov x12, #8
    b .Lnss_disp
.Lnss_var:
    ldr x12, [x11]
    add x12, x12, #8
    b .Lnss_disp
.Lnss_r8:
    mov x12, #8
.Lnss_disp:
    str x12, [sp, #64]
    cmp w9, #4
    b.hs .Lnss_adv
    ldr x12, [x11]              // bound
    ldr x13, [sp, #16]          // units
    cmp w9, #1
    b.eq .Lnss_min
    cmp w9, #2
    b.eq .Lnss_max
    mov w5, #1                  // len -> exact
    cmp x13, x12
    b.eq .Lnss_adv
    mov x0, #8
    b.lo .Lnss_emit
    mov x0, #9
    b .Lnss_emit
.Lnss_min:
    mov w5, #0
    cmp x13, x12
    b.hs .Lnss_adv
    mov x0, #8
    b .Lnss_emit
.Lnss_max:
    mov w5, #0
    cmp x13, x12
    b.ls .Lnss_adv
    mov x0, #9
.Lnss_emit:
    ucvtf d0, x12
    fmov x3, d0
    ldr x1, [sp, #40]           // originptr
    ldr x2, [sp, #48]           // originlen
    mov w4, #1
    mov x6, #0
    mov x7, #0
    bl _az_issue_size
    cbnz x0, .Lnss_out          // hard err -> stop
.Lnss_adv:
    ldr x11, [sp, #56]
    ldr x12, [sp, #64]
    add x11, x11, x12           // next rec = params + paramsize
    str x11, [sp, #24]
    ldr x9, [sp, #32]
    sub x9, x9, #1
    str x9, [sp, #32]
    b .Lnss_loop
.Lnss_out:
    ldp x29, x30, [sp], #160
    ret

// _azn_issue_type(x0=exp ptr, x1=exp len) -> -2 (issue written) or -4
_azn_issue_type:
    stp x29, x30, [sp, #-96]!
    mov x29, sp
    stp x0, x1, [sp, #16]       // exp ptr/len
    mov x0, x28
    bl _azn_recvname
    stp x0, x1, [sp, #48]
    mov x1, #0
    mov x2, #0
    mov x0, #0                  // code = invalid_type
    bl _az_issue_begin
    cbnz x0, .Lnit_out
    AZ_ADR x0, .Ln_k_expected
    mov x1, #8
    ldp x2, x3, [sp, #16]
    bl _az_issue_f_str
    cbnz x0, .Lnit_out
    AZ_ADR x0, .Ln_k_received
    mov x1, #8
    ldp x2, x3, [sp, #48]
    bl _az_issue_f_str
    cbnz x0, .Lnit_out
    bl _az_issue_commit
    mov x0, #-2
.Lnit_out:
    ldp x29, x30, [sp], #96
    ret

// _azn_blob_to_napi(x0=taggedptr, x1=outslotptr) -> x0=0 | -10 unsupported tag
// tags: 0 undef,1 null,2 bool,3 f64,4 str,5 i64,6 obj,7 arr,8 hostref(-10)
_azn_blob_to_napi:
    stp x29, x30, [sp, #-160]!
    mov x29, sp
    stp x0, x1, [sp, #16]       // ptr, outslot
    ldrb w9, [x0]
    cmp w9, #0
    b.eq .Lb2n_und
    cmp w9, #1
    b.eq .Lb2n_nul
    cmp w9, #2
    b.eq .Lb2n_bol
    cmp w9, #3
    b.eq .Lb2n_num
    cmp w9, #4
    b.eq .Lb2n_str
    cmp w9, #5
    b.eq .Lb2n_big
    cmp w9, #6
    b.eq .Lb2n_obj
    cmp w9, #7
    b.eq .Lb2n_arr
    mov x0, #-10
    b .Lb2n_out
.Lb2n_und:
    mov x0, x26
    ldr x1, [sp, #24]
    bl _napi_get_undefined
    b .Lb2n_ok
.Lb2n_nul:
    mov x0, x26
    ldr x1, [sp, #24]
    bl _napi_get_null
    b .Lb2n_ok
.Lb2n_bol:
    mov x0, x26
    ldr x9, [sp, #16]
    ldrb w1, [x9, #1]
    ldr x2, [sp, #24]
    bl _napi_get_boolean
    b .Lb2n_ok
.Lb2n_num:
    ldr x9, [sp, #16]
    ldr d0, [x9, #1]
    mov x0, x26
    ldr x1, [sp, #24]
    bl _napi_create_double
    b .Lb2n_ok
.Lb2n_str:
    ldr x9, [sp, #16]
    ldr x1, [x9, #1]            // len
    add x2, x9, #9              // bytes — wait: create_string_utf8(str,len,out)
    mov x9, x2
    mov x2, x1
    mov x1, x9
    mov x0, x26
    ldr x3, [sp, #24]
    bl _napi_create_string_utf8
    b .Lb2n_ok
.Lb2n_big:
    ldr x9, [sp, #16]
    ldr x1, [x9, #1]
    mov x0, x26
    mov x2, #0
    ldr x3, [sp, #24]
    bl _napi_create_bigint_int64
    b .Lb2n_ok
.Lb2n_obj:
    // tag6: u64 nfields | [u64 klen, key, value]*
    mov x0, x26
    add x1, sp, #32
    bl _napi_create_object
    ldr x9, [sp, #16]
    ldr x10, [x9, #1]           // n
    str x10, [sp, #40]
    add x9, x9, #9
    str x9, [sp, #48]           // cursor
.Lb2n_oloop:
    ldr x10, [sp, #40]
    cbz x10, .Lb2n_odone
    ldr x9, [sp, #48]
    ldr x11, [x9]               // klen
    add x12, x9, #8             // kptr
    add x9, x12, x11            // value ptr
    str x9, [sp, #56]
    // key napi string
    mov x0, x26
    mov x1, x12
    mov x2, x11
    add x3, sp, #64
    bl _napi_create_string_utf8
    // recurse value
    ldr x0, [sp, #56]
    add x1, sp, #72
    bl _azn_blob_to_napi
    cbnz x0, .Lb2n_out
    mov x0, x26
    ldr x1, [sp, #32]           // obj
    ldr x2, [sp, #64]           // key
    ldr x3, [sp, #72]           // val
    bl _napi_set_property
    // advance: value size = cur-after — recurse advanced? need vsize.
    ldr x0, [sp, #56]
    bl _az_vsize
    ldr x9, [sp, #56]
    add x9, x9, x0
    str x9, [sp, #48]
    ldr x10, [sp, #40]
    sub x10, x10, #1
    str x10, [sp, #40]
    b .Lb2n_oloop
.Lb2n_odone:
    ldr x9, [sp, #32]
    ldr x10, [sp, #24]
    str x9, [x10]
    b .Lb2n_ok
.Lb2n_arr:
    // tag7: u64 n | value*
    ldr x9, [sp, #16]
    ldr x10, [x9, #1]           // n
    str x10, [sp, #40]
    add x9, x9, #9
    str x9, [sp, #48]
    mov x0, x26
    ldr x1, [sp, #40]
    add x2, sp, #32
    bl _napi_create_array_with_length
    str xzr, [sp, #56]          // i
.Lb2n_aloop:
    ldr x10, [sp, #56]
    ldr x11, [sp, #40]
    cmp x10, x11
    b.hs .Lb2n_adone
    ldr x0, [sp, #48]
    add x1, sp, #64
    bl _azn_blob_to_napi
    cbnz x0, .Lb2n_out
    mov x0, x26
    ldr x1, [sp, #32]
    ldr x2, [sp, #56]
    ldr x3, [sp, #64]
    bl _napi_set_element
    ldr x0, [sp, #48]
    bl _az_vsize
    ldr x9, [sp, #48]
    add x9, x9, x0
    str x9, [sp, #48]
    ldr x10, [sp, #56]
    add x10, x10, #1
    str x10, [sp, #56]
    b .Lb2n_aloop
.Lb2n_adone:
    ldr x9, [sp, #32]
    ldr x10, [sp, #24]
    str x9, [x10]
    b .Lb2n_ok
.Lb2n_ok:
    mov x0, #0
.Lb2n_out:
    ldp x29, x30, [sp], #160
    ret

// _az_issue_size_n(x0=dir(0min/1max),x1=bound,x2=len,x3=exact,x4=originptr,x5=originlen) -> 0/-4
_az_issue_size_n:
    mov x7, #0
    mov x6, #0
    mov x9, x0
    mov x0, #8
    cbz x9, .Liszn_go
    mov x0, #9
.Liszn_go:
    mov x10, x1
    mov x1, x4
    mov x2, x5
    mov w5, w3                // exact flag from caller
    ucvtf d0, x10
    fmov x3, d0
    mov w4, #1
    b _az_issue_size

// ================= opcode handlers =================

// ---- 0x01 STRING ----
.Ln_str:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_STR
    b.ne .Ln_str_fail
    bl _azn_getstr
    cmp x0, #-1
    b.eq .Ln_toobig
    str x0, [sp, #LN_A]       // strlen
    ldrb w1, [x27, #1]
    cbz w1, .Ln_str_ok
    add x0, x27, #2
    mov x2, x20
    ldr x3, [sp, #LN_A]
    bl _az_run_strchecks
    cmp x0, #0
    b.ne .Ln_ret
.Ln_str_ok:
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_toobig:
    mov x0, #-14
    b .Ln_ret
.Ln_str_fail:
    AZ_ADR x0, .Lex_string
    mov x1, #6
    bl _azn_issue_type
    cmp x0, #-2
    b.ne .Ln_ret
    // size checks on sized non-string inputs (origin = received type)
    mov x0, x28
    bl _azn_input_len
    cmp x0, #-1
    b.eq .Ln_str_fin
    str x0, [sp, #LN_A]
    mov x0, x28
    bl _azn_origin
    mov x3, x0
    mov x4, x1
    ldr x0, [sp, #LN_A]
    add x1, x27, #2
    ldrb w2, [x27, #1]
    bl _azn_strsize
.Ln_str_fin:
    mov x0, #-2
    b .Ln_ret

// ---- 0x02 NUMBER ----
.Ln_num:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_NUM
    b.ne .Ln_num_fail
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    bl _napi_get_value_double
    ldr d0, [sp, #LN_A]
    fcmp d0, d0
    b.vs .Ln_num_fail          // NaN -> invalid_type
    fabs d1, d0
    mov x9, #0x7FF0000000000000
    fmov d2, x9
    fcmp d1, d2
    b.eq .Ln_num_fail          // +-Inf -> invalid_type
    ldrb w1, [x27, #1]
    cbz w1, .Ln_num_ok
    add x0, x27, #2
    mov x2, x27
    bl _az_run_numchecks      // (chkptr,count,d0,valptr) — valptr unused for checks
    cmp x0, #0
    b.ne .Ln_ret
.Ln_num_ok:
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_num_fail:
    AZ_ADR x0, .Lex_number
    mov x1, #6
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret

// ---- 0x03 BOOLEAN ----
.Ln_bool:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_BOOL
    b.ne .Ln_bool_fail
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_bool_fail:
    AZ_ADR x0, .Lex_boolean
    mov x1, #7
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret

// ---- 0x04 BIGINT ----
.Ln_big:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_BIG
    b.ne .Ln_big_fail
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    add x3, sp, #LN_B
    bl _napi_get_value_bigint_int64
    ldr x2, [sp, #LN_A]
    ldrb w1, [x27, #1]
    cbz w1, .Ln_big_ok
    add x0, x27, #2
    mov x3, x27
    bl _az_run_bigintchecks   // (chkptr,count,i64 val,valptr)
    cmp x0, #0
    b.ne .Ln_ret
.Ln_big_ok:
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_big_fail:
    AZ_ADR x0, .Lex_bigint
    mov x1, #6
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret

// ---- 0x15 ANY/UNKNOWN ----
.Ln_any:
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
// ---- 0x16 NEVER ----
.Ln_never:
    AZ_ADR x0, .Lex_never
    mov x1, #5
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret
// ---- 0x17 NULL ----
.Ln_nulls:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_NULL
    b.ne .Ln_null_fail
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_null_fail:
    AZ_ADR x0, .Lex_null
    mov x1, #4
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret
// ---- 0x18 UNDEFINED/VOID ----
.Ln_undef:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_UNDEF
    b.ne .Ln_und_fail
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_und_fail:
    AZ_ADR x0, .Lex_undefined
    mov x1, #9
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret
// ---- 0x19 NAN ----
.Ln_nanop:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_NUM
    b.ne .Ln_nan_fail
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    bl _napi_get_value_double
    ldr d0, [sp, #LN_A]
    fcmp d0, d0
    b.vc .Ln_nan_fail
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_nan_fail:
    AZ_ADR x0, .Lex_nan
    mov x1, #3
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret
// ---- 0x21 SYMBOL ----
.Ln_sym:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_SYM
    b.ne .Ln_sym_fail
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_sym_fail:
    AZ_ADR x0, .Lex_symbol
    mov x1, #6
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret

// ---- 0x0B OPTIONAL ----
.Ln_opt:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_UNDEF
    b.ne .Ln_wrap
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
// ---- 0x0C NULLABLE ----
.Ln_nul:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_NULL
    b.ne .Ln_wrap
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
// ---- shared wrapper: rel field at node+1 -> recurse inner ----
.Ln_wrap:
    add x9, x27, #1
    ldr x0, [x9]
    add x0, x9, x0            // inner = fieldaddr + reloff
    mov x1, x28
    mov x2, x19
    bl _aznapi_run
    b .Ln_ret
// ---- 0x23 NONOPTIONAL ----
.Ln_nonopt:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_UNDEF
    b.ne .Ln_wrap
    AZ_ADR x0, .Lex_nonoptional
    mov x1, #11
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret

// ---- 0x0D DEFAULT / 0x0E CATCH ----
// layout: op|innerField(8)|tagged-val|inner
.Ln_def:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_UNDEF
    b.ne .Ln_wrap
    add x0, x27, #9           // tagged default value
    mov x1, x19
    bl _azn_blob_to_napi
    b .Ln_ret
.Ln_cat:
    // catch: run inner; on -2 roll back err arena and emit default
    str x21, [sp, #LN_A]      // save err cursor
    ldr x9, [x22]
    str x9, [sp, #LN_B]       // save issue count
    add x9, x27, #1
    ldr x0, [x9]
    add x0, x9, x0
    mov x1, x28
    add x2, sp, #LN_C         // out slot scratch
    bl _aznapi_run
    cmp x0, #0
    b.eq .Ln_cat_ok
    cmp x0, #-2
    b.ne .Ln_ret              // -4/-10 propagate
    // rollback issues then emit default
    ldr x21, [sp, #LN_A]
    ldr x9, [sp, #LN_B]
    str x9, [x22]
    str xzr, [x22, #16]
    str xzr, [x22, #24]
    add x0, x27, #9
    mov x1, x19
    bl _azn_blob_to_napi
    b .Ln_ret
.Ln_cat_ok:
    ldr x9, [sp, #LN_C]
    str x9, [x19]
    mov x0, #0
    b .Ln_ret

// _azn_encval(x0=val, x1=dst) -> x0 = bytes written, or -1 unsupported
// writes the same tagged format as codec.encodeValue (tags 0-7 only)
_azn_encval:
    stp x29, x30, [sp, #-160]!
    mov x29, sp
    stp x0, x1, [sp, #16]       // val, dst
    bl _azn_typeof
    cmp w0, #NAPI_UNDEF
    b.eq .Lenc_und
    cmp w0, #NAPI_NULL
    b.eq .Lenc_nul
    cmp w0, #NAPI_BOOL
    b.eq .Lenc_bol
    cmp w0, #NAPI_NUM
    b.eq .Lenc_num
    cmp w0, #NAPI_STR
    b.eq .Lenc_str
    cmp w0, #NAPI_BIG
    b.eq .Lenc_big
    cmp w0, #NAPI_OBJ
    b.eq .Lenc_obj
    mov x0, #-1
    b .Lenc_out
.Lenc_und:
    ldr x9, [sp, #24]
    mov w10, #0
    strb w10, [x9]
    mov x0, #1
    b .Lenc_out
.Lenc_nul:
    ldr x9, [sp, #24]
    mov w10, #1
    strb w10, [x9]
    mov x0, #1
    b .Lenc_out
.Lenc_bol:
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #32
    bl _napi_get_value_bool
    ldr x9, [sp, #24]
    mov w10, #2
    strb w10, [x9]
    ldrb w10, [sp, #32]
    strb w10, [x9, #1]
    mov x0, #2
    b .Lenc_out
.Lenc_num:
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #32
    bl _napi_get_value_double
    ldr x9, [sp, #24]
    mov w10, #3
    strb w10, [x9]
    ldr d0, [sp, #32]
    str d0, [x9, #1]
    mov x0, #9
    b .Lenc_out
.Lenc_str:
    // fetch utf8 into scratch+1MB, then copy to dst
    mov x0, x26
    ldr x1, [sp, #16]
    mov x12, #1048576
    add x2, x20, x12
    mov x3, #1048576
    add x4, sp, #32
    bl _napi_get_value_string_utf8
    cbnz x0, .Lenc_neg
    ldr x9, [sp, #24]
    mov w10, #4
    strb w10, [x9]
    ldr x10, [sp, #32]          // len
    str x10, [x9, #1]
    add x0, x9, #9
    mov x12, #1048576
    add x1, x20, x12
    mov x2, x10
    bl _az_memcpy
    ldr x10, [sp, #32]
    add x0, x10, #9
    b .Lenc_out
.Lenc_big:
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #32
    add x3, sp, #40
    bl _napi_get_value_bigint_int64
    ldr x9, [sp, #24]
    mov w10, #5
    strb w10, [x9]
    ldr x10, [sp, #32]
    str x10, [x9, #1]
    mov x0, #9
    b .Lenc_out
.Lenc_obj:
    // array -> tag7; plain/exotic object -> tag6 via own-property names
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #32
    bl _napi_is_array
    ldrb w9, [sp, #32]
    cbnz w9, .Lenc_arr
    // tag6 object: u64 nf | [u64 klen,key,val]*
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #32
    bl _napi_get_property_names
    cbnz x0, .Lenc_neg
    mov x0, x26
    ldr x1, [sp, #32]
    add x2, sp, #40
    bl _napi_get_array_length
    ldr w9, [sp, #40]
    str x9, [sp, #48]           // nf
    ldr x10, [sp, #24]
    mov w11, #6
    strb w11, [x10]
    str x9, [x10, #1]
    add x10, x10, #9
    str x10, [sp, #56]          // write cursor
    str xzr, [sp, #64]          // i
.Lenc_okv:
    ldr x9, [sp, #64]
    ldr x10, [sp, #48]
    cmp x9, x10
    b.hs .Lenc_odone
    // key = names[i]
    mov x0, x26
    ldr x1, [sp, #32]
    ldr x2, [sp, #64]
    add x3, sp, #72
    bl _napi_get_element
    // klen via get_string_utf8 into scratch+1MB
    mov x0, x26
    ldr x1, [sp, #72]
    mov x12, #1048576
    add x2, x20, x12
    mov x3, #1048576
    add x4, sp, #80
    bl _napi_get_value_string_utf8
    cbnz x0, .Lenc_neg
    ldr x9, [sp, #56]
    ldr x10, [sp, #80]
    str x10, [x9]
    add x0, x9, #8
    mov x12, #1048576
    add x1, x20, x12
    mov x2, x10
    bl _az_memcpy
    ldr x9, [sp, #56]
    ldr x10, [sp, #80]
    add x9, x9, x10
    add x9, x9, #8
    str x9, [sp, #56]
    // prop value
    mov x0, x26
    ldr x1, [sp, #16]
    ldr x2, [sp, #72]
    add x3, sp, #88
    bl _napi_get_property
    ldr x0, [sp, #88]
    ldr x1, [sp, #56]
    bl _azn_encval
    cmp x0, #-1
    b.eq .Lenc_neg
    ldr x9, [sp, #56]
    add x9, x9, x0
    str x9, [sp, #56]
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Lenc_okv
.Lenc_odone:
    ldr x0, [sp, #56]
    ldr x9, [sp, #24]
    sub x0, x0, x9
    b .Lenc_out
.Lenc_arr:
    mov x0, x26
    ldr x1, [sp, #16]
    add x2, sp, #40
    bl _napi_get_array_length
    ldr w9, [sp, #40]
    str x9, [sp, #48]           // n
    ldr x10, [sp, #24]
    mov w11, #7
    strb w11, [x10]
    str x9, [x10, #1]
    add x10, x10, #9
    str x10, [sp, #56]
    str xzr, [sp, #64]
.Lenc_al:
    ldr x9, [sp, #64]
    ldr x10, [sp, #48]
    cmp x9, x10
    b.hs .Lenc_adone
    mov x0, x26
    ldr x1, [sp, #16]
    ldr x2, [sp, #64]
    add x3, sp, #88
    bl _napi_get_element
    ldr x0, [sp, #88]
    ldr x1, [sp, #56]
    bl _azn_encval
    cmp x0, #-1
    b.eq .Lenc_neg
    ldr x9, [sp, #56]
    add x9, x9, x0
    str x9, [sp, #56]
    ldr x9, [sp, #64]
    add x9, x9, #1
    str x9, [sp, #64]
    b .Lenc_al
.Lenc_adone:
    ldr x0, [sp, #56]
    ldr x9, [sp, #24]
    sub x0, x0, x9
    b .Lenc_out
.Lenc_neg:
    mov x0, #-1
.Lenc_out:
    ldp x29, x30, [sp], #160
    ret

// ---- 0x07 UNION ----
// op|nopts(8)|fields[n]|uidx(8) — try each option; rollback err ctx per
// failed option; all fail -> invalid_union + _u=uidx
.Ln_union:
    ldr x9, [x27, #1]         // nopts
    str x9, [sp, #LN_A]
    add x10, x27, #9
    str x10, [sp, #LN_B]      // field cursor
    // save err ctx for rollback
    str x21, [sp, #LN_C]      // err cursor
    ldr x9, [x22]
    str x9, [sp, #LN_D]       // issue count
    ldr x9, [x22, #8]
    str x9, [sp, #LN_E]       // path depth
    ldr x9, [x22, #16]
    str x9, [sp, #LN_F]       // patch ptr
.Ln_un_loop:
    ldr x9, [sp, #LN_A]
    cbz x9, .Ln_un_allfail
    ldr x12, [sp, #LN_B]
    ldr x0, [x12]
    add x0, x12, x0           // child node
    mov x1, x28
    mov x2, x19
    bl _aznapi_run
    cmp x0, #0
    b.eq .Ln_ret              // success — out written
    cmp x0, #-2
    b.ne .Ln_ret              // hard error propagates
    // rollback err ctx, next option
    ldr x21, [sp, #LN_C]
    ldr x9, [sp, #LN_D]
    str x9, [x22]
    ldr x9, [sp, #LN_E]
    str x9, [x22, #8]
    ldr x9, [sp, #LN_F]
    str x9, [x22, #16]
    ldr x12, [sp, #LN_B]
    add x12, x12, #8
    str x12, [sp, #LN_B]
    ldr x9, [sp, #LN_A]
    sub x9, x9, #1
    str x9, [sp, #LN_A]
    b .Ln_un_loop
.Ln_un_allfail:
    mov x0, #3                // invalid_union
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Ln_ret
    ldr x9, [x27, #1]
    lsl x9, x9, #3
    add x9, x9, #9
    ldr x10, [x27, x9]        // uidx at node+9+8n
    ucvtf d0, x10
    AZ_ADR x0, .Lnk_u
    mov x1, #2
    bl _az_issue_f_f64
    cbnz x0, .Ln_ret
    bl _az_issue_commit
    mov x0, #-2
    b .Ln_ret

// ---- 0x09 LITERAL ----
// tagged value at node+1; miss -> -10 (correct invalid_value via FFI)
.Ln_lit:
    mov x0, x28
    bl _azn_typeof
    add x10, x27, #1
    ldrb w9, [x10]            // literal tag
    cmp w9, #0
    b.eq .Ln_lit_undef
    cmp w9, #1
    b.eq .Ln_lit_null
    cmp w9, #2
    b.eq .Ln_lit_bool
    cmp w9, #3
    b.eq .Ln_lit_num
    cmp w9, #4
    b.eq .Ln_lit_str
    cmp w9, #5
    b.eq .Ln_lit_big
    mov x0, #-10
    b .Ln_ret
.Ln_lit_undef:
    cmp w0, #NAPI_UNDEF
    b.eq .Ln_lit_hit
    b .Ln_lit_miss
.Ln_lit_null:
    cmp w0, #NAPI_NULL
    b.eq .Ln_lit_hit
    b .Ln_lit_miss
.Ln_lit_bool:
    cmp w0, #NAPI_BOOL
    b.ne .Ln_lit_miss
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    bl _napi_get_value_bool
    ldrb w9, [sp, #LN_A]
    ldrb w11, [x27, #2]       // literal bool byte (tag@+1, val@+2)
    cmp w9, w11
    b.eq .Ln_lit_hit
    b .Ln_lit_miss
.Ln_lit_num:
    cmp w0, #NAPI_NUM
    b.ne .Ln_lit_miss
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    bl _napi_get_value_double
    ldr d0, [sp, #LN_A]
    ldr d1, [x27, #2]
    fcmp d0, d1
    b.eq .Ln_lit_hit
    fcmp d0, d0
    b.vc .Ln_lit_miss
    fcmp d1, d1
    b.vs .Ln_lit_hit
    b .Ln_lit_miss
.Ln_lit_big:
    cmp w0, #NAPI_BIG
    b.ne .Ln_lit_miss
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    mov x3, #0
    bl _napi_get_value_bigint_int64
    ldr x9, [sp, #LN_A]
    ldr x11, [x27, #2]
    cmp x9, x11
    b.eq .Ln_lit_hit
    b .Ln_lit_miss
.Ln_lit_str:
    cmp w0, #NAPI_STR
    b.ne .Ln_lit_miss
    bl _azn_getstr
    cmp x0, #-1
    b.eq .Ln_toobig
    ldr x9, [x27, #2]         // lit len
    cmp x9, x0
    b.ne .Ln_lit_miss
    add x0, x27, #10          // lit bytes
    mov x1, x20
    mov x2, x9
    bl _az_memeq
    cbnz x0, .Ln_lit_hit
    b .Ln_lit_miss
.Ln_lit_hit:
    str x28, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_lit_miss:
    mov x0, #1                 // invalid_literal
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Ln_ret
    add x2, x27, #1            // embedded value bytes
    str x2, [sp, #LN_A]
    mov x0, x2
    bl _az_vsize
    mov x3, x0
    AZ_ADR x0, .Ln_k_expected
    mov x1, #8
    ldr x2, [sp, #LN_A]
    bl _az_issue_f_rawval
    cbnz x0, .Ln_ret
    bl _az_issue_commit
    mov x0, #-2
    b .Ln_ret

// ---- 0x0A ENUM ----
// nvals | [len+bytes]*n — input must be string; miss -> -10
.Ln_enum:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_STR
    b.ne .Ln_enum_miss
    bl _azn_getstr
    cmp x0, #-1
    b.eq .Ln_toobig
    str x0, [sp, #LN_A]       // inlen
    add x10, x27, #1
    ldr x9, [x10]
    str x9, [sp, #LN_B]       // nvals
    add x10, x10, #8
    str x10, [sp, #LN_C]      // cursor
.Ln_enum_loop:
    ldr x9, [sp, #LN_B]
    cbz x9, .Ln_enum_miss
    ldr x10, [sp, #LN_C]
    ldr x9, [x10]             // vallen
    ldr x11, [sp, #LN_A]
    cmp x9, x11
    b.ne .Ln_enum_next
    add x0, x10, #8           // valbytes
    mov x1, x20
    mov x2, x9
    bl _az_memeq
    cbnz x0, .Ln_lit_hit
.Ln_enum_next:
    ldr x10, [sp, #LN_C]
    ldr x9, [x10]
    add x10, x10, x9
    add x10, x10, #8
    str x10, [sp, #LN_C]
    ldr x9, [sp, #LN_B]
    sub x9, x9, #1
    str x9, [sp, #LN_B]
    b .Ln_enum_loop
.Ln_enum_miss:
    mov x0, #4                 // invalid_enum_value
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Ln_ret
    // received = encoded input at scratch+1.5MB
    mov x12, #1572864
    add x9, x20, x12
    str x9, [sp, #LN_A]
    mov x0, x28
    mov x1, x9
    bl _azn_encval
    cmp x0, #-1
    b.eq .Ln_enum_fallback
    mov x3, x0
    AZ_ADR x0, .Lnk_received
    mov x1, #8
    ldr x2, [sp, #LN_A]
    bl _az_issue_f_rawval
    cbnz x0, .Ln_ret
    // options = strseq(node+9, n)
    AZ_ADR x0, .Lnk_options
    mov x1, #7
    add x2, x27, #9
    ldr x3, [x27, #1]
    bl _az_issue_f_strseq
    cbnz x0, .Ln_ret
    bl _az_issue_commit
    mov x0, #-2
    b .Ln_ret
.Ln_enum_fallback:
    mov x0, #-10
    b .Ln_ret

// ---- 0x06 ARRAY ----
// op|elemField(8)|min(8)|max(8)|exact(1)|elem
.Ln_arr:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_OBJ
    b.ne .Ln_arr_fail
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    bl _napi_is_array
    ldrb w9, [sp, #LN_A]
    cbz w9, .Ln_arr_fail
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    bl _napi_get_array_length
    ldr w9, [sp, #LN_A]       // u32 out-param
    str x9, [sp, #LN_A]       // n
    str xzr, [sp, #LN_H]      // failed-any
    ldr x10, [x27, #9]        // min (u64, -1 = absent)
    cmp x10, #-1
    b.eq .Ln_arr_chkmax
    cmp x9, x10
    b.hs .Ln_arr_chkmax
    mov x0, #0
    mov x1, x10
    ldr x2, [sp, #LN_A]
    ldrb w3, [x27, #25]
    AZ_ADR x4, .Ls_array
    mov x5, #5
    bl _az_issue_size_n
    mov x9, #1
    str x9, [sp, #LN_H]
.Ln_arr_chkmax:
    ldr x10, [x27, #17]       // max
    cmp x10, #-1
    b.eq .Ln_arr_lenok
    ldr x9, [sp, #LN_A]
    cmp x9, x10
    b.ls .Ln_arr_lenok
    mov x0, #1
    mov x1, x10
    ldr x2, [sp, #LN_A]
    ldrb w3, [x27, #25]
    AZ_ADR x4, .Ls_array
    mov x5, #5
    bl _az_issue_size_n
    mov x9, #1
    str x9, [sp, #LN_H]
.Ln_arr_lenok:
    mov x0, x26
    ldr x1, [sp, #LN_A]
    add x2, sp, #LN_B
    bl _napi_create_array_with_length
    ldr x9, [sp, #LN_B]
    str x9, [sp, #LN_B]       // outarr
    str xzr, [sp, #LN_C]      // i
.Ln_arr_loop:
    ldr x9, [sp, #LN_C]
    ldr x10, [sp, #LN_A]
    cmp x9, x10
    b.hs .Ln_arr_done
    mov x0, x26
    mov x1, x28
    mov x2, x9
    add x3, sp, #LN_D
    bl _napi_get_element
    ldr x0, [sp, #LN_C]
    bl _az_path_push_idx
    add x12, x27, #1
    ldr x0, [x12]
    add x0, x12, x0           // elem node
    ldr x1, [sp, #LN_D]
    add x2, sp, #LN_D
    bl _aznapi_run
    str x0, [sp, #LN_E]
    bl _az_path_pop
    ldr x0, [sp, #LN_E]
    cmp x0, #-2
    b.ne .Ln_arr_elemst       // 0 ok / hard error
    mov x9, #1
    str x9, [sp, #LN_H]
    b .Ln_arr_next
.Ln_arr_elemst:
    cbnz x0, .Ln_ret
    mov x0, x26
    ldr x1, [sp, #LN_B]
    ldr x2, [sp, #LN_C]
    ldr x3, [sp, #LN_D]
    bl _napi_set_element
.Ln_arr_next:
    ldr x9, [sp, #LN_C]
    add x9, x9, #1
    str x9, [sp, #LN_C]
    b .Ln_arr_loop
.Ln_arr_done:
    ldr x9, [sp, #LN_H]
    cbnz x9, .Ln_arr_failed
    ldr x9, [sp, #LN_B]
    str x9, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_arr_failed:
    mov x0, #-2
    b .Ln_ret
.Ln_arr_fail:
    AZ_ADR x0, .Lex_array
    mov x1, #5
    bl _azn_issue_type
    cmp x0, #-2
    b.ne .Ln_ret
    mov x0, x28
    bl _azn_input_len
    cmp x0, #-1
    b.eq .Ln_arr_fin
    str x0, [sp, #LN_B]       // units
    ldr x12, [x27, #9]        // min
    ldr x13, [x27, #17]       // max
    stp x12, x13, [sp, #LN_C]
    mov x0, x28
    bl _azn_origin
    stp x0, x1, [sp, #LN_E]   // origin ptr/len
    ldr x12, [sp, #LN_C]
    cmp x12, #-1
    b.eq .Ln_arr_fmax
    ldr x13, [sp, #LN_B]
    cmp x13, x12
    b.hs .Ln_arr_fmax
    mov x0, #8
    b .Ln_arr_femit
.Ln_arr_fmax:
    ldr x12, [sp, #LN_D]
    cmp x12, #-1
    b.eq .Ln_arr_fin
    ldr x13, [sp, #LN_B]
    cmp x13, x12
    b.ls .Ln_arr_fin
    mov x0, #9
.Ln_arr_femit:
    ucvtf d0, x12
    fmov x3, d0
    ldp x1, x2, [sp, #LN_E]
    mov w4, #1
    ldrb w5, [x27, #25]
    mov x6, #0
    mov x7, #0
    bl _az_issue_size
.Ln_arr_fin:
    mov x0, #-2
    b .Ln_ret

// ---- 0x05 OBJECT ----
// op|mode(1)|catchallField(8)|nkeys(8)|[klen+key]*n|[field]*n
.Ln_obj:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_OBJ
    b.ne .Ln_obj_fail
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    bl _napi_is_array
    ldrb w9, [sp, #LN_A]
    cbnz w9, .Ln_obj_fail
    // proto == Object.prototype | null else -11
    b .Ln_obj_mode            // BISECT: skip proto check
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    bl _napi_get_prototype
    ldr x10, [sp, #LN_A]
    cbz x10, .Ln_obj_mode
    mov x0, x26
    add x1, sp, #LN_B
    bl _napi_get_global
    ldr x1, [sp, #LN_B]
    mov x0, x26
    AZ_ADR x2, .Ls_Objstr
    add x3, sp, #LN_B
    bl _napi_get_named_property
    cbnz x0, .Ln_obj_exotic
    ldr x1, [sp, #LN_B]
    mov x0, x26
    AZ_ADR x2, .Ls_protoname
    add x3, sp, #LN_B
    bl _napi_get_named_property
    cbnz x0, .Ln_obj_exotic
    ldr x1, [sp, #LN_A]       // proto
    ldr x2, [sp, #LN_B]       // Object.prototype
    mov x0, x26
    add x3, sp, #LN_C
    bl _napi_strict_equals
    ldrb w9, [sp, #LN_C]
    cbz w9, .Ln_obj_exotic
.Ln_obj_mode:
    ldrb w9, [x27, #1]
    cbnz w9, .Ln_obj_unsup    // v1: strip only
    ldr x9, [x27, #2]
    cbnz x9, .Ln_obj_unsup    // catchall -> FFI
    mov x0, x26
    add x1, sp, #LN_A
    bl _napi_create_object
    ldr x9, [sp, #LN_A]
    str x9, [sp, #LN_A]       // outobj
    // records are interleaved: [klen][key][field]*n starting at node+18
    add x10, x27, #18
    str x10, [sp, #LN_B]      // record cursor
    ldr x9, [x27, #10]
    str x9, [sp, #LN_D]       // remaining
    str xzr, [sp, #LN_I]      // failed-any
.Ln_obj_loop:
    ldr x9, [sp, #LN_D]
    cbz x9, .Ln_obj_done
    ldr x10, [sp, #LN_B]
    ldr x13, [x10]
    str x13, [sp, #LN_E]      // klen
    add x14, x10, #8
    str x14, [sp, #LN_F]      // kptr
    add x15, x14, x13
    str x15, [sp, #LN_C]      // field addr (right after key bytes)
    // key as napi_value (avoids scratch-race with inner runs)
    mov x0, x26
    ldr x1, [sp, #LN_F]
    ldr x2, [sp, #LN_E]
    add x3, sp, #LN_J
    bl _napi_create_string_utf8
    mov x0, x26
    mov x1, x28
    ldr x2, [sp, #LN_J]
    add x3, sp, #LN_G
    bl _napi_get_property
    // path push
    ldr x0, [sp, #LN_F]
    ldr x1, [sp, #LN_E]
    bl _az_path_push_key
    // recurse on prop
    ldr x12, [sp, #LN_C]
    ldr x0, [x12]
    add x0, x12, x0           // node = fldaddr + reloff
    ldr x1, [sp, #LN_G]
    add x2, sp, #LN_G
    bl _aznapi_run
    str x0, [sp, #LN_H]
    bl _az_path_pop
    ldr x0, [sp, #LN_H]
    cmp x0, #-2
    b.ne .Ln_obj_st           // 0 ok / hard error
    mov x9, #1
    str x9, [sp, #LN_I]
    b .Ln_obj_adv
.Ln_obj_st:
    cbnz x0, .Ln_ret
    // set_property(outobj, key, outval)
    mov x0, x26
    ldr x1, [sp, #LN_A]
    ldr x2, [sp, #LN_J]
    ldr x3, [sp, #LN_G]
    bl _napi_set_property
.Ln_obj_adv:
    // advance: record = klen(8) + key + field(8)
    ldr x10, [sp, #LN_B]
    ldr x9, [x10]
    add x10, x10, x9
    add x10, x10, #16
    str x10, [sp, #LN_B]
    ldr x9, [sp, #LN_D]
    sub x9, x9, #1
    str x9, [sp, #LN_D]
    b .Ln_obj_loop
.Ln_obj_done:
    ldr x9, [sp, #LN_I]
    cbnz x9, .Ln_obj_failed
    ldr x9, [sp, #LN_A]
    str x9, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_obj_failed:
    mov x0, #-2
    b .Ln_ret
.Ln_obj_exotic:
    mov x0, #-11
    b .Ln_ret
.Ln_obj_unsup:
    mov x0, #-12
    b .Ln_ret
.Ln_obj_fail:
    AZ_ADR x0, .Lex_object
    mov x1, #6
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret

// ---- 0x13 TUPLE ----
// op|n(8)|field[n]|restField(8)|minItems(8)|optoutStart(8)
.Ln_tup:
    mov x0, x28
    bl _azn_typeof
    cmp w0, #NAPI_OBJ
    b.ne .Ln_tup_fail
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_A
    bl _napi_is_array
    ldrb w9, [sp, #LN_A]
    cbz w9, .Ln_tup_fail
    // layout: op|n(8)|fields[n]|restField|minItems|optoutStart
    ldr x11, [x27, #1]        // n items
    add x12, x27, #9
    lsl x13, x11, #3
    add x12, x12, x13         // restField slot
    ldr x9, [x12]
    cbnz x9, .Ln_tup_unsup    // rest -> FFI
    str x11, [sp, #LN_A]      // n
    str x12, [sp, #LN_B]      // restField addr (base of min/optout)
    mov x0, x26
    mov x1, x28
    add x2, sp, #LN_C
    bl _napi_get_array_length
    ldr w9, [sp, #LN_C]       // u32 out-param
    str x9, [sp, #LN_C]       // nin
    str xzr, [sp, #LN_I]      // lenfail
    ldr x12, [sp, #LN_B]
    ldr x15, [x12, #8]        // minItems
    cmp x9, x15
    b.hs .Ln_tup_overchk
    // under-length + no rest: too_small(_nc), skip elements entirely
    AZ_ADR x9, az_nc_flag
    mov w10, #1
    strb w10, [x9]
    mov x0, #0
    mov x1, x15
    ldr x2, [sp, #LN_C]
    mov x3, #0
    AZ_ADR x4, .Ls_array
    mov x5, #5
    bl _az_issue_size_n
    AZ_ADR x9, az_nc_flag
    strb wzr, [x9]
    mov x0, #-2
    b .Ln_ret
.Ln_tup_overchk:
    ldr x11, [sp, #LN_A]
    cmp x9, x11
    b.ls .Ln_tup_lenok
    // over-length + no rest: too_big(_nc), elements still validated
    AZ_ADR x9, az_nc_flag
    mov w10, #1
    strb w10, [x9]
    mov x0, #1
    ldr x1, [sp, #LN_A]
    ldr x2, [sp, #LN_C]
    mov x3, #0
    AZ_ADR x4, .Ls_array
    mov x5, #5
    bl _az_issue_size_n
    AZ_ADR x9, az_nc_flag
    strb wzr, [x9]
    mov x9, #1
    str x9, [sp, #LN_I]
.Ln_tup_lenok:
    ldr x12, [sp, #LN_B]
    ldr x15, [x12, #16]       // optoutStart
    // emitn = min(max(nin,optout), n)
    ldr x9, [sp, #LN_C]
    cmp x9, x15
    csel x16, x9, x15, hi
    ldr x11, [sp, #LN_A]
    cmp x16, x11
    csel x16, x16, x11, lo
    str x16, [sp, #LN_D]      // emitn
    str xzr, [sp, #LN_J]      // failed-any
    mov x0, x26
    mov x1, x16
    add x2, sp, #LN_E
    bl _napi_create_array_with_length
    ldr x9, [sp, #LN_E]
    str x9, [sp, #LN_E]       // outarr
    str xzr, [sp, #LN_F]      // i
.Ln_tup_loop:
    ldr x9, [sp, #LN_F]
    ldr x11, [sp, #LN_A]
    cmp x9, x11
    b.hs .Ln_tup_done
    // val = i<nin ? element : undefined
    ldr x13, [sp, #LN_C]
    cmp x9, x13
    b.hs .Ln_tup_undv
    mov x0, x26
    mov x1, x28
    mov x2, x9
    add x3, sp, #LN_G
    bl _napi_get_element
    b .Ln_tup_have
.Ln_tup_undv:
    mov x0, x26
    add x1, sp, #LN_G
    bl _napi_get_undefined
.Ln_tup_have:
    ldr x0, [sp, #LN_F]
    bl _az_path_push_idx
    // node = fields[i] at node+9+i*8
    add x12, x27, #9
    ldr x9, [sp, #LN_F]
    lsl x9, x9, #3
    add x12, x12, x9
    ldr x0, [x12]
    add x0, x12, x0
    ldr x1, [sp, #LN_G]
    add x2, sp, #LN_G
    bl _aznapi_run
    str x0, [sp, #LN_H]
    bl _az_path_pop
    ldr x0, [sp, #LN_H]
    cmp x0, #-2
    b.ne .Ln_tup_st
    mov x9, #1
    str x9, [sp, #LN_J]
    b .Ln_tup_skip
.Ln_tup_st:
    cbnz x0, .Ln_ret
    ldr x9, [sp, #LN_F]
    ldr x13, [sp, #LN_D]
    cmp x9, x13
    b.hs .Ln_tup_skip
    mov x0, x26
    ldr x1, [sp, #LN_E]
    mov x2, x9
    ldr x3, [sp, #LN_G]
    bl _napi_set_element
.Ln_tup_skip:
    ldr x9, [sp, #LN_F]
    add x9, x9, #1
    str x9, [sp, #LN_F]
    b .Ln_tup_loop
.Ln_tup_done:
    ldr x9, [sp, #LN_I]
    cbnz x9, .Ln_tup_lenfail
    ldr x9, [sp, #LN_J]
    cbnz x9, .Ln_tup_lenfail
    ldr x9, [sp, #LN_E]
    str x9, [x19]
    mov x0, #0
    b .Ln_ret
.Ln_tup_lenfail:
    mov x0, #-2
    b .Ln_ret
.Ln_tup_fail:
    AZ_ADR x0, .Lex_tuple
    mov x1, #5
    bl _azn_issue_type
    cbnz x0, .Ln_ret           // -4 etc propagate
    mov x0, #-2
    b .Ln_ret
.Ln_tup_unsup:
    mov x0, #-13
    b .Ln_ret

// ================= data =================
.Ls_nan:      .ascii "NaN\0"
.Ls_inf:      .ascii "Infinity\0"
.Ls_ninf:     .ascii "-Infinity\0"
.Ls_array:    .ascii "array\0"
.Ls_object:   .ascii "object\0"
.Ls_ctor:     .ascii "constructor\0"
.Ls_name:     .ascii "name\0"
.Ls_Objstr:   .ascii "Object\0"
.Ls_protoname:.ascii "prototype\0"
.Ls_length:   .ascii "length\0"
.Ls_unknown:  .ascii "unknown\0"
.Lex_string:     .ascii "string\0"
.Lex_number:     .ascii "number\0"
.Lex_boolean:    .ascii "boolean\0"
.Lex_bigint:     .ascii "bigint\0"
.Lex_never:      .ascii "never\0"
.Lex_null:       .ascii "null\0"
.Lex_undefined:  .ascii "undefined\0"
.Lex_nan:        .ascii "nan\0"
.Lex_symbol:     .ascii "symbol\0"
.Lex_array:      .ascii "array\0"
.Lex_object:     .ascii "object\0"
.Lex_tuple:      .ascii "tuple\0"
.Lex_nonoptional:.ascii "nonoptional\0"
.Ln_k_expected:  .ascii "expected\0"
.Lnk_u:          .ascii "_u\0"
.Lnk_received:   .ascii "received\0"
.Lnk_options:    .ascii "options\0"
.Ln_k_received:  .ascii "received\0"
    AZ_DATA
    .p2align 3
// typeof -> received-name table (idx = napi_valuetype, stride 16)
_azn_vtype_table:
    .quad .Lv_undefined, 9
    .quad .Lv_null, 4
    .quad .Lv_boolean, 7
    .quad .Lv_number, 6
    .quad .Lv_string, 6
    .quad .Lv_symbol, 6
    .quad .Ls_object, 6
    .quad .Lv_function, 8
    .quad .Ls_object, 6
    .quad .Lv_bigint, 6
.Lv_undefined: .ascii "undefined\0"
.Lv_null:      .ascii "null\0"
.Lv_boolean:   .ascii "boolean\0"
.Lv_number:    .ascii "number\0"
.Lv_string:    .ascii "string\0"
.Lv_symbol:    .ascii "symbol\0"
.Lv_function:  .ascii "function\0"
.Lv_bigint:    .ascii "bigint\0"
    .text
