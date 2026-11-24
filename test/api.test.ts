import { test, expect } from "bun:test";
import { z } from "../src/index";

test("string", () => {
  expect(z.string().parse("hi")).toBe("hi");
  expect(() => z.string().parse(4)).toThrow();
  const r = z.string().safeParse(4);
  expect(r.success).toBe(false);
  if (!r.success) expect(r.error.issues[0].code).toBe("invalid_type");
});

test("string checks", () => {
  expect(z.string().min(2).safeParse("a").success).toBe(false);
  expect(z.string().min(2).safeParse("ab").success).toBe(true);
  expect(z.string().max(2).safeParse("abc").success).toBe(false);
  expect(z.string().length(2).safeParse("ab").success).toBe(true);
  expect(z.string().email().safeParse("a@b.com").success).toBe(true);
  expect(z.string().email().safeParse("nope").success).toBe(false);
  expect(z.string().startsWith("ab").safeParse("abc").success).toBe(true);
  expect(z.string().endsWith("bc").safeParse("abc").success).toBe(true);
  expect(z.string().includes("b").safeParse("abc").success).toBe(true);
});

test("number", () => {
  expect(z.number().parse(3.5)).toBe(3.5);
  expect(z.number().int().safeParse(3.5).success).toBe(false);
  expect(z.number().int().safeParse(3).success).toBe(true);
  expect(z.number().gt(5).safeParse(5).success).toBe(false);
  expect(z.number().gte(5).safeParse(5).success).toBe(true);
  expect(z.number().safeParse(NaN).success).toBe(false);
});

test("boolean/null/undefined/any", () => {
  expect(z.boolean().parse(true)).toBe(true);
  expect(z.boolean().safeParse(1).success).toBe(false);
  expect(z.null().parse(null)).toBe(null);
  expect(z.undefined().parse(undefined)).toBe(undefined);
  expect(z.any().parse({ a: 1 })).toEqual({ a: 1 });
});

test("object", () => {
  const s = z.object({ name: z.string(), age: z.number().int() });
  expect(s.parse({ name: "x", age: 3 })).toEqual({ name: "x", age: 3 });
  const r = s.safeParse({ name: "x", age: "y" });
  expect(r.success).toBe(false);
  if (!r.success) {
    expect(r.error.issues[0].path).toEqual(["age"]);
    expect(r.error.issues[0].code).toBe("invalid_type");
  }
});

test("object strip/passthrough/strict", () => {
  const base = z.object({ a: z.string() });
  expect(base.parse({ a: "x", extra: 1 })).toEqual({ a: "x" });
  expect(base.passthrough().parse({ a: "x", extra: 1 })).toEqual({ a: "x", extra: 1 });
  const r = base.strict().safeParse({ a: "x", extra: 1 });
  expect(r.success).toBe(false);
  if (!r.success) expect(r.error.issues[0].code).toBe("unrecognized_keys");
});

test("optional/nullable/default", () => {
  expect(z.string().optional().parse(undefined)).toBe(undefined);
  expect(z.string().optional().parse("x")).toBe("x");
  expect(z.string().nullable().parse(null)).toBe(null);
  expect(z.string().default("d").parse(undefined)).toBe("d");
  expect(z.string().default("d").parse("x")).toBe("x");
});

test("array", () => {
  const s = z.array(z.number());
  expect(s.parse([1, 2, 3])).toEqual([1, 2, 3]);
  const r = s.safeParse([1, "x"]);
  expect(r.success).toBe(false);
  if (!r.success) expect(r.error.issues[0].path).toEqual([1]);
});

test("literal/enum", () => {
  expect(z.literal("a").parse("a")).toBe("a");
  expect(z.literal("a").safeParse("b").success).toBe(false);
  expect(z.enum(["x", "y"]).parse("y")).toBe("y");
  expect(z.enum(["x", "y"]).safeParse("z").success).toBe(false);
});

test("union", () => {
  const s = z.union([z.string(), z.number()]);
  expect(s.parse("x")).toBe("x");
  expect(s.parse(4)).toBe(4);
  expect(s.safeParse(true).success).toBe(false);
});

test("tuple/record", () => {
  expect(z.tuple([z.string(), z.number()]).parse(["a", 1])).toEqual(["a", 1]);
  expect(z.tuple([z.string(), z.number()]).safeParse(["a"]).success).toBe(false);
  const r = z.record(z.number());
  expect(r.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  expect(r.safeParse({ a: "x" }).success).toBe(false);
});

test("nested path", () => {
  const s = z.object({ a: z.object({ b: z.array(z.number()) }) });
  const r = s.safeParse({ a: { b: [1, "x", 3] } });
  expect(r.success).toBe(false);
  if (!r.success) expect(r.error.issues[0].path).toEqual(["a", "b", 1]);
});

test("transform/refine", () => {
  expect(z.string().transform((s: string) => s.length).parse("abc")).toBe(3);
  expect(z.string().refine((s: string) => s.length > 2).safeParse("ab").success).toBe(false);
  expect(z.string().refine((s: string) => s.length > 2).safeParse("abc").success).toBe(true);
});

test("coerce", () => {
  expect(z.coerce.number().parse("42")).toBe(42);
  expect(z.coerce.string().parse(42)).toBe("42");
  expect(z.coerce.boolean().parse(0)).toBe(false);
  expect(z.coerce.boolean().parse("x")).toBe(true);
});

test("zoderror format/flatten", () => {
  const s = z.object({ a: z.string(), b: z.number() });
  const r = s.safeParse({ a: 1, b: "x" });
  expect(r.success).toBe(false);
  if (!r.success) {
    const f = r.error.format();
    expect(f.a._errors.length).toBe(1);
    expect(f.b._errors.length).toBe(1);
    const fl = r.error.flatten();
    expect(fl.fieldErrors.a.length).toBe(1);
  }
});

test("factory {checks} params + z.check", () => {
  const s = z.string({ checks: [z.minLength(1), z.maxLength(3)] });
  expect(s.safeParse("").success).toBe(false);
  expect(s.safeParse("ab").success).toBe(true);
  expect(s.safeParse("abcd").success).toBe(false);
  const fn = z.string({ checks: [z.check((c: any) => { if (c.value !== "ok") c.issues.push({ code: "custom", input: c.value }); })] });
  expect(fn.safeParse("ok").success).toBe(true);
  expect(fn.safeParse("bad").success).toBe(false);
  expect(z.coerce.string({ checks: [z.minLength(2)] }).safeParse("a").success).toBe(false);
  expect(z.coerce.string({ checks: [z.minLength(2)] }).safeParse("ab").success).toBe(true);
  expect(z.validate(z.string(), "x")).toBe(true);
  expect(z.validate(z.string(), 5)).toBe(false);
});
