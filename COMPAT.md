# Compatibility contract

Upstream suite: **1628/1628** zod classic tests pass (all 91 files —
`packages/zod/src/v4/classic/tests` run against `src/index.ts` via a
vitest alias harness, `zod/mini` mapped to `src/mini.ts`).

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

## Zod-suite status (v4 classic, 2026)

The repo's own tests were run against `packages/zod/src/v4/classic/tests`
(vitest, `zod/v4` + relative imports aliased to `src/index.ts`). Baseline
after the Node/V8 `napi_ref` handle-lifetime fix:

- ~500/~1000 assertions failing across ~65 files; `anyunknown`, `brand`,
  `custom`, `json`, `nullable`, `nan`, `prototypes`, `validations`,
  `from-json-schema` (111) and others are fully green.
- Largest failure clusters: `object`, `cyclic-data`, `deep-partial`,
  `discriminated-unions`, `error-utils`, `record`, `error`, `string`,
  `to-json-schema-methods`, `catch`, `record`.
- Recurring missing semantics: `{ checks: [...] }` factory params,
  `schema._zod.*` internals (`traits`, `parent`, `def`), `z.validate`,
  `.includes({position})`, exact message snapshot wording, symbol-keyed
  object schemas, cyclic input data, `default`/`catch`/`prefault` output
  transforms, error-util shapes (`flatten`/`format`/`prettify`/`treeify`),
  codec/pipe `in`/`out` typing behavior, detached methods.
- Harness: `/private/tmp/zodsuite` (vitest 3.2.7, alias config maps
  `zod`, `zod/*`, and `../index.js`/`../from-json-schema.js`/
  `../deep-partial.js` relative imports to `src/index.ts`).

Node/V8 no longer crashes the suite — callback tables store persistent
`napi_ref`s instead of scoped `napi_value`s.
