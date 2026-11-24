// schema.ts — schema classes + chaining API (zod3-compatible surface)
import { compile, type Compiled } from "./bytecode.ts";
import { engineParse, portableEngineParse, reg, regId } from "./ffi.ts";
import * as napiBackend from "./native/napi.ts";
import { parsedTypeName, defaultMessage, applyErrorMaps, finalizeIssueTree, failure, captureStackTrace, stripInternalFrames, globalConfig, defaultedIssues, globalRegistry, ZodRegistry } from "./shared.ts";
import { encodeValue, type HostTable } from "./codec.ts";
import { ZodError, ZodRealError, ZodEncodeError, type ZodIssue } from "./error.ts";
import { msgFns, paramMsg, ensureDefaultMemoizer, NEVER, _addIssueCtx, FORMAT_PATTERNS, FORMAT_NOPAT, _isoRe, _isoTimeSrc } from "./shared.ts";

// issues added via ctx.addIssue inside superRefine callbacks during the
// in-flight engine run; _run splices them over the engine's `custom` slots
const pendingRefineIssues: any[] = [];

// async check support: the engine is synchronous, so callbacks that
// return thenables can't complete inside it. In async mode, ZodEffects
// stages queue here and safeParseAsync replays them sequentially —
// transforms rewrite a moving value, refines gate on it.
let asyncMode = false;
// validate() walks with abort-early semantics — the first issue stops the
// container walk (between children, never inside one)
let earlyAbort = false;
const pendingAsync: { type: string; fn: (v: unknown, ctx?: any) => unknown; msg?: string; cbid?: number; ipath?: any[] }[] = [];
// the per-call parse ctx — catch callbacks finalize their issues against it
let RUN_CTX: any;
// zod's $ZodCatchCtx: the inner payload spread, with value/input pinned to
// the data the catch was handed and a finalized mirror in `error`
function _catchCtx(data: unknown, issues: any[], aborted: boolean, ctx?: any) {
  return {
    issues,
    aborted,
    value: data,
    input: data,
    error: { issues: issues.map((i: any) => finalizeIssueTree(i, ctx ?? RUN_CTX, globalConfig)) },
  };
}

// ——— cyclic-data memoizer (port of zod's core/memoizer.ts) ———
export class ZodCyclicError extends Error {
  constructor() {
    super("Cannot parse a reference cycle that closes through a transform");
    this.name = "ZodCyclicError";
  }
}
interface _MemoEntry { value: unknown; issues: any[] | null }
// per top-level parse call — keyed on schema then input object
let MEMO: { buckets: WeakMap<any, WeakMap<object, _MemoEntry>>; backEdges?: WeakSet<object> } | undefined;

const _REC_NONE = 0, _REC_ASSUMED = 1, _REC_PROVEN = 2;
const _recCache = new WeakMap<object, boolean>();

// whether this schema's subtree contains a reference cycle; same answer
// lattice as zod — unresolvable getter edges count as ASSUMED, never cached
const _isSchema = (c: any): boolean => c instanceof ZodType || c?._zod?.def !== undefined;

function _isRecWalk(inst: any, stack: Set<object>, resolve: boolean): number {
  const cached = _recCache.get(inst);
  if (cached !== undefined) return cached ? _REC_PROVEN : _REC_NONE;
  if (stack.has(inst)) return _REC_PROVEN;
  stack.add(inst);
  let result = _REC_NONE;
  const check = (c: any) => {
    if (result !== _REC_PROVEN && _isSchema(c)) {
      const a = _isRecWalk(c, stack, resolve);
      if (a > result) result = a;
    }
  };
  const shapeWalk = (sh: object, spread: boolean): number => {
    let a = _REC_NONE;
    for (const key of Reflect.ownKeys(sh)) {
      const desc = Object.getOwnPropertyDescriptor(sh, key)!;
      if (spread && !desc.enumerable) continue;
      // a getter mints a fresh subtree per read — can't follow, count as cycle
      const c = desc.get ? _REC_ASSUMED
        : _isSchema(desc.value) ? _isRecWalk(desc.value, stack, resolve) : _REC_NONE;
      if (c > a) a = c;
    }
    return a;
  };
  const merge = (a: number) => { if (a > result) result = a; };
  const d = inst._def ?? inst._zod?.def ?? {};
  switch (d.type) {
    case "object": {
      merge(shapeWalk(d.shape ?? {}, true));
      check(d.catchall);
      break;
    }
    case "array": check(d.element); break;
    case "tuple": for (const el of d.items ?? []) check(el); check(d.rest); break;
    case "record": case "map": check(d.keyType); check(d.valueType); break;
    case "set": check(d.valueType); break;
    case "union": case "discunion": case "discriminatedUnion": case "xor":
      for (const el of d.options ?? []) check(el);
      break;
    case "intersect": case "intersection": check(d.left); check(d.right); break;
    case "optional": case "nullable": case "default": case "prefault":
    case "catch": case "readonly": case "nonoptional": case "promise":
    case "success": case "effects": case "transform": case "refine": case "superrefine":
      check(d.inner);
      break;
    case "pipe": case "codec": check(d.in); check(d.out); break;
    case "function": check(d.input); check(d.output); break;
    case "lazy": {
      // a resolved lazy edge is followed exactly once, with resolution off
      const inner = d._cachedInner ?? (resolve ? (d._cachedInner = d.getter?.()) : undefined);
      merge(inner ? _isRecWalk(inner, stack, false) : _REC_ASSUMED);
      break;
    }
    default: {
      // unknown kinds: scan data-own def values for child schemas
      for (const key in d) {
        const desc = Object.getOwnPropertyDescriptor(d, key);
        if (!desc || desc.get) continue;
        const v = desc.value;
        if (_isSchema(v)) check(v);
        else if (Array.isArray(v)) for (const el of v) check(el);
      }
    }
  }
  stack.delete(inst);
  if (result !== _REC_ASSUMED) _recCache.set(inst, result === _REC_PROVEN);
  return result;
}

function _cloneIssues(iss: any[]): any[] {
  return iss.map((i) => (i.path ? { ...i, path: i.path.slice() } : { ...i }));
}
// schema-graph walk for JS-callback effect nodes — the engines can't host
// them, and zod still runs each node's own checks on a best-effort payload
// when children fail, so any container holding them runs at TS level
const _FX_KINDS = new Set(["transform", "refine", "superrefine"]);
const _fxCache = new WeakMap<object, boolean>();
function _hasFxWalk(inst: any, stack: Set<any>): boolean {
  if (inst == null || (typeof inst !== "object" && typeof inst !== "function")) return false;
  if (stack.has(inst)) return false;
  const cached = _fxCache.get(inst);
  if (cached !== undefined) return cached;
  stack.add(inst);
  let hit = false;
  const d = inst._def ?? inst._zod?.def ?? {};
  const kind = d.kind ?? d.type;
  if (_FX_KINDS.has(kind) && typeof d.fn === "function") hit = true;
  // function schemas implement() their payload in JS — no engine opcode
  if (!hit && d.type === "function") hit = true;
  if (!hit) {
    const see = (v: any): boolean => _isSchema(v) && _hasFxWalk(v, stack);
    const seeList = (v: any): boolean => Array.isArray(v) && v.some(see);
    for (const key in d) {
      const desc = Object.getOwnPropertyDescriptor(d, key);
      if (!desc) continue;
      let v: any;
      if (desc.get) {
        // def-level accessors (shape maps etc) resolve cached structures —
        // safe to read. Deferred FIELD getters live on the resolved shape and
        // can construct fresh schema graphs per call — never invoke those.
        try { v = d[key]; } catch { hit = true; break; }
      } else v = desc.value;
      // raw function props (catchValue/defaultValue thunks, transforms) need
      // the TS runner — registered cbids are the engine's callback channel
      if (typeof v === "function") { hit = true; break; }
      if (see(v) || seeList(v)) { hit = true; break; }
      if (v && typeof v === "object" && !Array.isArray(v) && !_isSchema(v)) {
        for (const sk of Reflect.ownKeys(v)) {
          const sd = Object.getOwnPropertyDescriptor(v, sk);
          if (!sd || !sd.enumerable) continue;
          // a deferred field MIGHT hide effects — assume so; the runtime
          // resolves it and dispatches correctly
          if (sd.get) { hit = true; break; }
          if (see(sd.value) || seeList(sd.value)) { hit = true; break; }
        }
      }
      if (hit) break;
    }
    // JS-effect check records (tx/checkfn/fn payloads) live inside defs, not
    // as schema children — the walk needs an explicit look
    if (!hit && Array.isArray(d.checks))
      hit = d.checks.some((c: any) => c && (typeof c === "function" || c.kind === "tx" || c.kind === "checkfn" || typeof c.tx === "function" || typeof c.fn === "function" || (c.kind === "includes" && c.position !== undefined)));
    if (!hit && d.type === "lazy") hit = d._cachedInner ? see(d._cachedInner) : true;
  }
  stack.delete(inst);
  _fxCache.set(inst, hit);
  return hit;
}

// zod's public variant — resolves deferred edges on the walk path
export function isRecursiveSchema(inst: any): boolean {
  return _isRecWalk(inst, new Set(), true) !== _REC_NONE;
}

function _memoBucket(sch: any): WeakMap<object, _MemoEntry> {
  let b = MEMO!.buckets.get(sch);
  if (!b) { b = new WeakMap(); MEMO!.buckets.set(sch, b); }
  return b;
}
// replay a completed entry or hand back the in-flight container
function _memoHit(e: _MemoEntry): any {
  if (e.issues === null) {
    (MEMO!.backEdges ??= new WeakSet()).add(e.value as object);
    return { ok: true as const, value: e.value, memo: true };
  }
  return e.issues.length
    ? { ok: false as const, issues: _cloneIssues(e.issues) }
    : { ok: true as const, value: e.value };
}
const _isRef = (v: unknown): v is object => v !== null && typeof v === "object";
// wraps a container's run: hit → replay/back-edge, miss → pre-alloc + fill
function _memoRun(sch: any, data: unknown, empty: () => any, run: (out: any) => any): any {
  const hit = _memoBucket(sch).get(data as object);
  if (hit) return _memoHit(hit);
  const out = empty();
  const entry: _MemoEntry = { value: out, issues: null };
  _memoBucket(sch).set(data as object, entry);
  const r = run(out);
  entry.issues = r.ok ? [] : _cloneIssues(r.issues ?? []);
  return r;
}
const isThenable = (v: unknown): v is Promise<unknown> =>
  !!v && typeof (v as any).then === "function";
export class AsyncCheckError extends Error {
  constructor() { super("Encountered Promise during synchronous parse. Use .parseAsync() instead."); }
}
// engine-invoked cb wrapper: a thenable result means the check is async
// and the engine cannot queue it (nested position) — match zod's sync error
function guardAsync<F extends (v: any) => any>(fn: F): F {
  return ((v: unknown) => {
    const r = fn(v);
    if (isThenable(r)) throw new AsyncCheckError();
    return r;
  }) as F;
}

export type ParsePath = (string | number)[];
export interface SafeParseSuccess<T> { success: true; data: T }
export interface SafeParseFail { success: false; error: ZodError }
export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseFail;

// ---------- _zod internals (zod v4 internals surface) ----------
const _optResolving = new WeakSet<object>();
function _inner(s: any): any { const d = s._def ?? s._zod?.def; return d?.inner ?? d?.innerType ?? (s.schema ?? undefined); }
function _zodOptin(s: any): any {
  const t = s._def.type;
  const inner = _inner(s);
  switch (t) {
    case "optional": case "exactOptional": case "catch":
      return inner?._zod?.optin === "defaulted" ? "defaulted" : "optional";
    case "default": case "prefault": return "defaulted";
    case "transform": return s instanceof ZodTransform ? "optional" : inner?._zod?.optin;
    case "refine": case "superrefine": case "custom": return inner?._zod?.optin;
    case "pipe": return s._def.prefault ? "defaulted" : s._def.in?._zod?.optin;
    case "codec": return s._def.in?._zod?.optin;
    case "union": case "discunion": case "discriminatedUnion": {
      const os: any[] = s._def.options ?? [];
      return os.some((o) => o._zod.optin === "defaulted") ? "defaulted"
        : os.some((o) => o._zod.optin === "optional") ? "optional" : undefined;
    }
    case "nullable": case "readonly": case "brand": return inner?._zod?.optin;
    case "lazy": {
      if (_optResolving.has(s)) return undefined;
      _optResolving.add(s);
      try { return inner?._zod?.optin; } finally { _optResolving.delete(s); }
    }
    case "nonoptional": return undefined;
    default: return undefined;
  }
}
function _zodOptout(s: any): any {
  const t = s._def.type;
  const inner = _inner(s);
  switch (t) {
    case "optional": case "exactOptional": return "optional";
    case "catch": return inner?._zod?.optout;
    case "transform": return undefined;
    case "refine": case "superrefine": case "custom": return inner?._zod?.optout;
    case "pipe": return s._def.out?._zod?.optout;
    case "codec": return s._def.out?._zod?.optout;
    case "union": case "discunion": case "discriminatedUnion": {
      const os: any[] = s._def.options ?? [];
      return os.some((o) => o._zod.optout === "optional") ? "optional" : undefined;
    }
    case "nullable": case "readonly": case "brand": return inner?._zod?.optout;
    case "lazy": {
      if (_optResolving.has(s)) return undefined;
      _optResolving.add(s);
      try { return inner?._zod?.optout; } finally { _optResolving.delete(s); }
    }
    default: return undefined;
  }
}
function _zodValues(s: any): any {
  const t = s._def.type;
  const inner = _inner(s);
  switch (t) {
    case "enum": case "nativeEnum": return new Set(s._def.values);
    case "literal":
      return new Set(s._def.values ?? (Array.isArray(s._def.value) ? s._def.value : [s._def.value]));
    case "undefined": return new Set([undefined]);
    case "null": return new Set([null]);
    case "optional": {
      const v = inner?._zod?.values;
      return v ? new Set([...v, undefined]) : undefined;
    }
    case "nullable": {
      const v = inner?._zod?.values;
      return v ? new Set([...v, null]) : undefined;
    }
    case "exactOptional": case "default": case "prefault":
    case "catch": case "readonly": case "brand":
      return inner?._zod?.values;
    case "transform": case "refine": case "superrefine":
      return inner?._zod?.values;
    case "pipe": return (s._def.prefault ? s._def.out : s._def.in)?._zod?.values;
    case "codec": return s._def.in?._zod?.values;
    case "lazy": {
      if (_valResolving.has(s)) return undefined;
      _valResolving.add(s);
      try { return inner?._zod?.values; } finally { _valResolving.delete(s); }
    }
    case "nonoptional": {
      const v = inner?._zod?.values;
      return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
    }
    case "union": case "discunion": case "discriminatedUnion": {
      const os: any[] = s._def.options ?? [];
      const vs = os.map((o) => o._zod.values);
      if (vs.some((v) => v === undefined)) return undefined;
      return new Set(vs.flatMap((v: any) => [...v]));
    }
    default: return undefined;
  }
}
const _valResolving = new WeakSet<object>();
const _pvResolving = new WeakSet<object>();
// per-key discriminator candidate sets — only shape-bearing schemas have
// propValues; wrappers defer inward the same way zod's _zod.def chain does
function _zodPropValues(s: any): any {
  if (_pvResolving.has(s)) return undefined;
  _pvResolving.add(s);
  try { return _propValuesInner(s, new Set<object>()); } finally { _pvResolving.delete(s); }
}
function _propValuesInner(s: any, seen: Set<object>): any {
  let cur: any = s;
  while (cur) {
    const d = cur._def;
    if (!d) return undefined;
    if (d.shape !== undefined) {
      const pv: Record<string, Set<any>> = Object.create(null);
      for (const key of Object.keys(d.shape)) {
        const f = d.shape[key];
        const vals = f?._zod?.values;
        if (vals) {
          const set = (pv[key] ??= new Set<any>());
          for (const v of vals) set.add(v);
          // an omittable slot reads back as undefined at discriminator lookup
          if (f._zod?.optin !== undefined) set.add(undefined);
        }
      }
      return pv;
    }
    if (d.type === "discunion" || d.type === "discriminatedUnion") {
      const pv: Record<string, Set<any>> = Object.create(null);
      let undefinedCount = 0;
      const opts: any[] = d.options ?? [];
      for (let i = 0; i < opts.length; i++) {
        const opv = _zodPropValues(opts[i]);
        if (!opv || Object.keys(opv).length === 0)
          throw new Error(`Invalid discriminated union option at index "${i}"`);
        if (Object.prototype.hasOwnProperty.call(opv, d.discriminator) && opv[d.discriminator].has(undefined)) undefinedCount++;
        for (const [k, vs] of Object.entries(opv)) {
          const set = (pv[k] ??= new Set<any>());
          for (const v of vs as Set<any>) set.add(v);
        }
      }
      if (!d.unionFallback && undefinedCount > 1 && Object.prototype.hasOwnProperty.call(pv, d.discriminator)) pv[d.discriminator].delete(undefined);
      return pv;
    }
    const inner = d.inner ?? (d.prefault ? d.out : d.in);
    if (inner) { cur = inner; continue; }
    if (d.getter) {
      if (seen.has(cur)) return undefined;
      seen.add(cur);
      cur = cur.schema;
      continue;
    }
    return undefined;
  }
  return undefined;
}
const _escapeRe = (v: any) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// zod's format validators as JS predicates — records with `fn` never compile
// to engine opcodes, so every runtime agrees on these semantics
const _uuidRe = (v?: number) => v === undefined
  ? /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/
  : new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${v}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);

const _isValidB64 = (data: string): boolean => {
  if (data === "") return true;
  if (/\s/.test(data)) return false;
  if (data.length % 4 !== 0) return false;
  try { atob(data); return true; } catch { return false; }
};

const _isValidB64Url = (data: string): boolean => {
  if (!/^[A-Za-z0-9_-]*$/.test(data)) return false;
  const b64 = data.replace(/[-_]/g, (c) => (c === "-" ? "+" : "/"));
  return _isValidB64(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
};

const _isValidJWT = (token: string, alg?: string | null): boolean => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[0]) return false;
    const header = JSON.parse(atob(parts[0]));
    if ("typ" in header && header?.typ !== "JWT") return false;
    if (!header.alg) return false;
    if (alg && header.alg !== alg) return false;
    return true;
  } catch { return false; }
};

const _canParseURL = (s: string): boolean => {
  try {
    if (typeof URL !== "undefined" && typeof (URL as any).canParse === "function") return (URL as any).canParse(s);
    new URL(s); return true;
  } catch { return false; }
};

const _HTTP_PROTO = /^https?$/;
const _urlCheck = (def: any) => (v: any): true | string | any[] | false => {
  if (typeof v !== "string") return false;
  const trimmed = v.trim();
  const none = def.normalize === undefined && def.hostname === undefined && def.protocol === undefined;
  const issues: any[] = [];
  if (none) {
    if (!_canParseURL(trimmed)) return [{ code: "invalid_format", format: "url", input: v }];
    return trimmed.replace(/[\t\n\r]/g, "");
  }
  let url: URL | 1 | 2;
  if (!def.normalize && def.protocol?.source === _HTTP_PROTO.source && !/^https?:\/\//i.test(trimmed)) url = 1;
  else {
    try {
      const U: any = URL;
      url = typeof U.parse === "function" ? (U.parse(trimmed) ?? 2) : new U(trimmed);
    } catch { url = 2; }
  }
  if (url === 1) return [{ code: "invalid_format", format: "url", note: "Invalid URL format", input: v }];
  if (url === 2) return [{ code: "invalid_format", format: "url", input: v }];
  const u = url as URL;
  if (def.hostname) { def.hostname.lastIndex = 0; if (!def.hostname.test(u.hostname)) issues.push({ code: "invalid_format", format: "url", note: "Invalid hostname", pattern: def.hostname.source, input: v }); }
  if (def.protocol) { def.protocol.lastIndex = 0; const proto = u.protocol.endsWith(":") ? u.protocol.slice(0, -1) : u.protocol; if (!def.protocol.test(proto)) issues.push({ code: "invalid_format", format: "url", note: "Invalid protocol", pattern: def.protocol.source, input: v }); }
  return issues.length ? issues : (def.normalize ? u.href : trimmed.replace(/[\t\n\r]/g, ""));
};

const FMT_FNS: Record<string, (c: any) => (v: any) => any> = {
  email: () => { const re = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/; return (s) => typeof s !== "string" || re.test(s); },
  uuid: (c) => { const re = _uuidRe(c.version); return (s) => typeof s !== "string" || re.test(s); },
  guid: () => { const re = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/; return (s) => typeof s !== "string" || re.test(s); },
  nanoid: (c) => { const re = new RegExp(`^[a-zA-Z0-9_-]{${c.length ?? 21}}$`); return (s) => typeof s !== "string" || re.test(s); },
  cuid: () => { const re = /^[cC][0-9a-z]{6,}$/; return (s) => typeof s !== "string" || re.test(s); },
  cuid2: () => { const re = /^[0-9a-z]+$/; return (s) => typeof s !== "string" || re.test(s); },
  ulid: () => { const re = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/; return (s) => typeof s !== "string" || re.test(s); },
  xid: () => { const re = /^[0-9a-vA-V]{20}$/; return (s) => typeof s !== "string" || re.test(s); },
  ksuid: () => { const re = /^[A-Za-z0-9]{27}$/; return (s) => typeof s !== "string" || re.test(s); },
  e164: () => { const re = /^\+[1-9]\d{6,14}$/; return (s) => typeof s !== "string" || re.test(s); },
  base64: () => (s) => typeof s !== "string" || _isValidB64(s),
  base64url: () => (s) => typeof s !== "string" || _isValidB64Url(s),
  jwt: (c) => (s) => typeof s !== "string" || _isValidJWT(s, c.alg ?? null),
  url: (c) => _urlCheck(c),
  httpurl: (c) => _urlCheck({ ...c, protocol: _HTTP_PROTO }),
  ipv6: () => (s) => typeof s !== "string" || (/^[0-9a-fA-F:.]+$/.test(s) && _canParseURL(`http://[${s}]`)),
  mac: (c) => { const d = String(c.delimiter ?? ":").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const re = new RegExp(`^(?:[0-9A-F]{2}${d}){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}${d}){5}[0-9a-f]{2}$`); return (s) => typeof s !== "string" || re.test(s); },
  datetime: (c) => { const re = _isoRe.datetime({ local: c.local, offset: c.offset, precision: c.precision }); c.pat = re; return (s) => typeof s !== "string" || re.test(s); },
  datestr: (c) => { c.fmt = "date"; c.pat = _isoRe.date; return (s) => typeof s !== "string" || _isoRe.date.test(s); },
  timestr: (c) => { c.fmt = "time"; const re = _isoRe.time({ precision: c.precision }); c.pat = re; return (s) => typeof s !== "string" || re.test(s); },
};

const _cleanRe = (src: string): string =>
  src.slice(src.startsWith("^") ? 1 : 0, src.endsWith("$") ? src.length - 1 : undefined);

// template-literal pattern sources for formats kept out of FORMAT_PATTERNS
// (zod hides `pattern` on these issues but still derives them for parts)
const TL_PATTERNS: Record<string, RegExp> = {
  ipv6: /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/,
  cidrv4: /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/,
  cidrv6: /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,
  mac: /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/,
  guid: /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  xid: /^[0-9a-vA-V]{20}$/,
  ksuid: /^[A-Za-z0-9]{27}$/,
  e164: /^\+[1-9]\d{6,14}$/,
  base64: /^[0-9a-zA-Z+/]*={0,2}$/,
  base64url: /^[A-Za-z0-9_-]*$/,
  hex: /^[0-9a-fA-F]*$/,
};

// zod's leafPattern: format/check patterns beat bounds, bounds beat the
// type default — check records carry `regex`/`value` where zod's carry
// `pattern`/`minimum`/`maximum`/`length`
function _zodLeafPattern(s: any): RegExp | undefined {
  const d = s._def;
  let pattern: RegExp | undefined = d.pattern;
  let isInt = !!d.format?.includes("int");
  let minimum: number | undefined, maximum: number | undefined;
  const fmtRe = (k: any): RegExp | undefined => {
    if (typeof k !== "string") return undefined;
    if (TL_PATTERNS[k]) return TL_PATTERNS[k];
    const src = FORMAT_PATTERNS[k];
    const m = src?.match(/^\/(.*)\/([a-z]*)$/s);
    return m ? new RegExp(m[1], m[2]) : undefined;
  };
  if (!pattern && typeof d.format === "string") pattern = fmtRe(d.format);
  for (const c of d.checks ?? []) {
    if (c.pattern instanceof RegExp) pattern = c.pattern;
    else if (c.regex) pattern = c.regex;
    else if (c.kind === "startsWith") pattern = new RegExp(`^${_escapeRe(c.value)}.*`);
    else if (c.kind === "endsWith") pattern = new RegExp(`.*${_escapeRe(c.value)}$`);
    else if (c.kind === "includes")
      pattern = new RegExp(typeof c.position === "number" ? `^.{${c.position},}${_escapeRe(c.value)}` : _escapeRe(c.value));
    else if (!pattern) pattern = fmtRe(c.kind);
    isInt ||= !!c.format?.includes("int") || c.kind === "int" || c.kind === "safeInt";
    const lo = c.kind === "min" || c.kind === "length" ? c.value : c.minimum;
    const hi = c.kind === "max" || c.kind === "length" ? c.value : c.maximum;
    if (lo !== undefined && (minimum === undefined || lo > minimum)) minimum = lo;
    if (hi !== undefined && (maximum === undefined || hi < maximum)) maximum = hi;
  }
  if (pattern) return pattern;
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) return /(?!)/;
  if (minimum !== undefined || maximum !== undefined)
    return new RegExp(`^[\\s\\S]{${minimum ?? 0},${maximum ?? ""}}$`);
  if (d.type === "number") return isInt ? /^-?\d+$/ : /^-?\d+(?:\.\d+)?$/;
  return undefined;
}

