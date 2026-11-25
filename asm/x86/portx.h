// portx.h — x86-64 port layer for the asmzod validation core.
//
// Strategy notes for the port (read before translating any file):
//
// register map vs the arm64 originals:
//   x0-x5 args      -> rdi, rsi, rdx, rcx, r8, r9   (SysV; rcx is shift-count, rsi/rdi string ops)
//   x9-x15 scratch  -> rax, r10, r11 + arg regs after consumption
//   x19-x28 callee  -> rbx, rbp, r12-r15 (6 only!) + stack frame slots for the rest
//   flags           -> arm64 sets flags explicitly (subs/cmp); x86 most ALU ops set
//                      EFLAGS implicitly — translate `subs x, y, #1; b.ne` into
//                      `dec`/`sub`+`jne` but NEVER rely on flags surviving across
//                      another ALU op the way arm64 code sometimes does
//   adrp+add/lo12   -> lea reg, [rip+sym] (small PIC); ELF wants @GOTPCREL only for
//                      external syms — ours are -Bsymbolic local, rip-relative is fine
//   ldp/stp pairs   -> two movs, or movups when contiguous xmm is natural
//   cbz/cbnz        -> test reg,reg + jz/jnz
//   ldrb/strb       -> movzx/mov byte ptr
//   xzr             -> xor reg,reg (zeroing idiom, no memory operand)
//
// calling convention: napi_* are real C calls — align rsp to 16 at call sites
// (arm64 doesn't need this; x86-64 SysV MOVAPS faults otherwise). Leaf helpers
// internal to the core keep the arm64-shaped register contract where possible:
// x0->rdi, x1->rsi, x2->rdx, x3->rcx, return in rax.
//
// assembler: clang integrated as, Intel syntax (.intel_syntax noprefix).
.intel_syntax noprefix

#ifdef __APPLE__
#define AZX_NAPI(n) _##n
#define AZX_RODATA .section __TEXT,__const
#define AZX_DATA   .section __DATA,__const
#define AZX_WDATA  .section __DATA,__data
.macro AZX_HIDDEN sym
	.private_extern \sym
.endm
#else
#define AZX_NAPI(n) n
#define AZX_RODATA .section .rodata
#define AZX_DATA   .section .data.rel.ro
#define AZX_WDATA  .section .data
.macro AZX_HIDDEN sym
	.hidden \sym
.endm
#endif
