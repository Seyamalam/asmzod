# AsmZod

> **This project is for shits and giggles.** Nobody asked for this. Nobody
> needed this. We took a perfectly good, JIT-optimized, battle-tested
> TypeScript validation library and reimplemented its core in **hand-written
> ARM64 assembly** — because "it works" was never the point. If you're
> evaluating this for production: seek help. If you're reading the source:
> welcome, bring popcorn and a debugger.

A drop-in [Zod](https://zod.dev) replacement where the **entire validation
engine is written in ARM64 assembly**.

```ts
import { z } from "asmzod";

const User = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().gte(0).optional(),
});

User.parse(input);          // validated by machine code, not JavaScript
type User = z.infer<typeof User>;  // still fully typed
```

## How it works

Zod's API surface is inherently JavaScript — `z.object({...})` is a function
call and `z.infer` is TypeScript types. What *can* be assembly is everything
underneath: the actual validation. So AsmZod is two layers:

```
your code ──► TS shim (src/)              ──► ARM64 engine (asm/*.s)
              z.* schema builders               recursive bytecode interpreter
              schema ──► binary bytecode        validates tagged input values
              value  ──► tagged binary          writes result + issues to arenas
              issues ──► ZodError               pure machine code, zero JS
```

- The TS layer lowers a schema tree into a compact bytecode and serializes
  the input into a tagged binary format (see [`FORMAT.md`](FORMAT.md)).
- The engine (`libasmzod.dylib`, loaded via `bun:ffi`) is a recursive-descent
  validator over that bytecode. String checks (email, uuid, min/max counted
  in UTF-16 units like real Zod, …) and number checks (f64 compares,
  multipleOf, int) run in assembly.
- Results and validation issues are written to caller-provided arenas;
  the JS side decodes them into real `ZodError`s with proper `path`s.
- `.refine()`, `.transform()`, `.regex()`, `.lazy()`, `.instanceof()` and
  `.custom()` call **back into JavaScript from the assembly** through FFI
  callbacks — user functions are JS no matter what, even in real Zod.
  Non-serializable values (`Date`, class instances, symbols, `Map`, `Set`)
  flow through the engine as `HOSTREF` handles.

## Requirements

- macOS on Apple Silicon (arm64)
- [Bun](https://bun.sh) (uses `bun:ffi` to load the dylib)
- Xcode CLT (`clang`, for assembling the engine)

## Build & test

```sh
bun install
bun run build     # assembles asm/*.s -> asm/libasmzod.dylib
bun test          # unit + differential tests against real zod
bun run bench     # asm vs zod
```

## API coverage

Drop-in target is `zod@4.6.7`. The differential suite
(`test/diff.test.ts`) runs identical schemas and inputs through both
AsmZod and real Zod and compares success, output values, and issue
codes+paths — currently **50/50 cases green**, plus 15 API tests.

| Area | Status |
|---|---|
| `string` `number` `boolean` `bigint` `date` `symbol` `undefined` `null` `void` `nan` `any` `unknown` `never` | ✅ engine |
| `object` (strict/strip/passthrough/catchall), `array`, `tuple`, `record`, `enum`, `literal`, `nativeEnum` | ✅ engine |
| `optional` `nullable` `nullish` `default` `catch` `readonly` | ✅ engine / passthrough |
| `union` `discriminatedUnion` `intersection` `pipe`/`brand` | ✅ engine |
| `refine` `superRefine` `transform` `custom` `lazy` `instanceof` `coerce` `regex` | ✅ via asm→JS callbacks |
| `z.infer` / `z.input` / `z.output` type machinery | ✅ |
| `safeParse` `parse` `spa` sync parsing; `ZodError` + `format`/`flatten`/`issues` | ✅ |
| `parseAsync` / async refinements | ❌ throws (engine is synchronous machine code) |
| `map` `set` `promise` `function` | ❌ not yet |
| `bigint` | i64 range only |
| `unionErrors` detail on union failure | approximated (single `invalid_union` issue) |

## Performance

Honest answer: **slower than Zod on everything we've measured.** Zod 4
JIT-compiles validators into tight JS; AsmZod pays a fixed toll per parse
(encode JS value → FFI call → asm validate → decode result). Measured on
an M-series Mac, Bun 1.4:

| workload | asmzod | zod@4.6.7 | ratio |
|---|---|---|---|
| small object | 11.8µs | 0.13µs | ~92× slower |
| union dispatch | 10.1µs | 0.16µs | ~62× slower |
| failure + issues | 17.7µs | 0.55µs | ~32× slower |
| array of 2000 objects | 4.23ms | 121µs | ~35× slower |
| deep nested + 500-elem array | 104µs | 22µs | ~4.7× slower |

The ratio shrinks as inputs grow (92× → 4.7×) — the marshaling, not the
engine, is the bottleneck. This project was never about speed; it's
about answering the question "can you make `z.object()` run on raw ARM64"
with "yes, and here's a 50-case differential suite to prove it."

## Honest limitations

- **Bun only.** `bun:ffi` is the bridge; Node support would need a N-API
  loader (which is C glue — doable, not yet done).
- **arm64 macOS only.** The engine is hand-written AArch64.
- `.parseAsync` and async `.refine` are rejected at runtime.
- `.regex()` patterns execute in JS (via callback); every *built-in* string
  format check runs in assembly.
- Error `message` strings match Zod's defaults; custom `errorMap`s are
  applied JS-side.

## Layout

```
asm/        the engine — AArch64 assembly, one concern per file
src/        TypeScript API layer — schema classes, codec, FFI, ZodError
test/       bun:test — unit tests + differential tests vs real zod
bench/      benchmarks
FORMAT.md   the binary contract (bytecode + value encoding + FFI ABI)
```

Built for fun. Ship at your own risk.
