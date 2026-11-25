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

    AZX_RODATA
    .p2align 4
.Lxv_jt:
    .quad .Lxv_badop
    .quad .Lxv_string
    .quad .Lxv_number
    .quad .Lxv_boolean
    .quad .Lxv_bigint
    .quad .Lxv_badop         // object — pending
    .quad .Lxv_badop         // array — pending
    .quad .Lxv_badop         // union — pending
    .quad .Lxv_badop         // discunion — pending
    .quad .Lxv_badop         // literal — pending
    .quad .Lxv_badop         // enum — pending
    .quad .Lxv_optional
    .quad .Lxv_nullable
    .quad .Lxv_badop         // default — pending
    .quad .Lxv_badop         // catch — pending
    .quad .Lxv_badop         // refine — pending
    .quad .Lxv_badop         // transform — pending
    .quad .Lxv_badop         // pipe — pending
    .quad .Lxv_badop         // intersect — pending
    .quad .Lxv_badop         // tuple — pending
    .quad .Lxv_badop         // record — pending
    .quad .Lxv_any
    .quad .Lxv_never
    .quad .Lxv_nullt
    .quad .Lxv_undeft
    .quad .Lxv_nan
    .quad .Lxv_badop         // lazy — pending
    .quad .Lxv_badop         // instof — pending
    .quad .Lxv_badop         // coerce_str — pending
    .quad .Lxv_badop         // coerce_num — pending
    .quad .Lxv_badop         // coerce_bool — pending
    .quad .Lxv_badop         // coerce_bigint — pending
    .quad .Lxv_badop         // date — pending
    .quad .Lxv_symbol
    .quad .Lxv_badop         // custom — pending
    .quad .Lxv_badop         // nonopt — pending
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
    .p2align 4
