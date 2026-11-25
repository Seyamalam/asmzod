#include "portx.h"
// validate.s — x86-64 port. az_validate: recursive schema bytecode interpreter
//
//   az_validate(rdi=node, rsi=val) -> rax status, rdx=out ptr, rcx=out len
//     0 ok  -2 invalid  -3 out_val ENOSPC  -4 out_err ENOSPC
//     -5 host callback threw  -1 malformed bytecode
//
// frame: node/val live in stack slots (all callee-saved regs are ctx):
//   [rsp+16] = node   [rsp+24] = val   — same offsets as arm64 x27/x28 saves
//   rsp stays 16-aligned inside: entry%16=8, push rbx -> 0, sub 512 -> 0
// LD_NODE/LD_VAL reload; handlers may cache in scratch but never assume
// survival across calls.
#define LD_NODE mov r8, [rsp+16]
#define LD_VAL  mov r9, [rsp+24]
    .text
    .p2align 4

    .globl AZX_NAPI(az_validate)
    AZX_HIDDEN AZX_NAPI(az_validate)
AZX_NAPI(az_validate):
    push rbx
    sub rsp, 512
    mov [rsp + 16], rdi      // node
    mov [rsp + 24], rsi      // val
.Lxv_dispatch:
    LD_NODE
    movzx eax, byte ptr [r8]
    cmp eax, 0x2A
    je .Lxv_msgnode
    cmp eax, 0x25
    ja .Lxv_badop
    lea r10, [rip + .Lxv_jt]
    mov r11, [r10 + rax*8]
    jmp r11

// 0x2A msgwrap: [op][u64 msglen][msg][i64 rel -> inner node]
.Lxv_msgnode:
    LD_NODE
    LD_VAL
    mov r10, [r8 + 1]        // msglen
    lea r11, [r8 + 9]        // msgptr
    lea rcx, [r11 + r10]     // -> rel field
    lea rax, [rip + AZX_NAPI(az_msgstack)]
    mov rdx, [rax]
    cmp rdx, 64
    jae .Lxv_msg_skip
    imul rdx, rdx, 24
    lea rdx, [rax + rdx + 8] // slot
    mov rax, [r13 + 8]       // path depth
    mov [rdx], rax
    mov [rdx + 8], r11
    mov [rdx + 16], r10
    lea rax, [rip + AZX_NAPI(az_msgstack)]
    mov rdx, [rax]
    inc rdx
    mov [rax], rdx
    mov r10, [rcx]           // rel
    lea rdi, [rcx + r10]     // inner node
    mov rsi, r9              // val
    call AZX_NAPI(az_validate)
    lea rcx, [rip + AZX_NAPI(az_msgstack)]
    mov rdx, [rcx]
    dec rdx
    js .Lxv_ret
    mov [rcx], rdx
    jmp .Lxv_ret
.Lxv_msg_skip:
    mov r10, [rcx]
    lea rax, [rcx + r10]
    mov [rsp + 16], rax      // node = inner
    jmp .Lxv_dispatch

// ---------- shared exits ----------
.Lxv_ret:
    add rsp, 512
    pop rbx
    ret
.Lxv_invalid:
    mov rax, -2
    jmp .Lxv_ret
.Lxv_badop:
    mov rax, -1
    jmp .Lxv_ret
// out = whole input
.Lxv_pass:
    LD_VAL
    mov rdi, r9
    call AZX_NAPI(az_vsize)
    mov rcx, rax             // out len
    mov rdx, r9              // out ptr — wait: vsize clobbered r9? it preserves (leaf)
    xor eax, eax
    jmp .Lxv_ret
// out = scalar input, r10 = size (set before jumping here)
.Lxv_passn:
    mov rcx, r10
    mov rdx, r9
    xor eax, eax
    jmp .Lxv_ret
// tail-dispatch to child: rax = addr of i64 self-rel offset field
.Lxv_tail:
    mov r10, [rax]
    add rax, r10
    mov [rsp + 16], rax      // node = child
    LD_NODE
    movzx eax, byte ptr [rax]
    cmp eax, 0x2A
    je .Lxv_msgnode
    cmp eax, 0x25
    ja .Lxv_badop
    movzx eax, byte ptr [rax]
    lea r10, [rip + .Lxv_jt]
    mov r11, [r10 + rax*8]
    jmp r11
// type issue helper: rdi=expptr rsi=explen -> emit invalid_type then -2/-4
.Lxaz_vtype:
    LD_VAL
    movzx edx, byte ptr [r9]
    mov rcx, r9
    call AZX_NAPI(az_issue_type)
    test rax, rax
    jnz .Lxv_ret             // -4 propagate
    jmp .Lxv_invalid

// ---------- 0x01 STRING ----------
.Lxv_string:
    LD_VAL
    cmp byte ptr [r9], 4
    je .Lxvs_tok
    lea rdi, [rip + .Lexx_string]
    mov esi, 6
    jmp .Lxaz_vtype
.Lxvs_tok:
    LD_NODE
    movzx eax, byte ptr [r8 + 1]
    test eax, eax
    jz .Lxvs_ok
    lea rdi, [r8 + 2]
    mov esi, eax
    mov rdx, r9
    add rdx, 9               // str bytes
    mov rcx, [r9 + 1]        // len
    call AZX_NAPI(az_run_strchecks)
    test rax, rax
    jnz .Lxv_ret
