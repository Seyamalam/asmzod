# RESULTS

Bench: `bun bench/bench.ts [--md]` — asmzod vs `zod@4` (`safeParse`), Apple
Silicon (ARM64), Bun. asmzod numbers are the N-API direct path
(`asm/asmzod.node`); `AZ_NAPI=0` forces the encode→FFI→decode path.

| workload | asmzod | zod4 | ratio |
|---|---|---|---|
| small-obj     x50k | 0.29µs | 0.11µs | 2.69x |
| array-2000     x40 | 315.77µs | 107.91µs | 2.93x |
| deep+arr500   x400 | 5.43µs | 18.25µs | **0.30x — faster** |
| union-mixed   x30k | 0.20µs | 0.12µs | 1.75x |
| disc-union    x30k | 0.22µs | 0.09µs | 2.44x |
| record-200   x2000 | 15.21µs | 16.99µs | **0.90x — faster** |
| tuple        x30k | 0.15µs | 0.15µs | **0.97x — faster** |
| str-checks   x30k | 0.16µs | 0.12µs | 1.29x |
| strict-obj   x30k | 1.35µs | 0.18µs | 7.57x |
| lazy-rec     x30k | 0.38µs | 0.27µs | 1.41x |
| opt/null/def x30k | 0.21µs | 0.12µs | 1.77x |
| fail-issues  x10k | 2.75µs | 0.44µs | 6.30x |
| str-email    x30k | 0.11µs | 0.11µs | **1.00x — par** |
| str-email-f  x10k | 1.16µs | 0.26µs | 4.38x |
| emoji        x30k | 0.14µs | 0.07µs | 2.13x |
| coerce-num   x30k | 0.10µs | 0.05µs | 2.12x |
| refine+trans x30k | 0.14µs | 0.15µs | **0.93x — faster** |
| msgwrap      x30k | 0.09µs | 0.04µs | 2.03x |
| msgwrap-fail x10k | 1.20µs | 0.09µs | 13.43x |
| int-safe     x30k | 0.09µs | 0.12µs | **0.77x — faster** |
| date         x30k | 0.20µs | 0.05µs | 4.38x |

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
