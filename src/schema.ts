// schema.ts — schema classes + chaining API (zod3-compatible surface)
import { compile, type Compiled } from "./bytecode.ts";
import { engineParse, portableEngineParse, reg, regId } from "./ffi.ts";
import * as napiBackend from "./native/napi.ts";
import { parsedTypeName, defaultMessage, applyErrorMaps, finalizeIssueTree, failure, captureStackTrace, globalConfig, defaultedIssues } from "./shared.ts";
import { encodeValue, type HostTable } from "./codec.ts";
import { ZodError, ZodRealError, type ZodIssue } from "./error.ts";
import { msgFns, paramMsg, ensureDefaultMemoizer } from "./shared.ts";

// issues added via ctx.addIssue inside superRefine callbacks during the
// in-flight engine run; _run splices them over the engine's `custom` slots
const pendingRefineIssues: any[] = [];

// async check support: the engine is synchronous, so callbacks that
// return thenables can't complete inside it. In async mode, ZodEffects
// stages queue here and safeParseAsync replays them sequentially —
// transforms rewrite a moving value, refines gate on it.
let asyncMode = false;
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
class AsyncCheckError extends Error {
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
function _inner(s: any): any { return s._def.inner ?? s._def.innerType ?? (s.schema ?? undefined); }
function _zodOptin(s: any): any {
  const t = s._def.type;
  const inner = _inner(s);
  switch (t) {
    case "optional": case "exactOptional": case "catch":
      return inner?._zod?.optin === "defaulted" ? "defaulted" : "optional";
    case "default": case "prefault": return "defaulted";
    case "transform": return s._def.node ? "optional" : inner?._zod?.optin;
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

const _cleanRe = (src: string): string =>
  src.slice(src.startsWith("^") ? 1 : 0, src.endsWith("$") ? src.length - 1 : undefined);

// zod's leafPattern: format/check patterns beat bounds, bounds beat the
// type default — check records carry `regex`/`value` where zod's carry
// `pattern`/`minimum`/`maximum`/`length`
function _zodLeafPattern(s: any): RegExp | undefined {
  const d = s._def;
  let pattern: RegExp | undefined = d.pattern;
  let isInt = !!d.format?.includes("int");
  let minimum: number | undefined, maximum: number | undefined;
  for (const c of d.checks ?? []) {
    if (c.regex) pattern = c.regex;
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
    case "optional": case "exactOptional": {
      const p = _zodPattern(_inner(s));
      return p ? new RegExp(`^(${_cleanRe(p.source)})?$`) : undefined;
    }
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

function _stampTree(i: any, inst: any, data: any): void {
  i.inst ??= inst;
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
      captureStackTrace(e, _params?.callee ?? fn);
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
      captureStackTrace(e, _params?.callee ?? fn);
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
      return _encodeScoped(schema, value);
    } catch (e: any) {
      if (e instanceof Error) captureStackTrace(e, _params?.callee ?? fn);
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
      if (e instanceof Error) captureStackTrace(e, _params?.callee ?? fn);
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

export abstract class ZodType<Output = unknown, Input = Output> {
  readonly _output!: Output;
  readonly _input!: Input;
  _def!: any;
  __zod: any;
  private _rec: boolean | undefined;
  private _recChecked = false;
  constructor() {
    ensureDefaultMemoizer();
    // zod's $constructor binds proto methods onto each instance — detached
    // `schema.parse` keeps `this`
    for (const k of ["parse", "parseAsync", "safeParse", "safeParseAsync", "spa",
                     "encode", "decode", "encodeAsync", "decodeAsync"]) {
      const m = (this as any)[k];
      if (typeof m === "function") (this as any)[k] = m.bind(this);
    }
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
    const inner = _inner(this);
    z = {
      def: this._def,
      traits: new Set([(this as any).constructor]),
      parent: this._def.parent,
      innerType: inner,
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
      toJSONSchema: () => (this as any).toJSONSchema?.(),
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
    return z;
  }

  private _compiled: Compiled | null = null;

  protected _compile(): Compiled {
    return (this._compiled ??= compile(this));
  }

  protected _run(data: unknown): { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] } {
    const r = this._runImpl(data) as any;
    _stampIss(r, this, data);
    return r;
  }
  protected _runImpl(data: unknown): { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] } {
    const _checks = (this._def as any).checks as any[] | undefined;
    if (_checks?.some((c) => c && (typeof c === "function" || c.kind === "tx" || c.kind === "checkfn")))
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
  private _runChecksTS(data: unknown, checks: any[]): { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] } {
    const Base = this.constructor as any;
    const base = new Base({ ...this._def, checks: [] });
    const r = base._run(data);
    if (!r.ok) return r;
    let v = r.value;
    const issues: ZodIssue[] = [];
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i];
      if (typeof c === "function" || c.kind === "checkfn") {
        const fn = typeof c === "function" ? c : c.fn;
        const payload = { value: v, issues: [] as any[] };
        const pr = fn(payload);
        if (isThenable(pr)) {
          if (!asyncMode) throw new AsyncCheckError();
          pendingAsync.push({ type: "checkchain", checks: checks.slice(i + 1), ctor: Base, def: this._def, tx: pr, pre: issues.splice(0), inst: this } as any);
          return { ok: true as const, value: v };
        }
        issues.push(...payload.issues);
        continue;
      }
      if (c.kind === "tx") {
        const nv = c.tx(v);
        if (isThenable(nv)) {
          if (!asyncMode) throw new AsyncCheckError();
          pendingAsync.push({ type: "checkchain", checks: checks.slice(i + 1), ctor: Base, def: this._def, tx: nv, pre: issues.splice(0), inst: this } as any);
          return { ok: true as const, value: v };
        }
        v = nv;
        continue;
      }
      const rr = new Base({ ...this._def, checks: [c] })._run(v);
      if (!rr.ok) issues.push(...rr.issues);
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
    return new ZodOptional({ type: "exactOptional", inner: this });
  }
  nullable(): ZodNullable<this> {
    return new ZodNullable({ type: "nullable", inner: this });
  }
  nullish(): ZodOptional<ZodNullable<this>> {
    return this.nullable().optional();
  }
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
    return new ZodEffects({
      type: "refine", inner: this,
      cbid: regId(reg.refine, guardAsync(fn as (v: unknown) => unknown)),
      fn, kind: "refine", message: p.message, error: p.error,
      path: p.path, params: p.params, abort: p.abort,
    });
  }
  refinement(fn: (v: Output) => boolean, message?: string): ZodEffects<this, Output> {
    return this.refine(fn, message);
  }
  superRefine(fn: (v: Output, ctx: { addIssue: (i: any) => void }) => void): ZodEffects<this, Output> {
    return new ZodEffects({
      type: "refine", inner: this,
      cbid: regId(reg.refine, guardAsync(((v: unknown) => {
        let ok = true;
        fn(v as Output, {
          addIssue: (i: any) => { ok = false; pendingRefineIssues.push(i); },
        });
        return ok;
      }) as (v: unknown) => unknown)),
      fn, kind: "superrefine", message: undefined,
    });
  }
  transform<N>(fn: (v: Output) => N): ZodPipe<this, ZodTransform> {
    return new ZodPipe({ type: "pipe", in: this, out: new ZodTransform(fn as (v: unknown) => unknown) });
  }
  pipe<T extends ZodTypeAny>(target: T): ZodPipe<this, T> {
    return new ZodPipe({ type: "pipe", in: this, out: target });
  }
  brand<B extends string>(): ZodBranded<this, B> {
    return new ZodBranded({ type: "brand", inner: this });
  }
  nonoptional(): ZodNonOptional<this> {
    return new ZodNonOptional({ inner: this });
  }
  clone(): this {
    return new (this.constructor as any)({ ...this._def });
  }
  describe(d: string): this {
    const c = this.clone();
    c._def = { ...c._def, description: d };
    return c;
  }
  meta(m?: any): any {
    if (m === undefined) return this._def.meta;
    const c = this.clone();
    c._def = { ...c._def, meta: { ...(c._def.meta ?? {}), ...m } };
    return c;
  }
  register(registry: any, m?: any): this {
    if (m !== undefined) this.meta(m);
    registry?.add?.(this);
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
        if (_isSchema(o)) {
          fns.push((payload: any) => {
            const r = (o as any)._run(payload.value);
            if (!r.ok) payload.issues.push(...r.issues);
          });
          continue;
        }
        const c = o._def ?? o;
        if (c.kind === "meta") { def.description = c.description ?? def.description; def.metadata = { ...(def.metadata ?? {}), ...(c.metadata ?? {}) }; }
        else if (c.kind === "checkfn") fns.push(c.fn);
        else if (c.kind === "tx") s = new ZodEffects({ type: "transform", inner: s, cbid: regId(reg.transform, guardAsync(c.tx)), fn: c.tx, kind: "transform" });
        else checks.push(c);
      }
      s = new (this as any).constructor(def);
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
  overwrite<N>(fn: (v: Output) => N): ZodPipe<this, ZodTransform> {
    return this.transform(fn);
  }
  prefault<V extends Input>(value: V | (() => V)): ZodType<Output, Input | undefined> {
    return new ZodPipe({
      type: "pipe",
      prefault: true,
      in: new ZodEffects<ZodAny>({
        type: "transform", inner: new ZodAny(),
        cbid: regId(reg.transform, (x: unknown) => x === undefined
          ? (typeof value === "function" ? (value as () => V)() : value)
          : x),
      }),
      out: this,
    }) as any;
  }
  isOptional(): boolean { return this.safeParse(undefined).success; }
  isNullable(): boolean { return this.safeParse(null).success; }
  get def(): any { return this._def; }
  get type(): string { return this._def.type; }
  get description(): string | undefined { return this._def.description; }
  get "~standard"() {
    const self = this;
    return {
      version: 1 as const, vendor: "zod",
      validate: (v: unknown) => {
        const r = self.safeParse(v);
        return r.success ? { value: r.data } : { issues: r.error.issues };
      },
    };
  }
  safeParseAsync(data: unknown, params?: any): Promise<SafeParseResult<Output>> {
    return _safeParseAsync(ZodRealError)(this, data, params);
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
    if (!r.ok) return r;
    if (!pendingAsync.length) return r;
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
      if (st.type === "transform")
        return { value: setPath(root, p, await st.fn(cur)), issues: [] };
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
      const res = await st.fn(cur);
      return res ? { value: root, issues: [] } : {
        value: root,
        issues: [{ code: "custom", path: [...(p ?? []), ...(st.ipath ?? [])], message: st.msg ?? "Invalid input", inst: st.inst, schema: st.schema } as ZodIssue],
      };
    };
    const allIssues: ZodIssue[] = [];
    for (const st of pendingAsync) {
      const r = await runStage(st, value);
      value = r.value;
      allIssues.push(...r.issues);
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
  spa(data: unknown): Promise<SafeParseResult<Output>> {
    return this.safeParseAsync(data);
  }
  readonly(): this { return this; }
}

class ZodIssueThrow extends Error {
  issue: any;
  constructor(issue: any) { super(issue.message ?? "invalid"); this.issue = issue; }
}

export type ZodTypeAny = ZodType<any, any>;

// ---------- primitives ----------
export class ZodString extends ZodType<string> {
  constructor(_def: any = { type: "string", checks: [] }) { super(); this._def = _def; }
  private _check(c: any) { return new ZodString({ ...this._def, parent: this, checks: [...this._def.checks, { ...c, message: paramMsg(c.message) }] }); }
  min(n: number, message?: string) { return this._check({ kind: "min", value: n, message }); }
  max(n: number, message?: string) { return this._check({ kind: "max", value: n, message }); }
  length(n: number, message?: string) { return this._check({ kind: "length", value: n, message }); }
  email(message?: string) { return this._check({ kind: "email", message }); }
  url(message?: string) { return this._check({ kind: "url", message }); }
  uuid(message?: string) { return this._check({ kind: "uuid", message }); }
  uuidv4(message?: string) { return this._check({ kind: "uuid", version: 4, message }); }
  ulid(message?: string) { return this._check({ kind: "ulid", message }); }
  nanoid(message?: string) { return this._check({ kind: "nanoid", message }); }
  cuid2(message?: string) { return this._check({ kind: "cuid2", message }); }
  base64(message?: string) { return this._check({ kind: "base64", message }); }
  hex(message?: string) { return this._check({ kind: "hex", message }); }
  ip(message?: string) { return this._check({ kind: "ipv4", message }); }
  ipv4(message?: string) { return this._check({ kind: "ipv4", message }); }
  ipv6(message?: string) { return this._check({ kind: "ipv6", message }); }
  datetime(message?: string) { return this._check({ kind: "datetime", message }); }
  date(message?: string) { return this._check({ kind: "datestr", message }); }
  time(message?: string) { return this._check({ kind: "timestr", message }); }
  regex(re: RegExp, message?: string) { return this._check({ kind: "regex", regex: re, message }); }
  startsWith(s: string, message?: string) { return this._check({ kind: "startsWith", value: s, message }); }
  endsWith(s: string, message?: string) { return this._check({ kind: "endsWith", value: s, message }); }
  includes(s: string, message?: string) { return this._check({ kind: "includes", value: s, message }); }
  lowercase(message?: string) { return this._check({ kind: "lowercase", message }); }
  uppercase(message?: string) { return this._check({ kind: "uppercase", message }); }
  nonempty(message?: string) { return this.min(1, message); }
  trim() { return this.transform((s) => s.trim()); }
  toLowerCase() { return this.transform((s) => s.toLowerCase()); }
  toUpperCase() { return this.transform((s) => s.toUpperCase()); }

  private _fmtcheck(format: string, regex: RegExp, message?: string) {
    return this._check({ kind: "regex", regex, format, message });
  }
  emoji(message?: string) {
    return this._fmtcheck("emoji",
      /^(?=[\s\S]*[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3])[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u, message);
  }
  guid(message?: string) {
    return this._fmtcheck("guid",
      /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, message);
  }
  uuidv6(message?: string) {
    return this._fmtcheck("uuid6",
      /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-6[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/, message);
  }
  uuidv7(message?: string) {
    return this._fmtcheck("uuid7",
      /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/, message);
  }
  cuid(message?: string) {
    return this._fmtcheck("cuid", /^[cC][0-9a-z]{6,}$/, message);
  }
  base64url(message?: string) {
    return this._fmtcheck("base64url",
      /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/, message);
  }
  jwt(message?: string) {
    return this._fmtcheck("jwt",
      /^([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]{2,})$/, message);
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
    return this._fmtcheck("httpurl",
      /^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*$/, message);
  }
  normalize(form: "NFC" | "NFD" | "NFKC" | "NFKD" = "NFC") {
    return this.transform((s) => s.normalize(form));
  }
  slugify() {
    return this.transform((s) => s.toLowerCase().trim()
      .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, ""));
  }

  get format(): string | null {
    for (const c of this._def.checks ?? [])
      if (c.format) return c.format === "httpurl" ? "url" : (c.format.startsWith("uuid") ? "uuid" : c.format);
    for (const c of this._def.checks ?? [])
      if (!["min", "max", "length", "startsWith", "endsWith", "includes", "regex",
             "lowercase", "uppercase"].includes(c.kind))
        return c.kind === "datestr" ? "date" : c.kind === "timestr" ? "time" : c.kind;
    return null;
  }
  get minLength(): number | null {
    for (const c of this._def.checks ?? [])
      if (c.kind === "min" || c.kind === "length") return c.value;
    return null;
  }
  get maxLength(): number | null {
    for (const c of this._def.checks ?? [])
      if (c.kind === "max" || c.kind === "length") return c.value;
    return null;
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
  multipleOf(n: bigint, message?: string) { return this._check({ kind: "multipleOf", value: n, message }); }
  positive(m?: string) { return this.gt(0n, m); }
  nonnegative(m?: string) { return this.gte(0n, m); }
  negative(m?: string) { return this.lt(0n, m); }
  nonpositive(m?: string) { return this.lte(0n, m); }
  get minValue(): bigint | null {
    for (const c of this._def.checks ?? [])
      if (c.kind === "gte" || c.kind === "gt" || c.kind === "min") return c.value;
    return null;
  }
  get maxValue(): bigint | null {
    for (const c of this._def.checks ?? [])
      if (c.kind === "lte" || c.kind === "lt" || c.kind === "max") return c.value;
    return null;
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
  min(d: Date, message?: string) { return this._check({ kind: "min", value: d.getTime(), message }); }
  max(d: Date, message?: string) { return this._check({ kind: "max", value: d.getTime(), message }); }
  get minDate(): Date | null {
    for (const c of this._def.checks ?? [])
      if (c.kind === "min") return new Date(c.value);
    return null;
  }
  get maxDate(): Date | null {
    for (const c of this._def.checks ?? [])
      if (c.kind === "max") return new Date(c.value);
    return null;
  }
}

// ---------- wrappers ----------
export class ZodOptional<T extends ZodTypeAny> extends ZodType<T["_output"] | undefined, T["_input"] | undefined> {
  constructor(_def: any) { super(); this._def = _def; }
  unwrap() { return this._def.inner as T; }
  protected override _runImpl(data: unknown) {
    if (this._isRec()) {
      if (data === undefined) return { ok: true as const, value: undefined };
      return (this._def.inner as any)._run(data);
    }
    return super._runImpl(data);
  }
}
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
    if (this._isRec() || typeof this._def.value === "function") {
      const v = data === undefined
        ? (typeof this._def.value === "function" ? this._def.value() : this._def.value)
        : data;
      return (this._def.inner as any)._run(v);
    }
    return super._runImpl(data);
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
  innerType() { return this._def.inner as T; }
  sourceType() { return this._def.inner as T; }

  // refine/superRefine wrap an object — object helpers delegate to the
  // inner object the way zod's checks-in-def model exposes them
  // coerce wrappers carry no check methods of their own — delegate to the
  // inner schema so `z.coerce.number().min(10)` behaves like zod's
  // coerce-flagged ZodNumber
  private _delegateCheck(m: string, args: any[]) {
    const inner: any = this._def.inner;
    if (typeof inner?.[m] !== "function") throw new TypeError(`asmzod: .${m}() not supported on this wrapper`);
    return new ZodEffects({ ...this._def, inner: inner[m](...args) });
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
    return new ZodEffects({ ...this._def, inner: ni });
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
    throw new Error("Invalid input to partial: expected an object schema");
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
    if (ir.ok === false && ((ir as any).aborted ?? isAborted(ir.issues))) return ir;
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
    // a transform fed a node a back-edge already resolved to can't mirror
    // the cycle — its output is allocated after the input, never before
    if (kind === "transform" && MEMO?.backEdges?.has(base)) throw new ZodCyclicError();
    const queue = () => {
      if (!asyncMode) throw new AsyncCheckError();
      pendingAsync.push({ type: kind, fn, msg: this._def.message, ipath: this._def.path, inst: this, schema: this._def.inner } as any);
      return ir;
    };
    if (kind === "transform") {
      const r = fn(base);
      if (isThenable(r)) return queue();
      if (!ir.ok) return { ok: false as const, issues: ir.issues, aborted: false, value: r } as any;
      return { ok: true as const, value: r };
    }
    if (kind === "superrefine") {
      const pushed: any[] = [];
      const r = fn(base, { addIssue: (i: any) => pushed.push(i) });
      if (isThenable(r)) return queue();
      const mine = pushed.map(({ path, ...rest }: any) => ({ inst: this, schema: this._def.inner, ...rest, path: path ?? [] }));
      if (ir.ok) return mine.length ? { ok: false as const, issues: mine } : ir;
      return { ok: false as const, issues: [...ir.issues, ...mine], value: base } as any;
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
        ? { ok: false as const, issues: mine }
        : { ok: false as const, issues: [...ir.issues, ...mine], value: base } as any;
    }
    return ir;
  }
}
export class ZodPipe<A extends ZodTypeAny, B extends ZodTypeAny> extends ZodType<B["_output"], A["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }

  get in(): A { return this._def.in; }
  get out(): B { return this._def.out; }

  protected override _runImpl(data: unknown) {
    if (!this._hasFx() && !(MEMO && _isRef(data) && this._isRec())) return super._runImpl(data);
    const ir = (this._def.in as any)._run(data);
    if (!ir.ok) {
      // any blocking issue truncates the pipe (aborted); unrecognized keys
      // forward through `out` so an enclosing intersection can reconcile them
      if (ir.issues.some((i: any) => i.code !== "unrecognized_keys"))
        return { ...ir, aborted: true };
      const or = (this._def.out as any)._run(("value" in ir) ? ir.value : data);
      if (or.ok)
        return { ok: false as const, issues: ir.issues, aborted: true, value: or.value } as any;
      return {
        ok: false as const, issues: [...ir.issues, ...or.issues], aborted: true,
        value: ("value" in or) ? or.value : (("value" in ir) ? ir.value : data),
      } as any;
    }
    const or = (this._def.out as any)._run(ir.value);
    if ((ir as any).memo) (or as any).memo = (or as any).memo ?? true;
    return or;
  }
}

// zod's $ZodTransform — the function-holding `out` side of a transform pipe;
// shares the effects runner with inner=any so the fn applies to the payload
export class ZodTransform extends ZodEffects<any, any> {
  constructor(fn: (v: unknown) => unknown) {
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
    if (this._hasFx()) {
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
      if (!present && f._def?.type === "exactOptional") continue;
      const mark = pendingAsync.length;
      const res = (f as any)._run(view[k]);
      for (let i = mark; i < pendingAsync.length; i++)
        (pendingAsync[i] as any).path = [k, ...((pendingAsync[i] as any).path ?? [])];
      if (!present && res.ok && f._zod.optin === undefined) {
        issues.push({ code: "invalid_type", expected: "nonoptional",
          path: [k], message: "Invalid input: expected nonoptional, received undefined" });
        continue;
      }
      // absent + omittable -> best-effort run; zod swallows its failure
      if (!present && !res.ok && f._zod.optin !== undefined) { pendingAsync.length = mark; continue; }
      if (res.ok) {
        if (present || res.value !== undefined) out[k] = res.value;
      } else {
        for (const i of res.issues) issues.push({ ...i, path: [k, ...(i.path ?? [])] });
      }
    }
    const extra = Object.keys(view).filter((k) => !consumed.has(k));
    if (d.mode === "strict" && extra.length) {
      issues.push({ code: "unrecognized_keys", keys: extra, path: [] } as any);
    } else if (d.mode === "passthrough") {
      for (const k of extra) if (k !== "__proto__") out[k] = view[k];
    } else if (d.catchall) {
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
    return issues.length
      ? { ok: false as const, issues, aborted: isAborted(issues) }
      : { ok: true as const, value: out };
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
    if (this._def.checks?.length) throw new Error(".partial() cannot be used on object schemas containing refinements");
    const sel = mask ? new Set(_maskedKeys(this._def.shape, mask)) : undefined;
    const shape: any = {};
    _mirrorShape(shape, this, _shapeKeys(this._def.shape),
      (v, k) => (sel && !sel.has(k) ? v : new ZodOptional({ type: "optional", inner: v })));
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
  deepPartial() { return this.partial(); }
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
      wraps.unshift((s: any) => new ZodEffects({ ...e._def, inner: s }));
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
  exactPartial() { return this.partial(); }
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
    // recursive-capable subtree: the engine can't close a reference cycle,
    // so recursive arrays validate per-element at TS level through the memo
    if (!this._hasFx() && !(MEMO && Array.isArray(data) && this._isRec())) return super._runImpl(data);
    if (!Array.isArray(data)) return super._runImpl(data);
    const el = this._def.element as any;
    const d = this._def;
    return _memoRun(this, data, () => new Array(data.length), (out: any[]) => {
      const issues: any[] = [];
      for (let i = 0; i < data.length; i++) {
        const mark = pendingAsync.length;
        const r = el._run(data[i]);
        for (let j = mark; j < pendingAsync.length; j++)
          (pendingAsync[j] as any).path = [i, ...((pendingAsync[j] as any).path ?? [])];
        if (r.ok) out[i] = r.value;
        else for (const iss of r.issues) issues.push({ ...iss, path: [i, ...(iss.path ?? [])] });
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

  protected override _runImpl(data: unknown) {
    if (!this._hasFx() && !(MEMO && Array.isArray(data) && this._isRec())) return super._runImpl(data);
    if (!Array.isArray(data)) return super._runImpl(data);
    const items: any[] = this._def.items ?? [];
    const rest = this._def.rest as any;
    return _memoRun(this, data, () => new Array(data.length), (out) => {
      const issues: any[] = [];
      if (!rest && data.length !== items.length) {
        const lim = items.length;
        const code = data.length < lim ? "too_small" : "too_big";
        issues.push({
          code, origin: "array", [code === "too_small" ? "minimum" : "maximum"]: lim,
          inclusive: true, exact: true, path: [],
          message: `Too ${code === "too_small" ? "small" : "big"}: expected array to have ${code === "too_small" ? ">=" : "<="}${lim} items`,
        });
        // tuple arity aborts the whole union option it sits under
        return { ok: false as const, issues, aborted: true };
      }
      for (let i = 0; i < data.length; i++) {
        const it = i < items.length ? items[i] : rest;
        if (!it) continue;
        const mark = pendingAsync.length;
        const r = it._run(data[i]);
        for (let j = mark; j < pendingAsync.length; j++)
          (pendingAsync[j] as any).path = [i, ...((pendingAsync[j] as any).path ?? [])];
        if (r.ok) out[i] = r.value;
        else for (const iss of r.issues) issues.push({ ...iss, path: [i, ...(iss.path ?? [])] });
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
    case "codec": return s.encode(v);
    case "pipe": return _encode(d.in, _encode(d.out, v));
    case "transform": case "refine": case "superrefine": return s.parse(v);
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
      return _encode(d.inner ?? d.innerType,
        v === undefined ? (typeof d.value === "function" ? d.value() : d.value) : v);
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

  protected override _runImpl(data: unknown) {
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
    }
    return issues.length ? { ok: false as const, issues, aborted: isAborted(issues) } : { ok: true as const, value: out };
  }
}

export class ZodSet<V extends ZodTypeAny>
  extends ZodType<Set<V["_output"]>, Set<V["_input"]>> {
  constructor(_def: any) { super(); this._def = _def; }

  protected override _runImpl(data: unknown) {
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
    const survivor = runs.findIndex((r) => !((r as any).aborted ?? isAborted(r.issues)));
    if (survivor >= 0) return runs[survivor];
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
    if (issues.length) return { ok: false as const, issues, aborted: isAborted(issues) };
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
      if (!dropped.length) return undefined;
      const trimmed: any = { ...(data as object) };
      for (const k of dropped) delete trimmed[k];
      const rr = side._run(trimmed);
      return rr.ok ? rr.value : undefined;
    };
    const merged = _mergeValues(valueFor(this._def.left, l, "l"), valueFor(this._def.right, r, "r"));
    if (!merged.valid)
      throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
    return { ok: true as const, value: merged.data };
  }
}

export class ZodLiteral<T> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
  get value(): T { return this._def.value; }
  // multi-value literals are one closed enum-like set — a single invalid_value
  // issue listing every member, not a union of per-literal failures. string
  // members compile to the enum node; anything else stays TS-side.
  protected override _runImpl(data: unknown) {
    const vals: any[] | undefined = this._def.values
      ?? (Array.isArray(this._def.value) ? this._def.value : undefined);
    if (vals && vals.some((v) => typeof v !== "string")) {
      return vals.includes(data)
        ? { ok: true as const, value: data }
        : { ok: false as const, issues: [{ code: "invalid_value", values: vals, path: [],
            message: `Invalid option: expected one of ${vals.map((v) => JSON.stringify(v)).join("|")}` }] as any };
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
  extract<V extends T>(vals: V[]) {
    return new ZodEnum({ type: "enum", values: this._def.values.filter((v: string) => vals.includes(v as V)) });
  }
  exclude(vals: string[]) {
    return new ZodEnum({ type: "enum", values: this._def.values.filter((v: string) => !vals.includes(v)) });
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

export class ZodInstanceof<T> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
}

export class ZodPromise<T extends ZodTypeAny> extends ZodType<Promise<T["_output"]>, Promise<T["_input"]>> {
  constructor(_def: any = { type: "instof", ctor: Promise, name: "promise", inner: null }) {
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
  constructor(_def: any = { type: "instof", ctor: Function, name: "function", args: null, ret: null }) {
    super(); this._def = _def;
  }
  implement(fn: (...args: any[]) => any): (...args: any[]) => any {
    const { args, ret } = this._def as { args: A | null; ret: R | null };
    if (!args && !ret) return fn;
    return (...callArgs: any[]) => {
      if (args) {
        const t = new ZodTuple({ type: "tuple", items: args, rest: null } as any);
        const ar = t.safeParse(callArgs);
        if (!ar.success) throw new ZodError(ar.error.issues);
      }
      const out = fn(...callArgs);
      if (ret) {
        const rr = ret.safeParse(out);
        if (!rr.success) throw new ZodError(rr.error.issues);
        return (rr as any).data;
      }
      return out;
    };
  }
}

export class ZodCustom<T> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
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

const STRINGBOOL_TRUE = new Set(["true", "1", "yes", "on", "y", "enabled"]);
const STRINGBOOL_FALSE = new Set(["false", "0", "no", "off", "n", "disabled"]);

export class ZodStringbool extends ZodType<boolean, unknown> {
  constructor(_def: any) { super(); this._def = _def; }
  protected override _runImpl(data: unknown) {
    if (typeof data !== "string")
      return { ok: false as const, issues: [typeIssue("string", data)], aborted: true };
    const s = data.toLowerCase();
    if (STRINGBOOL_TRUE.has(s)) return { ok: true as const, value: true };
    if (STRINGBOOL_FALSE.has(s)) return { ok: true as const, value: false };
    const values = [...STRINGBOOL_TRUE, ...STRINGBOOL_FALSE];
    return {
      ok: false as const, aborted: true,
      issues: [{
        code: "invalid_value", expected: "stringbool", values,
        path: [], message: `Invalid option: expected one of ${values.map((v) => `"${v}"`).join("|")}`,
      }] as any[],
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
        issues.push({ code: "too_small", origin: "file", minimum: c.value, inclusive: true, path: [], message: c.message ?? `Too small: expected file to have >=${c.value} bytes` } as any);
      else if (c.kind === "max" && data.size > c.value)
        issues.push({ code: "too_big", origin: "file", maximum: c.value, inclusive: true, path: [], message: c.message ?? `Too big: expected file to have <=${c.value} bytes` } as any);
      else if (c.kind === "size" && data.size !== c.value)
        issues.push({ code: "invalid_value", values: [c.value], path: [], message: c.message ?? `Invalid input: expected ${c.value}` } as any);
      else if (c.kind === "mime" && !c.value.some((m: string) => data.type === m || data.type.startsWith(m.split("*")[0])))
        issues.push({ code: "invalid_value", values: c.value, path: [], message: c.message ?? `Invalid input: expected ${c.value.map((m: string) => `"${m}"`).join(" | ")}` } as any);
    }
    return issues.length ? { ok: false as const, issues, aborted: isAborted(issues) } : { ok: true as const, value: data };
  }
}

export class ZodCodec<A extends ZodTypeAny, B extends ZodTypeAny>
  extends ZodType<B["_output"], A["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  protected override _runImpl(data: unknown) {
    const ir = (this._def.in as any)._run(data);
    if (!ir.ok) return ir;
    const decoded = this._def.transform(ir.value);
    return (this._def.out as any)._run(decoded);
  }
  // encode: validate against B, reverse-transform, validate against A
  encode(value: B["_output"]): A["_output"] {
    const r = (this._def.out as any).safeParse(value);
    if (!r.success) throw new ZodError(r.error.issues);
    const enc = this._def.reverseTransform(r.data);
    const er = (this._def.in as any).safeParse(enc);
    if (!er.success) throw new ZodError(er.error.issues);
    return er.data as A["_output"];
  }
  decode(value: A["_input"]): B["_output"] { return this.parse(value); }
}

// ---------- algorithmic string formats (can't be regexes) ----------
// emitted as invalid_format issues exactly like zod's ZodStringFormat defs
export class ZodAlgoFormat extends ZodType<string, string> {
  constructor(_def: { format: string; message: string; fn: (s: string) => boolean }) {
    super(); this._def = { ..._def, type: "algoformat" };
  }
  protected override _runImpl(data: unknown) {
    if (typeof data !== "string")
      return { ok: false as const, issues: [typeIssue("string", data)], aborted: true };
    if (this._def.fn(data)) return { ok: true as const, value: data };
    return {
      ok: false as const, aborted: true,
      issues: [{ code: "invalid_format", format: this._def.format, path: [], message: this._def.message }] as any[],
    };
  }
}

// Luhn, tolerating spaces/dashes like zod's credit card check
export function luhnCheck(s: string): boolean {
  const digits = s.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl && (d *= 2) > 9) d -= 9;
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

// IBAN: 2 letters + 2 digits + up to 30 alnum; mod-97 of rearranged digits == 1
export function ibanCheck(s: string): boolean {
  const ib = s.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(ib)) return false;
  let rem = 0;
  const moved = ib.slice(4) + ib.slice(0, 4);
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) rem = (rem * 10 + (code - 48)) % 97;
    else { const n = code - 55; rem = (rem * 10 + Math.floor(n / 10)) % 97; rem = (rem * 10 + (n % 10)) % 97; }
  }
  return rem === 1;
}
