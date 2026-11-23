import { runSmoke } from "../test/runtime.ts";
import { engineBackend } from "../src/index.ts";

declare const Deno: any;
if (typeof Deno !== "undefined") {
  Deno.test("asmzod portable engine validates on Deno", () => {
    if (!runSmoke()) throw new Error("smoke failed");
    console.log("backend:", engineBackend);
  });
}
