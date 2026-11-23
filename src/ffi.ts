// ffi.ts — libasmzod binding, callback table, parse driver
import { dlopen, ptr, JSCallback, read } from "bun:ffi";
import { decodeAt, encodeValue, view, type HostTable } from "./codec";

const libPath = new URL("../asm/libasmzod.dylib", import.meta.url).pathname;

const lib = dlopen(libPath, {
  az_parse: {
    args: ["pointer", "pointer", "pointer", "u64", "pointer", "u64", "pointer"],
    returns: "i64",
  },
  az_version: { args: [], returns: "u32" },
});

// ---- registries (cb ids index into these) ----
export const reg = {
  refine: [] as ((v: unknown) => unknown)[],
  transform: [] as ((v: unknown) => unknown)[],
  lazy: [] as (() => Uint8Array)[],
  regex: [] as RegExp[],
  ctor: [] as (new (...a: any[]) => any)[],
  custom: [] as ((v: unknown) => boolean)[],
};

export function regId<T>(arr: T[], v: T): number {
  arr.push(v);
  return arr.length - 1;
}

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

export function engineParse(blob: Uint8Array, input: Uint8Array, hosts: HostTable): ParseResult {
  let outCap = 1 << 16;
  let errCap = 1 << 16;
  let outv = new ArrayBuffer(outCap);
  let oute = new ArrayBuffer(errCap);
  curHosts = hosts;
  pendingThrow = null;

  for (;;) {
    curOut = { base: ptr(outv), cap: outCap };
    const status = lib.symbols.az_parse(
      ptr(blob), ptr(input),
      ptr(outv), BigInt(outCap),
      ptr(oute), BigInt(errCap),
      ptr(cbTable),
    ) as bigint;

    if (process.env.AZ_DEBUG) console.error("az status", status, "outCap", outCap, "errCap", errCap);
    if (status === -3n) { outCap *= 4; outv = new ArrayBuffer(outCap); continue; }
    if (status === -4n) { if (process.env.AZ_DEBUG) throw new Error("ENOSPC"); errCap *= 4; oute = new ArrayBuffer(errCap); continue; }
    if (pendingThrow !== null) { const e = pendingThrow; pendingThrow = null; throw e; }

    if (status === 0n) {
      const op = Number(read.u64(ptr(outv)) as bigint);
      const [v] = decodeAt(op, hosts);
      return { ok: true, value: v };
    }
    if (status === -2n) {
      const base = ptr(oute);
      const cnt = Number(read.u64(base) as bigint);
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

// ---- zod4 issue normalization ----
// the engine emits structured low-level issues; translate to zod@4 shapes
const FORMAT_NAMES: Record<string, string> = {
  email: "email", uuid: "uuid", url: "url", regex: "regex",
  startsWith: "starts_with", endsWith: "ends_with", includes: "includes",
  lowercase: "lowercase", uppercase: "uppercase",
  ipv4: "ipv4", ipv6: "ipv6", ulid: "ulid", nanoid: "nanoid",
  cuid2: "cuid2", base64: "base64", hex: "hex",
  datetime: "datetime", date: "date", time: "time",
};

function normalizeIssue(i: any): any {
  if (i == null || typeof i !== "object") return i;
  const out: any = { ...i };
  switch (i.code) {
    case "invalid_literal":
    case "invalid_enum_value":
      out.code = "invalid_value";
      break;
    case "invalid_string":
      out.code = "invalid_format";
      if (i.validation !== undefined) {
        out.format = FORMAT_NAMES[i.validation] ?? i.validation;
        delete out.validation;
      }
      break;
    case "not_finite":
      out.code = "invalid_type";
      break;
    case "too_small":
    case "too_big":
      if (i.type !== undefined) { out.origin = i.type; delete out.type; }
      break;
  }
  return out;
}

export const engineVersion = lib.symbols.az_version();
