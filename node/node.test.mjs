// Node runtime test: node --test node/node.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { z, engineBackend } from "../src/index.ts";
import { loadNapi } from "../src/native/napi.ts";

test("asmzod validates on Node", () => {
  const S = z.object({ n: z.string().min(2), a: z.number().int() });
  assert.deepStrictEqual(S.parse({ n: "ab", a: 1 }), { n: "ab", a: 1 });
  assert.strictEqual(S.safeParse({ n: "x", a: 1.5 }).success, false);
  console.log("backend:", engineBackend, "napi:", loadNapi() ? "native" : "none");
});

test("N-API addon validates napi_values directly", () => {
  if (!loadNapi()) return; // platform without prebuilt addon
  const S = z.object({ a: z.object({ b: z.array(z.string()) }), t: z.tuple([z.number(), z.string()]) });
  assert.deepStrictEqual(S.parse({ a: { b: ["x"] }, t: [1, "y"] }), { a: { b: ["x"] }, t: [1, "y"] });
  const r = S.safeParse({ a: { b: ["x", 2] }, t: [1, "y"] });
  assert.strictEqual(r.success, false);
  if (!r.success) assert.deepStrictEqual(r.error.issues[0].path, ["a", "b", 1]);
});
