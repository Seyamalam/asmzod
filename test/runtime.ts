// Runtime-agnostic smoke: runs under `bun test`, `deno test`, or `node --test`
// via the portable engine. Native-specific cases live in api.test.ts.
import { z } from "../src/index.ts";

const schema = z.object({
  name: z.string().min(2),
  age: z.number().int().gte(0),
  email: z.string().email().optional(),
  tags: z.array(z.string()),
});

const good = { name: "ab", age: 3, tags: [] };
const bad = { name: "x", age: -1, tags: ["ok", 4] };

export function runSmoke() {
  const ok = schema.safeParse(good);
  if (!ok.success) throw new Error("valid input failed");
  const r = schema.safeParse(bad);
  if (r.success) throw new Error("invalid input passed");
  const codes = r.error.issues.map((i: any) => i.code);
  if (!codes.includes("too_small") || !codes.includes("invalid_type")) {
    throw new Error("unexpected issues " + JSON.stringify(codes));
  }
  return true;
}
