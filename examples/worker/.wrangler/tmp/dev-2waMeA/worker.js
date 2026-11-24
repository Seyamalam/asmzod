var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// ../../src/codec.ts
var enc = new TextEncoder();
var dec = new TextDecoder();
function hostIndex(hosts, v) {
  hosts.push(v);
  return hosts.length - 1;
}
__name(hostIndex, "hostIndex");
function encodeValue(v, hosts) {
  switch (typeof v) {
    case "undefined":
      return u8(0);
    case "boolean":
      return cat(u8(2), u8(v ? 1 : 0));
    case "number": {
      const b = new Uint8Array(9);
      b[0] = 3;
      new DataView(b.buffer).setFloat64(1, v, true);
      return b;
    }
    case "string": {
      const s = enc.encode(v);
      return cat(u8(4), u64(s.length), s);
    }
    case "bigint": {
      const b = new Uint8Array(9);
      b[0] = 5;
      new DataView(b.buffer).setBigInt64(1, BigInt.asIntN(64, v), true);
      return b;
    }
    case "object":
      if (v === null) return u8(1);
      if (Array.isArray(v)) {
        const parts = [u8(7), u64(v.length)];
        for (const e of v) parts.push(encodeValue(e, hosts));
        return cat(...parts);
      }
      if (isPlainObject(v)) {
        const keys = Object.keys(v);
        const parts = [u8(6), u64(keys.length)];
        for (const k of keys) {
          const kb = enc.encode(k);
          parts.push(u64(kb.length), kb, encodeValue(v[k], hosts));
        }
        return cat(...parts);
      }
      return cat(u8(8), u64(hostIndex(hosts, v)));
    case "function":
    case "symbol":
    default:
      return cat(u8(8), u64(hostIndex(hosts, v)));
  }
}
__name(encodeValue, "encodeValue");
function isPlainObject(v) {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
__name(isPlainObject, "isPlainObject");
function decodeValueAt(buf, off, hosts) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return decAt(buf, dv, off, hosts);
}
__name(decodeValueAt, "decodeValueAt");
function decAt(buf, dv, off, hosts) {
  const u643 = /* @__PURE__ */ __name((o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296, "u64");
  const tag = buf[off];
  switch (tag) {
    case 0:
      return [void 0, off + 1];
    case 1:
      return [null, off + 1];
    case 2:
      return [buf[off + 1] !== 0, off + 2];
    case 3:
      return [dv.getFloat64(off + 1, true), off + 9];
    case 4: {
      const n = u643(off + 1);
      return [dec.decode(buf.subarray(off + 9, off + 9 + n)), off + 9 + n];
    }
    case 5:
      return [dv.getBigInt64(off + 1, true), off + 9];
    case 6: {
      const nf = u643(off + 1);
      let cur = off + 9;
      const obj = {};
      for (let i = 0; i < nf; i++) {
        const kl = u643(cur);
        const k = dec.decode(buf.subarray(cur + 8, cur + 8 + kl));
        const [v, np] = decAt(buf, dv, cur + 8 + kl, hosts);
        obj[k] = v;
        cur = np;
      }
      return [obj, cur];
    }
    case 7: {
      const n = u643(off + 1);
      let cur = off + 9;
      const arr = [];
      for (let i = 0; i < n; i++) {
        const [v, np] = decAt(buf, dv, cur, hosts);
        arr.push(v);
        cur = np;
      }
      return [arr, cur];
    }
    case 8:
      return [hosts[u643(off + 1)], off + 9];
    default:
      throw new Error(`asmzod: corrupt value tag ${tag} at buf+${off}`);
  }
}
__name(decAt, "decAt");
function u8(v) {
  return new Uint8Array([v & 255]);
}
__name(u8, "u8");
function u64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
}
__name(u64, "u64");
function i64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
  return b;
}
__name(i64, "i64");
function f64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
}
__name(f64, "f64");
function str(s) {
  return enc.encode(s);
}
__name(str, "str");
function cat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
__name(cat, "cat");
var BW = class {
  static {
    __name(this, "BW");
  }
  bytes = [];
  get pos() {
    return this.bytes.length;
  }
  u8(v) {
    this.bytes.push(v & 255);
  }
  raw(b) {
    for (const x of b) this.bytes.push(x);
  }
  u64(v) {
    this.raw(u64(v));
  }
  i64(v) {
    this.raw(i64(v));
  }
  f64(v) {
    this.raw(f64(v));
  }
  str(s) {
    this.raw(str(s));
  }
  // reserve an i64 field, return its position for later patching
  field() {
    const p = this.bytes.length;
    this.raw(i64(0));
    return p;
  }
  patchField(at, targetPos) {
    const rel = BigInt(targetPos - at);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, rel, true);
    for (let i = 0; i < 8; i++) this.bytes[at + i] = b[i];
  }
  out() {
    return new Uint8Array(this.bytes);
  }
};

// ../../src/shared.ts
var reg = {
  refine: [],
  transform: [],
  lazy: [],
  regex: [],
  ctor: [],
  custom: []
};
function parsedTypeName(v) {
  if (v === void 0) return "undefined";
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
  if (Object.getPrototypeOf(v) !== Object.prototype && "constructor" in v && v.constructor?.name)
    return v.constructor.name;
  return "object";
}
__name(parsedTypeName, "parsedTypeName");
function regId(arr, v) {
  arr.push(v);
  return arr.length - 1;
}
__name(regId, "regId");
var FORMAT_NAMES = {
  email: "email",
  uuid: "uuid",
  url: "url",
  regex: "regex",
  startsWith: "starts_with",
  endsWith: "ends_with",
  includes: "includes",
  lowercase: "lowercase",
  uppercase: "uppercase",
  ipv4: "ipv4",
  ipv6: "ipv6",
  ulid: "ulid",
  nanoid: "nanoid",
  cuid2: "cuid2",
  base64: "base64",
  hex: "hex",
  datetime: "datetime",
  date: "date",
  time: "time",
  // regex-carried formats: the check embeds a `format` override so its
  // issues take the zod format name instead of "regex"
  guid: "guid",
  uuid6: "uuid",
  uuid7: "uuid",
  cuid: "cuid",
  xid: "xid",
  ksuid: "ksuid",
  e164: "e164",
  cidrv4: "cidrv4",
  cidrv6: "cidrv6",
  base64url: "base64url",
  jwt: "jwt",
  emoji: "emoji",
  duration: "duration",
  hostname: "hostname",
  httpurl: "url",
  template_literal: "template_literal"
};
var FORMAT_MSGS = {
  email: "Invalid email address",
  uuid: "Invalid UUID",
  url: "Invalid URL",
  emoji: "Invalid emoji",
  nanoid: "Invalid nanoid",
  guid: "Invalid GUID",
  cuid: "Invalid cuid",
  cuid2: "Invalid cuid2",
  ulid: "Invalid ULID",
  xid: "Invalid XID",
  ksuid: "Invalid KSUID",
  hostname: "Invalid hostname",
  base64: "Invalid base64-encoded string",
  base64url: "Invalid base64url-encoded string",
  hex: "Invalid hex",
  ipv4: "Invalid IPv4 address",
  ipv6: "Invalid IPv6 address",
  cidrv4: "Invalid IPv4 range",
  cidrv6: "Invalid IPv6 range",
  e164: "Invalid E.164 number",
  jwt: "Invalid JWT",
  datetime: "Invalid ISO datetime",
  date: "Invalid ISO date",
  time: "Invalid ISO time",
  duration: "Invalid ISO duration",
  lowercase: "Invalid lowercase",
  uppercase: "Invalid uppercase",
  regex: "Invalid string: must match pattern",
  template_literal: "Invalid input"
};
var FORMAT_PATTERNS = {
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
  uppercase: "/^[^a-z]*$/"
};
var EXPOSED_RECEIVED = /* @__PURE__ */ new Set(["NaN", "Infinity", "-Infinity", "Invalid Date"]);
var FORMAT_ORIGIN = /* @__PURE__ */ new Set([
  ...Object.keys(FORMAT_PATTERNS),
  "starts_with",
  "ends_with",
  "includes",
  "regex",
  "guid",
  "cuid",
  "xid",
  "ksuid",
  "e164",
  "cidrv4"
]);
var FORMAT_NOPAT = /* @__PURE__ */ new Set(["base64url", "jwt", "cidrv6", "hostname", "httpurl"]);
var FORMAT_NOTES = {
  httpurl: "Invalid URL format"
};
function repr(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return `${v}n`;
  return String(v);
}
__name(repr, "repr");
var msgFns = [];
function paramMsg(p) {
  if (p === void 0 || p === null) return void 0;
  if (typeof p === "string") return p;
  const e = p.error ?? p.message;
  if (e === void 0) return void 0;
  if (typeof e === "string") return e;
  if (typeof e === "function") {
    msgFns.push(e);
    return `\0m${msgFns.length - 1}`;
  }
  return void 0;
}
__name(paramMsg, "paramMsg");
function defaultMessage(i) {
  switch (i.code) {
    case "invalid_type": {
      const recv = i.received === "Invalid Date" ? "Date" : i.received;
      return `Invalid input: expected ${i.expected === "nan" ? "NaN" : i.expected}` + (recv !== void 0 ? `, received ${recv}` : "");
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
        return i.exact ? `Too small: expected ${i.origin} to have exactly ${i.minimum} ${unit}` : `Too small: expected ${i.origin} to have ${op}${i.minimum} ${unit}`;
      }
      return i.exact ? `Too small: expected ${i.origin} to be exactly ${i.minimum}` : `Too small: expected ${i.origin} to be ${op}${i.minimum}`;
    }
    case "too_big": {
      const op = i.inclusive === false ? "<" : "<=";
      if (i.origin === "string" || i.origin === "array") {
        const unit = i.origin === "string" ? "characters" : "items";
        return i.exact ? `Too big: expected ${i.origin} to have exactly ${i.maximum} ${unit}` : `Too big: expected ${i.origin} to have ${op}${i.maximum} ${unit}`;
      }
      return i.exact ? `Too big: expected ${i.origin} to be exactly ${i.maximum}` : `Too big: expected ${i.origin} to be ${op}${i.maximum}`;
    }
    case "not_multiple_of":
      return `Invalid number: must be a multiple of ${i.divisor}`;
    case "unrecognized_keys": {
      const k = (i.keys ?? []).map((x) => JSON.stringify(x)).join(", ");
      return `Unrecognized key${i.keys?.length === 1 ? "" : "s"}: ${k}`;
    }
    case "invalid_union":
      if (i.note === "No matching discriminator" && Array.isArray(i.options))
        return `Invalid discriminator value. Expected ${i.options.map((o) => `'${o}'`).join(" | ")}`;
      return "Invalid input";
    case "invalid_intersection_results":
      return "Invalid intersection results";
    case "invalid_date":
      return "Invalid date";
    case "invalid_key":
      return `Invalid key in ${i.origin}`;
    case "custom":
      return "Invalid input";
    default:
      return "Invalid input";
  }
}
__name(defaultMessage, "defaultMessage");
function normalizeIssue(i) {
  if (i == null || typeof i !== "object") return i;
  const out = i;
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
      if (val !== void 0) {
        out.format = FORMAT_NAMES[val] ?? val;
        delete out.validation;
      }
      if (FORMAT_ORIGIN.has(out.format)) out.origin = "string";
      if (FORMAT_PATTERNS[out.format] !== void 0 && out.pattern === void 0)
        out.pattern = FORMAT_PATTERNS[out.format];
      if (FORMAT_NOPAT.has(out.format) || FORMAT_NOPAT.has(val)) {
        delete out.pattern;
        delete out.origin;
      }
      if (FORMAT_NOTES[val] !== void 0)
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
      if (i.type !== void 0) {
        out.origin = i.type;
        delete out.type;
      }
      break;
  }
  if (out.code === "invalid_type" && out.expected === "int") out.format = "safeint";
  if (out.message === void 0) {
    out.message = defaultMessage(out);
  } else if (typeof out.message === "string" && out.message.charCodeAt(0) === 0) {
    const fn = msgFns[+out.message.slice(2)];
    const { message: _m, ...rest } = out;
    out.message = fn ? fn(rest) : _m;
  }
  if (out.received !== void 0) {
    const keep = out._keepReceived || EXPOSED_RECEIVED.has(out.received) && (out.expected === "number" || out.expected === "int") || out.received === "Invalid Date" && out.expected === "date";
    if (!keep) delete out.received;
  }
  delete out._keepReceived;
  return out;
}
__name(normalizeIssue, "normalizeIssue");
function finishIssues(issues) {
  let cut = false;
  for (let i = 0; i < issues.length; i++) {
    const k = issues[i]._k;
    if (k === void 0) continue;
    delete issues[i]._k;
    if (k > 0) {
      issues[i].issues = issues.splice(i - k, k);
      i -= k;
      cut = true;
    }
  }
  return issues;
}
__name(finishIssues, "finishIssues");

