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

// zod 4 parsedType: builtin/class objects report constructor.name; NaN reports
// "NaN" (capitalized — observed in issue fields/messages, unlike core's "nan")
export function parsedTypeName(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return "number";
  }
  if (t !== "object") return t;
  if (Array.isArray(v)) return "array";
  if (Object.getPrototypeOf(v) !== Object.prototype &&
      "constructor" in (v as object) && (v as any).constructor?.name)
    return (v as any).constructor.name;
  return "object";
}

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
  // regex-carried formats: the check embeds a `format` override so its
  // issues take the zod format name instead of "regex"
  guid: "guid", uuid6: "uuid", uuid7: "uuid", cuid: "cuid", xid: "xid",
  ksuid: "ksuid", e164: "e164", cidrv4: "cidrv4", cidrv6: "cidrv6",
  base64url: "base64url", jwt: "jwt", emoji: "emoji", duration: "duration",
  hostname: "hostname", httpurl: "url", template_literal: "template_literal",
};

// zod 4 default messages, keyed off normalized issue fields. Engines emit
// `message` only when the schema supplies a custom one; everything else lands
// here so all backends produce identical strings.
const FORMAT_MSGS: Record<string, string> = {
  email: "Invalid email address", uuid: "Invalid UUID", url: "Invalid URL",
  emoji: "Invalid emoji", nanoid: "Invalid nanoid", guid: "Invalid GUID",
  cuid: "Invalid cuid", cuid2: "Invalid cuid2", ulid: "Invalid ULID",
  xid: "Invalid XID", ksuid: "Invalid KSUID", hostname: "Invalid hostname",
  base64: "Invalid base64-encoded string", base64url: "Invalid base64url-encoded string",
  hex: "Invalid hex", ipv4: "Invalid IPv4 address", ipv6: "Invalid IPv6 address",
  cidrv4: "Invalid IPv4 range", cidrv6: "Invalid IPv6 range",
  e164: "Invalid E.164 number", jwt: "Invalid JWT",
  datetime: "Invalid ISO datetime", date: "Invalid ISO date", time: "Invalid ISO time",
  duration: "Invalid ISO duration", lowercase: "Invalid lowercase",
  uppercase: "Invalid uppercase", regex: "Invalid string: must match pattern",
  md5_hex: "Invalid md5_hex", md5_base64: "Invalid md5_base64", md5_base64url: "Invalid md5_base64url",
  sha1_hex: "Invalid sha1_hex", sha1_base64: "Invalid sha1_base64", sha1_base64url: "Invalid sha1_base64url",
  sha256_hex: "Invalid sha256_hex", sha256_base64: "Invalid sha256_base64", sha256_base64url: "Invalid sha256_base64url",
  sha384_hex: "Invalid sha384_hex", sha384_base64: "Invalid sha384_base64", sha384_base64url: "Invalid sha384_base64url",
  sha512_hex: "Invalid sha512_hex", sha512_base64: "Invalid sha512_base64", sha512_base64url: "Invalid sha512_base64url",
  template_literal: "Invalid input",
};

// zod exposes `origin: "string"` + the check's regex `pattern` on these formats
// only. hex/ipv6/url/base64/base64url issues carry neither field.
const FORMAT_PATTERNS: Record<string, string> = {
  email: "/^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/",
  uuid: "/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/",
  datetime: "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$/",
  date: "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$/",
  time: "/^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?$/",
  duration: "/^P(?:(\\d+W)|(?!.*W)(?=\\d|T\\d)(\\d+Y)?(\\d+M)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+([.,]\\d+)?S)?)?)$/",
  ipv4: "/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/",
  ulid: "/^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/",
  nanoid: "/^[a-zA-Z0-9_-]{21}$/",
  cuid2: "/^[0-9a-z]+$/",
  emoji: "/^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$/u",
  lowercase: "/^[^A-Z]*$/",
  uppercase: "/^[^a-z]*$/",
};

// zod exposes `received` only when a guard reports a value-qualified name
const EXPOSED_RECEIVED = new Set(["NaN", "Infinity", "-Infinity", "Invalid Date"]);

// formats whose issues carry origin:"string" — everything except
// hex/ipv6/url/base64/base64url
const FORMAT_ORIGIN = new Set([
  ...Object.keys(FORMAT_PATTERNS),
  "starts_with", "ends_with", "includes", "regex",
  "guid", "cuid", "xid", "ksuid", "e164", "cidrv4",
]);

