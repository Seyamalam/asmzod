// Node CJS consumer test: node --test node/cjs.test.cjs
const { test } = require("node:test");
const assert = require("node:assert");
const { z } = require("../dist/index.js");

test("asmzod validates via require() on dist", () => {
  const S = z.object({ n: z.string().min(2), a: z.number().int() });
  assert.deepStrictEqual(S.parse({ n: "ab", a: 1 }), { n: "ab", a: 1 });
  assert.strictEqual(S.safeParse({ n: "x", a: 1.5 }).success, false);
});

test("asmzod/lite works via require()", () => {
  const { z: zl } = require("../dist/lite.js");
  assert.strictEqual(zl.string().uuid().safeParse("550e8400-e29b-41d4-a716-446655440000").success, true);
});
