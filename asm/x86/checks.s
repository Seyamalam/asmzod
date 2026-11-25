#include "portx.h"
// checks.s — x86-64 port. string format validators + check runners
// NEON->SSE2 idioms used throughout:
//   cmeq          -> pcmpeqb
//   cmhi (unsigned a>b) -> xor both with 0x80 then pcmpgtb (SSE2 has no
//                        unsigned byte compare); or range-test via psubusb
//   umaxv b (any) -> pmovmskb + test (values are 0/ff so mask!=0 == any)
//   uaddlv h      -> psadbw vs zero (byte sum in low word)
//   dup byte      -> imul rax, 0x0101010101010101 + movq
//   movi vN, imm  -> rodata constant + movdqa
    .text
    .p2align 4

// ---------- az_utf16_units(rdi=ptr, rsi=len) -> rax units ----------
    .globl AZX_NAPI(az_utf16_units)
    AZX_HIDDEN AZX_NAPI(az_utf16_units)
AZX_NAPI(az_utf16_units):
    xor r10d, r10d           // i
    xor r9d, r9d             // units
    cmp rsi, 32
    jb .Lxuu_loop
    movdqa xmm4, [rip + .Lxc_zero]   // cont accumulator
.Lxuu_simd:
    movdqu xmm0, [rdi + r10]
    movdqa xmm1, xmm0
    psubb xmm1, [rip + .Lxc_80]      // b - 0x80
    // unsigned cmhi: continuation iff (b-0x80) unsigned< 0x40
    // sse2 trick: psubusb xmm1, 0x40 -> 0 iff b-0x80 < 0x40... reversed:
    // use minub/maxub: cont iff max(b-0x80, 0x40)==0x40 and b-0x80 <= 0x3f
    // simplest correct: pcmpeqb after psubusb against 0x40 gives LE — but
    // need strict <: subtract 0x41 and test < 0 means borrow... use the
    // psubusb approach inverted: psubusb(0x3f, x) nonzero iff x<0x40
    movdqa xmm2, [rip + .Lxc_40]
    psubusb xmm2, xmm1       // nonzero lanes iff (b-0x80) unsigned< 0x40
    pcmpeqb xmm2, [rip + .Lxc_zero]  // ff lanes iff NOT continuation
    pxor xmm2, [rip + .Lxc_ff]       // invert -> ff per continuation
    // xmm2 lanes now ff for continuations; psadbw vs zero sums bytes: ff=255
    // accumulate count, not weight: and with 1 first
    pand xmm2, [rip + .Lxc_ones]
    paddb xmm4, xmm2
    add r10, 16
    mov r11, rsi
    sub r11, r10
    cmp r11, 16
    jae .Lxuu_simd
    // sum accumulator bytes: psadbw writes qword0 bits[0:16]=sum lanes0-7,
    // qword1 bits[64:80]=sum lanes8-15 — both halves must be added
    psadbw xmm4, [rip + .Lxc_zero]
    movq r11, xmm4
    movdqa xmm5, xmm4
    punpckhqdq xmm5, xmm5    // high qword -> low
    movq rax, xmm5
    movzx r11d, r11w
    movzx eax, ax
    add r11, rax
    mov r9, r10
    sub r9, r11              // simd units = bytes - continuations
.Lxuu_loop:
    cmp r10, rsi
    jae .Lxuu_done
    movzx eax, byte ptr [rdi + r10]
    cmp eax, 0x80
    jb .Lxuu_1
    cmp eax, 0xF0
    jae .Lxuu_4
    cmp eax, 0xE0
    jae .Lxuu_3
    add r10, 2
    inc r9
    jmp .Lxuu_loop
.Lxuu_3:
    add r10, 3
    inc r9
    jmp .Lxuu_loop
.Lxuu_4:
    add r10, 4
    inc r9
    jmp .Lxuu_loop
.Lxuu_1:
    inc r10
    inc r9
    jmp .Lxuu_loop
.Lxuu_done:
    mov rax, r9
    ret

// ---------- az_memmem(rdi=hay,rsi=hlen,rdx=ndl,rcx=nlen) -> eax 1/0 ----------
    .globl AZX_NAPI(az_memmem)
    AZX_HIDDEN AZX_NAPI(az_memmem)
AZX_NAPI(az_memmem):
    push rbx
    push r12
    test rcx, rcx
    jz .Lxmm_yes
    cmp rcx, rsi
    ja .Lxmm_no
    mov r8, rsi
    sub r8, rcx              // last valid start
    movzx eax, byte ptr [rdx]
    mov rbx, 0x0101010101010101
    imul rax, rbx
    movq xmm6, rax           // broadcast first needle byte
    punpcklqdq xmm6, xmm6    // movq zero-extends — replicate to all 16 lanes
    xor r9d, r9d             // i
.Lxmm_vloop:
    mov r10, rsi
    sub r10, r9
    cmp r10, 16
    jb .Lxmm_outer
    movdqu xmm0, [rdi + r9]
    pcmpeqb xmm0, xmm6
    pmovmskb eax, xmm0
    test eax, eax
    jnz .Lxmm_cand0
    add r9, 16
    jmp .Lxmm_vloop
.Lxmm_cand0:
    mov r11, r9              // candidate scan within chunk
    lea r10, [r9 + 16]
.Lxmm_cand:
    cmp r11, r10
    jae .Lxmm_cdone
    cmp r11, r8
    ja .Lxmm_no
    movzx eax, byte ptr [rdx]
    cmp [rdi + r11], al
    jne .Lxmm_cnext
    xor eax, eax             // verify full needle — reuse rax as k
.Lxmm_vfy:
    cmp rax, rcx
    jae .Lxmm_yes
    lea rbx, [r11 + rax]
    movzx r12d, byte ptr [rdi + rbx]
    cmp r12b, [rdx + rax]
    jne .Lxmm_cnext
    inc rax
    jmp .Lxmm_vfy
.Lxmm_cnext:
    inc r11
    jmp .Lxmm_cand
.Lxmm_cdone:
    mov r9, r10
    jmp .Lxmm_vloop
.Lxmm_outer:
    cmp r9, r8
    ja .Lxmm_no
    xor eax, eax
.Lxmm_inner:
    cmp rax, rcx
    jae .Lxmm_yes
    lea rbx, [r9 + rax]
    movzx r10d, byte ptr [rdi + rbx]
    cmp r10b, [rdx + rax]
    jne .Lxmm_next
    inc rax
    jmp .Lxmm_inner
.Lxmm_next:
    inc r9
    jmp .Lxmm_outer
.Lxmm_yes:
    mov eax, 1
    pop r12
    pop rbx
    ret
.Lxmm_no:
    xor eax, eax
    pop r12
    pop rbx
    ret

    AZX_RODATA
    .p2align 4
.Lxc_zero: .fill 16, 1, 0
.Lxc_ff:   .fill 16, 1, 0xff
.Lxc_ones: .fill 16, 1, 1
.Lxc_80:   .fill 16, 1, 0x80
.Lxc_40:   .fill 16, 1, 0x40
