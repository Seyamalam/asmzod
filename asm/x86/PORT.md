# x86-64 port of the asmzod validation core

Status: **in progress**. ARM64 remains the only complete core.
This file is the continuation manual — read it fully before porting the next file.

## verified milestones

- [x] harness: `docker build --platform linux/amd64 -t asmzod-x86 .` then
      `docker run --rm --platform linux/amd64 -v $PWD/asm/x86:/x asmzod-x86 bash`
      (colima on arm64 mac; qemu emulation; `/tmp` is NOT shared — only `/Users`)
- [x] util.s — ported, assembles, **semantic tests pass in-container** (xtest.c),
      output bit-exact vs arm64 incl. quirks ('3.141589' truncation, 'Naa')
- [x] engine.s — ported, assembles (no runtime test yet — needs validate.s)
- [x] value.s — ported, assembles (no runtime test yet)

## remaining, in dependency order

1. checks.s (1903 lines) — leaf validators, mostly self-contained, calls util
2. issues.s (945) — error arena writers, calls util
3. validate.s (3723) — the bytecode interpreter; uses x27/x28 as node/val
4. runners.s (1365) — container walkers (obj/arr/tuple/record/union)
5. napi.s (4934) — N-API frontend + module registration; the ABI-critical one

then: link libasmzod.so + asmzod.node for x86_64, bun test in-container,
full upstream suite in-container, `make ci` equivalent.

## internal ABI (asmzod core — NOT SysV except at napi boundary)

- args: rdi,rsi,rdx,rcx,r8,r9,r10,r11  (arm64 x0-x7 in order)
- returns: rax,rdx,rcx,r8,r9  (arm64 x0-x4)
- ctx registers (engine.s, stable across everything):
    x19 val-pos   -> rbx
    x20 pair-pos  -> rbp   (NEVER use rbp as frame pointer inside the core)
    x21 err-pos   -> r12
    x22 err-base  -> r13
    x23 err-limit -> r14
    x24 cb-table  -> r15
    x25 val-base  -> spilled to stack in az_parse; load into a scratch when needed
    x27 node      -> validate.s-local: use a callee-saved spill slot or r10/r11
                     when leaf-dominant; decide per-function and document inline
- scratch: rax (after return), r10, r11, plus arg regs once consumed
- x86 has only 6 callee-saved regs vs arm64's 10 — when a function needs more,
  spill to its own stack frame. correctness first; the arm64 code is not
  register-optimal for x86 and that's fine.

## translation patterns (apply mechanically)

| arm64                    | x86-64                                  |
|--------------------------|-----------------------------------------|
| adrp+add x9, sym         | lea r10, [rip+sym]                      |
| ldr x9, [x0, #8]         | mov r10, [rdi + 8]                      |
| ldr/str x9, [x0], #8     | mov + add reg, 8  (no post-increment!)  |
| ldp/stp pair             | two movs                                |
| cbz/cbnz xN              | test reg,reg + jz/jnz                   |
| cmp x9,#5 + b.lo/hi/hs   | cmp + jb/ja/jae (unsigned) jl/jg/jle/jge signed |
| subs x2,x2,#1 + b.ne     | dec + jnz  (dec sets ZF — safe)         |
| udiv x13,x9,x12          | mov rax,r9 / xor edx,edx / div r12 (rdx MUST be zeroed) |
| msub x14,x13,x12,x9      | remainder is already in rdx after div   |
| fmov/fcmp/fadd (fp)      | movq/ucomisd/addsd etc — SSE2           |
| frintm                   | roundsd xmm, xmm, 1  (SSE4.1, universal in practice) |
| fcvtzs                   | cvttsd2si                               |
| scvtf                    | cvtsi2sd                                |
| fcmp d0,d0 + b.vc        | ucomisd xmm0,xmm0 + jnp (PF set = unordered/NaN) |
| xzr                      | xor eax,eax                             |
| stp x29,x30 / mov x29,sp | push rbp-style prologue BUT rbp is ctx — use rsp-only frames |
| ret                      | ret                                     |
| bl                       | call                                    |

## traps already hit — do not rediscover

- **flags**: arm64 only sets flags on subs/cmp; x86 most ALU ops set EFLAGS.
  never let a translated flag test cross an intervening ALU op.
- **rep movsb** clobbers rsi/rdi/rcx — and rsi/rdi are ARG registers. shuffle
  args before string ops; see az_val_write/az_vw for the pattern.
- **div**: rdx:rax / operand. forgetting `xor edx,edx` faults on large values.
- **16-byte stack alignment** at every `call` into napi/libc. internal asm-to-asm
  calls don't strictly need it until SSE spills appear — align anyway.
- **ucomisd + ja/jae/jb/je**: CF/ZF semantics — unordered sets all three.
  handle NaN FIRST (PF), exactly like the arm64 originals do with b.vc.
- **cvtsi2sd xmm, eax** sign-extends from 32-bit; use rax form for counts.
- colima does not share macOS `/tmp` — mount repo paths under /Users only.
- ELF local syms: no underscore prefix; `-Bsymbolic` at link; rip-relative
  lea works for our own tables because they bind locally.

## file-by-file notes

- validate.s uses a 512-byte frame with x29-relative slots — translate to
  rsp-relative with a fixed frame size; keep the slot offsets identical
  (+16 etc) so cross-references stay readable.
- napi.s: SysV applies at napi entry points (args rdi,rsi,...). inside,
  convert to internal ABI immediately at the entry and stay internal.
  napi callback fn pointers are SysV — align rsp at those calls.
- aznc.s (counting instrumentation) and guard builds: port LAST or skip —
  they're dev-only.