.Lxvs_ok:
    LD_VAL
    mov r10, [r9 + 1]
    add r10, 9
    jmp .Lxv_passn

// ---------- 0x02 NUMBER ----------
.Lxv_number:
    LD_VAL
    cmp byte ptr [r9], 3
    je .Lxvn_tok
.Lxvn_fail:
    lea rdi, [rip + .Lexx_number]
    mov esi, 6
    jmp .Lxaz_vtype
.Lxvn_tok:
    movsd xmm0, [r9 + 1]
    ucomisd xmm0, xmm0
    jnp .Lxvn_infchk
    jmp .Lxvn_fail           // NaN
.Lxvn_infchk:
    // zod4: +-Infinity is not a valid z.number()
    psllq xmm0, 1            // abs: shift sign bit out (64-bit lane)
    psrlq xmm0, 1
    mov rax, 0x7FF0000000000000
    movq xmm1, rax
    ucomisd xmm0, xmm1
    je .Lxvn_fail
    LD_NODE
    movzx eax, byte ptr [r8 + 1]
    test eax, eax
    jz .Lxvn_ok
    lea rdi, [r8 + 2]
    mov esi, eax
    LD_VAL
    movsd xmm0, [r9 + 1]
    mov rdx, r9
    call AZX_NAPI(az_run_numchecks)
    test rax, rax
    jnz .Lxv_ret
.Lxvn_ok:
    LD_VAL
    mov r10d, 9
    jmp .Lxv_passn

// ---------- 0x03 BOOLEAN ----------
.Lxv_boolean:
    LD_VAL
    cmp byte ptr [r9], 2
    je .Lxvb_ok
    lea rdi, [rip + .Lexx_boolean]
    mov esi, 7
    jmp .Lxaz_vtype
.Lxvb_ok:
    mov r10d, 2
    jmp .Lxv_passn

// ---------- 0x04 BIGINT ----------
.Lxv_bigint:
    LD_VAL
    cmp byte ptr [r9], 5
    je .Lxvb_tok
    lea rdi, [rip + .Lexx_bigint]
    mov esi, 6
    jmp .Lxaz_vtype
.Lxvb_tok:
    LD_NODE
    movzx eax, byte ptr [r8 + 1]
    test eax, eax
    jz .Lxvb_ok2
    lea rdi, [r8 + 2]
    mov esi, eax
    LD_VAL
    mov rdx, [r9 + 1]
    mov rcx, r9
    call AZX_NAPI(az_run_bigintchecks)
    test rax, rax
    jnz .Lxv_ret
.Lxvb_ok2:
    LD_VAL
    mov r10d, 9
    jmp .Lxv_passn

// ---------- 0x17 NULL_T ----------
.Lxv_nullt:
    LD_VAL
    cmp byte ptr [r9], 1
    je .Lxvnul_ok
    lea rdi, [rip + .Lexx_null]
    mov esi, 4
    jmp .Lxaz_vtype
.Lxvnul_ok:
    mov r10d, 1
    jmp .Lxv_passn

// ---------- 0x18 UNDEF_T ----------
.Lxv_undeft:
    LD_VAL
    cmp byte ptr [r9], 0
    je .Lxvund_ok
    lea rdi, [rip + .Lexx_undefined]
    mov esi, 9
    jmp .Lxaz_vtype
.Lxvund_ok:
    mov r10d, 1
    jmp .Lxv_passn

// ---------- 0x19 NAN ----------
.Lxv_nan:
    LD_VAL
    cmp byte ptr [r9], 3
    jne .Lxvnan_no
    movsd xmm0, [r9 + 1]
    ucomisd xmm0, xmm0
    jp .Lxvnan_ok            // unordered -> NaN
.Lxvnan_no:
    lea rdi, [rip + .Lexx_nan]
    mov esi, 3
    jmp .Lxaz_vtype
.Lxvnan_ok:
    mov r10d, 9
    jmp .Lxv_passn

// ---------- 0x15 ANY / UNKNOWN ----------
.Lxv_any:
    jmp .Lxv_pass

// ---------- 0x16 NEVER ----------
.Lxv_never:
    lea rdi, [rip + .Lexx_never]
    mov esi, 5
    jmp .Lxaz_vtype

// ---------- 0x21 SYMBOL (HOSTREF kind 1) ----------
.Lxv_symbol:
    LD_VAL
    cmp byte ptr [r9], 8
    jne .Lxvsym_no
    mov rax, [r15 + 24]      // cb_host
    mov edi, 2               // kind2 hostref-kind-check
    mov esi, 1               // subtype symbol
    mov rdx, [r9 + 1]
    xor ecx, ecx
    call rax
    test rax, rax
    jz .Lxvsym_no
    mov r10d, 9
    jmp .Lxv_passn
.Lxvsym_no:
    lea rdi, [rip + .Lexx_symbol]
    mov esi, 6
    jmp .Lxaz_vtype

// ---------- 0x0B OPTIONAL ----------
.Lxv_optional:
    LD_VAL
    cmp byte ptr [r9], 0
    jne .Lxvopt_inner
    mov r10d, 1
    jmp .Lxv_passn
