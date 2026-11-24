// index.ts — the z factory object + public exports
import {
  ZodString, ZodNumber, ZodBigInt, ZodBoolean, ZodAny, ZodUnknown, ZodNever,
  ZodNull, ZodUndefined, ZodVoid, ZodNaN, ZodSymbol, ZodDate, ZodObject,
  ZodArray, ZodTuple, ZodRecord, ZodUnion, ZodDiscriminatedUnion,
  ZodIntersection, ZodLiteral, ZodEnum, ZodLazy, ZodInstanceof, ZodCustom,
  ZodOptional, ZodNullable, ZodDefault, ZodCatch, ZodEffects, ZodPipe,
  ZodBranded, ZodMap, ZodSet, ZodType, ZodPromise, ZodFunction,
  ZodStringbool, ZodXor, ZodFile, ZodCodec,
  ZodAlgoFormat, luhnCheck, ibanCheck,
  type ZodTypeAny, type ZodRawShape,
} from "./schema.ts";
import { reg, regId } from "./ffi.ts";
import { configure, setErrorMap, getErrorMap } from "./shared.ts";

export * from "./schema.ts";
export * from "./error.ts";
export { engineVersion, engineBackend } from "./ffi.ts";

// factory params: { checks: [z.minLength(1), z.check(fn)], error|message... }
const mk = (Cls: any, type: string, params: any, checks: any[] = []): any => {
  const pc = params && typeof params === "object" && !Array.isArray(params) ? params.checks : undefined;
  const all = [...checks, ...(Array.isArray(pc) ? pc : [])];
  const fns = all.filter((c: any) => typeof c === "function" || c?.kind === "checkfn")
    .map((c: any) => (typeof c === "function" ? c : c.fn));
  let s: any = new Cls({
    type,
    checks: all.filter((c: any) => typeof c !== "function" && c?.kind !== "checkfn"),
    error: params,
  });
  if (fns.length) s = s.check(...fns);
  return s;
};

