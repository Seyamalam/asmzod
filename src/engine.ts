// engine.ts — portable bytecode interpreter.
// Pure TypeScript: runs the same schema blob + tagged-value format the ARM64
// engine uses, so it works on Node, Deno, Cloudflare Workers, browsers —
// everywhere asm/libasmzod.dylib can't load.
import type { HostTable } from "./codec.ts";
import { reg, parsedTypeName } from "./shared.ts";

// ---- byte reader over a blob ----
class R {
  pos: number;
  b: Uint8Array;
  constructor(b: Uint8Array, pos = 0) { this.b = b; this.pos = pos; }
  u8() { return this.b[this.pos++]; }
  u64() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos).getBigUint64(0, true); this.pos += 8; return v; }
  i64() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos).getBigInt64(0, true); this.pos += 8; return v; }
  f64() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos).getFloat64(0, true); this.pos += 8; return v; }
  bytes(n: number) { const s = this.b.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  str(n: number | bigint) { return new TextDecoder().decode(this.bytes(Number(n))); }
  // i64 offset relative to the field's own address
  child(fieldPos: number) { const save = this.pos; this.pos = fieldPos; const rel = this.i64(); this.pos = save; return fieldPos + Number(rel); }
}

const dec = new TextDecoder();

// ---- tagged value decoder (must match codec.ts encodeValue) ----
function decodeValue(r: R, hosts: HostTable): unknown {
  const tag = r.u8();
  switch (tag) {
    case 0: return undefined;
    case 1: return null;
    case 2: return r.u8() !== 0;
    case 3: { const v = new DataView(r.b.buffer, r.b.byteOffset + r.pos).getFloat64(0, true); r.pos += 8; return v; }
    case 4: { const n = Number(r.u64()); return r.str(n); }
    case 5: return r.i64();
    case 6: {
      const n = Number(r.u64()); const o: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) { const k = r.str(Number(r.u64())); o[k] = decodeValue(r, hosts); }
      return o;
    }
    case 7: { const n = Number(r.u64()); const a: unknown[] = []; for (let i = 0; i < n; i++) a.push(decodeValue(r, hosts)); return a; }
    case 8: return hosts[Number(r.u64())];
    case 9: {
      const n = Number(r.u64()); const m = new Map();
      for (let i = 0; i < n; i++) m.set(decodeValue(r, hosts), decodeValue(r, hosts));
      return m;
    }
    case 10: {
      const n = Number(r.u64()); const s = new Set();
      for (let i = 0; i < n; i++) s.add(decodeValue(r, hosts));
      return s;
    }
    default: throw new Error(`asmzod: bad value tag ${tag}`);
  }
}

// ---- issue emission (internal pre-normalization shapes) ----
interface Ctx {
  hosts: HostTable;
  issues: any[];
  path: (string | number)[];
  // pendingThrow mirrors the FFI driver's callback-error channel
  pendingThrow: unknown;
}
function pushIssue(c: Ctx, code: string, fields?: Record<string, unknown>) {
  c.issues.push({ code, path: [...c.path], ...fields });
}
function atKey<T>(c: Ctx, k: string | number, f: () => T): T {
  c.path.push(k); try { return f(); } finally { c.path.pop(); }
}

// type names matching asm/.Lt* + hostref table (zod parsedType)
const typeName = parsedTypeName;
// zod's size-check origin for a received value: string/array keep their name,
// anything else with a .length (functions, host objects) reports "unknown"
const sizeOrigin = (v: unknown) => {
  const t = typeName(v);
  return t === "string" || t === "array" ? t : "unknown";
};

// az_input_len: strings count code points (matches asm utf16_units)
function inputLen(v: unknown): number {
  if (typeof v === "string") { let n = 0; for (const _ of v) n++; return n; }
  if (Array.isArray(v)) return v.length;
  const l = (v as any)?.length;
  return typeof l === "number" && l >= 0 && Number.isInteger(l) ? l : -1;
}

const TYPE_FAIL_CODES = new Set(["invalid_type", "invalid_value"]);

// the interpreter. returns {ok, value} or {ok:false} — issues accumulate on c.
export function portableParse(blob: Uint8Array, input: Uint8Array, hosts: HostTable) {
  const c: Ctx = { hosts, issues: [], path: [], pendingThrow: null };
  const rin = new R(input);
  const v = decodeValue(rin, hosts);
  let out: unknown;
  try {
    out = validate(new R(blob), v, c);
  } catch (e) {
    if (e !== FAILED) throw e;
  }
  if (c.pendingThrow !== null) throw c.pendingThrow;
  if (c.issues.length) return { ok: false as const, issues: c.issues };
  return { ok: true as const, value: out };
}