.Lxvopt_inner:
    LD_NODE
    lea rax, [r8 + 1]
    jmp .Lxv_tail

// ---------- 0x0C NULLABLE ----------
.Lxv_nullable:
    LD_VAL
    cmp byte ptr [r9], 1
    jne .Lxvnull_inner
    mov r10d, 1
    jmp .Lxv_passn
.Lxvnull_inner:
    LD_NODE
    lea rax, [r8 + 1]
    jmp .Lxv_tail

// ---------- 0x0D DEFAULT ----------
// [op][inner i64][embedded Value @+9]
.Lxv_default:
    LD_VAL
    cmp byte ptr [r9], 0
    je .Lxvdef_use
    mov rsi, r9
    jmp .Lxvdef_go
.Lxvdef_use:
    LD_NODE
    lea rsi, [r8 + 9]        // embedded default value
.Lxvdef_go:
    LD_NODE
    lea rax, [r8 + 1]
    mov r10, [rax]
    lea rdi, [rax + r10]     // inner node
    call AZX_NAPI(az_validate)
    jmp .Lxv_ret

// ---------- 0x0E CATCH ----------
// [op][inner i64][embedded Value @+9]
.Lxv_catch:
    mov [rsp + 32], rbx      // val pos
    mov [rsp + 40], rbp      // pair pos
    mov [rsp + 48], r12      // err pos
    mov rax, [r13]           // issue_count
    mov rcx, [r13 + 8]       // depth
    mov [rsp + 64], rax
    mov [rsp + 72], rcx
    LD_NODE
    lea rax, [r8 + 1]
    mov r10, [rax]
    lea rdi, [rax + r10]
    LD_VAL
    mov rsi, r9
    call AZX_NAPI(az_validate)
    test rax, rax
    jz .Lxv_ret              // ok
    cmp rax, -2
    jne .Lxv_ret             // -3/-4/-5 propagate
    mov rbx, [rsp + 32]
    mov rbp, [rsp + 40]
    mov r12, [rsp + 48]
    mov rax, [rsp + 64]
    mov rcx, [rsp + 72]
    mov [r13], rax
    mov [r13 + 8], rcx
    // out = embedded catch value (ref into schema blob)
    LD_NODE
    lea rdi, [r8 + 9]
    call AZX_NAPI(az_vsize)
    mov rcx, rax
    LD_NODE
    lea rdx, [r8 + 9]
    xor eax, eax
    jmp .Lxv_ret

// ---------- 0x09 LITERAL ----------
// [op][embedded scalar Value]
.Lxv_literal:
    LD_NODE
    LD_VAL
    movzx eax, byte ptr [r8 + 1]   // lit tag
    movzx ecx, byte ptr [r9]       // in tag
    cmp eax, ecx
    jne .Lxlit_fail
    cmp eax, 0
    je .Lxlit_ok
    cmp eax, 1
    je .Lxlit_ok
    cmp eax, 2
    je .Lxlit_bool
    cmp eax, 3
    je .Lxlit_f64
    cmp eax, 4
    je .Lxlit_str
    cmp eax, 5
    je .Lxlit_f64                // bigint: same 8-byte compare
    jmp .Lxlit_fail
.Lxlit_bool:
    movzx eax, byte ptr [r8 + 2]
    cmp al, [r9 + 1]
    je .Lxlit_ok
    jmp .Lxlit_fail
.Lxlit_f64:
    mov rax, [r8 + 2]
    cmp rax, [r9 + 1]
    je .Lxlit_ok
    jmp .Lxlit_fail
.Lxlit_str:
    mov rax, [r8 + 2]        // lit len
    cmp rax, [r9 + 1]        // in len
    jne .Lxlit_fail
    lea rdi, [r8 + 10]
    lea rsi, [r9 + 9]
    mov rdx, rax
    call AZX_NAPI(az_memeq)
    test eax, eax
    jz .Lxlit_fail
.Lxlit_ok:
    jmp .Lxv_pass
.Lxlit_fail:
    mov edi, 1               // invalid_literal
    xor esi, esi
    xor edx, edx
    call AZX_NAPI(az_issue_begin)
    test rax, rax
    jnz .Lxv_ret
    LD_NODE
    lea rdi, [r8 + 1]
    call AZX_NAPI(az_vsize)
    mov rcx, rax             // vlen
    LD_NODE
    lea rdx, [r8 + 1]        // vptr
    lea rdi, [rip + .Lxk_expected2]
    mov esi, 8
    call AZX_NAPI(az_issue_f_rawval)
    test rax, rax
    jnz .Lxv_ret
    call AZX_NAPI(az_issue_commit)
    jmp .Lxv_invalid

// ---------- 0x0A ENUM ----------
// [op][u64 n][entries: u64 len + bytes]*
// scan state in frame slots: [rsp+96]=cursor [rsp+104]=remaining
.Lxv_enum:
    LD_VAL
    cmp byte ptr [r9], 4
    jne .Lxen_fail
    LD_NODE
    mov rax, [r8 + 1]        // n
    mov [rsp + 104], rax
    lea rax, [r8 + 9]
    mov [rsp + 96], rax      // cursor