// zod's partPattern lattice: each type answers its own pattern; wrappers
// delegate to their inner, unions fold options into an alternation
export function _zodPattern(s: any): RegExp | undefined {
  const d = s?._def;
  if (!d) return undefined;
  switch (d.type) {
    case "string": return _zodLeafPattern(s) ?? /^[\s\S]{0,}$/;
    case "number": return _zodLeafPattern(s) ?? /^-?\d+(?:\.\d+)?$/;
    case "bigint": return /^-?\d+n?$/;
    case "boolean": return /^(?:true|false)$/i;
    case "null": return /^null$/i;
    case "undefined": return /^undefined$/i;
    case "literal": {
      const vs = d.values ?? (Array.isArray(d.value) ? d.value : [d.value]);
      return new RegExp(vs.length
        ? `^(${vs.map((o: any) => o === undefined ? "undefined" : _escapeRe(`${o}`)).join("|")})$`
        : "^[^\\s\\S]$");
    }
    case "enum": {
      const vals: any[] = (d.values ?? Object.values(d.entries ?? {}))
        .filter((k: any) => ["string", "number", "symbol"].includes(typeof k));
      return new RegExp(vals.length
        ? `^(${vals.map((v: any) => _escapeRe(`${v}`)).join("|")})$`
        : "^[^\\s\\S]$");
    }
    case "optional": {
      const p = _zodPattern(_inner(s));
      return p ? new RegExp(`^(${_cleanRe(p.source)})?$`) : undefined;
    }
    case "exactOptional": return _zodPattern(_inner(s));
    case "nullable": {
      const p = _zodPattern(_inner(s));
      return p ? new RegExp(`^(${_cleanRe(p.source)}|null)$`) : undefined;
    }
    case "union": case "discriminatedUnion": {
      const ps = (d.options ?? []).map(_zodPattern);
      return ps.every(Boolean)
        ? new RegExp(`^(${ps.map((p: any) => _cleanRe(p.source)).join("|")})$`)
        : undefined;
    }
    case "template_literal": return d.pattern;
    case "lazy": return _zodPattern(d.getter?.() ?? d._cachedInner);
    default: { const inn = _inner(s); return inn ? _zodPattern(inn) : undefined; }
  }
}

// zod's check params: {error, message, path, params, abort} — error and
// message can't coexist; a bare string is the message; a bare fn is error
function _checkParams(p: any): any {
  if (p == null) return {};
  if (typeof p === "string") return { message: p };
  if (typeof p === "function") return { error: p };
  if (typeof p !== "object") return {};
  if (p.error !== undefined && p.message !== undefined)
    throw new Error("Cannot use both 'error' and 'message' params in a check");
  return {
    error: typeof p.error === "string" || typeof p.error === "function" ? p.error : p.error?.message,
    message: paramMsg(p.message),
    path: Array.isArray(p.path) ? p.path : undefined,
    params: p.params,
    abort: p.abort,
    when: typeof p.when === "function" ? p.when : undefined,
  };
}

function _pathGet(data: any, path: any[] | undefined): any {
  let v = data;
  for (const p of path ?? []) {
    if (v == null) return undefined;
    const k = p && typeof p === "object" && "key" in p ? p.key : p;
    v = v[k as any];
  }
  return v;
}

// engine/flat issues carry no inst — the owner resolves by walking the schema
// def along the issue path; unions/intersections are ambiguous → keep `cur`.
// wrappers delegate their parse to the inner schema in zod, so the owner is
// the innermost non-wrapper along the path
const _OWNER_WRAP = new Set([
  "optional", "exactoptional", "nullable", "nonoptional", "default", "catch",
  "prefault", "readonly", "lazy", "refine", "transform", "branded",
]);
function _ownerInner(s: any): any {
  const d = s?._def;
  if (!d || !_OWNER_WRAP.has(d.type)) return s;
  const inner = d.inner ?? (typeof d.getter === "function" ? d.getter() : undefined);
  return inner === undefined ? s : _ownerInner(inner);
}

// check-originated issues carry a zod-style check instance — a `$ZodCheck*`
// trait makes finalizeIssue defer to a pre-stamped `schema` instead of
// overwriting it with inst, and the class name mirrors zod's check classes
const _CHECK_CLS = new Map<string, any>();
function _checkClsName(c: any): string {
  switch (c?.kind) {
    case "min": return "$ZodCheckMinLength";
    case "max": return "$ZodCheckMaxLength";
    case "length": return "$ZodCheckLengthEquals";
    case "size":
      return c.exact !== undefined ? "$ZodCheckSizeEquals"
        : c.min !== undefined ? "$ZodCheckMinSize" : "$ZodCheckMaxSize";
    case "multipleOf": return "$ZodCheckMultipleOf";
    case "gt": case "gte": return "$ZodCheckGreaterThan";
    case "lt": case "lte": return "$ZodCheckLessThan";
    case "int": case "safeInt": case "finite": return "$ZodCheckNumberFormat";
    case "regex": return "$ZodCheckRegex";
    case "includes": return "$ZodCheckIncludes";
    case "startsWith": return "$ZodCheckStartsWith";
    case "endsWith": return "$ZodCheckEndsWith";
    case "mime": return "$ZodCheckMimeType";
    case "lowercase": return "$ZodCheckLowerCase";
    case "uppercase": return "$ZodCheckUpperCase";
    case "checkfn": case "schemacheck": case "refine": case "superrefine":
    case "meta": return "$ZodCheck";
    case "tx": case "transform": return "$ZodCheckOverwrite";
    case "property": return "$ZodCheckProperty";
    case "properties": return "$ZodCheckProperties";
    default: return "$ZodCheckStringFormat";
  }
}
function _checkInst(c: any): any {
  const name = _checkClsName(c);
  let cls = _CHECK_CLS.get(name);
  if (!cls) {
    cls = new Function(`return class ${name} {}`)();
    _CHECK_CLS.set(name, cls);
  }
  const inst = new cls();
  inst._zod = { def: c, traits: new Set(["$ZodCheck"]) };
  return inst;
}

// which check record in `d.checks` produced this flat issue — bounds and
// format names disambiguate; returns undefined for schema-originated codes
function _checkOwner(d: any, i: any): any {
  const checks = d?.checks;
  if (!Array.isArray(checks) || !i) return undefined;
  for (const c of checks) {
    if (!c || typeof c !== "object") continue;
    const k = c.kind;
    const bound = c.value ?? c.min ?? c.exact ?? c.max;
    if (i.code === "too_small" && (k === "min" || k === "gte" || k === "length" || k === "size") && bound === i.minimum) return c;
    if (i.code === "too_big" && (k === "max" || k === "lte" || k === "length" || k === "size") && bound === i.maximum) return c;
    if (i.code === "invalid_format" && (c.fmt === i.format || c.format === i.format || k === i.format)) return c;
    if (i.code === "not_multiple_of" && k === "multipleOf" && c.value === i.divisor) return c;
    if (i.code === "custom" && (k === "checkfn" || k === "refine" || k === "superrefine" || k === "schemacheck")) return c;
  }
  return undefined;
}

// a pipe/codec at path end is ambiguous — the flat path can't say which side
// emitted; check-record match decides, then expected-type match, else `in`
function _ownerFinal(s: any, i: any): any {
  const d = s?._def;
  if (!d || (d.type !== "pipe" && d.type !== "codec")) return s;
  const out = _ownerInner(d.out), inn = _ownerInner(d.in);
  if (_checkOwner(out?._def, i)) return _ownerFinal(out, i);
  if (_checkOwner(inn?._def, i)) return _ownerFinal(inn, i);
  if (i?.expected === out?._def?.type) return _ownerFinal(out, i);
  return _ownerFinal(inn, i);
}

function _ownerAtPath(root: any, i: any): any {
  const path = i?.path;
  let cur = _ownerInner(root);
  if (!Array.isArray(path)) return _ownerFinal(cur, i);
  for (const seg of path) {
    const d = cur?._def;
    if (!d) return cur;
    let next: any;
    switch (d.type) {
      case "object": next = d.shape?.[seg]; break;
      case "array": next = d.element; break;
      case "tuple": next = d.items?.[seg] ?? d.rest; break;
      case "record": case "map": case "set": next = d.valueType; break;
      case "pipe": case "codec": next = d.out; break;
      case "union": case "discunion": case "xor": case "intersection": return cur;
      default: next = d.inner ?? (typeof d.getter === "function" ? d.getter() : undefined);
    }
    if (!next) return cur;
    cur = _ownerInner(next);
  }
  return _ownerFinal(cur, i);
}

function _stampTree(i: any, inst: any, data: any): void {
  if (i.inst === undefined) {
    const owner = _ownerAtPath(inst, i);
    const chk = _checkOwner(owner?._def, i);
    if (chk) {
      i.inst = _checkInst(chk);
      i.schema ??= owner;
    } else i.inst = owner;
  }
  if (!("input" in i)) i.input = _pathGet(data, i.path);
  if (Array.isArray(i.errors))
    for (const a of i.errors) for (const j of a) _stampTree(j, inst, data);
  if (Array.isArray(i.issues))
    for (const j of i.issues) _stampTree(j, inst, data);
}

function _stampIss(r: any, inst: any, data?: any): void {
  if (r && !r.ok && r.issues) for (const i of r.issues) _stampTree(i, inst, data);
}

const _ctxFrom = (params: any, async_: boolean): any =>
  params ? { ...params, async: async_, error: params.error ?? (typeof params === "function" ? params : undefined) }
       : { async: async_ };

// MEMO-scoped sync run — parse and safeParse share it
function _runScoped(schema: any, value: unknown, ctx?: any): any {
  const prev = MEMO;
  const prevCtx = RUN_CTX;
  MEMO = { buckets: new WeakMap() };
  RUN_CTX = ctx;
  try { return schema._run(value); } finally { MEMO = prev; RUN_CTX = prevCtx; }
}

export const _parse = (Err: any) => {
  const fn = (schema: any, value: unknown, _ctx?: any, _params?: any) => {
    const ctx = _ctxFrom(_ctx, false);
    const r = _runScoped(schema, value, ctx);
    if (!r.ok) {
      const e = new (_params?.Err ?? Err)(r.issues.map((i: any) => finalizeIssueTree(i, ctx, globalConfig)));
      captureStackTrace(e, _params?.callee ?? fn); stripInternalFrames(e);
      throw e;
    }
    return r.value;
  };
  return fn;
};

export const _safeParse = (Err: any) => (schema: any, value: unknown, _ctx?: any) => {
  const ctx = _ctxFrom(_ctx, false);
  const r = _runScoped(schema, value, ctx);
  return r.ok ? { success: true, data: r.value } : failure(Err, r.issues, ctx);
};

export const _parseAsync = (Err: any) => {
  const fn = async (schema: any, value: unknown, _ctx?: any, _params?: any) => {
    const ctx = _ctxFrom(_ctx, true);
    let r = schema._runAsyncScoped(value, ctx);
    if (r instanceof Promise) r = await r;
    if (!r.ok) {
      const e = new (_params?.Err ?? Err)(r.issues.map((i: any) => finalizeIssueTree(i, ctx, globalConfig)));
      captureStackTrace(e, _params?.callee ?? fn); stripInternalFrames(e);
      throw e;
    }
    return r.value;
  };
  return fn;
};

export const _safeParseAsync = (Err: any) => async (schema: any, value: unknown, _ctx?: any) => {
  const ctx = _ctxFrom(_ctx, true);
  let r = schema._runAsyncScoped(value, ctx);
  if (r instanceof Promise) r = await r;
  return r.ok ? { success: true, data: r.value } : failure(Err, r.issues, ctx);
};

// encode family — the backward traversal; errors get the callee-stripped
// stack of whichever entry raised them, resuppressed safeParse errors included
export const _mkEncode = (Err: any) => {
  const fn = (schema: any, value: unknown, _ctx?: any, _params?: any) => {
    try {
      const r = _encodeScoped(schema, value);
      if (isThenable(r)) throw new AsyncCheckError();
      return r;
    } catch (e: any) {
      if (e instanceof Error) captureStackTrace(e, _params?.callee ?? fn); stripInternalFrames(e);
      throw e;
    }
  };
  return fn;
};

export const _mkEncodeAsync = (Err: any) => {
  const fn = async (schema: any, value: unknown, _ctx?: any, _params?: any) => {
    try {
      let r = _encodeScoped(schema, value);
      if (r instanceof Promise) r = await r;
      return r;
    } catch (e: any) {
      if (e instanceof Error) captureStackTrace(e, _params?.callee ?? fn); stripInternalFrames(e);
      throw e;
    }
  };
  return fn;
};

export const _mkSafeEncode = (Err: any) => (schema: any, value: unknown, _ctx?: any) => {
  try {
    return { success: true as const, data: _encodeScoped(schema, value) };
  } catch (e: any) {
    const issues = e?.issues ? e.issues : [{ code: "custom", path: [], message: String(e?.message ?? e), input: value }];
    return failure(Err, issues, _ctxFrom(_ctx, false));
  }
};

export const _mkSafeEncodeAsync = (Err: any) => async (schema: any, value: unknown, _ctx?: any) => {
  try {
    return { success: true as const, data: await _encodeScoped(schema, value) };
  } catch (e: any) {
    const issues = e?.issues ? e.issues : [{ code: "custom", path: [], message: String(e?.message ?? e), input: value }];
    return failure(Err, issues, _ctxFrom(_ctx, true));
  }
};

export const _decode = _parse;
export const _decodeAsync = _parseAsync;
export const _safeDecode = _safeParse;
export const _safeDecodeAsync = _safeParseAsync;

const _boundKeys = new WeakMap<object, string[]>();

