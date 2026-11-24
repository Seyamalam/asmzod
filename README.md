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
your code ──► TS shim (src/)                ──► ARM64 engine (asm/*.s)
              z.* schema builders                bytecode interpreter, N-API
              schema ──► binary bytecode         addon or bun:ffi dylib —
              output ◄── native values           walks JS values in place
              issues ◄── ZodError                or tagged arenas on FFI
```

- The TS layer lowers a schema tree into compact bytecode (`FORMAT.md`).
- On Node/Bun the **N-API addon** (`asmzod.node`) walks `napi_value`s
  directly — success returns the value untouched, failure returns a
  natively-built issue array. No serialization on the hot path.
- Under `bun:ffi` (`libasmzod.dylib`/`.so`) the same engine validates a
  tagged-binary encoding; arenas are pooled across calls.
- `.refine()`, `.transform()`, `.regex()`, `.lazy()`, `.instanceof()`,
  `.coerce()` and `.custom()` call back into JavaScript *from inside
  the assembly* — user functions are JS no matter what, even in Zod.
- With no native backend (Workers, browsers, Deno today) a portable TS
  interpreter runs the identical bytecode — same issues, same suite.

## Requirements

- ARM64 (Apple Silicon, or Linux arm64)
- One of: [Bun](https://bun.sh), Node ≥ 18, Deno — or any JS runtime at
  all for the portable fallback
- `clang` (Xcode CLT on macOS) to assemble the engine

## Build & test

```sh
bun install
make ci             # assemble + full suite (Bun + portable + Node + Deno)
bun test            # unit + differential tests against real zod
bun run bench       # asm vs zod
bun scripts/doctor.ts   # which backend am I on?
bun scripts/dump.ts 'z.string().email()'   # disassemble a schema
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
| `z.map` `z.set` | ✅ validated entry-by-entry at the TS layer |
| `promise` `function` schemas | ❌ not yet |
| `bigint` | i64 range only |
| union errors (`invalid_union.errors`) | ✅ per-option arrays + zod-4 best-match semantics |

## Runtime support

Three engines, one API — picked at load time (`src/ffi.ts`):

| runtime | backend | notes |
|---|---|---|
| **Node ≥ 18** (macOS/Linux arm64) | `asmzod.node` N-API addon | validates `napi_value`s in place — no encode/decode |
| **Bun** (macOS/Linux arm64) | N-API addon, or `bun:ffi` + dylib | both verified; N-API is the fast path |
| **Bun** (Linux arm64) | same | `bun run test:linux` runs the suite in Docker |
| **Deno** | portable interpreter | `deno test --no-check` |
| **Cloudflare Workers / browsers / bundlers** | portable interpreter | module never statically imports `node:*`/`bun:*` — natives are probed lazily |

The portable engine (`src/engine.ts`) interprets the **same bytecode**
the ARM64 engines use and passes the identical 121-case differential
suite (`AZ_ENGINE=portable bun test`). `engineBackend` exports which
backend is live; `bun scripts/doctor.ts` tells you.

## Performance

Honest answer: **within ~1–3× of Zod on success paths, sometimes
faster, still slower on failures.** See [`RESULTS.md`](RESULTS.md) for
the full table and [`PERF.md`](PERF.md) for how it got here. Highlights
(M-series Mac, Bun):

| workload | ratio vs zod4 |
|---|---|
| deep nested + 500-elem array | **0.30× — faster** |
| record of 200 entries | **0.90× — faster** |
| tuple | **0.97× — faster** |
| small object | 2.7× |
| union dispatch | 1.75× |
| failure + issues | 6.3× — the gap that remains |

Failures are slow because real issue objects cost ~1µs each to build +
normalize; success paths often beat zod because the asm walker
allocates nothing when nothing changed.

## Honest limitations

- **arm64 only for the native engines.** Other architectures fall back
  to the portable interpreter.
- `.parseAsync` and async `.refine` are rejected at runtime.
- `.regex()` and callback checks execute in JS (via `napi_call_function`
  inside the addon); built-in formats run in assembly.
- Error `message` strings match Zod's defaults; custom `errorMap`s are
  applied JS-side.
- See [`COMPAT.md`](COMPAT.md) for the full issue-shape contract.

## Layout

```
asm/        the engine — AArch64 assembly, one concern per file
src/        TypeScript API layer — schema classes, codec, engines, ZodError
test/       bun:test — unit + differential + fuzz tests vs real zod
bench/      benchmarks                  scripts/  dump + doctor CLIs
docker-test.sh   Linux arm64 suite      justfile  task aliases
FORMAT.md   the binary contract         ARCHITECTURE.md  how it fits together
COMPAT.md   the zod-compat contract     PERF.md  perf notes   RESULTS.md  numbers
```

Built for fun. Ship at your own risk.
