import * as Z from "zod";
import { z } from "../src/index";

let sink: unknown = null;
function bench(fn: (i: number) => unknown, iters: number): number {
  for (let w = 0; w < Math.max(3, iters >> 4); w++) sink = fn(w); // warmup
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

const recAZ = z.record(z.string(), z.number());
const recZZ = Z.record(Z.string(), Z.number());
const recIn = Array.from({length:32},(_,k)=>Object.fromEntries(Array.from({length:200},(_,i)=>[`k${k}_${i}`, i])));

const tupAZ = z.tuple([z.string(), z.number(), z.optional(z.boolean())]);
const tupZZ = Z.tuple([Z.string(), Z.number(), Z.optional(Z.boolean())]);
const tupIn = Array.from({length:64},(_,i)=>[`s${i}`, i, i%2===0]);

const strAZ = z.string().min(3).max(20).regex(/^[a-z0-9_]+$/);
const strZZ = Z.string().min(3).max(20).regex(/^[a-z0-9_]+$/);
const strIn = Array.from({length:64},(_,i)=>`user_${i}_ok`);

const strictAZ = z.strictObject({ a: z.string(), b: z.number() });
const strictZZ = Z.strictObject({ a: Z.string(), b: Z.number() });
const strictIn = Array.from({length:64},(_,i)=>({a:`x${i}`, b:i, extra:`e${i}`}));

const lazyAZ: any = z.lazy(() => z.object({ v: z.number(), child: z.optional(lazyAZ) }));
const lazyZZ: any = Z.lazy(() => Z.object({ v: Z.number(), child: Z.optional(lazyZZ) }));
const lazyIn = Array.from({length:32},(_,k)=>({v:k,child:{v:k+1,child:{v:k+2}}}));

const discAZ = z.discriminatedUnion("t", [z.object({t: z.literal("a"), x: z.number()}), z.object({t: z.literal("b"), y: z.string()})]);
const discZZ = Z.discriminatedUnion("t", [Z.object({t: Z.literal("a"), x: Z.number()}), Z.object({t: Z.literal("b"), y: Z.string()})]);
const discIn = Array.from({length:64},(_,i)=>i%2?{t:"a",x:i}:{t:"b",y:`y${i}`});

const optAZ = z.object({ a: z.optional(z.string()), b: z.nullable(z.number()), c: z.number().default(9) });
const optZZ = Z.object({ a: Z.optional(Z.string()), b: Z.nullable(Z.number()), c: Z.number().default(9) });
const optIn = Array.from({length:64},(_,i)=>({a:i%2?`s${i}`:undefined, b:i%3?i:null}));

const failIn = Array.from({length:64},(_,i)=>({ name: i, age: `x${i}`, email: "nope" }));

const fmtAZ = z.string().email();
const fmtZZ = Z.string().email();
const fmtIn = Array.from({length:64},(_,i)=>`user${i}@ex.co`);
const fmtBadIn = Array.from({length:64},(_,i)=>`user${i}-nope`);

const emojiAZ = z.string().emoji();
const emojiZZ = (Z.string() as any).emoji();
const emojiIn = Array.from({length:64},(_,i)=>`😀${i%7}`);

const coerceAZ = z.coerce.number();
const coerceZZ = Z.coerce.number();
const coerceIn = Array.from({length:64},(_,i)=>`${i}.5`);

const refAZ = z.string().refine(s => s.length > 2).transform(s => s.toUpperCase());
const refZZ = Z.string().refine((s: string) => s.length > 2).transform((s: string) => s.toUpperCase());
const refIn = Array.from({length:64},(_,i)=>`val_${i}`);

const msgwAZ: any = z.string({ error: "schema-err" } as any);
const msgwZZ: any = Z.string({ error: "schema-err" } as any);

const intAZ = z.number().int();
const intZZ = Z.number().int();
const intIn = Array.from({length:64},(_,i)=>i*7);

const dateAZ = z.date();
const dateZZ = Z.date();
const dateIn = Array.from({length:64},(_,i)=>new Date(1700000000000+i*1000));

const cases: [string, any, any, unknown[], number][] = [
  ["small-obj     x50k", smallAZ, smallZZ, smallIn, 50000],
  ["array-2000     x40", arrAZ, arrZZ, arrIn, 40],
  ["deep+arr500   x400", deepAZ, deepZZ, deepIn, 400],
  ["union-mixed   x30k", unAZ, unZZ, unIn, 30000],
  ["disc-union    x30k", discAZ, discZZ, discIn, 30000],
  ["record-200   x2000", recAZ, recZZ, recIn, 2000],
  ["tuple        x30k", tupAZ, tupZZ, tupIn, 30000],
  ["str-checks   x30k", strAZ, strZZ, strIn, 30000],
  ["strict-obj   x30k", strictAZ, strictZZ, strictIn, 30000],
  ["lazy-rec     x30k", lazyAZ, lazyZZ, lazyIn, 30000],
  ["opt/null/def x30k", optAZ, optZZ, optIn, 30000],
  ["fail-issues  x10k", smallAZ, smallZZ, failIn, 10000],
  ["str-email    x30k", fmtAZ, fmtZZ, fmtIn, 30000],
  ["str-email-f  x10k", fmtAZ, fmtZZ, fmtBadIn, 10000],
  ["emoji        x30k", emojiAZ, emojiZZ, emojiIn, 30000],
  ["coerce-num   x30k", coerceAZ, coerceZZ, coerceIn, 30000],
  ["refine+trans x30k", refAZ, refZZ, refIn, 30000],
  ["msgwrap      x30k", msgwAZ, msgwZZ, ["x"], 30000],
  ["msgwrap-fail x10k", msgwAZ, msgwZZ, [42], 10000],
  ["int-safe     x30k", intAZ, intZZ, intIn, 30000],
  ["date         x30k", dateAZ, dateZZ, dateIn, 30000],
];

console.log("workload              asmzod        zod4         ratio");
const rows: [string,string,string,string][] = [];
for (const [name, sa, sz, inp, it] of cases) {
  const n = (inp as unknown[]).length;
  const ta = bench(i => sa.safeParse(inp[i % n]), it);
  const tz = bench(i => sz.safeParse(inp[i % n]), it);
  console.log(`${name}   ${fmt(ta).padEnd(13)} ${fmt(tz).padEnd(13)} ${(ta/tz).toFixed(2)}x`);
  rows.push([name.trim(), fmt(ta), fmt(tz), `${(ta/tz).toFixed(2)}x`]);
}
if (process.argv.includes("--md")) {
  console.log("\n| workload | asmzod | zod4 | ratio |\n|---|---|---|---|");
  for (const [n,a,z,r] of rows) console.log(`| ${n} | ${a} | ${z} | ${r} |`);
}
