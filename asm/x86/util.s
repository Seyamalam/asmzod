#include "portx.h"
// util.s — x86-64 port. leaf helpers: memory ops, integer to decimal.
// arm64 register contract preserved: args rdi/rsi/rdx/rcx, return rax.
    .text
    .p2align 4

// az_memcpy(rdi=dst, rsi=src, rdx=n) — forward copy
    .globl AZX_NAPI(az_memcpy)
    AZX_HIDDEN AZX_NAPI(az_memcpy)
AZX_NAPI(az_memcpy):
    test rdx, rdx
    jz .Lxmc_done
    mov rcx, rdx
    // rep movsb wants rsi=src rdi=dst rcx=n — already exactly there
    rep movsb
.Lxmc_done:
    ret

// az_memeq(rdi=a, rsi=b, rdx=n) -> rax 1 if equal else 0
    .globl AZX_NAPI(az_memeq)
    AZX_HIDDEN AZX_NAPI(az_memeq)
AZX_NAPI(az_memeq):
    test rdx, rdx
    jz .Lxmeq1
    cmp rdx, 16
    jb .Lxmeq8ck
.Lxmeq16:
    movups xmm0, [rdi]
    movups xmm1, [rsi]
    pcmpeqb xmm0, xmm1         // ff per equal byte
    pmovmskb eax, xmm0
    cmp eax, 0xffff
    jne .Lxmeq0
    add rdi, 16
    add rsi, 16
    sub rdx, 16
    cmp rdx, 16
    jae .Lxmeq16
.Lxmeq8ck:
    cmp rdx, 8
    jb .Lxmeqtail
.Lxmeq8:
    mov rax, [rdi]
    cmp rax, [rsi]
    jne .Lxmeq0
    add rdi, 8
    add rsi, 8
    sub rdx, 8
    cmp rdx, 8
    jae .Lxmeq8
.Lxmeqtail:
    test rdx, rdx
    jz .Lxmeq1
.Lxmeq1b:
    movzx eax, byte ptr [rdi]
    cmp al, [rsi]
    jne .Lxmeq0
    inc rdi
    inc rsi
    dec rdx
    jnz .Lxmeq1b
.Lxmeq1:
    mov eax, 1
    ret
.Lxmeq0:
    xor eax, eax
    ret

// az_u64_dec(rdi=value, rsi=buf) -> rax = length written
    .globl AZX_NAPI(az_u64_dec)
    AZX_HIDDEN AZX_NAPI(az_u64_dec)
AZX_NAPI(az_u64_dec):
    mov r8, rsi              // buf
    xor r9d, r9d             // digit count
    mov r10, rdi             // running value
    mov r11d, 10
.Lxdc_loop:
    mov rax, r10
    xor edx, edx             // div uses rdx:rax
    div r11                  // rax = quot, rdx = rem
    add dl, '0'
    mov [r8 + r9], dl
    inc r9
    mov r10, rax
    test r10, r10
    jnz .Lxdc_loop
    // reverse in place
    xor ecx, ecx             // lo
    lea rdx, [r9 - 1]        // hi
.Lxdc_rev:
    cmp rcx, rdx
    jae .Lxdc_done
    mov al, [r8 + rcx]
    mov r10b, [r8 + rdx]
    mov [r8 + rcx], r10b
    mov [r8 + rdx], al
    inc rcx
    dec rdx
    jmp .Lxdc_rev
.Lxdc_done:
    mov rax, r9
    ret

// az_cat(rdi=dst, rsi=src, rdx=len) -> rax = dst+len
    .globl AZX_NAPI(az_cat)
    AZX_HIDDEN AZX_NAPI(az_cat)
AZX_NAPI(az_cat):
    mov rax, rdi
    test rdx, rdx
    jz .Lxcat_done
    mov rcx, rdx
    // rsi=src already, rdi=dst already — rep movsb clobbers rdi; track end in rax
    rep movsb
    mov rax, rdi
.Lxcat_done:
    ret

// az_sdec(rdi=i64, rsi=buf) -> rax len
    .globl AZX_NAPI(az_sdec)
    AZX_HIDDEN AZX_NAPI(az_sdec)
AZX_NAPI(az_sdec):
    push rbp
    mov rbp, rsp
    test rdi, rdi
    jns .Lxsd_pos
    mov byte ptr [rsi], '-'
    inc rsi
    neg rdi
    call AZX_NAPI(az_u64_dec)
    inc rax                  // +1 for the sign
    jmp .Lxsd_out
