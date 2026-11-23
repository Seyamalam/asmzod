// diff.test.ts — differential testing: asmzod vs real zod as oracle
import { test, expect } from "bun:test";
import * as Z from "zod";
import { z } from "../src/index";

function issueKey(i: any) {
  return `${i.code}|${(i.path ?? []).join(".")}`;
}
function issueSort(issues: any[]) {
  return issues.map(issueKey).sort();
}

function deepEq(a: unknown, b: unknown): boolean {
  try { expect(a).toEqual(b); return true; } catch { return false; }
}

// run one case: {schema} built for both libs, {inputs} fed to each
interface Case {
  name: string;
  az: () => any;   // asmzod schema
  zz: () => any;   // zod schema
  inputs: unknown[];
  // compare full issue messages too (defaults: codes+paths only)
  strictIssues?: boolean;
}

const cases: Case[] = [];

function C(name: string, az: () => any, zz: () => any, inputs: unknown[], strictIssues = false) {
  cases.push({ name, az, zz, inputs, strictIssues });
}

const corpus: unknown[] = [
  "hello", "", "a@b.com", "x@y", 42, 3.14, -7, 0, NaN, Infinity,
  true, false, null, undefined, 9007199254740991n,
  [1, 2, 3], ["a", "b"], [], [1, "x"],
  { a: 1 }, { name: "n", age: 5 }, { name: 1, age: "x" }, {},
  Symbol("s"), new Date(), () => 1,
];

C("string", () => z.string(), () => Z.string(), corpus);
C("number", () => z.number(), () => Z.number(), corpus);
C("boolean", () => z.boolean(), () => Z.boolean(), corpus);
C("bigint", () => z.bigint(), () => Z.bigint(), corpus);
C("null", () => z.null(), () => Z.null(), corpus);
C("undefined", () => z.undefined(), () => Z.undefined(), corpus);
C("literal-x", () => z.literal("x"), () => Z.literal("x"), corpus);
C("literal-42", () => z.literal(42), () => Z.literal(42), corpus);
C("enum", () => z.enum(["a", "b", "c"]), () => Z.enum(["a", "b", "c"]), corpus);

C("str-min3", () => z.string().min(3), () => Z.string().min(3), corpus);
C("str-max2", () => z.string().max(2), () => Z.string().max(2), corpus);
C("str-len4", () => z.string().length(4), () => Z.string().length(4), corpus);
C("str-email", () => z.string().email(), () => Z.string().email(), corpus);
C("str-uuid", () => z.string().uuid(), () => Z.string().uuid(), corpus.concat([
  "550e8400-e29b-41d4-a716-446655440000", "not-uuid",
]));
C("str-starts", () => z.string().startsWith("ab"), () => Z.string().startsWith("ab"), corpus);
C("str-ends", () => z.string().endsWith("xy"), () => Z.string().endsWith("xy"), corpus);
C("str-includes", () => z.string().includes("ell"), () => Z.string().includes("ell"), corpus);
C("str-regex", () => z.string().regex(/^a.c$/), () => Z.string().regex(/^a.c$/), corpus);
C("str-url", () => z.string().url(), () => Z.string().url(),
  corpus.concat(["https://example.com", "ftp://x.y", "not url"]));
C("str-datetime", () => z.string().datetime(), () => Z.string().datetime(),
  corpus.concat(["2024-01-15T10:30:00Z", "2024-13-45T99:99:99Z", "no"]));
C("str-emoji-min2", () => z.string().min(2), () => Z.string().min(2),
  ["👍", "👍👍", "ab", "a", "𝕊𝕊"]); // UTF-16 units: emoji=2

C("num-int", () => z.number().int(), () => Z.number().int(), corpus);
C("num-gt5", () => z.number().gt(5), () => Z.number().gt(5), corpus);
C("num-lte3", () => z.number().lte(3), () => Z.number().lte(3), corpus);
C("num-mult3", () => z.number().multipleOf(3), () => Z.number().multipleOf(3), corpus);
C("num-finite", () => z.number().finite(), () => Z.number().finite(), corpus);
C("num-safe", () => z.number().safe(), () => Z.number().safe(), corpus);

C("array-num", () => z.array(z.number()), () => Z.array(Z.number()), corpus);
C("array-min2", () => z.array(z.number()).min(2), () => Z.array(Z.number()).min(2), corpus);
C("tuple", () => z.tuple([z.string(), z.number()]), () => Z.tuple([Z.string(), Z.number()]), corpus);