export const z = {
  /** Create a string schema. */
  string: (params?: any) => mk(ZodString, "string", params),
  /** Create a number schema (rejects NaN/Infinity by default, like zod). */
  number: (params?: any) => mk(ZodNumber, "number", params),
  /** Create a bigint schema. */
  bigint: (params?: any) => mk(ZodBigInt, "bigint", params),
  /** Create a boolean schema. */
  boolean: (params?: any) => mk(ZodBoolean, "boolean", params),
  /** Create a Date schema. */
  date: (params?: any) => mk(ZodDate, "date", params),
  /** Create a symbol schema. */
  symbol: (params?: any) => mk(ZodSymbol, "symbol", params),
  /** Schema that accepts any value. */
  any: (params?: any) => mk(ZodAny, "any", params),
  /** Schema that accepts any value typed as unknown. */
  unknown: (params?: any) => mk(ZodUnknown, "unknown", params),
  /** Schema that rejects every value. */
  never: (params?: any) => mk(ZodNever, "never", params),
  /** Schema accepting only null. */
  null: (params?: any) => mk(ZodNull, "null", params),
  /** Schema accepting only undefined. */
  undefined: (params?: any) => mk(ZodUndefined, "undefined", params),
  /** Schema accepting only undefined (void). */
  void: (params?: any) => mk(ZodVoid, "void", params),
  /** Schema accepting only NaN. */
  nan: (params?: any) => mk(ZodNaN, "nan", params),

  /** Create an object schema; unknown keys are stripped. */
  object: <T extends ZodRawShape>(shape: T, params?: any) =>
    new ZodObject<T>({ type: "object", shape, mode: "strip", catchall: null, error: params }),
  /** Create an object schema that fails on unknown keys. */
  strictObject: <T extends ZodRawShape>(shape: T, params?: any) =>
    new ZodObject<T>({ type: "object", shape, mode: "strict", catchall: null, error: params }),
  /** Create an object schema that passes unknown keys through. */
  looseObject: <T extends ZodRawShape>(shape: T, params?: any) =>
    new ZodObject<T>({ type: "object", shape, mode: "passthrough", catchall: null, error: params }),
  /** Schema for Promise instances. */
  promise: <T extends ZodTypeAny>(inner: T) =>
    new ZodPromise<T>({ type: "instof", ctor: Promise, name: "promise", inner }),
  /** Schema for functions, optionally validating args/return. */
  function: (opts?: { input?: ZodTypeAny[]; output?: ZodTypeAny }) =>
    new ZodFunction({
      type: "instof", ctor: Function, name: "function",
      args: opts?.input ?? null, ret: opts?.output ?? null,
    }),
  /** Run a transform on the input before validating with the given schema. */
  preprocess: <T extends ZodTypeAny>(fn: (v: unknown) => unknown, schema: T) =>
    new ZodPipe<ZodEffects<ZodAny>, T>({
      type: "pipe",
      in: new ZodEffects<ZodAny>({ type: "transform", inner: new ZodAny(), cbid: regId(reg.transform, fn) }),
      out: schema,
    }),

  /** Create an array schema for the element type. */
  array: <T extends ZodTypeAny>(element: T, params?: any) =>
    new ZodArray<T>({ type: "array", element, error: params }),
  /** Create a fixed-length tuple schema. */
  tuple: <T extends ZodTypeAny[]>(items: [...T], params?: any) =>
    new ZodTuple<T>({ type: "tuple", items, rest: null, error: params }),
  /** Create a record schema: record(valueType) or record(keyType, valueType). */
  record: ((keyOrVal: ZodTypeAny, val?: ZodTypeAny) =>
    val === undefined
      ? new ZodRecord({ type: "record", keyType: null, valueType: keyOrVal })
      : new ZodRecord({ type: "record", keyType: keyOrVal, valueType: val })) as {
    <V extends ZodTypeAny>(value: V): ZodRecord<ZodString, V>;
    <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V): ZodRecord<K, V>;
  },
  /** Create a Map schema. */
  map: <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V) =>
    new ZodMap<K, V>({ type: "map", keyType: key, valueType: value }),
  /** Create a Set schema. */
  set: <V extends ZodTypeAny>(value: V) =>
    new ZodSet<V>({ type: "set", valueType: value }),
  /** Record where the enum key set is optional; other keys rejected. */
  partialRecord: <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V) =>
    new ZodRecord<K, V>({ type: "record", keyType: key, valueType: value, recordMode: "partial" }),
  /** Record where all enum keys are required and other keys pass through. */
  looseRecord: <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V) =>
    new ZodRecord<K, V>({ type: "record", keyType: key, valueType: value, recordMode: "loose" }),
  /** Enum of an object schema's keys. */
  keyof: <T extends ZodTypeAny>(schema: T) => (schema as any).keyof(),
  /** Exactly one option must match. */
  xor: <T extends ZodTypeAny[]>(options: [...T], params?: any) =>
    new ZodXor<T>({ type: "union", options, error: params }),
  /** Parses boolean-ish strings ("true"/"yes"/"on"/"0"/"off"/...) to booleans. */
  stringbool: (params?: any) => new ZodStringbool({ type: "stringbool", error: params }),
  /** File schema with .min/.max/.size (bytes) and .mime checks. */
  file: (params?: any) => mk(ZodFile, "file", params),
  /** Bidirectional codec: parse via decode (in->out), .encode() via encode. */
  codec: <A extends ZodTypeAny, B extends ZodTypeAny>(
    inSchema: A, outSchema: B,
    params: { decode: (v: A["_output"]) => B["_input"]; encode: (v: B["_output"]) => A["_input"] },
  ) => new ZodCodec<A, B>({
    type: "codec", in: inSchema, out: outSchema,
    transform: params.decode, reverseTransform: params.encode,
  }),
  /** Check factory for use with .check(...). */
  check: (fn: (ctx: any) => void) => ({ kind: "checkfn", fn }),

  /** Try each option in order; first success wins. */
  union: <T extends ZodTypeAny[]>(options: [...T], params?: any) =>
    new ZodUnion<T>({ type: "union", options, error: params }),
  /** Union of objects routed by a shared discriminator key. */
  discriminatedUnion: <T extends ZodTypeAny[]>(disc: string, options: [...T]) => {
    const optionsMap = new Map<string, ZodTypeAny>();
    for (const o of options) {
      const lit = o._def?.shape?.[disc]?._def?.value;
      if (lit === undefined)
        throw new Error(`asmzod: discriminatedUnion option missing literal "${disc}"`);
      optionsMap.set(String(lit), o);
    }
    return new ZodDiscriminatedUnion<T>({ type: "discunion", disc, optionsMap });
  },
  /** Value must satisfy both schemas. */
  intersection: <A extends ZodTypeAny, B extends ZodTypeAny>(l: A, r: B) =>
    new ZodIntersection<A, B>({ type: "intersect", left: l, right: r }),

  /** Schema accepting exactly the given literal(s). */
  literal: <T extends string | number | boolean | bigint | null | undefined>(v: T, params?: any) =>
    new ZodLiteral<T>({ type: "literal", value: v, error: params }),
  /** Schema for a fixed set of string values (or a TS enum). */
  enum: <T extends string>(values: [T, ...T[]], params?: any) =>
    new ZodEnum<T>({ type: "enum", values, error: params }),
  /** Schema for a TS enum object (alias of enum). */
  nativeEnum: (e: object) => {
    const vals = Object.values(e).filter((v) => typeof v === "string");
    return new ZodEnum({ type: "enum", values: vals });
  },

  /** Defer schema resolution for recursive types. */
  lazy: <T extends ZodTypeAny>(getter: () => T) =>
    new ZodLazy<T>({ type: "lazy", getter }),
  /** Schema checking value instanceof the constructor. */
  instanceof: <T>(ctor: new (...a: any[]) => T) =>
    new ZodInstanceof<T>({ type: "instof", ctor, name: ctor.name ?? "object" }),
  /** Schema gated by an arbitrary predicate. */
  custom: <T>(fn: (v: unknown) => boolean, message?: string) =>
    new ZodCustom<T>({ type: "custom", cbid: regId(reg.custom, fn), message }),

  /** Coercion namespace: coerce.string/number/boolean/date/bigint. */
  coerce: {
    /** Create a string schema. */
    string: (params?: any) => new ZodEffects<ZodString, string>({
      type: "coerce_str",
      inner: mk(ZodString, "string", params),
    }),
    /** Create a number schema (rejects NaN/Infinity by default, like zod). */
    number: (params?: any) => new ZodEffects<ZodNumber, number>({
      type: "coerce_num",
      inner: mk(ZodNumber, "number", params),
    }),
    /** Create a boolean schema. */
    boolean: (params?: any) => new ZodEffects<ZodBoolean, boolean>({
      type: "coerce_bool",
      inner: mk(ZodBoolean, "boolean", params),
    }),
    /** Create a bigint schema. */
    bigint: (params?: any) => new ZodEffects<ZodBigInt, bigint>({
      type: "coerce_bigint",
      inner: mk(ZodBigInt, "bigint", params),
    }),
    /** Create a Date schema. */
    date: () => {
      // coerce to date needs a JS callback — implement via custom transform later
      throw new Error("asmzod: z.coerce.date() not supported in v1");
    },
  },

  /** Schema that also accepts undefined. */
  optional: <T extends ZodTypeAny>(s: T) => new ZodOptional<T>({ type: "optional", inner: s }),
  /** Schema that also accepts null. */
  nullable: <T extends ZodTypeAny>(s: T) => new ZodNullable<T>({ type: "nullable", inner: s }),
  /** Schema that also accepts null and undefined. */
  nullish: <T extends ZodTypeAny>(s: T) => new ZodNullable<T>({ type: "nullable", inner: s }).optional(),
  /** Substitute a default value when input is undefined. */
  default: <T extends ZodTypeAny>(s: T, v: T["_input"]) =>
    new ZodDefault<T>({ type: "default", inner: s, value: v }),
  /** Substitute a value when the inner schema fails. */
  catch: <T extends ZodTypeAny>(s: T, v: T["_input"]) => s.catch(v),
  /** Compile-time brand (no runtime effect). */
  brand: <T extends ZodTypeAny>(s: T) => s.brand(),
  nonoptional: <T extends ZodTypeAny>(s: T) => s.nonoptional(),
  /** Validate then freeze the output. */
  readonly: <T extends ZodTypeAny>(s: T) => s.readonly(),
  /** Add a custom check; fails with invalid_type when falsy. */
  refine: (fn: (v: unknown) => boolean, message?: string) =>
    new ZodAny().refine(fn, message),
  superRefine: (fn: (v: unknown, ctx: any) => void) =>
    new ZodAny().superRefine(fn),
  /** Map the parsed value through a function. */
  transform: (fn: (v: unknown) => unknown) => new ZodAny().transform(fn),

  // string-format factories — equivalent to z.string().<fmt>()
  /** Alias of z.string().email(). */
  email: (p?: string) => new ZodString().email(p),
  /** Alias of z.string().url(). */
  url: (p?: string) => new ZodString().url(p),
  /** Alias of z.string().uuid(). */
  uuid: (p?: string) => new ZodString().uuid(p),
  uuidv4: (p?: string) => new ZodString().uuidv4(p),
  uuidv6: (p?: string) => new ZodString().uuidv6(p),
  uuidv7: (p?: string) => new ZodString().uuidv7(p),
  guid: (p?: string) => new ZodString().guid(p),
  /** Alias of z.string().cuid(). */
  cuid: (p?: string) => new ZodString().cuid(p),
  /** Alias of z.string().cuid2(). */
  cuid2: (p?: string) => new ZodString().cuid2(p),
  /** Alias of z.string().ulid(). */
  ulid: (p?: string) => new ZodString().ulid(p),
  /** Alias of z.string().nanoid(). */
  nanoid: (p?: string) => new ZodString().nanoid(p),
  /** Alias of z.string().emoji(). */
  emoji: (p?: string) => new ZodString().emoji(p),
  /** Alias of z.string().base64(). */
  base64: (p?: string) => new ZodString().base64(p),
  /** Alias of z.string().base64url(). */
  base64url: (p?: string) => new ZodString().base64url(p),
  jwt: (p?: string) => new ZodString().jwt(p),
  hex: (p?: string) => new ZodString().hex(p),
  xid: (p?: string) => new ZodString().xid(p),
  ksuid: (p?: string) => new ZodString().ksuid(p),
  // [bodylen, alpha 0hex/1b64/2b64url, padlen] per zod4 fixedBase64 tables
  /** Hex-digest format: z.hash('md5'|'sha1'|'sha256'|'sha384'|'sha512'). */
  hash: (alg: string, params?: any) => {
    const enc = (typeof params === "object" && params !== null ? params.enc : undefined) ?? "hex";
    const fmt = `${alg}_${enc}`;
    const t = (HASH_LENS as Record<string, readonly [number, number, number]>)[fmt];
    if (!t) throw new Error(`Unrecognized hash format: ${fmt}`);
    return (new ZodString() as any)._check({ kind: "hash", body: t[0], alpha: t[1], pad: t[2], format: fmt, message: params });
  },
  /** Bigint constrained to [0, 2^64-1]. */
  uint64: (params?: any) =>
    mk(ZodBigInt, "bigint", params)
      .min(0n).max(18446744073709551615n),
  e164: (p?: string) => new ZodString().e164(p),
  duration: (p?: string) => new ZodString().duration(p),
  /** Alias of z.string().ipv4(). */
  ipv4: (p?: string) => new ZodString().ipv4(p),
  /** Alias of z.string().ipv6(). */
  ipv6: (p?: string) => new ZodString().ipv6(p),
  /** Alias of z.string().cidrv4(). */
  cidrv4: (p?: string) => new ZodString().cidrv4(p),
  /** Alias of z.string().cidrv6(). */
  cidrv6: (p?: string) => new ZodString().cidrv6(p),
  hostname: (p?: string) => new ZodString().hostname(p),
  httpUrl: (p?: string) => new ZodString().httpUrl(p),
  /** Set global config params (e.g. customError) like z.config in zod 4. */
  config: (opts: any) => configure(opts),
  /** Set the global error map. */
  setErrorMap: (fn?: (i: any) => string | undefined) => setErrorMap(fn),
  getErrorMap: () => getErrorMap(),
  /** ISO 8601 formats: iso.date/datetime/time/duration. */
  iso: {
    datetime: (p?: string) => new ZodString().datetime(p),
    /** Create a Date schema. */
    date: (p?: string) => new ZodString().date(p),
    time: (p?: string) => new ZodString().time(p),
    duration: (p?: string) => new ZodString().duration(p),
  },

  templateLiteral: (parts: readonly unknown[]) => {
    // zod4: composes parts into a regex; schemas contribute their pattern
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pat = parts.map((p) => {
      if (p instanceof ZodString) return ".*";
      if (p instanceof ZodNumber || p instanceof ZodBigInt) return "-?\\d+(?:\\.\\d+)?";
      if (p instanceof ZodLiteral) return esc(String(p._def.value));
      if (typeof p === "string") return esc(p);
      return esc(String(p));
    }).join("");
    return (new ZodString() as any)._fmtcheck(
      "template_literal", new RegExp(`^${pat}$`));
  },
  json: () => {
    let inner: any;
    inner = new ZodLazy({
      type: "lazy",
      getter: () => new ZodUnion({
        type: "union",
        options: [
          new ZodString(), new ZodNumber(), new ZodBoolean(), new ZodNull(),
          new ZodArray({ type: "array", element: inner }),
          new ZodRecord({ type: "record", keyType: null, valueType: inner }),
        ],
      }),
    });
    return inner;
  },
  success: <T extends ZodTypeAny>(s: T) =>
    s.transform(() => true) as ZodTypeAny,

  // zod3 compatibility aliases
  /** Error subclass carrying the issues array. */
  ZodError: undefined as unknown as typeof import("./error.ts").ZodError,

  // ---------- standalone parse/encode fns (zod 4 top-level) ----------
  /** standalone safeParse: z.safeParse(schema, data, params?) */
  safeParse: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.safeParse(data, params),
  /** standalone parse */
  parse: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.parse(data, params),
  safeParseAsync: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.safeParseAsync(data),
  parseAsync: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.parseAsync(data),
  validate: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.safeParse(data, params).success,
  validateAsync: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.safeParseAsync(data),
  /** codec decode — same as parse on codecs */
  decode: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.parse(data, params),
  decodeAsync: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.parseAsync(data),
  safeDecode: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.safeParse(data, params),
  safeDecodeAsync: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.safeParseAsync(data),
  /** codec encode — runs the codec's reverseTransform */
  encode: <T extends ZodTypeAny>(s: T, data: unknown): unknown => {
    if (typeof (s as any).encode === "function") return (s as any).encode(data);
    throw new Error("asmzod: encode() requires a codec schema");
  },
  encodeAsync: async <T extends ZodTypeAny>(s: T, data: unknown): Promise<unknown> => {
    if (typeof (s as any).encode === "function") return (s as any).encode(data);
    throw new Error("asmzod: encodeAsync() requires a codec schema");
  },
  safeEncode: <T extends ZodTypeAny>(s: T, data: unknown) => {
    try {
      if (typeof (s as any).encode === "function") return { success: true, data: (s as any).encode(data) };
      return { success: false, error: new ZodError([{ code: "custom", path: [], message: "schema is not a codec" } as any]) };
    } catch (e: any) { return { success: false, error: e instanceof ZodError ? e : new ZodError([{ code: "custom", path: [], message: String(e?.message ?? e) } as any]) }; }
  },
  safeEncodeAsync: async <T extends ZodTypeAny>(s: T, data: unknown) => {
    try {
      if (typeof (s as any).encode === "function") return { success: true, data: await (s as any).encode(data) };
      return { success: false, error: new ZodError([{ code: "custom", path: [], message: "schema is not a codec" } as any]) };
    } catch (e: any) { return { success: false, error: e instanceof ZodError ? e : new ZodError([{ code: "custom", path: [], message: String(e?.message ?? e) } as any]) }; }
  },
  /** runtime _input accessor */
  input: <T extends ZodTypeAny>(s: T) => s._input,
  /** runtime _output accessor */
  output: <T extends ZodTypeAny>(s: T) => s._output,
  /** clone a schema instance (shares def internals) */
  clone: <T extends ZodTypeAny>(s: T, def?: any): T =>
    new (s as any).constructor({ ...(s as any)._def, ...(def ?? {}) }),
  /** set .metadata on a schema def */
  meta: <T extends ZodTypeAny>(s: T, m: Record<string, unknown>): T => {
    (s as any)._def.metadata = { ...((s as any)._def.metadata ?? {}), ...m };
    return s;
  },
  /** registry: id -> schema map */
  registry: <M = ZodTypeAny>() => {
    const m = new Map<string, M>();
    return {
      add: (id: string, v: M) => (m.set(id, v), undefined),
      get: (id: string) => m.get(id),
      has: (id: string) => m.has(id),
      remove: (id: string) => m.delete(id),
      clear: () => m.clear(),
      count: () => m.size,
      _map: m,
    };
  },

  // ---------- numeric factories ----------
  /** number int bounded to i32 */
  int32: (params?: any) => mk(ZodNumber, "number", params, [{ kind: "int" }, { kind: "gte", value: -2147483648 }, { kind: "lte", value: 2147483647 }]),
  /** number int bounded to u32 */
  uint32: (params?: any) => mk(ZodNumber, "number", params, [{ kind: "int" }, { kind: "gte", value: 0 }, { kind: "lte", value: 4294967295 }]),
  /** number (f64 slot named float64 in zod) */
  float64: (params?: any) => mk(ZodNumber, "number", params),
  /** number (f32 semantics deferred — same range as float64 in JS) */
  float32: (params?: any) => mk(ZodNumber, "number", params),
  /** bigint bounded to i64 */
  int64: (params?: any) => mk(ZodBigInt, "bigint", params, [{ kind: "gte", value: BigInt("-9223372036854775808") }, { kind: "lte", value: BigInt("9223372036854775807") }]),

  // ---------- check factories for .check(...) ----------
  /** number check: value > n */
  gt: (v: number | bigint, message?: string) => ({ kind: "gt", value: v, message }),
  gte: (v: number | bigint, message?: string) => ({ kind: "gte", value: v, message }),
  min: (v: number | bigint, message?: string) => ({ kind: "gte", value: v, message }),
  lt: (v: number | bigint, message?: string) => ({ kind: "lt", value: v, message }),
  lte: (v: number | bigint, message?: string) => ({ kind: "lte", value: v, message }),
  max: (v: number | bigint, message?: string) => ({ kind: "lte", value: v, message }),
  positive: (message?: string) => ({ kind: "gt", value: 0, message }),
  nonnegative: (message?: string) => ({ kind: "gte", value: 0, message }),
  negative: (message?: string) => ({ kind: "lt", value: 0, message }),
  nonpositive: (message?: string) => ({ kind: "lte", value: 0, message }),
  int: (message?: string) => ({ kind: "int", message }),
  multipleOf: (v: number | bigint, message?: string) => ({ kind: "multipleOf", value: v, message }),
  minLength: (v: number, message?: string) => ({ kind: "min", value: v, message }),
  maxLength: (v: number, message?: string) => ({ kind: "max", value: v, message }),
  length: (v: number, message?: string) => ({ kind: "length", value: v, message }),
  minSize: (v: number, message?: string) => ({ kind: "min", value: v, message }),
  maxSize: (v: number, message?: string) => ({ kind: "max", value: v, message }),
  size: (v: number, message?: string) => ({ kind: "size", value: v, message }),
  regex: (re: RegExp, message?: string) => ({ kind: "regex", regex: re, message }),
  startsWith: (v: string, message?: string) => ({ kind: "startsWith", value: v, message }),
  endsWith: (v: string, message?: string) => ({ kind: "endsWith", value: v, message }),
  includes: (v: string, message?: string) => ({ kind: "includes", value: v, message }),
  lowercase: (message?: string) => ({ kind: "lowercase", message }),
  uppercase: (message?: string) => ({ kind: "uppercase", message }),
  mime: (v: string[], message?: string) => ({ kind: "mime", value: v, message }),
  /** overwrite-style checks: value transforms */
  trim: () => ({ kind: "tx", tx: (v: unknown) => typeof v === "string" ? v.trim() : v }),
  toLowerCase: () => ({ kind: "tx", tx: (v: unknown) => typeof v === "string" ? v.toLowerCase() : v }),
  toUpperCase: () => ({ kind: "tx", tx: (v: unknown) => typeof v === "string" ? v.toUpperCase() : v }),
  normalize: (form?: string) => ({ kind: "tx", tx: (v: unknown) => typeof v === "string" ? v.normalize(form as any) : v }),
  overwrite: (fn: (v: unknown) => unknown) => ({ kind: "tx", tx: fn }),
  slugify: () => ({ kind: "tx", tx: (v: unknown) => typeof v === "string" ? v.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/[\s-]+/g, "-").replace(/^-+|-+$/g, "") : v }),
  /** description/metadata checks */
  describe: (msg: string) => ({ kind: "meta", description: msg }),
  metaCheck: (m: Record<string, unknown>) => ({ kind: "meta", metadata: m }),

  // ---------- error utilities ----------
  /** {formErrors, fieldErrors} — errors grouped by top-level key */
  flattenError: (err: ZodError) => {
    const formErrors: string[] = [];
    const fieldErrors: Record<string, string[]> = {};
    for (const i of err.issues) {
      if (!i.path?.length) formErrors.push(i.message);
      else {
        const k = String(i.path[0]);
        (fieldErrors[k] ??= []).push(i.message);
      }
    }
    return { formErrors, fieldErrors };
  },
  /** nested errors keyed by path: {name?/_errors/items/properties} */
  formatError: (err: ZodError) => {
    const walk = (issues: any[]): any => {
      const node: any = { _errors: [] };
      for (const i of issues) {
        const [head, ...rest] = i.path ?? [];
        if (head === undefined) { node._errors.push(i.message); continue; }
        const key = typeof head === "number" ? "items" : "properties";
        node[key] ??= {};
        node[key][head] ??= { _errors: [] };
        node[key][head]._errors.push === undefined && (node[key][head] = { _errors: [] });
        if (!rest.length) node[key][head]._errors.push(i.message);
        else {
          const sub = walk([{ ...i, path: rest }]);
          node[key][head] = { ...node[key][head], ...sub, _errors: node[key][head]._errors };
        }
      }
      return node;
    };
    return walk(err.issues);
  },
  /** human-readable pretty print of an error */
  prettifyError: (err: ZodError) =>
    err.issues.map((i) => {
      const p = (i.path ?? []).map((seg, j) => (typeof seg === "number" ? `[${seg}]` : j === 0 ? String(seg) : `.${seg}`)).join("");
      return `✖ ${i.message}${p ? `\n  → at ${p}` : ""}`;
    }).join("\n"),
  /** tree-shaped error: {errors, properties, items} */
  treeifyError: (err: ZodError) => {
    const walk = (issues: any[]): any => {
      const node: any = { errors: [] };
      for (const i of issues) {
        const [head, ...rest] = i.path ?? [];
        if (head === undefined) { node.errors.push(i.message); continue; }
        const key = typeof head === "number" ? "items" : "properties";
        node[key] ??= typeof head === "number" ? [] : {};
        if (typeof head === "number") node[key][head] ??= { errors: [] };
        else node[key][head] ??= { errors: [] };
        if (!rest.length) node[key][head].errors.push(i.message);
        else {
          const sub = walk([{ ...i, path: rest }]);
          const cur = node[key][head];
          node[key][head] = {
            errors: cur.errors,
            ...(sub.properties ? { properties: { ...(cur.properties ?? {}), ...sub.properties } } : {}),
            ...(sub.items ? { items: sub.items } : {}),
          };
        }
      }
      return node;
    };
    return walk(err.issues);
  },

  // ---------- string-format factories not in the asm engine ----------
  /** credit card (Luhn, spaces/dashes tolerated) */
  creditCard: (params?: any) => new ZodAlgoFormat({
    format: "credit_card", message: "Invalid credit card number", fn: luhnCheck,
  }),
  /** IBAN (ISO 13616 mod-97) */
  iban: (params?: any) => new ZodAlgoFormat({
    format: "iban", message: "Invalid IBAN", fn: ibanCheck,
  }),
  /** ISO 4217 currency code */
  currencyCode: (params?: any) => new ZodAlgoFormat({
    format: "currency_code", message: "Invalid currency code",
    fn: (s: string) => /^[A-Z]{3}$/.test(s),
  }),
  /** MAC address — same regex as zod */
  mac: (params?: any) => new ZodString({
    type: "string",
    checks: [{ kind: "regex", regex: /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/, format: "mac" }],
    error: params,
  }),
  /** JSON Schema -> schema (covers the subset toJSONSchema emits + common constructs) */
  fromJSONSchema: (js: any): ZodTypeAny => fromJSONSchema(js),

  // ---------- remaining top-level utilities ----------
  /** schema.pipe(target) as a factory */
  pipe: <A extends ZodTypeAny, B extends ZodTypeAny>(inS: A, out: B) => inS.pipe(out),
  /** schema.prefault(value) as a factory */
  prefault: <T extends ZodTypeAny>(s: T, v: any) => (s as any).prefault(v),
  /** optional wrapper preserving zod's exactOptional field semantics */
  exactOptional: <T extends ZodTypeAny>(s: T) => s.optional(),
  /** deepPartial on an object schema */
  deepPartial: <T extends ZodTypeAny>(s: T) => (s as any).deepPartial(),
  /** shape passthrough helper */
  properties: <T extends ZodRawShape>(shape: T): T => shape,
  /** single-property shape helper */
  property: <T extends ZodTypeAny>(key: string, s: T): Record<string, T> => ({ [key]: s }),
  /** compile a schema eagerly (returns the schema) */
  compile: <T extends ZodTypeAny>(s: T): T => ((s as any)._compile(), s),
  /** memoize a schema factory */
  memoizer: <A extends any[], R>(fn: (...a: A) => R) => {
    const c = new Map<string, R>();
    return (...a: A): R => {
      const k = JSON.stringify(a);
      if (!c.has(k)) c.set(k, fn(...a));
      return c.get(k)!;
    };
  },
  /** swap a codec's in/out */
  invertCodec: <T extends ZodTypeAny>(c: T): ZodCodec<any, any> => {
    const d = (c as any)._def;
    if (d?.type !== "codec") throw new Error("asmzod: invertCodec requires a codec");
    return new ZodCodec({ ...d, in: d.out, out: d.in, transform: d.reverseTransform, reverseTransform: d.transform });
  },
  /** find the discriminated-union option matching a discriminator value */
  getDiscriminatedOption: (options: ZodTypeAny[], disc: string, value: unknown): ZodTypeAny | undefined =>
    options.find((o) => {
      const lit = (o as any)._def?.shape?.[disc]?._def?.value;
      return lit === value;
    }),
  /** wrap an arbitrary parse fn as a schema */
  withParser: <T>(fn: (data: unknown) => T): ZodType<T, unknown> => {
    const inner = z.custom<T>((v) => (fn(v), true));
    return inner.transform(fn) as unknown as ZodType<T, unknown>;
  },
  /** named string format from a fn or regex */
  stringFormat: (
    format: string,
    check: RegExp | ((v: string) => boolean),
    opts?: { message?: string },
  ) => check instanceof RegExp
    ? new ZodString({ type: "string", checks: [{ kind: "regex", regex: check, format }], error: opts?.message })
    : new ZodAlgoFormat({ format, message: opts?.message ?? `Invalid ${format}`, fn: check }),
  /** schema -> zod-ish source string (subset of defs) */
  toZod: (s: ZodTypeAny): string => toZod(s),
};

