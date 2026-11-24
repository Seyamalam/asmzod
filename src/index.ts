// index.ts — the z factory object + public exports
import {
  ZodString, ZodNumber, ZodBigInt, ZodBoolean, ZodAny, ZodUnknown, ZodNever,
  ZodNull, ZodUndefined, ZodVoid, ZodNaN, ZodSymbol, ZodDate, ZodObject,
  ZodArray, ZodTuple, ZodRecord, ZodUnion, ZodDiscriminatedUnion,
  ZodIntersection, ZodLiteral, ZodEnum, ZodLazy, ZodInstanceof, ZodCustom,
  ZodOptional, ZodNullable, ZodDefault, ZodCatch, ZodEffects, ZodPipe,
  ZodBranded, ZodMap, ZodSet, ZodType, ZodPromise, ZodFunction,
  type ZodTypeAny, type ZodRawShape,
} from "./schema.ts";
import { reg, regId } from "./ffi.ts";
import { configure, setErrorMap, getErrorMap } from "./shared.ts";

export * from "./schema.ts";
export * from "./error.ts";
export { engineVersion, engineBackend } from "./ffi.ts";

export const z = {
  string: (params?: any) => new ZodString({ type: "string", checks: [], error: params }),
  number: (params?: any) => new ZodNumber({ type: "number", checks: [], error: params }),
  bigint: (params?: any) => new ZodBigInt({ type: "bigint", checks: [], error: params }),
  boolean: (params?: any) => new ZodBoolean({ type: "boolean", checks: [], error: params }),
  date: (params?: any) => new ZodDate({ type: "date", checks: [], error: params }),
  symbol: (params?: any) => new ZodSymbol({ type: "symbol", checks: [], error: params }),
  any: (params?: any) => new ZodAny({ type: "any", checks: [], error: params }),
  unknown: (params?: any) => new ZodUnknown({ type: "unknown", checks: [], error: params }),
  never: (params?: any) => new ZodNever({ type: "never", checks: [], error: params }),
  null: (params?: any) => new ZodNull({ type: "null", checks: [], error: params }),
  undefined: (params?: any) => new ZodUndefined({ type: "undefined", checks: [], error: params }),
  void: (params?: any) => new ZodVoid({ type: "void", checks: [], error: params }),
  nan: (params?: any) => new ZodNaN({ type: "nan", checks: [], error: params }),

  object: <T extends ZodRawShape>(shape: T, params?: any) =>
    new ZodObject<T>({ type: "object", shape, mode: "strip", catchall: null, error: params }),
  strictObject: <T extends ZodRawShape>(shape: T, params?: any) =>
    new ZodObject<T>({ type: "object", shape, mode: "strict", catchall: null, error: params }),
  looseObject: <T extends ZodRawShape>(shape: T, params?: any) =>
    new ZodObject<T>({ type: "object", shape, mode: "passthrough", catchall: null, error: params }),
  promise: <T extends ZodTypeAny>(inner: T) =>
    new ZodPromise<T>({ type: "instof", ctor: Promise, name: "promise", inner }),
  function: (opts?: { input?: ZodTypeAny[]; output?: ZodTypeAny }) =>
    new ZodFunction({
      type: "instof", ctor: Function, name: "function",
      args: opts?.input ?? null, ret: opts?.output ?? null,
    }),
  preprocess: <T extends ZodTypeAny>(fn: (v: unknown) => unknown, schema: T) =>
    new ZodPipe<ZodEffects<ZodAny>, T>({
      type: "pipe",
      in: new ZodEffects<ZodAny>({ type: "transform", inner: new ZodAny(), cbid: regId(reg.transform, fn) }),
      out: schema,
    }),

  array: <T extends ZodTypeAny>(element: T, params?: any) =>
    new ZodArray<T>({ type: "array", element, error: params }),
  tuple: <T extends ZodTypeAny[]>(items: [...T], params?: any) =>
    new ZodTuple<T>({ type: "tuple", items, rest: null, error: params }),
  record: ((keyOrVal: ZodTypeAny, val?: ZodTypeAny) =>
    val === undefined
      ? new ZodRecord({ type: "record", keyType: null, valueType: keyOrVal })
      : new ZodRecord({ type: "record", keyType: keyOrVal, valueType: val })) as {
    <V extends ZodTypeAny>(value: V): ZodRecord<ZodString, V>;
    <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V): ZodRecord<K, V>;
  },
  map: <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V) =>
    new ZodMap<K, V>({ type: "map", keyType: key, valueType: value }),
  set: <V extends ZodTypeAny>(value: V) =>
    new ZodSet<V>({ type: "set", valueType: value }),

  union: <T extends ZodTypeAny[]>(options: [...T], params?: any) =>
    new ZodUnion<T>({ type: "union", options, error: params }),
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
  intersection: <A extends ZodTypeAny, B extends ZodTypeAny>(l: A, r: B) =>
    new ZodIntersection<A, B>({ type: "intersect", left: l, right: r }),

  literal: <T extends string | number | boolean | bigint | null | undefined>(v: T, params?: any) =>
    new ZodLiteral<T>({ type: "literal", value: v, error: params }),
  enum: <T extends string>(values: [T, ...T[]], params?: any) =>
    new ZodEnum<T>({ type: "enum", values, error: params }),
  nativeEnum: (e: object) => {
    const vals = Object.values(e).filter((v) => typeof v === "string");
    return new ZodEnum({ type: "enum", values: vals });
  },

  lazy: <T extends ZodTypeAny>(getter: () => T) =>
    new ZodLazy<T>({ type: "lazy", getter }),
  instanceof: <T>(ctor: new (...a: any[]) => T) =>
    new ZodInstanceof<T>({ type: "instof", ctor, name: ctor.name ?? "object" }),
  custom: <T>(fn: (v: unknown) => boolean, message?: string) =>
    new ZodCustom<T>({ type: "custom", cbid: regId(reg.custom, fn), message }),

  coerce: {
    string: () => new ZodEffects<ZodString, string>({
      type: "coerce_str",
      inner: new ZodString(),
    }),
    number: () => new ZodEffects<ZodNumber, number>({
      type: "coerce_num",
      inner: new ZodNumber(),
    }),
    boolean: () => new ZodEffects<ZodBoolean, boolean>({
      type: "coerce_bool",
      inner: new ZodBoolean(),
    }),
    bigint: () => new ZodEffects<ZodBigInt, bigint>({
      type: "coerce_bigint",
      inner: new ZodBigInt(),
    }),
    date: () => {
      // coerce to date needs a JS callback — implement via custom transform later
      throw new Error("asmzod: z.coerce.date() not supported in v1");
    },
  },

  optional: <T extends ZodTypeAny>(s: T) => new ZodOptional<T>({ type: "optional", inner: s }),
  nullable: <T extends ZodTypeAny>(s: T) => new ZodNullable<T>({ type: "nullable", inner: s }),
  nullish: <T extends ZodTypeAny>(s: T) => new ZodNullable<T>({ type: "nullable", inner: s }).optional(),
  default: <T extends ZodTypeAny>(s: T, v: T["_input"]) =>
    new ZodDefault<T>({ type: "default", inner: s, value: v }),
  catch: <T extends ZodTypeAny>(s: T, v: T["_input"]) => s.catch(v),
  brand: <T extends ZodTypeAny>(s: T) => s.brand(),
  nonoptional: <T extends ZodTypeAny>(s: T) => s.nonoptional(),
  readonly: <T extends ZodTypeAny>(s: T) => s.readonly(),
  refine: (fn: (v: unknown) => boolean, message?: string) =>
    new ZodAny().refine(fn, message),
  superRefine: (fn: (v: unknown, ctx: any) => void) =>
    new ZodAny().superRefine(fn),
  transform: (fn: (v: unknown) => unknown) => new ZodAny().transform(fn),

  // string-format factories — equivalent to z.string().<fmt>()
  email: (p?: string) => new ZodString().email(p),
  url: (p?: string) => new ZodString().url(p),
  uuid: (p?: string) => new ZodString().uuid(p),
  uuidv4: (p?: string) => new ZodString().uuidv4(p),
  uuidv6: (p?: string) => new ZodString().uuidv6(p),
  uuidv7: (p?: string) => new ZodString().uuidv7(p),
  guid: (p?: string) => new ZodString().guid(p),
  cuid: (p?: string) => new ZodString().cuid(p),
  cuid2: (p?: string) => new ZodString().cuid2(p),
  ulid: (p?: string) => new ZodString().ulid(p),
  nanoid: (p?: string) => new ZodString().nanoid(p),
  emoji: (p?: string) => new ZodString().emoji(p),
  base64: (p?: string) => new ZodString().base64(p),
  base64url: (p?: string) => new ZodString().base64url(p),
  jwt: (p?: string) => new ZodString().jwt(p),
  hex: (p?: string) => new ZodString().hex(p),
  xid: (p?: string) => new ZodString().xid(p),
  ksuid: (p?: string) => new ZodString().ksuid(p),
  // [bodylen, alpha 0hex/1b64/2b64url, padlen] per zod4 fixedBase64 tables
  hash: (alg: string, params?: any) => {
    const enc = (typeof params === "object" && params !== null ? params.enc : undefined) ?? "hex";
    const fmt = `${alg}_${enc}`;
    const t = (HASH_LENS as Record<string, [number, number, number]>)[fmt];
    if (!t) throw new Error(`Unrecognized hash format: ${fmt}`);
    return (new ZodString() as any)._check({ kind: "hash", body: t[0], alpha: t[1], pad: t[2], format: fmt, message: params });
  },
  uint64: (params?: any) =>
    new ZodBigInt({ type: "bigint", checks: [], error: params })
      .min(0n).max(18446744073709551615n),
  e164: (p?: string) => new ZodString().e164(p),
  duration: (p?: string) => new ZodString().duration(p),
  ipv4: (p?: string) => new ZodString().ipv4(p),
  ipv6: (p?: string) => new ZodString().ipv6(p),
  cidrv4: (p?: string) => new ZodString().cidrv4(p),
  cidrv6: (p?: string) => new ZodString().cidrv6(p),
  hostname: (p?: string) => new ZodString().hostname(p),
  httpUrl: (p?: string) => new ZodString().httpUrl(p),
  config: (opts: any) => configure(opts),
  setErrorMap: (fn?: (i: any) => string | undefined) => setErrorMap(fn),
  getErrorMap: () => getErrorMap(),
  iso: {
    datetime: (p?: string) => new ZodString().datetime(p),
    date: (p?: string) => new ZodString().date(p),
    time: (p?: string) => new ZodString().time(p),
    duration: (p?: string) => new ZodString().duration(p),
  },

  file: () => new ZodInstanceof<File>({
    type: "instof",
    ctor: (globalThis as any).File,
    name: "file",
  }),
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
