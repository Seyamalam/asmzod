// examples/deno/basic.ts — run: deno run --allow-all examples/deno/basic.ts
import { z } from "../../src/index.ts";

const Point = z.object({ x: z.number(), y: z.number() });
console.log("deno:", Point.safeParse({ x: 1, y: 2 }).success);
