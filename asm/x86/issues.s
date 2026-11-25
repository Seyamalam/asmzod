#include "portx.h"
// issues.s — x86-64 port. path stack + issue emission into err arena
// ctx: r12=err-pos r13=err-base r14=err-limit r15=cb-table (x21-x24)
// arm64 x27/x28 locals -> stack slots (all 6 callee-saved regs are ctx)
    .text
    .p2align 4

// ---------- path stack ----------
// az_path_push_key(rdi=keyptr, rsi=keylen)
    .globl AZX_NAPI(az_path_push_key)
    AZX_HIDDEN AZX_NAPI(az_path_push_key)
AZX_NAPI(az_path_push_key):
    mov rax, [r13 + 8]
    cmp rax, 128
    jae .Lxpk_done
    imul rax, rax, 24
    lea r10, [r13 + rax + 32]
    mov qword ptr [r10], 0   // kind=key
    mov [r10 + 8], rdi
    mov [r10 + 16], rsi
    mov rax, [r13 + 8]
    inc rax
    mov [r13 + 8], rax
.Lxpk_done:
    ret

// az_path_push_idx(rdi=idx)
    .globl AZX_NAPI(az_path_push_idx)
    AZX_HIDDEN AZX_NAPI(az_path_push_idx)
AZX_NAPI(az_path_push_idx):
    mov rax, [r13 + 8]
    cmp rax, 128
    jae .Lxpi_done
    imul rax, rax, 24
    lea r10, [r13 + rax + 32]
    mov qword ptr [r10], 1   // kind=idx
    mov [r10 + 8], rdi
    mov rax, [r13 + 8]
    inc rax
    mov [r13 + 8], rax
.Lxpi_done:
    ret

    .globl AZX_NAPI(az_path_pop)
    AZX_HIDDEN AZX_NAPI(az_path_pop)
AZX_NAPI(az_path_pop):
    mov rax, [r13 + 8]
    test rax, rax
    jz .Lxpp_done
    dec rax
    mov [r13 + 8], rax
.Lxpp_done:
    ret

// ---------- low-level err writers ----------
// az_ew(rdi=ptr, rsi=len) -> rax 0/-4
    .globl AZX_NAPI(az_ew)
    AZX_HIDDEN AZX_NAPI(az_ew)
AZX_NAPI(az_ew):
    lea r10, [r12 + rsi]
    cmp r10, r14
    ja .Lxew_oom
    mov r11, r12             // dst
    mov r12, r10             // bump
    mov rcx, rsi
    test rcx, rcx
    jz .Lxew_ok
    mov rax, rsi
    mov rsi, rdi
    mov rdi, r11
    rep movsb
.Lxew_ok:
    xor eax, eax
    ret
.Lxew_oom:
    mov rax, -4
    ret

// az_ew1(dil=byte) -> 0/-4
    .globl AZX_NAPI(az_ew1)
    AZX_HIDDEN AZX_NAPI(az_ew1)
AZX_NAPI(az_ew1):
    cmp r12, r14
    jae .Lxew1_oom
    mov [r12], dil
    inc r12
    xor eax, eax
    ret
.Lxew1_oom:
    mov rax, -4
    ret

// az_ew8(rdi=u64) -> 0/-4
    .globl AZX_NAPI(az_ew8)
    AZX_HIDDEN AZX_NAPI(az_ew8)
AZX_NAPI(az_ew8):
    lea r10, [r12 + 8]
    cmp r10, r14
    ja .Lxew8_oom
    mov [r12], rdi
    add r12, 8
    xor eax, eax
    ret
.Lxew8_oom:
    mov rax, -4
    ret

// ---------- issue fields ----------
// az_issue_f_str(rdi=kptr, rsi=klen, rdx=vptr, rcx=vlen) -> rax 0/-4
    .globl AZX_NAPI(az_issue_f_str)
    AZX_HIDDEN AZX_NAPI(az_issue_f_str)
