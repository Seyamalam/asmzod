import * as _z from "./index.ts";

export * from "./index.ts";

const CLASSIC_ONLY = new Set(["validate", "validateAsync"]);

const _raw = new WeakMap<object, any>();

const mini = <T>(s: T): T => {
  const p = new Proxy(s as any, {
    has: (t, k) => !CLASSIC_ONLY.has(k as string) && Reflect.has(t, k),
    get: (t, k, r) => (CLASSIC_ONLY.has(k as string) ? undefined : Reflect.get(t, k, t)),
  });
  _raw.set(p, s);
  return p;
};

// mini keeps the standalone validator; schemas carry no validate method
export const validate = (s: any, data: unknown, params?: any) => (_raw.get(s) ?? s).validate(data, params);
export const validateAsync = (s: any, data: unknown, params?: any) => (_raw.get(s) ?? s).validateAsync(data, params);

export const string = (...a: any[]) => mini((_z.string as any)(...a));
export const number = (...a: any[]) => mini((_z.number as any)(...a));
export const bigint = (...a: any[]) => mini((_z.bigint as any)(...a));
export const boolean = (...a: any[]) => mini((_z.boolean as any)(...a));
export const date = (...a: any[]) => mini((_z.date as any)(...a));
export const object = (...a: any[]) => mini((_z.object as any)(...a));
export const strictObject = (...a: any[]) => mini((_z.strictObject as any)(...a));
export const looseObject = (...a: any[]) => mini((_z.looseObject as any)(...a));
export const array = (...a: any[]) => mini((_z.array as any)(...a));
export const tuple = (...a: any[]) => mini((_z.tuple as any)(...a));
export const union = (...a: any[]) => mini((_z.union as any)(...a));
export const optional = (...a: any[]) => mini((_z.optional as any)(...a));
export const nullable = (...a: any[]) => mini((_z.nullable as any)(...a));
export const nullish = (...a: any[]) => mini((_z.nullish as any)(...a));
export const record = (...a: any[]) => mini((_z.record as any)(...a));
export const map = (...a: any[]) => mini((_z.map as any)(...a));
export const set = (...a: any[]) => mini((_z.set as any)(...a));
export const lazy = (...a: any[]) => mini((_z.lazy as any)(...a));
export const promise = (...a: any[]) => mini((_z.promise as any)(...a));
export const any = (...a: any[]) => mini((_z.any as any)(...a));
export const unknown = (...a: any[]) => mini((_z.unknown as any)(...a));
export const never = (...a: any[]) => mini((_z.never as any)(...a));