.Lxen_loop:
    mov rax, [rsp + 104]
    test rax, rax
    jz .Lxen_fail
    LD_VAL
    mov rcx, [r9 + 1]        // in len
    mov r10, [rsp + 96]
    mov rax, [r10]           // entry len
    cmp rax, rcx
    jne .Lxen_next
    lea rdi, [r9 + 9]        // in ptr
    mov rsi, [rsp + 96]
    add rsi, 8
    mov rdx, rcx
    call AZX_NAPI(az_memeq)
    test eax, eax
    jnz .Lxen_ok
.Lxen_next:
    mov r10, [rsp + 96]
    mov rax, [r10]
    lea r10, [r10 + rax + 8]
    mov [rsp + 96], r10
    dec qword ptr [rsp + 104]
    jmp .Lxen_loop
.Lxen_ok:
    LD_VAL
    mov r10, [r9 + 1]
    add r10, 9
    jmp .Lxv_passn
.Lxen_fail:
    // invalid_enum_value {received: rawval, options: strseq}
    mov edi, 4
    xor esi, esi
    xor edx, edx
    call AZX_NAPI(az_issue_begin)
    test rax, rax
    jnz .Lxv_ret
    LD_VAL
    mov rdi, r9
    call AZX_NAPI(az_vsize)
    mov rcx, rax
    LD_VAL
    mov rdx, r9
    lea rdi, [rip + .Lxk_received2]
    mov esi, 8
    call AZX_NAPI(az_issue_f_rawval)
    test rax, rax
    jnz .Lxv_ret
    LD_NODE
    lea rdx, [r8 + 9]        // seqptr
    mov rcx, [r8 + 1]        // count
    lea rdi, [rip + .Lxk_options]
    mov esi, 7
    call AZX_NAPI(az_issue_f_strseq)
    test rax, rax
    jnz .Lxv_ret
    call AZX_NAPI(az_issue_commit)
    jmp .Lxv_invalid

// ---------- 0x07 UNION ----------
// [op][u64 n][n x i64 optoffs]
// slots: [rsp+32]=nopts-remaining [rsp+48]=optseq cursor
//        [rsp+64/72]=rbx/rbp snap [rsp+80]=r12 snap [rsp+96/104]=err cnt/depth
.Lxv_union:
    LD_NODE
    mov rax, [r8 + 1]
    mov [rsp + 32], rax      // nopts
    lea rax, [r8 + 9]
    mov [rsp + 48], rax      // optseq cursor
.Lxun_loop:
    mov rax, [rsp + 32]
    test rax, rax
    jz .Lxun_allfail
    // snapshot
    mov [rsp + 64], rbx
    mov [rsp + 72], rbp
    mov [rsp + 80], r12
    mov rax, [r13]
    mov rcx, [r13 + 8]
    mov [rsp + 96], rax
    mov [rsp + 104], rcx
    // opt node = cur + [cur]
    mov r9, [rsp + 48]
    mov r10, [r9]
    lea rdi, [r9 + r10]
    LD_VAL
    mov rsi, r9
    call AZX_NAPI(az_validate)
    test rax, rax
    jz .Lxv_ret              // success
    cmp rax, -2
    jne .Lxv_ret             // -3/-4/-5 propagate
    // rollback
    mov rbx, [rsp + 64]
    mov rbp, [rsp + 72]
    mov r12, [rsp + 80]
    mov rax, [rsp + 96]
    mov rcx, [rsp + 104]
    mov [r13], rax
    mov [r13 + 8], rcx
    // next option
    mov r9, [rsp + 48]
    add r9, 8
    mov [rsp + 48], r9
    dec qword ptr [rsp + 32]
    jmp .Lxun_loop
.Lxun_allfail:
    mov edi, 3               // invalid_union
    xor esi, esi
    xor edx, edx
    call AZX_NAPI(az_issue_begin)
    test rax, rax
    jnz .Lxv_ret
    // `_u` = union index trailing field (per-option error attach in TS)
    LD_NODE
    mov rax, [r8 + 1]        // nopts
    shl rax, 3
    add rax, 9
    mov rax, [r8 + rax]      // uidx
    cvtsi2sd xmm0, rax
    lea rdi, [rip + .Lxk_u]
    mov esi, 2
    call AZX_NAPI(az_issue_f_f64)
    test rax, rax
    jnz .Lxv_ret
    call AZX_NAPI(az_issue_commit)
    jmp .Lxv_invalid

// ---------- 0x08 DISCRIMINATED UNION ----------
// [op][u64 dnamelen][dname][u64 nmap][klen+key+i64]*
// slots: [rsp+32]=dnamelen [rsp+40]=dname [rsp+48]=nfields [rsp+56]=cursor
//        [rsp+64]=discvalptr [rsp+80]=nmap [rsp+96]=mapcur [rsp+104]=inlen
//        [rsp+112]=inptr
.Lxv_discunion:
    LD_VAL
    movzx eax, byte ptr [r9]
    cmp eax, 6
    je .Lxdu_obj
    cmp eax, 8
    je .Lxdu_hr
    cmp eax, 9
    je .Lxdu_hrobj
    cmp eax, 10
    je .Lxdu_hrobj
    jmp .Lxdu_typefail