// ---- check runners ----

function msgOf(r: R): string | undefined {
  const n = Number(r.u64());
  return n ? r.str(n) : undefined;
}

function sizeFail(c: Ctx, code: "too_small" | "too_big", origin: string,
  limit: bigint, inclusive: boolean, exact: boolean, msg?: string, nc?: boolean) {
  // zod emits number for f64-origin limits, bigint for bigint-schema limits;
  // coerce when it fits so issues stay JSON-serializable
  const lim: number | bigint =
    origin === "bigint" ? limit
      : limit >= BigInt(Number.MIN_SAFE_INTEGER) && limit <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(limit) : limit;
  pushIssue(c, code, {
    type: origin, [code === "too_small" ? "minimum" : "maximum"]: lim,
    inclusive, ...(exact ? { exact: true } : {}), ...(nc ? { _nc: true } : {}),
    ...(msg ? { message: msg } : {}),
  });
}

// returns whether the value is a valid string; runs all checks on failure too
function runStrChecks(r: R, v: unknown, c: Ctx): boolean {
  const n = r.u8();
  const recs: { code: number; msg?: string; p: number }[] = [];
  for (let i = 0; i < n; i++) { const code = r.u8(); const msg = msgOf(r); recs.push({ code, msg, p: r.pos }); r.pos = checkParamEnd(r, code, true); }
  const isStr = typeof v === "string";
  const len = isStr ? inputLen(v) : -1;
  const alen = isStr ? len : inputLen(v);
  let fail = !isStr;
  for (const rc of recs) {
    const save = r.pos; r.pos = rc.p;
    try {
      switch (rc.code) {
        case 0x01: { const l = r.u64(); if (alen >= 0 && BigInt(alen) < l) { sizeFail(c, "too_small", sizeOrigin(v), l, true, false, rc.msg); fail = true; } break; }
        case 0x02: { const l = r.u64(); if (alen >= 0 && BigInt(alen) > l) { sizeFail(c, "too_big", sizeOrigin(v), l, true, false, rc.msg); fail = true; } break; }
        case 0x03: { const l = r.u64(); if (alen >= 0 && BigInt(alen) !== l) { sizeFail(c, BigInt(alen) < l ? "too_small" : "too_big", sizeOrigin(v), l, true, true, rc.msg); fail = true; } break; }
        case 0x07: { const s = r.str(Number(r.u64())); if (isStr && !(v as string).startsWith(s)) { fmtFail(c, "startsWith", rc.msg, { prefix: s }); fail = true; } break; }
        case 0x08: { const s = r.str(Number(r.u64())); if (isStr && !(v as string).endsWith(s)) { fmtFail(c, "endsWith", rc.msg, { suffix: s }); fail = true; } break; }
        case 0x09: { const s = r.str(Number(r.u64())); if (isStr && !(v as string).includes(s)) { fmtFail(c, "includes", rc.msg, { includes: s }); fail = true; } break; }
        case 0x0a: { const re = reg.regex[Number(r.u64())]; const src = r.str(Number(r.u64())); if (isStr) { re.lastIndex = 0; if (!re.test(v as string)) { fmtFail(c, "regex", rc.msg, { pattern: src }); fail = true; } } break; }
        case 0x18: {
          const body = Number(r.u64()); const alpha = r.u8(); const pad = r.u8();
          const fmt = r.str(Number(r.u64()));
          const ALPHAS = ["0-9a-fA-F", "A-Za-z0-9+/", "A-Za-z0-9_-"];
          if (isStr && !(v.length === body + pad &&
              new RegExp(`^[${ALPHAS[alpha]}]{${body}}${"=".repeat(pad)}$`).test(v))) {
            fmtFail(c, fmt, rc.msg); fail = true;
          }
          break;
        }
        default: {
          if (isStr && !STR_FMT[rc.code]?.(v as string)) { fmtFail(c, STR_NAMES[rc.code] ?? "format", rc.msg); fail = true; }
        }
      }
    } finally { r.pos = save; }
  }
  return !fail;
}

function fmtFail(c: Ctx, validation: string, msg?: string, extra?: Record<string, unknown>) {
  pushIssue(c, "invalid_string", { validation, ...extra, ...(msg ? { message: msg } : {}) });
}