AZX_NAPI(az_issue_f_str):
    push rbx
    sub rsp, 48
    mov [rsp], rdi
    mov [rsp + 8], rsi
    mov [rsp + 16], rdx
    mov [rsp + 24], rcx
    // bump field count
    mov rax, [r13 + 16]
    mov r10, [rax]
    inc r10
    mov [rax], r10
    mov rdi, rsi             // u64 klen
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfs_fail
    mov rdi, [rsp]
    mov rsi, [rsp + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfs_fail
    mov edi, 4               // STRING tag
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfs_fail
    mov rdi, [rsp + 24]      // vlen
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfs_fail
    mov rdi, [rsp + 16]
    mov rsi, [rsp + 24]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfs_fail
    xor eax, eax
.Lxfs_fail:
    add rsp, 48
    pop rbx
    ret

// az_issue_f_f64(rdi=kptr, rsi=klen, xmm0=val) -> 0/-4
    .globl AZX_NAPI(az_issue_f_f64)
    AZX_HIDDEN AZX_NAPI(az_issue_f_f64)
AZX_NAPI(az_issue_f_f64):
    push rbx
    sub rsp, 48
    mov [rsp], rdi
    mov [rsp + 8], rsi
    movsd [rsp + 16], xmm0
    mov rax, [r13 + 16]
    mov r10, [rax]
    inc r10
    mov [rax], r10
    mov rdi, rsi
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxff_fail
    mov rdi, [rsp]
    mov rsi, [rsp + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxff_fail
    mov edi, 3
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxff_fail
    mov rdi, [rsp + 16]
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxff_fail
    xor eax, eax
.Lxff_fail:
    add rsp, 48
    pop rbx
    ret

// az_issue_f_bool(rdi=kptr, rsi=klen, edx=val)
    .globl AZX_NAPI(az_issue_f_bool)
    AZX_HIDDEN AZX_NAPI(az_issue_f_bool)
AZX_NAPI(az_issue_f_bool):
    push rbx
    sub rsp, 48
    mov [rsp], rdi
    mov [rsp + 8], rsi
    mov [rsp + 16], rdx
    mov rax, [r13 + 16]
    mov r10, [rax]
    inc r10
    mov [rax], r10
    mov rdi, rsi
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfb_fail
    mov rdi, [rsp]
    mov rsi, [rsp + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfb_fail
    mov edi, 2
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfb_fail
    mov rdi, [rsp + 16]
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfb_fail
    xor eax, eax
.Lxfb_fail:
    add rsp, 48
    pop rbx
    ret

// az_issue_f_rawval(rdi=kptr, rsi=klen, rdx=vptr, rcx=vlen): bytes already tagged
    .globl AZX_NAPI(az_issue_f_rawval)
    AZX_HIDDEN AZX_NAPI(az_issue_f_rawval)
AZX_NAPI(az_issue_f_rawval):
    push rbx
    sub rsp, 48
    mov [rsp], rdi
    mov [rsp + 8], rsi
    mov [rsp + 16], rdx
    mov [rsp + 24], rcx
    mov rax, [r13 + 16]
    mov r10, [rax]
    inc r10
    mov [rax], r10
    mov rdi, rsi
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfrv_fail
    mov rdi, [rsp]
    mov rsi, [rsp + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfrv_fail
    mov rdi, [rsp + 16]
    mov rsi, [rsp + 24]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfrv_fail
    xor eax, eax
.Lxfrv_fail:
    add rsp, 48
    pop rbx
    ret

// az_issue_f_strarr(rdi=kptr, rsi=klen, rdx=pairptr, rcx=count)
    .globl AZX_NAPI(az_issue_f_strarr)
    AZX_HIDDEN AZX_NAPI(az_issue_f_strarr)
AZX_NAPI(az_issue_f_strarr):
    push rbx
    sub rsp, 64
    mov [rsp], rdi
    mov [rsp + 8], rsi
    mov [rsp + 16], rdx      // pairptr
    mov [rsp + 24], rcx      // count
    mov rax, [r13 + 16]
    mov r10, [rax]
    inc r10
    mov [rax], r10
    mov rdi, rsi
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfsa_fail
    mov rdi, [rsp]
    mov rsi, [rsp + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfsa_fail
    mov edi, 7               // ARRAY tag
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfsa_fail
    mov rdi, [rsp + 24]
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfsa_fail
    mov rbx, [rsp + 16]      // pairptr (rbx is ours — saved)
    mov rax, [rsp + 24]
    mov [rsp + 32], rax      // remaining count in slot
.Lxfsa_loop:
    mov rax, [rsp + 32]
    test rax, rax
    jz .Lxfsa_done
    mov edi, 4
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfsa_fail
    mov rdi, [rbx + 8]       // len
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfsa_fail
    mov rdi, [rbx]
    mov rsi, [rbx + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfsa_fail
    add rbx, 16
    dec qword ptr [rsp + 32]
    jmp .Lxfsa_loop
.Lxfsa_done:
    xor eax, eax
.Lxfsa_fail:
    add rsp, 64
    pop rbx
    ret

// ---------- issue begin/commit ----------
// az_msgcat(rdi=dst, rsi=src, rdx=n) -> rax = dst+n
    .globl AZX_NAPI(az_msgcat)
    AZX_HIDDEN AZX_NAPI(az_msgcat)
AZX_NAPI(az_msgcat):
    push rbx
    mov rbx, rdi
    add rbx, rdx             // end ptr
    call AZX_NAPI(az_memcpy)
    mov rax, rbx
    pop rbx
    ret

// az_issue_begin(rdi=code_idx, rsi=msgptr, rdx=msglen) -> rax 0/-4
    .globl AZX_NAPI(az_issue_begin)
    AZX_HIDDEN AZX_NAPI(az_issue_begin)
AZX_NAPI(az_issue_begin):
    push rbx
    sub rsp, 96
    // pending-msg cell: consumed (and cleared) on read
    lea rax, [rip + AZX_NAPI(az_pending_msg)]
    mov r10, [rax]
    mov r11, [rax + 8]
    mov qword ptr [rax], 0
    mov qword ptr [rax + 8], 0
    test rdx, rdx
    jnz .Libx_havemsg        // explicit msg wins
    mov rsi, r10
    mov rdx, r11
    test rdx, rdx
    jnz .Libx_havemsg        // pending msg
    // msg-stack top: depth match means wrapped node's own message
    lea rax, [rip + AZX_NAPI(az_msgstack)]
    mov rcx, [rax]
    test rcx, rcx
    jz .Libx_havemsg
    dec rcx
    imul rcx, rcx, 24
    lea r10, [rax + rcx + 8]
    mov rax, [r13 + 8]       // path depth
    cmp rax, [r10]
    jne .Libx_havemsg2
    mov rsi, [r10 + 8]
    mov rdx, [r10 + 16]
.Libx_havemsg:
.Libx_havemsg2:
    mov [rsp], rdi           // code idx
    mov [rsp + 8], rsi       // msgptr
    mov [rsp + 16], rdx      // msglen
    // reserve check: need >= msglen + 4096 slack
    lea rax, [r12 + rdx + 4096]
    cmp rax, r14
    ja .Libx_fail
    mov [r13 + 24], r12      // open-issue start
    mov edi, 6
    call AZX_NAPI(az_ew1)    // OBJECT tag
    test rax, rax
    jnz .Libx_fail
    xor edi, edi
    call AZX_NAPI(az_ew8)    // field count placeholder
    test rax, rax
    jnz .Libx_fail
    lea rax, [r12 - 8]
    mov [r13 + 16], rax      // patch ptr
    // field "code"
    lea rdi, [rip + .Lxk_code]
    mov esi, 4
    lea rdx, [rip + AZX_NAPI(az_code_table)]
    mov rax, [rsp]           // code idx
    shl rax, 5               // stride 32
    add rdx, rax
    mov rcx, [rdx + 8]
    mov rdx, [rdx]
    call AZX_NAPI(az_issue_f_str)
    test rax, rax
    jnz .Libx_fail
    // field "path" -> ARRAY
    mov rax, [r13 + 16]
    mov r10, [rax]
    inc r10
    mov [rax], r10
    mov edi, 4
    call AZX_NAPI(az_ew8)    // klen
    test rax, rax
    jnz .Libx_fail
    lea rdi, [rip + .Lxk_path]
    mov esi, 4
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Libx_fail
    mov edi, 7
    call AZX_NAPI(az_ew1)    // ARRAY tag
    test rax, rax
    jnz .Libx_fail
    mov rdi, [r13 + 8]       // depth
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Libx_fail
    mov rax, [r13 + 8]
    mov [rsp + 24], rax      // remaining = depth
    mov qword ptr [rsp + 32], 0  // i
.Libx_pathloop:
    mov rax, [rsp + 24]
    test rax, rax
    jz .Libx_pathdone
    mov rax, [rsp + 32]
    imul rax, rax, 24
    lea r10, [r13 + rax + 32]    // entry
    mov rax, [r10]
    test rax, rax
    jnz .Libx_pathidx
    // key -> STRING
    mov [rsp + 40], r10
    mov edi, 4
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Libx_fail
    mov r10, [rsp + 40]
    mov rdi, [r10 + 16]      // keylen
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Libx_fail
    mov r10, [rsp + 40]
    mov rdi, [r10 + 8]
    mov rsi, [r10 + 16]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Libx_fail
    jmp .Libx_pathnext
.Libx_pathidx:
    mov [rsp + 40], r10
    mov edi, 3               // F64 tag
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Libx_fail
    mov r10, [rsp + 40]
    mov rdi, [r10 + 8]
    cvtsi2sd xmm0, rdi       // path idx small positive — signed exact
    movq rdi, xmm0
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Libx_fail
.Libx_pathnext:
    inc qword ptr [rsp + 32]
    dec qword ptr [rsp + 24]
    jmp .Libx_pathloop
.Libx_pathdone:
    // field "message" — custom messages only (msglen>0)
    mov rdx, [rsp + 16]
    test rdx, rdx
    jz .Libx_done
    mov rcx, rdx             // vlen
    mov rdx, [rsp + 8]       // vptr
    lea rdi, [rip + .Lxk_message]
    mov esi, 7
    call AZX_NAPI(az_issue_f_str)
    test rax, rax
    jnz .Libx_fail
.Libx_done:
    xor eax, eax
    jmp .Libx_out
.Libx_fail:
    mov rax, -4
.Libx_out:
    add rsp, 96
    pop rbx
    ret

// az_issue_commit: ++issue_count
    .globl AZX_NAPI(az_issue_commit)
    AZX_HIDDEN AZX_NAPI(az_issue_commit)
AZX_NAPI(az_issue_commit):
    mov rax, [r13]
    inc rax
    mov [r13], rax
    ret

// az_issue_rollback_open: reset err pos to open-issue start
    .globl AZX_NAPI(az_issue_rollback_open)
    AZX_HIDDEN AZX_NAPI(az_issue_rollback_open)
AZX_NAPI(az_issue_rollback_open):
    mov rax, [r13 + 24]
    test rax, rax
    jz .Lxro_done              // no open issue — leave err pos unchanged
    mov r12, rax
.Lxro_done:
    ret

// ---------- az_issue_type ----------
// (rdi=exp_ptr, rsi=exp_len, rdx=got_tag, rcx=val_ptr) -> rax 0/-4
    .globl AZX_NAPI(az_issue_type)
    AZX_HIDDEN AZX_NAPI(az_issue_type)
AZX_NAPI(az_issue_type):
    push rbx
    sub rsp, 144
    mov [rsp], rdi           // exp ptr
    mov [rsp + 8], rsi       // exp len
    mov [rsp + 16], rdx      // got tag
    mov [rsp + 24], rcx      // val ptr
    // resolve received-name ptr/len -> [rsp+32/+40]
    cmp rdx, 3
    jne .Litx_notf64
    // f64: NaN -> "nan"; +-Infinity -> names
    mov rax, [rcx + 1]
    movq xmm0, rax
    ucomisd xmm0, xmm0
    jnp .Litx_f64fin
    lea rax, [rip + .Lxn_nan]
    mov [rsp + 32], rax
    mov qword ptr [rsp + 40], 3
    jmp .Litx_gotname
.Litx_f64fin:
    // fabs compare with inf bits
    mov rbx, 0x7FF0000000000000
    movq xmm1, rbx
    andpd xmm0, [rip + .Lxabs_mask]
    ucomisd xmm0, xmm1
    jne .Litx_notf64
    mov rax, [rsp + 24]
    mov rax, [rax + 1]       // raw bits — sign bit distinguishes +-inf
    test rax, rax
    jns .Litx_infpos
    lea rax, [rip + .Lxn_ninf]
    mov [rsp + 32], rax
    mov qword ptr [rsp + 40], 9
    jmp .Litx_gotname
.Litx_infpos:
    lea rax, [rip + .Lxn_inf]
    mov [rsp + 32], rax
    mov qword ptr [rsp + 40], 8
    jmp .Litx_gotname
.Litx_notf64:
    cmp rdx, 8
    jne .Litx_named
    // HOSTREF -> cb_host kind 6 for type-name idx
    mov rax, [r15 + 24]      // cb_host = table[3]
    mov edi, 6
    mov rcx, [rsp + 24]
    mov rsi, [rcx + 1]       // hostref idx
    xor edx, edx
    xor ecx, ecx
    call rax                 // cb table entries are internal-ABI thunks
    cmp rax, 5
    jne .Litx_tabname
    // idx 5 = other object -> constructor name (cb kind 8)
    mov r9, [r15 + 24]
    mov edi, 8
    mov rcx, [rsp + 24]
    mov rsi, [rcx + 1]
    mov rdx, r14
    sub rdx, 256             // scratch name buffer at err-arena tail
    mov ecx, 255
    mov [rsp + 48], r9
    call r9
    test rax, rax
    jz .Litx_tabname5
    mov r9, r14
    sub r9, 256
    mov [rsp + 32], r9
    mov [rsp + 40], rax
    jmp .Litx_gotname
.Litx_tabname5:
    mov eax, 5
.Litx_tabname:
    lea r9, [rip + AZX_NAPI(az_hosttype_table)]
    shl rax, 4               // stride 16
    add r9, rax
    mov rax, [r9]
    mov [rsp + 32], rax
    mov rax, [r9 + 8]
    mov [rsp + 40], rax
    jmp .Litx_gotname
.Litx_named:
    lea r9, [rip + AZX_NAPI(az_tagname_table)]
    mov rax, [rsp + 16]      // tag
    shl rax, 4
    add r9, rax
    mov rax, [r9]
    mov [rsp + 32], rax
    mov rax, [r9 + 8]
    mov [rsp + 40], rax
.Litx_gotname:
    // "nan" expected-name special case
    mov r10, [rsp]
    mov r11, [rsp + 8]
    mov [rsp + 48], r10
    mov [rsp + 56], r11
    cmp r11, 3
    jne .Litx_e_ok
    cmp byte ptr [r10], 'n'
    jne .Litx_e_ok
    cmp byte ptr [r10 + 1], 'a'
    jne .Litx_e_ok
    cmp byte ptr [r10 + 2], 'n'
    jne .Litx_e_ok
    lea rax, [rip + .Lxhv_nan]
    mov [rsp + 48], rax
    mov qword ptr [rsp + 56], 3
.Litx_e_ok:
    // "Invalid Date" received -> display name "Date"
    mov r10, [rsp + 32]
    mov r11, [rsp + 40]
    mov [rsp + 64], r10
    mov [rsp + 72], r11
    cmp r11, 12
    jne .Litx_r_done
    mov rdi, r10
    lea rsi, [rip + .Lxh7]
    mov edx, 12
    call AZX_NAPI(az_memeq)
    test eax, eax
    jz .Litx_r_done
    lea rax, [rip + .Lxhv_dname]
    mov [rsp + 64], rax
    mov qword ptr [rsp + 72], 4
.Litx_r_done:
    // build "Invalid input: expected X, received Y" in msgbuf
    lea rbx, [rip + AZX_NAPI(az_msgbuf)]
    mov rdi, rbx
    lea rsi, [rip + .Lxm_invexp]
    mov edx, 24
    call AZX_NAPI(az_msgcat)
    mov rdi, rax
    mov rsi, [rsp + 48]
    mov rdx, [rsp + 56]
    call AZX_NAPI(az_msgcat)
    mov rdi, rax
    lea rsi, [rip + .Lxm_rcv]
    mov edx, 11
    call AZX_NAPI(az_msgcat)
    mov rdi, rax
    mov rsi, [rsp + 64]
    mov rdx, [rsp + 72]
    call AZX_NAPI(az_msgcat)
    lea r9, [rip + AZX_NAPI(az_msgbuf)]
    sub rax, r9
    lea r10, [rip + AZX_NAPI(az_default_msg)]
    mov [r10], r9
    mov [r10 + 8], rax
    xor esi, esi
    xor edx, edx
    xor edi, edi             // code = invalid_type
    call AZX_NAPI(az_issue_begin)
    test rax, rax
    jnz .Litx_out
    // expected
    lea rdi, [rip + .Lxk_expected]
    mov esi, 8
    mov rdx, [rsp]
    mov rcx, [rsp + 8]
    call AZX_NAPI(az_issue_f_str)
    test rax, rax
    jnz .Litx_out
    // received
    lea rdi, [rip + .Lxk_received]
    mov esi, 8
    mov rdx, [rsp + 32]
    mov rcx, [rsp + 40]
    call AZX_NAPI(az_issue_f_str)
    test rax, rax
    jnz .Litx_out
    call AZX_NAPI(az_issue_commit)
    xor eax, eax
.Litx_out:
    add rsp, 144
    pop rbx
    ret

// ---------- az_issue_invalid_date ----------
    .globl AZX_NAPI(az_issue_invalid_date)
    AZX_HIDDEN AZX_NAPI(az_issue_invalid_date)
AZX_NAPI(az_issue_invalid_date):
    push rbx
    xor esi, esi
    xor edx, edx
    xor edi, edi             // code = invalid_type
    call AZX_NAPI(az_issue_begin)
    test rax, rax
    jnz .Lidx_out
    lea rdi, [rip + .Lxk_expected]
    mov esi, 8
    lea rdx, [rip + .Lxhv_date]
    mov ecx, 4
    call AZX_NAPI(az_issue_f_str)
    test rax, rax
    jnz .Lidx_out
    lea rdi, [rip + .Lxk_received]
    mov esi, 8
    lea rdx, [rip + .Lxh7]
    mov ecx, 12
    call AZX_NAPI(az_issue_f_str)
    test rax, rax
    jnz .Lidx_out
    call AZX_NAPI(az_issue_commit)
    xor eax, eax
.Lidx_out:
    pop rbx
    ret

// az_issue_f_i64(rdi=kptr, rsi=klen, rdx=val) — BIGINT tagged value
    .globl AZX_NAPI(az_issue_f_i64)
    AZX_HIDDEN AZX_NAPI(az_issue_f_i64)
AZX_NAPI(az_issue_f_i64):
    push rbx
    sub rsp, 48
    mov [rsp], rdi
    mov [rsp + 8], rsi
    mov [rsp + 16], rdx
    mov rax, [r13 + 16]
    mov r10, [rax]
    inc r10
    mov [rax], r10
    mov rdi, rsi
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfi_fail
    mov rdi, [rsp]
    mov rsi, [rsp + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfi_fail
    mov edi, 5
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfi_fail
    mov rdi, [rsp + 16]
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfi_fail
    xor eax, eax
.Lxfi_fail:
    add rsp, 48
    pop rbx
    ret

// az_issue_f_strseq(rdi=kptr, rsi=klen, rdx=seqptr, rcx=count)
// seq = [u64 len + bytes]*count — enum "options"
    .globl AZX_NAPI(az_issue_f_strseq)
    AZX_HIDDEN AZX_NAPI(az_issue_f_strseq)
AZX_NAPI(az_issue_f_strseq):
    push rbx
    sub rsp, 64
    mov [rsp], rdi
    mov [rsp + 8], rsi
    mov [rsp + 16], rdx
    mov [rsp + 24], rcx
    mov rax, [r13 + 16]
    mov r10, [rax]
    inc r10
    mov [rax], r10
    mov rdi, rsi
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfsq_fail
    mov rdi, [rsp]
    mov rsi, [rsp + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfsq_fail
    mov edi, 7
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfsq_fail
    mov rdi, [rsp + 24]
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfsq_fail
    mov rbx, [rsp + 16]      // seqptr
    mov rax, [rsp + 24]
    mov [rsp + 32], rax      // remaining
.Lxfsq_loop:
    mov rax, [rsp + 32]
    test rax, rax
    jz .Lxfsq_done
    mov edi, 4
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfsq_fail
    mov rdi, [rbx]
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfsq_fail
    lea rdi, [rbx + 8]
    mov rsi, [rbx]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfsq_fail
    mov rax, [rbx]
    lea rbx, [rbx + rax + 8]
    dec qword ptr [rsp + 32]
    jmp .Lxfsq_loop
.Lxfsq_done:
    xor eax, eax
.Lxfsq_fail:
    add rsp, 64
    pop rbx
    ret

// az_issue_f_strarr2(rdi=kptr, rsi=klen, rdx=base, rcx=stride, r8=count)
    .globl AZX_NAPI(az_issue_f_strarr2)
    AZX_HIDDEN AZX_NAPI(az_issue_f_strarr2)
AZX_NAPI(az_issue_f_strarr2):
    push rbx
    sub rsp, 64
    mov [rsp], rdi
    mov [rsp + 8], rsi
    mov [rsp + 16], rdx      // base
    mov [rsp + 24], rcx      // stride
    mov [rsp + 32], r8       // count
    mov rax, [r13 + 16]
    mov r10, [rax]
    inc r10
    mov [rax], r10
    mov rdi, rsi
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfs2_fail
    mov rdi, [rsp]
    mov rsi, [rsp + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfs2_fail
    mov edi, 7
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfs2_fail
    mov rdi, [rsp + 32]
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfs2_fail
    mov rbx, [rsp + 16]      // cursor
.Lxfs2_loop:
    mov rax, [rsp + 32]
    test rax, rax
    jz .Lxfs2_done
    mov edi, 4
    call AZX_NAPI(az_ew1)
    test rax, rax
    jnz .Lxfs2_fail
    mov rdi, [rbx + 8]       // len
    call AZX_NAPI(az_ew8)
    test rax, rax
    jnz .Lxfs2_fail
    mov rdi, [rbx]
    mov rsi, [rbx + 8]
    call AZX_NAPI(az_ew)
    test rax, rax
    jnz .Lxfs2_fail
    add rbx, [rsp + 24]      // stride
    dec qword ptr [rsp + 32]
    jmp .Lxfs2_loop
.Lxfs2_done:
    xor eax, eax
.Lxfs2_fail:
    add rsp, 64
    pop rbx
    ret

// ---------- tables ----------
    AZX_DATA
    .p2align 3
    .globl AZX_NAPI(az_code_table)
    AZX_HIDDEN AZX_NAPI(az_code_table)
AZX_NAPI(az_code_table):
    .quad .Lxc0, 12, .Lxd0, 8
    .quad .Lxc1, 15, .Lxd1, 21
    .quad .Lxc2, 6,  .Lxd2, 13
    .quad .Lxc3, 13, .Lxd3, 13
    .quad .Lxc4, 18, .Lxd4, 18
    .quad .Lxc5, 17, .Lxd5, 26
    .quad .Lxc6, 12, .Lxd6, 12
    .quad .Lxc7, 14, .Lxd7, 7
    .quad .Lxc8, 9,  .Lxd8, 9
    .quad .Lxc9, 7,  .Lxd9, 7
    .quad .Lxc10, 28, .Lxd10, 28
    .quad .Lxc11, 15, .Lxd11, 15
    .quad .Lxc12, 10, .Lxd12, 18
    .quad .Lxc13, 11, .Lxd13, 15

    .globl AZX_NAPI(az_tagname_table)
    AZX_HIDDEN AZX_NAPI(az_tagname_table)
AZX_NAPI(az_tagname_table):
    .quad .Lxt0, 9
    .quad .Lxt1, 4
    .quad .Lxt2, 7
    .quad .Lxt3, 6
    .quad .Lxt4, 6
    .quad .Lxt5, 6
    .quad .Lxt6, 6
    .quad .Lxt7, 5
    .quad .Lxt8, 7
    .quad .Lxt9, 3
    .quad .Lxt10, 3

    .globl AZX_NAPI(az_hosttype_table)
    AZX_HIDDEN AZX_NAPI(az_hosttype_table)
AZX_NAPI(az_hosttype_table):
    .quad .Lxh0, 6
    .quad .Lxh1, 4
    .quad .Lxh2, 3
    .quad .Lxh3, 3
    .quad .Lxh4, 8
    .quad .Lxh5, 5
    .quad .Lxh6, 7
    .quad .Lxh7, 12
    .quad .Lxh8, 6

    AZX_RODATA
.Lxc0:  .ascii "invalid_type"
.Lxc1:  .ascii "invalid_literal"
.Lxc2:  .ascii "custom"
.Lxc3:  .ascii "invalid_union"
.Lxc4:  .ascii "invalid_enum_value"
.Lxc5:  .ascii "unrecognized_keys"
.Lxc6:  .ascii "invalid_date"
.Lxc7:  .ascii "invalid_string"
.Lxc8:  .ascii "too_small"
.Lxc9:  .ascii "too_big"
.Lxc10: .ascii "invalid_intersection_results"
.Lxc11: .ascii "not_multiple_of"
.Lxc12: .ascii "not_finite"
.Lxc13: .ascii "invalid_key"
.Lxd0:  .ascii "Required"
.Lxd1:  .ascii "Invalid literal value"
.Lxd2:  .ascii "Invalid input"
.Lxd3:  .ascii "Invalid input"
.Lxd4:  .ascii "Invalid enum value"
.Lxd5:  .ascii "Unrecognized key(s) in object"
.Lxd6:  .ascii "Invalid date"
.Lxd7:  .ascii "Invalid"
.Lxd8:  .ascii "Too small"
.Lxd9:  .ascii "Too big"
.Lxd10: .ascii "Invalid intersection results"
.Lxd11: .ascii "Not a multiple"
.Lxd12: .ascii "Number must be finite"
.Lxd13: .ascii "Invalid key ..."
.Lxt0:  .ascii "undefined"
.Lxt1:  .ascii "null"
.Lxt2:  .ascii "boolean"
.Lxt3:  .ascii "number"
.Lxt4:  .ascii "string"
.Lxt5:  .ascii "bigint"
.Lxt6:  .ascii "object"
.Lxt7:  .ascii "array"
.Lxt8:  .ascii "unknown"
.Lxt9:  .ascii "Map"
.Lxt10: .ascii "Set"
.Lxh0:  .ascii "symbol"
.Lxh1:  .ascii "Date"
.Lxh2:  .ascii "Map"
.Lxh3:  .ascii "Set"
.Lxh4:  .ascii "function"
.Lxh5:  .ascii "object"
.Lxh6:  .ascii "unknown"
.Lxh7:  .ascii "Invalid Date"
.Lxh8:  .ascii "bigint"
.Lxhv_date: .ascii "date"
.Lxk_code:     .ascii "code"
.Lxk_path:     .ascii "path"
.Lxk_message:  .ascii "message"
.Lxk_expected: .ascii "expected"
.Lxk_received: .ascii "received"
.Lxm_invexp: .ascii "Invalid input: expected "
.Lxm_rcv:    .ascii ", received "
.Lxhv_nan:   .ascii "NaN"
.Lxhv_dname: .ascii "Date"
.Lxn_nan:      .ascii "NaN"
.Lxn_inf:      .ascii "Infinity"
.Lxn_ninf:     .ascii "-Infinity"
    .p2align 4
.Lxabs_mask: .quad 0x7fffffffffffffff, 0x7fffffffffffffff

// ---------- pending check-message cell + msgbuf + msgstack ----------
    AZX_WDATA
    .p2align 3
    .globl AZX_NAPI(az_pending_msg)
    AZX_HIDDEN AZX_NAPI(az_pending_msg)
AZX_NAPI(az_pending_msg):     .quad 0
                              .quad 0
    .globl AZX_NAPI(az_default_msg)
    AZX_HIDDEN AZX_NAPI(az_default_msg)
AZX_NAPI(az_default_msg):     .quad 0, 0
    .globl AZX_NAPI(az_msgbuf)
    AZX_HIDDEN AZX_NAPI(az_msgbuf)
AZX_NAPI(az_msgbuf):          .space 512
    .globl AZX_NAPI(az_msgstack)
    AZX_HIDDEN AZX_NAPI(az_msgstack)
AZX_NAPI(az_msgstack):        .quad 0
                              .zero 64*24