// attach the real class
import { ZodError } from "./error.ts";

const HASH_LENS = {
  md5_hex: [32, 0, 0], md5_base64: [22, 1, 2], md5_base64url: [22, 2, 0],
  sha1_hex: [40, 0, 0], sha1_base64: [27, 1, 1], sha1_base64url: [27, 2, 0],
  sha256_hex: [64, 0, 0], sha256_base64: [43, 1, 1], sha256_base64url: [43, 2, 0],
  sha384_hex: [96, 0, 0], sha384_base64: [64, 1, 0], sha384_base64url: [64, 2, 0],
  sha512_hex: [128, 0, 0], sha512_base64: [86, 1, 2], sha512_base64url: [86, 2, 0],
} as const;
(z as any).ZodError = ZodError;
import { toJSONSchema } from "./jsonschema.ts";
(z as any).toJSONSchema = toJSONSchema;

export default z;
export type { ZodType } from "./schema.ts";
export type infer<T extends ZodType<any, any>> = T["_output"];
export type input<T extends ZodType<any, any>> = T["_input"];
export type output<T extends ZodType<any, any>> = T["_output"];
export declare namespace z {
  export type infer<T extends ZodType<any, any>> = T["_output"];
  export type input<T extends ZodType<any, any>> = T["_input"];
  export type output<T extends ZodType<any, any>> = T["_output"];
}

