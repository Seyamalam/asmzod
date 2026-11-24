# RESULTS

Bench: `bun bench/bench.ts [--md]` — asmzod vs `zod@4` (`safeParse`), Apple
Silicon (ARM64), Bun. asmzod numbers are the N-API direct path
(`asm/asmzod.node`); `AZ_NAPI=0` forces the encode→FFI→decode path.

| workload | asmzod | zod4 | ratio |
|---|---|---|---|
| small-obj     x50k | 0.28µs | 0.12µs | 2.41x |
| array-2000     x40 | 330.78µs | 130.00µs | 2.54x |
| deep+arr500   x400 | 5.41µs | 20.45µs | **0.26x — faster** |
| union-mixed   x30k | 0.18µs | 0.12µs | 1.43x |
| disc-union    x30k | 0.20µs | 0.10µs | 1.99x |
| record-200   x2000 | 16.70µs | 19.54µs | **0.85x — faster** |
| tuple        x30k | 0.15µs | 0.16µs | **0.98x — faster** |
| str-checks   x30k | 0.81µs | 0.16µs | 5.17x |
| strict-obj   x30k | 1.37µs | 0.17µs | 7.89x |
| lazy-rec     x30k | 0.35µs | 0.28µs | 1.27x |
| opt/null/def x30k | 0.20µs | 0.13µs | 1.60x |
| fail-issues  x10k | 3.01µs | 0.43µs | 7.09x |

## Where the time goes

- **Success path** is one N-API call per value inspected
  (`typeof`/`get_element`/`get_named_property`) — ~40ns/call is the floor
  for an external validator; leaf schemas return the input handle
  verbatim and unchanged arrays return the input array (no output
  materialization).
- **`str-checks`** goes through the regex path → JS callback → FFI
  fallback. Inherent: regex needs the JS RegExp engine.
- **`strict-obj`** input carries an extra key, so every parse fails with
  `unrecognized_keys` — it measures the failure path, not objects.
- **`fail-issues`** builds native issue objects then TypeScript
  post-processing (`normalizeIssue`/`finishIssues`) interpolates zod's
  messages — cold path, ~1µs/issue.
- **deep+arr / record** beat zod because the asm walker has no
  allocation on the hot path (issue arena is bump-only and untouched on
  success).

## History

| change | effect |
|---|---|
| encode→FFI→decode baseline | ~20–40x vs zod |
| N-API addon (`aznapi_run`) | small-obj 2.4x, deep faster than zod |
| native issue arrays | fail 6.7µs → ~3µs |
| raw-value success contract | wrapper calls dropped, ~120ns/parse |
| return-input-if-unchanged (arrays) | array-2000 351→338µs |
| lazy thunk dedup + lazytab | lazy 162x → 1.4x |
