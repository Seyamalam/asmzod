// schema.ts — schema classes + chaining API (zod3-compatible surface)
import { compile, type Compiled } from "./bytecode";
import { engineParse, reg, regId } from "./ffi";
import { encodeValue, type HostTable } from "./codec";
import { ZodError, type ZodIssue } from "./error";

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

  private _run(data: unknown): { ok: true; value: unknown } | { ok: false; issues: ZodIssue[] } {
    const c = this._compile();
    const hosts: HostTable = [...c.hosts];
    const input = encodeValue(data, hosts);
    return engineParse(c.blob, input, hosts);
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
    // superRefine can emit multiple issues — approximate: first added issue wins
    return new ZodEffects({
      type: "refine", inner: this,
      cbid: regId(reg.refine, ((v: unknown) => {
        let ok = true;
        fn(v as Output, { addIssue: (i: any) => { ok = false; } });
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
  constructor(public issue: any) { super(issue.message ?? "invalid"); }
}

export type ZodTypeAny = ZodType<any, any>;

// ---------- primitives ----------
export class ZodString extends ZodType<string> {
  constructor(public _def: any = { type: "string", checks: [] }) { super(); }
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
  constructor(public _def: any = { type: "number", checks: [] }) { super(); }
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
  constructor(public _def: any = { type: "bigint", checks: [] }) { super(); }
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
  constructor(public _def: any = { type: "boolean" }) { super(); }
}
export class ZodAny extends ZodType<any> {
  constructor(public _def: any = { type: "any" }) { super(); }
}
export class ZodUnknown extends ZodType<unknown> {
  constructor(public _def: any = { type: "unknown" }) { super(); }
}
export class ZodNever extends ZodType<never> {
  constructor(public _def: any = { type: "never" }) { super(); }
}
export class ZodNull extends ZodType<null> {
  constructor(public _def: any = { type: "null" }) { super(); }
}
export class ZodUndefined extends ZodType<undefined> {
  constructor(public _def: any = { type: "undefined" }) { super(); }
}
export class ZodVoid extends ZodType<void> {
  constructor(public _def: any = { type: "void" }) { super(); }
}
export class ZodNaN extends ZodType<number> {
  constructor(public _def: any = { type: "nan" }) { super(); }
}
export class ZodSymbol extends ZodType<symbol> {
  constructor(public _def: any = { type: "symbol" }) { super(); }
}

export class ZodDate extends ZodType<Date> {
  constructor(public _def: any = { type: "date", checks: [] }) { super(); }
  private _check(c: any) { return new ZodDate({ ...this._def, checks: [...this._def.checks, c] }); }
  min(d: Date, message?: string) { return this._check({ kind: "min", value: d.getTime(), message }); }
  max(d: Date, message?: string) { return this._check({ kind: "max", value: d.getTime(), message }); }
}

// ---------- wrappers ----------
export class ZodOptional<T extends ZodTypeAny> extends ZodType<T["_output"] | undefined, T["_input"] | undefined> {
  constructor(public _def: any) { super(); }
  unwrap() { return this._def.inner as T; }
}
export class ZodNullable<T extends ZodTypeAny> extends ZodType<T["_output"] | null, T["_input"] | null> {
  constructor(public _def: any) { super(); }
  unwrap() { return this._def.inner as T; }
}
export class ZodDefault<T extends ZodTypeAny> extends ZodType<T["_output"], T["_input"] | undefined> {
  constructor(public _def: any) { super(); }
  removeDefault() { return this._def.inner as T; }
}
export class ZodCatch<T extends ZodTypeAny> extends ZodType<T["_output"], T["_input"]> {
  constructor(public _def: any) { super(); }
  removeCatch() { return this._def.inner as T; }
}
export class ZodEffects<T extends ZodTypeAny, N = T["_output"]> extends ZodType<N, T["_input"]> {
  constructor(public _def: any) { super(); }
  innerType() { return this._def.inner as T; }
  sourceType() { return this._def.inner as T; }
}
export class ZodPipe<A extends ZodTypeAny, B extends ZodTypeAny> extends ZodType<B["_output"], A["_input"]> {
  constructor(public _def: any) { super(); }
}
export class ZodBranded<T extends ZodTypeAny, B extends string> extends ZodType<T["_output"] & { __brand: B }, T["_input"]> {
  constructor(public _def: any) { super(); }
}

// ---------- composites ----------
export type ZodRawShape = { [k: string]: ZodTypeAny };

export class ZodObject<T extends ZodRawShape> extends ZodType<objectOutputType<T>, objectInputType<T>> {
  constructor(public _def: any) { super(); }
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
      while (s instanceof ZodOptional) s = s.unwrap();
      shape[k] = s;
    }
    return new ZodObject({ ...this._def, shape });
  }
  keyof() { return new ZodEnum({ type: "enum", values: Object.keys(this._def.shape) }); }
  deepPartial() { return this.partial(); }
}

export class ZodArray<T extends ZodTypeAny> extends ZodType<T["_output"][], T["_input"][]> {
  constructor(public _def: any) { super(); }
  get element(): T { return this._def.element; }
  min(n: number, message?: string) { return new ZodArray({ ...this._def, minLen: n, _minMsg: message }); }
  max(n: number, message?: string) { return new ZodArray({ ...this._def, maxLen: n, _maxMsg: message }); }
  length(n: number, message?: string) { return new ZodArray({ ...this._def, minLen: n, maxLen: n }); }
  nonempty(message?: string) { return this.min(1, message); }
}

export class ZodTuple<Items extends ZodTypeAny[] = ZodTypeAny[]> extends ZodType<{ [k in keyof Items]: Items[k]["_output"] }> {
  constructor(public _def: any) { super(); }
  rest<R extends ZodTypeAny>(r: R) {
    return new ZodTuple({ ...this._def, rest: r }) as ZodTuple<[...Items, ...R[]]>;
  }
}

export class ZodRecord<K extends ZodTypeAny, V extends ZodTypeAny> extends ZodType<Record<string, V["_output"]>> {
  constructor(public _def: any) { super(); }
}

export class ZodUnion<T extends ZodTypeAny[]> extends ZodType<T[number]["_output"], T[number]["_input"]> {
  constructor(public _def: any) { super(); }
  get options(): T { return this._def.options; }
}

export class ZodDiscriminatedUnion<T extends ZodTypeAny[]> extends ZodType<T[number]["_output"], T[number]["_input"]> {
  constructor(public _def: any) { super(); }
  get options(): T { return [...this._def.optionsMap.values()] as T; }
}

export class ZodIntersection<A extends ZodTypeAny, B extends ZodTypeAny> extends ZodType<A["_output"] & B["_output"], A["_input"] & B["_input"]> {
  constructor(public _def: any) { super(); }
}

export class ZodLiteral<T> extends ZodType<T> {
  constructor(public _def: any) { super(); }
  get value(): T { return this._def.value; }
}

export class ZodEnum<T extends string = string> extends ZodType<T> {
  constructor(public _def: any) { super(); }
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
  constructor(public _def: any) { super(); }
  get schema(): T { return this._def.getter(); }
}

export class ZodInstanceof<T> extends ZodType<T> {
  constructor(public _def: any) { super(); }
}

export class ZodCustom<T> extends ZodType<T> {
  constructor(public _def: any) { super(); }
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