export abstract class ZodType<Output = unknown, Input = Output> {
  readonly _output!: Output;
  readonly _input!: Input;
  // $ZodType.init — installs the _zod internals a $constructor-built class
  // needs; the TS-level _run shim drives custom parses through it
  static init(inst: any, def: any) {
    inst._zod = {
      def,
      traits: new Set([inst.constructor]),
      run: (payload: any, ctx: any) => inst._zod.parse(payload, ctx),
      parse: (payload: any) => payload,
    };
  }
  __def: any;
  // inner/innerType alias the same child — zod's clone writes innerType, our
  // builders write inner; whichever side arrives wins and the other syncs
  get _def(): any { return this.__def; }
  set _def(v: any) {
    if (v && typeof v === "object") {
      if (v.innerType !== undefined) v.inner = v.innerType;
      else if (v.inner !== undefined) v.innerType = v.inner;
    }
    this.__def = v;
  }
  __zod: any;
  private _rec: boolean | undefined;
  private _recChecked = false;
  constructor() {
    ensureDefaultMemoizer();
    // English registers lazily on first schema construction (zod#5953)
    globalConfig.localeError ??= defaultMessage;
    // zod's $constructor binds every proto method onto each instance —
    // detached `schema.parse`/`schema.optional` keeps `this` (zod#5870)
    const proto = Object.getPrototypeOf(this);
    let keys = _boundKeys.get(proto);
    if (!keys) {
      keys = [];
      let p: any = proto;
      while (p && p !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(p)) {
          if (k === "constructor") continue;
          const desc = Object.getOwnPropertyDescriptor(p, k);
          if (desc?.value !== undefined && typeof desc.value === "function") keys.push(k);
        }
        p = Object.getPrototypeOf(p);
      }
      _boundKeys.set(proto, keys);
    }
    for (const k of keys) (this as any)[k] = (this as any)[k].bind(this);
  }

  protected _hasFx(): boolean { return _hasFxWalk(this, new Set()); }

  // latched recursion check — ASSUMED answers count as recursive for the
  // current parse without being cached, matching zod's memoizer latch
  protected _isRec(): boolean {
    if (this._rec !== undefined) return this._rec;
    const w = _isRecWalk(this, new Set(), false);
    if (w === _REC_NONE) { this._rec = false; return false; }
    if (w === _REC_PROVEN || this._recChecked) this._rec = true;
    else this._recChecked = true;
    return true;
  }

  get _zod(): any {
    let z = this.__zod;
    if (z) return z;
    const t = this;
    z = {
      // _def normalized into zod's public def vocabulary: coerce_* reports
      // as the base type and default/prefault expose defaultValue
      get def() {
        const d = t._def;
        if (z.__zdef && z.__zdef.__src === d) return z.__zdef;
        const tname = (d?.type ?? "").startsWith("coerce_")
          ? ({ coerce_str: "string", coerce_num: "number", coerce_bool: "boolean", coerce_bigint: "bigint" } as any)[d.type]
          : d?.type;
        const out = (tname === d?.type && d?.type !== "default" && d?.type !== "prefault")
          ? d
          : { ...d, type: tname,
              get defaultValue() {
                const raw = d.defaultValue !== undefined ? d.defaultValue : d.value;
                return typeof raw === "function" ? raw() : raw;
              } };
        Object.defineProperty(out, "__src", { value: d, enumerable: false });
        z.__zdef = out;
        return out;
      },
      set def(v: any) { t._def = v; z.__zdef = undefined; },
      constr: (this as any).constructor,
      traits: new Set([(this as any).constructor]),
      parent: this._def.parent,
      get innerType() { return _inner(t); },
      bag: { ...(this._def.bag ?? {}) },
      deferred: this._def.deferred,
      // payload-shaped like zod's internals: {value, issues} in, mutated back
      run: (payload: any, _ctx?: any) => {
        const r = this._run(payload.value);
        payload.value = r.ok ? r.value : payload.value;
        if ((r as any).issues) payload.issues.push(...(r as any).issues);
        if ((r as any).memo) payload.memo = true;
        return payload;
      },
      parse: (payload: any, ctx?: any) => this._zod.run(payload, ctx),
      toJSONSchema: undefined,
      check: (...args: any[]) => (this as any).check(...args),
    };
    // lazy like zod's defineLazyInternal — recursive schemas resolve these on
    // demand, not while the internals object is being constructed
    const lazyProps: Record<string, () => any> = {
      optin: () => _zodOptin(this),
      optout: () => _zodOptout(this),
      values: () => _zodValues(this),
      pattern: () => _zodPattern(this),
      propValues: () => _zodPropValues(this),
    };
    for (const [k, fn] of Object.entries(lazyProps)) {
      let cached = false, val: any;
      Object.defineProperty(z, k, {
        enumerable: true, configurable: true,
        get: () => { if (!cached) { val = fn(); cached = true; } return val; },
      });
    }
    this.__zod = z;
    // visit() can graft real-zod nodes into our defs — wrap them on contact.
    // Runs after __zod is cached: shape getters may re-enter _zod via merge
    const d0 = this._def;
    if (d0 && typeof d0 === "object") {
      for (const k of ["inner", "innerType", "element", "rest", "in", "out",
                       "left", "right", "catchall", "keyType", "valueType",
                       "input", "output", "schema"])
        if (d0[k] != null) d0[k] = _norm(d0[k]);
      for (const k of ["items", "options"])
        if (Array.isArray(d0[k])) { const a = d0[k]; for (let i = 0; i < a.length; i++) a[i] = _norm(a[i]); }
      const sh = d0.shape;
      if (sh && typeof sh === "object") for (const k of Object.keys(sh)) {
        const desc = Object.getOwnPropertyDescriptor(sh, k);
        if (!desc || !("value" in desc)) continue; // deferred prop — getters stay lazy
        const m = _norm(desc.value);
        if (m !== desc.value) Object.defineProperty(sh, k, { ...desc, value: m });
      }
    }
    return z;
  }

  private _compiled: Compiled | null = null;

  protected _compile(): Compiled {
    return (this._compiled ??= compile(this));
  }

  protected _run(data: unknown): { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] } {
    void this._zod; // materialize internals + normalize foreign def children
    const r = this._runImpl(data) as any;
    _stampIss(r, this, data);
    return r;
  }
  protected _runImpl(data: unknown): { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] } {
    const _checks = (this._def as any).checks as any[] | undefined;
    if (_checks?.some((c) => c && (typeof c === "function" || c.kind === "tx" || c.kind === "checkfn" || c.kind === "schemacheck" || c.kind === "size" || typeof c.fn === "function" || (c.kind === "includes" && c.position !== undefined) || (c.kind === "regex" && c.format !== undefined && c.format !== "regex"))))
      return this._runChecksTS(data, _checks);
    const c = this._compile();
    // direct N-API validation walks the JS value natively (no encode/decode);
    // null -> schema needs the encoded engine path (callbacks, unions, ...)
    const nr = napiBackend.parse(c.blob, data, c.hosts, c.cbUnsafe);
    // the encoded engine needs its own hosts array — encodeValue appends
    const hosts: HostTable | undefined = nr === null ? [...c.hosts] : undefined;
    // a bigint hostref in hosts means encodeValue met an out-of-i64 value —
    // the FFI engine can't inspect it, so that input runs the portable engine
    const enc = nr === null ? encodeValue(data, hosts!) : undefined;
    const r = nr ?? (hosts!.some((v) => typeof v === "bigint")
      ? portableEngineParse(c.blob, enc!, hosts!)
      : engineParse(c.blob, enc!, hosts!));
    // `_u`-tagged invalid_union issues (union nodes reached inside containers)
    // get their per-option errors by re-running the registered options on the
    // value at the issue's path
    if (!r.ok) {
      // aborted is judged on the raw issue set — `_nc` (payload-level size
      // issues like tuple arity) counts before it is stripped
      let aborted = isAborted(r.issues);
      // `_u`-tagged invalid_union issues re-run their registered options on the
      // value at the issue's path: exactly one non-aborted option (all issues
      // from continue:true checks) surfaces its issues in place of the union
      // issue; otherwise the union issue carries per-option errors arrays
      const out: ZodIssue[] = [];
      let spliced = false;
      for (const i of r.issues) {
        delete (i as any)._nc;
        if (i.code === "invalid_union" && (i as any)._u !== undefined &&
            (i as any).errors === undefined) {
          const u = (c.unions as any[])[(i as any)._u];
          delete (i as any)._u;
          if (u) {
            let v: any = data;
            for (const p of i.path ?? []) v = v?.[p as any];
            const runs = (u._def.options as ZodTypeAny[]).map((o) => o._run(v));
            const cands = runs.filter(
              (x): x is { ok: false; issues: ZodIssue[] } =>
                !x.ok && !((x as any).aborted ?? isAborted(x.issues)));
            if (cands.length === 1) {
              spliced = true;
              for (const iss of cands[0].issues)
                out.push({ ...iss, path: [...(i.path ?? []), ...(iss.path ?? [])] });
              continue;
            }
            // zod field order: errors directly after code
            const { code: _c, ...rest } = i as any;
            const rebuilt: any = { code: _c, errors: runs.map((x) => (x.ok ? [] : x.issues)) };
            for (const k of Object.keys(rest)) rebuilt[k] = rest[k];
            out.push(rebuilt);
            continue;
          }
        }
        if ((i as any)._u !== undefined) delete (i as any)._u;
        out.push(i);
      }
      r.issues = out;
      if (spliced) aborted = isAborted(r.issues);
      (r as any).aborted = aborted;
    }
    // superRefine issues pushed by refine callbacks during this run replace the
    // engine's generic `custom` placeholder issues, in order
    if (!r.ok && pendingRefineIssues.length) {
      const extra = pendingRefineIssues.splice(0);
      const out: ZodIssue[] = [];
      for (const i of r.issues) {
        if (i.code === "custom" && extra.length) {
          const st = extra.shift()!;
          const { path: sp, ...rest } = st;
          out.push({ ...rest, path: [...(i.path ?? []), ...(sp ?? [])] } as ZodIssue);
          continue;
        }
        out.push(i);
      }
      while (extra.length) out.push(extra.shift()!);
      return { ok: false, issues: out };
    }
    pendingRefineIssues.length = 0;
    return r;
  }

  // def.checks containing JS-effect records (overwrite `tx`, `checkfn` payload
  // fns) can't compile — zod runs checks positionally on the payload, so the
  // TS path walks them in order: compilable records through a single-check
  // sibling, tx rewriting the value in place, fns pushing issues
  protected _runChecksTS(data: unknown, checks: any[], baseResult?: any, carrier?: any): { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] } {
    const Base = (carrier?.constructor ?? this.constructor) as any;
    const carrierDef = carrier?._def ?? this._def;
    // zod's array flow: checks evaluate on the payload before elements walk —
    // a rewriting check (tx) changes what the size bounds see, so when tx
    // records exist the bounds leave the engine node and evaluate here, in
    // check order, on the rewritten value
    if (carrierDef.type === "array" && checks.some((c) => c?.kind === "tx") &&
        (carrierDef.minLen !== undefined || carrierDef.maxLen !== undefined || carrierDef.exactLen !== undefined)) {
      const { minLen, maxLen, exactLen } = carrierDef;
      const sized = [...checks, { kind: "_arrsize", minLen, maxLen, exactLen, _minMsg: carrierDef._minMsg, _maxMsg: carrierDef._maxMsg }];
      const stripped = new Base({ ...carrierDef, checks: [], minLen: undefined, maxLen: undefined, exactLen: undefined });
      (stripped as any).__synth = true;
      const r2 = baseResult ?? stripped._run(data);
      return this._runChecksTS(data, sized, r2, stripped);
    }
    const base = baseResult ? undefined : new Base({ ...carrierDef, checks: [] });
    if (base) (base as any).__synth = true;
    const r = baseResult ?? (base as any)._run(data);
    // zod: a failed base implicitly aborts the payload — only `when`-gated
    // checks still evaluate (length/size bounds on values carrying the field)
    let v = r.ok ? r.value : data;
    const issues: ZodIssue[] = r.ok ? [] : [...r.issues];
    // the checkless base stands in for this schema — zod has no synthetic, so
    // issues it emitted attribute to the carrier, not the stand-in
    for (const i of issues) if ((i as any).inst?.__synth === true) (i as any).inst = this;
    const whenOK = (c: any): boolean => {
      if (c?.kind === "min" || c?.kind === "max" || c?.kind === "length")
        return v != null && (v as any).length !== undefined;
      if (c?.kind === "size") return v != null && (v as any).size !== undefined;
      return false;
    };
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i];
      if (!r.ok && !whenOK(c)) continue;
      // `when` gates the record against the payload, checked at run time
      if (typeof c?.when === "function" && c.when({ value: v, issues }) === false) continue;
      if (typeof c === "function" || c.kind === "checkfn") {
        const fn = typeof c === "function" ? c : c.fn;
        const payload = { value: v, issues: [] as any[] };
        const pr = fn(payload);
        if (isThenable(pr)) {
          if (!asyncMode) throw new AsyncCheckError();
          pendingAsync.push({ type: "checkchain", checks: checks.slice(i + 1), ctor: Base, def: carrierDef, tx: pr, pre: issues.splice(0), inst: this } as any);
          return { ok: true as const, value: v };
        }
        issues.push(...payload.issues);
        continue;
      }
      if (c.kind === "tx") {
        const nv = c.tx(v);
        if (isThenable(nv)) {
          if (!asyncMode) throw new AsyncCheckError();
          pendingAsync.push({ type: "checkchain", checks: checks.slice(i + 1), ctor: Base, def: carrierDef, tx: nv, pre: issues.splice(0), inst: this } as any);
          return { ok: true as const, value: v };
        }
        v = nv;
        continue;
      }
      // array bounds deferred behind a rewriting check — evaluated on the
      // rewritten payload, in check order; a too_big here is an ordinary
      // (continuable) check failure since the rewrite ended the gate
      if (c.kind === "_arrsize") {
        const len = Array.isArray(v) ? v.length : undefined;
        const emit = (code: string, lim: number, exact: boolean, msg?: string) => issues.push({
          code, origin: "array", [code === "too_small" ? "minimum" : "maximum"]: lim,
          inclusive: true, exact, path: [],
          message: msg ?? `Too ${code === "too_small" ? "small" : "big"}: expected array to have ${code === "too_small" ? ">=" : "<="}${lim} items`,
        });
        if (len !== undefined) {
          if (c.exactLen !== undefined && len !== c.exactLen) emit(len < c.exactLen ? "too_small" : "too_big", c.exactLen, true, c._minMsg);
          else {
            if (c.minLen !== undefined && len < c.minLen) emit("too_small", c.minLen, false, c._minMsg);
            if (c.maxLen !== undefined && len > c.maxLen) emit("too_big", c.maxLen, false, c._maxMsg);
          }
        }
        continue;
      }
      // pipe-side refine records — a boolean gate on the moving value, emitted
      // as a `custom` issue; these never compile to engine opcodes
      if (c.kind === "refine" && typeof c.fn === "function") {
        const nv = c.fn(v);
        if (isThenable(nv)) {
          if (!asyncMode) throw new AsyncCheckError();
          pendingAsync.push({ type: "checkchain", checks: checks.slice(i + 1), ctor: Base, def: carrierDef,
            tx: Promise.resolve(nv).then((ok) => (ok ? v : { __azRefine: c })),
            pre: issues.splice(0), inst: this } as any);
          return { ok: true as const, value: v };
        }
        if (nv === false) {
          const i: any = { code: "custom", input: v, path: [] };
          const e = c.error ?? c.message;
          if (e !== undefined) i.message = typeof e === "function" ? e(i) : e;
          if (c.abort === true) i.continue = false;
          issues.push(i);
          if (c.abort === true) break;
        }
        continue;
      }
      // format records carrying a JS predicate (url/jwt/base64/uuid-version/
      // nanoid-length…) — zod's real semantics live in the function, so the
      // check never compiles to an engine opcode
      if (typeof c.fn === "function") {
        // string-format checks are guarded upstream in zod — non-strings skip
        if (typeof v !== "string") continue;
        const nv = c.fn(v);
        if (Array.isArray(nv)) {
          for (const i of nv) if (i.message === undefined && c.message !== undefined) { i.path ??= []; i.message = c.message; }
          issues.push(...nv);
        }
        else if (nv === false)
          issues.push({ ...(FORMAT_NOPAT.has(c.fmt ?? c.kind) ? {} : { origin: "string" }),
                        code: "invalid_format", format: c.fmt ?? c.kind,
                        ...(!FORMAT_NOPAT.has(c.fmt ?? c.kind) && (c.pat || FORMAT_PATTERNS[c.fmt ?? c.kind])
                              ? { pattern: c.pat ? `/${c.pat.source}/` : FORMAT_PATTERNS[c.fmt ?? c.kind] } : {}),
                        input: v, path: [], message: c.message } as any);
        else if (typeof nv === "string") v = nv;
        continue;
      }
      // a schema passed to .check runs as a check — whole-schema validation
      // against the payload, keeping this schema's class (getters survive)
      if (c.kind === "schemacheck") {
        const rr = (c.schema as any)._run(v);
        if (!rr.ok) issues.push(...rr.issues);
        else v = rr.value;
        continue;
      }
      // set/map cardinality bounds — too_big already fired as an entry-parse
      // precheck in _runImpl; only the lower side lands here
      if (c.kind === "size") {
        const n = (v as any)?.size;
        if (typeof n === "number") {
          const origin = v instanceof Set ? "set" : "map";
          const lo = c.exact ?? c.min;
          if (lo !== undefined && n < lo)
            issues.push({ code: "too_small", origin, minimum: lo, inclusive: true,
              ...(c.exact !== undefined ? { exact: true } : {}), path: [], message: c.message } as any);
        }
        continue;
      }
      // a named format (z.stringFormat("creditCard", re)) emits
      // invalid_format under its own name — no pattern, message via error
      if (c.format !== undefined && c.format !== c.kind && c.regex) {
        if (typeof v !== "string") continue;
        c.regex.lastIndex = 0;
        if (!c.regex.test(v)) {
          const i: any = c.format === "template_literal"
            ? { code: "invalid_format", format: c.format, pattern: c.regex.source }
            : (c.customFmt === true || FORMAT_NOPAT.has(c.format))
              ? { code: "invalid_format", format: c.format }
              : { origin: "string", code: "invalid_format", format: c.format,
                  pattern: `/${c.regex.source}/${c.regex.flags}` };
          i.input = v;
          i.path = [];
          const e = c.error ?? c.message;
          if (e !== undefined) i.message = typeof e === "function" ? e(i) : e;
          if (c.abort === true) i.continue = false;
          issues.push(i);
          if (c.abort === true) break;
        }
        continue;
      }
      // a positioned `includes` never compiles — the engines' substring check
      // is position-agnostic, so it runs here like a format check
      if (c.kind === "includes" && c.position !== undefined) {
        if (typeof v !== "string" || !v.includes(c.value, c.position))
          issues.push({ origin: "string", code: "invalid_format", format: "includes",
                        includes: c.value, input: v, path: [], message: c.message } as any);
        continue;
      }
      const rr = new Base({ ...carrierDef, checks: [c] })._run(v);
      // a failed base already emitted invalid_type — the check run repeats it
      if (!rr.ok) {
        const mine = r.ok ? rr.issues : rr.issues.filter((i: any) => i.code !== "invalid_type");
        for (const i of mine) {
          // check-originated: inst is the check, schema the carrier — otherwise
          // finalizeIssue rewrites schema to the synthetic base
          (i as any).inst = _checkInst(c);
          (i as any).schema ??= this;
          if (c.error !== undefined) (i as any).message = typeof c.error === "function" ? c.error(i) : c.error;
          if (c.abort === true) (i as any).continue = false;
        }
        issues.push(...mine);
        if (c.abort === true) break;
      }
      else v = rr.value;
    }
    return issues.length
      ? { ok: false as const, issues, value: v, aborted: isAborted(issues) } as any
      : { ok: true as const, value: v };
  }

  parse(data: unknown, params?: any): Output {
    return _parse(ZodRealError)(this, data, params, { callee: ZodType.prototype.parse });
  }

  safeParse(data: unknown, params?: any): SafeParseResult<Output> {
    return _safeParse(ZodRealError)(this, data, params);
  }

  async parseAsync(data: unknown, params?: any): Promise<Output> {
    return await _parseAsync(ZodRealError)(this, data, params, { callee: ZodType.prototype.parseAsync });
  }

  decode(data: unknown, params?: any): any {
    return _decode(ZodRealError)(this, data, params, { callee: ZodType.prototype.decode });
  }
  encode(data: unknown, params?: any): any {
    return _mkEncode(ZodRealError)(this, data, params, { callee: ZodType.prototype.encode });
  }
  async decodeAsync(data: unknown, params?: any): Promise<any> {
    return await _decodeAsync(ZodRealError)(this, data, params, { callee: ZodType.prototype.decodeAsync });
  }
  async encodeAsync(data: unknown, params?: any): Promise<any> {
    return await _mkEncodeAsync(ZodRealError)(this, data, params, { callee: ZodType.prototype.encodeAsync });
  }
  /** zod's wrapper unwrap — the single inner schema, undefined elsewhere */
  unwrap(): any { return (this._def as any).inner ?? (this._def as any).innerType; }

  optional(): ZodOptional<this> {
    return new ZodOptional({ type: "optional", inner: this });
  }
  /** optional in objects but rejects explicit undefined */
  exactOptional(): ZodOptional<this> {
    return new ZodExactOptional({ type: "exactOptional", inner: this });
  }
  nullable(): ZodNullable<this> {
    return new ZodNullable({ type: "nullable", inner: this });
  }
  nullish(): ZodOptional<ZodNullable<this>> {
    return this.nullable().optional();
  }
  apply(fn: (s: this, ...args: any[]) => any, ...args: any[]) { return fn(this, ...args); }
  default<V extends Input>(value: V | (() => V)): ZodDefault<this> {
    return new ZodDefault({ type: "default", inner: this, value });
  }
  catch<V extends Input>(value: V | (() => V)): ZodCatch<this> {
    return new ZodCatch({ type: "catch", inner: this, value });
  }
  array(): ZodArray<this> {
    return new ZodArray({ type: "array", element: this });
  }
  or<T extends ZodTypeAny>(option: T): ZodUnion<[this, T]> {
    return new ZodUnion({ type: "union", options: [this, option] });
  }
  and<T extends ZodTypeAny>(right: T): ZodIntersection<this, T> {
    return new ZodIntersection({ type: "intersect", left: this, right });
  }
  refine(fn: (v: Output) => boolean, message?: any): ZodEffects<this, Output> {
    const p = _checkParams(message);
    const def: any = {
      type: "refine", inner: this,
      cbid: regId(reg.refine, guardAsync(fn as (v: unknown) => unknown)),
      fn, kind: "refine", message: p.message, error: p.error,
      path: p.path, params: p.params, abort: p.abort, when: p.when,
    };
    Object.defineProperty(def, "checks", { value: [{ _zod: { def } }], enumerable: false, writable: true, configurable: true });
    return new ZodEffects(def);
  }
  refinement(fn: (v: Output) => boolean, message?: string): ZodEffects<this, Output> {
    return this.refine(fn, message);
  }
  superRefine(fn: (v: Output, ctx: { addIssue: (i: any) => void }) => void, params?: any): ZodEffects<this, Output> {
    const p = _checkParams(params);
    const def: any = {
      type: "refine", inner: this,
      cbid: regId(reg.refine, guardAsync(((v: unknown) => {
        let ok = true;
        fn(v as Output, {
          addIssue: (i: any) => { ok = false; pendingRefineIssues.push(i); },
        });
        return ok;
      }) as (v: unknown) => unknown)),
      fn, kind: "superrefine", message: undefined, when: p.when, abort: p.abort,
      error: p.error, path: p.path, params: p.params,
    };
    Object.defineProperty(def, "checks", { value: [{ _zod: { def } }], enumerable: false, writable: true, configurable: true });
    return new ZodEffects(def);
  }
  transform<N>(fn: (v: Output) => N): ZodPipe<this, ZodTransform> {
    return new ZodPipe({ type: "pipe", in: this, out: new ZodTransform(fn as (v: unknown) => unknown) });
  }
  pipe<T extends ZodTypeAny>(target: T): ZodPipe<this, T> {
    return new ZodPipe({ type: "pipe", in: this, out: target });
  }
  brand<B extends string>(): ZodBranded<this, B> {
    return this as any;
  }
  nonoptional(): ZodNonOptional<this> {
    return new ZodNonOptional({ inner: this });
  }
  clone(): this {
    const c = new (this.constructor as any)({ ...this._def });
    (c as any)._zod.parent = this;
    return c;
  }
  describe(d: string): this {
    const c = this.clone();
    globalRegistry.add(c, { description: d });
    return c;
  }
  meta(m?: any): any {
    if (m === undefined) return globalRegistry.get(this);
    const c = this.clone();
    globalRegistry.add(c, m);
    return c;
  }
  register(registry: any, m?: any): this {
    registry?.add?.(this, m);
    return this;
  }
  check(...args: any[]): any {
    const objs = args.filter((a) => a && typeof a === "object" && typeof a !== "function");
    const fns = args.filter((a) => typeof a === "function");
    let s: any = this;
    if (objs.length) {
      const checks = [...(this._def.checks ?? [])];
      const def: any = { ...this._def, checks };
      for (const o of objs) {
        // a schema passed to .check runs as a check — its whole validation
        // applies to the payload (zod: schemas carry _zod.check too). this
        // covers z.refine()/z.superRefine()/z.iso.* args
        // zod check objects: def is the record, check is the predicate,
        // onattach callbacks write _zod.bag contributions on the clone
        if (o._zod && typeof o._zod === "object" && o._zod.def && o._zod.def.type === undefined) {
          const rec: any = { ...(o._zod.def ?? {}), fn: o._zod.check, _onattach: o._zod.onattach };
          // _zod.check takes the payload ({value, issues}) — route like checkfn
          if (typeof rec.fn === "function" && rec.kind === undefined) rec.kind = "checkfn";
          checks.push(rec);
          continue;
        }
        if (_isSchema(o)) {
          checks.push({ kind: "schemacheck", schema: o });
          continue;
        }
        const c = o._def ?? o;
        if (c.kind === "meta") (def._metaCheck ??= []).push(c);
        else if (c.kind === "checkfn") fns.push(c.fn);
        else checks.push(c);
      }
      s = new (this as any).constructor(def);
      (s as any)._zod.parent = this;
      for (const rec of checks)
        if (rec?._onattach) for (const f of rec._onattach) f(s);
      if (def._metaCheck) {
        (s as any)._zod.parent = this;
        const meta: any = {};
        for (const mc of def._metaCheck) {
          if (mc.description !== undefined) meta.description = mc.description;
          Object.assign(meta, mc.metadata);
        }
        globalRegistry.add(s, meta);
        delete def._metaCheck;
      }
    }
    if (fns.length) s = s.superRefine((v: any, ctx: any) => {
      for (const fn of fns) {
        const payload = { value: v, issues: [] as any[], addIssue: (i: any) => payload.issues.push(i) };
        fn(payload);
        for (const i of payload.issues) ctx.addIssue(i);
      }
    });
    return s;
  }
  with(...args: any[]): any { return this.check(...args); }
  overwrite<N>(fn: (v: Output) => N): this {
    return this.check({ kind: "tx", tx: fn });
  }
  prefault<V extends Input>(value: V | (() => V)): ZodType<Output, Input | undefined> {
    return new ZodPrefault({ type: "prefault", inner: this, value }) as any;
  }
  isOptional(): boolean { return this.safeParse(undefined).success; }
  isNullable(): boolean { return this.safeParse(null).success; }
  get def(): any { return this._def; }
  get type(): string { return this._def.type; }
  get description(): string | undefined {
    return globalRegistry.get(this)?.description ?? this._def.description;
  }
  get "~standard"() {
    const self = this;
    return {
      version: 1 as const, vendor: "zod",
      validate: (v: unknown) => {
        try {
          const r = self.safeParse(v);
          return r.success ? { value: r.data } : { issues: r.error.issues };
        } catch (e) {
          // async-capable schemas validate through the async runner; a sync
          // throw inside a check becomes a rejected promise per the spec
          if (e instanceof AsyncCheckError)
            return self.safeParseAsync(v).then((r) => r.success ? { value: r.data } : { issues: r.error.issues });
          return Promise.reject(e);
        }
      },
      jsonSchema: {
        input: (params?: any) => (self as any).toJSONSchema({ ...params, io: "input" }),
        output: (params?: any) => (self as any).toJSONSchema({ ...params, io: "output" }),
      },
    };
  }
  safeParseAsync(data: unknown, params?: any): Promise<SafeParseResult<Output>> {
    return _safeParseAsync(ZodRealError)(this, data, params);
  }

  validate(data: unknown, params?: any): boolean {
    const prev = earlyAbort;
    earlyAbort = true;
    try { return this.safeParse(data, params).success; }
    finally { earlyAbort = prev; }
  }

  async validateAsync(data: unknown, params?: any): Promise<boolean> {
    return (await this.safeParseAsync(data, params)).success;
  }

  // async run producing a raw {ok,value|issues} result — the public
  // safe/parse variants finalize issues through the lazy-error boundary
  private _runAsyncScoped(data: unknown, ctx?: any): any {
    asyncMode = true;
    pendingAsync.length = 0;
    const prevMemo = MEMO;
    const prevCtx = RUN_CTX;
    MEMO = { buckets: new WeakMap() };
    RUN_CTX = ctx;
    let r: { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] };
    try {
      r = this._run(data);
    } finally {
      asyncMode = false;
      MEMO = prevMemo;
      RUN_CTX = prevCtx;
    }
    if (!pendingAsync.length) return r;
    if (!r.ok) {
      // a failed outer run still owns pending async checks — zod collects
      // their issues alongside the sync ones
      return (async () => {
        const fr = await this._finishAsync("value" in (r as any) ? (r as any).value : data);
        const stageIssues = fr.ok ? [] : fr.issues;
        return { ok: false as const, issues: [...(r as any).issues, ...stageIssues], value: (r as any).value };
      })();
    }
    return this._finishAsync(r.value);
  }
  private async _finishAsync(value: any): Promise<any> {
    // stages can carry a path (record/object children queue nested async
    // checks) — apply them to that position, not the root
    const atPath = (v: any, p: any[] | undefined) => (p?.length ? p.reduce((o, k) => o instanceof Map ? o.get(k) : o?.[k], v) : v);
    const setPath = (v: any, p: any[] | undefined, nv: any) => {
      if (!p?.length) return nv;
      let o = v;
      for (let i = 0; i < p.length - 1; i++) o = o instanceof Map ? o.get(p[i]) : o[p[i]];
      if (o instanceof Map) o.set(p[p.length - 1], nv); else o[p[p.length - 1]] = nv;
      return v;
    };
    // zod collects every failed check's issue — refinements at sibling
    // positions and root-level checks all land in one error
    const runStage = async (st: any, root: any): Promise<{ value: any; issues: any[] }> => {
      const p = st.path as any[] | undefined;
      const cur = st.keyInput !== undefined ? st.keyInput : atPath(root, p);
      if (st.type === "promisegate") {
        // zod: Promise.resolve(payload.value).then(inner) — resolved value
        // becomes the payload at the promise's position
        const resolved = await Promise.resolve(st.input);
        const mark = pendingAsync.length;
        const ir = (st.inner as any)._run(resolved);
        for (let i = mark; i < pendingAsync.length; i++)
          (pendingAsync[i] as any).path = [...(p ?? []), ...((pendingAsync[i] as any).path ?? [])];
        if (!ir.ok) return { value: root, issues: ir.issues };
        return { value: setPath(root, p, ir.value), issues: [] };
      }
      if (st.type === "catchgate") {
        // deferred inner work belongs to a catch — replay it inside the gate;
        // failures get swallowed into the catch value instead of surfacing
        let gval = cur;
        const gIssues: any[] = [];
        for (const sub of st.stages) {
          const sr = await runStage(sub, gval);
          gval = sr.value;
          gIssues.push(...sr.issues);
        }
        const fin = gIssues.length
          ? (typeof st.fn === "function" ? await st.fn(_catchCtx(st.data, gIssues, isAborted(gIssues), st.ctx)) : st.fn)
          : gval;
        return { value: setPath(root, p, fin), issues: [] };
      }
      if (st.type === "checkchain") {
        // a thenable `tx`/payload fn suspended mid-check-chain — resolve it,
        // then finish the remaining checks positionally
        let cv = await st.tx;
        const cIssues: any[] = [...(st.pre ?? [])];
        if (cv != null && typeof cv === "object" && (cv as any).__azRefine) {
          // a suspended pipe-refine resolved false — emit its custom issue
          const rc = (cv as any).__azRefine;
          const i: any = { code: "custom", input: cur, path: p ?? [] };
          const e = rc.error ?? rc.message;
          if (e !== undefined) i.message = typeof e === "function" ? e(i) : e;
          cIssues.push(i);
          if (rc.abort === true) return { value: root, issues: cIssues };
          cv = cur;
        }
        for (const c of st.checks ?? []) {
          if (typeof c === "function" || c?.kind === "checkfn") {
            const fn = typeof c === "function" ? c : c.fn;
            const payload = { value: cv, issues: [] as any[] };
            await fn(payload);
            cIssues.push(...payload.issues);
            continue;
          }
          if (c?.kind === "tx") { cv = await c.tx(cv); continue; }
          const rr = new st.ctor({ ...st.def, checks: [c] })._run(cv);
          if (!rr.ok) cIssues.push(...rr.issues); else cv = rr.value;
        }
        return { value: setPath(root, p, cv), issues: cIssues };
      }
      if (st.type === "pipetail") {
        // `in`'s stages resolved — run the pipe's `out` on the settled value
        const mark = pendingAsync.length;
        const or = (st.out as any)._run(cur);
        for (let i = mark; i < pendingAsync.length; i++)
          (pendingAsync[i] as any).path = [...(p ?? []), ...((pendingAsync[i] as any).path ?? [])];
        if (!or.ok)
          return { value: root, issues: or.issues.map((i: any) => ({ ...i, path: [...(p ?? []), ...(i.path ?? [])] })) };
        let res = or;
        if (st.inst?._def?.checks?.length)
          res = (st.inst as any)._runChecksTS(or.value, st.inst._def.checks, or, st.out);
        if (!res.ok)
          return { value: root, issues: res.issues.map((i: any) => ({ ...i, path: [...(p ?? []), ...(i.path ?? [])] })) };
        return { value: setPath(root, p, res.value), issues: [] };
      }
      if (st.type === "codecout") {
        // async codec transform resolved — run `out`, then codec checks
        const cv = await st.tx;
        if ((cv as any) === NEVER || st.cctx?.issues.length)
          return { value: root,
            issues: (st.cctx?.issues.length ? st.cctx.issues : [{ code: "custom", path: [], message: "Invalid input" }])
              .map((i: any) => ({ ...i, path: [...(p ?? []), ...(i.path ?? [])] })) };
        const mark = pendingAsync.length;
        const or = (st.out as any)._run(cv);
        for (let i = mark; i < pendingAsync.length; i++)
          (pendingAsync[i] as any).path = [...(p ?? []), ...((pendingAsync[i] as any).path ?? [])];
        let res = or;
        if (or.ok && st.inst?._def?.checks?.length) {
          res = (st.inst as any)._runChecksTS(cv, st.inst._def.checks, or, st.inst._def.out);
          for (let i = mark; i < pendingAsync.length; i++)
            (pendingAsync[i] as any).path = [...(p ?? []), ...((pendingAsync[i] as any).path ?? [])];
        }
        if (!res.ok)
          return { value: root, issues: res.issues.map((i: any) => ({ ...i, path: [...(p ?? []), ...(i.path ?? [])] })) };
        return { value: setPath(root, p, res.value), issues: [] };
      }
      if (st.type === "transform") {
        const out = await st.fn(cur);
        const mine = ((st as any).pushed ?? []).map(({ path, ...rest }: any) => ({
          inst: st.inst, schema: st.schema, ...rest, path: [...(p ?? []), ...(path ?? [])],
        }));
        if (out === NEVER || mine.length) return { value: root, issues: mine };
        return { value: setPath(root, p, out), issues: [] };
      }
      if (st.type === "superrefine") {
        const pushed: any[] = [];
        await st.fn(cur, { addIssue: (i: any) => pushed.push(i) });
        return {
          value: root,
          issues: pushed.map(({ path, ...rest }: any) => ({
            ...rest, inst: st.inst, schema: st.schema, path: [...(p ?? []), ...(path ?? [])],
          })),
        };
      }
      if (st.type === "freeze") {
        const v = atPath(root, p);
        if (v !== null && (typeof v === "object" || typeof v === "function")) Object.freeze(v);
        return { value: root, issues: [] };
      }
      const res = await st.fn(cur);
      return res ? { value: root, issues: [] } : {
        value: root,
        issues: [{ code: "custom", path: [...(p ?? []), ...(st.ipath ?? [])], ...(st.msg !== undefined ? { message: st.msg } : {}), inst: st.inst, schema: st.schema } as ZodIssue],
      };
    };
    const allIssues: ZodIssue[] = [];
    // replay IS async context — a transform/outer-run re-entered by pipetail
    // may suspend again; queue its stage instead of throwing AsyncCheckError
    asyncMode = true;
    try {
      for (const st of pendingAsync) {
        const r = await runStage(st, value);
        value = r.value;
        allIssues.push(...r.issues);
      }
    } finally {
      asyncMode = false;
    }
    if (allIssues.length) return { ok: false as const, issues: allIssues };
    return { ok: true as const, value };
  }
  // extension: batch-validate through the addon's in-native loop when
  // available; per-element results like a map of safeParse
  safeParseMany(data: unknown[]): SafeParseResult<Output>[] {
    const c = this._compile();
    const rs = napiBackend.parseMany(c.blob, data, c.hosts, c.cbUnsafe);
    if (rs !== null) {
      return rs.map((r) => {
        if (r.ok) return { success: true as const, data: r.value as Output };
        return { success: false as const, error: new ZodError(r.issues) };
      });
    }
    return data.map((v) => this.safeParse(v));
  }
  parseMany(data: unknown[]): Output[] {
    return this.safeParseMany(data).map((r) => {
      if (!r.success) throw r.error;
      return r.data;
    });
  }
  readonly(): ZodReadonly<this> {
    return new ZodReadonly({ type: "readonly", inner: this });
  }
}

