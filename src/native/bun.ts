// native/bun.ts — libasmzod binding via bun:ffi, callback table, parse driver
import { dlopen, ptr, JSCallback, read, toArrayBuffer } from "bun:ffi";
import { decodeAt, encodeValue, view, setMemBackend, type HostTable } from "../codec.ts";
import { reg, normalizeIssue } from "../shared.ts";

setMemBackend({
  view: (p, n) => new Uint8Array(toArrayBuffer(p, 0, n)),
  u8: (p) => read.u8(p),
  f64: (p) => read.f64(p),
  i64: (p) => read.i64(p) as bigint,
  u64: (p) => read.u64(p) as bigint,
});

// ELF keeps the Mach-O-style `_` prefix (source symbols are `_az_*` on both)
const isDarwin = (globalThis as any).process?.platform !== "linux";
const libPath = new URL(
  isDarwin ? "../../asm/libasmzod.dylib" : "../../asm/libasmzod.so",
  import.meta.url,
).pathname;
const P = isDarwin ? "" : "_"; // symbol prefix on ELF

const lib = dlopen(libPath, {
  [P + "az_parse"]: {
    args: ["pointer", "pointer", "pointer", "u64", "pointer", "u64", "pointer"],
    returns: "i64",
  },
  [P + "az_version"]: { args: [], returns: "u32" },
});

// error thrown inside a callback — rethrown by the driver after the call
let pendingThrow: unknown = null;
// hosts for the in-flight parse
let curHosts: HostTable = [];
// out_val buffer base/size for cb writes (kind 5)
let curOut = { base: 0, cap: 0 };

// hosttype table must match asm/_az_hosttype_table order
function hostTypeIndex(v: unknown): number {
  if (typeof v === "symbol") return 0;
  if (v instanceof Date) return 1;
  if (v instanceof Map) return 2;
  if (v instanceof Set) return 3;
  if (typeof v === "function") return 4;
  if (typeof v === "object" && v !== null) return 5;
  return 6; // unknown
}

const cbRefine = new JSCallback(
  (id: bigint, valptr: bigint) => {
    try {
      const [v] = decodeAt(Number(valptr), curHosts);
      const r = reg.refine[Number(id)](v);
      return r ? 1 : 0;
    } catch (e) {
      pendingThrow = e;
      return 0;
    }
  },
  { args: ["u64", "u64"], returns: "u32" },
);

const cbTransform = new JSCallback(
  (id: bigint, valptr: bigint, outptr: bigint, avail: bigint) => {
    try {
      const [v] = decodeAt(Number(valptr), curHosts);
      const r = reg.transform[Number(id)](v);
      const bytes = encodeValue(r, curHosts);
      if (bytes.length > Number(avail)) return BigInt(-3);
      view(Number(outptr), bytes.length).set(bytes);
      return BigInt(bytes.length);
    } catch (e) {
      pendingThrow = e;
      return BigInt(-5);
    }
  },
  { args: ["u64", "u64", "u64", "u64"], returns: "i64" },
);

const cbLazy = new JSCallback(
  (id: bigint) => {
    const blob = reg.lazy[Number(id)]();
    return BigInt(ptr(blob));
  },
  { args: ["u64"], returns: "u64" },
);

const cbHost = new JSCallback(
  (kind: bigint, a: bigint, b: bigint, c: bigint) => {
    const k = Number(kind);
    try {
      switch (k) {
        case 0: { // regex: a=cbid b=strptr c=strlen
          const re = reg.regex[Number(a)];
          const s = new TextDecoder().decode(view(Number(b), Number(c)));
          re.lastIndex = 0;
          return re.test(s) ? 1n : 0n;
        }
        case 1: { // instanceof: a=cbid b=hostidx
          const Ctor = reg.ctor[Number(a)];
          return curHosts[Number(b)] instanceof Ctor ? 1n : 0n;
        }
        case 2: { // hostref kind: a=subtype b=hostidx
          const v = curHosts[Number(b)];
          switch (Number(a)) {
            case 1: return typeof v === "symbol" ? 1n : 0n;
            case 2: return v instanceof Date ? 1n : 0n;
            case 3: return v instanceof Map ? 1n : 0n;
            case 4: return v instanceof Set ? 1n : 0n;
          }
          return 0n;
        }
        case 3: { // date getTime: a=hostidx -> f64 bits
          const v = curHosts[Number(a)];
          const t = v instanceof Date ? v.getTime() : NaN;
          const buf = new ArrayBuffer(8);
          new DataView(buf).setFloat64(0, t, true);
          return new DataView(buf).getBigInt64(0, true);
        }
        case 4: { // custom: a=cbid b=valptr
          const [v] = decodeAt(Number(b), curHosts);
          return reg.custom[Number(a)](v) ? 1n : 0n;
        }
        case 5: { // coerce hostref->primitive: a=valptr b=target c=outptr
          const [v] = decodeAt(Number(a), curHosts);
          const t = Number(b);
          let r: unknown;
          try {
            if (t === 1) r = String(v);
            else if (t === 2) r = Number(v);
            else if (t === 3) r = Boolean(v);
            else r = BigInt(v as any);
          } catch { return 0n; } // coercion threw -> empty output (invalid)
          const bytes = encodeValue(r, curHosts);
          const op = Number(c);
          const avail = curOut.base + curOut.cap - op;
          if (bytes.length > avail) return BigInt(-3);
          view(op, bytes.length).set(bytes);
          return BigInt(bytes.length);
        }
        case 6: { // hostref type name index: a=hostidx
          return BigInt(hostTypeIndex(curHosts[Number(a)]));
        }
        case 8: { // write ctor name for an "other object" hostref: a=hostidx b=destptr c=cap
          const v = curHosts[Number(a)] as any;
          let name = "object";
          if (v !== null && typeof v === "object" &&
              Object.getPrototypeOf(v) !== Object.prototype &&
              "constructor" in v && v.constructor?.name) name = v.constructor.name;
          const nb = new TextEncoder().encode(name);
          const n = Math.min(nb.length, Number(c));
          view(Number(b), n).set(nb.subarray(0, n));
          return BigInt(n);
        }
        case 7: { // .length of host value: a=hostidx -> len or -1
          const v = curHosts[Number(a)] as any;
          const l = v?.length;
          return typeof l === "number" && l >= 0 && Number.isInteger(l)
            ? BigInt(l) : -1n;
        }
      }
      return 0n;
    } catch (e) {
      pendingThrow = e;
      return BigInt(-5);
    }
  },
  { args: ["u64", "u64", "u64", "u64"], returns: "i64" },
);