.Lxdu_hr:
    mov rax, [r15 + 24]      // cb_host
    mov edi, 6               // host type idx
    mov rsi, [r9 + 1]
    xor edx, edx
    xor ecx, ecx
    call rax
    test rax, rax
    jz .Lxdu_typefail        // symbol
    cmp rax, 4
    je .Lxdu_typefail        // function
    cmp rax, 8
    je .Lxdu_typefail        // bigint
.Lxdu_hrobj:
    LD_NODE
    mov rax, [r8 + 1]
    mov [rsp + 32], rax      // dnamelen
    lea rax, [r8 + 9]
    mov [rsp + 40], rax      // dname
    jmp .Lxdu_fail
.Lxdu_typefail:
    lea rdi, [rip + .Lexx_object]
    mov esi, 6
    jmp .Lxaz_vtype
.Lxdu_obj:
    LD_NODE
    mov rax, [r8 + 1]
    mov [rsp + 32], rax      // dnamelen
    lea rax, [r8 + 9]
    mov [rsp + 40], rax      // dname
    // scan input fields for the discriminator key
    LD_VAL
    mov rax, [r9 + 1]        // nfields
    mov [rsp + 48], rax
    lea rax, [r9 + 9]
    mov [rsp + 56], rax      // cursor at first key
.Lxdu_scan:
    mov rax, [rsp + 48]
    test rax, rax
    jz .Lxdu_fail
    mov r10, [rsp + 56]
    mov rax, [r10]           // keylen
    cmp rax, [rsp + 32]
    jne .Lxdu_next
    mov rdi, [rsp + 40]      // dname
    lea rsi, [r10 + 8]       // key bytes
    mov rdx, [rsp + 32]
    call AZX_NAPI(az_memeq)
    test eax, eax
    jnz .Lxdu_found
.Lxdu_next:
    mov r10, [rsp + 56]
    mov rax, [r10]
    lea r10, [r10 + rax + 8] // at value
    mov rdi, r10
    call AZX_NAPI(az_vsize)
    mov r10, [rsp + 56]
    mov rcx, [r10]
    lea r10, [r10 + rcx + 8]
    add r10, rax             // past value
    mov [rsp + 56], r10
    dec qword ptr [rsp + 48]
    jmp .Lxdu_scan
.Lxdu_found:
    // value ptr = cursor + keylen + 8
    mov r10, [rsp + 56]
    mov rax, [r10]
    lea rax, [r10 + rax + 8]
    cmp byte ptr [rax], 4    // discr must be string
    jne .Lxdu_fail
    mov [rsp + 64], rax      // disc value ptr
    // scan the map: entries at dname+dnamelen
    mov r10, [rsp + 40]
    mov rax, [rsp + 32]
    add r10, rax             // past dname -> nmap field
    mov rax, [r10]           // nmap
    mov [rsp + 80], rax
    lea rax, [r10 + 8]
    mov [rsp + 96], rax      // map cursor
    mov r10, [rsp + 64]
    mov rax, [r10 + 1]
    mov [rsp + 104], rax     // in len
    lea rax, [r10 + 9]
    mov [rsp + 112], rax     // in ptr
.Lxdu_map:
    mov rax, [rsp + 80]
    test rax, rax
    jz .Lxdu_fail
    mov r10, [rsp + 96]
    mov rax, [r10]           // key len
    cmp rax, [rsp + 104]
    jne .Lxdu_mnext
    mov rdi, [rsp + 112]
    mov rsi, [rsp + 96]
    add rsi, 8
    mov rdx, [rsp + 104]
    call AZX_NAPI(az_memeq)
    test eax, eax
    jnz .Lxdu_match
.Lxdu_mnext:
    mov r10, [rsp + 96]
    mov rax, [r10]
    lea r10, [r10 + rax + 8 + 8]  // skip key + i64 off
    mov [rsp + 96], r10
    dec qword ptr [rsp + 80]
    jmp .Lxdu_map
.Lxdu_match:
    mov r10, [rsp + 96]
    mov rax, [r10]
    lea r10, [r10 + rax + 8] // at i64 optoff
    mov rax, [r10]
    lea rdi, [r10 + rax]     // opt node
    LD_VAL
    mov rsi, r9
    call AZX_NAPI(az_validate)
    jmp .Lxv_ret
.Lxdu_fail:
    mov rdi, [rsp + 40]      // discriminator name ptr
    mov rsi, [rsp + 32]      // len
    call AZX_NAPI(az_path_push_key)
    mov edi, 3
    xor esi, esi
    xor edx, edx
    call AZX_NAPI(az_issue_begin)
    test rax, rax
    jnz .Lxv_ret
    call AZX_NAPI(az_issue_commit)
    call AZX_NAPI(az_path_pop)
    jmp .Lxv_invalid