// readonly freezes the parsed payload; async children resolve first — the
// freeze is queued behind their replay so in-place path writes still land
export class ZodReadonly<T extends ZodTypeAny = ZodTypeAny> extends ZodType<T["_output"], T["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  protected override _runImpl(data: unknown) {
    const mark = pendingAsync.length;
    const r = (this._def.inner as any)._run(data);
    if (!r.ok) return r;
    // a memo back-edge is a node still being parsed — freezing it would
    // lock the enclosing object's in-flight payload
    if ((r as any).memo) return r;
    if (asyncMode && pendingAsync.length > mark) {
      pendingAsync.push({ type: "freeze", path: [] } as any);
      return r;
    }
    return { ok: true as const, value: Object.freeze(r.value) };
  }
}

class ZodIssueThrow extends Error {
  issue: any;
  constructor(issue: any) { super(issue.message ?? "invalid"); this.issue = issue; }
}

export type ZodTypeAny = ZodType<any, any>;

// ---------- primitives ----------
export class ZodString extends ZodType<string> {
  constructor(_def: any = { type: "string", checks: [] }) { super(); this._def = _def; }
  private _check(c: any) {
    const mk: any = FMT_FNS[c.kind];
    const rec = mk ? { ...c, fn: mk(c), builtin: true } : c;
    // mk may annotate the record (fmt/pat for JSON Schema + issues)
    if (mk) Object.assign(rec, c);
    return new ZodString({ ...this._def, parent: this, checks: [...this._def.checks, { ...rec, message: paramMsg(rec.message) }] });
  }
  min(n: number, message?: string) { return this._check({ kind: "min", value: n, message }); }
  max(n: number, message?: string) { return this._check({ kind: "max", value: n, message }); }
  length(n: number, message?: string) { return this._check({ kind: "length", value: n, message }); }
  email(message?: string) { return this._check({ kind: "email", message }); }
  url(params?: any) {
    const p = typeof params === "object" && params !== null ? params : {};
    return this._check({ kind: "url", hostname: p.hostname, protocol: p.protocol, normalize: p.normalize,
                         _hasOpts: true, message: p.error ?? p.message ?? (typeof params === "string" ? params : undefined) });
  }
  uuid(params?: any) {
    const p = typeof params === "object" && params !== null ? params : {};
    return this._check({ kind: "uuid", version: p.version, message: p.error ?? p.message ?? (typeof params === "string" ? params : undefined) });
  }
  uuidv4(message?: string) { return this._check({ kind: "uuid", version: 4, message }); }
  ulid(message?: string) { return this._check({ kind: "ulid", message }); }
  nanoid(params?: any) {
    const p = typeof params === "object" && params !== null ? params : {};
    const length = p.length;
    if (length !== undefined && (!Number.isInteger(length) || length <= 0))
      throw new Error(`Invalid nanoid length: ${length}`);
    return this._check({ kind: "nanoid", length, message: p.error ?? p.message ?? (typeof params === "string" ? params : undefined) });
  }
  cuid2(message?: string) { return this._check({ kind: "cuid2", message }); }
  base64(message?: string) { return this._check({ kind: "base64", message }); }
  hex(message?: string) { return this._check({ kind: "hex", message }); }
  ip(message?: string) { return this._check({ kind: "ipv4", message }); }
  ipv4(message?: string) { return this._check({ kind: "ipv4", message }); }
  ipv6(message?: string) { return this._check({ kind: "ipv6", message }); }
  datetime(params?: any) {
    const p = typeof params === "object" && params !== null ? params : {};
    return this._check({ kind: "datetime", local: p.local, offset: p.offset,
      precision: p.precision, message: p.error ?? p.message ?? (typeof params === "string" ? params : undefined) });
  }
  date(message?: string) { return this._check({ kind: "datestr", message }); }
  time(params?: any) {
    const p = typeof params === "object" && params !== null ? params : {};
    return this._check({ kind: "timestr", precision: p.precision,
      message: p.error ?? p.message ?? (typeof params === "string" ? params : undefined) });
  }
  regex(re: RegExp, message?: string) { return this._check({ kind: "regex", regex: re, message }); }
  startsWith(s: string, message?: string) { return this._check({ kind: "startsWith", value: s, message }); }
  endsWith(s: string, message?: string) { return this._check({ kind: "endsWith", value: s, message }); }
  includes(s: string, params?: any) {
    const p = typeof params === "object" && params !== null ? params : {};
    return this._check({ kind: "includes", value: s, position: p.position, message: p.error ?? params });
  }
  lowercase(message?: string) { return this._check({ kind: "lowercase", message }); }
  uppercase(message?: string) { return this._check({ kind: "uppercase", message }); }
  nonempty(message?: string) { return this.min(1, message); }
  trim() { return this._check({ kind: "tx", tx: (s: string) => s.trim() }); }
  toLowerCase() { return this._check({ kind: "tx", tx: (s: string) => s.toLowerCase() }); }
  toUpperCase() { return this._check({ kind: "tx", tx: (s: string) => s.toUpperCase() }); }

  private _fmtcheck(format: string, regex: RegExp, message?: string, extra?: any) {
    return this._check({ kind: "regex", regex, format, message, ...extra });
  }
  emoji(message?: string) {
    return this._fmtcheck("emoji",
      /^(?=[\s\S]*[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3])[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u, message);
  }
  guid(message?: string) {
    return this._fmtcheck("guid",
      /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, message);
  }
  uuidv6(message?: string) { return this._check({ kind: "uuid", version: 6, message }); }
  uuidv7(message?: string) { return this._check({ kind: "uuid", version: 7, message }); }
  cuid(message?: string) {
    return this._fmtcheck("cuid", /^[cC][0-9a-z]{6,}$/, message);
  }
  base64url(message?: string) { return this._check({ kind: "base64url", message }); }
  jwt(params?: any) {
    const p = typeof params === "object" && params !== null ? params : {};
    return this._check({ kind: "jwt", alg: p.algorithm ?? p.alg, message: p.error ?? p.message ?? (typeof params === "string" ? params : undefined) });
  }
  xid(message?: string) {
    return this._fmtcheck("xid", /^[0-9a-vA-V]{20}$/, message);
  }
  ksuid(message?: string) {
    return this._fmtcheck("ksuid", /^[A-Za-z0-9]{27}$/, message);
  }
  e164(message?: string) {
    return this._fmtcheck("e164", /^\+[1-9]\d{6,14}$/, message);
  }
  cidrv4(message?: string) {
    return this._fmtcheck("cidrv4",
      /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/, message);
  }
  cidrv6(message?: string) {
    return this._fmtcheck("cidrv6",
      /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))\/(12[0-8]|1[01][0-9]|[0-9]{1,2})$/, message);
  }
  duration(message?: string) {
    return this._fmtcheck("duration",
      /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/, message);
  }
  hostname(message?: string) {
    return this._fmtcheck("hostname",
      /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/, message);
  }
  httpUrl(message?: string) {
    return this._check({ kind: "httpurl", normalize: false, _hasOpts: true, message });
  }
  mac(params?: any) {
    const p = typeof params === "object" && params !== null ? params : {};
    const d = (p.delimiter ?? ":").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return this._check({ kind: "mac", delimiter: p.delimiter,
      pat: new RegExp(`^(?:[0-9A-F]{2}${d}){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}${d}){5}[0-9a-f]{2}$`),
      message: p.error ?? p.message ?? (typeof params === "string" ? params : undefined) });
  }
  normalize(form: "NFC" | "NFD" | "NFKC" | "NFKD" = "NFC") {
    return this._check({ kind: "tx", tx: (s: string) => s.normalize(form) });
  }
  slugify() {
    return this._check({ kind: "tx", tx: (s: string) => s.toLowerCase().trim()
      .replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "") });
  }

  get format(): string | null {
    for (const c of this._def.checks ?? [])
      if (c.format) return c.format === "httpurl" ? "url" : (c.format.startsWith("uuid") ? "uuid" : c.format);
    for (const c of this._def.checks ?? [])
      if (!["min", "max", "length", "startsWith", "endsWith", "includes", "regex",
             "lowercase", "uppercase", "tx", "checkfn", "meta"].includes(c.kind))
        return c.kind === "datestr" ? "date" : c.kind === "timestr" ? "time" : c.kind === "httpurl" ? "url" : c.kind;
    return null;
  }
  get minLength(): number | null {
    let v: number | null = null;
    for (const c of this._def.checks ?? [])
      if (c.kind === "min" || c.kind === "length") v = v === null ? c.value : Math.max(v, c.value);
    return v;
  }
  get maxLength(): number | null {
    let v: number | null = null;
    for (const c of this._def.checks ?? [])
      if (c.kind === "max" || c.kind === "length") v = v === null ? c.value : Math.min(v, c.value);
    return v;
  }
}

export class ZodNumber extends ZodType<number> {
  constructor(_def: any = { type: "number", checks: [] }) { super(); this._def = _def; }
  private _check(c: any) { return new ZodNumber({ ...this._def, parent: this, checks: [...this._def.checks, { ...c, message: paramMsg(c.message) }] }); }
  gt(n: number, message?: string) { return this._check({ kind: "gt", value: n, message }); }
  gte(n: number, message?: string) { return this._check({ kind: "gte", value: n, message }); }
  min(n: number, message?: string) { return this._check({ kind: "gte", value: n, message }); }
  lt(n: number, message?: string) { return this._check({ kind: "lt", value: n, message }); }
  lte(n: number, message?: string) { return this._check({ kind: "lte", value: n, message }); }
  max(n: number, message?: string) { return this._check({ kind: "lte", value: n, message }); }
  int(message?: string) { return this._check({ kind: "int", message }); }
  safe(message?: string) { return this._check({ kind: "safeInt", message }); }
  finite(message?: string) { return this._check({ kind: "finite", message }); }
  multipleOf(n: number, message?: string) { return this._check({ kind: "multipleOf", value: n, message }); }
  step(n: number, message?: string) { return this.multipleOf(n, message); }
  positive(message?: string) { return this.gt(0, message); }
  nonnegative(message?: string) { return this.gte(0, message); }
  negative(message?: string) { return this.lt(0, message); }
  nonpositive(message?: string) { return this.lte(0, message); }
  // zod's derived getters fold every bound check (and the format bag) into an
  // aggregate: minValue = max of lowers, maxValue = min of uppers
  private _agg() {
    let minimum: number | undefined, exclusiveMinimum: number | undefined;
    let maximum: number | undefined, exclusiveMaximum: number | undefined;
    let isInt = !!(this._def.format as string | undefined)?.includes("int");
    const divs: number[] = [];
    for (const c of this._def.checks ?? []) {
      const k = c.kind, v = c.value;
      if (k === "gt") exclusiveMinimum = exclusiveMinimum === undefined ? v : Math.max(exclusiveMinimum, v);
      else if (k === "gte" || k === "min") minimum = minimum === undefined ? v : Math.max(minimum, v);
      else if (k === "lt") exclusiveMaximum = exclusiveMaximum === undefined ? v : Math.min(exclusiveMaximum, v);
      else if (k === "lte" || k === "max") maximum = maximum === undefined ? v : Math.min(maximum, v);
      else if (k === "safeInt") {
        minimum = minimum === undefined ? Number.MIN_SAFE_INTEGER : Math.max(minimum, Number.MIN_SAFE_INTEGER);
        maximum = maximum === undefined ? Number.MAX_SAFE_INTEGER : Math.min(maximum, Number.MAX_SAFE_INTEGER);
        isInt = true;
      } else if (k === "int") isInt = true;
      else if (k === "multipleOf") divs.push(v);
      else if (typeof c.format === "string" && c.format.includes("int")) isInt = true;
    }
    return { minimum, exclusiveMinimum, maximum, exclusiveMaximum, isInt, divs };
  }
  get minValue(): number | null {
    const { minimum, exclusiveMinimum } = this._agg();
    return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
  }
  get maxValue(): number | null {
    const { maximum, exclusiveMaximum } = this._agg();
    return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
  }
  get isInt(): boolean {
    const { isInt, divs } = this._agg();
    return isInt || divs.some(Number.isSafeInteger);
  }
  get isFinite(): boolean { return true; }
  get format(): string | null {
    if (this._def.format) return this._def.format;
    return this.isInt ? "safeint" : null;
  }
}

export class ZodBigInt extends ZodType<bigint> {
  constructor(_def: any = { type: "bigint", checks: [] }) { super(); this._def = _def; }
  private _check(c: any) { return new ZodBigInt({ ...this._def, parent: this, checks: [...this._def.checks, { ...c, message: paramMsg(c.message) }] }); }
  gt(n: bigint, message?: string) { return this._check({ kind: "gt", value: n, message }); }
  gte(n: bigint, message?: string) { return this._check({ kind: "gte", value: n, message }); }
  min(n: bigint, message?: string) { return this._check({ kind: "gte", value: n, message }); }
  lt(n: bigint, message?: string) { return this._check({ kind: "lt", value: n, message }); }
  lte(n: bigint, message?: string) { return this._check({ kind: "lte", value: n, message }); }
  max(n: bigint, message?: string) { return this._check({ kind: "lte", value: n, message }); }
  multipleOf(n: bigint, message?: string) {
    // a zero divisor can never divide — `x % 0n` throws, so this always fails
    if (n === 0n) return this._check({ kind: "checkfn", fn: (p: any) => { p.issues.push({ code: "not_multiple_of", divisor: 0n, message: paramMsg(message) }); } });
    return this._check({ kind: "multipleOf", value: n, message });
  }
  positive(m?: string) { return this.gt(0n, m); }
  nonnegative(m?: string) { return this.gte(0n, m); }
  negative(m?: string) { return this.lt(0n, m); }
  nonpositive(m?: string) { return this.lte(0n, m); }
  get minValue(): bigint | null {
    let v: bigint | null = null;
    for (const c of this._def.checks ?? [])
      if (c.kind === "gte" || c.kind === "gt" || c.kind === "min") v = v === null || c.value > v ? c.value : v;
    return v;
  }
  get maxValue(): bigint | null {
    let v: bigint | null = null;
    for (const c of this._def.checks ?? [])
      if (c.kind === "lte" || c.kind === "lt" || c.kind === "max") v = v === null || c.value < v ? c.value : v;
    return v;
  }
  get format(): string | null { return null; }
}

export class ZodBoolean extends ZodType<boolean> {
  constructor(_def: any = { type: "boolean" }) { super(); this._def = _def; }
}
export class ZodAny extends ZodType<any> {
  constructor(_def: any = { type: "any" }) { super(); this._def = _def; }
}
export class ZodUnknown extends ZodType<unknown> {
  constructor(_def: any = { type: "unknown" }) { super(); this._def = _def; }
}
export class ZodNever extends ZodType<never> {
  constructor(_def: any = { type: "never" }) { super(); this._def = _def; }
}
export class ZodNull extends ZodType<null> {
  constructor(_def: any = { type: "null" }) { super(); this._def = _def; }
}
export class ZodUndefined extends ZodType<undefined> {
  constructor(_def: any = { type: "undefined" }) { super(); this._def = _def; }
}
export class ZodVoid extends ZodType<void> {
  constructor(_def: any = { type: "void" }) { super(); this._def = _def; }
}
export class ZodNaN extends ZodType<number> {
  constructor(_def: any = { type: "nan" }) { super(); this._def = _def; }
}
export class ZodSymbol extends ZodType<symbol> {
  constructor(_def: any = { type: "symbol" }) { super(); this._def = _def; }
}

export class ZodDate extends ZodType<Date> {
  constructor(_def: any = { type: "date", checks: [] }) { super(); this._def = _def; }
  private _check(c: any) { return new ZodDate({ ...this._def, parent: this, checks: [...this._def.checks, { ...c, message: paramMsg(c.message) }] }); }
  min(d: Date | number, message?: string) { return this._check({ kind: "min", value: d instanceof Date ? d.getTime() : +d, message }); }
  max(d: Date | number, message?: string) { return this._check({ kind: "max", value: d instanceof Date ? d.getTime() : +d, message }); }
  get minDate(): Date | null {
    let m = -Infinity;
    for (const c of this._def.checks ?? [])
      if (c.kind === "min" && c.value > m) m = c.value;
    return m === -Infinity ? null : new Date(m);
  }
  get maxDate(): Date | null {
    let m = Infinity;
    for (const c of this._def.checks ?? [])
      if (c.kind === "max" && c.value < m) m = c.value;
    return m === Infinity ? null : new Date(m);
  }
}

// ---------- wrappers ----------
export class ZodOptional<T extends ZodTypeAny> extends ZodType<T["_output"] | undefined, T["_input"] | undefined> {
  constructor(_def: any) { super(); this._def = _def; }
  unwrap() { return this._def.inner as T; }
  protected override _runImpl(data: unknown) {
    const defaulted = (this._def.inner as any)?._zod?.optin === "defaulted";
    if (this._isRec() || defaulted) {
      if (data === undefined) {
        if (!defaulted) return { ok: true as const, value: undefined };
        // zod: the defaulted inner substitutes for absence; its failure
        // yields undefined with the issues dropped (handleOptionalResult)
        const r = (this._def.inner as any)._run(data);
        return { ok: true as const, value: r.ok ? r.value : undefined };
      }
      return (this._def.inner as any)._run(data);
    }
    return super._runImpl(data);
  }
}
// exactOptional is optional minus the undefined short-circuit: absent keys
// pass, explicit undefined falls through to the inner schema's own check
export class ZodExactOptional<T extends ZodTypeAny = ZodTypeAny> extends ZodOptional<T> {}

