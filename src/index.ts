// index.ts — the z factory object + public exports
import {
  ZodString, ZodNumber, ZodBigInt, ZodBoolean, ZodAny, ZodUnknown, ZodNever,
  ZodNull, ZodUndefined, ZodVoid, ZodNaN, ZodSymbol, ZodDate, ZodObject,
  ZodArray, ZodTuple, ZodRecord, ZodUnion, ZodDiscriminatedUnion,
  ZodIntersection, ZodLiteral, ZodEnum, ZodLazy, ZodInstanceof, ZodCustom,
  ZodOptional, ZodNullable, ZodDefault, ZodCatch, ZodEffects, ZodPipe,
  ZodBranded, ZodMap, ZodSet, ZodType, ZodPromise, ZodFunction,
  ZodStringbool, ZodXor, ZodFile, ZodCodec,
  type ZodTypeAny, type ZodRawShape,
} from "./schema.ts";
import { reg, regId } from "./ffi.ts";
import { configure, setErrorMap, getErrorMap } from "./shared.ts";

export * from "./schema.ts";
export * from "./error.ts";
export { engineVersion, engineBackend } from "./ffi.ts";

export const z = {
  /** Create a string schema. */
  string: (params?: any) => new ZodString({ type: "string", checks: [], error: params }),
  /** Create a number schema (rejects NaN/Infinity by default, like zod). */
  number: (params?: any) => new ZodNumber({ type: "number", checks: [], error: params }),
  /** Create a bigint schema. */
  bigint: (params?: any) => new ZodBigInt({ type: "bigint", checks: [], error: params }),
  /** Create a boolean schema. */
  boolean: (params?: any) => new ZodBoolean({ type: "boolean", checks: [], error: params }),
  /** Create a Date schema. */
  date: (params?: any) => new ZodDate({ type: "date", checks: [], error: params }),
  /** Create a symbol schema. */
  symbol: (params?: any) => new ZodSymbol({ type: "symbol", checks: [], error: params }),
  /** Schema that accepts any value. */
  any: (params?: any) => new ZodAny({ type: "any", checks: [], error: params }),
  /** Schema that accepts any value typed as unknown. */
  unknown: (params?: any) => new ZodUnknown({ type: "unknown", checks: [], error: params }),
  /** Schema that rejects every value. */
  never: (params?: any) => new ZodNever({ type: "never", checks: [], error: params }),
  /** Schema accepting only null. */
  null: (params?: any) => new ZodNull({ type: "null", checks: [], error: params }),
  /** Schema accepting only undefined. */
  undefined: (params?: any) => new ZodUndefined({ type: "undefined", checks: [], error: params }),
  /** Schema accepting only undefined (void). */
  void: (params?: any) => new ZodVoid({ type: "void", checks: [], error: params }),
  /** Schema accepting only NaN. */
  nan: (params?: any) => new ZodNaN({ type: "nan", checks: [], error: params }),

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
  file: (params?: any) => new ZodFile({ type: "file", checks: [], error: params }),
  /** Bidirectional codec: parse via decode (in->out), .encode() via encode. */
  codec: <A extends ZodTypeAny, B extends ZodTypeAny>(
    inSchema: A, outSchema: B,
    params: { decode: (v: A["_output"]) => B["_input"]; encode: (v: B["_output"]) => A["_input"] },
  ) => new ZodCodec<A, B>({
    type: "codec", in: inSchema, out: outSchema,
    transform: params.decode, reverseTransform: params.encode,
  }),
  /** Check factory for use with .check(...). */
  check: (fn: (ctx: any) => void) => fn,

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
    string: () => new ZodEffects<ZodString, string>({
      type: "coerce_str",
      inner: new ZodString(),
    }),
    /** Create a number schema (rejects NaN/Infinity by default, like zod). */
    number: () => new ZodEffects<ZodNumber, number>({
      type: "coerce_num",
      inner: new ZodNumber(),
    }),
    /** Create a boolean schema. */
    boolean: () => new ZodEffects<ZodBoolean, boolean>({
      type: "coerce_bool",
      inner: new ZodBoolean(),
    }),
    /** Create a bigint schema. */
    bigint: () => new ZodEffects<ZodBigInt, bigint>({
      type: "coerce_bigint",
      inner: new ZodBigInt(),
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
    new ZodBigInt({ type: "bigint", checks: [], error: params })
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
