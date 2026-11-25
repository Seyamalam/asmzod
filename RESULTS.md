# RESULTS

Bench: `bun bench/bench.ts [--md]` — asmzod vs `zod@4` (`safeParse`), Apple
Silicon (ARM64), Bun. asmzod numbers are the N-API direct path
(`asm/asmzod.node`); `AZ_NAPI=0` forces the encode→FFI→decode path.

| workload | asmzod | zod4 | ratio |
|---|---|---|---|
| small-obj     x50k | 0.39µs | 0.12µs | 3.23x |
| array-2000     x40 | 357µs | 120µs | 2.99x |
| deep+arr500   x400 | 8.95µs | 24.91µs | **0.36x — faster** |
| union-mixed   x30k | 0.19µs | 0.14µs | 1.36x |
| disc-union    x30k | 0.61µs | 0.14µs | 4.32x |
| record-200   x2000 | 64µs | 17µs | 3.73x |
| tuple        x30k | 0.60µs | 0.15µs | 3.90x |
| str-checks   x30k | 0.15µs | 0.13µs | 1.19x |
| strict-obj   x30k | 1.70µs | 0.18µs | 9.46x |
| lazy-rec     x30k | 1.72µs | 0.13µs | 13.20x |
| opt/null/def x30k | 0.22µs | 0.10µs | 2.09x |
| fail-issues  x10k | 3.75µs | 0.45µs | 8.26x |
| str-email    x30k | 0.13µs | 0.07µs | 1.90x |
| str-email-f  x10k | 1.95µs | 0.28µs | 6.84x |
| emoji        x30k | 0.53µs | 0.05µs | 10.6x |
| coerce-num   x30k | 0.19µs | 0.04µs | 4.65x |
| refine+trans x30k | 0.55µs | 0.17µs | 3.22x |
| msgwrap      x30k | 0.03µs | 0.03µs | 1.06x |
| msgwrap-fail x10k | 1.55µs | 0.04µs | 40.8x |
| int-safe     x30k | 0.06µs | 0.11µs | **0.61x — faster** |
| date         x30k | 0.09µs | 0.04µs | 2.50x |

## Where the time goes

- **Success path** is one N-API call per value inspected
  (`typeof`/`get_element`/`get_named_property`) — ~40ns/call is the floor
  for an external validator; leaf schemas return the input handle
  verbatim and unchanged arrays/objects return the input when nothing
  changed (depth-1 strip mode, verified by key-count pigeonhole +
  per-key own-property checks).
- **Object fields** read with `get` first and only pay a `has` crossing
  when the value is undefined (presence matters exactly there). Required
  fields whose type structurally rejects undefined skip even the typeof
  probe — absent and present-undefined are the same failure for them.
- **strict/passthrough/catchall** skip the unknown-key scan entirely
  when input key count equals the count of present declared keys —
  input = declared + unknown with no duplicates, so equality is exact.
- **`safeParseMany`** batch-validates through the addon's in-native loop;
  the win over per-value `safeParse` is small (~12%) because per-object
  crossings dominate, not fixed entry costs.
- **`lazy-rec`** recursive schemas route to the TS memo path — cyclic
  input data can't be distinguished from deep data without memoization,
  so native compilation is blocked. Enabling it needs a depth cap in
  the asm walker with a whole-parse TS fallback; documented in the
  backlog.
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