// fromJSONSchema: inverse of toJSONSchema — covers the emitted subset
// plus common draft-2020-12 constructs. Unsupported constructs throw.
function fromJSONSchema(js: any): ZodTypeAny {
  if (js === true || js === undefined) return z.any();
  if (js === false) return z.never();
  if (js.const !== undefined) return z.literal(js.const);
  if (js.enum !== undefined) return z.enum(js.enum);
  if (js.anyOf) return z.union(js.anyOf.map(fromJSONSchema));
  if (js.oneOf) return z.union(js.oneOf.map(fromJSONSchema));
  if (js.allOf && js.allOf.length === 2)
    return z.intersection(fromJSONSchema(js.allOf[0]), fromJSONSchema(js.allOf[1]));
  if (js.not) throw new Error("asmzod: fromJSONSchema does not support 'not'");
  const types: string[] = Array.isArray(js.type) ? js.type : js.type ? [js.type] : [];
  if (types.length > 1) {
    // ["T","null"] -> nullable(T); other unions -> z.union
    const nonNull = types.filter((t) => t !== "null");
    if (nonNull.length === 1)
      return (fromJSONSchema({ ...js, type: nonNull[0] }) as any).nullable();
    return z.union(types.map((t) => fromJSONSchema({ ...js, type: t })));
  }
  let s: ZodTypeAny;
  switch (types[0]) {
    case "string": {
      let str = z.string() as any;
      const fmtMap: Record<string, string> = {
        email: "email", uuid: "uuid", url: "url", uri: "url", emoji: "emoji",
        base64: "base64", base64url: "base64url", nanoid: "nanoid", cuid: "cuid",
        cuid2: "cuid2", ulid: "ulid", ipv4: "ipv4", ipv6: "ipv6",
        cidrv4: "cidrv4", cidrv6: "cidrv6", date: "date", time: "time",
        "date-time": "datetime", datetime: "datetime", duration: "duration",
        e164: "e164", jwt: "jwt", hex: "hex",
      };
      const f = fmtMap[js.format ?? ""];
      if (f && typeof str[f] === "function") str = str[f]();
      if (typeof js.minLength === "number") str = str.min(js.minLength);
      if (typeof js.maxLength === "number") str = str.max(js.maxLength);
      if (typeof js.length === "number") str = str.length(js.length);
      if (js.pattern) str = str.regex(new RegExp(js.pattern));
      if (js.startsWith) str = str.startsWith(js.startsWith);
      if (js.endsWith) str = str.endsWith(js.endsWith);
      if (js.includes) str = str.includes(js.includes);
      s = str; break;
    }
    case "number": case "integer": {
      let n = z.number() as any;
      if (types[0] === "integer") n = n.int();
      if (typeof js.minimum === "number") n = n.gte(js.minimum);
      if (typeof js.maximum === "number") n = n.lte(js.maximum);
      if (typeof js.exclusiveMinimum === "number") n = n.gt(js.exclusiveMinimum);
      if (typeof js.exclusiveMaximum === "number") n = n.lt(js.exclusiveMaximum);
      if (typeof js.multipleOf === "number") n = n.multipleOf(js.multipleOf);
      s = n; break;
    }
    case "boolean": s = z.boolean(); break;
    case "null": s = z.null(); break;
    case "array": {
      let a = z.array(js.items ? fromJSONSchema(js.items) : z.any()) as any;
      if (typeof js.minItems === "number") a = a.min(js.minItems);
      if (typeof js.maxItems === "number") a = a.max(js.maxItems);
      s = a; break;
    }
    case "object": {
      if (js.properties) {
        const shape: Record<string, ZodTypeAny> = {};
        for (const [k, v] of Object.entries(js.properties)) {
          let vs = fromJSONSchema(v);
          if (!js.required?.includes(k)) vs = (vs as any).optional();
          shape[k] = vs;
        }
        s = js.additionalProperties === false ? z.strictObject(shape)
          : js.additionalProperties ? z.looseObject(shape) : z.object(shape);
      } else if (js.additionalProperties && typeof js.additionalProperties === "object") {
        s = z.record(z.string(), fromJSONSchema(js.additionalProperties));
      } else s = z.record(z.string(), z.unknown());
      break;
    }
    default:
      if (js.$ref) throw new Error("asmzod: fromJSONSchema does not resolve $ref");
      s = z.unknown();
  }
  return s;
}

