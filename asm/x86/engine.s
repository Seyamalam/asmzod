#include "portx.h"
// engine.s — x86-64 port. az_parse entry point + engine context
//
// INTERNAL ABI (asmzod core, not SysV): args rdi,rsi,rdx,rcx,r8,r9,r10,r11
// (arm64 x0-x7 in order); multi-value returns rax,rdx,rcx (arm64 x0,x1,x2).
// Only napi-facing entry points follow SysV exactly.
//
// ctx registers (callee-saved, stable across JS callbacks):
//   arm64   x86    role
//   x19  -> rbx   val arena write pos (grows up)
//   x20  -> rbp   pair-stack frontier (grows down, shares out_val buffer top)
//   x21  -> r12   err issue write pos
//   x22  -> r13   err base
//   x23  -> r14   err limit (err_base + cap)
//   x24  -> r15   cb table ptr
//   x25  -> [rsp] val base (spilled: written once at end)
//   x26  -> [rsp+8]  spare
//   x27/x28 -> validate.s-local; map to r10/r11 there (leaf-dominant) or spill
    .text
    .p2align 4

    .globl AZX_NAPI(az_version)
AZX_NAPI(az_version):
    mov eax, 1
    ret

// az_parse(rdi=node, rsi=input, rdx=outval, rcx=outvalcap, r8=outerr, r9=outerrcap, r10=cbtable)
//   -> rax status (0 ok, -2 invalid, -3/-4 enospc), rdx=out ptr, rcx=out len
    .globl AZX_NAPI(az_parse)
AZX_NAPI(az_parse):
    push rbp
    push rbx
    push r12
    push r13
    push r14
    push r15
    sub rsp, 24              // 2 ctx slots + pad: entry rsp%16=8, +48+24 -> aligned
    mov [rsp], rdx           // x25: val base
    lea rbx, [rdx + 16]      // val pos (skip 16B result header)
    lea rbp, [rdx + rcx]     // pair pos (top of val buffer)
    mov r13, r8              // err base
    lea r12, [r8 + 3104]     // err pos (past header+path stack)
    lea r14, [r8 + r9]       // err limit
    mov r15, r10             // cb table
    mov qword ptr [r13], 0       // issue_count = 0
    mov qword ptr [r13 + 8], 0   // path_depth = 0
    mov qword ptr [r13 + 16], 0  // open patch ptr
    mov qword ptr [r13 + 24], 0  // open issue start
    // rdi=node rsi=val already in place
    call AZX_NAPI(az_validate)
    test rax, rax
    jnz .Lxep_out            // nonzero -> status already in rax
    mov r8, [rsp]            // val base
    mov [r8], rdx            // success: result ptr (validate x1 -> rdx)
    mov [r8 + 8], rcx        // result len (validate x2 -> rcx)
.Lxep_out:
    add rsp, 24
    pop r15
    pop r14
    pop r13
    pop r12
    pop rbx
    pop rbp
    ret
