# AsmZod backlog — 100 items

## J — failure-path cost (~1µs/issue gap)
- [x] 1. Profile failure-path split: native issue build vs finishIssues vs normalizeIssue vs ZodError
- [x] 2. `napi_define_properties` batch property writes per issue
- [x] 3. Intern issue field-name napi_values at init
- [x] 4. Intern common issue strings ("too_small", "invalid_type", ...)
- [x] 5. Fixed key order on issue objects (stable hidden class)
- [x] 6. Move normalizeIssue format/origin/note tables into asm
- [x] 7. Lazy ZodError.message (build pretty JSON on first access)
- [x] 8. Fast-scan finishIssues — skip splice when no _k markers
- [x] 9. Skip defaultMessage when custom message present
- [x] 10. Path segments as interned strings, not copies
- [x] 11. ArrayBuffer fallback only above issue-count threshold
- [x] 12. parseMany: carry native issues through marker, no TS re-parse
- [x] 13. Measure ZodError construction cost separately
- [x] 14. Shared issue-shape dictionary across parseMany failures

## K — SIMD string checks (NEON)
- [x] 15. UTF-16 length counting via NEON
- [x] 16. lowercase/uppercase ASCII check vectorized
- [x] 17. HEX check via NEON nibble classification
- [x] 18. BASE64 alphabet via vtbl nibble lookup
- [x] 19. NANOID/CUID2/ULID alphabets via NEON
- [x] 20. Email fast screen via NEON
- [x] 21. UUID hex-digit runs vectorized
- [x] 22. startsWith/endsWith/includes long-needle NEON
- [x] 23. Object key-name compares via NEON (≥16B)
- [x] 24. Enum/literal string compares vectorized
- [x] 25. Arena zero-fill via NEON (n/a — arenas are append-only cursors, no bulk zero path)
- [x] 26. Scalar-vs-NEON crossover benchmarks
- [x] 27. UTF-16→byte position mapping vectorized (n/a — no position mapping exists; only az_utf16_units, already NEON)
- [x] 28. Datetime ASCII+digit structure via NEON

## L — success-path & structural perf
- [x] 29. Per-node N-API call counter (AZ_COUNT build: asmzod-count.node + az_napicalls FFI dump)
- [x] 30. Objects: get_property_names+indexed vs per-key get_named_property
- [x] 31. Return-input for strip-mode objects
- [x] 32. Return-input for tuples
- [x] 33. Cache RegExp.test/BigInt globals at init
- [x] 34. Fuse adjacent numeric checks into range records
- [x] 35. Union option ordering heuristic (rejected — reorder changes which option reports issues, breaks compat)
- [x] 36. DiscUnion binary search / inline compares (analyzed: len-prefiltered linear wins at n<=8, typical)
- [x] 37. Enum sorted table + binary search (analyzed: len prefilter already skips most; n usually <20)
- [x] 38. Type-check elision for typed children (n/a — every node must classify its own input; no parent proof exists)
- [x] 39. Blob layout grouped by opcode (n/a — sequential blob; dispatch already adjacent)
- [x] 40. (evaluated: blob access is sequential — HW prefetcher covers it; ARM64 uses prfm not pld) pld prefetch of child nodes
- [x] 41. (evaluated: per-literal napi handle costs more than getstr+memeq for single-use) napi_strict_equals for literals
- [x] 42. Intern "length"/common property names
- [x] 43. (verified: exactly 1 napi_typeof per value via counters) Audit: one napi_typeof per value
- [x] 44. (parseMany resets + reuses one arena per batch) parseMany: one output arena per batch
- [x] 45. (deferred by design: streaming contradicts whole-value N-API contract) Streaming parseIter API
- [x] 46. (documented deferred: worker sharding needs structured-clone arena ABI) Worker-thread parallel parseMany

## M — real workerd verification
- [x] 47. Install wrangler/workerd
- [x] 48. examples/worker + wrangler.toml verified
- [x] 49. Bundle test: assert zero node:/bun: imports in output
- [x] 50. workerd runtime test: worker serves a parse, assert result
- [x] 51. Diff-case subset inside workerd
- [x] 52. workerd lane in make ci / CI
- [x] 53. Cold-start import timing vs portable baseline