// zod hides `pattern`/`origin` on these formats even when a regex carries
// the actual match pattern — strip the embedded pattern field on normalize
const FORMAT_NOPAT = new Set(["base64url", "jwt", "cidrv6", "hostname", "httpurl"]);

// formats whose issues carry an extra `note` field
const FORMAT_NOTES: Record<string, string> = {
  httpurl: "Invalid URL format",
};

function repr(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return `${v}n`;
  return String(v);
}

// error-param function registry — `check(msg, {error: fn})` compiles the
// sentinel "\0mN" into the check record; normalizeIssue resolves it by
// calling the function with the (still messageless) issue
export const msgFns: ((i: any) => string)[] = [];

// zod4 params: a message string or {message?, error?: string | fn}
// ---- error maps: zod message priority is schema/check error > per-parse
// error > config customError > default. engine-set messages are exempt;
// only defaulted (_dflt) issues get remapped.
export type ErrorMap = (issue: any) => string | undefined;
let globalErrorMap: ErrorMap | undefined;
export function setErrorMap(fn?: ErrorMap) { globalErrorMap = fn; }
export function getErrorMap() { return globalErrorMap; }
export function configure(opts: any) {
  if (opts && typeof opts === "object" && "customError" in opts) globalErrorMap = opts.customError;
}
export function applyErrorMaps(issues: any[], perCall?: any) {
  const pc: ErrorMap | undefined =
    typeof perCall === "function" ? perCall :
    typeof perCall === "string" ? () => perCall :
    perCall && typeof perCall === "object" && typeof perCall.message === "string" ? () => perCall.message :
    undefined;
  if (!pc && !globalErrorMap) { for (const i of issues) delete i._dflt; return; }
  for (const i of issues) {
    const dflt = i._dflt; delete i._dflt;
    if (!dflt) continue;
    const m = pc?.(i) ?? globalErrorMap?.(i);
    if (m !== undefined) i.message = m;
  }
}

export function paramMsg(p: any): string | undefined {
  if (p === undefined || p === null) return undefined;
  if (typeof p === "string") return p;
  const e = p.error ?? p.message;
  if (e === undefined) return undefined;
  if (typeof e === "string") return e;
  if (typeof e === "function") {
    msgFns.push(e);
    return `\0m${msgFns.length - 1}`;
  }
  return undefined;
}

export function defaultMessage(i: any): string {
  switch (i.code) {
    case "invalid_type": {
      // zod: message shows parsedType(input); the `received` field may carry a
      // guard-qualified name (Invalid Date) that the message does not use
      const recv = i.received === "Invalid Date" ? "Date" : i.received;
      return `Invalid input: expected ${i.expected === "nan" ? "NaN" : i.expected}` +
        (recv !== undefined ? `, received ${recv}` : "");
    }
    case "invalid_value":
      if (Array.isArray(i.values)) {
        if (i.values.length > 1)
          return `Invalid option: expected one of ${i.values.map(repr).join("|")}`;
        return `Invalid input: expected ${repr(i.values[0])}`;
      }
      return "Invalid input";
    case "invalid_format":
      if (i.format === "regex") return `Invalid string: must match pattern ${i.pattern}`;
      if (i.format === "starts_with") return `Invalid string: must start with "${i.prefix}"`;
      if (i.format === "ends_with") return `Invalid string: must end with "${i.suffix}"`;
      if (i.format === "includes") return `Invalid string: must include "${i.includes}"`;
      return FORMAT_MSGS[i.format] ?? `Invalid string: must match ${i.format}`;
    case "too_small": {
      const op = i.inclusive === false ? ">" : ">=";
      if (i.origin === "string" || i.origin === "array") {
        const unit = i.origin === "string" ? "characters" : "items";
        return i.exact
          ? `Too small: expected ${i.origin} to have exactly ${i.minimum} ${unit}`
          : `Too small: expected ${i.origin} to have ${op}${i.minimum} ${unit}`;
      }
      return i.exact
        ? `Too small: expected ${i.origin} to be exactly ${i.minimum}`
        : `Too small: expected ${i.origin} to be ${op}${i.minimum}`;
    }
    case "too_big": {
      const op = i.inclusive === false ? "<" : "<=";
      if (i.origin === "string" || i.origin === "array") {
        const unit = i.origin === "string" ? "characters" : "items";
        return i.exact
          ? `Too big: expected ${i.origin} to have exactly ${i.maximum} ${unit}`
          : `Too big: expected ${i.origin} to have ${op}${i.maximum} ${unit}`;
      }
      return i.exact
        ? `Too big: expected ${i.origin} to be exactly ${i.maximum}`
        : `Too big: expected ${i.origin} to be ${op}${i.maximum}`;
    }
    case "not_multiple_of": return `Invalid number: must be a multiple of ${i.divisor}`;
    case "unrecognized_keys": {
      const k = (i.keys ?? []).map((x: unknown) => JSON.stringify(x)).join(", ");
      return `Unrecognized key${i.keys?.length === 1 ? "" : "s"}: ${k}`;
    }
    case "invalid_union":
      if (i.note === "No matching discriminator" && Array.isArray(i.options))
        return `Invalid discriminator value. Expected ${i.options.map((o: unknown) => `'${o}'`).join(" | ")}`;
      return "Invalid input";
    case "invalid_intersection_results": return "Invalid intersection results";
    case "invalid_date": return "Invalid date";
    case "invalid_key": return `Invalid key in ${i.origin}`;
    case "custom": return "Invalid input";
    default: return "Invalid input";
  }
}

