// index.ts — the z factory object + public exports
import {
  ZodString, ZodNumber, ZodBigInt, ZodBoolean, ZodAny, ZodUnknown, ZodNever,
  ZodNull, ZodUndefined, ZodVoid, ZodNaN, ZodSymbol, ZodDate, ZodObject,
  ZodArray, ZodTuple, ZodRecord, ZodUnion, ZodDiscriminatedUnion,
  ZodIntersection, ZodLiteral, ZodEnum, ZodLazy, ZodInstanceof, ZodCustom,
  ZodOptional, ZodExactOptional, ZodNullable, ZodDefault, ZodCatch, ZodEffects, ZodPipe,
  ZodBranded, ZodMap, ZodSet, ZodType, ZodPromise, ZodFunction,
  ZodStringbool, ZodXor, ZodFile, ZodCodec, ZodTransform, ZodPreprocess, ZodPrefault, STRINGBOOL_TRUE, STRINGBOOL_FALSE,
  ZodAlgoFormat, luhnCheck, ibanCheck, _encode, _encodeScoped, isRecursiveSchema, _zodPattern, AsyncCheckError,
  deepPartial as _deepPartial,
  _parse, _safeParse, _parseAsync, _safeParseAsync,
  _mkEncode as _encodeFn, _mkEncodeAsync as _encodeAsyncFn,
  _mkSafeEncode as _safeEncodeFn, _mkSafeEncodeAsync as _safeEncodeAsyncFn,
  type ZodTypeAny, type ZodRawShape,
} from "./schema.ts";
import { reg, regId } from "./ffi.ts";
import { configure, setErrorMap, getErrorMap, config as _sharedConfig, globalConfig as _globalConfig, memoizerFactory as _memoizerFactory, failure as _failure, captureStackTrace, NEVER, ZodRegistry, globalRegistry, defaultMessage, frLocaleError } from "./shared.ts";

export * from "./schema.ts";
export * from "./error.ts";
export { engineVersion, engineBackend } from "./ffi.ts";

