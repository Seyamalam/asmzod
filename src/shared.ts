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

// zod's abort sentinel — a transform/preprocess returns it to kill the chain
export const NEVER: never = Object.freeze({ status: "aborted" }) as never;

// the payload ctx zod hands transform/preprocess callbacks — issues pushed
// here ride along in the run's issue list (fatal by default downstream)
export const _addIssueCtx = (pushed: any[], inst?: any, value?: any): any => ({
  value,
  issues: pushed,
  addIssue: (issue: any) => {
    if (typeof issue === "string") {
      pushed.push({ message: issue, code: "custom", input: value, inst });
      return;
    }
    if (issue.fatal) issue.continue = false;
    issue.code ??= "custom";
    if (!("input" in issue)) issue.input = value;
    issue.inst ??= inst;
    pushed.push(issue);
  },
});

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

// zod's regexes.ts ISO sources — datetime/time honor local/offset/precision
export const _isoDateSrc = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
export const _isoTimeSrc = (a: { precision?: number | null; seconds?: boolean }): string => {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  if (typeof a.precision === "number")
    return a.precision === -1 ? hhmm
      : a.precision === 0 ? `${hhmm}:[0-5]\\d`
      : `${hhmm}:[0-5]\\d\\.\\d{${a.precision}}`;
  return a.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
};
export const _isoRe = {
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
  mac: "Invalid MAC address",
};

// zod exposes `origin: "string"` + the check's regex `pattern` on these formats
// only. hex/ipv6/url/base64/base64url issues carry neither field.
export const FORMAT_PATTERNS: Record<string, string> = {
  email: "/^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/",
  uuid: "/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/",
  datetime: "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$/",
  date: "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$/",
  time: "/^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?$/",
  duration: "/^P(?:(\\d+W)|(?!.*W)(?=\\d|T\\d)(\\d+Y)?(\\d+M)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+([.,]\\d+)?S)?)?)$/",
  ipv4: "/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/",
  ulid: "/^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/",
  nanoid: "/^[a-zA-Z0-9_-]{21}$/",
  cuid: "/^[cC][0-9a-z]{6,}$/",
  cuid2: "/^[0-9a-z]+$/",
  emoji: "/^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$/u",
  lowercase: "/^[^A-Z]*$/",
  uppercase: "/^[^a-z]*$/",
  mac: "/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/",
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
export const FORMAT_NOPAT = new Set(["base64url", "jwt", "cidrv6", "hostname", "httpurl", "ipv6", "url"]);

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
// issues whose message came from defaultMessage (not schema/engine custom)
// — WeakSet so the marker can't leak into user-visible keys
export const defaultedIssues = new WeakSet<object>();
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
  if (!pc && !globalErrorMap) return;
  const walk = (i: any) => {
    if (i == null || typeof i !== "object") return;
    if (defaultedIssues.has(i)) {
      const m = pc?.(i) ?? globalErrorMap?.(i);
      if (m !== undefined) i.message = m;
    }
    // union issues carry per-option errors arrays — maps apply there too
    if (Array.isArray(i.errors)) for (const e of i.errors) for (const j of e) walk(j);
  };
  for (const i of issues) walk(i);
}

