# RESULTS

Bench: `bun bench/bench.ts [--md]` — asmzod vs `zod@4` (`safeParse`), Apple
Silicon (ARM64), Bun. asmzod numbers are the N-API direct path
(`asm/asmzod.node`); `AZ_NAPI=0` forces the encode→FFI→decode path.

| workload | asmzod | zod4 | ratio |
|---|---|---|---|
| small-obj     x50k | 0.53µs | 0.12µs | 4.48x |
| array-2000     x40 | 473µs | 118µs | 4.01x |
| deep+arr500   x400 | 9.10µs | 20.38µs | **0.45x — faster** |
| union-mixed   x30k | 0.33µs | 0.19µs | 1.79x |
| disc-union    x30k | 0.47µs | 0.10µs | 4.74x |
| record-200   x2000 | 69µs | 21µs | 3.36x |
| tuple        x30k | 0.69µs | 0.20µs | 3.52x |
| str-checks   x30k | 0.28µs | 0.15µs | 1.82x |
| strict-obj   x30k | 1.42µs | 0.21µs | 6.73x |
| lazy-rec     x30k | 2.27µs | 0.18µs | 12.68x |
| opt/null/def x30k | 0.44µs | 0.12µs | 3.54x |
| fail-issues  x10k | 3.55µs | 0.60µs | 5.96x |
| str-email    x30k | 0.21µs | 0.11µs | 1.90x |
| str-email-f  x10k | 2.21µs | 0.35µs | 6.40x |
| emoji        x30k | 1.38µs | 0.10µs | 13.8x |
| coerce-num   x30k | 0.23µs | 0.06µs | 4.07x |
| refine+trans x30k | 0.59µs | 0.21µs | 2.85x |
| msgwrap      x30k | 0.22µs | 0.06µs | 3.94x |
| msgwrap-fail x10k | 1.43µs | 0.09µs | 15.9x |
| int-safe     x30k | 0.26µs | 0.15µs | 1.73x |
| date         x30k | 0.28µs | 0.05µs | 5.6x |

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
