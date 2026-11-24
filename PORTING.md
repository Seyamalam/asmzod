# Porting

## Targets that work today

| target | what's needed |
|---|---|
| macOS arm64 | `make -C asm` — clang + Mach-O, no deps |
| Linux arm64 | `make -C asm` — ELF path in `port.h` strips the `_` prefix; verified in Docker (see `docker-test.sh`) |
| Node ≥18 | `asmzod.node` loads via N-API (`src/native/napi.ts`) |
| Bun | both N-API addon and `bun:ffi` dylib |
| Deno | portable engine; `deno test --no-check` |
| Cloudflare Workers / browsers / bundlers | portable engine — the module never statically imports `node:*`/`bun:*`; natives are probed lazily |

## Assembly portability

Everything platform-specific lives in `asm/port.h`:

- **Symbol names**: Mach-O wants `_foo`, ELF wants `foo`. Use the
  `G(sym)` / `AZ_NAPI(sym)` macros, never raw `_napi_*` or `_az_*`.
- **N-API symbols**: resolved lazily. `AZ_NAPI(foo)` loads the function
  pointer through the module's import table on Mach-O and through
  `napi_module`-registered globals on ELF — no link-time dependency on
  libnode. Never hard-extern a napi symbol.
- **Syscalls / libc**: the engine only needs `malloc`-family, provided by
  the host (`bun:ffi` resolution or the N-API addon's link). No direct
  syscalls anywhere.

## Adding a new opcode

1. Emit it in `src/bytecode.ts` (`emitNode`), document it in `FORMAT.md`.
2. Implement in `asm/engine.s` (dylib engine) and `asm/napi.s` (N-API).
   Dispatch caps at `0x23`; `0x2A` is handled pre-dispatch as a msgwrap.
3. Implement in `src/engine.ts` (portable) — this is the reference.
4. If the node calls user JS, add it to the callback table (`reg.*` in
   `src/shared.ts`) and mark `cbUnsafe` only if it can't run in the addon.
5. Add differential cases in `test/diff.test.ts` — all three engines must
   emit byte-identical issue shapes to zod4.

## Adding a new issue code

1. Pick a code number, add to the code table in `asm/issues.s` +
   `src/engine.ts` + `src/shared.ts` normalization.
2. Check field emitters cover what you need (`az_issue_f_*`); nested
   `issues` arrays need the `_k` splice protocol (see `finishIssues`).

## Runtime gotchas

- `napi_get_prototype` on a null-prototype object returns the JS `null`
  value (nonzero handle), not `NULL`. Test with `napi_typeof`/`NAPI_NULL`.
- `napi_symbol_for` is not exported by Bun's N-API — use a string marker.
- `napi_get_value_bigint_int64`'s `lossless` out-param is required.
- Never call `napi_create_bigint_int64`/`get_value_*` with a NULL result.
