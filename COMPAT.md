# Compatibility contract

Drop-in target: `zod@4` (latest). The suite in `test/diff.test.ts` runs
identical schemas + inputs through AsmZod and real Zod and compares:

- `success` flag and parsed output (deep equality)
- full issue objects — every field (`code`, `expected`, `received`,
  `format`, `origin`, `pattern`, `note`, bounds, `inclusive`, `path`,
  `message`), semantically compared (key order ignored)

All three engines (N-API addon, bun:ffi dylib, portable interpreter)
must produce identical results — `AZ_ENGINE=portable bun test` runs the
same suite through the interpreter.

## Issue-shape notes

- `invalid_union` issues carry `errors`: arrays of per-option issue
  arrays. Nested/lazy unions are re-resolved TypeScript-side so the
  structure survives compilation.
- Record-key failures are wrapped as `invalid_key{origin:"record",
  issues:[...], path:[key]}` — all three engines.
- String-format issues follow zod's field conventions: some formats
  expose `pattern` + `origin`, some only `format`, some a `note`.
  `FORMAT_MSGS`/`FORMAT_NOTES`/`FORMAT_ORIGINS` in `src/shared.ts` hold
  the tables; `normalizeIssue` enforces them.
- `.int()`/`.safe()` enforce zod's safe-integer bound (±2^53-1) and
  emit `too_small`/`too_big` with `origin:"int"` +
  `note:"Integers must be within the safe integer range."`.
- Invalid `Date` objects → `invalid_type` with `received:"Invalid Date"`.
- Template literals → `invalid_format` with `format:"template_literal"`.
- Custom messages: string, `{message}`, `{error}` (string or callback),
  `{abort}` — supported on checks *and* at schema level (schema-level
  errors apply to issues raised at that node's own depth via opcode
  0x2A `MSGWRAP`).
- `Object.create(null)` and other exotic-prototype inputs are treated
  exactly as zod treats them per type.

## Known gaps

- Async checks **nested inside compiled schemas** (e.g.
  `z.object({f: z.string().refine(async () => true)})`) throw
  "Encountered Promise during synchronous parse" even in `parseAsync` —
  the engine cannot suspend mid-walk. Top-level async effects
  (`schema.refine/transform/superRefine` called directly or at the end
  of a `.pipe` chain) replay correctly via `safeParseAsync`.
- `z.map`/`z.set` keys validate per-entry at the TS layer; values run
  through the engine.
- `bigint` checks bounded by i64 in the native engines — beyond that,
  inputs route to the portable engine (same results, slower path).
