import { runSmoke } from "../test/runtime.ts";
import { engineBackend, z } from "../src/index.ts";
import { loadNapi } from "../src/native/napi.ts";

declare const Deno: any;
if (typeof Deno !== "undefined") {
  Deno.test("asmzod validates on Deno", () => {
    if (!runSmoke()) throw new Error("smoke failed");
    console.log("backend:", engineBackend, "napi:", loadNapi() ? "native" : "none");
  });
  Deno.test("N-API addon validates on Deno", () => {
    if (!loadNapi()) return;
    const S = z.object({ a: z.array(z.number()), s: z.string().min(2) });
    const r = S.safeParse({ a: [1, 2], s: "x" });
    if (r.success) throw new Error("expected fail");
  });
}
