// fuzz.test.ts — seeded property fuzz: random schemas x random values,
// full issue-object parity between asmzod and zod, plus arena poison check.
import { test, expect } from "bun:test";
import * as Z from "zod";
import { z } from "../src/index";

// mulberry32 — deterministic rng so failures reproduce via FUZZ_SEED
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randVal(r: () => number, depth: number): unknown {
  const pick = r();
  if (depth <= 0) {
    const leaf = ["", "a", "hello", "a@b.com", 0, 1, -3.5, NaN, Infinity, true,
      false, null, undefined, 42n, Symbol("s"), new Date(), new Date(NaN),
      () => 1, "550e8400-e29b-41d4-a716-446655440000"];
    return leaf[Math.floor(r() * leaf.length)];
  }
  if (pick < 0.25) {
    const n = Math.floor(r() * 4);
    return Array.from({ length: n }, () => randVal(r, depth - 1));
  }
  if (pick < 0.5) {
    const keys = ["a", "b", "name", "age", "x", ""];
    const o: Record<string, unknown> = {};
    const n = Math.floor(r() * 4);
    for (let i = 0; i < n; i++) o[keys[Math.floor(r() * keys.length)]!] = randVal(r, depth - 1);
    return o;
  }
  return randVal(r, 0);
}

// random schema built in parallel for both libs, with a readable spec
type Gen = { az: any; zz: any; spec: string };
function randSchema(r: () => number, depth: number): Gen {
  const leaf = () => {
    const k = Math.floor(r() * 9);
    switch (k) {
      case 0: return { az: z.string(), zz: Z.string(), spec: "string" };
      case 1: return { az: z.number(), zz: Z.number(), spec: "number" };
      case 2: return { az: z.boolean(), zz: Z.boolean(), spec: "boolean" };
      case 3: return { az: z.bigint(), zz: Z.bigint(), spec: "bigint" };
      case 4: return { az: z.null(), zz: Z.null(), spec: "null" };
      case 5: return { az: z.literal("lit"), zz: Z.literal("lit"), spec: "lit('lit')" };
      case 6: return { az: z.enum(["a", "b"]), zz: Z.enum(["a", "b"]), spec: "enum(a,b)" };
      case 7: return { az: z.date(), zz: Z.date(), spec: "date" };
      default: return { az: z.nan(), zz: Z.nan(), spec: "nan" };
    }
  };
  if (depth <= 0) return leaf();
  const k = Math.floor(r() * 11);
  switch (k) {
    case 0: return { az: z.string().min(2).max(10), zz: Z.string().min(2).max(10), spec: "string.min(2).max(10)" };
    case 1: return { az: z.number().int().min(-5), zz: Z.number().int().min(-5), spec: "number.int.min(-5)" };
    case 2: return { az: z.number().multipleOf(3), zz: Z.number().multipleOf(3), spec: "number.multOf(3)" };
    case 3: {
      const i = randSchema(r, depth - 1);
      return { az: z.array(i.az), zz: Z.array(i.zz), spec: `array(${i.spec})` };
    }
    case 4: {
      const a = randSchema(r, depth - 1);
      const o: Record<string, any> = {}; const oz: Record<string, any> = {};
      o.a = a.az; oz.a = a.zz;
      const b = randSchema(r, depth - 1);
      o.name = b.az; oz.name = b.zz;
      return { az: z.object(o), zz: Z.object(oz), spec: `object({a:${a.spec},name:${b.spec}})` };
    }
    case 5: {
      const a = randSchema(r, depth - 1), b = randSchema(r, depth - 1);
      return { az: z.union([a.az, b.az]), zz: Z.union([a.zz, b.zz]), spec: `union(${a.spec}|${b.spec})` };
    }
    case 6: {
      const i = randSchema(r, depth - 1);
      return { az: i.az.optional(), zz: i.zz.optional(), spec: `${i.spec}.opt` };
    }
    case 7: {
      const i = randSchema(r, depth - 1);
      return { az: i.az.nullable(), zz: i.zz.nullable(), spec: `${i.spec}.null` };
    }
    case 8: {
      const a = randSchema(r, depth - 1), b = randSchema(r, depth - 1);
      return { az: z.tuple([a.az, b.az]), zz: Z.tuple([a.zz, b.zz]), spec: `tuple(${a.spec},${b.spec})` };
    }
    case 9: {
      const i = randSchema(r, depth - 1);
      return { az: z.record(z.string(), i.az), zz: Z.record(Z.string(), i.zz), spec: `record(str,${i.spec})` };
    }
    case 10: {
      const i = randSchema(r, depth - 1);
      return { az: i.az.catch("caught"), zz: i.zz.catch("caught"), spec: `${i.spec}.catch` };
    }
    default: return leaf();
  }
}

