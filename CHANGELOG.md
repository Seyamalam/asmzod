# Changelog

## 0.2.0

The N-API rewrite. The validation engine no longer needs encode→FFI→decode
on the hot path: the `asmzod.node` addon walks JavaScript values directly
in hand-written ARM64.

- **N-API engine** (`asm/napi.s`): parse returns raw `napi_value`s on
  success, native issue arrays on failure, `{~azres}` marker for fallback
- **Native callbacks**: refine/transform/custom/regex/lazy/instanceof/
  coerce run inside the addon via `napi_call_function`
- **Return-input**: unchanged arrays/objects return the input handle —
  zero allocation when validation doesn't transform
- **`parseMany`/`safeParseMany`**: batch entry point, loop lives in the
  addon (one JS↔native crossing per batch)
- **Linux arm64**: ELF build (`libasmzod.so` + `asmzod.node`), verified
  in Docker — `./docker-test.sh`
- **Worker-safe loading**: no static `node:*`/`bun:*` imports anywhere on
  the portable path
- **zod4 compat**: safe-int bounds, `invalid_key` wrapping, nested union
  `errors`, template-literal/`z.success`/`z.json` shapes, custom error
  params (`{error}`, `{message}`, callbacks), schema-level error params
  (`MSGWRAP`), format factories (`jwt`, `e164`, `cidrv4/6`, `hostname`,
  `xid`, `ksuid`, `uuidv6/7`, `emoji`, …), object/array accessors,
  `z.check`, `z.prefault`, `z.meta`/`z.register`
- **Tooling**: `scripts/dump.ts` bytecode disassembler,
  `scripts/doctor.ts` environment probe, `justfile`
- **Docs**: ARCHITECTURE / PORTING / COMPAT / PERF / RESULTS

## 0.1.0

- encode → `bun:ffi` → decode engine, macOS arm64 only
- portable TS interpreter for Node/Deno/Workers
- differential suite vs `zod@4`
