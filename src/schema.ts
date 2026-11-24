// schema.ts — schema classes + chaining API (zod3-compatible surface)
import { compile, type Compiled } from "./bytecode.ts";
import { engineParse, reg, regId } from "./ffi.ts";
import * as napiBackend from "./native/napi.ts";
import { parsedTypeName, defaultMessage } from "./shared.ts";
import { encodeValue, type HostTable } from "./codec.ts";
import { ZodError, type ZodIssue } from "./error.ts";

// issues added via ctx.addIssue inside superRefine callbacks during the
// in-flight engine run; _run splices them over the engine's `custom` slots
const pendingRefineIssues: any[] = [];

export type ParsePath = (string | number)[];
export interface SafeParseSuccess<T> { success: true; data: T }
export interface SafeParseFail { success: false; error: ZodError }
export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseFail;

export abstract class ZodType<Output = unknown, Input = Output> {
  readonly _output!: Output;
  readonly _input!: Input;
  abstract _def: any;

  private _compiled: Compiled | null = null;

  protected _compile(): Compiled {
    return (this._compiled ??= compile(this));
  }

  protected _run(data: unknown): { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] } {
    const c = this._compile();
    const hosts: HostTable = [...c.hosts];
    // direct N-API validation walks the JS value natively (no encode/decode);
    // null -> schema needs the encoded engine path (callbacks, unions, ...)
    const nr = napiBackend.parse(c.blob, data, hosts, c.cbUnsafe);
    const r = nr ?? engineParse(c.blob, encodeValue(data, hosts), hosts);
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

  parse(data: unknown): Output {
    const r = this._run(data);
    if (!r.ok) throw new ZodError(r.issues);
    return r.value as Output;
  }

  safeParse(data: unknown): SafeParseResult<Output> {
    const r = this._run(data);
    if (r.ok) return { success: true, data: r.value as Output };
    return { success: false, error: new ZodError(r.issues) };
  }

  parseAsync(_: unknown): Promise<Output> {
    return Promise.reject(new Error("asmzod: parseAsync is not supported (synchronous engine)"));
  }
  safeParseAsync(_: unknown): Promise<SafeParseResult<Output>> {
    return Promise.reject(new Error("asmzod: safeParseAsync is not supported (synchronous engine)"));
  }
  async parseAsync(data: unknown): Promise<Output> {
    const r = await this.safeParseAsync(data);
    if (!r.success) throw new ZodError(r.error.issues);
    return r.data;
  }

  optional(): ZodOptional<this> {
    return new ZodOptional({ type: "optional", inner: this });
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
  refine(fn: (v: Output) => boolean, message?: string): ZodEffects<this, Output> {
    return new ZodEffects({
      type: "refine", inner: this,
      cbid: regId(reg.refine, fn as (v: unknown) => unknown),
      message,
    });
  }
  refinement(fn: (v: Output) => boolean, message?: string): ZodEffects<this, Output> {
    return this.refine(fn, message);
  }
  superRefine(fn: (v: Output, ctx: { addIssue: (i: any) => void }) => void): ZodEffects<this, Output> {
    return new ZodEffects({
      type: "refine", inner: this,
      cbid: regId(reg.refine, ((v: unknown) => {
        let ok = true;
        fn(v as Output, {
          addIssue: (i: any) => { ok = false; pendingRefineIssues.push(i); },
        });
        return ok;
      }) as (v: unknown) => unknown),
      message: undefined,
    });
  }
  transform<N>(fn: (v: Output) => N): ZodEffects<this, N> {
    return new ZodEffects({
      type: "transform", inner: this,
      cbid: regId(reg.transform, fn as (v: unknown) => unknown),
    });
  }
  pipe<T extends ZodTypeAny>(target: T): ZodPipe<this, T> {
    return new ZodPipe({ type: "pipe", in: this, out: target });
  }
  brand<B extends string>(): ZodBranded<this, B> {
    return new ZodBranded({ type: "brand", inner: this });
  }
  describe(_: string): this { return this; }
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
  private _check(c: any) { return new ZodString({ ...this._def, checks: [...this._def.checks, c] }); }
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
}

export class ZodNumber extends ZodType<number> {
  constructor(_def: any = { type: "number", checks: [] }) { super(); this._def = _def; }
  private _check(c: any) { return new ZodNumber({ ...this._def, checks: [...this._def.checks, c] }); }
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
}

export class ZodBigInt extends ZodType<bigint> {
  constructor(_def: any = { type: "bigint", checks: [] }) { super(); this._def = _def; }
  private _check(c: any) { return new ZodBigInt({ ...this._def, checks: [...this._def.checks, c] }); }
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
  private _check(c: any) { return new ZodDate({ ...this._def, checks: [...this._def.checks, c] }); }
  min(d: Date, message?: string) { return this._check({ kind: "min", value: d.getTime(), message }); }
  max(d: Date, message?: string) { return this._check({ kind: "max", value: d.getTime(), message }); }
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
}
export class ZodPipe<A extends ZodTypeAny, B extends ZodTypeAny> extends ZodType<B["_output"], A["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
}
export class ZodBranded<T extends ZodTypeAny, B extends string> extends ZodType<T["_output"] & { __brand: B }, T["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
}

// ---------- composites ----------
export type ZodRawShape = { [k: string]: ZodTypeAny };

export class ZodObject<T extends ZodRawShape> extends ZodType<objectOutputType<T>, objectInputType<T>> {
  constructor(_def: any) { super(); this._def = _def; }
  get shape(): T { return this._def.shape; }
  strict() { return new ZodObject({ ...this._def, mode: "strict" }); }
  strip() { return new ZodObject({ ...this._def, mode: "strip" }); }
  passthrough() { return new ZodObject({ ...this._def, mode: "passthrough" }); }
  catchall<C extends ZodTypeAny>(c: C) { return new ZodObject({ ...this._def, catchall: c }); }
  extend<S extends ZodRawShape>(s: S) {
    return new ZodObject({ ...this._def, shape: { ...this._def.shape, ...s } }) as ZodObject<T & S>;
  }
  pick<K extends keyof T>(mask: Record<K, true>) {
    const shape: any = {};
    for (const k of Object.keys(mask)) if (mask[k as K]) shape[k] = this._def.shape[k];
    return new ZodObject({ ...this._def, shape }) as ZodObject<Pick<T, K>>;
  }
  omit<K extends keyof T>(mask: Record<K, true>) {
    const shape: any = { ...this._def.shape };
    for (const k of Object.keys(mask)) if (mask[k as K]) delete shape[k];
    return new ZodObject({ ...this._def, shape }) as ZodObject<Omit<T, K>>;
  }
  partial() {
    const shape: any = {};
    for (const k of Object.keys(this._def.shape)) shape[k] = this._def.shape[k].optional();
    return new ZodObject({ ...this._def, shape });
  }
  required() {
    const shape: any = {};
    for (const k of Object.keys(this._def.shape)) {
      let s = this._def.shape[k];
      let wasOpt = false;
      while (s instanceof ZodOptional) { wasOpt = true; s = s.unwrap(); }
      shape[k] = wasOpt ? new ZodNonOptional({ inner: s }) : s;
    }
    return new ZodObject({ ...this._def, shape });
  }
  keyof() { return new ZodEnum({ type: "enum", values: Object.keys(this._def.shape) }); }
  deepPartial() { return this.partial(); }
}

export class ZodArray<T extends ZodTypeAny> extends ZodType<T["_output"][], T["_input"][]> {
  constructor(_def: any) { super(); this._def = _def; }
  get element(): T { return this._def.element; }
  min(n: number, message?: string) { return new ZodArray({ ...this._def, minLen: n, _minMsg: message }); }
  max(n: number, message?: string) { return new ZodArray({ ...this._def, maxLen: n, _maxMsg: message }); }
  length(n: number, message?: string) { return new ZodArray({ ...this._def, minLen: n, maxLen: n, exactLen: true }); }
  nonempty(message?: string) { return this.min(1, message); }
}

export class ZodTuple<Items extends ZodTypeAny[] = ZodTypeAny[]> extends ZodType<{ [k in keyof Items]: Items[k]["_output"] }> {
  constructor(_def: any) { super(); this._def = _def; }
  rest<R extends ZodTypeAny>(r: R) {
    return new ZodTuple({ ...this._def, rest: r }) as ZodTuple<[...Items, ...R[]]>;
  }
}

export class ZodRecord<K extends ZodTypeAny, V extends ZodTypeAny> extends ZodType<Record<string, V["_output"]>> {
  constructor(_def: any) { super(); this._def = _def; }
}

// Map/Set: the container walk is JS (can't enumerate a Map in machine
// code), but every key/value still validates through the ARM64 engine.
export class ZodNonOptional<T extends ZodTypeAny = ZodTypeAny> extends ZodType<NonNullable<T["_output"]>, T["_input"]> {
  constructor(_def: any) { super(); this._def = { ..._def, type: "nonoptional" }; }
  protected override _run(data: unknown) {
    if (data === undefined) return { ok: false as const, issues: [typeIssue("nonoptional", data)], aborted: true };
    return (this._def.inner as ZodTypeAny)._run(data);
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
  return {
    code: "invalid_type",
    path: [],
    expected,
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
      const kr = keyType._run(k);
      const vr = valueType._run(v);
      if (!kr.ok) issues.push(...kr.issues.map((i) => ({ ...i, path: [k, ...(i.path ?? [])] })));
      if (!vr.ok) issues.push(...vr.issues.map((i) => ({ ...i, path: [k, ...(i.path ?? [])] })));
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
      const r = valueType._run(v);
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

  override parse(data: unknown): T[number]["_output"] {
    const r = this._run(data);
    if (!r.ok) { this._attachFields(r.issues); throw new ZodError(r.issues); }
    return r.value as T[number]["_output"];
  }
  override safeParse(data: unknown): SafeParseResult<T[number]["_output"]> {
    const r = this._run(data);
    if (r.ok) return { success: true, data: r.value as T[number]["_output"] };
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

export class ZodIntersection<A extends ZodTypeAny, B extends ZodTypeAny> extends ZodType<A["_output"] & B["_output"], A["_input"] & B["_input"]> {
  constructor(_def: any) { super(); this._def = _def; }
}

export class ZodLiteral<T> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
  get value(): T { return this._def.value; }
}

export class ZodEnum<T extends string = string> extends ZodType<T> {
  constructor(_def: any) { super(); this._def = _def; }
  get options(): T[] { return this._def.values; }
  get enum(): Record<T, T> {
    return Object.fromEntries(this._def.values.map((v: string) => [v, v]));
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