function checkParamEnd(r: R, code: number, str_: boolean): number {
  const save = r.pos;
  if (str_) {
    if (code === 0x01 || code === 0x02 || code === 0x03) { r.pos += 8; }
    else if (code === 0x05) { r.pos += 1; }
    else if (code === 0x07 || code === 0x08 || code === 0x09) { r.pos += 8 + Number(r.u64()); }
    else if (code === 0x0a) { r.pos += 8; r.pos += 8 + Number(r.u64()); }
    else if (code === 0x18) { r.pos += 10; r.pos += 8 + Number(r.u64()); }
  } else {
    if (code >= 0x01 && code <= 0x04 || code === 0x07) { r.pos += 8; }
    else if (code === 0x09) { r.pos += 17; }
  }
  const end = r.pos; r.pos = save; return end;
}

const STR_NAMES: Record<number, string> = {
  0x04: "email", 0x05: "uuid", 0x06: "url", 0x0b: "lowercase", 0x0c: "uppercase",
  0x0d: "ipv4", 0x0e: "ipv6", 0x0f: "ulid", 0x10: "nanoid", 0x11: "cuid2",
  0x12: "base64", 0x13: "hex", 0x14: "datetime", 0x15: "date", 0x16: "time",
};
// format validators — regexes lifted verbatim from zod@4 (v4/core/regexes.js)
const Z_DATE = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$/;
const Z_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/;
const Z_DATETIME = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|(?:[+-](?:[01]\d|2[0-3]):[0-5]\d)))$/;
const STR_FMT: Record<number, (s: string) => boolean> = {
  0x04: (s) => /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/.test(s),
  0x05: (s) => /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(s),
  0x06: (s) => { try { const u = new URL(s); return !!u.hostname; } catch { return false; } },
  0x0b: (s) => s === s.toLowerCase(),
  0x0c: (s) => s === s.toUpperCase(),
  0x0d: (s) => /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/.test(s),
  // zod validates ipv6 via the URL parser (the exported regex is decorative)
  0x0e: (s) => /^[0-9a-fA-F:.]+$/.test(s) && (() => { try { new URL(`http://[${s}]`); return true; } catch { return false; } })(),
  0x0f: (s) => /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/.test(s),
  0x10: (s) => /^[a-zA-Z0-9_-]{21}$/.test(s),
  0x11: (s) => /^[0-9a-z]+$/.test(s),
  0x12: (s) => /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/.test(s),
  0x13: (s) => /^[0-9a-fA-F]*$/.test(s),
  0x14: (s) => Z_DATETIME.test(s),
  0x15: (s) => Z_DATE.test(s),
  0x16: (s) => Z_TIME.test(s),
};

function runNumChecks(r: R, v: number | bigint, isBig: boolean, c: Ctx): boolean {
  const n = r.u8();
  let fail = false;
  for (let i = 0; i < n; i++) {
    let code = r.u8(); const msg = msgOf(r);
    // code|0x10: the i64 slot holds a u64 index into hosts instead — used for
    // bigint bounds beyond i64; the bound is the real bigint
    const bound = () => c.hosts[Number(r.u64())] as bigint;
    switch (code) {
      case 0x01: case 0x11: { const p = code === 0x11 ? bound() : isBig ? r.i64() : r.f64(); if (!(v > (p as any))) { sizeFail(c, "too_small", isBig ? "bigint" : "number", BigInt(p as any), false, false, msg); fail = true; } break; }
      case 0x02: case 0x12: { const p = code === 0x12 ? bound() : isBig ? r.i64() : r.f64(); if (!(v >= (p as any))) { sizeFail(c, "too_small", isBig ? "bigint" : "number", BigInt(p as any), true, false, msg); fail = true; } break; }
      case 0x03: case 0x13: { const p = code === 0x13 ? bound() : isBig ? r.i64() : r.f64(); if (!(v < (p as any))) { sizeFail(c, "too_big", isBig ? "bigint" : "number", BigInt(p as any), false, false, msg); fail = true; } break; }
      case 0x04: case 0x14: { const p = code === 0x14 ? bound() : isBig ? r.i64() : r.f64(); if (!(v <= (p as any))) { sizeFail(c, "too_big", isBig ? "bigint" : "number", BigInt(p as any), true, false, msg); fail = true; } break; }
      case 0x05: {
        const ok = isBig || Number.isInteger(v as number);
        if (!ok) { pushIssue(c, "invalid_type", { expected: "int", received: typeName(v), ...(msg ? { message: msg } : {}) }); fail = true; }
        break;
      }
      case 0x06: {
        if (!isBig && !Number.isFinite(v as number)) { pushIssue(c, "not_finite", { ...(msg ? { message: msg } : {}) }); fail = true; }
        break;
      }
      case 0x07: case 0x17: {
        const p = code === 0x17 ? bound() : isBig ? r.i64() : r.f64();
        // zod floatSafeRemainder: |ratio - round(ratio)| < 4*eps*max(|ratio|,1)
        const ok = isBig ? (p !== 0n && (v as bigint) % (p as bigint) === 0n)
          : Math.abs((v as number) / (p as number) - Math.round((v as number) / (p as number)))
            < 4 * Number.EPSILON * Math.max(Math.abs((v as number) / (p as number)), 1);
        if (!ok) { pushIssue(c, "not_multiple_of", { divisor: p, ...(msg ? { message: msg } : {}) }); fail = true; }
        break;
      }
      case 0x09: { // fused [lo f64][hi f64][flags] — both sides checked (numbers only)
        const lo = r.f64(), hi = r.f64(), flags = r.u8();
        if (!(v >= lo)) { sizeFail(c, "too_small", "number", lo as any, (flags & 1) === 1, false, msg); fail = true; }
        if (!(v <= hi)) { sizeFail(c, "too_big", "number", hi as any, (flags & 2) === 2, false, msg); fail = true; }
        break;
      }
      case 0x08: {
        const nonInt = !isBig && !Number.isInteger(v as number);
        const ok = nonInt ? false : isBig
          ? (v as bigint) >= BigInt(Number.MIN_SAFE_INTEGER) && (v as bigint) <= BigInt(Number.MAX_SAFE_INTEGER)
          : Number.isSafeInteger(v as number);
        if (!ok && nonInt) {
          pushIssue(c, "invalid_type", { expected: "int", received: typeName(v), ...(msg ? { message: msg } : {}) });
          fail = true;
        } else if (!ok) {
          const over = isBig ? (v as bigint) > 0n : (v as number) > 0;
          const lim = over ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
          pushIssue(c, over ? "too_big" : "too_small", {
            type: "int", [over ? "maximum" : "minimum"]: lim, inclusive: true, ...(msg ? { message: msg } : {}) });
          fail = true;
        }
        break;
      }
    }
  }
  return !fail;
}