const cbTable = new ArrayBuffer(32);
{
  const dv = new DataView(cbTable);
  dv.setBigUint64(0, BigInt(cbRefine.ptr), true);
  dv.setBigUint64(8, BigInt(cbTransform.ptr), true);
  dv.setBigUint64(16, BigInt(cbLazy.ptr), true);
  dv.setBigUint64(24, BigInt(cbHost.ptr), true);
}

export interface ParseOk { ok: true; value: unknown }
export interface ParseFail { ok: false; issues: any[] }
export type ParseResult = ParseOk | ParseFail;

const ERR_ISSUES_OFF = 3104;

// pooled parse arenas — reused across calls; grow to the largest size seen
// and stay there. Buffers are fully consumed before returning, so sharing
// is safe within a thread.
let poolOut = new ArrayBuffer(1 << 16), poolOutCap = 1 << 16;
let poolErr = new ArrayBuffer(1 << 16), poolErrCap = 1 << 16;

export function parse(blob: Uint8Array, input: Uint8Array, hosts: HostTable): ParseResult {
  let outCap = poolOutCap;
  let errCap = poolErrCap;
  let outv = poolOut;
  let oute = poolErr;
  curHosts = hosts;
  pendingThrow = null;

  for (;;) {
    if ((process.env as any)?.AZ_POISON) { new Uint8Array(outv).fill(0xaa); new Uint8Array(oute).fill(0xaa); }
    curOut = { base: ptr(outv), cap: outCap };
    const status = (lib.symbols as any)[P + "az_parse"](
      ptr(blob), ptr(input),
      ptr(outv), BigInt(outCap),
      ptr(oute), BigInt(errCap),
      ptr(cbTable),
    ) as bigint;

    if (process.env.AZ_DEBUG) console.error("az status", status, "outCap", outCap, "errCap", errCap);
    if (status === -3n) { outCap *= 4; outv = new ArrayBuffer(outCap); poolOut = outv; poolOutCap = outCap; continue; }
    if (status === -4n) { if (process.env.AZ_DEBUG) throw new Error("ENOSPC"); errCap *= 4; oute = new ArrayBuffer(errCap); poolErr = oute; poolErrCap = errCap; continue; }
    if (pendingThrow !== null) { const e = pendingThrow; pendingThrow = null; throw e; }

    if (status === 0n) {
      const op = Number(read.u64(ptr(outv)) as bigint);
      const [v] = decodeAt(op, hosts);
      return { ok: true, value: v };
    }
    if (status === -2n) {
      const base = ptr(oute);
      const cnt = Number(read.u64(base) as bigint);
      if ((process.env as any).AZ_DEBUG_ERR) {
        const n = Math.min(Number(read.u64(base + 3104 - 8) as bigint) ? 512 : 512, errCap);
        const bytes = new Uint8Array(toArrayBuffer(base + ERR_ISSUES_OFF, 0, n));
        console.error("ERR[0..512]:", [...bytes].map(b => b.toString(16).padStart(2, "0")).join(" "));
      }
      const issues: any[] = [];
      let cur = base + ERR_ISSUES_OFF;
      for (let i = 0; i < cnt; i++) {
        const [v, np] = decodeAt(cur, hosts);
        issues.push(normalizeIssue(v));
        cur = np;
      }
      return { ok: false, issues };
    }
    throw new Error(`asmzod: engine error ${status}`);
  }
}

export const version = (lib.symbols as any)[P + "az_version"]();