C("object", () => z.object({ name: z.string(), age: z.number() }),
  () => Z.object({ name: Z.string(), age: Z.number() }), corpus);

C("object-strict", () => z.object({ a: z.string() }).strict(),
  () => Z.object({ a: Z.string() }).strict(),
  [{ a: "x", b: 1 }, { a: "x" }, { b: 1 }, "x"]);

C("object-passthrough", () => z.object({ a: z.string() }).passthrough(),
  () => Z.object({ a: Z.string() }).passthrough(),
  [{ a: "x", b: 1 }, { a: "x" }]);

C("object-catchall", () => z.object({ a: z.string() }).catchall(z.number()),
  () => Z.object({ a: Z.string() }).catchall(Z.number()),
  [{ a: "x", b: 1 }, { a: "x", b: "y" }, { a: "x" }]);

C("optional", () => z.string().optional(), () => Z.string().optional(), corpus);
C("nullable", () => z.string().nullable(), () => Z.string().nullable(), corpus);
C("default", () => z.string().default("d"), () => Z.string().default("d"), corpus);
C("catch", () => z.string().catch("c"), () => Z.string().catch("c"), corpus);

C("union", () => z.union([z.string(), z.number()]),
  () => Z.union([Z.string(), Z.number()]), corpus);

C("discunion", () => z.discriminatedUnion("t", [
    z.object({ t: z.literal("a"), v: z.string() }),
    z.object({ t: z.literal("b"), w: z.number() }),
  ]),
  () => Z.discriminatedUnion("t", [
    Z.object({ t: Z.literal("a"), v: Z.string() }),
    Z.object({ t: Z.literal("b"), w: Z.number() }),
  ]),
  [{ t: "a", v: "x" }, { t: "b", w: 1 }, { t: "c" }, { t: "a", v: 1 }, { t: 1 }]);

C("intersect", () => z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
  () => Z.intersection(Z.object({ a: Z.string() }), Z.object({ b: Z.number() })),
  [{ a: "x", b: 1 }, { a: "x" }, { a: "x", b: "y" }, "s"]);

C("record", () => z.record(z.number()), () => Z.record(Z.number()),
  [{ a: 1, b: 2 }, { a: "x" }, "s", []]);

C("nested", () => z.object({
    user: z.object({ name: z.string(), tags: z.array(z.string()) }),
    meta: z.object({ ok: z.boolean() }),
  }),
  () => Z.object({
    user: Z.object({ name: Z.string(), tags: Z.array(Z.string()) }),
    meta: Z.object({ ok: Z.boolean() }),
  }),
  [
    { user: { name: "n", tags: ["a"] }, meta: { ok: true } },
    { user: { name: "n", tags: [1] }, meta: { ok: true } },
    { user: { tags: [] }, meta: { ok: true } },
    { user: { name: "n" }, meta: { ok: "y" } },
  ]);

C("coerce-num", () => z.coerce.number(), () => Z.coerce.number(),
  ["42", "3.5", "x", "", 7, true, null, undefined]);
C("coerce-str", () => z.coerce.string(), () => Z.coerce.string(),
  ["x", 42, 3.5, true, false, null, undefined, 7n]);
C("coerce-bool", () => z.coerce.boolean(), () => Z.coerce.boolean(),
  [0, 1, "", "x", null, undefined, true, false, [], {}]);

C("nan", () => z.nan(), () => Z.nan(), [NaN, 1, "x"]);
C("date", () => z.date(), () => Z.date(), [new Date(), "2024-01-01", 123, null]);
C("lazy", () => z.lazy(() => z.string()), () => Z.lazy(() => Z.string()), corpus);
C("instanceof", () => z.instanceof(Map), () => Z.instanceof(Map), [new Map(), {}, new Set()]);

for (const c of cases) {
  test(`diff: ${c.name}`, () => {
    const as = c.az();
    const zs = c.zz();
    for (const input of c.inputs) {
      const ar = as.safeParse(input);
      const zr = zs.safeParse(input);
      expect(
        ar.success,
        `success mismatch for input ${JSON.stringify(String(input))}: az=${ar.success} zz=${zr.success}`,
      ).toBe(zr.success);
      if (ar.success && zr.success) {
        expect(deepEq(ar.data, zr.data)).toBe(true);
      } else if (!ar.success && !zr.success) {
        const aKeys = issueSort(ar.error.issues);
        const zKeys = issueSort(zr.error.issues);
        expect(aKeys).toEqual(zKeys);
      }
    }
  });
}