.Lxsd_pos:
    call AZX_NAPI(az_u64_dec)
.Lxsd_out:
    pop rbp
    ret

// az_f64_dec(xmm0=val, rdi=buf) -> rax=len
// NaN->"NaN", integral->int digits, else int.frac up to 6 digits trimmed
    .globl AZX_NAPI(az_f64_dec)
    AZX_HIDDEN AZX_NAPI(az_f64_dec)
AZX_NAPI(az_f64_dec):
    push rbp
    mov rbp, rsp
    sub rsp, 32
    mov [rsp], rdi           // buf base
    mov r8, rdi              // cursor
    ucomisd xmm0, xmm0
    jnp .Lxfd_notnan
    mov byte ptr [r8], 'N'
    mov byte ptr [r8+1], 'a'
    mov byte ptr [r8+2], 'a'
    add r8, 3
    jmp .Lxfd_done
.Lxfd_notnan:
    xorpd xmm2, xmm2
    ucomisd xmm0, xmm2       // val ? 0.0 — CF set means val < 0
    jae .Lxfd_pos
    mov byte ptr [r8], '-'
    inc r8
    // negate: flip sign bit
    movq rax, xmm0
    mov rcx, 0x8000000000000000
    xor rax, rcx
    movq xmm0, rax
.Lxfd_pos:
    roundsd xmm1, xmm0, 1    // floor(val) — SSE4.1, universal on x86_64 in practice
    ucomisd xmm0, xmm1
    je .Lxfd_int
    // < 2^52?
    mov rax, 0x4330000000000000
    movq xmm2, rax
    ucomisd xmm0, xmm2
    jae .Lxfd_int
    cvttsd2si rdi, xmm0
    mov rax, rdi
    mov rdi, rax
    mov rsi, r8
    // preserve xmm0 across the call — u64_dec is integer-only, xmm untouched
    call AZX_NAPI(az_u64_dec)
    add r8, rax
    mov byte ptr [r8], '.'
    inc r8
    roundsd xmm1, xmm0, 1    // recompute floor — rdi clobbered regs but xmm0 lives
    subsd xmm0, xmm1         // frac
    mov r9d, 6
.Lxfd_frac:
    test r9d, r9d
    jz .Lxfd_trim
    mov eax, 10
    cvtsi2sd xmm2, rax
    mulsd xmm0, xmm2
    cvttsd2si eax, xmm0
    cvtsi2sd xmm3, eax
    subsd xmm0, xmm3
    add al, '0'
    mov [r8], al
    inc r8
    dec r9d
    jmp .Lxfd_frac
.Lxfd_trim:
    movzx eax, byte ptr [r8 - 1]
    cmp al, '0'
    jne .Lxfd_trimdot
    dec r8
    jmp .Lxfd_trim
.Lxfd_trimdot:
    movzx eax, byte ptr [r8 - 1]
    cmp al, '.'
    jne .Lxfd_done
    dec r8
    jmp .Lxfd_done
.Lxfd_int:
    cvttsd2si rdi, xmm0
    mov rsi, r8
    call AZX_NAPI(az_u64_dec)
    add r8, rax
.Lxfd_done:
    mov rax, r8
    sub rax, [rsp]
    mov rsp, rbp
    pop rbp
    ret

// az_i64toa(rdi=val, rsi=dst) -> rax=len — signed decimal, no leading zeros
    .globl AZX_NAPI(az_i64toa)
    AZX_HIDDEN AZX_NAPI(az_i64toa)
AZX_NAPI(az_i64toa):
    sub rsp, 56
    xor r9d, r9d             // sign flag
    test rdi, rdi
    jns .Lxia_pos
    neg rdi
    mov r9d, 1
    mov byte ptr [rsi], '-'
    inc rsi
.Lxia_pos:
    xor r10d, r10d           // ndig
    mov r11d, 10
.Lxia_loop:
    mov rax, rdi
    xor edx, edx
    div r11
    add dl, '0'
    mov [rsp + r10], dl
    inc r10
    mov rdi, rax
    test rdi, rdi
    jnz .Lxia_loop
    xor ecx, ecx             // copy reversed into dst
.Lxia_cpy:
    mov rdx, r10
    dec rdx
    sub rdx, rcx
    movzx eax, byte ptr [rsp + rdx]
    mov [rsi + rcx], al
    inc rcx
    cmp rcx, r10
    jb .Lxia_cpy
    lea rax, [r10 + r9]      // len = ndig + sign
    add rsp, 56
    ret
