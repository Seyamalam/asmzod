import * as Z from "zod";
import { z } from "../src/index";

let sink: unknown = null;
function bench(fn: (i: number) => unknown, iters: number): number {
  fn(0); fn(1); fn(2);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) sink = fn(i);
  return ((performance.now() - t0) * 1000) / iters;
}
const fmt = (us: number) => us < 1000 ? `${us.toFixed(2)}µs` : `${(us/1000).toFixed(2)}ms`;

const smallAZ = z.object({ name: z.string(), age: z.number(), email: z.string().email() });
const smallZZ = Z.object({ name: Z.string(), age: Z.number(), email: Z.string().email() });
const smallIn = Array.from({length: 64}, (_,i) => ({ name: `ada${i}`, age: 30 + (i%10), email: `a${i}@b.co` }));

const arrAZ = z.array(z.object({ id: z.number(), tag: z.string(), ok: z.boolean() }));
const arrZZ = Z.array(Z.object({ id: Z.number(), tag: Z.string(), ok: Z.boolean() }));
const arrIn = Array.from({length: 8}, (_,k) => Array.from({ length: 2000 }, (_, i) => ({ id: i+k, tag: `t${i}`, ok: i % 2 === 0 })));

const deepAZ = z.object({ a: z.object({ b: z.object({ c: z.object({ d: z.array(z.number().min(0)) }) }) }) });
const deepZZ = Z.object({ a: Z.object({ b: Z.object({ c: Z.object({ d: Z.array(Z.number().min(0)) }) }) }) });
const deepIn = Array.from({length:8},(_,k)=>({ a: { b: { c: { d: Array.from({length: 500}, (_,i)=>i+k) } } } }));

const unAZ = z.union([z.literal("a"), z.literal("b"), z.number(), z.object({ t: z.string() })]);
const unZZ = Z.union([Z.literal("a"), Z.literal("b"), Z.number(), Z.object({ t: Z.string() })]);
const unIn = Array.from({length:64},(_,i)=>i%3===0?{t:`x${i}`}:(i%3===1?i:"b"));

const failIn = Array.from({length:64},(_,i)=>({ name: i, age: `x${i}`, email: "nope" }));

const cases: [string, any, any, unknown[], number][] = [
  ["small-obj     x50k", smallAZ, smallZZ, smallIn, 50000],
  ["array-2000     x40", arrAZ, arrZZ, arrIn, 40],
  ["deep+arr500   x400", deepAZ, deepZZ, deepIn, 400],
  ["union-mixed   x30k", unAZ, unZZ, unIn, 30000],
  ["fail-issues   x10k", smallAZ, smallZZ, failIn, 10000],
];

console.log("workload              asmzod        zod4         ratio");
for (const [name, sa, sz, inp, it] of cases) {
  const n = (inp as unknown[]).length;
  const ta = bench(i => sa.safeParse(inp[i % n]), it);
  const tz = bench(i => sz.safeParse(inp[i % n]), it);
  console.log(`${name}   ${fmt(ta).padEnd(13)} ${fmt(tz).padEnd(13)} ${(ta/tz).toFixed(2)}x slower`);
}