// ---- main validator: node offset -> validated output or issue accumulation ----
// success: returns output value. failure: pushes issues, returns undefined.

function validate(r: R, v: unknown, c: Ctx): unknown {
  const node = r.pos;
  const op = r.u8();
  switch (op) {
    case 0x01: { // string
      const isStr = typeof v === "string";
      if (!isStr) pushIssue(c, "invalid_type", { expected: "string", received: typeName(v) });
      if (!runStrChecks(r, v, c) || !isStr) throw FAILED;
      return v;
    }
    case 0x02: { // number
      if (typeof v !== "number" || !Number.isFinite(v)) {
        pushIssue(c, "invalid_type", { expected: "number", received: typeName(v) });
        throw FAILED;
      }
      if (!runNumChecks(r, v as number, false, c)) throw FAILED;
      return v;
    }
    case 0x03: { // boolean
      if (typeof v !== "boolean") { pushIssue(c, "invalid_type", { expected: "boolean", received: typeName(v) }); throw FAILED; }
      return v;
    }
    case 0x04: { // bigint
      if (typeof v !== "bigint") { pushIssue(c, "invalid_type", { expected: "bigint", received: typeName(v) }); throw FAILED; }
      if (!runNumChecks(r, v as bigint, true, c)) throw FAILED;
      return v;
    }
    case 0x05: { // object
      const mode = r.u8();
      const catchallPos = r.pos; const catchallOff = r.i64();
      const nf = Number(r.u64());
      const fields: { name: string; pos: number; opt: number }[] = [];
      for (let i = 0; i < nf; i++) {
        const opt = r.u8();
        const nl = Number(r.u64()); const name = r.str(nl);
        const fp = r.pos; fields.push({ name, pos: fp + Number(r.i64()), opt });
      }
      // hostrefs that are objects (Date/Map/Set/classes) -> treated as empty
      // objects; functions/symbols/primitives -> invalid_type
      const objectLike = v !== null && typeof v === "object" && !Array.isArray(v);
      if (!objectLike) { pushIssue(c, "invalid_type", { expected: "object", received: typeName(v) }); throw FAILED; }
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const before = c.issues.length;
      const consumed = new Set<string>();
      for (const f of fields) {
        consumed.add(f.name);
        // a declared "__proto__" field is never validated or written — zod
        // strips it everywhere; it only counts as a known key below
        if (f.name === "__proto__") continue;
        const present = Object.prototype.hasOwnProperty.call(obj, f.name);
        // opt 2: absent optin==="optional"+optional-out contributes nothing
        if (!present && f.opt === 2) continue;
        const raw = obj[f.name];
        const mark = c.issues.length;
        const res = atKey(c, f.name, () => tryValidate(new R(r.b, f.pos), raw, c));
        // opt 1: absent + omittable + optional-out swallows its failure whole
        if (!present && f.opt === 1 && !res.ok) { c.issues.length = mark; continue; }
        // absent + required but inner accepted undefined -> nonoptional issue
        if (!present && f.opt === 0 && res.ok) {
          atKey(c, f.name, () => pushIssue(c, "invalid_type", { expected: "nonoptional", received: "undefined" }));
          continue;
        }
        // absent + opt 0 -> no value lands regardless of the run
        if (!present && f.opt === 0) continue;
        // zod writes the field's payload value even on failure; absent fields
        // only write defined values unless they are defaulted non-optional-out
        const val = res.ok ? res.value : raw;
        if (val === undefined) {
          if (present || f.opt === 3) out[f.name] = undefined;
        } else {
          out[f.name] = val;
        }
      }
      const extra = Object.keys(obj).filter((k) => !consumed.has(k));
      if (mode === 1 && extra.length) {
        pushIssue(c, "unrecognized_keys", { keys: extra });
      } else if (mode === 2) {
        for (const k of extra) if (k !== "__proto__") out[k] = obj[k];
      } else if (catchallOff !== 0n) {
        const cpos = catchallPos + Number(catchallOff);
        for (const k of extra) {
          if (k === "__proto__") continue;
          const res = atKey(c, k, () => tryValidate(new R(r.b, cpos), obj[k], c));
          if (res.ok) out[k] = res.value;
        }
      }
      if (c.issues.length !== before) throw FAILED;
      return out;
    }
    case 0x06: { // array — layout: elemoff | min | max | exact u8
      const ep = r.pos; const epos = ep + Number(r.i64());
      const min = r.i64(); const max = r.i64();
      const exact = r.u8() !== 0;
      if (!Array.isArray(v)) {
        pushIssue(c, "invalid_type", { expected: "array", received: typeName(v) });
        // uniform .length semantics: size checks still run on the input's length
        const alen = inputLen(v);
        if (alen >= 0) {
          if (min !== -1n && BigInt(alen) < min) sizeFail(c, "too_small", sizeOrigin(v), min, true, exact, undefined);
          if (max !== -1n && BigInt(alen) > max) sizeFail(c, "too_big", sizeOrigin(v), max, true, exact, undefined);
        }
        throw FAILED;
      }
      const before = c.issues.length;
      // zod precheks the upper bound before any element runs — a too_big
      // payload is non-continuable: no item issues, no downstream checks
      if (max !== -1n && BigInt(v.length) > max) {
        sizeFail(c, "too_big", "array", max, true, exact, undefined, true);
        throw FAILED;
      }
      const out: unknown[] = new Array(v.length);
      for (let i = 0; i < v.length; i++) {
        const res = atKey(c, i, () => tryValidate(new R(r.b, epos), v[i], c));
        if (res.ok) out[i] = res.value;
      }
      // item issues precede the size issue — zod emits too_small after the
      // element walk, too_big is precheked before it
      if (min !== -1n && BigInt(v.length) < min) sizeFail(c, "too_small", "array", min, true, exact, undefined);
      if (c.issues.length !== before) throw FAILED;
      return out;
    }
    case 0x07: { // union — engine always emits invalid_union; TS layer refines
      const n = Number(r.u64());
      const offs: number[] = [];
      for (let i = 0; i < n; i++) { const fp = r.pos; offs.push(fp + Number(r.i64())); }
      const uidx = Number(r.u64()); // after fps, before option subtrees
      for (const p of offs) {
        const save = c.issues.length;
        const rr = new R(r.b); rr.pos = p;
        const res = tryValidate(rr, v, c);
        if (res.ok) { c.issues.length = save; return res.value; }
        c.issues.length = save;
      }
      pushIssue(c, "invalid_union", { _u: uidx });
      throw FAILED;
    }
    case 0x08: { // discriminated union
      const dl = Number(r.u64()); const dname = r.str(dl);
      const n = Number(r.u64());
      const entries: { key: string; pos: number }[] = [];
      for (let i = 0; i < n; i++) { const kl = Number(r.u64()); const key = r.str(kl); const fp = r.pos; entries.push({ key, pos: fp + Number(r.i64()) }); }
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        pushIssue(c, "invalid_type", { expected: "object", received: typeName(v) });
        throw FAILED;
      }
      const dv = (v as any)[dname];
      if (!(typeof dv === "string" || typeof dv === "number" || typeof dv === "boolean" || dv === null || dv === undefined)) {
        pushIssue(c, "invalid_union", {});
        throw FAILED;
      }
      const e = entries.find((x) => x.key === String(dv));
      if (!e) {
        atKey(c, dname, () => pushIssue(c, "invalid_union", {}));
        throw FAILED;
      }
      const rr = new R(r.b); rr.pos = e.pos;
      return validate(rr, v, c);
    }
    case 0x09: { // literal
      const lv = decodeValue(r, c.hosts);
      if (!literalEq(v, lv)) { pushIssue(c, "invalid_literal", { expected: lv }); throw FAILED; }
      return v;
    }
    case 0x0a: { // enum
      const n = Number(r.u64()); const vals: string[] = [];
      for (let i = 0; i < n; i++) vals.push(r.str(Number(r.u64())));
      if (typeof v !== "string" || !vals.includes(v)) { pushIssue(c, "invalid_value", { values: vals }); throw FAILED; }
      return v;
    }
    case 0x0b: { // optional
      const fp = r.pos; const ip = fp + Number(r.i64());
      if (v === undefined) return undefined;
      const rr = new R(r.b); rr.pos = ip; return validate(rr, v, c);
    }
    case 0x0c: { // nullable
      const fp = r.pos; const ip = fp + Number(r.i64());
      if (v === null) return null;
      const rr = new R(r.b); rr.pos = ip; return validate(rr, v, c);
    }
    case 0x23: { // nonoptional
      const fp = r.pos; const ip = fp + Number(r.i64());
      if (v === undefined) { pushIssue(c, "invalid_type", { expected: "nonoptional", received: "undefined" }); throw FAILED; }
      const rr = new R(r.b); rr.pos = ip; return validate(rr, v, c);
    }
    case 0x0d: { // default — layout: inneroff | tagged value
      const fp = r.pos; const ip = fp + Number(r.i64());
      const dv = decodeValue(r, c.hosts);
      if (v === undefined) return dv;
      const rr = new R(r.b); rr.pos = ip; return validate(rr, v, c);
    }
    case 0x0e: { // catch — same layout
      const fp = r.pos; const ip = fp + Number(r.i64());
      const cv = decodeValue(r, c.hosts);
      const rr = new R(r.b); rr.pos = ip;
      const save = c.issues.length;
      const res = tryValidate(rr, v, c);
      if (res.ok) return res.value;
      c.issues.length = save;
      return cv;
    }
    case 0x0f: { // refine — layout: inneroff | cbid
      const fp = r.pos; const ip = fp + Number(r.i64()); const id = Number(r.u64());
      const rr = new R(r.b); rr.pos = ip;
      const inner = validate(rr, v, c);
      let ok = false;
      try { ok = !!reg.refine[id](inner); } catch (e) { c.pendingThrow = e; }
      if (!ok) { pushIssue(c, "custom", {}); throw FAILED; }
      return inner;
    }
    case 0x10: { // transform — layout: inneroff | cbid
      const fp = r.pos; const ip = fp + Number(r.i64()); const id = Number(r.u64());
      const rr = new R(r.b); rr.pos = ip;
      const inner = validate(rr, v, c);
      try { return reg.transform[id](inner); } catch (e) { c.pendingThrow = e; throw FAILED; }
    }
    case 0x11: { // pipe
      const fi = r.pos; const ip = fi + Number(r.i64());
      const fo = r.pos; const opos = fo + Number(r.i64());
      const rr = new R(r.b); rr.pos = ip;
      const mark = c.issues.length;
      let mid: any;
      try {
        mid = validate(rr, v, c);
      } catch (err) {
        // the out stage never ran — tag in's issues non-continuing so the
        // boundary judges the payload aborted
        for (let j = mark; j < c.issues.length; j++) (c.issues[j] as any)._nc = true;
        throw err;
      }
      const rr2 = new R(r.b); rr2.pos = opos;
      return validate(rr2, mid, c);
    }
    case 0x12: { // intersection
      const fl = r.pos; const lp = fl + Number(r.i64());
      const fr = r.pos; const rp = fr + Number(r.i64());
      const save = c.issues.length;
      const rl = tryValidate(new R(r.b, lp), v, c);
      const rr = tryValidate(new R(r.b, rp), v, c);
      if (!rl.ok || !rr.ok) throw FAILED;
      c.issues.length = save;
      const a = rl.value, b = rr.value;
      if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
        return { ...(a as object), ...(b as object) };
      }
      if (Array.isArray(a) && Array.isArray(b)) return a;
      if (literalEq(a, b)) return a;
      pushIssue(c, "invalid_intersection_results", {});
      throw FAILED;
    }
    case 0x13: { // tuple
      const n = Number(r.u64());
      const ips: number[] = [];
      for (let i = 0; i < n; i++) { const fp = r.pos; ips.push(fp + Number(r.i64())); }
      const rf = r.pos; const restRel = r.i64(); const restPos = rf + Number(restRel);
      const minItems = Number(r.u64());
      const optoutStart = Number(r.u64());
      const items = Array.isArray(v) ? v : null;
      if (!items) { pushIssue(c, "invalid_type", { expected: "tuple", received: typeName(v) }); throw FAILED; }
      const before = c.issues.length;
      if (restRel === 0n && (items.length < minItems || items.length > n)) {
        // zod: arity mismatch emits a non-exact size issue; under-length skips
        // element validation, over-length still validates the fixed slots
        sizeFail(c, items.length < minItems ? "too_small" : "too_big", "array",
          BigInt(items.length < minItems ? minItems : n), true, false, undefined, true);
        (c.issues[c.issues.length - 1] as any)._arity = true;
        if (items.length < minItems) throw FAILED;
      }
      // absent fixed slots still get validated as undefined: catch fills them,
      // optional accepts them
      const eff = restRel !== 0n ? Math.max(items.length, n) : n;
      const results: { ok: boolean; value: unknown }[] = [];
      for (let i = 0; i < eff; i++) {
        const res = atKey(c, i, () =>
          tryValidate(new R(r.b, i < n ? ips[i] : restPos) as any, i < items.length ? items[i] : undefined, c));
        results.push(res as any);
      }
      if (c.issues.length !== before) throw FAILED;
      const outLen = Math.max(Math.min(items.length, eff), optoutStart);
      const out: unknown[] = [];
      for (let i = 0; i < outLen; i++)
        out[i] = results[i]!.ok ? results[i]!.value : (i < items.length ? items[i] : undefined);
      return out;
    }
    case 0x14: { // record
      const fk = r.pos; const kp = fk + Number(r.i64());
      const fv = r.pos; const vp = fv + Number(r.i64());
      if (typeof v !== "object" || v === null || Array.isArray(v) || !isPlain(v)) {
        pushIssue(c, "invalid_type", { expected: "record", received: typeName(v) }); throw FAILED;
      }
      const before = c.issues.length;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        const save = c.issues.length;
        if (kp !== fk) { // key schema present (kp==fk only if offset 0 — actually check)
          const rr = new R(r.b); rr.pos = kp;
          const kr = tryValidate(rr, k, c);
          if (!kr.ok) {
            const inner = c.issues.splice(save);
            atKey(c, k, () => pushIssue(c, "invalid_key", { origin: "record", issues: inner }));
            continue;
          }
          c.issues.length = save;
        }
        const res = atKey(c, k, () => tryValidate(new R(r.b, vp), (v as any)[k], c));
        if (res.ok) out[k] = res.value;
      }
      if (c.issues.length !== before) throw FAILED;
      return out;
    }
    case 0x15: return v; // any/unknown
    case 0x16: pushIssue(c, "invalid_type", { expected: "never", received: typeName(v) }); throw FAILED;
    case 0x17: if (v === null) return null; pushIssue(c, "invalid_type", { expected: "null", received: typeName(v) }); throw FAILED;
    case 0x18: if (v === undefined) return undefined; pushIssue(c, "invalid_type", { expected: "undefined", received: typeName(v) }); throw FAILED;
    case 0x19: if (typeof v === "number" && Number.isNaN(v)) return v; pushIssue(c, "invalid_type", { expected: "nan", received: typeName(v) }); throw FAILED;
    case 0x1a: { // lazy — reg returns a compiled blob
      const id = Number(r.u64());
      const blob = reg.lazy[id]();
      const rr = new R(blob);
      return validate(rr, v, c);
    }
    case 0x1b: { // instanceof
      const id = Number(r.u64()); const nl = Number(r.u64()); const name = r.str(nl);
      const Ctor = reg.ctor[id];
      if (!(v instanceof Ctor)) { pushIssue(c, "invalid_type", { expected: name, received: typeName(v) }); throw FAILED; }
      return v;
    }
    case 0x1c: return coerceTo(r, v, c, 1); // string
    case 0x1d: return coerceTo(r, v, c, 2); // number
    case 0x1e: return coerceTo(r, v, c, 3); // boolean
    case 0x1f: return coerceTo(r, v, c, 4); // bigint
    case 0x20: { // date
      const t = v instanceof Date ? v.getTime() : NaN;
      if (!(v instanceof Date) || Number.isNaN(t)) {
        // zod: NaN-time Date carries received:"Invalid Date" (message shows "Date")
        pushIssue(c, "invalid_type", {
          expected: "date",
          received: v instanceof Date ? "Invalid Date" : typeName(v),
        });
        throw FAILED;
      }
      const nc = r.u8();
      let fail = false;
      for (let i = 0; i < nc; i++) {
        const kind = r.u8(); const msg = msgOf(r); const p = r.f64();
        if (kind === 1 && t < p) { pushIssue(c, "too_small", { type: "date", minimum: p, inclusive: true, ...(msg ? { message: msg } : {}) }); fail = true; }
        if (kind === 2 && t > p) { pushIssue(c, "too_big", { type: "date", maximum: p, inclusive: true, ...(msg ? { message: msg } : {}) }); fail = true; }
      }
      if (fail) throw FAILED;
      return v;
    }
    case 0x21: { // symbol
      if (typeof v !== "symbol") { pushIssue(c, "invalid_type", { expected: "symbol", received: typeName(v) }); throw FAILED; }
      return v;
    }
    case 0x24: { // map — [koff i64][voff i64]; issues at path [key]
      const kp = r.pos; const kpos = kp + Number(r.i64());
      const vp = r.pos; const vpos = vp + Number(r.i64());
      if (!(v instanceof Map)) { pushIssue(c, "invalid_type", { expected: "map", received: typeName(v) }); throw FAILED; }
      const out = new Map();
      const before = c.issues.length;
      for (const [k, vv] of v as Map<unknown, unknown>) {
        const kr = atKey(c, k as string | number, () => tryValidate(new R(r.b, kpos), k, c));
        const vr = atKey(c, k as string | number, () => tryValidate(new R(r.b, vpos), vv, c));
        if (kr.ok && vr.ok) out.set(kr.value, vr.value);
      }
      if (c.issues.length !== before) throw FAILED;
      return out;
    }
    case 0x25: { // set — [voff i64]; element issues at path []
      const vp = r.pos; const vpos = vp + Number(r.i64());
      if (!(v instanceof Set)) { pushIssue(c, "invalid_type", { expected: "set", received: typeName(v) }); throw FAILED; }
      const out = new Set();
      const before = c.issues.length;
      for (const vv of v as Set<unknown>) {
        const res = tryValidate(new R(r.b, vpos), vv, c);
        if (res.ok) out.add(res.value);
      }
      if (c.issues.length !== before) throw FAILED;
      return out;
    }
    case 0x22: { // custom
      const id = Number(r.u64()); const msg = msgOf(r);
      let ok = false;
      try { ok = reg.custom[id](v); } catch (e) { c.pendingThrow = e; }
      if (!ok) { pushIssue(c, "custom", msg ? { message: msg } : {}); throw FAILED; }
      return v;
    }
    default:
      throw new Error(`asmzod: bad opcode 0x${op.toString(16)} at ${node}`);
  }
}

