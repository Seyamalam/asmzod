# RESULTS

Bench: `bun bench/bench.ts [--md]` — asmzod vs `zod@4` (`safeParse`), Apple
Silicon (ARM64), Bun. asmzod numbers are the N-API direct path
(`asm/asmzod.node`); `AZ_NAPI=0` forces the encode→FFI→decode path.

| workload | asmzod | zod4 | ratio |
|---|---|---|---|
| small-obj     x50k | 0.29µs | 0.10µs | 2.79x |
| array-2000     x40 | 319.02µs | 109.48µs | 2.91x |
| deep+arr500   x400 | 6.17µs | 17.67µs | **0.35x — faster** |
| union-mixed   x30k | 0.19µs | 0.12µs | 1.64x |
| disc-union    x30k | 0.23µs | 0.09µs | 2.53x |
| record-200   x2000 | 15.43µs | 17.07µs | **0.90x — faster** |
| tuple        x30k | 0.17µs | 0.16µs | 1.07x |
| str-checks   x30k | 0.17µs | 0.12µs | 1.46x |
| strict-obj   x30k | 1.31µs | 0.16µs | 8.13x |
| lazy-rec     x30k | 0.37µs | 0.27µs | 1.37x |
| opt/null/def x30k | 0.20µs | 0.11µs | 1.83x |
| fail-issues  x10k | 2.74µs | 0.43µs | 6.36x |

## Where the time goes

- **Success path** is one N-API call per value inspected
  (`typeof`/`get_element`/`get_named_property`) — ~40ns/call is the floor
  for an external validator; leaf schemas return the input handle
  verbatim and unchanged arrays return the input array (no output
  materialization).
- **`str-checks`** runs natively: check records are walked one at a
  time, regex hits the host's `RegExp.test` through a single N-API
  call instead of bouncing through the whole FFI engine.
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
