# Architecture

Two layers, two engines, one API.

```
your code
   │
   ▼
src/schema.ts        z.* schema builders, _def trees, _compile()
src/bytecode.ts      schema tree ──► binary bytecode blob (FORMAT.md)
src/codec.ts         JS values ◄──► tagged binary encoding
   │
   ├──► N-API addon (asm/napi.s → asmzod.node)      Node ≥18, Bun, Deno
   │      walks JS values directly via napi_* calls — no encode/decode
   │      on the success path; issues built as native JS arrays
   │
   ├──► bun:ffi dylib (asm/*.s → libasmzod.dylib/.so)  Bun + arm64
   │      encode → az_parse → decode; arenas pooled across calls
   │
   └──► portable interpreter (src/engine.ts)         everywhere else
          same bytecode + tagged format, pure TS — Cloudflare Workers,
          browsers, bundlers, anything with a JS VM
```

Backend selection is in `src/ffi.ts`: probe `asmzod.node` (N-API), then
`bun:ffi`, then portable. `AZ_ENGINE=portable` forces the interpreter.
`engineBackend` / `engineVersion` export what's live.

## The N-API path (the fast one)

The addon is ~3000 lines of hand-written aarch64 implementing the same
bytecode interpreter as the dylib — but instead of a tagged binary input
it walks `napi_value`s in place:

- **success**: returns the output `napi_value` directly. Leaves return the
  input handle verbatim; containers stage children and return the input
  object/array untouched when nothing changed (no allocation at all).
- **failure**: builds the issue array as real JS objects inside the addon
  and returns `{["~azres"]: true, issues}` — no result buffer, no decode.
- **callbacks**: `.refine`/`.transform`/`.custom`/`.regex`/`lazy`/
  `instanceof`/`coerce` call JS functions through `napi_call_function`;
  a thrown callback propagates as a pending exception (matches zod).
- **batch**: `parseMany`/`safeParseMany` loop inside the addon —
  one JS↔native crossing for N values.

Scratch arenas (string buffers, issue arena, path stack, output staging)
are `malloc`ed once in `init` and grown on demand — zero allocation per
parse on the hot path.

## Registers that matter (napi.s)

| reg | role |
|---|---|
| x20 | scratch byte buffer base |
| x21 | issue arena cursor |
| x22 | arena base (path stack / issues / output staging live in it) |
| x23 | blob base, x24 env, x25 host table, x26 cb table |

Rule #1 of the codebase: **nobody saves/restores x20–x22 across a call
that emits issues.** `_azn_strmixed` once restored x21 and silently ate
the issue the string checks had just written — the next issue overwrote
it and the issue count lied. Git history has the war story.

## The FFI path (bun:ffi)

`az_parse(blob, input, out, outCap, err, errCap, cbTable)` — the dylib
validates a pre-encoded tagged value and writes the tagged result +
issue records into caller arenas. `-3`/`-4` = arena overflow → grow and
retry. JS callbacks come in through `cbTable` (refine/transform/custom/
regex/lazy/instanceof). See FORMAT.md for the wire format.

## The portable path

`src/engine.ts` interprets the identical blob against live JS values —
same opcode semantics, same issue construction. It's the correctness
reference and the only engine that runs everywhere; the differential
suite runs it under `AZ_ENGINE=portable` so all three engines are held
to the same 121-case contract.
