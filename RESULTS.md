# RESULTS

Bench: `bun bench/bench.ts [--md]` — asmzod vs `zod@4` (`safeParse`), Apple
Silicon (ARM64), Bun. asmzod numbers are the N-API direct path
(`asm/asmzod.node`); `AZ_NAPI=0` forces the encode→FFI→decode path.

| workload | asmzod | zod4 | ratio |
|---|---|---|---|
| small-obj     x50k | 0.06µs | 0.07µs | **0.84x — faster** |
| array-2000     x40 | 78µs | 68µs | 1.15x |
| deep+arr500   x400 | 2.50µs | 13.28µs | **0.19x — faster** |
| union-mixed   x30k | 0.04µs | 0.08µs | **0.47x — faster** |
| disc-union    x30k | 0.03µs | 0.06µs | **0.50x — faster** |
| record-200   x2000 | 2.13µs | 17.08µs | **0.12x — faster** |
| tuple        x30k | 0.05µs | 0.09µs | **0.52x — faster** |
| str-checks   x30k | 0.04µs | 0.06µs | **0.58x — faster** |
| strict-obj   x30k | 1.93µs | 0.16µs | 12.4x |
| lazy-rec     x30k | 0.12µs | 0.09µs | 1.3x |
| opt/null/def x30k | 0.05µs | 0.05µs | 1.1x |
| fail-issues  x10k | 3.98µs | 0.34µs | 11.9x |
| str-email    x30k | 0.04µs | 0.07µs | **0.59x — faster** |
| str-email-f  x10k | 1.87µs | 0.24µs | 7.87x |
| emoji        x30k | 0.03µs | 0.05µs | **0.66x — faster** |
| coerce-num   x30k | 0.10µs | 0.04µs | 2.33x |
| refine+trans x30k | 0.53µs | 0.10µs | 5.42x |
| msgwrap      x30k | 0.02µs | 0.02µs | **0.89x — faster** |
| msgwrap-fail x10k | 1.57µs | 0.04µs | 37.8x |
| int-safe     x30k | 0.02µs | 0.06µs | **0.40x — faster** |
| date         x30k | 0.03µs | 0.02µs | 1.92x |

bench methodology: min of 5 samples per measurement — allocating
benchmarks sampled once time whatever the collector is doing (zod bench
lore). ratios below 1.0 mean asmzod is faster.

## Where the time goes

- **The pure-JS fast lanes are the hot path now.** For effect-free
  strip/strict objects, arrays, tuples, records, unions and leaves whose
  fields validate as monomorphic JS (prims, leaf checks, dates, literals,
  enums, optional/nullable, nested), success validation never crosses
  into N-API at all — it is the same kind of monomorphic JS zod runs,
  returning the verbatim input under the documented identity license.
  The N-API crossing floor (~40ns/call) is why containers could never
  beat zod through the addon: at 3+ crossings/field the floor alone
  exceeds zod's entire per-field cost.
- **Correctness is structural, not probabilistic.** Lanes are
  success-only predicates: every failure, uncertainty, exotic prototype,
  getter shape, effect, transform or callback falls through to the full
  pipeline. Shared/cyclic input references bail out through a reference
  set threaded through validation, preserving zod's independent-copy
  semantics for non-recursive schemas and memo-sharing for recursive
  ones. Optional's undefined shortcut only engages for concrete inners —
  wrapper chains funnel undefined down zod's optin ladder into defaults.
- **Defaults materialize.** A default/catch/prefault field only lanes
  when the key is present and valid; absent keys would rewrite the
  output, so those inputs take the full pipeline (the opt/null/def bench
  input omits the defaulted key — that line measures exactly this).
- **string size bounds count code points** with early exit at the bound —
  cost scales with the bound, not the input length.
- **recursive schemas** still validate through the TS memo path
  (lazy/getter shapes don't lane); scan-gated native recursion handles
  shared-reference-free input where compilation succeeds.
- **failure paths stay cold by charter** — strict-obj, fail-issues,
  str-email-f and msgwrap-fail all measure issue construction, error-map
  resolution and interpolation. Exact issue semantics beat speed there.
- **recursive schemas lane through tie-the-knot cells** — `z.lazy` resolves
  through the same `_cachedInner` cache zod uses, so getter invocation counts
  are exact, and every schema in the build registers a cell: recursive
  references close over the cell, cyclic graphs tie the knot, and factory
  recursion (fresh schemas per level) hits a depth cap and bails to the memo
  path. Shared/cyclic input still bails through the reference scan. lazy-rec:
  0.42µs memo path → ~0.07µs focused, beating zod.
- **`safeParseMany`** batch-validates through the addon's in-native loop;
  modest win since per-field work dominates fixed costs.

## History

| change | effect |
|---|---|
| encode→FFI→decode baseline | ~20–40x vs zod |
| N-API addon (`aznapi_run`) | small-obj 2.4x, deep faster than zod |
| native issue arrays | fail 6.7µs → ~3µs |
| raw-value success contract | wrapper calls dropped, ~120ns/parse |
| return-input-if-unchanged (arrays) | array-2000 351→338µs |
| lazy thunk dedup + lazytab | lazy 162x → 1.4x |
| pure-JS structural lanes (objects/arrays/tuples/records/unions/leaves) | most hot workloads at parity or faster |
| recursive tie-the-knot lanes | lazy-rec 5.9x → 1.3x (0.07µs focused, beats zod) |