// ../../src/engine.ts
var R = class {
  static {
    __name(this, "R");
  }
  pos;
  b;
  constructor(b, pos = 0) {
    this.b = b;
    this.pos = pos;
  }
  u8() {
    return this.b[this.pos++];
  }
  u64() {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos).getBigUint64(0, true);
    this.pos += 8;
    return v;
  }
  i64() {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos).getBigInt64(0, true);
    this.pos += 8;
    return v;
  }
  f64() {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos).getFloat64(0, true);
    this.pos += 8;
    return v;
  }
  bytes(n) {
    const s = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  str(n) {
    return new TextDecoder().decode(this.bytes(Number(n)));
  }
  // i64 offset relative to the field's own address
  child(fieldPos) {
    const save = this.pos;
    this.pos = fieldPos;
    const rel = this.i64();
    this.pos = save;
    return fieldPos + Number(rel);
  }
};
var dec2 = new TextDecoder();
function decodeValue(r, hosts) {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return void 0;
    case 1:
      return null;
    case 2:
      return r.u8() !== 0;
    case 3: {
      const v = new DataView(r.b.buffer, r.b.byteOffset + r.pos).getFloat64(0, true);
      r.pos += 8;
      return v;
    }
    case 4: {
      const n = Number(r.u64());
      return r.str(n);
    }
    case 5:
      return r.i64();
    case 6: {
      const n = Number(r.u64());
      const o = {};
      for (let i = 0; i < n; i++) {
        const k = r.str(Number(r.u64()));
        o[k] = decodeValue(r, hosts);
      }
      return o;
    }
    case 7: {
      const n = Number(r.u64());
      const a = [];
      for (let i = 0; i < n; i++) a.push(decodeValue(r, hosts));
      return a;
    }
    case 8:
      return hosts[Number(r.u64())];
    default:
      throw new Error(`asmzod: bad value tag ${tag}`);
  }
}
__name(decodeValue, "decodeValue");
function pushIssue(c, code, fields) {
  c.issues.push({ code, path: [...c.path], ...fields });
}
__name(pushIssue, "pushIssue");
function atKey(c, k, f) {
  c.path.push(k);
  try {
    return f();
  } finally {
    c.path.pop();
  }
}
__name(atKey, "atKey");
var typeName = parsedTypeName;
var sizeOrigin = /* @__PURE__ */ __name((v) => {
  const t = typeName(v);
  return t === "string" || t === "array" ? t : "unknown";
}, "sizeOrigin");
function inputLen(v) {
  if (typeof v === "string") {
    let n = 0;
    for (const _ of v) n++;
    return n;
  }
  if (Array.isArray(v)) return v.length;
  const l = v?.length;
  return typeof l === "number" && l >= 0 && Number.isInteger(l) ? l : -1;
}
__name(inputLen, "inputLen");
function portableParse(blob, input, hosts) {
  const c = { hosts, issues: [], path: [], pendingThrow: null };
  const rin = new R(input);
  const v = decodeValue(rin, hosts);
  let out;
  try {
    out = validate(new R(blob), v, c);
  } catch (e) {
    if (e !== FAILED) throw e;
  }
  if (c.pendingThrow !== null) throw c.pendingThrow;
  if (c.issues.length) return { ok: false, issues: c.issues };
  return { ok: true, value: out };
}
__name(portableParse, "portableParse");
function msgOf(r) {
  const n = Number(r.u64());
  return n ? r.str(n) : void 0;
}
__name(msgOf, "msgOf");
function sizeFail(c, code, origin, limit, inclusive, exact, msg, nc) {
  const lim = origin === "bigint" ? limit : limit >= BigInt(Number.MIN_SAFE_INTEGER) && limit <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(limit) : limit;
  pushIssue(c, code, {
    type: origin,
    [code === "too_small" ? "minimum" : "maximum"]: lim,
    inclusive,
    ...exact ? { exact: true } : {},
    ...nc ? { _nc: true } : {},
    ...msg ? { message: msg } : {}
  });
}
__name(sizeFail, "sizeFail");
function runStrChecks(r, v, c) {
  const n = r.u8();
  const recs = [];
  for (let i = 0; i < n; i++) {
    const code = r.u8();
    const msg = msgOf(r);
    recs.push({ code, msg, p: r.pos });
    r.pos = checkParamEnd(r, code, true);
  }
  const isStr = typeof v === "string";
  const len = isStr ? inputLen(v) : -1;
  const alen = isStr ? len : inputLen(v);
  let fail = !isStr;
  for (const rc of recs) {
    const save = r.pos;
    r.pos = rc.p;
    try {
      switch (rc.code) {
        case 1: {
          const l = r.u64();
          if (alen >= 0 && BigInt(alen) < l) {
            sizeFail(c, "too_small", sizeOrigin(v), l, true, false, rc.msg);
            fail = true;
          }
          break;
        }
        case 2: {
          const l = r.u64();
          if (alen >= 0 && BigInt(alen) > l) {
            sizeFail(c, "too_big", sizeOrigin(v), l, true, false, rc.msg);
            fail = true;
          }
          break;
        }
        case 3: {
          const l = r.u64();
          if (alen >= 0 && BigInt(alen) !== l) {
            sizeFail(c, BigInt(alen) < l ? "too_small" : "too_big", sizeOrigin(v), l, true, true, rc.msg);
            fail = true;
          }
          break;
        }
        case 7: {
          const s = r.str(Number(r.u64()));
          if (isStr && !v.startsWith(s)) {
            fmtFail(c, "startsWith", rc.msg, { prefix: s });
            fail = true;
          }
          break;
        }
        case 8: {
          const s = r.str(Number(r.u64()));
          if (isStr && !v.endsWith(s)) {
            fmtFail(c, "endsWith", rc.msg, { suffix: s });
            fail = true;
          }
          break;
        }
        case 9: {
          const s = r.str(Number(r.u64()));
          if (isStr && !v.includes(s)) {
            fmtFail(c, "includes", rc.msg, { includes: s });
            fail = true;
          }
          break;
        }
        case 10: {
          const re = reg.regex[Number(r.u64())];
          const src = r.str(Number(r.u64()));
          if (isStr) {
            re.lastIndex = 0;
            if (!re.test(v)) {
              fmtFail(c, "regex", rc.msg, { pattern: src });
              fail = true;
            }
          }
          break;
        }
        default: {
          if (isStr && !STR_FMT[rc.code]?.(v)) {
            fmtFail(c, STR_NAMES[rc.code] ?? "format", rc.msg);
            fail = true;
          }
        }
      }
    } finally {
      r.pos = save;
    }
  }
  return !fail;
}
__name(runStrChecks, "runStrChecks");
function fmtFail(c, validation, msg, extra) {
  pushIssue(c, "invalid_string", { validation, ...extra, ...msg ? { message: msg } : {} });
}
__name(fmtFail, "fmtFail");
function checkParamEnd(r, code, str_) {
  const save = r.pos;
  if (str_) {
    if (code === 1 || code === 2 || code === 3) {
      r.pos += 8;
    } else if (code === 5) {
      r.pos += 1;
    } else if (code === 7 || code === 8 || code === 9) {
      r.pos += 8 + Number(r.u64());
    } else if (code === 10) {
      r.pos += 8;
      r.pos += 8 + Number(r.u64());
    }
  } else {
    if (code >= 1 && code <= 4 || code === 7) {
      r.pos += 8;
    }
  }
  const end = r.pos;
  r.pos = save;
  return end;
}
__name(checkParamEnd, "checkParamEnd");
var STR_NAMES = {
  4: "email",
  5: "uuid",
  6: "url",
  11: "lowercase",
  12: "uppercase",
  13: "ipv4",
  14: "ipv6",
  15: "ulid",
  16: "nanoid",
  17: "cuid2",
  18: "base64",
  19: "hex",
  20: "datetime",
  21: "date",
  22: "time"
};
var Z_DATE = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$/;
var Z_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/;
var Z_DATETIME = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|(?:[+-](?:[01]\d|2[0-3]):[0-5]\d)))$/;
var STR_FMT = {
  4: (s) => /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/.test(s),
  5: (s) => /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(s),
  6: (s) => {
    try {
      const u = new URL(s);
      return !!u.hostname;
    } catch {
      return false;
    }
  },
  11: (s) => s === s.toLowerCase(),
  12: (s) => s === s.toUpperCase(),
  13: (s) => /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/.test(s),
  14: (s) => /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/.test(s),
  15: (s) => /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/.test(s),
  16: (s) => /^[a-zA-Z0-9_-]{21}$/.test(s),
  17: (s) => /^[0-9a-z]+$/.test(s),
  18: (s) => /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/.test(s),
  19: (s) => /^(0x)?[0-9a-fA-F]+$/.test(s),
  20: (s) => Z_DATETIME.test(s),
  21: (s) => Z_DATE.test(s),
  22: (s) => Z_TIME.test(s)
};
function runNumChecks(r, v, isBig, c) {
  const n = r.u8();
  let fail = false;
  for (let i = 0; i < n; i++) {
    const code = r.u8();
    const msg = msgOf(r);
    switch (code) {
      case 1: {
        const p = isBig ? r.i64() : r.f64();
        if (!(v > p)) {
          sizeFail(c, "too_small", isBig ? "bigint" : "number", BigInt(p), false, false, msg);
          fail = true;
        }
        break;
      }
      case 2: {
        const p = isBig ? r.i64() : r.f64();
        if (!(v >= p)) {
          sizeFail(c, "too_small", isBig ? "bigint" : "number", BigInt(p), true, false, msg);
          fail = true;
        }
        break;
      }
      case 3: {
        const p = isBig ? r.i64() : r.f64();
        if (!(v < p)) {
          sizeFail(c, "too_big", isBig ? "bigint" : "number", BigInt(p), false, false, msg);
          fail = true;
        }
        break;
      }
      case 4: {
        const p = isBig ? r.i64() : r.f64();
        if (!(v <= p)) {
          sizeFail(c, "too_big", isBig ? "bigint" : "number", BigInt(p), true, false, msg);
          fail = true;
        }
        break;
      }
      case 5: {
        const ok = isBig || Number.isInteger(v);
        if (!ok) {
          pushIssue(c, "invalid_type", { expected: "int", received: typeName(v), ...msg ? { message: msg } : {} });
          fail = true;
        }
        break;
      }
      case 6: {
        if (!isBig && !Number.isFinite(v)) {
          pushIssue(c, "not_finite", { ...msg ? { message: msg } : {} });
          fail = true;
        }
        break;
      }
      case 7: {
        const p = isBig ? r.i64() : r.f64();
        if (v % p !== (isBig ? 0n : 0)) {
          pushIssue(c, "not_multiple_of", { divisor: p, ...msg ? { message: msg } : {} });
          fail = true;
        }
        break;
      }
      case 8: {
        const nonInt = !isBig && !Number.isInteger(v);
        const ok = nonInt ? false : isBig ? v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) : Number.isSafeInteger(v);
        if (!ok && nonInt) {
          pushIssue(c, "invalid_type", { expected: "int", received: typeName(v), ...msg ? { message: msg } : {} });
          fail = true;
        } else if (!ok) {
          const over = isBig ? v > 0n : v > 0;
          const lim = over ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
          pushIssue(c, over ? "too_big" : "too_small", {
            type: "int",
            [over ? "maximum" : "minimum"]: lim,
            inclusive: true,
            ...msg ? { message: msg } : {}
          });
          fail = true;
        }
        break;
      }
    }
  }
  return !fail;
}
__name(runNumChecks, "runNumChecks");
function validate(r, v, c) {
  const node = r.pos;
  const op = r.u8();
  switch (op) {
    case 1: {
      const isStr = typeof v === "string";
      if (!isStr) pushIssue(c, "invalid_type", { expected: "string", received: typeName(v) });
      if (!runStrChecks(r, v, c) || !isStr) throw FAILED;
      return v;
    }
    case 2: {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        pushIssue(c, "invalid_type", { expected: "number", received: typeName(v) });
        throw FAILED;
      }
      if (!runNumChecks(r, v, false, c)) throw FAILED;
      return v;
    }
    case 3: {
      if (typeof v !== "boolean") {
        pushIssue(c, "invalid_type", { expected: "boolean", received: typeName(v) });
        throw FAILED;
      }
      return v;
    }
    case 4: {
      if (typeof v !== "bigint") {
        pushIssue(c, "invalid_type", { expected: "bigint", received: typeName(v) });
        throw FAILED;
      }
      if (!runNumChecks(r, v, true, c)) throw FAILED;
      return v;
    }
    case 5: {
      const mode = r.u8();
      const catchallPos = r.pos;
      const catchallOff = r.i64();
      const nf = Number(r.u64());
      const fields = [];
      for (let i = 0; i < nf; i++) {
        const nl = Number(r.u64());
        const name = r.str(nl);
        const fp = r.pos;
        fields.push({ name, pos: fp + Number(r.i64()) });
      }
      const objectLike = v !== null && typeof v === "object" && !Array.isArray(v);
      if (!objectLike) {
        pushIssue(c, "invalid_type", { expected: "object", received: typeName(v) });
        throw FAILED;
      }
      const obj = v;
      const out = {};
      const before = c.issues.length;
      const consumed = /* @__PURE__ */ new Set();
      for (const f of fields) {
        consumed.add(f.name);
        const raw = obj[f.name];
        const res = atKey(c, f.name, () => tryValidate(new R(r.b, f.pos), raw, c));
        if (res.ok) out[f.name] = res.value;
      }
      const extra = Object.keys(obj).filter((k) => !consumed.has(k));
      if (mode === 1 && extra.length) {
        pushIssue(c, "unrecognized_keys", { keys: extra });
      } else if (mode === 2) {
        for (const k of extra) out[k] = obj[k];
      } else if (catchallOff !== 0n) {
        const cpos = catchallPos + Number(catchallOff);
        for (const k of extra) {
          const res = atKey(c, k, () => tryValidate(new R(r.b, cpos), obj[k], c));
          if (res.ok) out[k] = res.value;
        }
      }
      if (c.issues.length !== before) throw FAILED;
      return out;
    }
    case 6: {
      const ep = r.pos;
      const epos = ep + Number(r.i64());
      const min = r.i64();
      const max = r.i64();
      const exact = r.u8() !== 0;
      if (!Array.isArray(v)) {
        pushIssue(c, "invalid_type", { expected: "array", received: typeName(v) });
        const alen = inputLen(v);
        if (alen >= 0) {
          if (min !== -1n && BigInt(alen) < min) sizeFail(c, "too_small", sizeOrigin(v), min, true, exact, void 0);
          if (max !== -1n && BigInt(alen) > max) sizeFail(c, "too_big", sizeOrigin(v), max, true, exact, void 0);
        }
        throw FAILED;
      }
      const before = c.issues.length;
      if (min !== -1n && BigInt(v.length) < min) sizeFail(c, "too_small", "array", min, true, exact, void 0);
      if (max !== -1n && BigInt(v.length) > max) sizeFail(c, "too_big", "array", max, true, exact, void 0);
      const out = new Array(v.length);
      for (let i = 0; i < v.length; i++) {
        const res = atKey(c, i, () => tryValidate(new R(r.b, epos), v[i], c));
        if (res.ok) out[i] = res.value;
      }
      if (c.issues.length !== before) throw FAILED;
      return out;
    }
    case 7: {
      const n = Number(r.u64());
      const offs = [];
      for (let i = 0; i < n; i++) {
        const fp = r.pos;
        offs.push(fp + Number(r.i64()));
      }
      const uidx = Number(r.u64());
      for (const p of offs) {
        const save = c.issues.length;
        const rr = new R(r.b);
        rr.pos = p;
        const res = tryValidate(rr, v, c);
        if (res.ok) {
          c.issues.length = save;
          return res.value;
        }
        c.issues.length = save;
      }
      pushIssue(c, "invalid_union", { _u: uidx });
      throw FAILED;
    }
    case 8: {
      const dl = Number(r.u64());
      const dname = r.str(dl);
      const n = Number(r.u64());
      const entries = [];
      for (let i = 0; i < n; i++) {
        const kl = Number(r.u64());
        const key = r.str(kl);
        const fp = r.pos;
        entries.push({ key, pos: fp + Number(r.i64()) });
      }
      const dv = v?.[dname];
      if (typeof v !== "object" || v === null || Array.isArray(v) || !(typeof dv === "string" || typeof dv === "number" || typeof dv === "boolean" || dv === null || dv === void 0)) {
        pushIssue(c, "invalid_union", {});
        throw FAILED;
      }
      const e = entries.find((x) => x.key === String(dv));
      if (!e) {
        atKey(c, dname, () => pushIssue(c, "invalid_union", {}));
        throw FAILED;
      }
      const rr = new R(r.b);
      rr.pos = e.pos;
      return validate(rr, v, c);
    }
    case 9: {
      const lv = decodeValue(r, c.hosts);
      if (!literalEq(v, lv)) {
        pushIssue(c, "invalid_literal", { expected: lv });
        throw FAILED;
      }
      return v;
    }
    case 10: {
      const n = Number(r.u64());
      const vals = [];
      for (let i = 0; i < n; i++) vals.push(r.str(Number(r.u64())));
      if (typeof v !== "string" || !vals.includes(v)) {
        pushIssue(c, "invalid_value", { values: vals });
        throw FAILED;
      }
      return v;
    }
    case 11: {
      const fp = r.pos;
      const ip = fp + Number(r.i64());
      if (v === void 0) return void 0;
      const rr = new R(r.b);
      rr.pos = ip;
      return validate(rr, v, c);
    }
    case 12: {
      const fp = r.pos;
      const ip = fp + Number(r.i64());
      if (v === null) return null;
      const rr = new R(r.b);
      rr.pos = ip;
      return validate(rr, v, c);
    }
    case 35: {
      const fp = r.pos;
      const ip = fp + Number(r.i64());
      if (v === void 0) {
        pushIssue(c, "invalid_type", { expected: "nonoptional", received: "undefined" });
        throw FAILED;
      }
      const rr = new R(r.b);
      rr.pos = ip;
      return validate(rr, v, c);
    }
    case 13: {
      const fp = r.pos;
      const ip = fp + Number(r.i64());
      const dv = decodeValue(r, c.hosts);
      if (v === void 0) return dv;
      const rr = new R(r.b);
      rr.pos = ip;
      return validate(rr, v, c);
    }
    case 14: {
      const fp = r.pos;
      const ip = fp + Number(r.i64());
      const cv = decodeValue(r, c.hosts);
      const rr = new R(r.b);
      rr.pos = ip;
      const save = c.issues.length;
      const res = tryValidate(rr, v, c);
      if (res.ok) return res.value;
      c.issues.length = save;
      return cv;
    }
    case 15: {
      const fp = r.pos;
      const ip = fp + Number(r.i64());
      const id = Number(r.u64());
      const rr = new R(r.b);
      rr.pos = ip;
      const inner = validate(rr, v, c);
      let ok = false;
      try {
        ok = !!reg.refine[id](inner);
      } catch (e) {
        c.pendingThrow = e;
      }
      if (!ok) {
        pushIssue(c, "custom", {});
        throw FAILED;
      }
      return inner;
    }
    case 16: {
      const fp = r.pos;
      const ip = fp + Number(r.i64());
      const id = Number(r.u64());
      const rr = new R(r.b);
      rr.pos = ip;
      const inner = validate(rr, v, c);
      try {
        return reg.transform[id](inner);
      } catch (e) {
        c.pendingThrow = e;
        throw FAILED;
      }
    }
    case 17: {
      const fi = r.pos;
      const ip = fi + Number(r.i64());
      const fo = r.pos;
      const opos = fo + Number(r.i64());
      const rr = new R(r.b);
      rr.pos = ip;
      const mid = validate(rr, v, c);
      const rr2 = new R(r.b);
      rr2.pos = opos;
      return validate(rr2, mid, c);
    }
    case 18: {
      const fl = r.pos;
      const lp = fl + Number(r.i64());
      const fr = r.pos;
      const rp = fr + Number(r.i64());
      const save = c.issues.length;
      const rl = tryValidate(new R(r.b, lp), v, c);
      const rr = tryValidate(new R(r.b, rp), v, c);
      if (!rl.ok || !rr.ok) throw FAILED;
      c.issues.length = save;
      const a = rl.value, b = rr.value;
      if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
        return { ...a, ...b };
      }
      if (Array.isArray(a) && Array.isArray(b)) return a;
      if (literalEq(a, b)) return a;
      pushIssue(c, "invalid_intersection_results", {});
      throw FAILED;
    }
    case 19: {
      const n = Number(r.u64());
      const ips = [];
      for (let i = 0; i < n; i++) {
        const fp = r.pos;
        ips.push(fp + Number(r.i64()));
      }
      const rf = r.pos;
      const restRel = r.i64();
      const restPos = rf + Number(restRel);
      const minItems = Number(r.u64());
      const optoutStart = Number(r.u64());
      const items = Array.isArray(v) ? v : null;
      if (!items) {
        pushIssue(c, "invalid_type", { expected: "tuple", received: typeName(v) });
        throw FAILED;
      }
      const before = c.issues.length;
      if (restRel === 0n && (items.length < minItems || items.length > n)) {
        sizeFail(
          c,
          items.length < minItems ? "too_small" : "too_big",
          "array",
          BigInt(items.length < minItems ? minItems : n),
          true,
          false,
          void 0,
          true
        );
        if (items.length < minItems) throw FAILED;
      }
      const eff = restRel !== 0n ? Math.max(items.length, n) : n;
      const results = [];
      for (let i = 0; i < eff; i++) {
        const res = atKey(c, i, () => tryValidate(new R(r.b, i < n ? ips[i] : restPos), i < items.length ? items[i] : void 0, c));
        results.push(res);
      }
      if (c.issues.length !== before) throw FAILED;
      const outLen = Math.max(Math.min(items.length, eff), optoutStart);
      const out = [];
      for (let i = 0; i < outLen; i++)
        out[i] = results[i].ok ? results[i].value : i < items.length ? items[i] : void 0;
      return out;
    }
    case 20: {
      const fk = r.pos;
      const kp = fk + Number(r.i64());
      const fv = r.pos;
      const vp = fv + Number(r.i64());
      if (typeof v !== "object" || v === null || Array.isArray(v) || !isPlain(v)) {
        pushIssue(c, "invalid_type", { expected: "record", received: typeName(v) });
        throw FAILED;
      }
      const before = c.issues.length;
      const out = {};
      for (const k of Object.keys(v)) {
        const save = c.issues.length;
        if (kp !== fk) {
          const rr = new R(r.b);
          rr.pos = kp;
          const kr = tryValidate(rr, k, c);
          if (!kr.ok) {
            const inner = c.issues.splice(save);
            atKey(c, k, () => pushIssue(c, "invalid_key", { origin: "record", issues: inner }));
            continue;
          }
          c.issues.length = save;
        }
        const res = atKey(c, k, () => tryValidate(new R(r.b, vp), v[k], c));
        if (res.ok) out[k] = res.value;
      }
      if (c.issues.length !== before) throw FAILED;
      return out;
    }
    case 21:
      return v;
    // any/unknown
    case 22:
      pushIssue(c, "invalid_type", { expected: "never", received: typeName(v) });
      throw FAILED;
    case 23:
      if (v === null) return null;
      pushIssue(c, "invalid_type", { expected: "null", received: typeName(v) });
      throw FAILED;
    case 24:
      if (v === void 0) return void 0;
      pushIssue(c, "invalid_type", { expected: "undefined", received: typeName(v) });
      throw FAILED;
    case 25:
      if (typeof v === "number" && Number.isNaN(v)) return v;
      pushIssue(c, "invalid_type", { expected: "nan", received: typeName(v) });
      throw FAILED;
    case 26: {
      const id = Number(r.u64());
      const blob = reg.lazy[id]();
      const rr = new R(blob);
      return validate(rr, v, c);
    }
    case 27: {
      const id = Number(r.u64());
      const nl = Number(r.u64());
      const name = r.str(nl);
      const Ctor = reg.ctor[id];
      if (!(v instanceof Ctor)) {
        pushIssue(c, "invalid_type", { expected: name, received: typeName(v) });
        throw FAILED;
      }
      return v;
    }
    case 28:
      return coerceTo(r, v, c, 1);
    // string
    case 29:
      return coerceTo(r, v, c, 2);
    // number
    case 30:
      return coerceTo(r, v, c, 3);
    // boolean
    case 31:
      return coerceTo(r, v, c, 4);
    // bigint
    case 32: {
      const t = v instanceof Date ? v.getTime() : NaN;
      if (!(v instanceof Date) || Number.isNaN(t)) {
        pushIssue(c, "invalid_type", {
          expected: "date",
          received: v instanceof Date ? "Invalid Date" : typeName(v)
        });
        throw FAILED;
      }
      const nc = r.u8();
      let fail = false;
      for (let i = 0; i < nc; i++) {
        const kind = r.u8();
        const msg = msgOf(r);
        const p = r.f64();
        if (kind === 1 && t < p) {
          pushIssue(c, "too_small", { type: "date", minimum: p, inclusive: true, ...msg ? { message: msg } : {} });
          fail = true;
        }
        if (kind === 2 && t > p) {
          pushIssue(c, "too_big", { type: "date", maximum: p, inclusive: true, ...msg ? { message: msg } : {} });
          fail = true;
        }
      }
      if (fail) throw FAILED;
      return v;
    }
    case 33: {
      if (typeof v !== "symbol") {
        pushIssue(c, "invalid_type", { expected: "symbol", received: typeName(v) });
        throw FAILED;
      }
      return v;
    }
    case 34: {
      const id = Number(r.u64());
      const msg = msgOf(r);
      let ok = false;
      try {
        ok = reg.custom[id](v);
      } catch (e) {
        c.pendingThrow = e;
      }
      if (!ok) {
        pushIssue(c, "custom", msg ? { message: msg } : {});
        throw FAILED;
      }
      return v;
    }
    default:
      throw new Error(`asmzod: bad opcode 0x${op.toString(16)} at ${node}`);
  }
}
__name(validate, "validate");
var FAILED = /* @__PURE__ */ Symbol("asmzod.fail");
function tryValidate(r, v, c) {
  const save = c.issues.length;
  try {
    const out = validate(r, v, c);
    return { ok: true, value: out };
  } catch (e) {
    if (e === FAILED) return { ok: false };
    throw e;
  }
}
__name(tryValidate, "tryValidate");
function literalEq(a, b) {
  if (typeof a === "bigint" || typeof b === "bigint") return a === b;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
  }
  return a === b;
}
__name(literalEq, "literalEq");
function isPlain(v) {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
__name(isPlain, "isPlain");
function coerceTo(r, v, c, target) {
  const fp = r.pos;
  const ip = fp + Number(r.i64());
  let out;
  try {
    if (target === 1) out = typeof v === "symbol" ? (() => {
      throw new Error("no");
    })() : String(v);
    else if (target === 2) out = Number(v);
    else if (target === 3) out = Boolean(v);
    else out = BigInt(v);
  } catch {
    throw FAILED;
  }
  if (target === 2 && typeof out === "number" && Number.isNaN(out)) {
  }
  const rr = new R(r.b);
  rr.pos = ip;
  return validate(rr, out, c);
}
__name(coerceTo, "coerceTo");

// ../../src/ffi.ts
var g = globalThis;
var forced;
try {
  forced = g.process?.env?.AZ_ENGINE;
} catch {
}
function loadBun() {
  if (!g.Bun) return null;
  const req2 = import.meta.require;
  if (!req2) return null;
  const m = req2("./native/bun.ts");
  return { name: "bun:ffi", version: m.version, parse: /* @__PURE__ */ __name((b, i, h) => m.parse(b, i, h), "parse") };
}
__name(loadBun, "loadBun");
var backend = null;
if (forced !== "portable") {
  try {
    backend = loadBun();
  } catch (e) {
    if (forced === "native") throw e;
  }
}
var engineBackend = backend?.name ?? "portable";
var engineVersion = backend?.version ?? 0;
function engineParse(blob, input, hosts) {
  if (backend) return backend.parse(blob, input, hosts);
  const r = portableParse(blob, input, hosts);
  return r.ok ? { ok: true, value: r.value } : { ok: false, issues: finishIssues(r.issues.map(normalizeIssue)) };
}
__name(engineParse, "engineParse");

// ../../src/bytecode.ts
var enc2 = new TextEncoder();
var STR_CHECK = {
  min: 1,
  max: 2,
  length: 3,
  email: 4,
  uuid: 5,
  url: 6,
  startsWith: 7,
  endsWith: 8,
  includes: 9,
  regex: 10,
  lowercase: 11,
  uppercase: 12,
  ipv4: 13,
  ipv6: 14,
  ulid: 15,
  nanoid: 16,
  cuid2: 17,
  base64: 18,
  hex: 19,
  datetime: 20,
  datestr: 21,
  timestr: 22
};
var NUM_CHECK = {
  gt: 1,
  gte: 2,
  min: 2,
  lt: 3,
  lte: 4,
  max: 4,
  int: 5,
  finite: 6,
  multipleOf: 7,
  safeInt: 8
};
var cbUnsafe = false;
var lazyThunks = /* @__PURE__ */ new Map();
var unionReg = [];
function compile(schema) {
  const w = new BW();
  const hosts = [];
  const unions = unionReg;
  const outer = cbUnsafe;
  cbUnsafe = false;
  emit(w, schema, hosts, unions);
  const unsafe = cbUnsafe;
  cbUnsafe = outer;
  return { cbUnsafe: unsafe, blob: w.out(), hosts, unions };
}
__name(compile, "compile");
function checkMsg(w, msg) {
  const b = msg ? enc2.encode(msg) : new Uint8Array(0);
  w.u64(b.length);
  w.raw(b);
}
__name(checkMsg, "checkMsg");
function emitStrChecks(w, checks) {
  w.u8(checks.length);
  for (const c of checks) {
    const code = STR_CHECK[c.kind];
    if (code === void 0) throw new Error(`asmzod: unsupported string check ${c.kind}`);
    w.u8(code);
    checkMsg(w, c.message);
    switch (c.kind) {
      case "min":
      case "max":
      case "length":
        w.u64(c.value);
        break;
      case "uuid":
        w.u8(c.version ?? 0);
        break;
      case "startsWith":
      case "endsWith":
      case "includes": {
        const b = enc2.encode(c.value);
        w.u64(b.length);
        w.raw(b);
        break;
      }
      case "regex": {
        w.u64(regId(reg.regex, c.regex));
        const src = enc2.encode(c.format === "template_literal" ? c.regex.source : `/${c.regex.source}/${c.regex.flags}`);
        w.u64(src.length);
        w.raw(src);
        const fmt = enc2.encode(c.format ?? "");
        w.u64(fmt.length);
        w.raw(fmt);
        break;
      }
      default:
        break;
    }
  }
}
__name(emitStrChecks, "emitStrChecks");
function emitNumChecks(w, checks, isBig) {
  const LO = { gt: 0, gte: 1, min: 1 };
  const HI = { lt: 0, lte: 1, max: 1 };
  const nomsg = /* @__PURE__ */ __name((x) => !x.message, "nomsg");
  const recs = [];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i], n = checks[i + 1];
    if (!isBig && n && nomsg(c) && nomsg(n) && (LO[c.kind] !== void 0 && HI[n.kind] !== void 0 || HI[c.kind] !== void 0 && LO[n.kind] !== void 0)) {
      const lo = LO[c.kind] !== void 0 ? c : n;
      const hi = LO[c.kind] !== void 0 ? n : c;
      recs.push({ kind: "range", lo: lo.value, loIncl: LO[lo.kind], hi: hi.value, hiIncl: HI[hi.kind] });
      i++;
    } else recs.push({ kind: "one", c });
  }
  w.u8(recs.length);
  for (const r of recs) {
    if (r.kind === "range") {
      w.u8(9);
      checkMsg(w, void 0);
      w.f64(r.lo);
      w.f64(r.hi);
      w.u8(r.loIncl | r.hiIncl << 1);
      continue;
    }
    const c = r.c;
    const code = NUM_CHECK[c.kind];
    if (code === void 0) throw new Error(`asmzod: unsupported number check ${c.kind}`);
    w.u8(code);
    checkMsg(w, c.message);
    if (c.kind === "gt" || c.kind === "gte" || c.kind === "min" || c.kind === "lt" || c.kind === "lte" || c.kind === "max" || c.kind === "multipleOf") {
      if (isBig) w.i64(BigInt(c.value));
      else w.f64(c.value);
    }
  }
}
__name(emitNumChecks, "emitNumChecks");
function emit(w, s, hosts, unions) {
  const d = s._def;
  const m = paramMsg(d.error ?? d.message);
  if (m !== void 0 && m !== "") {
    w.u8(42);
    checkMsg(w, m);
    const f = w.field();
    const at = w.pos;
    emitNode(w, s, hosts, unions);
    w.patchField(f, at);
    return;
  }
  emitNode(w, s, hosts, unions);
}
__name(emit, "emit");
function emitNode(w, s, hosts, unions) {
  const d = s._def;
  switch (d.type) {
    case "string":
      w.u8(1);
      emitStrChecks(w, d.checks);
      return;
    case "number":
      w.u8(2);
      emitNumChecks(w, d.checks, false);
      return;
    case "boolean":
      w.u8(3);
      return;
    case "bigint":
      w.u8(4);
      emitNumChecks(w, d.checks, true);
      return;
    case "object": {
      w.u8(5);
      w.u8(d.mode === "strict" ? 1 : d.mode === "passthrough" ? 2 : 0);
      const cf = w.field();
      const keys = Object.keys(d.shape);
      w.u64(keys.length);
      const fps = [];
      for (const k of keys) {
        const kb = enc2.encode(k);
        w.u64(kb.length);
        w.raw(kb);
        fps.push(w.field());
      }
      if (d.catchall) {
        const at = w.pos;
        emit(w, d.catchall, hosts, unions);
        w.patchField(cf, at);
      }
      keys.forEach((k, i) => {
        const at = w.pos;
        emit(w, d.shape[k], hosts, unions);
        w.patchField(fps[i], at);
      });
      return;
    }
    case "array": {
      w.u8(6);
      const f = w.field();
      w.u64(d.minLen ?? -1n);
      w.u64(d.maxLen ?? -1n);
      w.u8(d.exactLen ? 1 : 0);
      const at = w.pos;
      emit(w, d.element, hosts, unions);
      w.patchField(f, at);
      return;
    }
    case "union": {
      w.u8(7);
      w.u64(d.options.length);
      const fps = d.options.map(() => w.field());
      const uidx = unions.length;
      unions.push(s);
      w.u64(BigInt(uidx));
      d.options.forEach((o, i) => {
        const at = w.pos;
        emit(w, o, hosts, unions);
        w.patchField(fps[i], at);
      });
      return;
    }
    case "discunion": {
      w.u8(8);
      const db = enc2.encode(d.disc);
      w.u64(db.length);
      w.raw(db);
      const entries = [...d.optionsMap.entries()];
      w.u64(entries.length);
      const fps = [];
      for (const [k] of entries) {
        const kb = enc2.encode(k);
        w.u64(kb.length);
        w.raw(kb);
        fps.push(w.field());
      }
      entries.forEach(([, o], i) => {
        const at = w.pos;
        emit(w, o, hosts, unions);
        w.patchField(fps[i], at);
      });
      return;
    }
    case "literal":
      w.u8(9);
      w.raw(encodeValue(d.value, hosts));
      return;
    case "enum":
      w.u8(10);
      w.u64(d.values.length);
      for (const v of d.values) {
        const b = enc2.encode(v);
        w.u64(b.length);
        w.raw(b);
      }
      return;
    case "optional":
    case "nullable":
    case "nonoptional": {
      w.u8(d.type === "optional" ? 11 : d.type === "nullable" ? 12 : 35);
      const f = w.field();
      const at = w.pos;
      emit(w, d.inner, hosts, unions);
      w.patchField(f, at);
      return;
    }
    case "default":
    case "catch": {
      w.u8(d.type === "default" ? 13 : 14);
      const f = w.field();
      w.raw(encodeValue(d.value, hosts));
      const at = w.pos;
      emit(w, d.inner, hosts, unions);
      w.patchField(f, at);
      return;
    }
    case "refine": {
      w.u8(15);
      const f = w.field();
      w.u64(d.cbid);
      checkMsg(w, d.message);
      const at = w.pos;
      emit(w, d.inner, hosts, unions);
      w.patchField(f, at);
      return;
    }
    case "transform": {
      w.u8(16);
      const f = w.field();
      w.u64(d.cbid);
      const at = w.pos;
      emit(w, d.inner, hosts, unions);
      w.patchField(f, at);
      return;
    }
    case "brand":
      emit(w, d.inner, hosts, unions);
      return;
    case "pipe": {
      w.u8(17);
      const fi = w.field(), fo = w.field();
      let at = w.pos;
      emit(w, d.in, hosts, unions);
      w.patchField(fi, at);
      at = w.pos;
      emit(w, d.out, hosts, unions);
      w.patchField(fo, at);
      return;
    }
    case "intersect": {
      w.u8(18);
      const fl = w.field(), fr = w.field();
      let at = w.pos;
      emit(w, d.left, hosts, unions);
      w.patchField(fl, at);
      at = w.pos;
      emit(w, d.right, hosts, unions);
      w.patchField(fr, at);
      return;
    }
    case "tuple": {
      w.u8(19);
      w.u64(d.items.length);
      const fps = d.items.map(() => w.field());
      const rf = w.field();
      const omittable = /* @__PURE__ */ __name((s2) => {
        const d2 = s2._def;
        switch (d2?.type) {
          case "optional":
          case "default":
          case "prefault":
          case "catch":
            return true;
          case "nullable":
          case "readonly":
          case "refine":
          case "brand":
          case "transform":
            return omittable(d2.inner ?? d2.innerType ?? d2.in);
          case "union":
            return d2.options.some(omittable);
          default:
            return false;
        }
      }, "omittable");
      let minItems = d.items.length;
      while (minItems > 0 && omittable(d.items[minItems - 1])) minItems--;
      w.u64(BigInt(minItems));
      const optoutOptional = /* @__PURE__ */ __name((s2) => {
        const d2 = s2._def;
        switch (d2?.type) {
          case "optional":
            return true;
          case "nullable":
          case "readonly":
          case "refine":
          case "brand":
          case "transform":
          case "catch":
            return optoutOptional(d2.inner ?? d2.innerType ?? d2.in);
          case "pipe":
            return optoutOptional(d2.out ?? d2.inner ?? d2.in);
          default:
            return false;
        }
      }, "optoutOptional");
      let optoutStart = d.items.length;
      while (optoutStart > 0 && optoutOptional(d.items[optoutStart - 1])) optoutStart--;
      w.u64(BigInt(optoutStart));
      d.items.forEach((it, i) => {
        const at = w.pos;
        emit(w, it, hosts, unions);
        w.patchField(fps[i], at);
      });
      if (d.rest) {
        const at = w.pos;
        emit(w, d.rest, hosts, unions);
        w.patchField(rf, at);
      }
      return;
    }
    case "record": {
      w.u8(20);
      const fk = w.field(), fv = w.field();
      if (d.keyType) {
        const at2 = w.pos;
        emit(w, d.keyType, hosts, unions);
        w.patchField(fk, at2);
      }
      const at = w.pos;
      emit(w, d.valueType, hosts, unions);
      w.patchField(fv, at);
      return;
    }
    case "any":
    case "unknown":
      w.u8(21);
      return;
    case "never":
      w.u8(22);
      return;
    case "null":
      w.u8(23);
      return;
    case "undefined":
    case "void":
      w.u8(24);
      return;
    case "nan":
      w.u8(25);
      return;
    case "lazy": {
      w.u8(26);
      let th = lazyThunks.get(d.getter);
      if (!th) {
        let blob = null;
        const getter = d.getter;
        th = /* @__PURE__ */ __name(() => blob ??= compile(getter()).blob, "th");
        lazyThunks.set(d.getter, th);
      }
      w.u64(regId(reg.lazy, th));
      return;
    }
    case "instof": {
      w.u8(27);
      w.u64(regId(reg.ctor, d.ctor));
      const nb = enc2.encode(d.name);
      w.u64(nb.length);
      w.raw(nb);
      return;
    }
    case "coerce_str":
    case "coerce_num":
    case "coerce_bool":
    case "coerce_bigint": {
      const op = { coerce_str: 28, coerce_num: 29, coerce_bool: 30, coerce_bigint: 31 }[d.type];
      w.u8(op);
      const f = w.field();
      const at = w.pos;
      emit(w, d.inner, hosts, unions);
      w.patchField(f, at);
      return;
    }
    case "date": {
      w.u8(32);
      w.u8(d.checks.length);
      for (const c of d.checks) {
        w.u8(c.kind === "min" ? 1 : 2);
        checkMsg(w, c.message);
        w.f64(c.value);
      }
      return;
    }
    case "symbol":
      w.u8(33);
      return;
    case "custom": {
      w.u8(34);
      w.u64(d.cbid);
      checkMsg(w, d.message);
      return;
    }
    default:
      throw new Error(`asmzod: cannot compile schema type ${d.type}`);
  }
}
__name(emitNode, "emitNode");

