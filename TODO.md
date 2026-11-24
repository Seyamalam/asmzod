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
- [ ] 15. UTF-16 length counting via NEON
- [ ] 16. lowercase/uppercase ASCII check vectorized
- [ ] 17. HEX check via NEON nibble classification
- [ ] 18. BASE64 alphabet via vtbl nibble lookup
- [ ] 19. NANOID/CUID2/ULID alphabets via NEON
- [ ] 20. Email fast screen via NEON
- [ ] 21. UUID hex-digit runs vectorized
- [ ] 22. startsWith/endsWith/includes long-needle NEON
- [ ] 23. Object key-name compares via NEON (≥16B)
- [ ] 24. Enum/literal string compares vectorized
- [ ] 25. Arena zero-fill via NEON
- [ ] 26. Scalar-vs-NEON crossover benchmarks
- [ ] 27. UTF-16→byte position mapping vectorized
- [ ] 28. Datetime ASCII+digit structure via NEON

## L — success-path & structural perf
- [ ] 29. Per-node N-API call counter (AZ_NAPICALLS)
- [ ] 30. Objects: get_property_names+indexed vs per-key get_named_property
- [ ] 31. Return-input for strip-mode objects
- [ ] 32. Return-input for tuples
- [ ] 33. Cache RegExp.test/BigInt globals at init
- [ ] 34. Fuse adjacent numeric checks into range records
- [ ] 35. Union option ordering heuristic
- [ ] 36. DiscUnion binary search / inline compares
- [ ] 37. Enum sorted table + binary search
- [ ] 38. Type-check elision for typed children
- [ ] 39. Blob layout grouped by opcode
- [ ] 40. pld prefetch of child nodes
- [ ] 41. napi_strict_equals for literals
- [ ] 42. Intern "length"/common property names
- [ ] 43. Audit: one napi_typeof per value
- [ ] 44. parseMany: one output arena per batch
- [ ] 45. Streaming parseIter API
- [ ] 46. Worker-thread parallel parseMany

## M — real workerd verification
- [ ] 47. Install wrangler/workerd
- [ ] 48. examples/worker + wrangler.toml verified
- [ ] 49. Bundle test: assert zero node:/bun: imports in output
- [ ] 50. workerd runtime test: worker serves a parse, assert result
- [ ] 51. Diff-case subset inside workerd
- [ ] 52. workerd lane in make ci / CI
- [ ] 53. Cold-start import timing vs portable baseline

## N — runtime hardening
- [ ] 54. Deno.dlopen driver (native engine on Deno)
- [ ] 55. Node CJS consumer test
- [ ] 56. Node <22 dist build (tsc emit)
- [ ] 57. pnpm install verification
- [ ] 58. bun build --compile smoke test
- [ ] 59. x86_64 portable-fallback verification
- [ ] 60. esbuild/vite/rollup bundle smoke tests
- [ ] 61. npm pack → install → parse in clean dir
- [ ] 62. asmzod/lite subpath (portable-only)

## O — compat expansion
- [ ] 63. z.map/z.set opcodes (native)
- [ ] 64. parseAsync/safeParseAsync (sync fast path + async refine queue)
- [ ] 65. z.promise/z.function (portable minimum)
- [ ] 66. Full-range bigint (hostref beyond i64)
- [ ] 67. Remaining zod4 formats audit (base32, ipv6 compression, jwt)
- [ ] 68. errorMap/z.config parity
- [ ] 69. Property-based fuzz: random schemas × inputs vs zod
- [ ] 70. Cross-engine consistency gate
- [ ] 71. Perf-regression harness (>25% = fail)
- [ ] 72. toJSONSchema parity if in scope

## P — tooling & CI
- [ ] 73. scripts/flake.ts (N× rerun, flaky report)
- [ ] 74. bun test --coverage in make ci
- [ ] 75. GitHub Actions matrix (macOS × {Bun,Node}, linux × {Bun,Node,Deno}, workerd)
- [ ] 76. Release workflow (artifacts + npm publish)
- [ ] 77. scripts/compare.ts (all backends side-by-side)
- [ ] 78. scripts/asmlint.sh (AZ_NAPI symbols vs port.h, no raw _napi_*)
- [ ] 79. Bench vs zod@3 toggle
- [ ] 80. dump --verify structural invariants

## Q — docs & distribution
- [ ] 81. JSDoc pass on public z.* surface
- [ ] 82. examples/node|deno|browser
- [ ] 83. Typedoc / API markdown
- [ ] 84. npm publish 0.2.0
- [ ] 85. JSR publish for Deno
- [ ] 86. Bundle-size badge
- [ ] 87. Real-world bench (tsconfig, package-lock, GeoJSON)
- [ ] 88. "When to use this" doc section

## R — deep asm work
- [ ] 89. Inline hottest leaf handlers into dispatch loop
- [ ] 90. Computed-goto dispatch if faster
- [ ] 91. Register audit: zero reloads of blob/env/hosts per node
- [ ] 92. Issue-arena vsize prefix per record (rollback-proof)
- [ ] 93. Two-level scratch: kill last malloc in init
- [ ] 94. -mcpu=native / literal-pool layout experiments
- [ ] 95. Verify no double indirection in N-API thunks
- [ ] 96. Guard-page arenas (AZ_GUARD)
- [ ] 97. Fuzz under AZ_GUARD + poison as CI gate
- [ ] 98. Stack-alignment audit at every bl
- [ ] 99. Symbolization script: addr → napi.s line
- [ ] 100. strict-obj/fail-issues within 2× of zod — or the written proof