export function paramMsg(p: any): string | undefined {
  if (p === undefined || p === null) return undefined;
  if (typeof p === "string") return p;
  const e = p.error ?? p.message;
  if (e === undefined) return undefined;
  if (typeof e === "string") {
    if (e === "") { msgFns.push(() => ""); return `\0m${msgFns.length - 1}`; }
    return e;
  }
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
      const recv = i.received === "Invalid Date" ? "Date" : (i.received ?? ("input" in i ? parsedTypeName(i.input) : undefined));
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
      const unit = i.origin === "string" ? "characters" : i.origin === "map" ? "entries" : "items";
      if (i.origin === "string" || i.origin === "array" || i.origin === "set" || i.origin === "map") {
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
      const unit = i.origin === "string" ? "characters" : i.origin === "map" ? "entries" : "items";
      if (i.origin === "string" || i.origin === "array" || i.origin === "set" || i.origin === "map") {
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
    defaultedIssues.add(out);
  } else if (typeof out.message === "string" && out.message.charCodeAt(0) === 0) {
    const fn = msgFns[+out.message.slice(2)];
    const { message: _m, ...rest } = out;
    const resolved = fn ? fn(rest) : _m;
    out.message = unwrapMessage(resolved) ?? resolved;
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
  // zod's issue objects carry fields in creation order — snapshots serialize
  // that order, so normalize to it (expected-first for invalid_type etc)
  // zod builds nonoptional issues from a code-first literal, unlike the
  // expected-first order of every other invalid_type
  // tuple arity issues are code-first literals in zod ({code, maximum,
  // inclusive, origin}) — never carrying `exact` like a length check would
  const ord = out.code === "invalid_type" && out.expected === "nonoptional"
    ? NONOPT_ORDER : out._arity ? ARITY_ORDER : ISSUE_ORDER[out.code as string];
  if (out._arity) { delete out._arity; delete out.exact; }
  if (ord) {
    const ordOut: any = {};
    for (const k of ord) if (k in out) ordOut[k] = out[k];
    for (const k of Object.keys(out)) if (!(k in ordOut)) ordOut[k] = out[k];
    if (defaultedIssues.has(out)) { defaultedIssues.delete(out); defaultedIssues.add(ordOut); }
    return ordOut;
  }
  return out;
}

const NONOPT_ORDER = ["code", "expected", "input", "path", "message"];
// zod's tuple-arity literal: code, minimum|maximum, inclusive, origin
const ARITY_ORDER = ["code", "minimum", "maximum", "inclusive", "origin", "path", "message", "input"];
// field order of zod issue objects (their finalizeIssue copies creation order)
const ISSUE_ORDER: Record<string, string[]> = {
  invalid_type: ["expected", "format", "code", "received", "input", "path", "message"],
  invalid_value: ["code", "values", "path", "message", "input"],
  invalid_key: ["code", "origin", "issues", "input", "path", "message"],
  unrecognized_keys: ["code", "keys", "path", "message"],
  too_small: ["origin", "code", "minimum", "inclusive", "path", "message", "exact"],
  too_big: ["origin", "code", "maximum", "inclusive", "path", "message", "exact"],
  invalid_format: ["origin", "code", "format", "pattern", "includes", "prefix", "suffix", "position", "algorithm", "minimum", "maximum", "delimiter", "encoding", "path", "message", "note"],
  not_multiple_of: ["code", "divisor", "path", "message"],
  invalid_union: ["code", "errors", "inclusive", "matches", "path", "message"],
};

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

// zod's mutable global config — containers install the default memoizer on
// construction so `delete z.config().memoizer` restores on next schema init
// schema -> metadata store; `get` inherits the _zod.parent chain (minus id)
export class ZodRegistry {
  _map = new WeakMap<object, any>();
  _idmap = new Map<string, any>();
  add(schema: any, meta?: any) {
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
    return this;
  }
  clear() {
    this._map = new WeakMap();
    this._idmap = new Map();
    return this;
  }
  remove(schema: any) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
    this._map.delete(schema);
    return this;
  }
  get(schema: any): any {
    const p = schema?._zod?.parent;
    if (p) {
      const pm: any = { ...(this.get(p) ?? {}) };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema: any) { return this._map.has(schema); }
}

// globalThis singleton: one registry shared across module copies
export const globalRegistry: ZodRegistry =
  ((globalThis as any).__zod_globalRegistry ??= new ZodRegistry());

// globalThis singleton: one config shared across CJS/ESM/bundled copies
export const globalConfig: any =
  ((globalThis as any).__zod_globalConfig ??= { memoizer: undefined });
export function config(cfg?: any) {
  if (cfg) { configure(cfg); Object.assign(globalConfig, cfg); }
  return globalConfig;
}
export const memoizerFactory = () => ({
  attach(_inst: any) {},
  alloc(_inst: any, _payload: any, empty: any) { return empty; },
  guard(_inst: any) {},
});
export function ensureDefaultMemoizer(): void {
  if (!globalConfig.memoizer) globalConfig.memoizer = memoizerFactory();
}

export function unwrapMessage(m: any): string | undefined {
  return typeof m === "string" ? m : m?.message;
}

// v8 captures the stack inside the Error ctor — suppress it for safeParse's
// lazily-built error; parse() re-adds frames with captureStackTrace. Latched
// off entirely when stackTraceLimit is unassignable (hardened realms) or
// captureStackTrace is absent (old Safari), where suppression is unrecoverable
let _suppE: any = "captureStackTrace" in Error ? Error : null;
export function newError(make: () => any): any {
  const E = _suppE;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _suppE = null;
        return make();
      }
      try {
        return make();
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return make();
}

export const captureStackTrace: (t: object, fn?: Function) => void =
  "captureStackTrace" in Error ? (Error as any).captureStackTrace : () => {};

// V8's reconstructed async stack can put the resumption trampoline
// (`processTicksAndRejections`) where the callee frame was, leaving internal
// frames above the callsite — strip leading node-internal frames
export function stripInternalFrames(e: any): void {
  const s: string = e?.stack ?? "";
  const at = s.indexOf("\n    at ");
  if (at === -1) return;
  const frames = s.slice(at + 1).split("\n");
  while (frames.length && /^\s+at .*node:internal|^\s+at \(node:|^\s+at node:/.test(frames[0])) frames.shift();
  e.stack = s.slice(0, at) + (frames.length ? "\n" + frames.join("\n") : "");
}

// exact port of zod's util.finalizeIssue — map ladder: check's own error
// (iss.inst) > owning schema's error (iss.schema) > contextual > customError >
// localeError > "Invalid input"; own-string-key copy minus internal slots
export function finalizeIssue(iss: any, ctx: any, config: any): any {
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType") || iss.inst?._def !== undefined) {
    if (traits?.has("$ZodCheck")) iss.schema ??= iss.inst;
    else iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod?.def?.error ?? iss.schema?._def?.error : undefined;
  // a message normalizeIssue assigned from defaults is soft — the ladder wins
  const hard = iss.message !== undefined && !defaultedIssues.has(iss) ? iss.message : undefined;
  // _zod.def and _def are the same object on our classes — read once or
  // fn-valued error params get invoked twice
  const instDef = iss.inst?._zod?.def ?? iss.inst?._def;
  const instErr = instDef?.error;
  const message = hard !== undefined
    ? hard
    : (unwrapMessage(typeof instErr === "function" ? instErr(iss) : instErr) ??
      unwrapMessage(typeof schemaError === "function" ? schemaError(iss) : schemaError) ??
      unwrapMessage(ctx?.error?.(iss)) ??
      unwrapMessage(config.customError?.(iss)) ??
      unwrapMessage(config.localeError?.(iss)) ??
      defaultMessage(iss));
  const full: any = {};
  for (const k of Object.keys(iss)) {
    if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__") continue;
    full[k] = iss[k];
  }
  full.path ??= [];
  full.message = message;
  if (ctx?.reportInput) full.input = iss.input;
  return full;
}

// the lazy-error result object — error materializes on first read
export function failure(Err: any, issues: any[], ctx: any): any {
  let error: any;
  return {
    success: false,
    get error() {
      if (!error) {
        error = newError(() => new Err(issues.map((iss: any) => finalizeIssueTree(iss, ctx, globalConfig))));
        issues = undefined as any;
        ctx = undefined;
      }
      return error;
    },
    set error(e: any) {
      error = e;
      issues = undefined as any;
      ctx = undefined;
    },
  };
}

// finalizeIssue over a whole tree — union errors / record+map nested issues
// carry arrays of raw issues that finalize with the same ctx
export function finalizeIssueTree(iss: any, ctx: any, config: any): any {
  const f = finalizeIssue(iss, ctx, config);
  if (Array.isArray(f.errors)) f.errors = f.errors.map((a: any) => Array.isArray(a) ? a.map((i: any) => finalizeIssueTree(i, ctx, config)) : a);
  if (Array.isArray(f.issues)) f.issues = f.issues.map((i: any) => finalizeIssueTree(i, ctx, config));
  return f;
}

// ---------- locales ----------
function _joinValues(vals: any[], sep = "|"): string {
  return vals.map((v) => (typeof v === "string" ? `"${v}"` : `${v}`)).join(sep);
}
function _stringifyPrimitive(v: any): string {
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "symbol") return String(v);
  if (typeof v === "string") return `"${v}"`;
  return `${v}`;
}
export function frLocaleError(): (issue: any) => string {
  const Sizable: Record<string, { unit: string; verb: string }> = {
    string: { unit: "caractères", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "éléments", verb: "avoir" },
    set: { unit: "éléments", verb: "avoir" },
  };
  const FormatDictionary: Record<string, string> = {
    regex: "expression régulière", email: "adresse e-mail", url: "URL",
    emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6",
    nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2",
    ulid: "ULID", xid: "XID", ksuid: "KSUID",
    datetime: "date et heure ISO", date: "date ISO", time: "heure ISO",
    duration: "durée ISO", ipv4: "adresse IPv4", ipv6: "adresse IPv6",
    mac: "adresse MAC", cidrv4: "plage IPv4", cidrv6: "plage IPv6",
    base64: "chaîne de caractères encodée en base64",
    base64url: "chaîne de caractères encodée en base64url",
    json_string: "chaîne de caractères JSON", e164: "numéro au format E.164",
    credit_card: "numéro de carte de crédit", currency_code: "code de devise",
    iban: "IBAN", jwt: "JWT", template_literal: "entrée",
  };
  const TypeDictionary: Record<string, string> = {
    string: "chaîne de caractères", number: "nombre", int: "entier",
    boolean: "booléen", bigint: "grand entier", symbol: "symbole",
    undefined: "indéfini", null: "null", never: "jamais", void: "vide",
    date: "date", array: "tableau", object: "objet", tuple: "tuple",
    record: "record", map: "map", set: "ensemble", file: "fichier",
    nonoptional: "non optionnel", nan: "NaN", function: "fonction",
  };
  return (issue: any) => {
    switch (issue.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue.expected] ?? issue.expected;
        const receivedType = parsedTypeName(issue.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        if (/^[A-Z]/.test(issue.expected))
          return `Entrée invalide : instance de ${issue.expected} attendu, ${received} reçu`;
        return `Entrée invalide : ${expected} attendu, ${received} reçu`;
      }
      case "invalid_value":
        if (issue.values.length === 1) return `Entrée invalide : ${_stringifyPrimitive(issue.values[0])} attendu`;
        return `Option invalide : une valeur parmi ${_joinValues(issue.values, "|")} attendue`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = Sizable[issue.origin] ?? null;
        if (sizing)
          return `Trop grand : ${TypeDictionary[issue.origin] ?? "valeur"} doit ${sizing.verb} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "élément(s)"}`;
        return `Trop grand : ${TypeDictionary[issue.origin] ?? "valeur"} doit être ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = Sizable[issue.origin] ?? null;
        if (sizing)
          return `Trop petit : ${TypeDictionary[issue.origin] ?? "valeur"} doit ${sizing.verb} ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        return `Trop petit : ${TypeDictionary[issue.origin] ?? "valeur"} doit être ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        if (issue.format === "starts_with")
          return `Chaîne de caractères invalide : doit commencer par "${issue.prefix}"`;
        if (issue.format === "ends_with")
          return `Chaîne de caractères invalide : doit se terminer par "${issue.suffix}"`;
        if (issue.format === "includes") return `Chaîne de caractères invalide : doit inclure "${issue.includes}"`;
        if (issue.format === "regex")
          return `Chaîne de caractères invalide : doit correspondre au motif ${issue.pattern}`;
        return `${FormatDictionary[issue.format] ?? issue.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit être un multiple de ${issue.divisor}`;
      case "unrecognized_keys":
        return `Clé${issue.keys.length > 1 ? "s" : ""} non reconnue${issue.keys.length > 1 ? "s" : ""} : ${_joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Clé invalide dans ${issue.origin}`;
      case "invalid_union":
        return "Entrée invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue.origin}`;
      default:
        return "Entrée invalide";
    }
  };
}
