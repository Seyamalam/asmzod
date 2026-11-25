#include "portx.h"
// value.s — x86-64 port. tagged value readers (see FORMAT.md)
// ctx regs: rbx = val pos (x19), rbp = pair frontier (x20) — engine state,
// saved/restored wherever borrowed as locals. multi-return: rax,rdx,rcx,r8,r9
    .text
    .p2align 4

// az_vsize(rdi=val ptr) -> rax serialized byte size
    .globl AZX_NAPI(az_vsize)
    AZX_HIDDEN AZX_NAPI(az_vsize)
AZX_NAPI(az_vsize):
    movzx eax, byte ptr [rdi]
    cmp eax, 4
    je .Lxvs_str
    cmp eax, 6
    je .Lxvs_obj
    cmp eax, 7
    je .Lxvs_arr
    cmp eax, 9
    je .Lxvs_map
    cmp eax, 10
    je .Lxvs_arr           // set: n + n tagged values (same walk)
    cmp eax, 2
    je .Lxvs_two
    jb .Lxvs_one
    mov eax, 9
    ret
.Lxvs_one:
    mov eax, 1
    ret
.Lxvs_two:
    mov eax, 2
    ret
.Lxvs_str:
    mov rax, [rdi + 1]
    add rax, 9
    ret
.Lxvs_obj:
    push rbx
    push r12
    push r13
    mov rbx, rdi
    mov r12, [rbx + 1]     // nfields
    add rbx, 9             // cursor at first field
    mov r13d, 9            // size so far
.Lxvs_objloop:
    test r12, r12
    jz .Lxvs_objdone
    mov r10, [rbx]         // keylen
    lea rbx, [rbx + r10 + 8]  // skip key
    lea r13, [r13 + r10 + 8]
    mov rdi, rbx
    call AZX_NAPI(az_vsize)
    add rbx, rax
    add r13, rax
    dec r12
    jmp .Lxvs_objloop
.Lxvs_objdone:
    mov rax, r13
    pop r13
    pop r12
    pop rbx
    ret
.Lxvs_arr:
    push rbx
    push r12
    push r13
    mov rbx, rdi
    mov r12, [rbx + 1]
    add rbx, 9
    mov r13d, 9
.Lxvs_arrloop:
    test r12, r12
    jz .Lxvs_arrdone
    mov rdi, rbx
    call AZX_NAPI(az_vsize)
    add rbx, rax
    add r13, rax
    dec r12
    jmp .Lxvs_arrloop
.Lxvs_arrdone:
    mov rax, r13
    pop r13
    pop r12
    pop rbx
    ret
.Lxvs_map:
    // tag9: n pairs — count is 2n tagged values
    push rbx
    push r12
    push r13
    mov rbx, rdi
    mov r12, [rbx + 1]
    add r12, r12           // 2n values
    add rbx, 9
    mov r13d, 9
.Lxvs_maploop:
    test r12, r12
    jz .Lxvs_mapdone
    mov rdi, rbx
    call AZX_NAPI(az_vsize)
    add rbx, rax
    add r13, rax
    dec r12
    jmp .Lxvs_maploop
.Lxvs_mapdone:
    mov rax, r13
    pop r13
    pop r12
    pop rbx
    ret

// az_scalar_size(rdi=tag) -> rax (1,2,or 9; string/obj/arr -> 0 = variable)
    .globl AZX_NAPI(az_scalar_size)
    AZX_HIDDEN AZX_NAPI(az_scalar_size)
AZX_NAPI(az_scalar_size):
    cmp rdi, 2
    je .Lxss2
    jb .Lxss1
    cmp rdi, 3
    je .Lxss9
    cmp rdi, 5
    je .Lxss9
    cmp rdi, 8
    je .Lxss9
    xor eax, eax
    ret
.Lxss1:
    mov eax, 1
    ret
.Lxss2:
    mov eax, 2
    ret
.Lxss9:
    mov eax, 9
    ret

// az_val_write(rdi=src, rsi=len) — copies value into val arena
// bounds-checks against rbp; returns dst ptr in rax or rax=-1 on ENOSPC
// NOTE arm64 had x0=arena-check comment mismatch; contract here matches use sites
    .globl AZX_NAPI(az_val_write)
    AZX_HIDDEN AZX_NAPI(az_val_write)
AZX_NAPI(az_val_write):
    lea r10, [rbx + rsi]
    cmp r10, rbp
    ja .Lxvw_oom
    mov r11, rbx           // dst
    mov rbx, r10           // bump
    mov rcx, rsi
    // rep movsb: rsi=src already? rdi=src — rearrange
    mov rax, rsi           // save len
    mov rsi, rdi           // src
    mov rdi, r11           // dst
    rep movsb
    mov rsi, rax           // len back (harmless)
    mov rax, rbx
    sub rax, rsi           // dst start = pos - len... careful: rbx already bumped
    ret
