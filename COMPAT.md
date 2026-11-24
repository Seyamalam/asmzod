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

- `parseAsync`/async refinements: the engine is synchronous machine
  code; async paths throw (same as calling them on a sync-only schema).
- `z.map`/`z.set` validate at the TS layer (no dedicated opcode).
- `bigint` checks bounded by i64 (native) — beyond that, portable path.
- `z.promise`/`z.function` schemas: not implemented.