export class ZodNullable<T extends ZodTypeAny> extends ZodType<T["_output"] | null, T["_input"] | null> {
  constructor(_def: any) { super(); this._def = _def; }
  unwrap() { return this._def.inner as T; }
  protected override _runImpl(data: unknown) {
    if (this._isRec()) {
      if (data === null) return { ok: true as const, value: null };
      return (this._def.inner as any)._run(data);
    }
    return super._runImpl(data);
  }
}
export class ZodDefault<T extends ZodTypeAny> extends ZodType<T["_output"], T["_input"] | undefined> {
  constructor(_def: any) { super(); this._def = _def; }
  removeDefault() { return this._def.inner as T; }
  protected override _runImpl(data: unknown) {
    if (this._isRec() || this._hasFx() || typeof this._def.value === "function") {
      // zod: undefined input short-circuits to the default unvalidated; a
      // defined input runs inner, and an undefined RESULT swaps in the
      // default too (output-side default, e.g. transform -> undefined)
      if (data === undefined)
        return { ok: true as const, value: typeof this._def.value === "function" ? this._def.value() : this._def.value };
      const r = (this._def.inner as any)._run(data);
      if (r.ok && r.value === undefined)
        return { ok: true as const, value: typeof this._def.value === "function" ? this._def.value() : this._def.value };
      return r;
    }
    return super._runImpl(data);
  }
}
export class ZodPrefault<T extends ZodTypeAny> extends ZodType<T["_output"], T["_input"] | undefined> {
  constructor(_def: any) { super(); this._def = _def; }
  protected override _runImpl(data: unknown) {
    // prefault validates the substituted value through inner (unlike
    // default, which trusts it) — the engine's 0x0d node shares that shape
    if (!this._isRec() && !this._hasFx() && typeof this._def.value !== "function")
      return super._runImpl(data);
    const v = data === undefined
      ? (typeof this._def.value === "function" ? this._def.value() : this._def.value)
      : data;
    return (this._def.inner as any)._run(v);
  }
}
export class ZodCatch<T extends ZodTypeAny> extends ZodType<T["_output"], T["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  removeCatch() { return this._def.inner as T; }
  protected override _runImpl(data: unknown) {
    // function catchValues need the zod catch ctx and any fx inside the
    // subtree needs TS-level staging — constants can stay on the engine
    if (typeof this._def.value !== "function" && !this._isRec() && !this._hasFx())
      return super._runImpl(data);
    const mark = pendingAsync.length;
    const ir = (this._def.inner as any)._run(data);
    if (ir.ok) {
      if (pendingAsync.length > mark) {
        // the inner's deferred checks may still fail — gate them so the
        // catch sees the full inner result, zod's handleCatchResult
        const stages = pendingAsync.splice(mark);
        pendingAsync.push({ type: "catchgate", stages, data, inst: this, fn: this._def.value, ctx: RUN_CTX } as any);
      }
      return (ir as any).memo
        ? { ok: true as const, value: ir.value, memo: true }
        : { ok: true as const, value: ir.value };
    }
    // a failed inner leaves nothing behind — its issues and queued stages
    // are private to the catch's run
    pendingAsync.length = mark;
    const v = typeof this._def.value === "function"
      ? this._def.value(_catchCtx(data, ir.issues, ir.aborted === true))
      : this._def.value;
    return { ok: true as const, value: v };
  }
}
export class ZodEffects<T extends ZodTypeAny, N = T["_output"]> extends ZodType<N, T["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  // zod's checks live on the schema's own def — refinements expose inner
  // def fields like `pattern` through the wrapper
  override get def(): any {
    const d = this._def;
    if (d.pattern === undefined) {
      const p = (d.inner ?? d.innerType)?._def?.pattern;
      if (p !== undefined) return { ...d, pattern: p };
    }
    return d;
  }
  innerType() { return this._def.inner as T; }
  sourceType() { return this._def.inner as T; }
  private get _innerS(): any { return this._def.inner ?? this._def.innerType; }
  get minValue(): any { return this._innerS?.minValue ?? null; }
  get maxValue(): any { return this._innerS?.maxValue ?? null; }
  get minLength(): any { return this._innerS?.minLength ?? null; }
  get maxLength(): any { return this._innerS?.maxLength ?? null; }
  get minDate(): any { return this._innerS?.minDate ?? null; }
  get maxDate(): any { return this._innerS?.maxDate ?? null; }

  // refine/superRefine wrap an object — object helpers delegate to the
  // inner object the way zod's checks-in-def model exposes them
  // coerce wrappers carry no check methods of their own — delegate to the
  // inner schema so `z.coerce.number().min(10)` behaves like zod's
  // coerce-flagged ZodNumber
  private _delegateCheck(m: string, args: any[]) {
    const inner: any = this._def.inner;
    if (typeof inner?.[m] !== "function") throw new TypeError(`asmzod: .${m}() not supported on this wrapper`);
    return new ZodEffects({ ...this._def, innerType: inner[m](...args) });
  }
  min(n: number, m?: any) { return this._delegateCheck("min", [n, m]); }
  max(n: number, m?: any) { return this._delegateCheck("max", [n, m]); }
  gt(n: number, m?: any) { return this._delegateCheck("gt", [n, m]); }
  gte(n: number, m?: any) { return this._delegateCheck("gte", [n, m]); }
  lt(n: number, m?: any) { return this._delegateCheck("lt", [n, m]); }
  lte(n: number, m?: any) { return this._delegateCheck("lte", [n, m]); }
  length(n: number, m?: any) { return this._delegateCheck("length", [n, m]); }
  multipleOf(n: number, m?: any) { return this._delegateCheck("multipleOf", [n, m]); }
  int(m?: any) { return this._delegateCheck("int", [m]); }
  positive(m?: any) { return this._delegateCheck("positive", [m]); }
  nonnegative(m?: any) { return this._delegateCheck("nonnegative", [m]); }
  negative(m?: any) { return this._delegateCheck("negative", [m]); }
  nonpositive(m?: any) { return this._delegateCheck("nonpositive", [m]); }
  finite(m?: any) { return this._delegateCheck("finite", [m]); }
  regex(r: RegExp, m?: any) { return this._delegateCheck("regex", [r, m]); }
  startsWith(p: string, m?: any) { return this._delegateCheck("startsWith", [p, m]); }
  endsWith(p: string, m?: any) { return this._delegateCheck("endsWith", [p, m]); }
  includes(p: string, m?: any) { return this._delegateCheck("includes", [p, m]); }
  email(m?: any) { return this._delegateCheck("email", [m]); }
  url(m?: any) { return this._delegateCheck("url", [m]); }
  uuid(m?: any) { return this._delegateCheck("uuid", [m]); }

  private _refinedObj(): any {
    let s: any = this;
    while (s instanceof ZodEffects && (s._def.kind === "refine" || s._def.kind === "superrefine")) s = s._def.inner;
    return s instanceof ZodObject ? s : undefined;
  }
  private _mapRefinedObj(fn: (o: any) => any): any {
    const inner: any = this._def.inner;
    const ni = inner instanceof ZodEffects ? inner._mapRefinedObj(fn) : fn(inner);
    return new ZodEffects({ ...this._def, innerType: ni });
  }
  merge(): any {
    if (this._refinedObj())
      throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
    throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
  }
  extend(s: any): any {
    const t = this._refinedObj();
    if (!_isPlainObject(s)) throw new Error("Invalid input to extend: expected a plain object");
    if (!t) throw new Error("Invalid input to extend: expected a plain object");
    for (const k of Reflect.ownKeys(s)) {
      if (Object.getOwnPropertyDescriptor(t._def.shape, k) !== undefined)
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
    }
    return this._mapRefinedObj((o: any) => o.extend(s));
  }
  safeExtend(s: any): any {
    const t = this._refinedObj();
    if (!_isPlainObject(s)) throw new Error("Invalid input to safeExtend: expected a plain object");
    if (!t) throw new Error("Invalid input to safeExtend: expected a plain object");
    return this._mapRefinedObj((o: any) => o.extend(s));
  }
  pick(): any {
    if (this._refinedObj()) throw new Error(".pick() cannot be used on object schemas containing refinements");
    throw new Error("Invalid input to pick: expected an object schema");
  }
  omit(): any {
    if (this._refinedObj()) throw new Error(".omit() cannot be used on object schemas containing refinements");
    throw new Error("Invalid input to omit: expected an object schema");
  }
  partial(): any {
    if (this._refinedObj()) throw new Error(".partial() cannot be used on object schemas containing refinements");
    let s: any = this;
    while (s instanceof ZodEffects && (s._def.kind === "refine" || s._def.kind === "superrefine")) s = s._def.inner;
    if (s instanceof ZodTuple) throw new Error(".partial() cannot be used on tuple schemas containing refinements");
    throw new Error("Invalid input to partial: expected an object schema");
  }
  exactPartial(): any {
    if (this._refinedObj()) throw new Error(".exactPartial() cannot be used on object schemas containing refinements");
    throw new Error("Invalid input to exactPartial: expected an object schema");
  }
  required(mask?: Record<string, true>): any {
    if (this._refinedObj()) return this._mapRefinedObj((o: any) => o.required(mask));
    throw new Error("Invalid input to required: expected an object schema");
  }

  // effects always run at the TS level — the compiled engine can't host them
  // in nested positions (record keys etc). only thenable results queue for
  // safeParseAsync's replay; sync effects stay transparent in async mode too.
  protected override _runImpl(data: unknown) {
    const kind = this._def.kind ?? this._def.type;
    // coerce_* and check-record wrappers compile to engine ops — only
    // JS-callback effects (transform/refine/superrefine) run here
    if (kind !== "transform" && kind !== "superrefine" && kind !== "refine")
      return super._runImpl(data);
    const ir = (this._def.inner as any)._run(data);
    // back-edge hit: the value is an in-flight container — its own parse owns
    // the checks, and a transform's output can't exist in time to bind
    if ((ir as any).memo) {
      if (kind === "transform") throw new ZodCyclicError();
      return { ok: true as const, value: ir.value, memo: true };
    }
    // zod's check loop: a `when` check evaluates on any payload not explicitly
    // aborted (continue:false / pipe truncation); checks without `when` skip
    // whenever the payload is aborted
    const _when = this._def.when as ((p: any) => boolean) | undefined;
    if (_when) {
      if ((ir as any)._hardAbort === true ||
          (!ir.ok && ir.issues.some((i: any) => i.continue === false))) return ir;
    } else if (ir.ok === false && ((ir as any).aborted ?? isAborted(ir.issues))) return ir;
    // inner failed non-aborted: zod keeps running the check chain on the
    // parsed-so-far payload — re-run inner minus its unrecognized keys to get
    // it (no user callbacks re-fire), falling back to the raw input
    let base: any = ir.ok ? ir.value : ("value" in (ir as any) ? (ir as any).value : data);
    if (!ir.ok && data !== null && typeof data === "object" && !Array.isArray(data)) {
      const drop = new Set<PropertyKey>();
      for (const iss of ir.issues)
        if (iss.code === "unrecognized_keys" && !iss.path?.length)
          for (const k of (iss as any).keys) drop.add(k);
      if (drop.size) {
        const trimmed: any = { ...(data as object) };
        for (const k of drop) delete trimmed[k];
        const rr = (this._def.inner as any)._run(trimmed);
        if (rr.ok) base = rr.value;
      }
    }
    const fn = this._def.fn as (v: unknown, ctx?: any) => unknown;
    if (_when && !_when({ value: base, issues: ir.ok ? [] : ir.issues })) return ir;
    // a transform fed a node a back-edge already resolved to can't mirror
    // the cycle — its output is allocated after the input, never before
    if (kind === "transform" && MEMO?.backEdges?.has(base)) throw new ZodCyclicError();
    const queue = () => {
      if (!asyncMode) throw new AsyncCheckError();
      pendingAsync.push({ type: kind, fn, msg: this._def.message, ipath: this._def.path, inst: this, schema: this._def.inner } as any);
      return ir;
    };
    if (kind === "transform") {
      // zod passes the payload as ctx — addIssue pushes into the run's issues,
      // which aborts the enclosing pipe like any other failure
      const pushed: any[] = [];
      const r = fn(base, _addIssueCtx(pushed, this, base));
      if (isThenable(r)) {
        if (!asyncMode) throw new AsyncCheckError();
        pendingAsync.push({ type: kind, fn: () => r, pushed, msg: this._def.message, ipath: this._def.path, inst: this, schema: this._def.inner } as any);
        return ir;
      }
      if (pushed.length || r === NEVER) {
        const mine = pushed.map(({ path, ...rest }: any) => ({ inst: this, schema: this._def.inner, ...rest, path: path ?? [] }));
        return {
          ok: false as const,
          issues: [...(ir.ok ? [] : ir.issues), ...mine],
          value: r === NEVER ? undefined : r, aborted: true,
        } as any;
      }
      if (!ir.ok) return { ok: false as const, issues: ir.issues, aborted: false, value: r } as any;
      return { ok: true as const, value: r };
    }
    if (kind === "superrefine") {
      const pushed: any[] = [];
      const r = fn(base, _addIssueCtx(pushed, this, base));
      if (isThenable(r)) return queue();
      const mine = pushed.map(({ path, ...rest }: any) => ({ inst: this, schema: this._def.inner, ...rest, path: path ?? [] }));
      const abort = mine.length ? isAborted(mine) : undefined;
      if (ir.ok)
        return mine.length ? { ok: false as const, issues: mine, value: base, aborted: abort } as any : ir;
      return { ok: false as const, issues: [...ir.issues, ...mine], value: base,
               aborted: abort === true || isAborted(ir.issues) } as any;
    }
    const r = fn(base);
    if (isThenable(r)) return queue();
    if (!r) {
      const iss: any = {
        code: "custom", input: base, inst: this, schema: this._def.inner,
        path: [...(this._def.path ?? [])], continue: !this._def.abort,
      };
      if (this._def.params) iss.params = this._def.params;
      if (this._def.message !== undefined) iss.message = this._def.message;
      const mine = [iss];
      return ir.ok
        ? { ok: false as const, issues: mine, value: base }
        : { ok: false as const, issues: [...ir.issues, ...mine], value: base } as any;
    }
    return ir;
  }
}
export class ZodPipe<A extends ZodTypeAny, B extends ZodTypeAny> extends ZodType<B["_output"], A["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }

  get in(): A { return this._def.in; }
  get out(): B { return this._def.out; }

  // a pipe's refine is a real check record on the pipe def (never an
  // effects wrapper) — `def.in`/`def.out` must stay reachable for
  // input/output resolution and the checks run on the decoded value
  override refine(fn: (v: any) => boolean, message?: any): any {
    const p = _checkParams(message);
    return this.check({ kind: "refine", fn, message: p.message ?? p.error, error: p.error, abort: p.abort, when: p.when } as any);
  }
  override superRefine(fn: (v: any, ctx: any) => void): any {
    return this.check({ kind: "checkfn", fn: (p: any) => fn(p.value, { addIssue: (i: any) => p.issues.push(i) }) } as any);
  }

  protected override _runImpl(data: unknown) {
    if (!this._hasFx() && !(MEMO && _isRef(data) && this._isRec())) return super._runImpl(data);
    const mark = pendingAsync.length;
    const ir = (this._def.in as any)._run(data);
    if (!ir.ok) {
      // any blocking issue truncates the pipe (aborted); unrecognized keys
      // forward through `out` so an enclosing intersection can reconcile them
      if (ir.issues.some((i: any) => i.code !== "unrecognized_keys"))
        return { ...ir, aborted: true, _hardAbort: true };
      const or = (this._def.out as any)._run(("value" in ir) ? ir.value : data);
      if (or.ok)
        return { ok: false as const, issues: ir.issues, aborted: true, _hardAbort: true, value: or.value } as any;
      return {
        ok: false as const, issues: [...ir.issues, ...or.issues], aborted: true, _hardAbort: true,
        value: ("value" in or) ? or.value : (("value" in ir) ? ir.value : data),
      } as any;
    }
    // `in` queued async work (an async transform leaf, a nested async field)
    // — zod defers `out` behind the payload resolution, so a pipetail stage
    // replays it after the queued stages write the real value back
    if (pendingAsync.length > mark) {
      if (!asyncMode) throw new AsyncCheckError();
      pendingAsync.push({ type: "pipetail", out: this._def.out, inst: this, schema: this } as any);
      return { ok: true as const, value: ir.value };
    }
    const or = (this._def.out as any)._run(ir.value);
    if ((ir as any).memo) (or as any).memo = (or as any).memo ?? true;
    // the pipe's own checks gate the finished value (refine-on-transform etc)
    if (!or.ok || !this._def.checks?.length) return or;
    return this._runChecksTS(or.value, this._def.checks, or, this._def.out);
  }
}

// zod's ZodPreprocess — a pipe whose `in` is a $ZodTransform; the transform's
// optin is "optional" so absent object fields still run the fn
export class ZodPreprocess<B extends ZodTypeAny> extends ZodPipe<ZodTransform, B> {
  constructor(_def: any) { super(_def); }
}

// zod's $ZodTransform — the function-holding `out` side of a transform pipe;
// shares the effects runner with inner=any so the fn applies to the payload
export class ZodTransform extends ZodEffects<any, any> {
  constructor(fn: (v: unknown, ctx?: any) => unknown) {
    super({
      type: "transform", kind: "transform", inner: new ZodAny(),
      cbid: regId(reg.transform, guardAsync(fn as (v: unknown) => unknown)),
      fn,
    });
  }
  unwrap() { return undefined as any; }
}
export class ZodBranded<T extends ZodTypeAny, B extends string> extends ZodType<T["_output"] & { __brand: B }, T["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
}

// ---------- composites ----------
export type ZodRawShape = { [k: string]: ZodTypeAny };

// own-property write — plain `t[k]=` sets the prototype for "__proto__" and
// can run inherited setters; defineProperty does neither (zod's putProp)
const _putProp = (t: any, k: PropertyKey, v: any) =>
  Object.defineProperty(t, k, { value: v, enumerable: true, writable: true, configurable: true });

// a key whose value is not settled yet — self-caching so every read after
// the first gets the same one, then redefines itself as a data property so
// walks see the resolved edge (zod's deferProp/defineLazy)
const _deferProp = (t: any, k: PropertyKey, getter: () => any): void => {
  const EVAL: any = Symbol("evaluating");
  let value: any;
  Object.defineProperty(t, k, {
    enumerable: true, configurable: true,
    get() {
      if (value === EVAL) return undefined;
      if (value === undefined) {
        value = EVAL;
        const v = getter();
        value = v;
        Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true });
      }
      return value;
    },
    set(nv: any) {
      Object.defineProperty(this, k, { value: nv, writable: true, enumerable: true, configurable: true });
    },
  });
};

// mirror a schema's shape into a plain object — getter entries become
// deferred props that read the SOURCE's resolved shape on first access,
// so builders never invoke recursive getters (zod's mirrorShape)
const _mirrorShape = (
  target: any, src: any, keys: PropertyKey[],
  wrap?: ((v: any, k: PropertyKey) => any) | null,
): void => {
  const raw = src._def.shape;
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc || !desc.enumerable) continue;
    if (desc.get) {
      _deferProp(target, key, () => {
        const v = src._def.shape[key];
        return wrap ? wrap(v, key) : v;
      });
    } else _putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
  }
};

// plain-shape variant for caller-passed extension objects
const _mirrorProps = (target: any, source: Record<PropertyKey, any>): void => {
  for (const key of Reflect.ownKeys(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, key)!;
    if (!desc.enumerable) continue;
    if (desc.get) _deferProp(target, key, () => source[key]);
    else _putProp(target, key, desc.value);
  }
};
const _shapeKeys = (shape: any): PropertyKey[] =>
  Reflect.ownKeys(shape).filter((k) => Object.getOwnPropertyDescriptor(shape, k)?.enumerable);
const _maskedKeys = (shape: any, mask: any): PropertyKey[] => {
  const keys: PropertyKey[] = [];
  for (const k of Reflect.ownKeys(mask ?? {})) {
    if (!Object.getOwnPropertyDescriptor(shape, k)?.enumerable)
      throw new Error(`Unrecognized key: "${String(k)}"`);
    if ((mask as any)[k]) keys.push(k);
  }
  return keys;
};
const _isPlainObject = (v: any) =>
  v !== null && typeof v === "object" &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

export class ZodObject<T extends ZodRawShape> extends ZodType<objectOutputType<T>, objectInputType<T>> {
  constructor(_def: any) {
    super();
    // shape resolves by object spread — on first read, like zod: until then it
    // tracks the caller's raw object, and the snapshot keeps getter entries
    // intact (discriminatedUnion's construction check enumerates keys without
    // invoking recursive getters)
    const rawShape = _def.shape;
    if (rawShape) {
      let resolved: any;
      Object.defineProperty(_def, "shape", {
        enumerable: true, configurable: true,
        get() {
          if (resolved === undefined) {
            resolved = {};
            for (const k of _shapeKeys(rawShape)) {
              const desc = Object.getOwnPropertyDescriptor(rawShape, k)!;
              // getter keys become self-caching deferred props — invoked once
              // on first access, then a data property the recursion walk follows
              if (desc.get) _deferProp(resolved, k, () => rawShape[k]);
              else Object.defineProperty(resolved, k, desc);
            }
          }
          return resolved;
        },
      });
    }
    this._def = _def;
  }
  get shape(): T { return this._def.shape; }

