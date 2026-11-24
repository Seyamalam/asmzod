// scripts/doctor.ts — environment + backend diagnostics
import { engineBackend, engineVersion } from "../src/ffi.ts";

const g = globalThis as any;
console.log("runtime :",
  g.Bun ? `Bun ${g.Bun.version}` :
  g.Deno ? `Deno ${g.Deno.version?.deno}` :
  g.process?.versions?.node ? `Node ${g.process.versions.node}` : "unknown");
console.log("platform:", g.process?.platform ?? "n/a", g.process?.arch ?? g.navigator?.hardwareConcurrency ?? "");
console.log("backend :", engineBackend, "engineVersion:", engineVersion);
const fs = await import("node:fs").catch(() => null);
for (const f of ["asm/asmzod.node", "asm/libasmzod.dylib", "asm/libasmzod.so"]) {
  try { console.log(`artifact: ${f}  ${fs!.statSync(f).size} bytes`); }
  catch { console.log(`artifact: ${f}  MISSING`); }
}
// napi probe
try {
  const napi = await import("../src/native/napi.ts");
  const probe = z => null;
  const { z } = await import("../src/index.ts");
  const c = (z.string() as any)._compile();
  const r = napi.parse(c.blob, "ok?", c.hosts, c.cbUnsafe);
  console.log("napi    :", r === null ? "unavailable (portable fallback)" : `ok (${JSON.stringify(r).slice(0, 60)})`);
} catch (e: any) {
  console.log("napi    :", "error —", e.message);
}