// toZod: render a schema's def back to zod-ish source — subset matching
// fromJSONSchema coverage; unknown defs degrade to z.unknown()
function toZod(s: any, d = 0): string {
  const ind = "  ".repeat(d);
  const def = s?._def ?? {};
  switch (def.type) {
    case "string": {
      let out = "z.string()";
      for (const c of def.checks ?? []) {
        if (c.kind === "min") out += `.min(${c.value})`;
        else if (c.kind === "max") out += `.max(${c.value})`;
        else if (c.kind === "length") out += `.length(${c.value})`;
        else if (c.kind === "regex") out += ".regex(/" + c.regex.source + "/" + c.regex.flags + ")";
        else if (typeof (ZodString.prototype as any)[c.kind] === "function") out += `.${c.kind}()`;
        else if (["startsWith","endsWith","includes"].includes(c.kind)) out += `.${c.kind}(${JSON.stringify(c.value)})`;
      }
      return out;
    }
    case "number": {
      let out = "z.number()";
      for (const c of def.checks ?? []) {
        if (c.kind === "int") out += ".int()";
        else if (["gt","gte","lt","lte","multipleOf"].includes(c.kind)) out += `.${c.kind}(${c.value})`;
      }
      return out;
    }
    case "bigint": return "z.bigint()";
    case "boolean": return "z.boolean()";
    case "date": return "z.date()";
    case "symbol": return "z.symbol()";
    case "any": return "z.any()";
    case "unknown": return "z.unknown()";
    case "never": return "z.never()";
    case "null": return "z.null()";
    case "undefined": return "z.undefined()";
    case "void": return "z.void()";
    case "nan": return "z.nan()";
    case "literal": return `z.literal(${JSON.stringify(def.value)})`;
    case "enum": return `z.enum(${JSON.stringify(def.values)})`;
    case "array": return `z.array(${toZod(def.element, d + 1)})`;
    case "tuple": return `z.tuple([${(def.items ?? []).map((i: any) => toZod(i, d + 1)).join(", ")}])`;
    case "record":
      return def.keyType
        ? `z.record(${toZod(def.keyType, d + 1)}, ${toZod(def.valueType, d + 1)})`
        : `z.record(z.string(), ${toZod(def.valueType, d + 1)})`;
    case "union": return `z.union([${def.options.map((o: any) => toZod(o, d + 1)).join(", ")}])`;
    case "optional": return `${toZod(def.inner, d + 1)}.optional()`;
    case "nullable": return `${toZod(def.inner, d + 1)}.nullable()`;
    case "default": return `${toZod(def.inner, d + 1)}.default(${JSON.stringify(def.value)})`;
    case "object": {
      const parts = Object.entries(def.shape ?? {}).map(([k, v]) => `${JSON.stringify(k)}: ${toZod(v, d + 1)}`);
      const mk = def.mode === "strict" ? "z.strictObject" : def.mode === "passthrough" ? "z.looseObject" : "z.object";
      return `${mk}({ ${parts.join(", ")} })`;
    }
    case "lazy": return "z.lazy(() => /* recursive */)";
    case "map": return `z.map(${toZod(def.keyType, d + 1)}, ${toZod(def.valueType, d + 1)})`;
    case "set": return `z.set(${toZod(def.valueType, d + 1)})`;
    default: return "z.unknown()";
  }
}

