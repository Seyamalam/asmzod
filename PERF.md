# Performance notes

See RESULTS.md for the current table. How the numbers got here:

## The journey

1. **v0: encode → bun:ffi → decode.** Every parse serialized the JS value
   to tagged binary, crossed FFI, decoded the result. ~17× slower than
   zod on small inputs.
2. **Arena pooling.** Output/error arenas reused across calls → 2.1µs.
3. **N-API rewrite.** The addon walks `napi_value`s directly; success
   returns the raw value, failure returns a prebuilt `issues` array.
   Small-object parse: 2.1µs → ~120ns, roughly zod parity on success.
4. **Return-input.** Arrays stage children; if every child returned the
   input handle verbatim the input array is returned as-is — containers
   can validate-and-return with zero allocation.
5. **Native callbacks.** refine/transform/custom/regex/lazy/instanceof/
   coerce run inside the addon via `napi_call_function`. No more FFI
   round-trip for callback schemas (lazy-rec: 162× → 1.39×).
6. **`parseMany`.** The loop lives in the addon; one boundary crossing
   per batch instead of per value.

## What's still slow

- **Failure paths.** Building real JS issue objects + TS-side
  normalization + `ZodError` formatting is ~1µs+/issue. Zod does it in
  pure JIT'd JS with no boundary crossing — inherent gap.
- **`napi_get_element` / `get_named_property`** is the floor on arrays
  and objects — one N-API call per child, no way around it.
- **`parseMany`** at ~200ns/elem still loses to a tight zod loop (~70ns);
  the per-element N-API work dominates the boundary amortization.

## Rules of thumb

- One N-API call ≈ 30–50ns. Count calls before cleverness.
- `napi_get_named_property` beats `create_string_utf8` + `get_property`.
- `napi_is_date` beats walking the prototype chain.
- Scratch arenas beat per-call allocation. `x20` is scratch, `x21` is the
  issue cursor — never save/restore them around issue-emitting calls.