// factory params: { checks: [z.minLength(1), z.check(fn)], error|message... }
// zod's regexes.ts — ISO format sources, ported verbatim so the iso.*
// factories match upstream's accepted/rejected surface exactly
const _isoDateSrc = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
const _isoTimeSrc = (a: { precision?: number | null; seconds?: boolean }): string => {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  if (typeof a.precision === "number")
    return a.precision === -1 ? hhmm
      : a.precision === 0 ? `${hhmm}:[0-5]\\d`
      : `${hhmm}:[0-5]\\d\\.\\d{${a.precision}}`;
  return a.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
};
const _isoRe = {
  date: new RegExp(`^${_isoDateSrc}$`),
  duration: /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/,
  time: (a: any) => new RegExp(`^${_isoTimeSrc(a)}$`),
  datetime: (a: any) => {
    const opts = ["Z"];
    if (a.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
    const qualified = `${_isoTimeSrc({ precision: a.precision, seconds: true })}(?:${opts.join("|")})`;
    const timeRe = a.local ? `${qualified}|${_isoTimeSrc({ precision: a.precision })}` : qualified;
    return new RegExp(`^${_isoDateSrc}T(?:${timeRe})$`);
  },
};
const _isoCheck = (fmt: "datetime" | "date" | "time" | "duration", p: any) => {
  const opts = p && typeof p === "object" ? p : {};
  const re = fmt === "date" ? _isoRe.date : fmt === "duration" ? _isoRe.duration
    : fmt === "time" ? _isoRe.time(opts) : _isoRe.datetime(opts);
  return (new ZodString() as any)._fmtcheck(fmt, re, typeof p === "string" ? p : opts.message ?? opts.error);
};

// zod's util.isPlainObject/shallowClone — constructor-based, not proto-based
const _azIsPlainObject = (o: any): boolean => {
  if (typeof o !== "object" || o === null) return false;
  const ctor = o.constructor;
  if (ctor === undefined) return true;
  if (typeof ctor !== "function") return true;
  const prot = ctor.prototype;
  if (typeof prot !== "object" || prot === null) return false;
  return Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf");
};
const _azShallowClone = (o: any): any =>
  _azIsPlainObject(o) ? { ...o } : Array.isArray(o) ? [...o]
  : o instanceof Map ? new Map(o) : o instanceof Set ? new Set(o) : o;

// zod's numeric format factories (z.int32() etc.) stamp def.format so
// isInt/minValue/toJSONSchema can read the declared width
const _fmtNum = (s: any, format: string) => { s._def.format = format; return s; };

const mk = (Cls: any, type: string, params: any, checks: any[] = []): any => {
  const pc = params && typeof params === "object" && !Array.isArray(params) ? params.checks : undefined;
  const all = [...checks, ...(Array.isArray(pc) ? pc : [])];
  const isCb = (c: any) => typeof c === "function" || c?.kind === "checkfn" || c instanceof ZodType || c?._zod;
  const fns = all.filter(isCb)
    .map((c: any) => (typeof c === "function" || c instanceof ZodType || c?._zod ? c : c.fn));
  let s: any = new Cls({
    type,
    checks: all.filter((c: any) => !isCb(c)),
    error: typeof params === "string" || typeof params === "function" ? params
      : params && typeof params === "object" ? params.error ?? params.message : undefined,
  });
  if (fns.length) s = s.check(...fns);
  return s;
};

// definite = a synchronous rejection is proof of runtime rejection: no node in
// the graph can suspend, transform, or run a user callback. Format fns and
// min/max check records don't count — they're compiled predicates.
function _definite(s: any, stack = new Set<any>()): boolean {
  if (!s || typeof s !== "object" || stack.has(s)) return true;
  const d = s._def;
  if (!d) return true;
  stack.add(s);
  const kind = d.kind ?? d.type;
  if (kind === "lazy" || kind === "custom" || kind === "catch" || kind === "transform" ||
    kind === "refine" || kind === "superrefine" || kind === "effects" || kind === "pipe" ||
    kind === "codec" || kind === "function" || kind === "promise" || kind === "instof") return false;
  if (Array.isArray(d.checks))
    for (const c of d.checks) if (c && (c.kind === "checkfn" || c.kind === "tx")) return false;
  const rec = (x: any) => x && typeof x === "object" && x._def && !_definite(x, stack);
  for (const k in d) {
    const desc = Object.getOwnPropertyDescriptor(d, k);
    if (!desc) continue;
    let v: any;
    if (desc.get) {
      try { v = d[k]; } catch { return false; }
    } else v = desc.value;
    if (typeof v === "function") return false;
    if (rec(v) || (Array.isArray(v) && v.some(rec))) return false;
    if (v && typeof v === "object" && !Array.isArray(v))
      for (const sv of Object.values(v)) if (rec(sv)) return false;
  }
  return true;
}

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
    new ZodObject<T>({ type: "object", shape, mode: "strip", catchall: undefined, error: params }),
  /** Create an object schema that fails on unknown keys. */
  strictObject: <T extends ZodRawShape>(shape: T, params?: any) =>
    new ZodObject<T>({ type: "object", shape, mode: "strict", catchall: new ZodNever({ type: "never" }), error: params }),
  /** Create an object schema that passes unknown keys through. */
  looseObject: <T extends ZodRawShape>(shape: T, params?: any) =>
    new ZodObject<T>({ type: "object", shape, mode: "passthrough", catchall: new ZodUnknown({ type: "unknown" }), error: params }),
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
  preprocess: <T extends ZodTypeAny>(fn: (v: unknown, ctx: any) => unknown, schema: T) =>
    new ZodPreprocess<T>({
      type: "pipe",
      in: new ZodTransform(fn),
      out: schema,
    }),

  /** Create an array schema for the element type. */
  array: <T extends ZodTypeAny>(element: T, params?: any) =>
    new ZodArray<T>({ type: "array", element, error: params }),
  /** Create a fixed-length tuple schema. */
  tuple: <T extends ZodTypeAny[]>(items: [...T], restOrParams?: any, params?: any) => {
    const hasRest = restOrParams instanceof ZodType || restOrParams?._zod?.def !== undefined;
    return new ZodTuple<T>({
      type: "tuple", items,
      rest: hasRest ? restOrParams : null,
      error: hasRest ? params : restOrParams,
    });
  },
  /** Create a record schema: record(valueType) or record(keyType, valueType). */
  record: ((keyOrVal: ZodTypeAny, val?: any) =>
    !(val instanceof ZodType)
      ? new ZodRecord({ type: "record", keyType: new ZodString({ type: "string", checks: [] }), valueType: keyOrVal, error: val })
      : new ZodRecord({ type: "record", keyType: keyOrVal, valueType: val })) as {
    <V extends ZodTypeAny>(value: V): ZodRecord<ZodString, V>;
    <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V): ZodRecord<K, V>;
  },
  /** Create a Map schema. */
  map: <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V, params?: any) =>
    new ZodMap<K, V>({ type: "map", keyType: key, valueType: value,
      error: typeof params === "string" || typeof params === "function" ? params : params?.error ?? params?.message }),
  /** Create a Set schema. */
  set: <V extends ZodTypeAny>(value: V, params?: any) =>
    new ZodSet<V>({ type: "set", valueType: value,
      error: typeof params === "string" || typeof params === "function" ? params : params?.error ?? params?.message }),
  /** Record where the closed key set is optional; other keys rejected (or loose). */
  partialRecord: <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V, params?: any) =>
    new ZodRecord<K, V>({ type: "record", keyType: key, valueType: value, partial: true, mode: params?.mode ?? "strict" }),
  /** Record where all closed keys are required and other keys pass through. */
  looseRecord: <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V) =>
    new ZodRecord<K, V>({ type: "record", keyType: key, valueType: value, mode: "loose" }),
  /** Enum of an object schema's keys. */
  keyof: <T extends ZodTypeAny>(schema: T) => (schema as any).keyof(),
  /** Exactly one option must match. */
  xor: <T extends ZodTypeAny[]>(options: [...T], params?: any) =>
    new ZodXor<T>({ type: "union", options, error: params }),
  /** Parses boolean-ish strings ("true"/"yes"/"on"/"0"/"off"/...) to booleans. */
  stringbool: (params?: any) => {
    const cs = params?.case ?? "insensitive";
    const norm = (a: string[]) => (cs === "insensitive" ? a.map((x) => x.toLowerCase()) : a);
    const truthy = norm(params?.truthy ?? [...STRINGBOOL_TRUE]);
    const falsy = norm(params?.falsy ?? [...STRINGBOOL_FALSE]);
    return new ZodStringbool({
      type: "stringbool", truthy, falsy, case: cs,
      bag: { truthy, falsy, case: cs },
      error: typeof params === "string" ? params : (params?.error ?? params?.message),
    });
  },
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
  discriminatedUnion: <T extends ZodTypeAny[]>(disc: string, options: [...T], params?: any) => {
    // eager rawShape check: options whose shape enumerates without invoking
    // getters must own the discriminator — pipes/lazies defer to the map build
    for (let i = 0; i < options.length; i++) {
      const shape = (options[i] as any)._def?.shape;
      if (shape !== undefined && !Object.prototype.hasOwnProperty.call(shape, disc))
        throw new Error(`Invalid discriminated union option at index "${i}"`);
    }
    return new ZodDiscriminatedUnion<T>({
      type: "discunion", discriminator: disc, options,
      unionFallback: params?.unionFallback === true, error: params,
    });
  },
  /** Value must satisfy both schemas. */
  intersection: <A extends ZodTypeAny, B extends ZodTypeAny>(l: A, r: B) =>
    new ZodIntersection<A, B>({ type: "intersect", left: l, right: r }),

  /** Schema accepting exactly the given literal(s). */
  literal: <T extends string | number | boolean | bigint | null | undefined>(v: T, params?: any) =>
    new ZodLiteral<T>({ type: "literal", value: v, values: Array.isArray(v) ? [...v] : [v], error: params }),
  /** Schema for a fixed set of string values (or a TS enum). */
  enum: ((values: any, params?: any) => {
    if (!Array.isArray(values)) {
      // native/TS enum object — numeric reverse-mapped keys are not members
      const entries = Object.fromEntries(Object.entries(values).filter(([k]) => isNaN(Number(k))));
      return new ZodEnum({ type: "enum", values: Object.values(entries), entries, error: params });
    }
    return new ZodEnum({ type: "enum", values, error: params });
  }) as { <T extends string>(values: [T, ...T[]], params?: any): ZodEnum<T>; (values: object, params?: any): ZodEnum<any> },
  /** Schema for a TS enum object (alias of enum). */
  nativeEnum: (e: object) => z.enum(e as any),

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
    date: (params?: any) => new ZodPipe({
      type: "pipe",
      in: new ZodTransform((x: any) => new Date(x)),
      out: mk(ZodDate, "date", params),
    }) as any,
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
  /** Substitute a default when input is undefined (zod's z._default). */
  _default: <T extends ZodTypeAny>(s: T, v: T["_output"] | (() => T["_output"])) =>
    new ZodDefault({ type: "default", inner: s, value: v }),
  /** Validate then freeze the output. */
  readonly: <T extends ZodTypeAny>(s: T) => s.readonly(),
  /** Add a custom check; fails with invalid_type when falsy. */
  refine: (fn: (v: unknown) => boolean, message?: string) =>
    new ZodAny().refine(fn, message),
  superRefine: (fn: (v: unknown, ctx: any) => void) =>
    new ZodAny().superRefine(fn),
  /** Map the parsed value through a function — zod's standalone $ZodTransform. */
  transform: (fn: (v: unknown) => unknown) => new ZodTransform(fn),

  // string-format factories — equivalent to z.string().<fmt>()
  /** Alias of z.string().email(). */
  email: (p?: string) => new ZodString().email(p),
  /** Alias of z.string().url(). */
  url: (p?: any) => new ZodString().url(p),
  /** Alias of z.string().uuid(). */
  uuid: (p?: any) => new ZodString().uuid(p),
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
  nanoid: (p?: any) => new ZodString().nanoid(p),
  /** Alias of z.string().emoji(). */
  emoji: (p?: string) => new ZodString().emoji(p),
  /** Alias of z.string().base64(). */
  base64: (p?: string) => new ZodString().base64(p),
  /** Alias of z.string().base64url(). */
  base64url: (p?: string) => new ZodString().base64url(p),
  jwt: (p?: any) => new ZodString().jwt(p),
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
  config: (opts?: any) => _sharedConfig(opts),
  /** Set the global error map. */
  setErrorMap: (fn?: (i: any) => string | undefined) => setErrorMap(fn),
  getErrorMap: () => getErrorMap(),
  /** ISO 8601 formats: iso.date/datetime/time/duration. */
  /** zod's exported format regexes */
  regexes: {
    domain: /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/,
    email: /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/,
    ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
    ipv6: /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/,
    uuid: /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
    cuid: /^[cC][0-9a-z]{6,}$/,
    cuid2: /^[0-9a-z]+$/,
    ulid: /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/,
    nanoid: /^[a-zA-Z0-9_-]{21}$/,
    xid: /^[0-9a-vA-V]{20}$/,
    ksuid: /^[A-Za-z0-9]{27}$/,
    e164: /^\+[1-9]\d{6,14}$/,
    base64: /^[0-9a-zA-Z+/]*={0,2}$/,
    base64url: /^[A-Za-z0-9_-]*$/,
    hex: /^[0-9a-fA-F]*$/,
    emoji: /^(?=[\s\S]*[\p{Extended_Pictographic}\p{Regional_Indicator}⃝])[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u,
    httpProtocol: /^https?$/,
  },

  iso: {
    datetime: (p?: any) => _isoCheck("datetime", p),
    /** Create a Date schema. */
    date: (p?: any) => _isoCheck("date", p),
    time: (p?: any) => _isoCheck("time", p),
    duration: (p?: any) => _isoCheck("duration", p),
  },

  templateLiteral: (parts: readonly unknown[], _params?: any) => {
    // zod4: composes parts into a regex; schemas contribute _zod.pattern
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const clean = (src: string) =>
      src.slice(src.startsWith("^") ? 1 : 0, src.endsWith("$") ? src.length - 1 : undefined);
    const pat = parts.map((p) => {
      if (p instanceof ZodType || (p as any)?._zod?.def !== undefined) {
        const re = _zodPattern(p);
        if (!re) throw new Error(`Invalid template literal part, no pattern found: ${(p as any)?._def?.type}`);
        return clean(re.source);
      }
      if (p === null || ["string", "number", "bigint", "boolean", "symbol", "undefined"].includes(typeof p))
        return esc(`${p}`);
      throw new Error(`Invalid template literal part: ${p}`);
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
          new ZodRecord({ type: "record", keyType: new ZodString(), valueType: inner }),
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
  safeParse: _safeParse(ZodError) as any,
  /** standalone parse */
  parse: _parse(ZodError) as any,
  safeParseAsync: _safeParseAsync(ZodError) as any,
  parseAsync: _parseAsync(ZodError) as any,
  validate: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.validate(data, params),
  validateAsync: <T extends ZodTypeAny>(s: T, data: unknown, params?: any) => s.safeParseAsync(data, params).then((r) => r.success),
  /** codec decode — same as parse on codecs */
  decode: _parse(ZodError) as any,
  decodeAsync: _parseAsync(ZodError) as any,
  safeDecode: _safeParse(ZodError) as any,
  safeDecodeAsync: _safeParseAsync(ZodError) as any,
  /** codec encode — backward-direction traversal over the schema graph */
  encode: _encodeFn(ZodError) as any,
  encodeAsync: _encodeAsyncFn(ZodError) as any,
  safeEncode: _safeEncodeFn(ZodError) as any,
  safeEncodeAsync: _safeEncodeAsyncFn(ZodError) as any,
  /** runtime _input accessor */
  input: <T extends ZodTypeAny>(s: T) => s._input,
  /** runtime _output accessor */
  output: <T extends ZodTypeAny>(s: T) => s._output,
  /** clone a schema instance (shares def internals) */
  clone: <T extends ZodTypeAny>(s: T, def?: any): T =>
    new (s as any).constructor({ ...(s as any)._def, ...(def ?? {}) }),
  /** metadata check (check form) or schema metadata setter */
  meta: ((s: any, m?: any): any => {
    if (m === undefined && !(s instanceof ZodType) && !(s && typeof s === "object" && typeof s._def === "object"))
      return { kind: "meta", metadata: s };
    if (m === undefined) return s;
    (s as any)._def.metadata = { ...(s._def.metadata ?? {}), ...m };
    return s;
  }) as any,
  /** schema -> metadata registry */
  registry: <M = ZodTypeAny>() => new ZodRegistry(),
  /** shared schema metadata registry */
  globalRegistry,
  /** locale error-map factories */
  locales: {
    en: () => ({ localeError: defaultMessage }),
    fr: () => ({ localeError: frLocaleError() }),
  },

  // ---------- numeric factories ----------
  /** number int bounded to i32 */
  int32: (params?: any) => _fmtNum(mk(ZodNumber, "number", params, [{ kind: "int" }, { kind: "gte", value: -2147483648 }, { kind: "lte", value: 2147483647 }]), "int32"),
  /** number int bounded to u32 */
  uint32: (params?: any) => _fmtNum(mk(ZodNumber, "number", params, [{ kind: "int" }, { kind: "gte", value: 0 }, { kind: "lte", value: 4294967295 }]), "uint32"),
  /** number (f64 slot named float64 in zod) */
  float64: (params?: any) => _fmtNum(mk(ZodNumber, "number", params), "float64"),
  /** number (f32 semantics deferred — same range as float64 in JS) */
  float32: (params?: any) => _fmtNum(mk(ZodNumber, "number", params), "float32"),
  /** bigint bounded to i64 */
  int64: (params?: any) => _fmtNum(mk(ZodBigInt, "bigint", params, [{ kind: "gte", value: BigInt("-9223372036854775808") }, { kind: "lte", value: BigInt("9223372036854775807") }]), "int64"),
  /** bigint bounded to u64 */
  uint64: (params?: any) => _fmtNum(mk(ZodBigInt, "bigint", params, [{ kind: "gte", value: 0n }, { kind: "lte", value: 18446744073709551615n }]), "uint64"),

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
  int: (params?: any) => _fmtNum(mk(ZodNumber, "number", params, [{ kind: "int" }]), "safeint"),
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
  flattenError: <U>(err: ZodError, mapper?: (i: any) => U) => _flattenError(err, mapper),
  /** nested errors keyed by path: {name?/_errors/items/properties} */
  formatError: <U>(err: ZodError, mapper?: (i: any) => U) => _formatError(err, mapper),
  /** human-readable pretty print of an error */
  prettifyError: (err: { issues: any[] }) => _prettifyError(err),
  /** dotted path like `a.b[0]` with bracket escaping */
  toDotPath: (path: readonly (string | number | symbol | { key: PropertyKey })[]) => _toDotPath(path),
  /** tree-shaped error: {errors, properties, items} */
  treeifyError: <U>(err: ZodError, mapper?: (i: any) => U) => _treeifyError(err, mapper),

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
    fn: (s: string) => /^(?:AED|AFN|ALL|AMD|AOA|ARS|AUD|AWG|AZN|BAM|BBD|BDT|BHD|BIF|BMD|BND|BOB|BOV|BRL|BSD|BTN|BWP|BYN|BZD|CAD|CDF|CHE|CHF|CHW|CLF|CLP|CNY|COP|COU|CRC|CUP|CVE|CZK|DJF|DKK|DOP|DZD|EGP|ERN|ETB|EUR|FJD|FKP|GBP|GEL|GHS|GIP|GMD|GNF|GTQ|GYD|HKD|HNL|HTG|HUF|IDR|ILS|INR|IQD|IRR|ISK|JMD|JOD|JPY|KES|KGS|KHR|KMF|KPW|KRW|KWD|KYD|KZT|LAK|LBP|LKR|LRD|LSL|LYD|MAD|MDL|MGA|MKD|MMK|MNT|MOP|MRU|MUR|MVR|MWK|MXN|MXV|MYR|MZN|NAD|NGN|NIO|NOK|NPR|NZD|OMR|PAB|PEN|PGK|PHP|PKR|PLN|PYG|QAR|RON|RSD|RUB|RWF|SAR|SBD|SCR|SDG|SEK|SGD|SHP|SLE|SOS|SRD|SSP|STN|SVC|SYP|SZL|THB|TJS|TMT|TND|TOP|TRY|TTD|TWD|TZS|UAH|UGX|USD|USN|UYI|UYU|UYW|UZS|VED|VES|VND|VUV|WST|XAD|XAF|XAG|XAU|XBA|XBB|XBC|XBD|XCD|XCG|XDR|XOF|XPD|XPF|XPT|XSU|XTS|XUA|XXX|YER|ZAR|ZMW|ZWG)$/.test(s),
  }),
  /** MAC address — same regex as zod */
  mac: (params?: any) => new ZodString().mac(params),
  /** JSON Schema -> schema (covers the subset toJSONSchema emits + common constructs) */
  fromJSONSchema: (js: any): ZodTypeAny => fromJSONSchema(js),

  // ---------- remaining top-level utilities ----------
  /** schema.pipe(target) as a factory */
  pipe: <A extends ZodTypeAny, B extends ZodTypeAny>(inS: A, out: B) => inS.pipe(out),
  /** schema.prefault(value) as a factory */
  prefault: <T extends ZodTypeAny>(s: T, v: any) => (s as any).prefault(v),
  /** optional wrapper preserving zod's exactOptional field semantics */
  exactOptional: <T extends ZodTypeAny>(s: T) => s.exactOptional(),
  /** deepPartial on an object schema */
  deepPartial: <T extends ZodTypeAny>(s: T) => (s as any).deepPartial?.() ?? _deepPartial(s),
  /** shape passthrough helper */
  /** property checks for .check(): each validates value[key] against the schema */
  properties: <T extends ZodRawShape>(shape: T): any[] =>
    Object.entries(shape).map(([k, s]) => ({
      kind: "checkfn",
      fn: (payload: any) => {
        const r = (s as any)._run(payload.value?.[k]);
        if (!r.ok) for (const i of r.issues) payload.issues.push({ ...i, path: [k, ...(i.path ?? [])] });
      },
    })),
  /** single-property shape helper */
  property: <T extends ZodTypeAny>(key: string, s: T): Record<string, T> => ({ [key]: s }),
  /** compile a schema eagerly (returns the schema) */
  compile: <T extends ZodTypeAny>(s: T, opts?: { strict?: boolean }): T => {
    if (opts?.strict) {
      // strict precompilation walks the whole graph — symbol-keyed fields and
      // cyclic structures can't be resolved eagerly
      const seen = new Set<any>();
      const walk = (sc: any): void => {
        if (!sc || typeof sc !== "object" || seen.has(sc)) return;
        seen.add(sc);
        const d = sc._def;
        if (!d) return;
        if (d.type === "lazy") return;
        if (d.shape && Object.getOwnPropertySymbols(d.shape).length)
          throw new Error("z.compile does not support symbol-keyed object fields; this schema must use the runtime parser");
        for (const k of ["shape", "inner", "in", "out", "element", "keyType", "valueType", "catchall", "options", "items", "getter"])
          if (d[k]) { const v = d[k]; if (v instanceof ZodType) walk(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); }
      };
      walk(s);
    }
    (s as any)._compile();
    try { ((s as any)._def.bag ??= {}).validator ??= { definite: _definite(s) }; } catch { }
    return s;
  },
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
  getDiscriminatedOption: (schema: any, value: unknown): ZodTypeAny | undefined => {
    const map = schema?.discMap?.() ?? schema?._def?.optionsMap;
    if (!map) throw new Error("asmzod: getDiscriminatedOption requires a discriminated union");
    const o = map.get(value);
    if (o === null) throw new Error(`Ambiguous discriminator value "${String(value as any)}"`);
    return o ?? undefined;
  },
  /** wrap an arbitrary parse fn as a schema */
  withParser: <T>(fn: (data: unknown) => T): ZodType<T, unknown> => {
    const inner = z.custom<T>((v) => (fn(v), true));
    return inner.transform(fn) as unknown as ZodType<T, unknown>;
  },
  /** named string format from a fn or regex */
  stringFormat: (
    format: string,
    check: RegExp | ((v: string) => boolean),
    opts?: { message?: string; error?: string | ((i: any) => string); abort?: boolean },
  ) => check instanceof RegExp
    ? new ZodString({ type: "string", pattern: check,
        checks: [{ kind: "regex", regex: check, format,
                   error: opts?.error ?? opts?.message, abort: opts?.abort }] })
    : new ZodAlgoFormat({ format,
        message: typeof (opts?.error ?? opts?.message) === "string"
          ? (opts!.error ?? opts!.message) as string
          : `Invalid ${format}`,
        fn: check, abort: opts?.abort }),
  /** curried type-assert: toZod<T>()(schema) returns the schema typed as T */
  toZod: (<T>() => (s: ZodTypeAny) => s) as any,

  // ---------- public schema classes ----------
  ZodType, ZodString, ZodNumber, ZodBigInt, ZodBoolean, ZodAny, ZodUnknown,
  ZodNever, ZodNull, ZodUndefined, ZodVoid, ZodNaN, ZodSymbol, ZodDate,
  ZodObject, ZodArray, ZodTuple, ZodRecord, ZodUnion, ZodDiscriminatedUnion,
  ZodIntersection, ZodLiteral, ZodEnum, ZodLazy, ZodInstanceof, ZodCustom,
  ZodOptional, ZodExactOptional, ZodNullable, ZodDefault, ZodCatch, ZodEffects, ZodPipe,
  ZodBranded, ZodMap, ZodSet, ZodPromise, ZodFunction, ZodStringbool,
  ZodXor, ZodFile, ZodCodec, ZodAlgoFormat, ZodTransform, ZodPreprocess, ZodPrefault, STRINGBOOL_TRUE, STRINGBOOL_FALSE,
  NEVER,
  ZodIssueCode: {
    invalid_type: "invalid_type",
    too_big: "too_big",
    too_small: "too_small",
    invalid_format: "invalid_format",
    not_multiple_of: "not_multiple_of",
    unrecognized_keys: "unrecognized_keys",
    invalid_union: "invalid_union",
    invalid_key: "invalid_key",
    invalid_element: "invalid_element",
    invalid_value: "invalid_value",
    custom: "custom",
  } as const,
};

// attach the real class
import {
  ZodError, $ZodError, ZodRealError,
  flattenError as _flattenError, formatError as _formatError,
  treeifyError as _treeifyError, prettifyError as _prettifyError,
  toDotPath as _toDotPath,
} from "./error.ts";

const HASH_LENS = {
  md5_hex: [32, 0, 0], md5_base64: [22, 1, 2], md5_base64url: [22, 2, 0],
  sha1_hex: [40, 0, 0], sha1_base64: [27, 1, 1], sha1_base64url: [27, 2, 0],
  sha256_hex: [64, 0, 0], sha256_base64: [43, 1, 1], sha256_base64url: [43, 2, 0],
  sha384_hex: [96, 0, 0], sha384_base64: [64, 1, 0], sha384_base64url: [64, 2, 0],
  sha512_hex: [128, 0, 0], sha512_base64: [86, 1, 2], sha512_base64url: [86, 2, 0],
} as const;
(z as any).ZodError = ZodError;
(z as any).ZodRealError = ZodRealError;
import { toJSONSchema } from "./jsonschema.ts";
(z as any).toJSONSchema = toJSONSchema;
(ZodType.prototype as any).toJSONSchema = function (this: any, params?: any) {
  return toJSONSchema(this, params);
};
export const globalConfig: any = _globalConfig;
export { globalRegistry, ZodRegistry };
export const locales = {
  en: () => ({ localeError: defaultMessage }),
  fr: () => ({ localeError: frLocaleError() }),
};
const _config = _sharedConfig;

// $constructor builds user-defined schema classes; $ZodType.init installs
// the _zod internals a custom parse needs. Our engines drive these through
// the TS-level _run shim, so memoized cycles close through them too.
function $constructor(name: string, init: (inst: any, def: any) => void) {
  const cls = class {
    _zod: any;
    constructor(def: any) { init(this, def); }
    _run(data: unknown) {
      const payload = { value: data, issues: [] as any[] };
      const r = this._zod.parse(payload, {});
      return r.issues.length
        ? { ok: false as const, issues: r.issues }
        : { ok: true as const, value: r.value, memo: r.memo };
    }
  };
  Object.defineProperty(cls, "name", { value: name });
  return cls;
}

// z.core — the v4/core namespace: error classes + error walkers
export const core = {
  $ZodError, $ZodRealError: ZodRealError, ZodError, ZodRealError,
  $ZodType: ZodType, $ZodPipe: ZodPipe, $ZodCodec: ZodCodec, $ZodTransform: ZodTransform,
  $ZodAsyncError: AsyncCheckError,
  _parse, _safeParse, _parseAsync, _safeParseAsync,
  _encode: _encodeFn, _encodeAsync: _encodeAsyncFn,
  _safeEncode: _safeEncodeFn, _safeEncodeAsync: _safeEncodeAsyncFn,
  _decode: _parse, _decodeAsync: _parseAsync,
  _safeDecode: _safeParse, _safeDecodeAsync: _safeParseAsync,
  flattenError: _flattenError, formatError: _formatError,
  treeifyError: _treeifyError, prettifyError: _prettifyError,
  toDotPath: _toDotPath,
  isRecursiveSchema: (s: any) => isRecursiveSchema(s),
  config: _config, globalConfig, memoizer: _memoizerFactory,
  util: { isPlainObject: _azIsPlainObject, shallowClone: _azShallowClone, toZod: (<T>() => (s: ZodTypeAny) => s) as any },
  toZod: (<T>() => (s: ZodTypeAny) => s) as any,
  globalRegistry,
  $constructor,
};
(z as any).core = core;

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
function renderZodSrc(s: any, d = 0): string {
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
    case "array": return `z.array(${renderZodSrc(def.element, d + 1)})`;
    case "tuple": return `z.tuple([${(def.items ?? []).map((i: any) => renderZodSrc(i, d + 1)).join(", ")}])`;
    case "record":
      return def.keyType
        ? `z.record(${renderZodSrc(def.keyType, d + 1)}, ${renderZodSrc(def.valueType, d + 1)})`
        : `z.record(z.string(), ${renderZodSrc(def.valueType, d + 1)})`;
    case "union": return `z.union([${def.options.map((o: any) => renderZodSrc(o, d + 1)).join(", ")}])`;
    case "optional": return `${renderZodSrc(def.inner, d + 1)}.optional()`;
    case "nullable": return `${renderZodSrc(def.inner, d + 1)}.nullable()`;
    case "default": return `${renderZodSrc(def.inner, d + 1)}.default(${JSON.stringify(def.value)})`;
    case "object": {
      const parts = Object.entries(def.shape ?? {}).map(([k, v]) => `${JSON.stringify(k)}: ${renderZodSrc(v, d + 1)}`);
      const mk = def.mode === "strict" ? "z.strictObject" : def.mode === "passthrough" ? "z.looseObject" : "z.object";
      return `${mk}({ ${parts.join(", ")} })`;
    }
    case "lazy": return "z.lazy(() => /* recursive */)";
    case "map": return `z.map(${renderZodSrc(def.keyType, d + 1)}, ${renderZodSrc(def.valueType, d + 1)})`;
    case "set": return `z.set(${renderZodSrc(def.valueType, d + 1)})`;
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
  nonoptional, readonly, refine, superRefine, transform, _default,
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
  regexes,
} = z;
export { setErrorMap, getErrorMap, fromJSONSchema };
export const toZod = z.toZod;
export const ZodIssueCode = z.ZodIssueCode;
export { renderZodSrc };
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

// $Zod* aliases so zod/v4/core imports resolve to the same classes
export {
  ZodType as $ZodType, ZodString as $ZodString, ZodNumber as $ZodNumber,
  ZodBigInt as $ZodBigInt, ZodBoolean as $ZodBoolean, ZodAny as $ZodAny,
  ZodUnknown as $ZodUnknown, ZodNever as $ZodNever, ZodNull as $ZodNull,
  ZodUndefined as $ZodUndefined, ZodVoid as $ZodVoid, ZodNaN as $ZodNaN,
  ZodSymbol as $ZodSymbol, ZodDate as $ZodDate, ZodOptional as $ZodOptional,
  ZodNullable as $ZodNullable, ZodExactOptional as $ZodExactOptional, ZodDefault as $ZodDefault, ZodCatch as $ZodCatch,
  ZodEffects as $ZodEffects, ZodPipe as $ZodPipe, ZodBranded as $ZodBranded,
  ZodObject as $ZodObject, ZodArray as $ZodArray, ZodTuple as $ZodTuple,
  ZodRecord as $ZodRecord, ZodNonOptional as $ZodNonOptional, ZodMap as $ZodMap,
  ZodSet as $ZodSet, ZodUnion as $ZodUnion,
  ZodDiscriminatedUnion as $ZodDiscriminatedUnion,
  ZodIntersection as $ZodIntersection, ZodLiteral as $ZodLiteral,
  ZodEnum as $ZodEnum, ZodLazy as $ZodLazy, ZodPromise as $ZodPromise,
  ZodCustom as $ZodCustom, ZodStringbool as $ZodStringbool, ZodFile as $ZodFile,
  ZodCodec as $ZodCodec, ZodInstanceof as $ZodInstanceof,
  ZodFunction as $ZodFunction, ZodTransform as $ZodTransform,
} from "./schema.ts";
// $ZodError/ZodError/ZodRealError come through `export *` from error.ts