// ---------- 0x0F REFINE ----------
// [op][inner i64][cbid u64][msglen u64][msg]
.Lxv_refine:
    LD_NODE
    lea rax, [r8 + 1]
    mov r10, [rax]
    lea rdi, [rax + r10]
    LD_VAL
    mov rsi, r9
    call AZX_NAPI(az_validate)
    test rax, rax
    jnz .Lxv_ret
    // out in rdx/rcx — cb_refine(cbid, outptr)
    mov [rsp + 32], rdx
    mov [rsp + 40], rcx
    mov rax, [r15]           // cb_refine = table[0]
    LD_NODE
    mov rdi, [r8 + 9]        // cbid
    mov rsi, [rsp + 32]
    call rax
    test eax, eax
    jnz .Lxrf_ok
    // issue custom with node msg
    LD_NODE
    mov rdx, [r8 + 17]       // msglen
    lea rsi, [r8 + 25]       // msg
    mov edi, 2               // custom
    call AZX_NAPI(az_issue_begin)
    test rax, rax
    jnz .Lxv_ret
    call AZX_NAPI(az_issue_commit)
    jmp .Lxv_invalid
.Lxrf_ok:
    mov rdx, [rsp + 32]
    mov rcx, [rsp + 40]
    xor eax, eax
    jmp .Lxv_ret

// ---------- 0x10 TRANSFORM ----------
// [op][inner i64][cbid u64]
.Lxv_transform:
    LD_NODE
    lea rax, [r8 + 1]
    mov r10, [rax]
    lea rdi, [rax + r10]
    LD_VAL
    mov rsi, r9
    call AZX_NAPI(az_validate)
    test rax, rax
    jnz .Lxv_ret
    // cb_transform(cbid, outptr, dest, avail) -> len | -3 enospc | -5 threw
    mov rax, [r15 + 8]       // cb_transform = table[1]
    mov [rsp + 40], rax
    LD_NODE
    mov rdi, [r8 + 9]        // cbid
    mov rsi, rdx             // outptr — wait: rdx is outptr from validate ret
    mov rdx, rbx             // dest = val pos
    mov rcx, rbp
    sub rcx, rbx             // avail
    mov [rsp + 32], rbx      // remember dest
    call qword ptr [rsp + 40]
    test rax, rax
    js .Lxv_ret              // -3/-5 propagate
    mov rcx, rax             // out len = produced len
    mov rdx, [rsp + 32]      // out ptr = dest
    add rbx, rax             // val pos = dest + produced len
    xor eax, eax
    jmp .Lxv_ret

// ---------- 0x11 PIPE ----------
// [op][in i64][out i64]
.Lxv_pipe:
    lea rax, [rip + AZX_NAPI(az_nc_flag)]
    mov byte ptr [rax], 1
    LD_NODE
    lea rax, [r8 + 1]
    mov r10, [rax]
    lea rdi, [rax + r10]
    LD_VAL
    mov rsi, r9
    call AZX_NAPI(az_validate)
    lea r10, [rip + AZX_NAPI(az_nc_flag)]
    mov byte ptr [r10], 0
    test rax, rax
    jnz .Lxv_ret
    // output value -> input of second
    mov [rsp + 24], rdx      // val = out ptr
    LD_NODE
    lea rax, [r8 + 9]
    mov r10, [rax]
    lea rdi, [rax + r10]
    mov rsi, rdx
    call AZX_NAPI(az_validate)
    jmp .Lxv_ret

// ---------- 0x1A LAZY ----------
// [op][u64 cbid] : cb_lazy(id) -> node ptr
.Lxv_lazy:
    mov rax, [r15 + 16]      // cb_lazy = table[2]
    LD_NODE
    mov rdi, [r8 + 1]
    call rax
    test rax, rax
    jz .Lxv_badop
    mov rdi, rax
    LD_VAL
    mov rsi, r9
    call AZX_NAPI(az_validate)
    jmp .Lxv_ret

// ---------- 0x1B INSTANCEOF ----------
// [op][u64 cbid][u64 namelen][name]
.Lxv_instof:
    LD_VAL
    movzx eax, byte ptr [r9]
    cmp eax, 8
    je .Lxio_hr
    cmp eax, 9
    je .Lxio_tag
    cmp eax, 10
    jne .Lxio_fail
.Lxio_tag:
    // tag9/10 are real Map/Set by construction — cb kind9 implied-ctor compare
    mov rax, [r15 + 24]      // cb_host
    mov edi, 9
    movzx esi, byte ptr [r9] // tag — arg x1
    LD_NODE
    mov rdx, [r8 + 1]        // cbid (ctor idx) — arg x2
    xor ecx, ecx
    call rax
    test rax, rax
    jz .Lxio_fail
    mov r10d, 9
    jmp .Lxv_passn
.Lxio_hr:
    mov rax, [r15 + 24]
    mov edi, 1               // instanceof
    LD_NODE
    mov rsi, [r8 + 1]        // cbid
    mov rdx, [r9 + 1]        // hostref idx
    xor ecx, ecx
    call rax
    test rax, rax
    jz .Lxio_fail
    mov r10d, 9
    jmp .Lxv_passn
.Lxio_fail:
    LD_NODE
    mov rsi, [r8 + 9]        // namelen
    lea rdi, [r8 + 17]       // name
    jmp .Lxaz_vtype

