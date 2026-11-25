# AsmZod

Experimental drop-in replacement for the latest zod (`zod@4`) with a
hand-written ARM64 validation core. This project is for shits and
giggles — the only contract that matters is latest-zod compatibility.

## License to rewrite

Feel free to delete and rewrite entire sections and parts. Nothing is
sacred — the asm core, the TS pipeline, the engine, the bytecode format,
internal APIs. Rewrite aggressively whenever it buys compat or speed.
No backwards-compatibility burden inside the repo; the compat target is
upstream zod's public surface only.

## Perf posture

- Never pay a fixed JS-value → FFI → decode toll per parse. The N-API
  direct path walks `napi_value`s natively; keep it.
- `parse`/`safeParse` short-circuit to the addon after one proven
  native run (`Compiled.napi` flag). Success paths stay out of the TS
  pipeline entirely.
- Builtin format fns stay in JS at leaf level (zod-exact semantics);
  the engine's native format opcodes are allowed inside containers.
- Failure paths may stay slower — they're cold. Exact issue semantics
  beat speed there.
- zod4's monomorphic JS is ~50–100ns/property; the N-API crossing floor
  is ~40ns/call. Beat it with fewer crossings, batch APIs, and leaner
  asm — not by skipping semantics.

## Verification

- `make ci` — asm build, typecheck, bun suite, portable engine, node,
  deno, workerd. Local only; no GitHub Actions by design.
- `make ci-linux` — docker linux/arm64 (mounts the tree read-only).
- Upstream suite: `/tmp/zodsuite` vitest harness aliases `zod*` imports
  to `src/index.ts` / `src/mini.ts`. Currently 1628/1628.
- `AZ_ENGINE=portable` and `AZ_NAPI=0` force the fallback paths.
- Bench: `bun bench/bench.ts` — ratio column is asmzod/zod4.
