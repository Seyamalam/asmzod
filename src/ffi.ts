// ffi.ts — engine facade. Picks the best available backend:
//   1. native libasmzod via bun:ffi     (Bun)
//   2. native libasmzod via Deno.dlopen (Deno)
//   3. native libasmzod via koffi       (Node, optional dep)
//   4. portable TS interpreter          (Node, Deno, Cloudflare Workers, browsers)
// AZ_ENGINE=portable forces the interpreter (useful for differential testing).
import type { HostTable } from "./codec.ts";
import { reg, regId, normalizeIssue } from "./shared.ts";
import { portableParse } from "./engine.ts";

export { reg, regId };

export interface ParseOk { ok: true; value: unknown }
export interface ParseFail { ok: false; issues: any[] }
export type ParseResult = ParseOk | ParseFail;

export interface EngineBackend {
  name: string;
  version: number;
  parse(blob: Uint8Array, input: Uint8Array, hosts: HostTable): ParseResult;
}

const g = globalThis as any;
let forced: string | undefined;
try { forced = g.process?.env?.AZ_ENGINE; } catch { /* Deno env access may be denied */ }

function loadBun(): EngineBackend | null {
  if (!g.Bun) return null;
  // Bun injects import.meta.require in ESM modules — resolves like import
  const req: undefined | ((spec: string) => any) = (import.meta as any).require;
  if (!req) return null;
  const m = req("./native/bun.ts");
  return { name: "bun:ffi", version: m.version, parse: (b: Uint8Array, i: Uint8Array, h: HostTable) => m.parse(b, i, h) };
}

let backend: EngineBackend | null = null;
if (forced !== "portable") {
  try { backend = loadBun(); } catch (e) { if (forced === "native") throw e; }
  // Deno (Deno.dlopen) and Node (koffi) native drivers plug in here;
  // until then the portable interpreter covers those runtimes.
}

export const engineBackend = backend?.name ?? "portable";
export const engineVersion = backend?.version ?? 0;

export function engineParse(blob: Uint8Array, input: Uint8Array, hosts: HostTable): ParseResult {
  if (backend) return backend.parse(blob, input, hosts);
  const r = portableParse(blob, input, hosts);
  return r.ok ? { ok: true, value: r.value } : { ok: false, issues: r.issues.map(normalizeIssue) };
}
