// schema.ts — schema classes + chaining API (zod3-compatible surface)
import { compile, type Compiled } from "./bytecode.ts";
import { engineParse, portableEngineParse, reg, regId } from "./ffi.ts";
import * as napiBackend from "./native/napi.ts";
import { parsedTypeName, defaultMessage, applyErrorMaps } from "./shared.ts";
import { encodeValue, type HostTable } from "./codec.ts";
import { ZodError, type ZodIssue } from "./error.ts";
import { msgFns, paramMsg } from "./shared.ts";

// issues added via ctx.addIssue inside superRefine callbacks during the
// in-flight engine run; _run splices them over the engine's `custom` slots
const pendingRefineIssues: any[] = [];

// async check support: the engine is synchronous, so callbacks that
// return thenables can't complete inside it. In async mode, ZodEffects
// stages queue here and safeParseAsync replays them sequentially —
// transforms rewrite a moving value, refines gate on it.
let asyncMode = false;
const pendingAsync: { type: string; fn: (v: unknown, ctx?: any) => unknown; msg?: string; cbid?: number }[] = [];
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
    case "pipe": return s._def.in?._zod?.optin;
    case "union": case "discriminatedUnion": {
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
    case "union": case "discriminatedUnion": {
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
    case "literal": return new Set(s._def.values ?? [s._def.value]);
    case "optional": case "nullable": case "default": case "prefault":
    case "catch": case "readonly": case "brand": case "lazy":
      return inner?._zod?.values;
    case "nonoptional": {
      const v = inner?._zod?.values;
      return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
    }
    case "union": case "discriminatedUnion": {
      const os: any[] = s._def.options ?? [];
      const vs = os.map((o) => o._zod.values);
      if (vs.some((v) => v === undefined)) return undefined;
      return new Set(vs.flatMap((v: any) => [...v]));
    }
    default: return undefined;
  }
}
const _escapeRe = (v: any) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function _zodPattern(s: any): any {
  const t = s._def.type;
  if (t === "literal") {
    const vs = s._def.values ?? [s._def.value];
    if (vs.length === 1) return new RegExp(`^\\(${_escapeRe(vs[0])}\\)$`);
    return new RegExp(`^\\(${vs.map(_escapeRe).join("|")}\\)$`);
  }
  const inner = _inner(s);
  return inner?._zod?.pattern;
}

export abstract class ZodType<Output = unknown, Input = Output> {
  readonly _output!: Output;
  readonly _input!: Input;
  _def!: any;
  __zod: any;

  get _zod(): any {
    let z = this.__zod;
    if (z) return z;
    const inner = _inner(this);
    z = {
      def: this._def,
      traits: new Set([(this as any).constructor]),
      parent: this._def.parent,
      innerType: inner,
      bag: this._def.bag ?? {},
      optin: _zodOptin(this),
      optout: _zodOptout(this),
      values: _zodValues(this),
      pattern: _zodPattern(this),
      propValues: this._def.propValues,
      deferred: this._def.deferred,
      run: (v: any) => this._run(v),
      parse: (v: any) => this._run(v),
      toJSONSchema: () => (this as any).toJSONSchema?.(),
      check: (...args: any[]) => (this as any).check(...args),
    };
    this.__zod = z;
    return z;
  }

  private _compiled: Compiled | null = null;

  protected _compile(): Compiled {
    return (this._compiled ??= compile(this));
  }

