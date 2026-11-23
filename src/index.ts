// index.ts — the z factory object + public exports
import {
  ZodString, ZodNumber, ZodBigInt, ZodBoolean, ZodAny, ZodUnknown, ZodNever,
  ZodNull, ZodUndefined, ZodVoid, ZodNaN, ZodSymbol, ZodDate, ZodObject,
  ZodArray, ZodTuple, ZodRecord, ZodUnion, ZodDiscriminatedUnion,
  ZodIntersection, ZodLiteral, ZodEnum, ZodLazy, ZodInstanceof, ZodCustom,
  ZodOptional, ZodNullable, ZodDefault, ZodCatch, ZodEffects, ZodPipe,
  ZodBranded, ZodType, ZodTypeAny, type ZodRawShape,
} from "./schema";
import { reg, regId } from "./ffi";

export * from "./schema";
export * from "./error";
export { engineVersion } from "./ffi";

export const z = {
  string: () => new ZodString(),
  number: () => new ZodNumber(),
  bigint: () => new ZodBigInt(),
  boolean: () => new ZodBoolean(),
  date: () => new ZodDate(),
  symbol: () => new ZodSymbol(),
  any: () => new ZodAny(),
  unknown: () => new ZodUnknown(),
  never: () => new ZodNever(),
  null: () => new ZodNull(),
  undefined: () => new ZodUndefined(),
  void: () => new ZodVoid(),
  nan: () => new ZodNaN(),

  object: <T extends ZodRawShape>(shape: T) =>
    new ZodObject<T>({ type: "object", shape, mode: "strip", catchall: null }),
  strictObject: <T extends ZodRawShape>(shape: T) =>
    new ZodObject<T>({ type: "object", shape, mode: "strict", catchall: null }),

  array: <T extends ZodTypeAny>(element: T) =>
    new ZodArray<T>({ type: "array", element }),
  tuple: <T extends ZodTypeAny[]>(items: [...T]) =>
    new ZodTuple<T>({ type: "tuple", items, rest: null }),
  record: ((keyOrVal: ZodTypeAny, val?: ZodTypeAny) =>
    val === undefined
      ? new ZodRecord({ type: "record", keyType: null, valueType: keyOrVal })
      : new ZodRecord({ type: "record", keyType: keyOrVal, valueType: val })) as {
    <V extends ZodTypeAny>(value: V): ZodRecord<ZodString, V>;
    <K extends ZodTypeAny, V extends ZodTypeAny>(key: K, value: V): ZodRecord<K, V>;
  },

  union: <T extends ZodTypeAny[]>(options: [...T]) =>
    new ZodUnion<T>({ type: "union", options }),
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

  literal: <T extends string | number | boolean | bigint | null | undefined>(v: T) =>
    new ZodLiteral<T>({ type: "literal", value: v }),
  enum: <T extends string>(values: [T, ...T[]]) =>
    new ZodEnum<T>({ type: "enum", values }),
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
  default: <T extends ZodTypeAny>(s: T, v: T["_input"]) =>
    new ZodDefault<T>({ type: "default", inner: s, value: v }),

  // zod3 compatibility aliases
  ZodError: undefined as unknown as typeof import("./error").ZodError,
};

// attach the real class
import { ZodError } from "./error";
(z as any).ZodError = ZodError;

export default z;
export type { ZodType } from "./schema";
export type infer<T extends ZodType<any, any>> = T["_output"];
export type input<T extends ZodType<any, any>> = T["_input"];
export type output<T extends ZodType<any, any>> = T["_output"];
export namespace z {
  export type infer<T extends ZodType<any, any>> = T["_output"];
  export type input<T extends ZodType<any, any>> = T["_input"];
  export type output<T extends ZodType<any, any>> = T["_output"];
}
