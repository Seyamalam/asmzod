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
function* zipIssues(a: any[], b: any[]): Generator<[any, any]> {
  for (let i = 0; i < Math.min(a.length, b.length); i++) yield [a[i], b[i]];
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
  // compare every issue field + message verbatim
  fullIssues?: boolean;
}

const cases: Case[] = [];

function C(name: string, az: () => any, zz: () => any, inputs: unknown[], strictIssues = false, fullIssues = true) {
  cases.push({ name, az, zz, inputs, strictIssues, fullIssues });
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

// ---- extended corpus: trickier inputs ----
const corpus2: unknown[] = [
  "3.5", "0x10", "  42  ", "1e5", "-0", "1,000", "😀", "café",
  new Map(), new Set([1, 2]), new Map([["a", 1]]), new Set(),
  new Date("bad"), { name: 1 }, [[]], [[1], [2]], { a: { b: 1 } },
  "mailto:x@y.z", BigInt("9007199254740993"),
];

// string check combos + more formats
C("str-nonempty", () => z.string().nonempty(), () => Z.string().nonempty(), corpus2);
C("str-min+email", () => z.string().min(5).email(), () => Z.string().min(5).email(), corpus2);
C("str-regex-flag", () => z.string().regex(/^[A-Z]+$/i), () => Z.string().regex(/^[A-Z]+$/i),
  corpus2.concat(["ABC", "abc", "Ab1"]));
C("str-len-emoji", () => z.string().length(2), () => Z.string().length(2),
  ["😀😀", "😀", "ab", "a😀b", "café"]);
C("str-startswith-obj", () => z.string().startsWith("{"), () => Z.string().startsWith("{"), corpus2);

// numeric check matrix
C("num-gte0", () => z.number().gte(0), () => Z.number().gte(0), corpus2);
C("num-lt10", () => z.number().lt(10), () => Z.number().lt(10), corpus2);
C("num-pos", () => z.number().positive(), () => Z.number().positive(), corpus2);
C("num-neg", () => z.number().negative(), () => Z.number().negative(), corpus2);
C("num-nonneg", () => z.number().nonnegative(), () => Z.number().nonnegative(), corpus2);
C("num-mult2.5", () => z.number().multipleOf(2.5), () => Z.number().multipleOf(2.5), corpus2);
C("num-int+min", () => z.number().int().min(2), () => Z.number().int().min(2), corpus2);

// bigint checks
C("big-min", () => z.bigint().min(10n), () => Z.bigint().min(10n), corpus2);
C("big-max", () => z.bigint().max(5n), () => Z.bigint().max(5n), corpus2);
C("big-mult", () => z.bigint().multipleOf(3n), () => Z.bigint().multipleOf(3n), corpus2);

// array sizes + nested
C("arr-max2", () => z.array(z.string()).max(2), () => Z.array(Z.string()).max(2), corpus2);
C("arr-len3", () => z.array(z.number()).length(3), () => Z.array(Z.number()).length(3), corpus2);
C("arr-nonempty", () => z.array(z.boolean()).nonempty(), () => Z.array(Z.boolean()).nonempty(), corpus2);
C("arr-nested", () => z.array(z.array(z.number())), () => Z.array(Z.array(Z.number())), corpus2);
C("arr-union-el", () => z.array(z.union([z.string(), z.number()])),
  () => Z.array(Z.union([Z.string(), Z.number()])), corpus2);

// tuple rest
C("tuple-rest", () => (z.tuple([z.string()]) as any).rest?.(z.number()) ?? z.tuple([z.string()]),
  () => Z.tuple([Z.string()]).rest(Z.number()),
  [["a"], ["a", 1, 2], ["a", "b"], ["a", 1, "x"], [], "x"]);

// object transforms (pure TS — shape changes)
C("obj-partial", () => z.object({ a: z.string(), b: z.number() }).partial(),
  () => Z.object({ a: Z.string(), b: Z.number() }).partial(), corpus2);
C("obj-required", () => z.object({ a: z.string().optional() }).required(),
  () => Z.object({ a: Z.string().optional() }).required(), corpus2);
C("obj-pick", () => z.object({ a: z.string(), b: z.number() }).pick({ a: true }),
  () => Z.object({ a: Z.string(), b: Z.number() }).pick({ a: true }), corpus2);
C("obj-omit", () => z.object({ a: z.string(), b: z.number() }).omit({ b: true }),
  () => Z.object({ a: Z.string(), b: Z.number() }).omit({ b: true }), corpus2);
C("obj-extend", () => z.object({ a: z.string() }).extend({ c: z.number() }),
  () => Z.object({ a: Z.string() }).extend({ c: Z.number() }), corpus2);
C("obj-deep", () => z.object({ l1: z.object({ l2: z.object({ l3: z.object({ v: z.string() }) }) }) }),
  () => Z.object({ l1: Z.object({ l2: Z.object({ l3: Z.object({ v: Z.string() }) }) }) }),
  [{ l1: { l2: { l3: { v: "x" } } } }, { l1: { l2: { l3: {} } } }, { l1: { l2: {} } }, { l1: {} }, {}]);

// record with key type
C("record-str-key", () => z.record(z.string(), z.number()),
  () => Z.record(Z.string(), Z.number()), corpus2);

// unions: deeper + identical shapes
C("union-3way", () => z.union([z.literal("y"), z.number().min(10), z.object({ k: z.string() })]),
  () => Z.union([Z.literal("y"), Z.number().min(10), Z.object({ k: Z.string() })]), corpus2);
C("union-obj-obj", () => z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
  () => Z.union([Z.object({ a: Z.string() }), Z.object({ b: Z.number() })]), corpus2);

// effects: transform/refine/brand/or/catch-fn
C("transform", () => z.string().transform((s: string) => s.length),
  () => Z.string().transform((s) => s.length), corpus2);
C("refine", () => z.number().refine((n: number) => n > 2),
  () => Z.number().refine((n) => n > 2), corpus2);
C("superRefine", () => z.string().superRefine((s: string, ctx: any) => {
    if (s === "bad") ctx.addIssue({ code: "custom", message: "no bad" });
  }),
  () => Z.string().superRefine((s, ctx) => {
    if (s === "bad") ctx.addIssue({ code: "custom", message: "no bad" });
  }), ["bad", "ok", "worse"]);
C("or", () => (z.string() as any).or?.(z.number()) ?? z.union([z.string(), z.number()]),
  () => Z.string().or(Z.number()), corpus2);
C("catch-fn", () => (z.number() as any).catch?.(() => 9) ?? z.number(),
  () => Z.number().catch(() => 9), corpus2);
C("brand", () => (z.string() as any).brand?.("B") ?? z.string(),
  () => Z.string().brand("B"), corpus2);
C("readonly", () => (z.array(z.number()) as any).readonly?.() ?? z.array(z.number()),
  () => Z.array(Z.number()).readonly(), corpus2);

// date bounds
C("date-min", () => z.date().min(new Date("2020-01-01")),
  () => Z.date().min(new Date("2020-01-01")),
  [new Date("2019-01-01"), new Date("2021-06-01"), "x", new Date("bad")]);
C("date-max", () => z.date().max(new Date("2020-12-31")),
  () => Z.date().max(new Date("2020-12-31")),
  [new Date("2019-01-01"), new Date("2021-06-01"), new Date("bad")]);

// nullish / nullable chains
C("nullish", () => (z.string() as any).nullish?.() ?? z.string().nullable().optional(),
  () => Z.string().nullish(), corpus2);
C("opt-of-opt", () => z.string().optional().optional(),
  () => Z.string().optional().optional(), corpus2);

// literal variety
C("literal-null", () => z.literal(null), () => Z.literal(null), corpus2);
C("literal-true", () => z.literal(true), () => Z.literal(true), corpus2);
C("literal-big", () => z.literal(7n), () => Z.literal(7n), corpus2);

// nested failure shapes
C("obj-opt-field", () => z.object({ a: z.string(), b: z.number().optional() }),
  () => Z.object({ a: Z.string(), b: Z.number().optional() }), corpus2);
C("arr-of-obj", () => z.array(z.object({ n: z.number() })),
  () => Z.array(Z.object({ n: Z.number() })),
  [[{ n: 1 }], [{ n: "x" }], [{ n: 1 }, { n: "x" }, { n: 2 }], [{}]]);

// map / set
C("map", () => z.map(z.string(), z.number()), () => Z.map(Z.string(), Z.number()),
  [new Map([["a", 1]]), new Map([["a", 1], ["b", "x"], [5, 9]]), "x",
   new Map(), new Set(), new Map([[3, "s"]])]);
C("map-nested", () => z.map(z.string(), z.object({ v: z.number() })),
  () => Z.map(Z.string(), Z.object({ v: Z.number() })),
  [new Map([["k", { v: 1 }]]), new Map([["k", { v: "x" }], ["j", { q: 1 }]])]);
C("set", () => z.set(z.string()), () => Z.set(Z.string()),
  [new Set(["a"]), new Set(["a", 5]), [1, 2], new Set(), new Map(), "x"]);
C("set-nested", () => z.set(z.object({ v: z.number() })),
  () => Z.set(Z.object({ v: Z.number() })),
  [new Set([{ v: 1 }]), new Set([{ v: "x" }, { v: 2 }])]);

// null-prototype + exotic inputs
C("record-nullproto", () => z.record(z.number()), () => Z.record(Z.number()),
  [Object.create(null), Object.assign(Object.create(null), { a: 1 }), { a: 1 }]);
C("str-on-nullproto", () => z.string(), () => Z.string(), [Object.create(null)]);
C("boxed-inputs", () => z.string(), () => Z.string(),
  [new String("x"), new Number(5), new Boolean(true)]);
C("frozen-input", () => z.object({ a: z.string() }), () => Z.object({ a: Z.string() }),
  [Object.freeze({ a: "x" }), Object.freeze({ a: 1 })]);

// safe-integer range: zod4 int() is format "safeint"
C("num-int-safebound", () => z.number().int(), () => Z.number().int(),
  [1e21, -1e21, 9007199254740991, 9007199254740992, -9007199254740991, 0.5, 5]);
C("num-safe-bound", () => z.number().safe(), () => Z.number().safe(),
  [1e21, -1e21, 9007199254740991, 9007199254740992]);

// union nested errors field
C("union-errors", () => z.union([z.string().email(), z.number().min(10)]),
  () => Z.union([Z.string().email(), Z.number().min(10)]),
  [true, "bad", "a@b.c", 5, 15, null], true);
C("union-errors-deep", () => z.union([z.object({ a: z.string() }), z.array(z.number())]),
  () => Z.union([Z.object({ a: Z.string() }), Z.array(Z.number())]),
  [true, "x", { a: 5 }, ["x"]], true);

for (const c of cases) {
  test(`diff: ${c.name}`, () => {
    const as = c.az();
    const zs = c.zz();
    for (const input of c.inputs) {
      const ar = as.safeParse(input);
      const zr = zs.safeParse(input);
      expect(
        ar.success,
        `success mismatch for input ${JSON.stringify(
          typeof input === "object" && input !== null ? Object.getPrototypeOf(input)?.constructor?.name ?? "nullproto" : String(input),
        )}: az=${ar.success} zz=${zr.success}`,
      ).toBe(zr.success);
      if (ar.success && zr.success) {
        expect(deepEq(ar.data, zr.data)).toBe(true);
      } else if (!ar.success && !zr.success) {
        const aKeys = issueSort(ar.error.issues);
        const zKeys = issueSort(zr.error.issues);
        expect(aKeys).toEqual(zKeys);
        if (c.strictIssues) {
          // deep-compare per-option union errors
          for (const [ai, zi] of zipIssues(ar.error.issues, zr.error.issues)) {
            if (zi.errors !== undefined) {
              expect(ai.errors?.map((e: any[]) => issueSort(e))).toEqual(
                zi.errors.map((e: any[]) => issueSort(e)));
            }
            for (const f of ["discriminator", "note", "options"] as const) {
              if ((zi as any)[f] !== undefined) expect((ai as any)[f]).toEqual((zi as any)[f]);
            }
          }
        }
        if (c.fullIssues) {
          // full issue-object parity: all fields + messages (sorted view)
          const skeys = (o: any): any => Array.isArray(o)
            ? o.map(skeys)
            : (o && typeof o === "object"
                ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, skeys(o[k])]))
                : (typeof o === "bigint" ? `${o}n` : o));
          const norm = (iss: any[]) => iss.map((x: any) => JSON.stringify(skeys(x))).sort();
          const diag = typeof input === "object" && input !== null
            ? Object.getPrototypeOf(input)?.constructor?.name ?? "nullproto"
            : String(input);
          expect(norm(ar.error.issues), `issues mismatch for ${JSON.stringify(diag)}`)
            .toEqual(norm(zr.error.issues));
        }
      }
    }
  });
}