  protected _run(data: unknown): { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] } {
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
            (i as any).errors = runs.map((x) => (x.ok ? [] : x.issues));
          }
        }
        if ((i as any)._u !== undefined) delete (i as any)._u;
        out.push(i);
      }
      if (spliced) { r.issues = out; aborted = isAborted(r.issues); }
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

  parse(data: unknown, params?: any): Output {
    const r = this._run(data);
    if (!r.ok) { applyErrorMaps(r.issues, params?.error ?? params); throw new ZodError(r.issues); }
    return r.value as Output;
  }

  safeParse(data: unknown, params?: any): SafeParseResult<Output> {
    const r = this._run(data);
    if (r.ok) return { success: true, data: r.value as Output };
    applyErrorMaps(r.issues, params?.error ?? params);
    return { success: false, error: new ZodError(r.issues) };
  }

  async parseAsync(data: unknown): Promise<Output> {
    const r = await this.safeParseAsync(data);
    if (!r.success) throw new ZodError(r.error.issues);
    return r.data;
  }

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
    const v = typeof value === "function" ? (value as () => V)() : value;
    return new ZodDefault({ type: "default", inner: this, value: v });
  }
  catch<V extends Input>(value: V | (() => V)): ZodCatch<this> {
    const v = typeof value === "function" ? (value as () => V)() : value;
    return new ZodCatch({ type: "catch", inner: this, value: v });
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
    return new ZodEffects({
      type: "refine", inner: this,
      cbid: regId(reg.refine, guardAsync(fn as (v: unknown) => unknown)),
      fn, kind: "refine", message: paramMsg(message),
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
  transform<N>(fn: (v: Output) => N): ZodEffects<this, N> {
    return new ZodEffects({
      type: "transform", inner: this,
      cbid: regId(reg.transform, guardAsync(fn as (v: unknown) => unknown)),
      fn, kind: "transform",
    });
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
  overwrite<N>(fn: (v: Output) => N): ZodEffects<this, N> {
    return this.transform(fn);
  }
  prefault<V extends Input>(value: V | (() => V)): ZodType<Output, Input | undefined> {
    const v = typeof value === "function" ? (value as () => V)() : value;
    return new ZodPipe({
      type: "pipe",
      in: new ZodEffects<ZodAny>({
        type: "transform", inner: new ZodAny(),
        cbid: regId(reg.transform, (x: unknown) => x === undefined ? v : x),
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
  async safeParseAsync(data: unknown, params?: any): Promise<SafeParseResult<Output>> {
    asyncMode = true;
    pendingAsync.length = 0;
    let r: { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] };
    try {
      r = this._run(data);
    } finally {
      asyncMode = false;
    }
    if (!r.ok) { applyErrorMaps(r.issues, params?.error ?? params); return { success: false, error: new ZodError(r.issues) }; }
    if (!pendingAsync.length) return { success: true, data: r.value as Output };
    let value = r.value;
    // stages can carry a path (record/object children queue nested async
    // checks) — apply them to that position, not the root
    const atPath = (v: any, p: any[] | undefined) => (p?.length ? p.reduce((o, k) => o?.[k], v) : v);
    const setPath = (v: any, p: any[] | undefined, nv: any) => {
      if (!p?.length) return nv;
      let o = v;
      for (let i = 0; i < p.length - 1; i++) o = o[p[i]];
      o[p[p.length - 1]] = nv;
      return v;
    };
    // zod collects every failed check's issue — refinements at sibling
    // positions and root-level checks all land in one error
    const allIssues: ZodIssue[] = [];
    for (const st of pendingAsync) {
      const pp = (st as any).path as any[] | undefined;
      const cur = atPath(value, pp);
      if (st.type === "transform") {
        value = setPath(value, pp, await st.fn(cur));
      } else if (st.type === "superrefine") {
        const pushed: any[] = [];
        await st.fn(cur, { addIssue: (i: any) => pushed.push(i) });
        for (const { path, ...rest } of pushed)
          allIssues.push({ ...rest, path: [...(pp ?? []), ...(path ?? [])] });
      } else {
        const res = await st.fn(cur);
        if (!res)
          allIssues.push({ code: "custom", path: pp ?? [], message: st.msg ?? "Invalid input" } as ZodIssue);
      }
    }
    if (allIssues.length) {
      applyErrorMaps(allIssues, params?.error ?? params);
      return { success: false, error: new ZodError(allIssues) };
    }
    return { success: true, data: value as Output };
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
  get minValue(): number | null {
    for (const c of this._def.checks ?? [])
      if (c.kind === "gte" || c.kind === "gt") return c.value;
    return null;
  }
  get maxValue(): number | null {
    for (const c of this._def.checks ?? [])
      if (c.kind === "lte" || c.kind === "lt") return c.value;
    return null;
  }
  get isInt(): boolean {
    return (this._def.checks ?? []).some((c: any) => c.kind === "int" || c.kind === "safeInt");
  }
  get isFinite(): boolean { return true; }
  get format(): string | null {
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
}
export class ZodNullable<T extends ZodTypeAny> extends ZodType<T["_output"] | null, T["_input"] | null> {
  constructor(_def: any) { super(); this._def = _def; }
  unwrap() { return this._def.inner as T; }
}
export class ZodDefault<T extends ZodTypeAny> extends ZodType<T["_output"], T["_input"] | undefined> {
  constructor(_def: any) { super(); this._def = _def; }
  removeDefault() { return this._def.inner as T; }
}
export class ZodCatch<T extends ZodTypeAny> extends ZodType<T["_output"], T["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  removeCatch() { return this._def.inner as T; }
}
export class ZodEffects<T extends ZodTypeAny, N = T["_output"]> extends ZodType<N, T["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  innerType() { return this._def.inner as T; }
  sourceType() { return this._def.inner as T; }

  // refine/superRefine wrap an object — object helpers delegate to the
  // inner object the way zod's checks-in-def model exposes them
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
  protected override _run(data: unknown) {
    const kind = this._def.kind ?? this._def.type;
    // coerce_* and check-record wrappers compile to engine ops — only
    // JS-callback effects (transform/refine/superrefine) run here
    if (kind !== "transform" && kind !== "superrefine" && kind !== "refine")
      return super._run(data);
    const ir = (this._def.inner as any)._run(data);
    if (!ir.ok) return ir;
    const fn = this._def.fn as (v: unknown, ctx?: any) => unknown;
    const queue = () => {
      if (!asyncMode) throw new AsyncCheckError();
      pendingAsync.push({ type: kind, fn, msg: this._def.message });
      return ir;
    };
    if (kind === "transform") {
      const r = fn(ir.value);
      if (isThenable(r)) return queue();
      return { ok: true as const, value: r };
    }
    if (kind === "superrefine") {
      const pushed: any[] = [];
      const r = fn(ir.value, { addIssue: (i: any) => pushed.push(i) });
      if (isThenable(r)) return queue();
      if (pushed.length)
        return { ok: false as const, issues: pushed.map(({ path, ...rest }: any) => ({ ...rest, path: path ?? [] })) };
      return ir;
    }
    const r = fn(ir.value);
    if (isThenable(r)) return queue();
    if (!r) return { ok: false as const, issues: [{ code: "custom", path: [], message: this._def.message ?? "Invalid input" }] as any };
    return ir;
  }
}
export class ZodPipe<A extends ZodTypeAny, B extends ZodTypeAny> extends ZodType<B["_output"], A["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
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
    // shape resolves by object spread — non-enumerable entries drop here and
    // can never be promoted into a derived shape
    const shape = _def.shape;
    if (shape && _shapeKeys(shape).length !== Reflect.ownKeys(shape).length) {
      const next: any = {};
      for (const k of _shapeKeys(shape)) _putProp(next, k, shape[k]);
      _def = { ..._def, shape: next };
    }
    this._def = _def;
  }
  get shape(): T { return this._def.shape; }

  // symbol keys can't be tagged into bytecode — the compiled engine handles
  // the string keys and symbol fields are validated here at TS level.
  // undeclared input symbols are intentionally invisible to every engine,
  // matching zod's deliberate ignore-don't-flag behavior.
  protected override _run(data: unknown) {
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
    const syms = Reflect.ownKeys(shape).filter((k): k is symbol => typeof k === "symbol");
    if (!syms.length) return super._run(input);
    const r = super._run(input);
    const out: any = r.ok ? { ...(r.value as object) } : {};
    const symIssues: any[] = [];
    if (input !== null && typeof input === "object") {
      for (const k of syms) {
        const fd: any = shape[k];
        if (!(fd instanceof ZodType))
          throw new Error(`Invalid element at key "${String(k)}"`);
        const present = k in (input as any);
        if (!present && fd._def?.type === "exactOptional") continue;
        const res = (fd as any)._run((input as any)[k]);
        if (!present && fd._zod.optin === undefined && res.ok) {
          symIssues.push({ expected: "nonoptional", code: "invalid_type",
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
    for (const k of _maskedKeys(this._def.shape, mask)) _putProp(shape, k, this._def.shape[k]);
    return new ZodObject({ ...this._def, shape, checks: [] }) as ZodObject<Pick<T, K>>;
  }
  omit<K extends keyof T>(mask: Record<K, true>) {
    if (this._def.checks?.length) throw new Error(".omit() cannot be used on object schemas containing refinements");
    const omitted = new Set(_maskedKeys(this._def.shape, mask));
    const shape: any = {};
    for (const k of _shapeKeys(this._def.shape)) if (!omitted.has(k)) _putProp(shape, k, this._def.shape[k]);
    return new ZodObject({ ...this._def, shape, checks: [] }) as ZodObject<Omit<T, K>>;
  }
  partial(mask?: Record<string, true>) {
    if (this._def.checks?.length) throw new Error(".partial() cannot be used on object schemas containing refinements");
    const sel = mask ? new Set(_maskedKeys(this._def.shape, mask)) : undefined;
    const shape: any = {};
    for (const k of _shapeKeys(this._def.shape))
      _putProp(shape, k, sel && !sel.has(k) ? this._def.shape[k] : this._def.shape[k].optional());
    return new ZodObject({ ...this._def, shape, checks: [] });
  }
  required(mask?: Record<string, true>) {
    const sel = mask ? new Set(_maskedKeys(this._def.shape, mask)) : undefined;
    const shape: any = {};
    for (const k of _shapeKeys(this._def.shape)) {
      const s = this._def.shape[k];
      _putProp(shape, k, sel && !sel.has(k) ? s : new ZodNonOptional({ inner: s }));
    }
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
    for (const k of _shapeKeys(this._def.shape)) _putProp(shape, k, this._def.shape[k]);
    for (const k of _shapeKeys(b._def.shape)) _putProp(shape, k, b._def.shape[k]);
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
    for (const k of _shapeKeys(this._def.shape)) _putProp(shape, k, this._def.shape[k]);
    for (const k of Reflect.ownKeys(s)) {
      const d = Object.getOwnPropertyDescriptor(s, k);
      if (d?.enumerable) _putProp(shape, k, (s as any)[k]);
    }
    return new ZodObject({ ...this._def, shape });
  }
}

export class ZodArray<T extends ZodTypeAny> extends ZodType<T["_output"][], T["_input"][]> {
  constructor(_def: any) { super(); this._def = _def; }
  unwrap(): T { return this._def.element; }
  get element(): T { return this._def.element; }
  min(n: number, message?: string) { return new ZodArray({ ...this._def, minLen: n, _minMsg: message }); }
  max(n: number, message?: string) { return new ZodArray({ ...this._def, maxLen: n, _maxMsg: message }); }
  length(n: number, message?: string) { return new ZodArray({ ...this._def, minLen: n, maxLen: n, exactLen: true }); }
  nonempty(message?: string) { return this.min(1, message); }
}

export class ZodTuple<Items extends ZodTypeAny[] = ZodTypeAny[]> extends ZodType<{ [k in keyof Items]: Items[k]["_output"] }> {
  constructor(_def: any) { super(); this._def = _def; }
  rest<R extends ZodTypeAny>(r: R) {
    return new ZodTuple({ ...this._def, rest: r }) as any;
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
  protected override _run(data: unknown) {
    const kt = this._def.keyType as any;
    const vt = this._def.valueType as any;
    const mode: string = this._def.mode ?? "strict";
    const partial = this._def.partial === true;
    const values = _keyUniverse(kt);
    if (data === null || typeof data !== "object" || Array.isArray(data) ||
        data instanceof Map || data instanceof Set || data instanceof Date)
      return { ok: false as const, issues: [typeIssue("record", data)], aborted: true };
    const input = data as any;
    const issues: ZodIssue[] = [];
    const out: any = {};
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
  protected override _run(data: unknown) {
    if (data === undefined) return { ok: false as const, issues: [typeIssue("nonoptional", data)], aborted: true };
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
function isAborted(issues: any[]): boolean {
  return issues.some((i) => i._nc || !CONTINUING_CODES.has(i.code));
}

function typeIssue(expected: string, received: unknown): ZodIssue {
  const recvd = parsedTypeName(received);
  // zod field order: expected first (their issues are built that way)
  return {
    expected,
    code: "invalid_type",
    path: [],
    message: `Invalid input: expected ${expected === "nan" ? "NaN" : expected}, received ${recvd}`,
  } as ZodIssue;
}

export class ZodMap<K extends ZodTypeAny, V extends ZodTypeAny>
  extends ZodType<Map<K["_output"], V["_output"]>, Map<K["_input"], V["_input"]>> {
  constructor(_def: any) { super(); this._def = _def; }

  protected override _run(data: unknown) {
    if (!(data instanceof Map)) return { ok: false as const, issues: [typeIssue("map", data)], aborted: true };
    const { keyType, valueType } = this._def as { keyType: ZodTypeAny; valueType: ZodTypeAny };
    const out = new Map();
    const issues: ZodIssue[] = [];
    for (const [k, v] of data) {
      const kr = (keyType as any)._run(k);
      const vr = (valueType as any)._run(v);
      if (!kr.ok) issues.push(...kr.issues.map((i: any) => ({ ...i, path: [k, ...(i.path ?? [])] })));
      if (!vr.ok) issues.push(...vr.issues.map((i: any) => ({ ...i, path: [k, ...(i.path ?? [])] })));
      if (kr.ok && vr.ok) out.set(kr.value, vr.value);
    }
    return issues.length ? { ok: false as const, issues, aborted: isAborted(issues) } : { ok: true as const, value: out };
  }
}

export class ZodSet<V extends ZodTypeAny>
  extends ZodType<Set<V["_output"]>, Set<V["_input"]>> {
  constructor(_def: any) { super(); this._def = _def; }

  protected override _run(data: unknown) {
    if (!(data instanceof Set)) return { ok: false as const, issues: [typeIssue("set", data)], aborted: true };
    const { valueType } = this._def as { valueType: ZodTypeAny };
    const out = new Set();
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
  // invalid_union issue; otherwise per-option errors arrays attach
}

export class ZodDiscriminatedUnion<T extends ZodTypeAny[]> extends ZodType<T[number]["_output"], T[number]["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
  get options(): T { return [...this._def.optionsMap.values()] as T; }

  override parse(data: unknown, params?: any): T[number]["_output"] {
    const r = this._run(data);
    if (!r.ok) { this._attachFields(r.issues); applyErrorMaps(r.issues, params?.error ?? params); throw new ZodError(r.issues); }
    return r.value as T[number]["_output"];
  }
  override safeParse(data: unknown, params?: any): SafeParseResult<T[number]["_output"]> {
    const r = this._run(data);
    if (r.ok) return { success: true, data: r.value as T[number]["_output"] };
    applyErrorMaps(r.issues, params?.error ?? params);
    this._attachFields(r.issues);
    return { success: false, error: new ZodError(r.issues) };
  }
  private _attachFields(issues: ZodIssue[]): void {
    for (const i of issues) {
      if (i.code === "invalid_union" && (i as any).errors === undefined) {
        (i as any).errors = [];
        (i as any).note = "No matching discriminator";
        (i as any).discriminator = this._def.disc;
        const opts = [...this._def.optionsMap.keys()];
        (i as any).options = opts;
        if (i.message === "Invalid input")
          i.message = `Invalid discriminator value. Expected ${opts.map((o) => `'${o}'`).join(" | ")}`;
      }
    }
  }
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
  protected override _run(data: unknown) {
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
      if (aggregated.length) issues.push({ ...unrecIssue, keys: aggregated });
      for (const k of both) if (!aggregated.includes(k) && keyIssues.has(k)) issues.push(keyIssues.get(k));
    }
    if (issues.length) return { ok: false as const, issues, aborted: isAborted(issues) };
    const merged = _mergeValues((l as any).value, (r as any).value);
    if (!merged.valid)
      throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
    return { ok: true as const, value: merged.data };
  }
}

export class ZodLiteral<T> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
  get value(): T { return this._def.value; }
}

export class ZodEnum<T extends string = string> extends ZodType<T> {
  constructor(_def: any) {
    super(); this._def = _def;
    if (!_def.entries && Array.isArray(_def.values))
      _def.entries = Object.fromEntries(_def.values.map((v: string) => [v, v]));
  }
  // the bytecode enum node is string-members-only — native enums with
  // numeric members check at the TS level
  protected override _run(data: unknown) {
    const vals: any[] = this._def.values;
    if (vals.every((v) => typeof v === "string")) return super._run(data);
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
  get schema(): T { return this._def.getter(); }
}

export class ZodInstanceof<T> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
}

export class ZodPromise<T extends ZodTypeAny> extends ZodType<Promise<T["_output"]>, Promise<T["_input"]>> {
  constructor(_def: any = { type: "instof", ctor: Promise, name: "promise", inner: null }) {
    super(); this._def = _def;
  }
  private _syncThrow(): never {
    throw new Error("Encountered Promise during synchronous parse. Use .parseAsync() instead.");
  }
  override parse(_: unknown): never { this._syncThrow(); }
  override safeParse(_: unknown): never { this._syncThrow(); }
  override async safeParseAsync(data: unknown): Promise<SafeParseResult<Promise<T["_output"]>>> {
    const instof = new ZodInstanceof({ type: "instof", ctor: Promise, name: "promise" });
    const r = instof.safeParse(data);
    if (!r.success) return r as any;
    const p = r.data as Promise<unknown>;
    const inner = this._def.inner as T;
    try {
      const resolved = await p;
      const ir = inner.safeParse(resolved);
      if (!ir.success) return ir as any;
      return { success: true, data: ir.data as any };
    } catch (e) {
      return { success: false, error: new ZodError([{ code: "custom", path: [], message: String(e) } as any]) };
    }
  }
  override parseAsync(data: unknown) { return super.parseAsync(data); }
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
  protected override _run(data: unknown) {
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
  protected override _run(data: unknown) {
    const opts = this._def.options as ZodTypeAny[];
    const runs = opts.map((o) => (o as any)._run(data));
    const wins = runs.filter((r: any) => r.ok);
    if (wins.length === 1) return wins[0];
    if (wins.length === 0) {
      return {
        ok: false as const, aborted: true,
        issues: [{
          code: "invalid_union", errors: runs.map((r: any) => r.issues ?? []),
          path: [], message: "Invalid input",
        }] as any[],
      };
    }
    return {
      ok: false as const, aborted: true,
      issues: [{
        code: "invalid_union", errors: [], inclusive: false,
        matches: runs.map((r: any, i: number) => (r.ok ? i : -1)).filter((i: number) => i >= 0),
        path: [], message: "Invalid input: more than one option matched",
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
  protected override _run(data: unknown) {
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
  protected override _run(data: unknown) {
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
  protected override _run(data: unknown) {
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
