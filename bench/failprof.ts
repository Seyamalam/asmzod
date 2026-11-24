import { z } from "../src/index.ts";
import * as napiBackend from "../src/native/napi.ts";
import { encodeValue } from "../src/codec.ts";
import { ZodError } from "../src/error.ts";

const S = z.object({ a: z.string().min(2), b: z.number(), c: z.boolean() });
const bad = { a: "x", b: "no", c: 1 };
const c = (S as any)._compile();

const N = 30000;
const sink: any[] = [];
function t(name: string, f: () => void) {
  f(); f(); // warmup
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < N; i++) f();
  console.log(name.padEnd(28), ((Bun.nanoseconds() - t0) / N).toFixed(0), "ns");
}

// stage 1: native parse incl. issue-array construction
t("napi.parse (fail)", () => { sink[0] = napiBackend.parse(c.blob, bad, c.hosts, c.cbUnsafe); });
// stage 2: full _run (native + union splice + finishIssues/normalize)
t("_run (fail)", () => { sink[0] = (S as any)._run(bad); });
// stage 3: ZodError construction on ready issues
const r = (S as any)._run(bad);
const issues = (r as any).issues;
t("new ZodError", () => { sink[0] = new ZodError(issues); });
// full safeParse for reference
t("safeParse (fail)", () => { sink[0] = S.safeParse(bad); });
// error.message access (pretty print)
const e = new ZodError(issues);
t("error.message access", () => { sink[0] = e.message; });
console.log("issues:", issues.length, JSON.stringify(issues[0]).slice(0, 120));