// ---------- 0x22 CUSTOM ----------
// [op][u64 cbid][u64 msglen][msg]
.Lxv_custom:
    mov rax, [r15 + 24]
    mov edi, 4               // kind4 custom
    LD_NODE
    mov rsi, [r8 + 1]        // cbid
    LD_VAL
    mov rdx, r9              // val ptr
    xor ecx, ecx
    call rax
    test rax, rax
    jz .Lxcu_fail
    jmp .Lxv_pass
.Lxcu_fail:
    LD_NODE
    mov rdx, [r8 + 9]        // msglen
    lea rsi, [r8 + 17]       // msg
    mov edi, 2               // custom
    call AZX_NAPI(az_issue_begin)
    test rax, rax
    jnz .Lxv_ret
    call AZX_NAPI(az_issue_commit)
    jmp .Lxv_invalid

// ---------- 0x23 NONOPTIONAL (inner) ----------
.Lxv_nonopt:
    LD_VAL
    cmp byte ptr [r9], 0
    jne .Lxno_inner
    lea rdi, [rip + .Lexx_nonopt]
    mov esi, 11
    jmp .Lxaz_vtype
.Lxno_inner:
    LD_NODE
    lea rax, [r8 + 1]
    jmp .Lxv_tail


// ---------- 0x06 ARRAY ----------
// [op][elem i64][min u64][max u64]   (u64_MAX = absent)
// slots: 32=saved pair pos 40=n elems 48=elem node 56=i/j 64=cur elem
//        72=failed 80=scratch 88/96=out or pair addr 96=emit start
//        104=deferred too_small limit
.Lxv_array:
    LD_VAL
    cmp byte ptr [r9], 7
    jne .Lxar_tfail
    mov rax, [r9 + 1]        // n elems
    mov [rsp + 40], rax
    mov qword ptr [rsp + 72], 0
    mov qword ptr [rsp + 104], -1
    // elem node: [op+1] is i64 self-rel offset
    LD_NODE
    lea rax, [r8 + 1]
    mov r10, [rax]
    add rax, r10
    mov [rsp + 48], rax
    // min check — deferred until after element loop (zod ordering)
    LD_NODE
    mov r10, [r8 + 9]        // min
    mov rax, [rsp + 40]
    cmp r10, -1
    je .Lxar_chkmax
    cmp rax, r10
    jae .Lxar_chkmax
    mov [rsp + 104], r10
    mov qword ptr [rsp + 72], 1
.Lxar_chkmax:
    LD_NODE
    mov r11, [r8 + 17]       // max
    mov rax, [rsp + 40]
    cmp r11, -1
    je .Lxar_size_done
    cmp rax, r11
    jbe .Lxar_size_done
    // too_big — zod prechecks the upper bound: abort before element validation
    cvtsi2sd xmm0, r11
    movq rcx, xmm0           // x3 = bound f64 bits
    lea rax, [rip + AZX_NAPI(az_nc_flag)]
    mov byte ptr [rax], 1    // non-continuable: downstream checks don't run
    xor r11d, r11d           // x7 msglen = 0 -> default msg
    mov edi, 9               // too_big
    lea rsi, [rip + .Lxty_array]
    mov edx, 5
    LD_NODE                  // r8 = node (scratch before arg load)
    movzx r9d, byte ptr [r8 + 25]  // exactLen flag -> arg5 first:
    mov r8d, 1               // inclusive — LD_NODE clobbered r8, order matters
    call AZX_NAPI(az_issue_size)
    lea r10, [rip + AZX_NAPI(az_nc_flag)]
    mov byte ptr [r10], 0    // r10, not rax — the call's return is live
    test rax, rax
    jnz .Lxv_ret             // -4 propagates
    jmp .Lxv_invalid
.Lxar_tfail:
    lea rdi, [rip + .Lexx_array]
    mov esi, 5
    jmp .Lxaz_vtype
.Lxar_size_done:
    mov [rsp + 32], rbp      // saved pair pos
    mov qword ptr [rsp + 56], 0   // i
    LD_VAL
    lea rax, [r9 + 9]
    mov [rsp + 64], rax      // cur elem ptr
.Lxar_vloop:
    mov rax, [rsp + 56]
    cmp rax, [rsp + 40]
    jae .Lxar_emit
    mov rdi, rax
    call AZX_NAPI(az_path_push_idx)
    mov rdi, [rsp + 48]      // elem node
    mov rsi, [rsp + 64]      // cur val
    call AZX_NAPI(az_validate)
    mov [rsp + 80], rax      // status
    mov [rsp + 88], rdx      // out ptr
    mov [rsp + 96], rcx      // out len
    call AZX_NAPI(az_path_pop)
    mov rax, [rsp + 80]
    test rax, rax
    jnz .Lxar_bad
    // push out pair: (key=0,0 vptr,vlen kind=0)
    xor edi, edi
    xor esi, esi
    mov rdx, [rsp + 88]
    mov rcx, [rsp + 96]
    xor r8d, r8d
    call AZX_NAPI(az_pair_push40)
    test rax, rax
    jnz .Lxv_ret             // -3
    jmp .Lxar_next
.Lxar_bad:
    cmp rax, -2
    jne .Lxv_ret             // -3/-4/-5 propagate
    mov qword ptr [rsp + 72], 1
    // push input slice as placeholder out
    mov rdi, [rsp + 64]
    call AZX_NAPI(az_vsize)
    mov rcx, rax
    mov rdx, [rsp + 64]
    xor edi, edi
    xor esi, esi
    xor r8d, r8d
    call AZX_NAPI(az_pair_push40)
    test rax, rax
    jnz .Lxv_ret