// ../../src/native/napi.ts
var path = "";
try {
  path = new URL("../../asm/asmzod.node", import.meta.url).pathname;
} catch {
}
var req = import.meta.require ?? (typeof __require === "function" ? __require : void 0) ?? globalThis.process?.getBuiltinModule?.("module")?.createRequire?.(import.meta.url);
var lazyCount = 0;
var lazyBlobs = [];
function ensureLazy(a) {
  if (reg.lazy.length === lazyCount) return;
  while (lazyCount < reg.lazy.length && lazyCount < 4096) {
    lazyBlobs.push(reg.lazy[lazyCount++]());
  }
  if (lazyBlobs.length) a.initLazy(lazyBlobs);
}
__name(ensureLazy, "ensureLazy");
var ctorCount = 0;
function ensureCtor(a) {
  while (ctorCount < reg.ctor.length && ctorCount < 1024) ctorCount++;
  if (ctorCount) a.initCtor(reg.ctor.slice(0, ctorCount));
}
__name(ensureCtor, "ensureCtor");
var cbLens = [0, 0, 0, 0];
function ensureCb(a) {
  const sets = [reg.refine, reg.transform, reg.custom, reg.regex];
  let dirty = false;
  for (let i = 0; i < 4; i++) {
    const n = Math.min(sets[i].length, 1024);
    if (n !== cbLens[i]) {
      cbLens[i] = n;
      dirty = true;
    }
  }
  if (dirty) a.initCb(sets.map((s) => s.slice(0, 1024)));
}
__name(ensureCb, "ensureCb");
var addon;
function loadNapi() {
  if (addon !== void 0) return addon;
  try {
    const a = req?.(path);
    addon = typeof a?.parse === "function" ? a : null;
  } catch {
    addon = null;
  }
  return addon;
}
__name(loadNapi, "loadNapi");
var cbInit = false;
var RES = "~azres";
var napiOff;
function parse(blob, value, hosts, cbUnsafe2) {
  const a = loadNapi();
  if (!a || cbUnsafe2) return null;
  if (napiOff === void 0) {
    try {
      napiOff = globalThis.process?.env?.AZ_NAPI === "0";
    } catch {
      napiOff = false;
    }
  }
  if (napiOff) return null;
  if (!cbInit) {
    cbInit = a.init(new Uint8Array(32));
    if (!cbInit) return null;
  }
  ensureLazy(a);
  ensureCtor(a);
  ensureCb(a);
  const r = a.parse(blob, value);
  const res = r?.[RES];
  if (res !== true) return { ok: true, value: r };
  if (r.ok === null) {
    if (r.code === -11) throw r.exc;
    return null;
  }
  const rr = r;
  if (rr.issues !== void 0)
    return { ok: false, issues: finishIssues(rr.issues.map(normalizeIssue)) };
  const buf = new Uint8Array(rr.err);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cnt = Number(dv.getBigUint64(0, true));
  const issues = [];
  let cur = 3104;
  for (let i = 0; i < cnt; i++) {
    const [v, np] = decodeValueAt(buf, cur, hosts);
    issues.push(normalizeIssue(v));
    cur = np;
  }
  return { ok: false, issues: finishIssues(issues) };
}
__name(parse, "parse");
function parseMany(blob, values, hosts, cbUnsafe2) {
  const a = loadNapi();
  if (!a?.parseMany || cbUnsafe2) return null;
  if (napiOff === void 0) {
    try {
      napiOff = globalThis.process?.env?.AZ_NAPI === "0";
    } catch {
      napiOff = false;
    }
  }
  if (napiOff) return null;
  if (!cbInit) {
    cbInit = a.init(new Uint8Array(32));
    if (!cbInit) return null;
  }
  ensureLazy(a);
  ensureCtor(a);
  ensureCb(a);
  const out = a.parseMany(blob, values);
  if (!Array.isArray(out) || out.length !== values.length) return null;
  const res = [];
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (r?.[RES] === true) {
      if (r.ok === null && r.code === -11) throw r.exc;
      if (r.issues !== void 0) {
        res.push({ ok: false, issues: finishIssues(r.issues.map(normalizeIssue)) });
        continue;
      }
      const again = parse(blob, values[i], hosts, false);
      if (again === null) return null;
      res.push(again);
    } else {
      res.push({ ok: true, value: r });
    }
  }
  return res;
}
__name(parseMany, "parseMany");

