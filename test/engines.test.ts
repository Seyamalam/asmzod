// engines.test.ts — cross-engine consistency gate: every (schema, value)
// must agree across the N-API engine, the FFI engine and the portable
// interpreter, issue-field for issue-field.
import { test, expect } from "bun:test";
import { z } from "../src/index";
import * as napiBackend from "../src/native/napi";
import { engineParse, portableEngineParse, engineBackend } from "../src/ffi";
import { encodeValue } from "../src/codec";

function norm(x: unknown): string {
  // canonical form: sort object keys recursively so field-order differences
  // between engines don't count (field sets must still match exactly)
  const canon = (v: any): any =>
    Array.isArray(v) ? v.map(canon) :
    v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  return JSON.stringify(canon(JSON.parse(JSON.stringify(x, (_, v) =>
    typeof v === "bigint" ? `${v}n` : v instanceof Map ? { "~map": [...v] } :
    v instanceof Set ? { "~set": [...v] } : v instanceof Date ? `~date:${v.getTime()}` :
    typeof v === "symbol" || typeof v === "function" ? `~${typeof v}` : v) ?? null)));
}

test("cross-engine consistency: napi vs ffi vs portable", () => {
  const schemas: [string, any][] = [
    ["str", z.string()],
    ["str-checks", z.string().min(2).max(8).lowercase()],
    ["num", z.number().int().min(-3).max(100)],
    ["big", z.bigint().min(0n).max(10n)],
    ["big-wide", z.bigint().min(-(2n ** 70n)).max(2n ** 70n)],
    ["bool", z.boolean()],
    ["obj", z.object({ a: z.string(), n: z.number().optional() })],
    ["obj-strict", z.object({ a: z.string() }).strict()],
    ["nested", z.object({ u: z.object({ id: z.string().uuid() }), arr: z.array(z.number()).min(1) })],
    ["arr", z.array(z.string()).min(1).max(4)],
    ["tup", z.tuple([z.string(), z.number()])],
    ["union", z.union([z.string(), z.number(), z.literal("x")])],
    ["dunion", z.discriminatedUnion("k", [z.object({ k: z.literal("a"), v: z.number() }), z.object({ k: z.literal("b"), v: z.string() })])],
    ["enum", z.enum(["a", "b", "c"])],
    ["lit", z.literal(42)],
    ["rec", z.record(z.string(), z.number())],
    ["opt", z.string().optional()],
    ["nullable", z.string().nullable()],
    ["fmt", z.string().email()],
    ["hash", z.hash("sha256")],
    ["ipv6", z.string().ipv6()],
    ["date-iso", z.string().date()],
  ];
  const values: unknown[] = [
    "hi", "", "toolongstringvalue", 3, -5, 3.5, NaN, 0, 100,
    5n, -1n, 2n ** 100n, -(2n ** 100n), true, false, null, undefined,
    "550e8400-e29b-41d4-a716-446655440000", "a@b.com", "bad@",
    "::1", "::ffff:1.2.3.4", "1::2::3",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "2024-01-15", "2024-13-45",
    { a: "x", n: 1 }, { a: "x" }, { a: 1 }, { a: "x", extra: 1 }, {},
    { u: { id: "550e8400-e29b-41d4-a716-446655440000" }, arr: [1, 2] },
    { u: { id: "nope" }, arr: [] },
    [1, "a", 2.5], [], ["a", "b", "c", "d", "e"], ["a", 1],
    { k: "a", v: 3 }, { k: "b", v: "s" }, { k: "z" },
    "a", "c", "z", 42, "42",
    new Map([["k", 1]]), new Map([["k", "x"]]), new Set(["a"]),
    new Date(), new Date(NaN),
    Symbol("s"), () => 0,
  ];
  let checked = 0, skipped = 0;
  const diffs: string[] = [];
  for (const [sname, schema] of schemas) {
    const c = (schema as any)._compile();
    for (const v of values) {
      const label = `${sname} <- ${String(norm(v)).slice(0, 40)}`;
      let napi: any = null, ffi: any = null, port: any = null;
      try { napi = napiBackend.parse(c.blob, v, c.hosts, c.cbUnsafe); } catch (e) { napi = { err: String(e) }; }
      let ffiSkip = false;
      try {
        const h = [...c.hosts];
        const enc = encodeValue(v, h);
        // production routing: inputs or schemas with bigint hostrefs never
        // reach the FFI engine — _run sends them to portableEngineParse
        if (h.some((x) => typeof x === "bigint")) ffiSkip = true;
        else ffi = engineParse(c.blob, enc, h);
      } catch (e) { ffi = { err: String(e) }; }
      try {
        const h = [...c.hosts];
        port = portableEngineParse(c.blob, encodeValue(v, h), h);
      } catch (e) { port = { err: String(e) }; }
      // portable is the reference — ffi + napi must agree with it;
      // napi may legitimately bail (null -> schema falls back)
      if (!ffiSkip && norm(ffi) !== norm(port)) diffs.push(`ffi ${label}:\n  ffi=${norm(ffi)}\n  port=${norm(port)}`);
      if (napi === null) skipped++;
      else if (norm(napi) !== norm(port)) diffs.push(`napi ${label}:\n  napi=${norm(napi)}\n  port=${norm(port)}`);
      checked++;
      if (diffs.length > 8) break;
    }
    if (diffs.length > 8) break;
  }
  if (diffs.length) throw new Error(`${diffs.length} cross-engine mismatches:\n${diffs.join("\n\n")}`);
  console.log(`engines: ${checked} comparisons, ${skipped} napi bails, backend=${engineBackend}`);
});