.Lxar_next:
    mov rdi, [rsp + 64]
    call AZX_NAPI(az_vsize)
    add [rsp + 64], rax
    inc qword ptr [rsp + 56]
    jmp .Lxar_vloop
.Lxar_emit:
    mov rax, [rsp + 72]
    test rax, rax
    jnz .Lxar_fail_pop
    mov [rsp + 96], rbx      // emit start S
    mov edi, 7
    call AZX_NAPI(az_vw1)
    test rax, rax
    jnz .Lxv_ret
    mov rdi, [rsp + 40]
    call AZX_NAPI(az_vw8)
    test rax, rax
    jnz .Lxv_ret
    mov qword ptr [rsp + 56], 0   // j
.Lxar_eloop:
    mov rax, [rsp + 56]
    mov r10, [rsp + 40]
    cmp rax, r10
    jae .Lxar_edone
    // pair j at rbp + (n-1-j)*40 — pairs grow down, first pushed is highest
    mov r11, r10
    sub r11, rax
    dec r11                  // n-1-j
    imul r11, r11, 40
    add r11, rbp
    mov rdi, [r11 + 16]      // vptr
    mov rsi, [r11 + 24]      // vlen
    mov [rsp + 88], r11
    call AZX_NAPI(az_vw)
    test rax, rax
    jnz .Lxv_ret
    inc qword ptr [rsp + 56]
    jmp .Lxar_eloop
.Lxar_edone:
    mov r9, [rsp + 96]       // emit start S
    mov rcx, rbx
    sub rcx, r9              // out len
    mov rdx, r9              // out ptr
    xor eax, eax
    // pop pairs
    mov r9, [rsp + 40]
    imul r9, r9, 40
    add rbp, r9
    jmp .Lxv_ret
.Lxar_fail_pop:
    // deferred too_small lands after every element issue (zod ordering)
    mov rax, [rsp + 104]
    cmp rax, -1
    je .Lxar_fp0
    cvtsi2sd xmm0, rax
    movq rcx, xmm0
    xor r11d, r11d           // x7 msglen = 0
    mov edi, 8               // too_small
    lea rsi, [rip + .Lxty_array]
    mov edx, 5
    LD_NODE
    movzx r9d, byte ptr [r8 + 25]  // exactLen -> arg5 before r8 reload
    mov r8d, 1               // inclusive
    call AZX_NAPI(az_issue_size)
    test rax, rax
    jnz .Lxv_ret
.Lxar_fp0:
    mov r9, [rsp + 40]
    imul r9, r9, 40
    add rbp, r9
    mov rax, -2
    jmp .Lxv_ret

    AZX_RODATA
    .p2align 4
.Lxv_jt:
    .quad .Lxv_badop
    .quad .Lxv_string
    .quad .Lxv_number
    .quad .Lxv_boolean
    .quad .Lxv_bigint
    .quad .Lxv_badop         // object — pending
    .quad .Lxv_array
    .quad .Lxv_union
    .quad .Lxv_discunion
    .quad .Lxv_literal
    .quad .Lxv_enum
    .quad .Lxv_optional
    .quad .Lxv_nullable
    .quad .Lxv_default
    .quad .Lxv_catch
    .quad .Lxv_refine
    .quad .Lxv_transform
    .quad .Lxv_pipe
    .quad .Lxv_badop         // intersect — pending
    .quad .Lxv_badop         // tuple — pending
    .quad .Lxv_badop         // record — pending
    .quad .Lxv_any
    .quad .Lxv_never
    .quad .Lxv_nullt
    .quad .Lxv_undeft
    .quad .Lxv_nan
    .quad .Lxv_lazy
    .quad .Lxv_instof
    .quad .Lxv_badop         // coerce_str — pending
    .quad .Lxv_badop         // coerce_num — pending
    .quad .Lxv_badop         // coerce_bool — pending
    .quad .Lxv_badop         // coerce_bigint — pending
    .quad .Lxv_badop         // date — pending
    .quad .Lxv_symbol
    .quad .Lxv_custom
    .quad .Lxv_nonopt
    .quad .Lxv_badop         // map — pending
    .quad .Lxv_badop         // set — pending

.Lexx_string:    .ascii "string"
.Lexx_number:    .ascii "number"
.Lexx_boolean:   .ascii "boolean"
.Lexx_bigint:    .ascii "bigint"
.Lexx_null:      .ascii "null"
.Lexx_undefined: .ascii "undefined"
.Lexx_nan:       .ascii "nan"
.Lexx_never:     .ascii "never"
.Lexx_symbol:    .ascii "symbol"
.Lexx_object:    .ascii "object"
.Lexx_nonopt:    .ascii "nonoptional"
.Lexx_array:     .ascii "array"
.Lxty_array:     .ascii "array"
.Lxk_expected2:  .ascii "expected"
.Lxk_received2:  .ascii "received"
.Lxk_options:    .ascii "options"
.Lxk_u:          .ascii "_u"
    .p2align 4