.Lxvw_oom:
    mov rax, -1
    ret

// az_val_reserve(rdi=n) -> rax write ptr (arena grows), or -1 ENOSPC
    .globl AZX_NAPI(az_val_reserve)
    AZX_HIDDEN AZX_NAPI(az_val_reserve)
AZX_NAPI(az_val_reserve):
    lea r10, [rbx + rdi]
    cmp r10, rbp
    ja .Lxvr_oom
    mov rax, rbx
    mov rbx, r10
    ret
.Lxvr_oom:
    mov rax, -1
    ret

// pair stack (ptr,len) for pending child outputs — grows DOWN from rbp
// az_pair_push(rdi=ptr, rsi=len) -> rax=0 ok / -1 oom
    .globl AZX_NAPI(az_pair_push)
    AZX_HIDDEN AZX_NAPI(az_pair_push)
AZX_NAPI(az_pair_push):
    lea r10, [rbp - 16]
    cmp r10, rbx
    jb .Lxpp_oom
    mov rbp, r10
    mov [rbp], rdi
    mov [rbp + 8], rsi
    xor eax, eax
    ret
.Lxpp_oom:
    mov rax, -1
    ret

// az_pair_get(rdi=i) -> rax=ptr rdx=len
    .globl AZX_NAPI(az_pair_get)
    AZX_HIDDEN AZX_NAPI(az_pair_get)
AZX_NAPI(az_pair_get):
    mov rax, rdi
    shl rax, 4
    add rax, rbp
    mov rdx, [rax + 8]
    mov rax, [rax]
    ret

// az_vw1(dil=byte) -> 0 ok / -3 ENOSPC   (val arena byte append)
    .globl AZX_NAPI(az_vw1)
    AZX_HIDDEN AZX_NAPI(az_vw1)
AZX_NAPI(az_vw1):
    cmp rbx, rbp
    jae .Lxvw1_oom
    mov [rbx], dil
    inc rbx
    xor eax, eax
    ret
.Lxvw1_oom:
    mov rax, -3
    ret

// az_vw8(rdi=u64) -> 0/-3
    .globl AZX_NAPI(az_vw8)
    AZX_HIDDEN AZX_NAPI(az_vw8)
AZX_NAPI(az_vw8):
    lea r10, [rbx + 8]
    cmp r10, rbp
    ja .Lxvw8_oom
    mov [rbx], rdi
    add rbx, 8
    xor eax, eax
    ret
.Lxvw8_oom:
    mov rax, -3
    ret

// az_vw(rdi=src, rsi=len) -> 0/-3   (val arena raw append)
    .globl AZX_NAPI(az_vw)
    AZX_HIDDEN AZX_NAPI(az_vw)
AZX_NAPI(az_vw):
    lea r10, [rbx + rsi]
    cmp r10, rbp
    ja .Lxvw_oom2
    mov r11, rbx           // dst
    mov rbx, r10           // bump
    mov rcx, rsi
    test rcx, rcx
    jz .Lxvw_ok2
    mov rax, rsi
    mov rsi, rdi
    mov rdi, r11
    rep movsb
.Lxvw_ok2:
    xor eax, eax
    ret
.Lxvw_oom2:
    mov rax, -3
    ret

// pair entries are 40B: {kptr,klen,vptr,vlen,flags}
// az_pair_push40(rdi=kptr,rsi=klen,rdx=vptr,rcx=vlen,r8=flags) -> 0/-3
    .globl AZX_NAPI(az_pair_push40)
    AZX_HIDDEN AZX_NAPI(az_pair_push40)
AZX_NAPI(az_pair_push40):
    lea r10, [rbp - 40]
    cmp r10, rbx
    jb .Lxpp40_oom
    mov rbp, r10
    mov [rbp], rdi
    mov [rbp + 8], rsi
    mov [rbp + 16], rdx
    mov [rbp + 24], rcx
    mov [rbp + 32], r8
    xor eax, eax
    ret
.Lxpp40_oom:
    mov rax, -3
    ret

// az_pair_get40(rdi=i) -> rax=kptr rdx=klen rcx=vptr r8=vlen r9=flags
    .globl AZX_NAPI(az_pair_get40)
    AZX_HIDDEN AZX_NAPI(az_pair_get40)
AZX_NAPI(az_pair_get40):
    mov rax, rdi
    imul rax, rax, 40
    add rax, rbp
    mov rdx, [rax + 8]
    mov rcx, [rax + 16]
    mov r8, [rax + 24]
    mov r9, [rax + 32]
    mov rax, [rax]
    ret