  // symbol keys can't be tagged into bytecode — the compiled engine handles
  // the string keys and symbol fields are validated here at TS level.
  // undeclared input symbols are intentionally invisible to every engine,
  // matching zod's deliberate ignore-don't-flag behavior.
  protected override _runImpl(data: unknown) {
    const shape = this._def.shape;
    // zod reads declared keys through the prototype chain and validates exotic
    // objects the same as plain ones — engines only see own enumerable props,
    // so materialize the effective view for non-plain inputs first
    let input = data;
    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
      const proto = Object.getPrototypeOf(input);
      if (proto !== null && proto !== Object.prototype) {
        const merged: any = { ...(input as object) };
        let cur: object | null = proto;
        while (cur !== null && cur !== Object.prototype) {
          for (const k of Object.keys(cur))
            if (k in shape && !(k in merged)) merged[k] = (input as any)[k];
          cur = Object.getPrototypeOf(cur);
        }
        input = merged;
      }
    }
    // recursive-capable subtree — cyclic input can only loop through lazy or
    // getter edges, and the engine can't close a reference cycle, so these
    // validate per-field at TS level through the parse memo
    const syms = Reflect.ownKeys(shape).filter((k): k is symbol => typeof k === "symbol");
    if (MEMO && _isRef(data) && !Array.isArray(data) && this._isRec())
      return _memoRun(this, data, () => ({}), (out) => this._runTSObj(input, out));
    // JS-callback effects anywhere below need TS-level orchestration — the
    // engine skips a node's own checks once its children fail, while zod runs
    // them on the best-effort payload
    if (this._hasFx() || earlyAbort) {
      const rr = this._runTSObj(input);
      _stampIss(rr, this, data);
      return rr;
    }
    try {
      const r = super._runImpl(input);
      if (!syms.length) return r;
      const out: any = r.ok ? { ...(r.value as object) } : {};
      const symIssues: any[] = [];
      if (input !== null && typeof input === "object") {
        for (const k of syms) {
          const fd: any = shape[k];
          if (!_isSchema(fd))
            throw new Error(`Invalid element at key "${String(k)}"`);
          const present = k in (input as any);
          if (!present && fd._def?.type === "exactOptional") continue;
          const res = (fd as any)._run((input as any)[k]);
          if (!present && fd._zod.optin === undefined && res.ok) {
            symIssues.push({ code: "invalid_type", expected: "nonoptional",
              path: [k], message: "Invalid input: expected nonoptional, received undefined" });
          } else if (res.ok) {
            if (present || res.value !== undefined) out[k] = res.value;
          } else {
            for (const i of res.issues) symIssues.push({ ...i, path: [k, ...(i.path ?? [])] });
          }
        }
      }
      const issues = [...(r.ok ? [] : r.issues), ...symIssues];
      if (issues.length) return { ok: false as const, issues };
      return { ok: true as const, value: out };
    } catch (e: any) {
      // fields the engine can't host — codec/promise schemas don't compile,
      // and async effects can't suspend mid-run — so those objects validate
      // per-field at TS level where pendingAsync write-back works
      if ((asyncMode && e instanceof AsyncCheckError) || /cannot compile/.test(e?.message ?? ""))
        return this._runTSObj(input);
      throw e;
    }
  }

  // engine semantics replayed per-field in TS — runs every field through
  // _run so effects/codec subgraphs work and queued async stages get the
  // field-key path prefix the replay needs
  private _runTSObj(view: any, out?: any): any {
    const d = this._def;
    const shape = d.shape;
    if (view === null || typeof view !== "object" || Array.isArray(view))
      return { ok: false as const, issues: [typeIssue("object", view)], aborted: true };
    const issues: any[] = [];
    out ??= {};
    const consumed = new Set<PropertyKey>();
    for (const k of _shapeKeys(shape)) {
      consumed.add(k);
      if (k === "__proto__") continue;
      const f = shape[k];
      if (!_isSchema(f)) throw new Error(`Invalid element at key "${String(k)}"`);
      const present = k in view;
      const foptin = f._zod.optin;
      const isOptionalOut = f._zod.optout === "optional";
      const mark = pendingAsync.length;
      const res = (f as any)._run(view[k]);
      for (let i = mark; i < pendingAsync.length; i++)
        (pendingAsync[i] as any).path = [k, ...((pendingAsync[i] as any).path ?? [])];
      // handlePropertyResult: absent + optin==="optional" + optional-out
      // contributes nothing — the invented value is dropped, never substituted
      if (!present && isOptionalOut && foptin === "optional") { pendingAsync.length = mark; continue; }
      if (!res.ok) {
        // absent + omittable + optional-out swallows the failure outright
        if (!present && foptin !== undefined && isOptionalOut) { pendingAsync.length = mark; continue; }
        for (const i of res.issues) issues.push({ ...i, path: [k, ...(i.path ?? [])] });
      }
      // absent + required contributes the nonoptional issue, never a value
      if (!present && foptin === undefined) {
        if (res.ok)
          issues.push({ code: "invalid_type", expected: "nonoptional",
            path: [k], message: "Invalid input: expected nonoptional, received undefined" });
        continue;
      }
      // a failed field still supplies its payload value (checks see the
      // partial object); absent + defaulted + non-optional-out materializes
      // undefined, anything else absent contributes nothing
      const val = res.ok ? res.value : ("value" in (res as any) ? res.value : view[k]);
      if (val === undefined) {
        if (present || (foptin === "defaulted" && !isOptionalOut)) out[k] = undefined;
      } else {
        out[k] = val;
      }
      if (earlyAbort && isAborted(issues)) break;
    }
    const extra = Object.keys(view).filter((k) => !consumed.has(k));
    if (d.mode === "strict" && extra.length) {
      issues.push({ code: "unrecognized_keys", keys: extra, path: [] } as any);
    } else if (d.mode === "passthrough") {
      for (const k of extra) if (k !== "__proto__") out[k] = view[k];
    } else if (d.catchall && !(earlyAbort && isAborted(issues))) {
      for (const k of extra) {
        if (k === "__proto__") continue;
        const mark = pendingAsync.length;
        const res = (d.catchall as any)._run(view[k]);
        for (let i = mark; i < pendingAsync.length; i++)
          (pendingAsync[i] as any).path = [k, ...((pendingAsync[i] as any).path ?? [])];
        if (res.ok) out[k] = res.value;
        else for (const i of res.issues) issues.push({ ...i, path: [k, ...(i.path ?? [])] });
      }
    }
    // zod's payload is best-effort: fields that parsed stay in `value` so
    // when-checks and downstream effects see the partial object
    const res: any = issues.length
      ? { ok: false as const, issues, aborted: isAborted(issues), value: out }
      : { ok: true as const, value: out };
    // the object's own .check records evaluate on the finished payload
    if (this._def.checks?.length)
      return this._runChecksTS(view, this._def.checks, res, this._def);
    return res;
  }
  strict() { return new ZodObject({ ...this._def, mode: "strict", catchall: new ZodNever({ type: "never" }) }); }
  strip() { return new ZodObject({ ...this._def, mode: "strip", catchall: undefined }); }
  passthrough() { return new ZodObject({ ...this._def, mode: "passthrough", catchall: new ZodUnknown({ type: "unknown" }) }); }
  catchall<C extends ZodTypeAny>(c: C) { return new ZodObject({ ...this._def, mode: "strip", catchall: c }); }
  extend<S extends ZodRawShape>(s: S) {
    if (!_isPlainObject(s)) throw new Error("Invalid input to extend: expected a plain object");
    if (this._def.checks?.length) {
      for (const k of Reflect.ownKeys(s)) {
        if (Object.getOwnPropertyDescriptor(this._def.shape, k) !== undefined)
          throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
    return this._extend(s) as ZodObject<T & S>;
  }
  pick<K extends keyof T>(mask: Record<K, true>) {
    if (this._def.checks?.length) throw new Error(".pick() cannot be used on object schemas containing refinements");
    const shape: any = {};
    _mirrorShape(shape, this, _maskedKeys(this._def.shape, mask));
    return new ZodObject({ ...this._def, shape, checks: [] }) as ZodObject<Pick<T, K>>;
  }
  omit<K extends keyof T>(mask: Record<K, true>) {
    if (this._def.checks?.length) throw new Error(".omit() cannot be used on object schemas containing refinements");
    const omitted = new Set(_maskedKeys(this._def.shape, mask));
    const shape: any = {};
    _mirrorShape(shape, this, _shapeKeys(this._def.shape).filter((k) => !omitted.has(k)));
    return new ZodObject({ ...this._def, shape, checks: [] }) as ZodObject<Omit<T, K>>;
  }
  partial(mask?: Record<string, true>) {
    return this._partial(ZodOptional, mask, "partial");
  }
  exactPartial(mask?: Record<string, true>) {
    return this._partial(ZodExactOptional, mask, "exactPartial");
  }
  private _partial(Cls: any, mask: Record<string, true> | undefined, name: string) {
    if (this._def.checks?.length) throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
    const sel = mask ? new Set(_maskedKeys(this._def.shape, mask)) : undefined;
    const type = Cls === ZodExactOptional ? "exactOptional" : "optional";
    const shape: any = {};
    _mirrorShape(shape, this, _shapeKeys(this._def.shape),
      (v, k) => (sel && !sel.has(k) ? v : new Cls({ type, inner: v })));
    return new ZodObject({ ...this._def, shape, checks: [] });
  }
  required(mask?: Record<string, true>) {
    const sel = mask ? new Set(_maskedKeys(this._def.shape, mask)) : undefined;
    const shape: any = {};
    _mirrorShape(shape, this, _shapeKeys(this._def.shape),
      (v, k) => (sel && !sel.has(k) ? v : new ZodNonOptional({ type: "nonoptional", inner: v })));
    return new ZodObject({ ...this._def, shape });
  }
  keyof() { return new ZodEnum({ type: "enum", values: _shapeKeys(this._def.shape) }); }
  deepPartial() { return deepPartial(this); }
  loose() { return this.passthrough(); }
  merge<O extends ZodObject<any>>(o: O) {
    if (!(o as any)?._zod?.def)
      throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
    if (this._def.checks?.length)
      throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
    // a refined b contributes its inner shape plus its effect layers
    const wraps: ((s: any) => any)[] = [];
    let b: any = o;
    while (b instanceof ZodEffects && (b._def.kind === "refine" || b._def.kind === "superrefine")) {
      const e = b;
      wraps.unshift((s: any) => new ZodEffects({ ...e._def, innerType: s, inner: s }));
      b = e._def.inner;
    }
    if (!(b instanceof ZodObject))
      throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
    const shape: any = {};
    _mirrorShape(shape, this, _shapeKeys(this._def.shape));
    _mirrorShape(shape, b, _shapeKeys(b._def.shape));
    let res: any = new ZodObject({ ...this._def, shape, catchall: b._def.catchall, checks: [] });
    for (const w of wraps) res = w(res);
    return res as ZodObject<T & any>;
  }
  safeExtend<S extends ZodRawShape>(s: S) {
    if (!_isPlainObject(s)) throw new Error("Invalid input to safeExtend: expected a plain object");
    return this._extend(s);
  }
  private _extend<S extends ZodRawShape>(s: S) {
    const shape: any = {};
    _mirrorShape(shape, this, _shapeKeys(this._def.shape));
    _mirrorProps(shape, s);
    return new ZodObject({ ...this._def, shape });
  }
}

export class ZodArray<T extends ZodTypeAny> extends ZodType<T["_output"][], T["_input"][]> {
  constructor(_def: any) { super(); this._def = _def; }
  unwrap(): T { return this._def.element; }
  get element(): T { return this._def.element; }
  min(n: number, message?: any) { return new ZodArray({ ...this._def, minLen: n, _minMsg: paramMsg(message) }); }
  max(n: number, message?: any) { return new ZodArray({ ...this._def, maxLen: n, _maxMsg: paramMsg(message) }); }
  length(n: number, message?: any) { return new ZodArray({ ...this._def, minLen: n, maxLen: n, exactLen: true, _minMsg: paramMsg(message), _maxMsg: paramMsg(message) }); }
  nonempty(message?: string) { return this.min(1, message); }

  protected override _runImpl(data: unknown) {
    const mm = this._def._minMsg, xm = this._def._maxMsg;
    if (mm === undefined && xm === undefined) return this._runArrImpl(data);
    const r = this._runArrImpl(data) as any;
    // size params: this node's own too_small/too_big sits at path [] — patch
    // its message (nested arrays' issues carry deeper paths)
    if (!r.ok) for (const i of r.issues) {
      const msg = i.code === "too_small" && Number(i.minimum) === Number(this._def.minLen) ? mm
        : i.code === "too_big" && Number(i.maximum) === Number(this._def.maxLen) ? xm : undefined;
      if (msg !== undefined && (i.path?.length ?? 0) === 0 && i.origin === "array") {
        i.message = msg.charCodeAt(0) === 0 ? msgFns[+msg.slice(2)]?.(i) ?? i.message : msg;
        defaultedIssues.delete(i);
      }
    }
    return r;
  }
  private _runArrImpl(data: unknown) {
    // rewriting checks precede the element walk in zod — route through
    // _runChecksTS so tx transforms land before the size bounds evaluate
    if ((this._def.checks as any[])?.some((c) => c?.kind === "tx")) return super._runImpl(data);
    // recursive-capable subtree: the engine can't close a reference cycle,
    // so recursive arrays validate per-element at TS level through the memo
    if (!this._hasFx() && !earlyAbort && !(MEMO && Array.isArray(data) && this._isRec())) return super._runImpl(data);
    if (!Array.isArray(data)) return super._runImpl(data);
    const el = this._def.element as any;
    const d = this._def;
    return _memoRun(this, data, () => new Array(data.length), (out: any[]) => {
      const issues: any[] = [];
      // zod precheks the upper bound before any element runs — a too_big
      // payload aborts with no item issues and no downstream checks
      const over = d.exactLen !== undefined ? (data.length > d.exactLen ? d.exactLen : undefined)
        : (d.maxLen !== undefined && data.length > d.maxLen ? d.maxLen : undefined);
      if (over !== undefined) {
        const msg = d.exactLen !== undefined ? d._minMsg : d._maxMsg;
        issues.push({ code: "too_big", origin: "array", maximum: over, inclusive: true,
          exact: d.exactLen !== undefined, path: [],
          message: msg ?? `Too big: expected array to have <=${over} items` });
        return { ok: false as const, issues, aborted: true };
      }
      for (let i = 0; i < data.length; i++) {
        const mark = pendingAsync.length;
        const r = el._run(data[i]);
        for (let j = mark; j < pendingAsync.length; j++)
          (pendingAsync[j] as any).path = [i, ...((pendingAsync[j] as any).path ?? [])];
        if (r.ok) out[i] = r.value;
        else for (const iss of r.issues) issues.push({ ...iss, path: [i, ...(iss.path ?? [])] });
        if (earlyAbort && isAborted(issues)) break;
      }
      const lenIssue = (code: string, lim: number, exact: boolean, msg?: string) => issues.push({
        code, origin: "array", [code === "too_small" ? "minimum" : "maximum"]: lim,
        inclusive: true, exact, path: [],
        message: msg ?? `Too ${code === "too_small" ? "small" : "big"}: expected array to have ${code === "too_small" ? ">=" : "<="}${lim} items`,
      });
      if (d.exactLen !== undefined && data.length !== d.exactLen) lenIssue(data.length < d.exactLen ? "too_small" : "too_big", d.exactLen, true, d._minMsg);
      else {
        if (d.minLen !== undefined && data.length < d.minLen) lenIssue("too_small", d.minLen, false, d._minMsg);
        if (d.maxLen !== undefined && data.length > d.maxLen) lenIssue("too_big", d.maxLen, false, d._maxMsg);
      }
      return issues.length ? { ok: false as const, issues, aborted: isAborted(issues) } : { ok: true as const, value: out };
    });
  }
}

export class ZodTuple<Items extends ZodTypeAny[] = ZodTypeAny[]> extends ZodType<{ [k in keyof Items]: Items[k]["_output"] }> {
  constructor(_def: any) { super(); this._def = _def; }
  rest<R extends ZodTypeAny>(r: R) {
    return new ZodTuple({ ...this._def, rest: r }) as any;
  }
  partial() {
    const def = this._def;
    // a refinement was authored against the full arity; partialing would run it on a shorter array
    if (def.checks?.length) throw new Error(".partial() cannot be used on tuple schemas containing refinements");
    return new ZodTuple({ ...def, items: def.items.map((it: any) => new ZodOptional({ type: "optional", inner: it })) }) as any;
  }

  private _dropStages(from: number, to: number) {
    // discard async work queued by truncated tuple items — the tail slots
    // never materialize so their refinements must not write back
    pendingAsync.splice(from, to - from);
  }

  protected override _runImpl(data: unknown) {
    const items: any[] = this._def.items ?? [];
    const rest = this._def.rest as any;
    const n = items.length;
    // zod: optinStart — trailing run of optin!==undefined; optoutStart —
    // trailing run of optout==="optional". truncation rules only apply from
    // optoutStart, so optoutStart===n means the engine path is equivalent
    let optinStart = n; while (optinStart > 0 && items[optinStart - 1]?._zod?.optin !== undefined) optinStart--;
    let optoutStart = n; while (optoutStart > 0 && items[optoutStart - 1]?._zod?.optout === "optional") optoutStart--;
    if (optoutStart === n && !this._hasFx() && !earlyAbort && !(MEMO && Array.isArray(data) && this._isRec()))
      return super._runImpl(data);
    if (!Array.isArray(data)) return super._runImpl(data);
    return _memoRun(this, data, () => new Array(Math.max(data.length, optoutStart)), (out) => {
      const issues: any[] = [];
      if (!rest) {
        if (data.length < optinStart) {
          // zod's arity literal: code, minimum|maximum, inclusive, origin —
          // non-check issues so `aborted` judges on continue===undefined
          issues.push({ code: "too_small", minimum: optinStart, inclusive: true, origin: "array", path: [] });
          // arity precheck skips element validation entirely
          return { ok: false as const, issues, aborted: true };
        }
        if (data.length > n)
          issues.push({ code: "too_big", maximum: n, inclusive: true, origin: "array", path: [] });
      }
      // every item runs — even absent and truncated slots — so their async
      // work queues exactly like zod's parallel itemResults
      const stageMarks: number[] = [];
      const results: any[] = new Array(n);
      // fixed items parse as a unit — an abort inside the unit doesn't skip
      // later items, but it does keep `rest` (separate children) from running
      for (let i = 0; i < n; i++) {
        const mark = pendingAsync.length;
        stageMarks[i] = mark;
        const r = items[i]._run(data[i]);
        for (let j = mark; j < pendingAsync.length; j++)
          (pendingAsync[j] as any).path = [i, ...((pendingAsync[j] as any).path ?? [])];
        results[i] = r;
      }
      const tupleAborted = earlyAbort && results.some((r) => r && !r.ok && isAborted(r.issues));
      stageMarks[n] = pendingAsync.length;
      // rest validates input.slice(items.length) — every fixed index present
      if (rest && !tupleAborted) {
        for (let i = n; i < data.length; i++) {
          const mark = pendingAsync.length;
          const r = rest._run(data[i]);
          for (let j = mark; j < pendingAsync.length; j++)
            (pendingAsync[j] as any).path = [i, ...((pendingAsync[j] as any).path ?? [])];
          if (!r.ok) for (const iss of r.issues) issues.push({ ...iss, path: [i, ...(iss.path ?? [])] });
          out[i] = r.ok ? r.value : (r as any).value;
          if (earlyAbort && !r.ok && isAborted(r.issues)) break;
        }
      }
      // handleTupleResults: ordered walk — absent optin==="optional" slots
      // truncate outright; absent failing slots past optoutStart swallow
      for (let i = 0; i < n; i++) {
        const r = results[i];
        const isPresent = i < data.length;
        if (!isPresent && i >= optoutStart &&
            (items[i]._zod?.optin === "optional" || !r.ok)) {
          out.length = i;
          this._dropStages(stageMarks[i]!, stageMarks[n]!);
          break;
        }
        if (!r.ok) for (const iss of r.issues) issues.push({ ...iss, path: [i, ...(iss.path ?? [])] });
        out[i] = r.ok ? r.value : (r as any).value;
      }
      // tail-trim: absent input + optout==="optional" + undefined value
      for (let i = out.length - 1; i >= data.length; i--) {
        if (items[i]?._zod?.optout === "optional" && out[i] === undefined) out.length = i;
        else break;
      }
      return issues.length ? { ok: false as const, issues, aborted: isAborted(issues) } : { ok: true as const, value: out };
    });
  }
}

// the raw value universe for closed record key sets — mirrors zod's
// `_zod.values`: enum values, literal elements, flattened literal unions,
// resolving through transparent wrappers (refine/transform/pipe/...)
const _keyUniverse = (kt: any): any[] | undefined => {
  const t = kt?._def?.type;
  switch (t) {
    case "enum": {
      const v = kt._def.values;
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object")
        // native/TS enum object — drop the numeric reverse-mapped entries
        return Object.keys(v).filter((k) => isNaN(Number(k))).map((k) => v[k]);
      return [];
    }
    case "literal": {
      const v = kt._def.value ?? kt._def.values;
      return Array.isArray(v) ? v : [v];
    }
    case "union": {
      const out: any[] = [];
      for (const o of kt._def.options ?? []) {
        const ks = _keyUniverse(o);
        if (!ks) return undefined;
        out.push(...ks);
      }
      return out;
    }
    case "pipe": case "codec": return _keyUniverse(kt._def.in);
    case "optional": case "nullable": case "default": case "prefault":
    case "catch": case "readonly": case "brand": case "refine":
    case "superrefine": case "transform": case "nonoptional":
      return _keyUniverse(kt._def.inner ?? kt._def.innerType ?? kt._def.schema);
    default: return undefined;
  }
};

const _numKeyRe = /^-?\d+(\.\d+)?$/;
const _unrecMsg = (ks: string[]) =>
  ks.length === 1 ? `Unrecognized key: "${ks[0]}"` : `Unrecognized keys: ${ks.map((k) => `"${k}"`).join(", ")}`;

export class ZodRecord<K extends ZodTypeAny, V extends ZodTypeAny> extends ZodType<Record<string, V["_output"]>> {
  constructor(_def: any) { super(); this._def = _def; }
  get keyType(): K { return this._def.keyType; }
  get valueType(): V { return this._def.valueType; }

  // closed key sets own every universe key; open keyTypes constrain each
  // input key (numeric-string retry covers number keyTypes). "__proto__" is
  // never read, validated, or written — in or out.
  protected override _runImpl(data: unknown) {
    const kt = this._def.keyType as any;
    const vt = this._def.valueType as any;
    const mode: string = this._def.mode ?? "strict";
    const partial = this._def.partial === true;
    const values = _keyUniverse(kt);
    if (data === null || typeof data !== "object" || Array.isArray(data) ||
        data instanceof Map || data instanceof Set || data instanceof Date)
      return { ok: false as const, issues: [typeIssue("record", data)], aborted: true };
    if (MEMO && this._isRec())
      return _memoRun(this, data, () => ({}), (out) => this._runRecord(data, out));
    return this._runRecord(data, {});
  }

  private _runRecord(data: object, out: any) {
    const kt = this._def.keyType as any;
    const vt = this._def.valueType as any;
    const mode: string = this._def.mode ?? "strict";
    const partial = this._def.partial === true;
    const values = _keyUniverse(kt);
    const input = data as any;
    const issues: ZodIssue[] = [];
    let childAborted = false;
    const runV = (key: PropertyKey, v: any) => {
      const mark = pendingAsync.length;
      const r = vt._run(v);
      // the child judged aborted on its raw issues before _nc was stripped —
      // keep that verdict (tuple-arity too_small etc abort the union option)
      if (!r.ok && ((r as any).aborted ?? isAborted(r.issues))) childAborted = true;
      for (let i = mark; i < pendingAsync.length; i++)
        (pendingAsync[i] as any).path = [key, ...((pendingAsync[i] as any).path ?? [])];
      return r;
    };
    const vIssue = (key: PropertyKey, r: any) => {
      if (!r.ok) issues.push(...r.issues.map((i: any) => ({ ...i, path: [key, ...(i.path ?? [])] })));
    };
    const keyIssue = (key: PropertyKey, kr: any) =>
      issues.push({ code: "invalid_key", origin: "record", issues: kr.issues, path: [key], message: "Invalid key in record" } as any);
    // zod: "Async schemas not supported in object keys currently"
    const runK = (key: any): any => {
      const mark = pendingAsync.length;
      const kr: any = kt._run(key);
      if (pendingAsync.length > mark) throw new Error("Async schemas not supported in object keys currently");
      return kr;
    };

    if (values && !partial) {
      const recordKeys = new Set<any>(values.map((v) => typeof v === "number" ? String(v) : v));
      for (const key of values) {
        if (typeof key !== "string" && typeof key !== "number" && typeof key !== "symbol") continue;
        if (key === "__proto__") continue;
        const kr = runK(key);
        if (!kr.ok) { keyIssue(key, kr); continue; }
        const outKey: any = kr.value;
        if (outKey === "__proto__") continue;
        const r = runV(key, input[key]);
        vIssue(key, r);
        out[outKey] = r.ok ? r.value : undefined;
      }
      let unrecognized: string[] | undefined;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          if (mode === "loose") {
            if (key === "__proto__") continue;
            out[key] = input[key];
          } else (unrecognized ??= []).push(key);
        }
      }
      if (unrecognized?.length)
        issues.push({ code: "unrecognized_keys", keys: unrecognized, path: [], message: _unrecMsg(unrecognized) } as any);
    } else {
      let unrecognized: string[] | undefined;
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__") continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
        let kr = runK(key);
        if (!kr.ok && typeof key === "string" && _numKeyRe.test(key)) {
          const rr = runK(Number(key));
          if (rr.ok) kr = rr;
        }
        if (!kr.ok) {
          if (mode === "loose") out[key] = input[key];
          else if (values) (unrecognized ??= []).push(key as string);
          else keyIssue(key, kr);
          continue;
        }
        const outKey: any = kr.value;
        if (outKey === "__proto__") continue;
        const r = runV(key, input[key]);
        vIssue(key, r);
        out[outKey] = r.ok ? r.value : undefined;
      }
      if (unrecognized?.length)
        issues.push({ code: "unrecognized_keys", keys: unrecognized, path: [], message: _unrecMsg(unrecognized) } as any);
    }
    return issues.length ? { ok: false as const, issues, aborted: childAborted || isAborted(issues) } : { ok: true as const, value: out };
  }
}

// Map/Set: the container walk is JS (can't enumerate a Map in machine
// code), but every key/value still validates through the ARM64 engine.
export class ZodNonOptional<T extends ZodTypeAny = ZodTypeAny> extends ZodType<NonNullable<T["_output"]>, T["_input"]> {
  constructor(_def: any) { super(); this._def = { ..._def, type: "nonoptional" }; }
  protected override _runImpl(data: unknown) {
    const nir = (this._def.inner as any)._run(data);
    if (nir.ok && nir.value === undefined) {
      const iss: any = {
        code: "invalid_type", expected: "nonoptional", input: undefined, path: [],
        message: "Invalid input: expected nonoptional, received undefined",
      };
      defaultedIssues.add(iss);
      return { ok: false as const, issues: [iss], aborted: true };
    }
    return nir;
    return (this._def.inner as any)._run(data);
  }
}

// zod abort semantics: issues raised by checks (continue:true) can still be
// surfaced by a union's single-nonaborted-option rule; structural issues —
// and payload-level size issues like tuple arity — always abort the option
const CONTINUING_CODES = new Set([
  "too_small", "too_big", "invalid_format", "not_multiple_of",
  "unrecognized_keys", "custom",
]);
// backward-direction traversal — zod's direction:"backward": codecs reverse,
// unions try each option in order, objects encode each declared field, wrappers
// defer inward, and plain schemas validate forward
// every top-level encode gets a fresh memo — nested _encode calls share it
export function _encodeScoped(s: any, v: any): any {
  const prev = MEMO;
  MEMO = { buckets: new WeakMap() };
  try { return _encode(s, v); } finally { MEMO = prev; }
}

