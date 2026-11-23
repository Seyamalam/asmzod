// shared.ts — registries shared by the native drivers and the portable engine.
// cb ids written into the bytecode index into these arrays.
export const reg = {
  refine: [] as ((v: unknown) => unknown)[],
  transform: [] as ((v: unknown) => unknown)[],
  lazy: [] as (() => Uint8Array)[],
  regex: [] as RegExp[],
  ctor: [] as (new (...a: any[]) => any)[],
  custom: [] as ((v: unknown) => boolean)[],
};

export function regId<T>(arr: T[], v: T): number {
  arr.push(v);
  return arr.length - 1;
}

// ---- zod4 issue normalization ----
// engines emit structured low-level issues; translate to zod@4 shapes
const FORMAT_NAMES: Record<string, string> = {
  email: "email", uuid: "uuid", url: "url", regex: "regex",
  startsWith: "starts_with", endsWith: "ends_with", includes: "includes",
  lowercase: "lowercase", uppercase: "uppercase",
  ipv4: "ipv4", ipv6: "ipv6", ulid: "ulid", nanoid: "nanoid",
  cuid2: "cuid2", base64: "base64", hex: "hex",
  datetime: "datetime", date: "date", time: "time",
};

export function normalizeIssue(i: any): any {
  if (i == null || typeof i !== "object") return i;
  const out: any = { ...i };
  switch (i.code) {
    case "invalid_literal":
    case "invalid_enum_value":
      out.code = "invalid_value";
      break;
    case "invalid_string":
      out.code = "invalid_format";
      if (i.validation !== undefined) {
        out.format = FORMAT_NAMES[i.validation] ?? i.validation;
        delete out.validation;
      }
      break;
    case "not_finite":
      out.code = "invalid_type";
      break;
    case "too_small":
    case "too_big":
      if (i.type !== undefined) { out.origin = i.type; delete out.type; }
      break;
  }
  return out;
}