// named re-exports: `import * as z from "asmzod"` exposes the same
// surface as the `z` object, matching zod's index exports
export const {
  string, number, bigint, boolean, date, symbol, any, unknown, never, nan,
  object, strictObject, looseObject, promise, preprocess, array, tuple,
  record, map, set, partialRecord, looseRecord, keyof, xor, stringbool,
  file, codec, check, union, discriminatedUnion, intersection, literal,
  nativeEnum, lazy, custom, coerce, optional, nullable, nullish, brand,
  nonoptional, readonly, refine, superRefine, transform,
  email, url, uuid, uuidv4, uuidv6, uuidv7, guid, cuid, cuid2, ulid,
  nanoid, emoji, base64, base64url, jwt, hex, xid, ksuid, hash, uint64,
  e164, duration, ipv4, ipv6, cidrv4, cidrv6, hostname, httpUrl,
  config, iso, templateLiteral, json, success,
  safeParse, parse, safeParseAsync, parseAsync, validate, validateAsync,
  decode, decodeAsync, safeDecode, safeDecodeAsync, encode, encodeAsync,
  safeEncode, safeEncodeAsync, input, output, clone, meta, registry,
  int32, uint32, float64, float32, int64, gt, gte, min, lt, lte, max,
  positive, nonnegative, negative, nonpositive, int, multipleOf,
  minLength, maxLength, length, minSize, maxSize, size, regex,
  startsWith, endsWith, includes, lowercase, uppercase, mime, trim,
  toLowerCase, toUpperCase, normalize, overwrite, slugify, describe,
  metaCheck, flattenError, formatError, prettifyError, treeifyError,
  creditCard, iban, currencyCode, mac, pipe, prefault,
  exactOptional, deepPartial, properties, property, compile, memoizer,
  invertCodec, getDiscriminatedOption, withParser, stringFormat,
} = z;
export { setErrorMap, getErrorMap, fromJSONSchema, toZod };
export { toJSONSchema };
const _null = z.null;
const _undefined = z.undefined;
const _void = z.void;
const _function = z.function;
const _enum = z.enum;
const _instanceof = z.instanceof;
const _catch = z.catch;
export {
  _null as null, _undefined as undefined, _void as void,
  _function as function, _enum as enum, _instanceof as instanceof,
  _catch as catch,
};
