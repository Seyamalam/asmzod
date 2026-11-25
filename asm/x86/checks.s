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

// ---------- az_is_email(rdi=ptr, rsi=len) -> eax 1/0 ----------
// scalar-faithful port. the NEON 16-byte skip in the original is a pure
// optimization — semantics identical, speed differs. SIMD skip is a later
// item (scalar is the oracle). regs: r9=i r10=labels r13=cursor... only
// caller-saved scratch used: rax rbx-via-save rcx rdx r8-r11
    .globl AZX_NAPI(az_is_email)
    AZX_HIDDEN AZX_NAPI(az_is_email)
AZX_NAPI(az_is_email):
    xor r9d, r9d             // i
.Lxem_scan:
    cmp r9, rsi
    jae .Lxem_no             // no '@'
    movzx eax, byte ptr [rdi + r9]
    cmp al, '@'
    je .Lxem_at
    // allowed local char: [A-Za-z0-9_'+.-]
    cmp al, '0'
    jb .Lxem_l1
    cmp al, '9'
    jbe .Lxem_lok
    cmp al, 'A'
    jb .Lxem_l1
    cmp al, 'Z'
    jbe .Lxem_lok
    cmp al, 'a'
    jb .Lxem_l1
    cmp al, 'z'
    jbe .Lxem_lok
.Lxem_l1:
    cmp al, '_'
    je .Lxem_lok
    cmp al, 0x27             // single quote
    je .Lxem_lok
    cmp al, '+'
    je .Lxem_lok
    cmp al, '-'
    je .Lxem_lok
    cmp al, '.'
    je .Lxem_lok
    jmp .Lxem_no
.Lxem_lok:
    inc r9
    jmp .Lxem_scan
.Lxem_at:
    test r9, r9
    jz .Lxem_no              // empty local part
    movzx eax, byte ptr [rdi + r9 - 1]
    // end set: A-Za-z0-9_+-
    cmp al, '0'
    jb .Lxem_e1
    cmp al, '9'
    jbe .Lxem_eok
    cmp al, 'A'
    jb .Lxem_e1
    cmp al, 'Z'
    jbe .Lxem_eok
    cmp al, 'a'
    jb .Lxem_e1
    cmp al, 'z'
    jbe .Lxem_eok
.Lxem_e1:
    cmp al, '_'
    je .Lxem_eok
    cmp al, '+'
    je .Lxem_eok
    cmp al, '-'
    je .Lxem_eok
    jmp .Lxem_no
.Lxem_eok:
    inc r9                   // past '@'
    xor r10d, r10d           // dots seen
    mov r11, r9              // label start
.Lxem_dlabel:
    cmp r11, rsi
    jae .Lxem_no             // ran out mid-label
    mov rcx, r11             // cur
    xor edx, edx             // label len
.Lxem_dchar:
    cmp rcx, rsi
    jae .Lxem_dend
    movzx eax, byte ptr [rdi + rcx]
    cmp al, '.'
    je .Lxem_dend
    // allowed: alnum or '-' (pos0 must be alnum)
    cmp al, '0'
    jb .Lxem_d2
    cmp al, '9'
    jbe .Lxem_dok
    cmp al, 'A'
    jb .Lxem_d2
    cmp al, 'Z'
    jbe .Lxem_dok
    cmp al, 'a'
    jb .Lxem_d2
    cmp al, 'z'
    jbe .Lxem_dok
.Lxem_d2:
    cmp al, '-'
    je .Lxem_dok
    jmp .Lxem_no
.Lxem_dok:
    test rdx, rdx
    jnz .Lxem_dok2
    cmp al, '-'
    je .Lxem_no              // leading '-'
.Lxem_dok2:
    inc rcx
    inc rdx
    jmp .Lxem_dchar
.Lxem_dend:
    test rdx, rdx
    jz .Lxem_no              // empty label
    cmp rcx, rsi
    jae .Lxem_tld            // hit end -> last label letters >= 2
    inc r10
    lea r11, [rcx + 1]
    jmp .Lxem_dlabel
.Lxem_tld:
    test r10, r10
    jz .Lxem_no              // no dot in domain
    cmp rdx, 2
    jb .Lxem_no
    mov rcx, r11
.Lxem_tldl:
    cmp rcx, rsi
    jae .Lxem_yes
    movzx eax, byte ptr [rdi + rcx]
    cmp al, 'A'
    jb .Lxem_no
    cmp al, 'Z'
    jbe .Lxem_tldn
    cmp al, 'a'
    jb .Lxem_no
    cmp al, 'z'
    ja .Lxem_no
.Lxem_tldn:
    inc rcx
    jmp .Lxem_tldl
.Lxem_yes:
    mov eax, 1
    ret
.Lxem_no:
    xor eax, eax
    ret

// ---------- az_is_uuid(rdi=ptr, rsi=len, rdx=version) -> eax ----------
// 8-4-4-4-12 hex; version 0=any else nibble at pos 14 == version
// scalar-faithful port of the original's .Luid_slow oracle
    .globl AZX_NAPI(az_is_uuid)
    AZX_HIDDEN AZX_NAPI(az_is_uuid)
AZX_NAPI(az_is_uuid):
    cmp rsi, 36
    jne .Lxuid_no
    xor r9d, r9d             // i
    xor r10d, r10d           // group idx 0..4
    lea r11, [rip + .Lxuid_groups]
.Lxuid_grp:
    cmp r10, 5
    jae .Lxuid_yes
    movzx ecx, byte ptr [r11 + r10]  // group len
    xor r8d, r8d             // j within group
.Lxuid_hex:
    cmp r8, rcx
    jae .Lxuid_grp_end
    movzx eax, byte ptr [rdi + r9]
    cmp al, '0'
    jb .Lxuid_no
    cmp al, '9'
    jbe .Lxuid_hok
    cmp al, 'A'
    jb .Lxuid_no
    cmp al, 'F'
    jbe .Lxuid_hok
    cmp al, 'a'
    jb .Lxuid_no
    cmp al, 'f'
    ja .Lxuid_no
.Lxuid_hok:
    cmp r9, 14               // version nibble position
    jne .Lxuid_hn
    test rdx, rdx
    jz .Lxuid_hn
    sub al, '0'
    movzx eax, al
    cmp rax, rdx
    jne .Lxuid_no
.Lxuid_hn:
    inc r9
    inc r8
    jmp .Lxuid_hex
.Lxuid_grp_end:
    inc r10
    cmp r10, 5
    jae .Lxuid_yes
    movzx eax, byte ptr [rdi + r9]
    cmp al, '-'
    jne .Lxuid_no
    inc r9
    jmp .Lxuid_grp
.Lxuid_yes:
    mov eax, 1
    ret
.Lxuid_no:
    xor eax, eax
    ret

    AZX_RODATA
.Lxuid_groups: .byte 8,4,4,4,12
    .text
