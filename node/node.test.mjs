// Node runtime test: node --test test/node.test.mjs
import { test } from "node:test";
import assert from "node:assert";
import { z, engineBackend } from "../src/index.ts";

test("asmzod validates on Node (portable engine)", () => {
  const S = z.object({ n: z.string().min(2), a: z.number().int() });
  assert.deepStrictEqual(S.parse({ n: "ab", a: 1 }), { n: "ab", a: 1 });
  assert.strictEqual(S.safeParse({ n: "x", a: 1.5 }).success, false);
  console.log("backend:", engineBackend);
});