export function _encode(s: any, v: any): any {
  const d = s?._def;
  if (!d) throw new Error("asmzod: encode() requires a schema");
  switch (d.type) {
    case "codec": return (s as any)._enc(v);
    // pipe checks constrain the decoded side — run them on the input value
    // before it flows back through `out`
    case "pipe": return _encode(d.in, _encode(d.out, _encChecks(v, d.checks)));
    case "transform": throw new ZodEncodeError("ZodTransform");
    case "refine": case "superrefine": {
      v = _encChecks(v, d.checks);
      if (typeof d.fn === "function") {
        const p = { value: v, issues: [] as any[] };
        const rv = d.fn.length >= 2 ? d.fn(v, _addIssueCtx(p.issues)) : d.fn(v);
        if (rv === false || p.issues.length)
          throw new ZodError(p.issues.length ? p.issues : [{ code: "custom", input: v, path: [], message: "Invalid input" } as any]);
      }
      return _encode(d.inner ?? d.innerType, v);
    }
    case "lazy": return _encode(s.schema, v);
    case "union": case "discunion": case "discriminatedUnion": case "xor": {
      // map construction surfaces schema errors (duplicate tags) even in the
      // backward direction, matching zod
      s.discMap?.();
      for (const o of d.options ?? []) {
        try { return _encode(o, v); } catch { /* next */ }
      }
      throw new ZodError([{ code: "invalid_union", errors: [], path: [], message: "Invalid input" } as any]);
    }
    case "intersect": {
      const m = _mergeValues(_encode(d.left, v), _encode(d.right, v));
      if (!m.valid) throw new Error(`Unmergable intersection result at "${m.mergeErrorPath.join(".")}"`);
      return m.data;
    }
    case "object": {
      // cyclic input can only close through the encode memo — the encoded
      // container must be registered before children, same as parse
      if (MEMO && _isRef(v) && !Array.isArray(v) && (s as any)._isRec?.()) {
        const hit = _memoBucket(s).get(v);
        if (hit) {
          if (hit.issues === null) (MEMO!.backEdges ??= new WeakSet()).add(hit.value as object);
          return hit.value;
        }
        const out: any = {};
        const entry: _MemoEntry = { value: out, issues: null };
        _memoBucket(s).set(v as object, entry);
        for (const k of _shapeKeys(d.shape)) {
          const ev = _encode(d.shape[k], (v as any)?.[k]);
          if (ev !== undefined || (v != null && typeof v === "object" && k in v)) out[k] = ev;
        }
        if (d.mode === "passthrough" && v != null && typeof v === "object")
          for (const k of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(d.shape, k)) out[k] = (v as any)[k];
        entry.issues = [];
        return out;
      }
      const out: any = {};
      for (const k of _shapeKeys(d.shape)) {
        const ev = _encode(d.shape[k], (v as any)?.[k]);
        if (ev !== undefined || (v != null && typeof v === "object" && k in v)) out[k] = ev;
      }
      if (d.mode === "passthrough" && v != null && typeof v === "object")
        for (const k of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(d.shape, k)) out[k] = v[k];
      return out;
    }
    case "optional": case "exactOptional":
      return v === undefined ? undefined : _encode(d.inner ?? d.innerType, v);
    case "nullable":
      return v === null ? null : _encode(d.inner ?? d.innerType, v);
    case "nonoptional": {
      // inner may pass undefined through cleanly — that earns the
      // nonoptional issue, same gate as the parse direction
      const ev = _encode(d.inner ?? d.innerType, v);
      if (ev === undefined) {
        const r = s.safeParse(v);
        if (!r.success) throw r.error;
      }
      return ev;
    }
    case "default": case "prefault":
      // backward direction: defaults are decode-only — the raw value goes
      // through inner validation, so undefined earns invalid_type
      return _encode(d.inner ?? d.innerType, v);
    case "stringbool": {
      if (v === true) return (s as any)._lists().t[0];
      if (v === false) return (s as any)._lists().f[0];
      throw new ZodError([{ code: "invalid_type", expected: "boolean", input: v, path: [], message: "Invalid input: expected boolean" } as any]);
    }
    case "catch": return _encode(d.inner ?? d.innerType, v);
    case "readonly": case "brand": case "success":
      return _encode(d.inner ?? d.innerType, v);
    default: {
      const inner = d.inner ?? d.innerType;
      if (inner) return _encode(inner, v);
      const r = s.safeParse(v);
      if (!r.success) throw r.error;
      return r.data;
    }
  }
}

function isAborted(issues: any[]): boolean {
  return issues.some((i) => i._nc || i.continue === false || !CONTINUING_CODES.has(i.code));
}

function typeIssue(expected: string, received: unknown): ZodIssue {
  // soft message: flag it so finalizeIssue's ladder (inst > schema > ctx >
  // customError > localeError) can win — the default text fills in last
  const iss: any = {
    expected,
    code: "invalid_type",
    input: received,
    path: [],
    message: `Invalid input: expected ${expected === "nan" ? "NaN" : expected}, received ${parsedTypeName(received)}`,
  };
  defaultedIssues.add(iss);
  return iss as ZodIssue;
}

export class ZodMap<K extends ZodTypeAny, V extends ZodTypeAny>
  extends ZodType<Map<K["_output"], V["_output"]>, Map<K["_input"], V["_input"]>> {
  constructor(_def: any) { super(); this._def = _def; }
  private _check(c: any) { return new ZodMap({ ...this._def, checks: [...(this._def.checks ?? []), { ...c, message: paramMsg(c.message) }] }); }
  min(n: number, message?: string) { return this._check({ kind: "size", min: n, message }); }
  max(n: number, message?: string) { return this._check({ kind: "size", max: n, message }); }
  size(n: number, message?: string) { return this._check({ kind: "size", exact: n, message }); }
  nonempty(message?: string) { return this.min(1, message); }

  protected override _runImpl(data: unknown) {
    const _ck = this._def.checks;
    if (_ck?.length) {
      // zod aborts entry validation when the map already exceeds an upper
      // bound — the size issue stands alone
      const n = data instanceof Map ? data.size : undefined;
      if (typeof n === "number")
        for (const c of _ck)
          if (c.kind === "size" && ((c.exact !== undefined && n > c.exact) || (c.exact === undefined && c.max !== undefined && n > c.max)))
            return { ok: false as const, issues: [{ code: "too_big", origin: "map", maximum: c.exact ?? c.max, inclusive: true, ...(c.exact !== undefined ? { exact: true } : {}), path: [], message: c.message } as any], aborted: true };
      return this._runChecksTS(data, _ck);
    }
    if (!(data instanceof Map)) return { ok: false as const, issues: [typeIssue("map", data)], aborted: true };
    if (MEMO && this._isRec())
      return _memoRun(this, data, () => new Map(), (out) => this._runMap(data, out));
    return this._runMap(data, new Map());
  }

  private _runMap(data: Map<unknown, unknown>, out: Map<any, any>) {
    const { keyType, valueType } = this._def as { keyType: ZodTypeAny; valueType: ZodTypeAny };
    const issues: ZodIssue[] = [];
    for (const [k, v] of data) {
      let mark = pendingAsync.length;
      const kr = (keyType as any)._run(k);
      // key stages replay against the raw key, not a position in the output
      for (let i = mark; i < pendingAsync.length; i++) {
        (pendingAsync[i] as any).path = [k, ...((pendingAsync[i] as any).path ?? [])];
        (pendingAsync[i] as any).keyInput = k;
      }
      mark = pendingAsync.length;
      const vr = (valueType as any)._run(v);
      for (let i = mark; i < pendingAsync.length; i++)
        (pendingAsync[i] as any).path = [k, ...((pendingAsync[i] as any).path ?? [])];
      // zod: PropertyKey-typed keys get their issues prefixed at [key];
      // anything else wraps into invalid_key/invalid_element at the root
      if (!kr.ok) {
        if (["string", "number", "symbol"].includes(typeof k))
          issues.push(...kr.issues.map((i: any) => ({ ...i, path: [k, ...(i.path ?? [])] })));
        else issues.push({ code: "invalid_key", origin: "map", input: data, inst: this, issues: kr.issues, path: [], message: "Invalid key in map" } as any);
      }
      if (!vr.ok) {
        if (["string", "number", "symbol"].includes(typeof k))
          issues.push(...vr.issues.map((i: any) => ({ ...i, path: [k, ...(i.path ?? [])] })));
        else issues.push({ code: "invalid_element", origin: "map", input: data, key: k, inst: this, issues: vr.issues, path: [], message: "Invalid value in map" } as any);
      }
      // zod sets into the payload map unconditionally — payload values are
      // the raw key/value on failure
      out.set(kr.ok ? kr.value : k, vr.ok ? vr.value : v);
      // an entry parses as a unit — the stop lands between entries, so the
      // key/value pair of the aborting entry has already fully run
      if (earlyAbort && isAborted(issues)) break;
    }
    return issues.length ? { ok: false as const, issues, aborted: isAborted(issues) } : { ok: true as const, value: out };
  }
}

export class ZodSet<V extends ZodTypeAny>
  extends ZodType<Set<V["_output"]>, Set<V["_input"]>> {
  constructor(_def: any) { super(); this._def = _def; }
  private _check(c: any) { return new ZodSet({ ...this._def, checks: [...(this._def.checks ?? []), { ...c, message: paramMsg(c.message) }] }); }
  min(n: number, message?: string) { return this._check({ kind: "size", min: n, message }); }
  max(n: number, message?: string) { return this._check({ kind: "size", max: n, message }); }
  size(n: number, message?: string) { return this._check({ kind: "size", exact: n, message }); }
  nonempty(message?: string) { return this.min(1, message); }

  protected override _runImpl(data: unknown) {
    const _ck = this._def.checks;
    if (_ck?.length) {
      const n = data instanceof Set ? data.size : undefined;
      if (typeof n === "number")
        for (const c of _ck)
          if (c.kind === "size" && ((c.exact !== undefined && n > c.exact) || (c.exact === undefined && c.max !== undefined && n > c.max)))
            return { ok: false as const, issues: [{ code: "too_big", origin: "set", maximum: c.exact ?? c.max, inclusive: true, ...(c.exact !== undefined ? { exact: true } : {}), path: [], message: c.message } as any], aborted: true };
      return this._runChecksTS(data, _ck);
    }
    if (!(data instanceof Set)) return { ok: false as const, issues: [typeIssue("set", data)], aborted: true };
    if (MEMO && this._isRec())
      return _memoRun(this, data, () => new Set(), (out) => this._runSet(data, out));
    return this._runSet(data, new Set());
  }

  private _runSet(data: Set<unknown>, out: Set<any>) {
    const { valueType } = this._def as { valueType: ZodTypeAny };
    const issues: ZodIssue[] = [];
    for (const v of data) {
      const r = (valueType as any)._run(v);
      if (r.ok) out.add(r.value);
      else issues.push(...r.issues);
      if (earlyAbort && isAborted(issues)) break;
    }
    return issues.length ? { ok: false as const, issues, aborted: isAborted(issues) } : { ok: true as const, value: out };
  }
}

export class ZodUnion<T extends ZodTypeAny[]> extends ZodType<T[number]["_output"], T[number]["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  get options(): T { return this._def.options; }

  // union resolution happens in ZodType._run via the engine's `_u` marker:
  // exactly one non-aborted option surfaces its issues in place of the
  // invalid_union issue; otherwise per-option errors arrays attach.
  // recursive unions take the same option loop at TS level so a cyclic
  // input can close through the parse memo
  protected override _runImpl(data: unknown) {
    const fx = this._hasFx();
    if (!fx && !(MEMO && _isRef(data) && this._isRec())) return super._runImpl(data);
    const opts = this._def.options as any[];
    const runs = opts.map((o) => o._run(data));
    const win = runs.find((r) => r.ok);
    if (win) return win;
    const nonaborted = runs.filter((r) => !((r as any).aborted ?? isAborted(r.issues)));
    if (nonaborted.length === 1) return nonaborted[0];
    return {
      ok: false as const,
      issues: [{ code: "invalid_union", errors: runs.map((r) => (r as any).issues ?? []), path: [], message: "Invalid input" }] as any[],
    };
  }
}

export class ZodDiscriminatedUnion<T extends ZodTypeAny[]> extends ZodType<T[number]["_output"], T[number]["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  get options(): T { return this._def.options as T; }
  get def(): any { return this._def; }
  // discriminator value -> option map, built lazily on first use — recursive
  // options resolve their getters only once the union exists
  discMap(): Map<any, any> {
    const bag = this._zod.bag;
    return (bag.optionsMap ??= _discMap(this._def));
  }
  get _values(): Set<any> {
    const map = this.discMap();
    return new Set([...map.keys()].filter((k) => map.get(k) !== null));
  }

  protected override _runImpl(data: unknown) {
    if (data === null || typeof data !== "object" || Array.isArray(data))
      return { ok: false as const, issues: [typeIssue("object", data)], aborted: true };
    const disc = this._def.discriminator;
    const map = this.discMap();
    const opt = map.get((data as any)[disc]);
    if (opt) return opt._run(data);
    // explicit opt-in union matching; also the encode direction in zod
    if (this._def.unionFallback) {
      const u = (this._def._uf ??= new ZodUnion({ type: "union", options: this._def.options }));
      return (u as any)._run(data);
    }
    const opts = [...map.keys()].filter((k) => map.get(k) !== null);
    // schema-level error param overrides the default discriminator message
    const raw = paramMsg(this._def.error);
    const msg = raw !== undefined
      ? (raw.charCodeAt(0) === 0 ? msgFns[+raw.slice(2)]?.({ code: "invalid_union", path: [disc] }) : raw)
      : `Invalid discriminator value. Expected ${opts.map((o) => `'${o}'`).join(" | ")}`;
    return {
      ok: false as const,
      issues: [{
        code: "invalid_union", errors: [], note: "No matching discriminator",
        discriminator: disc, options: opts, path: [disc],
        message: msg,
      }] as any[],
    };
  }
}

// propValues-based lookup map — duplicate non-undefined tags are a hard error;
// colliding undefined tags poison the slot so no member can reclaim it
function _discMap(def: any): Map<any, any> {
  const map = new Map<any, any>();
  const disc = def.discriminator;
  (def.options as any[]).forEach((option, i) => {
    const values = _zodPropValues(option)?.[disc];
    if (!values || values.size === 0)
      throw new Error(`Invalid discriminated union option at index "${i}"`);
    for (const v of values) {
      if (map.has(v)) {
        if (v !== undefined) throw new Error(`Duplicate discriminator value "${String(v)}"`);
        map.set(v, null);
      } else map.set(v, option);
    }
  });
  return map;
}

// zod's mergeValues: shared object keys merge recursively, arrays zip,
// identical primitives pass — everything else is unmergable
function _mergeValues(a: any, b: any): { valid: true; data: any } | { valid: false; mergeErrorPath: (string | number)[] } {
  if (a === b) return { valid: true, data: a };
  if (a instanceof Date && b instanceof Date && +a === +b) return { valid: true, data: a };
  if (_isPlainObject(a) && _isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((k) => bKeys.indexOf(k) !== -1);
    const newObj: any = { ...a, ...b };
    if (Object.prototype.hasOwnProperty.call(newObj, "__proto__")) delete newObj.__proto__;
    for (const key of sharedKeys) {
      if (key === "__proto__") continue;
      const sv = _mergeValues(a[key], b[key]);
      if (!sv.valid) return { valid: false, mergeErrorPath: [key, ...sv.mergeErrorPath] };
      newObj[key] = sv.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { valid: false, mergeErrorPath: [] };
    const arr: unknown[] = [];
    for (let i = 0; i < a.length; i++) {
      const sv = _mergeValues(a[i], b[i]);
      if (!sv.valid) return { valid: false, mergeErrorPath: [i, ...sv.mergeErrorPath] };
      arr.push(sv.data);
    }
    return { valid: true, data: arr };
  }
  return { valid: false, mergeErrorPath: [] };
}

export class ZodIntersection<A extends ZodTypeAny, B extends ZodTypeAny> extends ZodType<A["_output"] & B["_output"], A["_input"] & B["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }

  // both sides run independently; a key rejection is reported only when BOTH
  // sides reject it (strict objects: unrecognized_keys; open records:
  // invalid_key) — a key owned by one branch survives the other's key schema
  protected override _runImpl(data: unknown) {
    const l = (this._def.left as any)._run(data);
    const r = (this._def.right as any)._run(data);
    const issues: ZodIssue[] = [];
    const unrecKeys = new Map<string, { l?: true; r?: true }>();
    let unrecIssue: any;
    const keyIssues = new Map<string, any>();
    const collect = (iss: any, side: "l" | "r"): boolean => {
      let keys: string[] | undefined;
      if (iss.code === "unrecognized_keys" && !iss.path?.length) {
        unrecIssue ??= iss;
        keys = iss.keys;
      } else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
        const k = String(iss.path[0]);
        if (!keyIssues.has(k)) keyIssues.set(k, iss);
        keys = [k];
      } else return false;
      for (const k of keys!) {
        const e = unrecKeys.get(k) ?? {};
        e[side] = true;
        unrecKeys.set(k, e);
      }
      return true;
    };
    for (const i of (l.ok ? [] : l.issues)) if (!collect(i, "l")) issues.push(i);
    for (const i of (r.ok ? [] : r.issues)) if (!collect(i, "r")) issues.push(i);
    const both = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
    if (both.length) {
      const aggregated = unrecIssue ? both.filter((k) => (unrecIssue.keys as string[]).includes(k)) : [];
      // zod finalizes the aggregated issue's message from the reduced key set
      if (aggregated.length)
        issues.push({
          ...unrecIssue, keys: aggregated,
          message: unrecIssue.message === _unrecMsg(unrecIssue.keys) ? _unrecMsg(aggregated) : unrecIssue.message,
        });
      for (const k of both) if (!aggregated.includes(k) && keyIssues.has(k)) issues.push(keyIssues.get(k));
    }
    // aborted payloads bail before the merge; continuable issues don't settle
    // the walk — the interpreter reaches the merge and throws on conflict
    const hardFail = isAborted(issues);
    if (issues.length && hardFail) return { ok: false as const, issues, aborted: true };
    // a side that failed only via reconciled key issues still contributes its
    // parsed-so-far value; effects results carry it, plain objects recover it
    // by re-running on the input minus that side's rejected keys
    const valueFor = (side: any, res: any, side_: "l" | "r") => {
      if (res.ok) return res.value;
      const dropped = [...unrecKeys].filter(([, f]) => f[side_]).map(([k]) => k);
      if ((res as any).value !== undefined) {
        let v = (res as any).value;
        // a best-effort value can still carry keys this side rejected — the
        // reconciling side's version wins the merge
        if (dropped.length && v !== null && typeof v === "object" && !Array.isArray(v)) {
          v = { ...(v as object) };
          for (const k of dropped) delete (v as any)[k];
        }
        return v;
      }
      if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
      const trimmed: any = { ...(data as object) };
      for (const k of dropped) delete trimmed[k];
      // engine results carry no best-effort value — re-run via the TS path
      const prevEA = earlyAbort;
      earlyAbort = true;
      try {
        const rr = side._run(trimmed) as any;
        return rr.value;
      } finally {
        earlyAbort = prevEA;
      }
    };
    const merged = _mergeValues(valueFor(this._def.left, l, "l"), valueFor(this._def.right, r, "r"));
    if (!merged.valid)
      throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
    if (issues.length) return { ok: false as const, issues, aborted: false, value: merged.data } as any;
    return { ok: true as const, value: merged.data };
  }
}

export class ZodLiteral<T> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
  private _vals(): any[] {
    return this._def.values ?? (Array.isArray(this._def.value) ? this._def.value : [this._def.value]);
  }
  get value(): T {
    const vs = this._vals();
    if (vs.length !== 1) throw new Error("Literal schemas with multiple or zero values cannot be represented as a single value");
    return vs[0];
  }
  get values(): Set<T> { return new Set(this._vals()); }
  // multi-value literals are one closed enum-like set — a single invalid_value
  // issue listing every member, not a union of per-literal failures. string
  // members compile to the enum node; anything else stays TS-side.
  protected override _runImpl(data: unknown) {
    const vals: any[] | undefined = this._def.values
      ?? (Array.isArray(this._def.value) ? this._def.value : undefined);
    if (vals && vals.length === 0)
      return { ok: false as const, issues: [{ code: "invalid_value", values: vals, path: [],
          message: "Invalid input" }] as any };
    if (vals && vals.some((v) => typeof v !== "string")) {
      return vals.includes(data)
        ? { ok: true as const, value: data }
        : { ok: false as const, issues: [{ code: "invalid_value", values: vals, path: [] }] as any };
    }
    return super._runImpl(data);
  }
}

export class ZodEnum<T extends string = string> extends ZodType<T> {
  constructor(_def: any) {
    super(); this._def = _def;
    if (!_def.entries && Array.isArray(_def.values))
      _def.entries = Object.fromEntries(_def.values.map((v: string) => [v, v]));
  }
  // the bytecode enum node is string-members-only — native enums with
  // numeric members check at the TS level
  protected override _runImpl(data: unknown) {
    const vals: any[] = this._def.values;
    if (vals.every((v) => typeof v === "string")) return super._runImpl(data);
    return vals.includes(data)
      ? { ok: true as const, value: data }
      : { ok: false as const, issues: [{ code: "invalid_value", values: vals, path: [], message: `Invalid option: expected one of ${vals.map((v) => JSON.stringify(v)).join("|")}` }] as any };
  }
  get options(): T[] { return this._def.values; }
  get enum(): Record<T, T> {
    return Object.fromEntries(this._def.values.map((v: string) => [v, v])) as Record<T, T>;
  }
  extract<V extends T>(vals: V[], params?: any) {
    return new ZodEnum({ type: "enum", values: this._def.values.filter((v: string) => vals.includes(v as V)), error: params === undefined ? this._def.error : params });
  }
  exclude(vals: string[], params?: any) {
    return new ZodEnum({ type: "enum", values: this._def.values.filter((v: string) => !vals.includes(v)), error: params === undefined ? this._def.error : params });
  }
}

export class ZodLazy<T extends ZodTypeAny> extends ZodType<T["_output"], T["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  // the getter resolves once — a factory that mints fresh schemas per call
  // still yields a finite schema graph (zod caches def.innerType)
  get schema(): T { return (this._def._cachedInner ??= this._def.getter()) as T; }

  // the engine's lazy thunk recurses natively — cyclic input can only reach
  // a lazy through a recursive subtree, which runs at TS level via the memo
  protected override _runImpl(data: unknown) {
    if (MEMO && _isRef(data) && this._isRec())
      return ((this._def._cachedInner ??= this._def.getter()) as any)._run(data);
    return super._runImpl(data);
  }
}

// real-zod schemas (grafted by core.visit's $ZodLazy cycle nodes) lack _run —
// this wrapper parses through their payload-shaped _zod.parse instead
class ZodForeign extends ZodLazy<any> {
  _foreign: any;
  constructor(s: any) {
    super({ type: "lazy", getter: () => s });
    this._foreign = s;
  }
  protected override _runImpl(data: unknown) {
    const p: any = { value: data, issues: [] };
    this._foreign._zod.parse(p, {});
    return p.issues?.length ? { ok: false as const, issues: p.issues } : { ok: true as const, value: p.value };
  }
}
function _norm(s: any): any {
  if (s == null || typeof s._run === "function" || typeof s._zod?.parse !== "function") return s;
  return (s.__az ??= new ZodForeign(s));
}

export class ZodInstanceof<T> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
  // zod: .check() clones the schema into a plain custom — the instanceof
  // predicate degrades from invalid_type to a `custom` code check
  override check(...args: any[]): any {
    const cls = this._def.ctor;
    const base = new ZodCustom<InstanceType<any>>({
      type: "custom", fn: (v: any) => v instanceof cls,
      abort: true, name: this._def.name,
    });
    return ZodType.prototype.check.call(base, ...args);
  }
  // asserts declared properties in place — same as .check(z.properties())
  properties(shape: any, params?: any): any {
    return this.check(_mkPropCheck(shape, params));
  }
}