const skeys = (o: any): any => Array.isArray(o)
  ? o.map(skeys)
  : (o && typeof o === "object"
      ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, skeys(o[k])]))
      : (typeof o === "bigint" ? `${o}n` : (typeof o === "symbol" || typeof o === "function" ? `<${typeof o}>` : o)));
const norm = (iss: any[]) => iss.map((x: any) => JSON.stringify(skeys(x))).sort();

const SEED = Number((process.env as any).FUZZ_SEED ?? 20260724);
const ROUNDS = Number((process.env as any).FUZZ_ROUNDS ?? 400);

test(`fuzz: ${ROUNDS} random schemas x values, seed ${SEED}`, () => {
  const r = rng(SEED);
  let compared = 0;
  const failures: string[] = [];
  for (let i = 0; i < ROUNDS && failures.length < 5; i++) {
    const { az, zz, spec } = randSchema(r, 3);
    for (let j = 0; j < 6; j++) {
      const v = randVal(r, 2);
      let ar: any, zr: any;
      try { ar = az.safeParse(v); } catch (e) { ar = { threw: String(e) }; }
      try { zr = zz.safeParse(v); } catch (e) { zr = { threw: String(e) }; }
      compared++;
      const tag = `round ${i} value ${j} [${spec}]: ${(() => { try { return JSON.stringify(String(v)) ?? "?"; } catch { return `<${typeof v}>`; } })().slice(0, 60)}`;
      if (ar.threw || zr.threw) {
        if (!!ar.threw !== !!zr.threw) failures.push(`${tag}: threw mismatch az=${ar.threw} zod=${zr.threw}`);
        continue;
      }
      if (ar.success !== zr.success) {
        failures.push(`${tag}: success az=${ar.success} zod=${zr.success} azIssues=${JSON.stringify(ar.error?.issues)} zodIssues=${JSON.stringify(zr.error?.issues)}`);
        continue;
      }
      if (!ar.success) {
        const a = norm(ar.error.issues), b = norm(zr.error.issues);
        if (JSON.stringify(a) !== JSON.stringify(b))
          failures.push(`${tag}: issues\n  az=${JSON.stringify(a)}\n  zod=${JSON.stringify(b)}`);
      } else {
        // success — compare outputs loosely (transforms aside, most are passthrough)
        try { expect(ar.data).toEqual(zr.data); }
        catch { failures.push(`${tag}: output az=${JSON.stringify(ar.data)} zod=${JSON.stringify(zr.data)}`); }
      }
    }
  }
  if (failures.length) throw new Error(`${failures.length} fuzz mismatches (${compared} comparisons):\n${failures.join("\n\n")}`);
});

test("arena poison: parses stay correct over 0xAA-filled pooled buffers", () => {
  (process.env as any).AZ_POISON = "1";
  try {
    const s = z.object({
      name: z.string().min(2),
      tags: z.array(z.union([z.string(), z.number()])),
      when: z.date().optional(),
    });
    const good = { name: "ok", tags: ["a", 1, "b"], when: new Date() };
    const bad = { name: "x", tags: [[], "b", {}], when: "nope" };
    for (let i = 0; i < 50; i++) {
      expect(s.safeParse(good).success).toBe(true);
      const r = s.safeParse(bad);
      expect(r.success).toBe(false);
      expect((r as any).error.issues.length).toBeGreaterThan(0);
      for (const iss of (r as any).error.issues) {
        expect(typeof iss.code).toBe("string");
        expect(typeof iss.message).toBe("string");
        expect(iss.message).not.toContain("\xaa");
      }
    }
  } finally {
    delete (process.env as any).AZ_POISON;
  }
});