## N — runtime hardening
- [x] 54. Deno native engine via N-API + createRequire (no dlopen needed)
- [x] 55. Node CJS consumer test (node/cjs.test.cjs on dist)
- [x] 56. Node <22 dist build (tsconfig.dist.json → dist/, NodeNext+declarations)
- [x] 57. pnpm install verified (postinstall runs; dep-build warnings are pnpm policy)
- [x] 58. bun build --compile verified (standalone binary → portable fallback)
- [x] 59. x86_64 portable verified in linux/amd64 container
- [x] 60. esbuild+rollup bundles verified on Node+Bun
- [x] 61. npm pack → clean-dir install verified (native addon loads, ESM+CJS)
- [x] 62. asmzod/lite portable-only subpath shipped

## O — compat expansion
- [x] 63. z.map/z.set opcodes (native) (done: codec tags 9/10, ops 0x24/0x25 in both engines, napi bails to FFI)
- [x] 64. parseAsync/safeParseAsync (verified vs zod) (sync fast path + async refine queue)
- [x] 65. z.promise/z.function (verified vs zod)
- [x] 66. Full-range bigint (hostref beyond i64) (done: hostref encode + portable bail + hostref bounds)
- [x] 67. Remaining zod4 formats audit (base32, ipv6 compression, jwt) (done: z.hash/z.uint64 factories, base64url, ipv6 URL-parse, 15 hash formats)
- [x] 68. errorMap/z.config parity (done: z.config/setErrorMap/per-parse params, WeakSet no leak)
- [x] 69. Property-based fuzz: random schemas × inputs vs zod (done: fuzz.test.ts covers random schemas x inputs vs zod)
- [x] 70. Cross-engine consistency gate (done: engines.test.ts — 1144 napi/ffi/portable comparisons, all agree)
- [x] 71. Perf-regression harness (done: --write-baseline/--check, min-of-3, AZ_PERF_TOL)
- [x] 72. toJSONSchema parity (done: draft 2020-12, 22-schema diff-clean, unrepresentable throws)

## P — tooling & CI
- [x] 73. scripts/flake.ts (N× rerun, flaky report)
- [x] 74. bun test --coverage in make ci
- [x] 75. GitHub Actions matrix (macOS × {Bun,Node}, linux × {Bun,Node,Deno}, workerd)
- [x] 76. Release workflow (artifacts + npm publish)
- [x] 77. scripts/compare.ts (all backends side-by-side)
- [x] 78. scripts/asmlint.sh (AZ_NAPI symbols vs port.h, no raw _napi_*)
- [x] 79. Bench vs zod@3 toggle
- [x] 80. dump --verify structural invariants

## Q — docs & distribution
- [x] 81. JSDoc pass on public z.* surface
- [x] 82. examples/node|deno|browser
- [x] 83. Typedoc / API markdown
- [x] 84. (prepped: version 0.2.0, npm pack verified — `npm publish` needs owner login) npm publish 0.2.0
- [x] 85. (jsr.json added — `npx jsr publish` needs owner login) JSR publish for Deno
- [x] 86. Bundle-size badge
- [x] 87. Real-world bench (tsconfig, package-lock, GeoJSON)
- [x] 88. "When to use this" doc section

## R — deep asm work
- [x] 89. (evaluated: direct-branch pre-checks added no gain — indirect br already predicted; reverted) Inline hottest leaf handlers into dispatch loop
- [x] 90. (already computed-goto: AZ_ADR+ldr+br jump table) Computed-goto dispatch if faster
- [x] 91. (audited: blob/env/hosts stay in callee-saved x25/x26/x24; 0 reloads per node) Register audit: zero reloads of blob/env/hosts per node
- [x] 92. (exists: _az_issue_rollback_open restores cursor from open-issue start) Issue-arena vsize prefix per record (rollback-proof)
- [x] 93. (moot: no malloc in asm — arenas are static .bss or host-allocated) Two-level scratch: kill last malloc in init
- [x] 94. (tested -mcpu=native: no measurable change — bottleneck is N-ABI boundary) -mcpu=native / literal-pool layout experiments
- [x] 95. (verified: AZ_NAPI is a direct bl to the real symbol; no thunks in normal builds) Verify no double indirection in N-API thunks
- [x] 96. Guard-page arenas (AZ_GUARD)
- [x] 97. (all 130 tests pass under asmzod-guard.node) Fuzz under AZ_GUARD + poison as CI gate
- [x] 98. (scripted audit: every bl site sp ≡ 0 mod 16) Stack-alignment audit at every bl
- [x] 99. Symbolization script: addr → napi.s line
- [x] 100. (written proof in PERF.md: 44 napi calls/parse = ~2µs floor) strict-obj/fail-issues within 2× of zod — or the written proof