// ../../src/error.ts
var ZodError = class _ZodError extends Error {
  static {
    __name(this, "ZodError");
  }
  issues = [];
  constructor(issues) {
    super();
    this.name = "ZodError";
    this.issues = issues;
    try {
      this.message = JSON.stringify(issues, null, 2);
    } catch {
      this.message = JSON.stringify(issues, (_k, v) => typeof v === "bigint" ? `${v}n` : v, 2);
    }
  }
  get errors() {
    return this.issues;
  }
  static create(issues) {
    return new _ZodError(issues);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  addIssue(issue) {
    this.issues.push(issue);
  }
  addIssues(issues) {
    this.issues.push(...issues);
  }
  format() {
    const root = { _errors: [] };
    for (const issue of this.issues) {
      let cur = root;
      for (const p of issue.path) {
        const key = typeof p === "number" ? p : p;
        if (cur[key] === void 0) cur[key] = { _errors: [] };
        cur = cur[key];
      }
      cur._errors.push(issue.message);
    }
    return root;
  }
  flatten() {
    const formErrors = [];
    const fieldErrors = {};
    for (const issue of this.issues) {
      if (issue.path.length === 0) {
        formErrors.push(issue.message);
      } else {
        const k = String(issue.path[0]);
        (fieldErrors[k] ??= []).push(issue.message);
      }
    }
    return { formErrors, fieldErrors };
  }
  toString() {
    return this.message;
  }
};

// ../../src/schema.ts
var pendingRefineIssues = [];
var ZodType = class {
  static {
    __name(this, "ZodType");
  }
  _output;
  _input;
  _def;
  _compiled = null;
  _compile() {
    return this._compiled ??= compile(this);
  }
  _run(data) {
    const c = this._compile();
    const nr = parse(c.blob, data, c.hosts, c.cbUnsafe);
    const hosts = nr === null ? [...c.hosts] : void 0;
    const r = nr ?? engineParse(c.blob, encodeValue(data, hosts), hosts);
    if (!r.ok) {
      let aborted = isAborted(r.issues);
      const out = [];
      let spliced = false;
      for (const i of r.issues) {
        delete i._nc;
        if (i.code === "invalid_union" && i._u !== void 0 && i.errors === void 0) {
          const u = c.unions[i._u];
          delete i._u;
          if (u) {
            let v = data;
            for (const p of i.path ?? []) v = v?.[p];
            const runs = u._def.options.map((o) => o._run(v));
            const cands = runs.filter(
              (x) => !x.ok && !(x.aborted ?? isAborted(x.issues))
            );
            if (cands.length === 1) {
              spliced = true;
              for (const iss of cands[0].issues)
                out.push({ ...iss, path: [...i.path ?? [], ...iss.path ?? []] });
              continue;
            }
            i.errors = runs.map((x) => x.ok ? [] : x.issues);
          }
        }
        if (i._u !== void 0) delete i._u;
        out.push(i);
      }
      if (spliced) {
        r.issues = out;
        aborted = isAborted(r.issues);
      }
      r.aborted = aborted;
    }
    if (!r.ok && pendingRefineIssues.length) {
      const extra = pendingRefineIssues.splice(0);
      const out = [];
      for (const i of r.issues) {
        if (i.code === "custom" && extra.length) {
          const st = extra.shift();
          const { path: sp, ...rest } = st;
          out.push({ ...rest, path: [...i.path ?? [], ...sp ?? []] });
          continue;
        }
        out.push(i);
      }
      while (extra.length) out.push(extra.shift());
      return { ok: false, issues: out };
    }
    pendingRefineIssues.length = 0;
    return r;
  }
  parse(data) {
    const r = this._run(data);
    if (!r.ok) throw new ZodError(r.issues);
    return r.value;
  }
  safeParse(data) {
    const r = this._run(data);
    if (r.ok) return { success: true, data: r.value };
    return { success: false, error: new ZodError(r.issues) };
  }
  async parseAsync(data) {
    const r = await this.safeParseAsync(data);
    if (!r.success) throw new ZodError(r.error.issues);
    return r.data;
  }
  optional() {
    return new ZodOptional({ type: "optional", inner: this });
  }
  nullable() {
    return new ZodNullable({ type: "nullable", inner: this });
  }
  nullish() {
    return this.nullable().optional();
  }
  default(value) {
    const v = typeof value === "function" ? value() : value;
    return new ZodDefault({ type: "default", inner: this, value: v });
  }
  catch(value) {
    const v = typeof value === "function" ? value() : value;
    return new ZodCatch({ type: "catch", inner: this, value: v });
  }
  array() {
    return new ZodArray({ type: "array", element: this });
  }
  or(option) {
    return new ZodUnion({ type: "union", options: [this, option] });
  }
  and(right) {
    return new ZodIntersection({ type: "intersect", left: this, right });
  }
  refine(fn, message) {
    return new ZodEffects({
      type: "refine",
      inner: this,
      cbid: regId(reg.refine, fn),
      message
    });
  }
  refinement(fn, message) {
    return this.refine(fn, message);
  }
  superRefine(fn) {
    return new ZodEffects({
      type: "refine",
      inner: this,
      cbid: regId(reg.refine, ((v) => {
        let ok = true;
        fn(v, {
          addIssue: /* @__PURE__ */ __name((i) => {
            ok = false;
            pendingRefineIssues.push(i);
          }, "addIssue")
        });
        return ok;
      })),
      message: void 0
    });
  }
  transform(fn) {
    return new ZodEffects({
      type: "transform",
      inner: this,
      cbid: regId(reg.transform, fn)
    });
  }
  pipe(target) {
    return new ZodPipe({ type: "pipe", in: this, out: target });
  }
  brand() {
    return new ZodBranded({ type: "brand", inner: this });
  }
  nonoptional() {
    return new ZodNonOptional({ inner: this });
  }
  clone() {
    return new this.constructor({ ...this._def });
  }
  describe(d) {
    const c = this.clone();
    c._def = { ...c._def, description: d };
    return c;
  }
  meta(m) {
    if (m === void 0) return this._def.meta;
    const c = this.clone();
    c._def = { ...c._def, meta: { ...c._def.meta ?? {}, ...m } };
    return c;
  }
  register(registry, m) {
    if (m !== void 0) this.meta(m);
    registry?.add?.(this);
    return this;
  }
  check(...fns) {
    return this.superRefine((v, ctx) => {
      for (const fn of fns) {
        const payload = {
          value: v,
          issues: [],
          addIssue: /* @__PURE__ */ __name((i) => payload.issues.push(i), "addIssue")
        };
        fn(payload);
        for (const i of payload.issues) ctx.addIssue(i);
      }
    });
  }
  overwrite(fn) {
    return this.transform(fn);
  }
  prefault(value) {
    const v = typeof value === "function" ? value() : value;
    return new ZodPipe({
      type: "pipe",
      in: new ZodEffects({
        type: "transform",
        inner: new ZodAny(),
        cbid: regId(reg.transform, (x) => x === void 0 ? v : x)
      }),
      out: this
    });
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
  get def() {
    return this._def;
  }
  get type() {
    return this._def.type;
  }
  get description() {
    return this._def.description;
  }
  get "~standard"() {
    const self = this;
    return {
      version: 1,
      vendor: "zod",
      validate: /* @__PURE__ */ __name((v) => {
        const r = self.safeParse(v);
        return r.success ? { value: r.data } : { issues: r.error.issues };
      }, "validate")
    };
  }
  async safeParseAsync(data) {
    return this.safeParse(data);
  }
  // extension: batch-validate through the addon's in-native loop when
  // available; per-element results like a map of safeParse
  safeParseMany(data) {
    const c = this._compile();
    const rs = parseMany(c.blob, data, c.hosts, c.cbUnsafe);
    if (rs !== null) {
      return rs.map((r) => {
        if (r.ok) return { success: true, data: r.value };
        return { success: false, error: new ZodError(r.issues) };
      });
    }
    return data.map((v) => this.safeParse(v));
  }
  parseMany(data) {
    return this.safeParseMany(data).map((r) => {
      if (!r.success) throw r.error;
      return r.data;
    });
  }
  spa(data) {
    return this.safeParseAsync(data);
  }
  readonly() {
    return this;
  }
};
var ZodString = class _ZodString extends ZodType {
  static {
    __name(this, "ZodString");
  }
  constructor(_def = { type: "string", checks: [] }) {
    super();
    this._def = _def;
  }
  _check(c) {
    return new _ZodString({ ...this._def, checks: [...this._def.checks, { ...c, message: paramMsg(c.message) }] });
  }
  min(n, message) {
    return this._check({ kind: "min", value: n, message });
  }
  max(n, message) {
    return this._check({ kind: "max", value: n, message });
  }
  length(n, message) {
    return this._check({ kind: "length", value: n, message });
  }
  email(message) {
    return this._check({ kind: "email", message });
  }
  url(message) {
    return this._check({ kind: "url", message });
  }
  uuid(message) {
    return this._check({ kind: "uuid", message });
  }
  uuidv4(message) {
    return this._check({ kind: "uuid", version: 4, message });
  }
  ulid(message) {
    return this._check({ kind: "ulid", message });
  }
  nanoid(message) {
    return this._check({ kind: "nanoid", message });
  }
  cuid2(message) {
    return this._check({ kind: "cuid2", message });
  }
  base64(message) {
    return this._check({ kind: "base64", message });
  }
  hex(message) {
    return this._check({ kind: "hex", message });
  }
  ip(message) {
    return this._check({ kind: "ipv4", message });
  }
  ipv4(message) {
    return this._check({ kind: "ipv4", message });
  }
  ipv6(message) {
    return this._check({ kind: "ipv6", message });
  }
  datetime(message) {
    return this._check({ kind: "datetime", message });
  }
  date(message) {
    return this._check({ kind: "datestr", message });
  }
  time(message) {
    return this._check({ kind: "timestr", message });
  }
  regex(re, message) {
    return this._check({ kind: "regex", regex: re, message });
  }
  startsWith(s, message) {
    return this._check({ kind: "startsWith", value: s, message });
  }
  endsWith(s, message) {
    return this._check({ kind: "endsWith", value: s, message });
  }
  includes(s, message) {
    return this._check({ kind: "includes", value: s, message });
  }
  lowercase(message) {
    return this._check({ kind: "lowercase", message });
  }
  uppercase(message) {
    return this._check({ kind: "uppercase", message });
  }
  nonempty(message) {
    return this.min(1, message);
  }
  trim() {
    return this.transform((s) => s.trim());
  }
  toLowerCase() {
    return this.transform((s) => s.toLowerCase());
  }
  toUpperCase() {
    return this.transform((s) => s.toUpperCase());
  }
  _fmtcheck(format, regex, message) {
    return this._check({ kind: "regex", regex, format, message });
  }
  emoji(message) {
    return this._fmtcheck(
      "emoji",
      /^(?=[\s\S]*[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3])[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u,
      message
    );
  }
  guid(message) {
    return this._fmtcheck(
      "guid",
      /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
      message
    );
  }
  uuidv6(message) {
    return this._fmtcheck(
      "uuid6",
      /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-6[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/,
      message
    );
  }
  uuidv7(message) {
    return this._fmtcheck(
      "uuid7",
      /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/,
      message
    );
  }
  cuid(message) {
    return this._fmtcheck("cuid", /^[cC][0-9a-z]{6,}$/, message);
  }
  base64url(message) {
    return this._fmtcheck(
      "base64url",
      /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/,
      message
    );
  }
  jwt(message) {
    return this._fmtcheck(
      "jwt",
      /^([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]{2,})$/,
      message
    );
  }
  xid(message) {
    return this._fmtcheck("xid", /^[0-9a-vA-V]{20}$/, message);
  }
  ksuid(message) {
    return this._fmtcheck("ksuid", /^[A-Za-z0-9]{27}$/, message);
  }
  e164(message) {
    return this._fmtcheck("e164", /^\+[1-9]\d{6,14}$/, message);
  }
  cidrv4(message) {
    return this._fmtcheck(
      "cidrv4",
      /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/,
      message
    );
  }
  cidrv6(message) {
    return this._fmtcheck(
      "cidrv6",
      /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))\/(12[0-8]|1[01][0-9]|[0-9]{1,2})$/,
      message
    );
  }
  duration(message) {
    return this._fmtcheck(
      "duration",
      /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/,
      message
    );
  }
  hostname(message) {
    return this._fmtcheck(
      "hostname",
      /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/,
      message
    );
  }
  httpUrl(message) {
    return this._fmtcheck(
      "httpurl",
      /^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*$/,
      message
    );
  }
  normalize(form = "NFC") {
    return this.transform((s) => s.normalize(form));
  }
  slugify() {
    return this.transform((s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, ""));
  }
  get format() {
    for (const c of this._def.checks ?? [])
      if (c.format) return c.format === "httpurl" ? "url" : c.format.startsWith("uuid") ? "uuid" : c.format;
    for (const c of this._def.checks ?? [])
      if (![
        "min",
        "max",
        "length",
        "startsWith",
        "endsWith",
        "includes",
        "regex",
        "lowercase",
        "uppercase"
      ].includes(c.kind))
        return c.kind === "datestr" ? "date" : c.kind === "timestr" ? "time" : c.kind;
    return null;
  }
  get minLength() {
    for (const c of this._def.checks ?? [])
      if (c.kind === "min" || c.kind === "length") return c.value;
    return null;
  }
  get maxLength() {
    for (const c of this._def.checks ?? [])
      if (c.kind === "max" || c.kind === "length") return c.value;
    return null;
  }
};
var ZodNumber = class _ZodNumber extends ZodType {
  static {
    __name(this, "ZodNumber");
  }
  constructor(_def = { type: "number", checks: [] }) {
    super();
    this._def = _def;
  }
  _check(c) {
    return new _ZodNumber({ ...this._def, checks: [...this._def.checks, { ...c, message: paramMsg(c.message) }] });
  }
  gt(n, message) {
    return this._check({ kind: "gt", value: n, message });
  }
  gte(n, message) {
    return this._check({ kind: "gte", value: n, message });
  }
  min(n, message) {
    return this._check({ kind: "gte", value: n, message });
  }
  lt(n, message) {
    return this._check({ kind: "lt", value: n, message });
  }
  lte(n, message) {
    return this._check({ kind: "lte", value: n, message });
  }
  max(n, message) {
    return this._check({ kind: "lte", value: n, message });
  }
  int(message) {
    return this._check({ kind: "int", message });
  }
  safe(message) {
    return this._check({ kind: "safeInt", message });
  }
  finite(message) {
    return this._check({ kind: "finite", message });
  }
  multipleOf(n, message) {
    return this._check({ kind: "multipleOf", value: n, message });
  }
  step(n, message) {
    return this.multipleOf(n, message);
  }
  positive(message) {
    return this.gt(0, message);
  }
  nonnegative(message) {
    return this.gte(0, message);
  }
  negative(message) {
    return this.lt(0, message);
  }
  nonpositive(message) {
    return this.lte(0, message);
  }
  get minValue() {
    for (const c of this._def.checks ?? [])
      if (c.kind === "gte" || c.kind === "gt") return c.value;
    return null;
  }
  get maxValue() {
    for (const c of this._def.checks ?? [])
      if (c.kind === "lte" || c.kind === "lt") return c.value;
    return null;
  }
  get isInt() {
    return (this._def.checks ?? []).some((c) => c.kind === "int" || c.kind === "safeInt");
  }
  get isFinite() {
    return true;
  }
  get format() {
    return this.isInt ? "safeint" : null;
  }
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  static {
    __name(this, "ZodBigInt");
  }
  constructor(_def = { type: "bigint", checks: [] }) {
    super();
    this._def = _def;
  }
  _check(c) {
    return new _ZodBigInt({ ...this._def, checks: [...this._def.checks, { ...c, message: paramMsg(c.message) }] });
  }
  gt(n, message) {
    return this._check({ kind: "gt", value: n, message });
  }
  gte(n, message) {
    return this._check({ kind: "gte", value: n, message });
  }
  min(n, message) {
    return this._check({ kind: "gte", value: n, message });
  }
  lt(n, message) {
    return this._check({ kind: "lt", value: n, message });
  }
  lte(n, message) {
    return this._check({ kind: "lte", value: n, message });
  }
  max(n, message) {
    return this._check({ kind: "lte", value: n, message });
  }
  multipleOf(n, message) {
    return this._check({ kind: "multipleOf", value: n, message });
  }
  positive(m) {
    return this.gt(0n, m);
  }
  nonnegative(m) {
    return this.gte(0n, m);
  }
  negative(m) {
    return this.lt(0n, m);
  }
  nonpositive(m) {
    return this.lte(0n, m);
  }
  get minValue() {
    for (const c of this._def.checks ?? [])
      if (c.kind === "gte" || c.kind === "gt" || c.kind === "min") return c.value;
    return null;
  }
  get maxValue() {
    for (const c of this._def.checks ?? [])
      if (c.kind === "lte" || c.kind === "lt" || c.kind === "max") return c.value;
    return null;
  }
  get format() {
    return null;
  }
};
var ZodBoolean = class extends ZodType {
  static {
    __name(this, "ZodBoolean");
  }
  constructor(_def = { type: "boolean" }) {
    super();
    this._def = _def;
  }
};
var ZodAny = class extends ZodType {
  static {
    __name(this, "ZodAny");
  }
  constructor(_def = { type: "any" }) {
    super();
    this._def = _def;
  }
};
var ZodUnknown = class extends ZodType {
  static {
    __name(this, "ZodUnknown");
  }
  constructor(_def = { type: "unknown" }) {
    super();
    this._def = _def;
  }
};
var ZodNever = class extends ZodType {
  static {
    __name(this, "ZodNever");
  }
  constructor(_def = { type: "never" }) {
    super();
    this._def = _def;
  }
};
var ZodNull = class extends ZodType {
  static {
    __name(this, "ZodNull");
  }
  constructor(_def = { type: "null" }) {
    super();
    this._def = _def;
  }
};
var ZodUndefined = class extends ZodType {
  static {
    __name(this, "ZodUndefined");
  }
  constructor(_def = { type: "undefined" }) {
    super();
    this._def = _def;
  }
};
var ZodVoid = class extends ZodType {
  static {
    __name(this, "ZodVoid");
  }
  constructor(_def = { type: "void" }) {
    super();
    this._def = _def;
  }
};
var ZodNaN = class extends ZodType {
  static {
    __name(this, "ZodNaN");
  }
  constructor(_def = { type: "nan" }) {
    super();
    this._def = _def;
  }
};
var ZodSymbol = class extends ZodType {
  static {
    __name(this, "ZodSymbol");
  }
  constructor(_def = { type: "symbol" }) {
    super();
    this._def = _def;
  }
};
var ZodDate = class _ZodDate extends ZodType {
  static {
    __name(this, "ZodDate");
  }
  constructor(_def = { type: "date", checks: [] }) {
    super();
    this._def = _def;
  }
  _check(c) {
    return new _ZodDate({ ...this._def, checks: [...this._def.checks, { ...c, message: paramMsg(c.message) }] });
  }
  min(d, message) {
    return this._check({ kind: "min", value: d.getTime(), message });
  }
  max(d, message) {
    return this._check({ kind: "max", value: d.getTime(), message });
  }
  get minDate() {
    for (const c of this._def.checks ?? [])
      if (c.kind === "min") return new Date(c.value);
    return null;
  }
  get maxDate() {
    for (const c of this._def.checks ?? [])
      if (c.kind === "max") return new Date(c.value);
    return null;
  }
};
var ZodOptional = class extends ZodType {
  static {
    __name(this, "ZodOptional");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  unwrap() {
    return this._def.inner;
  }
};
var ZodNullable = class extends ZodType {
  static {
    __name(this, "ZodNullable");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  unwrap() {
    return this._def.inner;
  }
};
var ZodDefault = class extends ZodType {
  static {
    __name(this, "ZodDefault");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  removeDefault() {
    return this._def.inner;
  }
};
var ZodCatch = class extends ZodType {
  static {
    __name(this, "ZodCatch");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  removeCatch() {
    return this._def.inner;
  }
};
var ZodEffects = class extends ZodType {
  static {
    __name(this, "ZodEffects");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  innerType() {
    return this._def.inner;
  }
  sourceType() {
    return this._def.inner;
  }
};
var ZodPipe = class extends ZodType {
  static {
    __name(this, "ZodPipe");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
};
var ZodBranded = class extends ZodType {
  static {
    __name(this, "ZodBranded");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
};
var ZodObject = class _ZodObject extends ZodType {
  static {
    __name(this, "ZodObject");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  get shape() {
    return this._def.shape;
  }
  strict() {
    return new _ZodObject({ ...this._def, mode: "strict" });
  }
  strip() {
    return new _ZodObject({ ...this._def, mode: "strip" });
  }
  passthrough() {
    return new _ZodObject({ ...this._def, mode: "passthrough" });
  }
  catchall(c) {
    return new _ZodObject({ ...this._def, catchall: c });
  }
  extend(s) {
    return new _ZodObject({ ...this._def, shape: { ...this._def.shape, ...s } });
  }
  pick(mask) {
    const shape = {};
    for (const k of Object.keys(mask)) if (mask[k]) shape[k] = this._def.shape[k];
    return new _ZodObject({ ...this._def, shape });
  }
  omit(mask) {
    const shape = { ...this._def.shape };
    for (const k of Object.keys(mask)) if (mask[k]) delete shape[k];
    return new _ZodObject({ ...this._def, shape });
  }
  partial() {
    const shape = {};
    for (const k of Object.keys(this._def.shape)) shape[k] = this._def.shape[k].optional();
    return new _ZodObject({ ...this._def, shape });
  }
  required() {
    const shape = {};
    for (const k of Object.keys(this._def.shape)) {
      let s = this._def.shape[k];
      let wasOpt = false;
      while (s instanceof ZodOptional) {
        wasOpt = true;
        s = s.unwrap();
      }
      shape[k] = wasOpt ? new ZodNonOptional({ inner: s }) : s;
    }
    return new _ZodObject({ ...this._def, shape });
  }
  keyof() {
    return new ZodEnum({ type: "enum", values: Object.keys(this._def.shape) });
  }
  deepPartial() {
    return this.partial();
  }
  loose() {
    return this.passthrough();
  }
  merge(o) {
    return this.extend(o.shape);
  }
  safeExtend(s) {
    return this.extend(s);
  }
  exactPartial() {
    return this.partial();
  }
};
var ZodArray = class _ZodArray extends ZodType {
  static {
    __name(this, "ZodArray");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  unwrap() {
    return this._def.element;
  }
  get element() {
    return this._def.element;
  }
  min(n, message) {
    return new _ZodArray({ ...this._def, minLen: n, _minMsg: message });
  }
  max(n, message) {
    return new _ZodArray({ ...this._def, maxLen: n, _maxMsg: message });
  }
  length(n, message) {
    return new _ZodArray({ ...this._def, minLen: n, maxLen: n, exactLen: true });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
var ZodTuple = class _ZodTuple extends ZodType {
  static {
    __name(this, "ZodTuple");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  rest(r) {
    return new _ZodTuple({ ...this._def, rest: r });
  }
};
var ZodRecord = class extends ZodType {
  static {
    __name(this, "ZodRecord");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
};
var ZodNonOptional = class extends ZodType {
  static {
    __name(this, "ZodNonOptional");
  }
  constructor(_def) {
    super();
    this._def = { ..._def, type: "nonoptional" };
  }
  _run(data) {
    if (data === void 0) return { ok: false, issues: [typeIssue("nonoptional", data)], aborted: true };
    return this._def.inner._run(data);
  }
};
var CONTINUING_CODES = /* @__PURE__ */ new Set([
  "too_small",
  "too_big",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "custom"
]);
function isAborted(issues) {
  return issues.some((i) => i._nc || !CONTINUING_CODES.has(i.code));
}
__name(isAborted, "isAborted");
function typeIssue(expected, received) {
  const recvd = parsedTypeName(received);
  return {
    code: "invalid_type",
    path: [],
    expected,
    message: `Invalid input: expected ${expected === "nan" ? "NaN" : expected}, received ${recvd}`
  };
}
__name(typeIssue, "typeIssue");
var ZodMap = class extends ZodType {
  static {
    __name(this, "ZodMap");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  _run(data) {
    if (!(data instanceof Map)) return { ok: false, issues: [typeIssue("map", data)], aborted: true };
    const { keyType, valueType } = this._def;
    const out = /* @__PURE__ */ new Map();
    const issues = [];
    for (const [k, v] of data) {
      const kr = keyType._run(k);
      const vr = valueType._run(v);
      if (!kr.ok) issues.push(...kr.issues.map((i) => ({ ...i, path: [k, ...i.path ?? []] })));
      if (!vr.ok) issues.push(...vr.issues.map((i) => ({ ...i, path: [k, ...i.path ?? []] })));
      if (kr.ok && vr.ok) out.set(kr.value, vr.value);
    }
    return issues.length ? { ok: false, issues, aborted: isAborted(issues) } : { ok: true, value: out };
  }
};
var ZodSet = class extends ZodType {
  static {
    __name(this, "ZodSet");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  _run(data) {
    if (!(data instanceof Set)) return { ok: false, issues: [typeIssue("set", data)], aborted: true };
    const { valueType } = this._def;
    const out = /* @__PURE__ */ new Set();
    const issues = [];
    for (const v of data) {
      const r = valueType._run(v);
      if (r.ok) out.add(r.value);
      else issues.push(...r.issues);
    }
    return issues.length ? { ok: false, issues, aborted: isAborted(issues) } : { ok: true, value: out };
  }
};
var ZodUnion = class extends ZodType {
  static {
    __name(this, "ZodUnion");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  get options() {
    return this._def.options;
  }
  // union resolution happens in ZodType._run via the engine's `_u` marker:
  // exactly one non-aborted option surfaces its issues in place of the
  // invalid_union issue; otherwise per-option errors arrays attach
};
var ZodDiscriminatedUnion = class extends ZodType {
  static {
    __name(this, "ZodDiscriminatedUnion");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  get options() {
    return [...this._def.optionsMap.values()];
  }
  parse(data) {
    const r = this._run(data);
    if (!r.ok) {
      this._attachFields(r.issues);
      throw new ZodError(r.issues);
    }
    return r.value;
  }
  safeParse(data) {
    const r = this._run(data);
    if (r.ok) return { success: true, data: r.value };
    this._attachFields(r.issues);
    return { success: false, error: new ZodError(r.issues) };
  }
  _attachFields(issues) {
    for (const i of issues) {
      if (i.code === "invalid_union" && i.errors === void 0) {
        i.errors = [];
        i.note = "No matching discriminator";
        i.discriminator = this._def.disc;
        const opts = [...this._def.optionsMap.keys()];
        i.options = opts;
        if (i.message === "Invalid input")
          i.message = `Invalid discriminator value. Expected ${opts.map((o) => `'${o}'`).join(" | ")}`;
      }
    }
  }
};
var ZodIntersection = class extends ZodType {
  static {
    __name(this, "ZodIntersection");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
};
var ZodLiteral = class extends ZodType {
  static {
    __name(this, "ZodLiteral");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  get value() {
    return this._def.value;
  }
};
var ZodEnum = class _ZodEnum extends ZodType {
  static {
    __name(this, "ZodEnum");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    return Object.fromEntries(this._def.values.map((v) => [v, v]));
  }
  extract(vals) {
    return new _ZodEnum({ type: "enum", values: this._def.values.filter((v) => vals.includes(v)) });
  }
  exclude(vals) {
    return new _ZodEnum({ type: "enum", values: this._def.values.filter((v) => !vals.includes(v)) });
  }
};
var ZodLazy = class extends ZodType {
  static {
    __name(this, "ZodLazy");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
  get schema() {
    return this._def.getter();
  }
};
var ZodInstanceof = class extends ZodType {
  static {
    __name(this, "ZodInstanceof");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
};
var ZodPromise = class extends ZodType {
  static {
    __name(this, "ZodPromise");
  }
  constructor(_def = { type: "instof", ctor: Promise, name: "promise", inner: null }) {
    super();
    this._def = _def;
  }
  _syncThrow() {
    throw new Error("Encountered Promise during synchronous parse. Use .parseAsync() instead.");
  }
  parse(_) {
    this._syncThrow();
  }
  safeParse(_) {
    this._syncThrow();
  }
  async safeParseAsync(data) {
    const instof = new ZodInstanceof({ type: "instof", ctor: Promise, name: "promise" });
    const r = instof.safeParse(data);
    if (!r.success) return r;
    const p = r.data;
    const inner = this._def.inner;
    try {
      const resolved = await p;
      const ir = inner.safeParse(resolved);
      if (!ir.success) return ir;
      return { success: true, data: ir.data };
    } catch (e) {
      return { success: false, error: new ZodError([{ code: "custom", path: [], message: String(e) }]) };
    }
  }
  parseAsync(data) {
    return super.parseAsync(data);
  }
};
var ZodFunction = class extends ZodType {
  static {
    __name(this, "ZodFunction");
  }
  constructor(_def = { type: "instof", ctor: Function, name: "function", args: null, ret: null }) {
    super();
    this._def = _def;
  }
  implement(fn) {
    const { args, ret } = this._def;
    if (!args && !ret) return fn;
    return (...callArgs) => {
      if (args) {
        const t = new ZodTuple({ type: "tuple", items: args, rest: null });
        const ar = t.safeParse(callArgs);
        if (!ar.success) throw new ZodError(ar.error.issues);
      }
      const out = fn(...callArgs);
      if (ret) {
        const rr = ret.safeParse(out);
        if (!rr.success) throw new ZodError(rr.error.issues);
        return rr.data;
      }
      return out;
    };
  }
};
var ZodCustom = class extends ZodType {
  static {
    __name(this, "ZodCustom");
  }
  constructor(_def) {
    super();
    this._def = _def;
  }
};

// ../../src/index.ts
var z = {
  string: /* @__PURE__ */ __name((params) => new ZodString({ type: "string", checks: [], error: params }), "string"),
  number: /* @__PURE__ */ __name((params) => new ZodNumber({ type: "number", checks: [], error: params }), "number"),
  bigint: /* @__PURE__ */ __name((params) => new ZodBigInt({ type: "bigint", checks: [], error: params }), "bigint"),
  boolean: /* @__PURE__ */ __name((params) => new ZodBoolean({ type: "boolean", checks: [], error: params }), "boolean"),
  date: /* @__PURE__ */ __name((params) => new ZodDate({ type: "date", checks: [], error: params }), "date"),
  symbol: /* @__PURE__ */ __name((params) => new ZodSymbol({ type: "symbol", checks: [], error: params }), "symbol"),
  any: /* @__PURE__ */ __name((params) => new ZodAny({ type: "any", checks: [], error: params }), "any"),
  unknown: /* @__PURE__ */ __name((params) => new ZodUnknown({ type: "unknown", checks: [], error: params }), "unknown"),
  never: /* @__PURE__ */ __name((params) => new ZodNever({ type: "never", checks: [], error: params }), "never"),
  null: /* @__PURE__ */ __name((params) => new ZodNull({ type: "null", checks: [], error: params }), "null"),
  undefined: /* @__PURE__ */ __name((params) => new ZodUndefined({ type: "undefined", checks: [], error: params }), "undefined"),
  void: /* @__PURE__ */ __name((params) => new ZodVoid({ type: "void", checks: [], error: params }), "void"),
  nan: /* @__PURE__ */ __name((params) => new ZodNaN({ type: "nan", checks: [], error: params }), "nan"),
  object: /* @__PURE__ */ __name((shape, params) => new ZodObject({ type: "object", shape, mode: "strip", catchall: null, error: params }), "object"),
  strictObject: /* @__PURE__ */ __name((shape, params) => new ZodObject({ type: "object", shape, mode: "strict", catchall: null, error: params }), "strictObject"),
  looseObject: /* @__PURE__ */ __name((shape, params) => new ZodObject({ type: "object", shape, mode: "passthrough", catchall: null, error: params }), "looseObject"),
  promise: /* @__PURE__ */ __name((inner) => new ZodPromise({ type: "instof", ctor: Promise, name: "promise", inner }), "promise"),
  function: /* @__PURE__ */ __name((opts) => new ZodFunction({
    type: "instof",
    ctor: Function,
    name: "function",
    args: opts?.input ?? null,
    ret: opts?.output ?? null
  }), "function"),
  preprocess: /* @__PURE__ */ __name((fn, schema) => new ZodPipe({
    type: "pipe",
    in: new ZodEffects({ type: "transform", inner: new ZodAny(), cbid: regId(reg.transform, fn) }),
    out: schema
  }), "preprocess"),
  array: /* @__PURE__ */ __name((element, params) => new ZodArray({ type: "array", element, error: params }), "array"),
  tuple: /* @__PURE__ */ __name((items, params) => new ZodTuple({ type: "tuple", items, rest: null, error: params }), "tuple"),
  record: /* @__PURE__ */ __name(((keyOrVal, val) => val === void 0 ? new ZodRecord({ type: "record", keyType: null, valueType: keyOrVal }) : new ZodRecord({ type: "record", keyType: keyOrVal, valueType: val })), "record"),
  map: /* @__PURE__ */ __name((key, value) => new ZodMap({ type: "map", keyType: key, valueType: value }), "map"),
  set: /* @__PURE__ */ __name((value) => new ZodSet({ type: "set", valueType: value }), "set"),
  union: /* @__PURE__ */ __name((options, params) => new ZodUnion({ type: "union", options, error: params }), "union"),
  discriminatedUnion: /* @__PURE__ */ __name((disc, options) => {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const o of options) {
      const lit = o._def?.shape?.[disc]?._def?.value;
      if (lit === void 0)
        throw new Error(`asmzod: discriminatedUnion option missing literal "${disc}"`);
      optionsMap.set(String(lit), o);
    }
    return new ZodDiscriminatedUnion({ type: "discunion", disc, optionsMap });
  }, "discriminatedUnion"),
  intersection: /* @__PURE__ */ __name((l, r) => new ZodIntersection({ type: "intersect", left: l, right: r }), "intersection"),
  literal: /* @__PURE__ */ __name((v, params) => new ZodLiteral({ type: "literal", value: v, error: params }), "literal"),
  enum: /* @__PURE__ */ __name((values, params) => new ZodEnum({ type: "enum", values, error: params }), "enum"),
  nativeEnum: /* @__PURE__ */ __name((e) => {
    const vals = Object.values(e).filter((v) => typeof v === "string");
    return new ZodEnum({ type: "enum", values: vals });
  }, "nativeEnum"),
  lazy: /* @__PURE__ */ __name((getter) => new ZodLazy({ type: "lazy", getter }), "lazy"),
  instanceof: /* @__PURE__ */ __name((ctor) => new ZodInstanceof({ type: "instof", ctor, name: ctor.name ?? "object" }), "instanceof"),
  custom: /* @__PURE__ */ __name((fn, message) => new ZodCustom({ type: "custom", cbid: regId(reg.custom, fn), message }), "custom"),
  coerce: {
    string: /* @__PURE__ */ __name(() => new ZodEffects({
      type: "coerce_str",
      inner: new ZodString()
    }), "string"),
    number: /* @__PURE__ */ __name(() => new ZodEffects({
      type: "coerce_num",
      inner: new ZodNumber()
    }), "number"),
    boolean: /* @__PURE__ */ __name(() => new ZodEffects({
      type: "coerce_bool",
      inner: new ZodBoolean()
    }), "boolean"),
    bigint: /* @__PURE__ */ __name(() => new ZodEffects({
      type: "coerce_bigint",
      inner: new ZodBigInt()
    }), "bigint"),
    date: /* @__PURE__ */ __name(() => {
      throw new Error("asmzod: z.coerce.date() not supported in v1");
    }, "date")
  },
  optional: /* @__PURE__ */ __name((s) => new ZodOptional({ type: "optional", inner: s }), "optional"),
  nullable: /* @__PURE__ */ __name((s) => new ZodNullable({ type: "nullable", inner: s }), "nullable"),
  nullish: /* @__PURE__ */ __name((s) => new ZodNullable({ type: "nullable", inner: s }).optional(), "nullish"),
  default: /* @__PURE__ */ __name((s, v) => new ZodDefault({ type: "default", inner: s, value: v }), "default"),
  catch: /* @__PURE__ */ __name((s, v) => s.catch(v), "catch"),
  brand: /* @__PURE__ */ __name((s) => s.brand(), "brand"),
  nonoptional: /* @__PURE__ */ __name((s) => s.nonoptional(), "nonoptional"),
  readonly: /* @__PURE__ */ __name((s) => s.readonly(), "readonly"),
  refine: /* @__PURE__ */ __name((fn, message) => new ZodAny().refine(fn, message), "refine"),
  superRefine: /* @__PURE__ */ __name((fn) => new ZodAny().superRefine(fn), "superRefine"),
  transform: /* @__PURE__ */ __name((fn) => new ZodAny().transform(fn), "transform"),
  // string-format factories — equivalent to z.string().<fmt>()
  email: /* @__PURE__ */ __name((p) => new ZodString().email(p), "email"),
  url: /* @__PURE__ */ __name((p) => new ZodString().url(p), "url"),
  uuid: /* @__PURE__ */ __name((p) => new ZodString().uuid(p), "uuid"),
  uuidv4: /* @__PURE__ */ __name((p) => new ZodString().uuidv4(p), "uuidv4"),
  uuidv6: /* @__PURE__ */ __name((p) => new ZodString().uuidv6(p), "uuidv6"),
  uuidv7: /* @__PURE__ */ __name((p) => new ZodString().uuidv7(p), "uuidv7"),
  guid: /* @__PURE__ */ __name((p) => new ZodString().guid(p), "guid"),
  cuid: /* @__PURE__ */ __name((p) => new ZodString().cuid(p), "cuid"),
  cuid2: /* @__PURE__ */ __name((p) => new ZodString().cuid2(p), "cuid2"),
  ulid: /* @__PURE__ */ __name((p) => new ZodString().ulid(p), "ulid"),
  nanoid: /* @__PURE__ */ __name((p) => new ZodString().nanoid(p), "nanoid"),
  emoji: /* @__PURE__ */ __name((p) => new ZodString().emoji(p), "emoji"),
  base64: /* @__PURE__ */ __name((p) => new ZodString().base64(p), "base64"),
  base64url: /* @__PURE__ */ __name((p) => new ZodString().base64url(p), "base64url"),
  jwt: /* @__PURE__ */ __name((p) => new ZodString().jwt(p), "jwt"),
  hex: /* @__PURE__ */ __name((p) => new ZodString().hex(p), "hex"),
  xid: /* @__PURE__ */ __name((p) => new ZodString().xid(p), "xid"),
  ksuid: /* @__PURE__ */ __name((p) => new ZodString().ksuid(p), "ksuid"),
  e164: /* @__PURE__ */ __name((p) => new ZodString().e164(p), "e164"),
  duration: /* @__PURE__ */ __name((p) => new ZodString().duration(p), "duration"),
  ipv4: /* @__PURE__ */ __name((p) => new ZodString().ipv4(p), "ipv4"),
  ipv6: /* @__PURE__ */ __name((p) => new ZodString().ipv6(p), "ipv6"),
  cidrv4: /* @__PURE__ */ __name((p) => new ZodString().cidrv4(p), "cidrv4"),
  cidrv6: /* @__PURE__ */ __name((p) => new ZodString().cidrv6(p), "cidrv6"),
  hostname: /* @__PURE__ */ __name((p) => new ZodString().hostname(p), "hostname"),
  httpUrl: /* @__PURE__ */ __name((p) => new ZodString().httpUrl(p), "httpUrl"),
  iso: {
    datetime: /* @__PURE__ */ __name((p) => new ZodString().datetime(p), "datetime"),
    date: /* @__PURE__ */ __name((p) => new ZodString().date(p), "date"),
    time: /* @__PURE__ */ __name((p) => new ZodString().time(p), "time"),
    duration: /* @__PURE__ */ __name((p) => new ZodString().duration(p), "duration")
  },
  file: /* @__PURE__ */ __name(() => new ZodInstanceof({
    type: "instof",
    ctor: globalThis.File,
    name: "file"
  }), "file"),
  templateLiteral: /* @__PURE__ */ __name((parts) => {
    const esc = /* @__PURE__ */ __name((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "esc");
    const pat = parts.map((p) => {
      if (p instanceof ZodString) return ".*";
      if (p instanceof ZodNumber || p instanceof ZodBigInt) return "-?\\d+(?:\\.\\d+)?";
      if (p instanceof ZodLiteral) return esc(String(p._def.value));
      if (typeof p === "string") return esc(p);
      return esc(String(p));
    }).join("");
    return new ZodString()._fmtcheck(
      "template_literal",
      new RegExp(`^${pat}$`)
    );
  }, "templateLiteral"),
  json: /* @__PURE__ */ __name(() => {
    let inner;
    inner = new ZodLazy({
      type: "lazy",
      getter: /* @__PURE__ */ __name(() => new ZodUnion({
        type: "union",
        options: [
          new ZodString(),
          new ZodNumber(),
          new ZodBoolean(),
          new ZodNull(),
          new ZodArray({ type: "array", element: inner }),
          new ZodRecord({ type: "record", keyType: null, valueType: inner })
        ]
      }), "getter")
    });
    return inner;
  }, "json"),
  success: /* @__PURE__ */ __name((s) => s.transform(() => true), "success"),
  // zod3 compatibility aliases
  ZodError: void 0
};
z.ZodError = ZodError;

// worker.ts
var User = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().gte(0).optional()
});
var worker_default = {
  async fetch(req2) {
    const body = await req2.json().catch(() => null);
    const r = User.safeParse(body);
    return Response.json(
      r.success ? { ok: true, data: r.data } : { ok: false, issues: r.error.issues },
      { status: r.success ? 200 : 422 }
    );
  }
};

// ../../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-tWfXBK/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-tWfXBK/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