export function normalizeIssue(i: any): any {
  if (i == null || typeof i !== "object") return i;
  // engine issues are fresh objects — mutate in place (spread was ~40% of cost)
  const out: any = i;
  switch (i.code) {
    case "invalid_literal":
      out.code = "invalid_value";
      out.values = [i.expected];
      delete out.expected;
      break;
    case "invalid_enum_value":
      out.code = "invalid_value";
      out.values = i.options;
      delete out.options;
      delete out.received;
      break;
    case "invalid_string": {
      const val = i.validation;
      out.code = "invalid_format";
      if (val !== undefined) {
        out.format = FORMAT_NAMES[val] ?? val;
        delete out.validation;
      }
      if (FORMAT_ORIGIN.has(out.format)) out.origin = "string";
      if (FORMAT_PATTERNS[out.format] !== undefined && out.pattern === undefined)
        out.pattern = FORMAT_PATTERNS[out.format];
      if (FORMAT_NOPAT.has(out.format) || FORMAT_NOPAT.has(val)) {
        delete out.pattern;
        delete out.origin;
      }
      if (FORMAT_NOTES[val] !== undefined)
        out.note = FORMAT_NOTES[val];
      break;
    }
    case "not_multiple_of":
      out.origin = "number";
      break;
    case "not_finite":
      out.code = "invalid_type";
      out.expected = "number";
      out.received = "Infinity";
      break;
    case "too_small":
    case "too_big":
      if (i.type !== undefined) { out.origin = i.type; delete out.type; }
      break;
  }
  if (out.code === "invalid_type" && out.expected === "int") out.format = "safeint";
  if (out.message === undefined) {
    out.message = defaultMessage(out);
    out._dflt = true;
  } else if (typeof out.message === "string" && out.message.charCodeAt(0) === 0) {
    const fn = msgFns[+out.message.slice(2)];
    const { message: _m, ...rest } = out;
    out.message = fn ? fn(rest) : _m;
  }
  // zod folds `received` into the message but exposes it as a field only from
  // guards that produce a value-qualified name: number-family NaN/Infinity and
  // date's Invalid Date
  if (out.received !== undefined) {
    const keep = out._keepReceived ||
      (EXPOSED_RECEIVED.has(out.received) &&
       (out.expected === "number" || out.expected === "int")) ||
      (out.received === "Invalid Date" && out.expected === "date");
    if (!keep) delete out.received;
  }
  delete out._keepReceived;
  return out;
}

// engines emit record-key failures as a flat stream: inner key-schema issues
// followed by an `invalid_key` wrapper carrying `_k` = child count. Fold the
// children under their wrapper (zod nests them as `issues`).
export function finishIssues(issues: any[]): any[] {
  let cut = false;
  for (let i = 0; i < issues.length; i++) {
    const k = (issues[i] as any)._k;
    if (k === undefined) continue;
    delete (issues[i] as any)._k;
    if (k > 0) {
      (issues[i] as any).issues = issues.splice(i - k, k);
      i -= k;
      cut = true;
    }
  }
  return issues;
}