const FAILED = Symbol("asmzod.fail");

// validate that swallows FAILED — used for union arms, catch, intersect
function tryValidate(r: R, v: unknown, c: Ctx): { ok: true; value: unknown } | { ok: false } {
  const save = c.issues.length;
  try {
    const out = validate(r, v, c);
    return { ok: true, value: out };
  } catch (e) {
    if (e === FAILED) return { ok: false };
    throw e;
  }
}

function literalEq(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") return a === b;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
  }
  return a === b;
}

function isPlain(v: object): boolean {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

// coerce hostref/primitive -> target primitive, then validate inner node
function coerceTo(r: R, v: unknown, c: Ctx, target: 1 | 2 | 3 | 4): unknown {
  const fp = r.pos; const ip = fp + Number(r.i64());
  let out: unknown;
  try {
    if (target === 1) out = typeof v === "symbol" ? (() => { throw new Error("no") })() : String(v);
    else if (target === 2) out = Number(v);
    else if (target === 3) out = Boolean(v);
    else out = BigInt(v as any);
  } catch { throw FAILED; }
  if (target === 2 && typeof out === "number" && Number.isNaN(out)) {
    // Number(symbol/bigint-garbage) can throw; NaN falls through to inner
    // which emits invalid_type — same as the asm path
  }
  const rr = new R(r.b); rr.pos = ip;
  return validate(rr, out, c);
}

// export the raw issue codes the shared normalizer expects
export { TYPE_FAIL_CODES };
