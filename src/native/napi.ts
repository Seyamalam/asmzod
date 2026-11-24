// native/napi.ts — N-API backend: validation runs against napi_values
// directly inside asmzod.node. No value encoding, no output decode —
// only the cold issue path crosses as an ArrayBuffer.
import { decodeValueAt, type HostTable } from "../codec.ts";
import { normalizeIssue, finishIssues } from "../shared.ts";
import type { ParseResult } from "./bun.ts";

import { createRequire } from "node:module";

const path = new URL("../../asm/asmzod.node", import.meta.url).pathname;
const req = createRequire(import.meta.url);

interface AzNapi {
  init(cbTable: Uint8Array): boolean;
  parse(blob: Uint8Array, value: unknown): { ok: true; value: unknown } | { ok: false; err: ArrayBuffer } | { ok: null; code: number } | undefined;
}

let addon: AzNapi | null | undefined;
export function loadNapi(): AzNapi | null {
  if (addon !== undefined) return addon;
  try {
    const a = req(path) as AzNapi;
    addon = a?.parse && a?.init ? a : null;
  } catch { addon = null; }
  return addon;
}

// cb table for regex/lazy/custom cbs — same 4-slot layout as the FFI backend:
// [refine, transform, lazy, host]
let cbInit = false;
export function initNapi(cbTable: ArrayBuffer): boolean {
  const a = loadNapi();
  if (!a) return false;
  if (cbInit) return true;
  cbInit = a.init(new Uint8Array(cbTable));
  return cbInit;
}

// -> ParseResult, or null when the schema needs the FFI path (callbacks,
// unions, records, transforms, ... anything aznapi_run doesn't cover).
let napiOff: boolean | undefined;
export function parse(blob: Uint8Array, value: unknown, hosts: HostTable, cbUnsafe?: boolean): ParseResult | null {
  const a = loadNapi();
  if (!a || cbUnsafe) return null;
  if (napiOff === undefined) {
    try { napiOff = (globalThis as any).process?.env?.AZ_NAPI === "0"; } catch { napiOff = false; }
  }
  if (napiOff) return null;
  if (!cbInit) {
    // cbtab is only read by callback opcodes, which always fall back first;
    // a nonzero dummy table satisfies the ctx check.
    cbInit = a.init(new Uint8Array(32));
    if (!cbInit) return null;
  }
  const r = a.parse(blob, value);
  if (r == null || r.ok === null) return null;
  if (r.ok === true) return { ok: true, value: r.value };
  // decode issues from the err ArrayBuffer: cnt@0, issues at +3104
  const buf = new Uint8Array(r.err);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cnt = Number(dv.getBigUint64(0, true));
  const issues: any[] = [];
  let cur = 3104;
  for (let i = 0; i < cnt; i++) {
    const [v, np] = decodeValueAt(buf, cur, hosts);
    issues.push(normalizeIssue(v));
    cur = np;
  }
  return { ok: false, issues: finishIssues(issues) };
}