export class ZodPromise<T extends ZodTypeAny> extends ZodType<Promise<T["_output"]>, Promise<T["_input"]>> {
  constructor(_def: any = { type: "promise", ctor: Promise, name: "promise", inner: null }) {
    super(); this._def = _def;
  }
  // zod: Promise.resolve(payload).then(inner) — any input resolves through
  // the promise hop, so even non-thenables work in async mode and sync
  // parse always raises the async error
  protected override _runImpl(data: unknown) {
    if (!asyncMode) throw new AsyncCheckError();
    pendingAsync.push({ type: "promisegate", inst: this, input: data, inner: this._def.inner } as any);
    return { ok: true as const, value: undefined };
  }
}

export class ZodFunction<A extends ZodTypeAny[] = [], R extends ZodTypeAny = ZodAny>
  extends ZodType<(...args: any[]) => any, (...args: any[]) => any> {
  constructor(_def: any = { type: "function", name: "function", input: null, output: null }) {
    super(); this._def = _def;
  }
  // `.input(args[])` wraps the list in a tuple; a bare schema passes through
  input(...args: any[]): any {
    const [a, rest] = args;
    const argSchema = _isSchema(a)
      ? a
      : new ZodTuple({ type: "tuple", items: a ?? [], rest: rest ?? null } as any);
    return new ZodFunction({ ...this._def, input: argSchema });
  }
  args(...args: any[]): any { return (this as any).input(args); }
  output(o: any): any {
    return new ZodFunction({ ...this._def, output: o });
  }
  returns(o: any): any { return this.output(o); }
  private _attach(fn: any): any {
    // an implemented function carries the schema's internals as a
    // non-enumerable own property — `(fn)._zod === schema._zod`
    Object.defineProperty(fn, "_zod", {
      value: this._zod, enumerable: false, writable: false, configurable: false,
    });
    return fn;
  }
  implement(fn: (...args: any[]) => any): (...args: any[]) => any {
    const argSchema: any = this._def.input ?? this._def.args;
    const ret: any = this._def.output ?? this._def.ret;
    // an anonymous function preserves `this` for method implementations
    return this._attach(function (this: any, ...callArgs: any[]) {
      let parsedArgs = callArgs;
      if (argSchema) {
        const ar = argSchema.safeParse(callArgs);
        if (!ar.success) throw new ZodError(ar.error.issues);
        parsedArgs = ar.data;
      }
      const out = Reflect.apply(fn, this, parsedArgs);
      if (ret) {
        const rr = ret.safeParse(out);
        if (!rr.success) throw new ZodError(rr.error.issues);
        return (rr as any).data;
      }
      return out;
    });
  }
  implementAsync(fn: (...args: any[]) => Promise<any>): (...args: any[]) => Promise<any> {
    const argSchema: any = this._def.input ?? this._def.args;
    const ret: any = this._def.output ?? this._def.ret;
    return this._attach(async function (this: any, ...callArgs: any[]) {
      let parsedArgs = callArgs;
      if (argSchema) {
        const ar = await argSchema.safeParseAsync(callArgs);
        if (!ar.success) throw new ZodError(ar.error.issues);
        parsedArgs = ar.data;
      }
      const out = await Reflect.apply(fn, this, parsedArgs);
      if (ret) {
        const rr = await (ret as any).safeParseAsync(out);
        if (!rr.success) throw new ZodError(rr.error.issues);
        return (rr as any).data;
      }
      return out;
    });
  }
  protected override _runImpl(data: unknown) {
    if (typeof data !== "function")
      return { ok: false as const, aborted: true,
        issues: [{ code: "invalid_type", expected: "function", input: data, path: [], message: "Expected function" } as any] };
    // a promise output means the wrapper must parse async (zod dispatches
    // on the output schema's type, not on the wrapped fn's asyncness)
    const outDef = this._def.output ?? this._def.ret;
    const impl = outDef?._def?.type === "promise" ? this.implementAsync : this.implement;
    return { ok: true as const, value: impl.call(this, data as (...args: any[]) => any) };
  }
}

export class ZodCustom<T> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
  protected override _runImpl(data: unknown) {
    const fn = this._def.fn as ((v: unknown) => boolean) | undefined;
    if (fn !== undefined) {
      const r = fn(data)
        ? { ok: true as const, value: data }
        : { ok: false as const, aborted: this._def.abort === true,
            issues: [{ code: "custom", input: data, path: [],
              ...(this._def.abort ? { continue: false } : {}) }] as any[] };
      // checks appended by .check()/.properties() evaluate after the predicate
      if (this._def.checks?.length)
        return this._runChecksTS(data, this._def.checks, r, this._def);
      return r;
    }
    return super._runImpl(data);
  }
  // instanceof.check() lands here — .properties() must chain the same way
  properties(shape: any, params?: any): any {
    return this.check(_mkPropCheck(shape, params));
  }
}

// ---------- type machinery ----------
export type output<T extends ZodTypeAny> = T["_output"];
export type input<T extends ZodTypeAny> = T["_input"];
export type infer<T extends ZodTypeAny> = T["_output"];

type optionalKeys<S extends ZodRawShape> = {
  [k in keyof S]: undefined extends S[k]["_input"] ? k : never;
}[keyof S];
type requiredKeys<S extends ZodRawShape> = Exclude<keyof S, optionalKeys<S>>;

export type objectOutputType<S extends ZodRawShape> = {
  [k in requiredKeys<S>]: S[k]["_output"];
} & {
  [k in optionalKeys<S>]?: S[k]["_output"];
};
export type objectInputType<S extends ZodRawShape> = {
  [k in requiredKeys<S>]: S[k]["_input"];
} & {
  [k in optionalKeys<S>]?: S[k]["_input"];
};

export { ZodError, type ZodIssue };

// ---------- zod 4 factories beyond the compiled core (TS layer) ----------

export const STRINGBOOL_TRUE = new Set(["true", "1", "yes", "on", "y", "enabled"]);
export const STRINGBOOL_FALSE = new Set(["false", "0", "no", "off", "n", "disabled"]);

export class ZodStringbool extends ZodType<boolean, unknown> {
  constructor(_def: any) {
    super();
    this._def = _def;
    (this as any)._zod.bag = { truthy: _def.truthy, falsy: _def.falsy, case: _def.case };
  }
  _lists(): { t: string[]; f: string[] } {
    const d = this._def;
    const t = d.truthy ?? [...STRINGBOOL_TRUE];
    const f = d.falsy ?? [...STRINGBOOL_FALSE];
    if (d.case === "sensitive") return { t, f };
    return { t: t.map((x: string) => x.toLowerCase()), f: f.map((x: string) => x.toLowerCase()) };
  }
  protected override _runImpl(data: unknown) {
    if (typeof data !== "string")
      return { ok: false as const, issues: [typeIssue("string", data)], aborted: true };
    const { t, f } = this._lists();
    const s = this._def.case === "sensitive" ? data : data.toLowerCase();
    if (t.includes(s)) return { ok: true as const, value: true };
    if (f.includes(s)) return { ok: true as const, value: false };
    const values = [...(this._def.truthy ?? [...STRINGBOOL_TRUE]), ...(this._def.falsy ?? [...STRINGBOOL_FALSE])];
    return {
      ok: false as const, aborted: true,
      issues: [{ code: "invalid_value", expected: "stringbool", values, path: [], inst: this, schema: this }] as any[],
    };
  }
}

export class ZodXor<T extends ZodTypeAny[]> extends ZodUnion<T> {
  protected override _runImpl(data: unknown) {
    const opts = this._def.options as ZodTypeAny[];
    const runs = opts.map((o) => (o as any)._run(data));
    const wins = runs.filter((r: any) => r.ok);
    if (wins.length === 1) return wins[0];
    // TS-level issues bypass the compiled 0x2A msgwrap — resolve def.error
    // here; `\0mN` placeholders resolve through msgFns directly
    const raw = paramMsg(this._def.error);
    const m = raw !== undefined && raw.charCodeAt(0) === 0
      ? msgFns[+raw.slice(2)]?.({ code: "invalid_union", path: [] }) : raw;
    if (wins.length === 0) {
      return {
        ok: false as const, aborted: true,
        issues: [{
          code: "invalid_union", errors: runs.map((r: any) => r.issues ?? []),
          path: [], message: m ?? "Invalid input",
        }] as any[],
      };
    }
    return {
      ok: false as const, aborted: true,
      issues: [{
        code: "invalid_union", errors: [], inclusive: false,
        matches: runs.map((r: any, i: number) => (r.ok ? i : -1)).filter((i: number) => i >= 0),
        path: [], message: m ?? "Invalid input: more than one option matched",
      }] as any[],
    };
  }
}

export class ZodFile extends ZodType<File, File> {
  constructor(_def: any) { super(); this._def = _def; }
  private _c(c: any) { return new ZodFile({ ...this._def, checks: [...(this._def.checks ?? []), c] }); }
  min(n: number, message?: string) { return this._c({ kind: "min", value: n, message }); }
  max(n: number, message?: string) { return this._c({ kind: "max", value: n, message }); }
  size(n: number, message?: string) { return this._c({ kind: "size", value: n, message }); }
  mime(m: string[], message?: string) { return this._c({ kind: "mime", value: m, message }); }
  protected override _runImpl(data: unknown) {
    if (typeof File === "undefined" || !(data instanceof File))
      return { ok: false as const, issues: [typeIssue("file", data)], aborted: true };
    const issues: ZodIssue[] = [];
    for (const c of this._def.checks ?? []) {
      if (c.kind === "min" && data.size < c.value)
        issues.push({ origin: "file", code: "too_small", minimum: c.value, inclusive: true, path: [], message: c.message ?? `Too small: expected file to have >=${c.value} bytes` } as any);
      else if (c.kind === "max" && data.size > c.value)
        issues.push({ origin: "file", code: "too_big", maximum: c.value, inclusive: true, path: [], message: c.message ?? `Too big: expected file to have <=${c.value} bytes` } as any);
      else if (c.kind === "size" && data.size !== c.value)
        issues.push({ code: "invalid_value", values: [c.value], path: [], message: c.message ?? `Invalid input: expected ${c.value}` } as any);
      else if (c.kind === "mime" && !c.value.some((m: string) => data.type === m || data.type.startsWith(m.split("*")[0])))
        issues.push({ code: "invalid_value", values: c.value, path: [], ...(c.message !== undefined ? { message: c.message } : {}) } as any);
    }
    return issues.length ? { ok: false as const, issues, aborted: isAborted(issues) } : { ok: true as const, value: data };
  }
}

// codec-side check application for the encode direction — tx/fn/checkfn
// plus single-check runs against a plain string base
function _encChecks(v: any, checks: any[] | undefined): any {
  for (const c of checks ?? []) {
    // `_zod`-shaped mirror records on refine defs aren't runnable checks
    if (c && typeof c === "object" && c.kind === undefined && c.fn === undefined) continue;
    if (c?.kind === "refine" && typeof c.fn === "function") {
      if (c.fn(v) === false) {
        const i: any = { code: "custom", input: v, path: [], message: "Invalid input" };
        const e = c.error ?? c.message;
        if (e !== undefined) i.message = typeof e === "function" ? e(i) : e;
        throw new ZodError([i]);
      }
    }
    else if (c?.kind === "tx") v = c.tx(v);
    else if (typeof c?.fn === "function") {
      const nv = c.fn(v);
      if (nv === false) throw new ZodError([{ code: "invalid_format", format: c.fmt ?? c.kind, input: v, path: [], message: c.message } as any]);
      else if (typeof nv === "string") v = nv;
      else if (Array.isArray(nv)) throw new ZodError(nv);
    } else if (typeof c === "function" || c?.kind === "checkfn") {
      const p = { value: v, issues: [] as any[] };
      (c.fn ?? c)(p);
      if (p.issues.length) throw new ZodError(p.issues);
    } else {
      const rr = new ZodString({ type: "string", checks: [c] }).safeParse(v);
      if (!rr.success) throw new ZodError(rr.error.issues);
    }
  }
  return v;
}

export class ZodCodec<A extends ZodTypeAny, B extends ZodTypeAny>
  extends ZodPipe<A, B> {
  constructor(_def: any) { super(_def); }
  protected override _runImpl(data: unknown) {
    const ir = (this._def.in as any)._run(data);
    if (!ir.ok) {
      // same truncation contract as pipes — a blocking `in` failure aborts
      // before the transform and any upstream refinements
      if (ir.issues.some((i: any) => i.code !== "unrecognized_keys"))
        return { ...ir, aborted: true, _hardAbort: true };
      return ir;
    }
    // codec transforms get zod's payload ctx — `ctx.issues` collects
    // decoder-reported failures like `invalid_format` on bad json
    const cctx = { value: ir.value, issues: [] as any[] };
    const decoded = this._def.transform(ir.value, cctx);
    if (isThenable(decoded)) {
      if (!asyncMode) throw new AsyncCheckError();
      pendingAsync.push({ type: "codecout", out: this._def.out, inst: this, tx: decoded, cctx } as any);
      return { ok: true as const, value: ir.value };
    }
    // `z.NEVER` returned from a decoder aborts with the ctx issues it pushed
    if ((decoded as any) === NEVER || cctx.issues.length)
      return { ok: false as const,
        issues: cctx.issues.length ? cctx.issues : [{ code: "custom", path: [], message: "Invalid input" }],
        aborted: true, _hardAbort: true };
    const or = (this._def.out as any)._run(decoded);
    // a failed `out` aborts the payload — upstream refinements must not run
    if (!or.ok) return { ...or, aborted: true, _hardAbort: true };
    if (!this._def.checks?.length) return or;
    // codec checks sit on the decoded (out-side) value — the single-check
    // carrier must be the out schema, never the codec itself
    return this._runChecksTS(decoded, this._def.checks, or, this._def.out);
  }
  _enc(v: any): any {
    const r = (this._def.out as any).safeParse(v);
    if (!r.success) throw new ZodError(r.error.issues);
    const checked = _encChecks(r.data, this._def.checks);
    const enc = this._def.reverseTransform(checked);
    const tail = (x: any) => {
      const er = (this._def.in as any).safeParse(x);
      if (!er.success) throw new ZodError(er.error.issues);
      return er.data;
    };
    return isThenable(enc) ? enc.then(tail) : tail(enc);
  }
  // encode: validate against B, reverse-transform, validate against A
  encode(value: B["_output"]): A["_output"] {
    const r = this._enc(value);
    if (isThenable(r)) throw new AsyncCheckError();
    return r as A["_output"];
  }
  decode(value: A["_input"]): B["_output"] { return this.parse(value); }
}

// ---------- algorithmic string formats (can't be regexes) ----------
// emitted as invalid_format issues exactly like zod's ZodStringFormat defs
export class ZodAlgoFormat extends ZodType<string, string> {
  constructor(_def: { format: string; message: string; fn: (s: string) => boolean; abort?: boolean; pattern?: RegExp }) {
    super(); this._def = { ..._def, type: "algoformat" };
  }
  protected override _runImpl(data: unknown) {
    if (typeof data !== "string")
      return { ok: false as const, issues: [typeIssue("string", data)], aborted: true };
    if (this._def.fn(data)) return { ok: true as const, value: data };
    const abort = this._def.abort === true;
    return {
      ok: false as const, aborted: abort,
      issues: [{ code: "invalid_format", format: this._def.format, path: [],
        ...(abort ? { continue: false } : {}), message: this._def.message }] as any[],
    };
  }
}

// zod's credit-card shape regex — single space/dash separators, 12-19 digits
export const CREDITCARD_RE = /^\d(?:[ -]?\d){11,18}$/;
// zod's iban shape: 2-letter country, check digits 02-98, 11-30 bban chars
export const IBAN_RE = /^[A-Z]{2}(?!00|01|99)\d{2}[A-Z0-9]{11,30}$/;

// Luhn behind the shape regex, like zod's credit card check
export function luhnCheck(s: string): boolean {
  if (!CREDITCARD_RE.test(s)) return false;
  const digits = s.replace(/[ -]/g, "");
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl && (d *= 2) > 9) d -= 9;
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

// IBAN: shape regex then mod-97 of rearranged digits == 1
export function ibanCheck(s: string): boolean {
  if (!IBAN_RE.test(s)) return false;
  const ib = s;
  let rem = 0;
  const moved = ib.slice(4) + ib.slice(0, 4);
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) rem = (rem * 10 + (code - 48)) % 97;
    else { const n = code - 55; rem = (rem * 10 + Math.floor(n / 10)) % 97; rem = (rem * 10 + (n % 10)) % 97; }
  }
  return rem === 1;
}

// visit() — bottom-up schema rewrite ported from zod's core/visit.ts, adapted
// to our def field names (inner|innerType, discunion, etc.). Cache-deferred
// cycles resolve to a lazy that reads the finished node.
const _AZ_RESOLVING = Symbol("az.visit/resolving");
export function visit(schema: any, fnOrHandlers: any): any {
  const fn = typeof fnOrHandlers === "function" ? fnOrHandlers : (node: any, rw: boolean) => {
    let t = node?._def?.type;
    if (t === "discunion") t = "union";
    else if (t === "intersect") t = "intersection";
    const h = fnOrHandlers[t];
    return h ? h(node, rw) : node;
  };
  const cache = new Map<any, any>();
  function run(s: any): any {
    const c = cache.get(s);
    if (c === _AZ_RESOLVING)
      return new ZodLazy({ type: "lazy", getter: () => cache.get(s) });
    if (c !== undefined) return c;
    cache.set(s, _AZ_RESOLVING);
    const inner = mapInner(s);
    const mapped = fn(inner, inner !== s);
    cache.set(s, mapped);
    return mapped;
  }
  const clone = (s: any, def: any) => new (s.constructor as any)(def);
  function mapInner(s: any): any {
    const d = s._def ?? s._zod?.def;
    if (!d) return s;
    switch (d.type) {
      case "object": {
        const old = d.shape as Record<string, any>;
        let changed = false;
        const shape: Record<string, any> = {};
        for (const k of Object.keys(old)) {
          const m = run(old[k]);
          if (m !== old[k]) changed = true;
          shape[k] = m;
        }
        let catchall = d.catchall;
        if (catchall) {
          catchall = run(catchall);
          if (catchall !== d.catchall) changed = true;
        }
        return changed ? clone(s, { ...d, shape, catchall }) : s;
      }
      case "array": {
        const m = run(d.element);
        return m === d.element ? s : clone(s, { ...d, element: m });
      }
      case "tuple": {
        let changed = false;
        const items = (d.items as any[]).map((it) => {
          const m = run(it);
          if (m !== it) changed = true;
          return m;
        });
        let rest = d.rest;
        if (rest) {
          rest = run(rest);
          if (rest !== d.rest) changed = true;
        }
        return changed ? clone(s, { ...d, items, rest }) : s;
      }
      case "record": case "map": {
        const k = run(d.keyType), v = run(d.valueType);
        return k === d.keyType && v === d.valueType ? s
          : clone(s, { ...d, keyType: k, valueType: v });
      }
      case "set": {
        const v = run(d.valueType);
        return v === d.valueType ? s : clone(s, { ...d, valueType: v });
      }
      case "union": case "discunion": {
        let changed = false;
        const options = (d.options as any[]).map((o) => {
          const m = run(o);
          if (m !== o) changed = true;
          return m;
        });
        return changed ? clone(s, { ...d, options }) : s;
      }
      case "intersect": case "intersection": {
        const l = run(d.left), r = run(d.right);
        return l === d.left && r === d.right ? s
          : clone(s, { ...d, left: l, right: r });
      }
      case "optional": case "exactOptional": case "nullable": case "default":
      case "prefault": case "catch": case "readonly": case "nonoptional":
      case "promise": case "success": case "refine": case "coerce_str":
      case "coerce_num": case "coerce_bool": case "coerce_bigint":
      case "instof": {
        const old = d.innerType ?? d.inner;
        if (old === undefined) return s;
        const m = run(old);
        return m === old ? s : clone(s, { ...d, innerType: m });
      }
      case "pipe": case "codec": {
        const i = run(d.in), o = run(d.out);
        return i === d.in && o === d.out ? s : clone(s, { ...d, in: i, out: o });
      }
      case "function": {
        const i = run(d.input), o = run(d.output);
        return i === d.input && o === d.output ? s
          : clone(s, { ...d, input: i, output: o });
      }
      case "lazy": {
        const original = d.getter as () => any;
        const { _cachedInner, ...rest } = d;
        return clone(s, { ...rest, getter: () => run(original()) });
      }
      default:
        return s;
    }
  }
  return run(schema);
}

// zod's $ZodCheckProperties — a _zod-shaped check object that asserts the
// declared keys on the payload value; issues prefix the key
export class ZodCheckProperties {
  _zod: any;
  constructor(_def: any) {
    const def = _def;
    let entries: [PropertyKey, any][] | undefined;
    const checkFn = (payload: any) => {
      const input = payload.value;
      // the base already typed the value — only nullish is rejected here
      if (input == null) {
        payload.issues.push({ code: "invalid_type", expected: "object", input, path: [] });
        return;
      }
      // key+schema snapshot together at first run (zod's mutation semantics)
      entries ??= Reflect.ownKeys(def.shape).map((k) => [k, (def.shape as any)[k]] as [PropertyKey, any]);
      for (const [key, schema] of entries) {
        const mark = pendingAsync.length;
        const r = (schema as any)._run((input as any)[key]);
        for (let j = mark; j < pendingAsync.length; j++)
          (pendingAsync[j] as any).path = [key, ...((pendingAsync[j] as any).path ?? [])];
        if (!r.ok)
          payload.issues.push(...r.issues.map((i: any) => {
            const ni = { ...i, path: [key, ...(i.path ?? [])] };
            if (defaultedIssues.has(i)) defaultedIssues.add(ni);
            return ni;
          }));
      }
    };
    this._zod = { def, check: checkFn, traits: new Set([ZodCheckProperties]) };
    // `[...z.properties(shape)]` spreads the check itself
    Object.defineProperty(this, Symbol.iterator, {
      value: function* () { yield this; }, enumerable: false, writable: true, configurable: true,
    });
  }
}
export class ZodCheckProperty extends ZodCheckProperties {}
export function _mkPropCheck(shape: any, params?: any): any {
  return new ZodCheckProperties({ check: "properties", shape, ...(params ?? {}) });
}
export function _mkPropertyCheck(key: PropertyKey, schema: any, params?: any): any {
  return new ZodCheckProperty({ check: "property", property: key, schema, shape: { [key]: schema }, ...(params ?? {}) });
}

/** Every nested object's properties made optional, wrappers preserved. */
export function deepPartial(schema: any): any {
  return visit(schema, {
    object: (s: any) => s.partial(),
    union: (s: any) => (s._def.discriminator === undefined ? s
      : new ZodUnion({ type: "union", options: s._def.options } as any)),
  });
}

// zod installs the spa alias accessor on every prototype that composes a trait
const _spaDesc: PropertyDescriptor = {
  get(this: any) { return this?.safeParseAsync; },
  set(this: any, v: any) {
    Object.defineProperty(this, "spa", { value: v, writable: true, enumerable: true, configurable: true });
  },
  enumerable: true,
  configurable: true,
};
for (const Cls of [
  ZodType, ZodString, ZodNumber, ZodBigInt, ZodBoolean, ZodAny, ZodUnknown,
  ZodNever, ZodNull, ZodUndefined, ZodVoid, ZodNaN, ZodSymbol, ZodDate,
  ZodObject, ZodArray, ZodTuple, ZodRecord, ZodUnion, ZodDiscriminatedUnion,
  ZodIntersection, ZodLiteral, ZodEnum, ZodLazy, ZodInstanceof, ZodCustom,
  ZodOptional, ZodExactOptional, ZodNullable, ZodDefault, ZodCatch,
  ZodEffects, ZodPipe, ZodBranded, ZodMap, ZodSet, ZodPromise, ZodFunction,
  ZodStringbool, ZodXor, ZodFile, ZodCodec, ZodAlgoFormat, ZodTransform,
  ZodPreprocess, ZodPrefault, ZodNonOptional, ZodReadonly, ZodForeign,
])
  if (Cls && !Object.getOwnPropertyDescriptor(Cls.prototype, "spa"))
    Object.defineProperty(Cls.prototype, "spa", _spaDesc);
