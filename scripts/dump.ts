// scripts/dump.ts — disassemble a schema's bytecode blob
// usage: bun scripts/dump.ts '<expr>'   e.g. bun scripts/dump.ts 'z.object({a: z.string()})'
import { z } from "../src/index.ts";

const VERIFY = process.argv.includes("--verify");
const expr = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "z.string().min(3)";
const schema = new Function("z", `return (${expr})`)(z);
const c = (schema as any)._compile();
const blob: Uint8Array = c.blob;
const dv = new DataView(blob.buffer, blob.byteOffset);
const dec = new TextDecoder();

const OPS: Record<number, string> = {
  0x01: "STRING", 0x02: "NUMBER", 0x03: "BOOLEAN", 0x04: "BIGINT",
  0x05: "OBJECT", 0x06: "ARRAY", 0x07: "UNION", 0x08: "DISCUNION",
  0x09: "LITERAL", 0x0a: "ENUM", 0x0b: "OPTIONAL", 0x0c: "NULLABLE",
  0x0d: "DEFAULT", 0x0e: "CATCH", 0x0f: "REFINE", 0x10: "TRANSFORM",
  0x11: "PIPE", 0x12: "INTERSECT", 0x13: "TUPLE", 0x14: "RECORD",
  0x15: "ANY", 0x16: "NEVER", 0x17: "NULL_T", 0x18: "UNDEF_T",
  0x19: "NAN", 0x1a: "LAZY", 0x1b: "INSTANCEOF", 0x1c: "COERCE_STR",
  0x1d: "COERCE_NUM", 0x1e: "COERCE_BOOL", 0x1f: "COERCE_BIGINT",
  0x24: "MAP", 0x25: "SET",
  0x20: "DATE", 0x21: "SYMBOL", 0x22: "CUSTOM", 0x2a: "MSGWRAP",
};
const STRCHK: Record<number, string> = {
  1: "MIN", 2: "MAX", 3: "LENGTH", 4: "EMAIL", 5: "UUID", 6: "URL",
  7: "STARTSWITH", 8: "ENDSWITH", 9: "INCLUDES", 0x0a: "REGEX",
  0x0b: "LOWERCASE", 0x0c: "UPPERCASE", 0x0d: "IPV4", 0x0e: "IPV6",
  0x0f: "ULID", 0x10: "NANOID", 0x11: "CUID2", 0x12: "BASE64",
  0x13: "HEX", 0x14: "DATETIME", 0x15: "DATESTR", 0x16: "TIMESTR",
};
const NUMCHK: Record<number, string> = { 1: "GT", 2: "GTE", 3: "LT", 4: "LTE", 5: "INT", 6: "FINITE", 7: "MULTIPLEOF", 8: "SAFEINT", 9: "RANGE" };
const STR_PARAM: Record<number, number | "str" | "u8"> = { 1: 8, 2: 8, 3: 8, 5: "u8", 7: "str", 8: "str", 9: "str", 0x0a: 8 };
const NUM_PARAM: Record<number, number | undefined> = { 1: 8, 2: 8, 3: 8, 4: 8, 7: 8, 9: 17 };

let p = 0;
const u64 = () => { const v = dv.getBigUint64(p, true); p += 8; return Number(v); };
// self-relative i64 child links (relative to the field's own offset)
const rel = () => { const at = p; const v = dv.getBigInt64(p, true); p += 8; return v === 0n ? 0 : at + Number(v); };
const f64 = () => { const v = dv.getFloat64(p, true); p += 8; return v; };
const u8 = () => blob[p++];
const str = () => { const n = u64(); const s = dec.decode(blob.slice(p, p + n)); p += n; return s; };

function check(kind: Record<number, string>, params: Record<number, any>): string {
  const code = u8();
  const ml = u64();
  const m = ml ? dec.decode(blob.slice(p, p + ml)) : "";
  p += ml;
  let prm = params[code];
  let pv = "";
  if (prm === "str") pv = ` ${JSON.stringify(str())}`;
  else if (prm === "u8") pv = ` v${u8()}`;
  else if (prm === 8) pv = ` ${kind === NUMCHK ? f64() : u64()}`;
  return `${kind[code] ?? "?"}${pv}${m ? ` msg=${JSON.stringify(m)}` : ""}`;
}

function value(): string {
  const t = u8();
  if (t === 0) return "undefined"; if (t === 1) return "null";
  if (t === 2) return String(!!u8()); if (t === 3) return String(f64());
  if (t === 4) return JSON.stringify(str()); if (t === 5) return `${dv.getBigInt64(p, true)}n`, p += 8, "";
  if (t === 8) return `hostref:${u64()}`;
  return `?tag${t}`;
}

function node(off: number, depth: number) {
  const ind = "  ".repeat(depth);
  p = off;
  const at = p;
  const op = u8();
  const name = OPS[op] ?? `?0x${op.toString(16)}`;
  let info = "";
  const kids: number[] = [];
  switch (op) {
    case 0x01: { const n = u8(); for (let i = 0; i < n; i++) info += "\n" + ind + "  " + check(STRCHK, STR_PARAM); break; }
    case 0x02: case 0x04: { const n = u8(); for (let i = 0; i < n; i++) info += "\n" + ind + "  " + check(NUMCHK, NUM_PARAM); break; }
    case 0x05: {
      const mode = u8(); const co = rel(); const n = u64();
      info = ` mode=${["strip", "strict", "passthrough"][mode]}`;
      for (let i = 0; i < n; i++) { const k = str(); const fo = rel(); info += `\n${ind}  .${k} -> @${fo}`; kids.push(fo); }
      if (co) { info += ` catchall->@${co}`; kids.push(co); }
      break;
    }
    case 0x06: { const e = rel(); const mn = u64(); const mx = u64();
      info = ` elem->@${e} min=${mn === 0xffffffffffffffff ? "-" : mn} max=${mx === 0xffffffffffffffff ? "-" : mx}`; kids.push(e); break; }
    case 0x07: { const n = u64(); for (let i = 0; i < n; i++) kids.push(rel()); info = ` opts=[${kids.join(",")}]`; break; }
    case 0x08: { const dn = str(); const n = u64();
      info = ` disc=${JSON.stringify(dn)}`;
      for (let i = 0; i < n; i++) { const k = str(); const o = rel(); info += `\n${ind}  ${k} -> @${o}`; kids.push(o); } break; }
    case 0x09: info = ` ${value()}`; break;
    case 0x0a: { const n = u64(); for (let i = 0; i < n; i++) info += ` ${JSON.stringify(str())}`; break; }
    case 0x0b: case 0x0c: case 0x1a + 2 /*0x1c*/: case 0x1d: case 0x1e: case 0x1f: {
      const i2 = rel(); info = ` inner->@${i2}`; kids.push(i2); break; }
    case 0x0d: case 0x0e: { const i2 = rel(); info = ` inner->@${i2} val=${value()}`; kids.push(i2); break; }
    case 0x0f: { const i2 = rel(); const cb = u64(); const ml = u64(); const m = dec.decode(blob.slice(p, p + ml)); p += ml;
      info = ` inner->@${i2} cb=${cb}${m ? ` msg=${JSON.stringify(m)}` : ""}`; kids.push(i2); break; }
    case 0x10: { const i2 = rel(); const cb = u64(); info = ` inner->@${i2} cb=${cb}`; kids.push(i2); break; }
    case 0x11: { const a = rel(); const b = rel(); info = ` in->@${a} out->@${b}`; kids.push(a, b); break; }
    case 0x12: { const a = rel(); const b = rel(); info = ` l->@${a} r->@${b}`; kids.push(a, b); break; }
    case 0x13: { const n = u64(); for (let i = 0; i < n; i++) kids.push(rel()); const r = rel(); if (r) kids.push(r);
      info = ` n=${n}${r ? ` rest->@${r}` : ""}`; break; }
    case 0x14: { const k = rel(); const v = rel(); info = ` key->@${k} val->@${v}`; if (k) kids.push(k); kids.push(v); break; }
    case 0x24: { const k = rel(); const v = rel(); info = ` key->@${k} val->@${v}`; kids.push(k, v); break; }
    case 0x25: { const v = rel(); info = ` val->@${v}`; kids.push(v); break; }
    case 0x1a: { const cb = u64(); info = ` cb=${cb}`; break; }
    case 0x1b: { const cb = u64(); info = ` cb=${cb} name=${JSON.stringify(str())}`; break; }
    case 0x20: { const n = u8(); for (let i = 0; i < n; i++) info += "\n" + ind + "  " + check(NUMCHK, NUM_PARAM); break; }
    case 0x22: { const cb = u64(); const ml = u64(); const m = dec.decode(blob.slice(p, p + ml)); p += ml;
      info = ` cb=${cb}${m ? ` msg=${JSON.stringify(m)}` : ""}`; break; }
    case 0x2a: { const ml = u64(); const m = dec.decode(blob.slice(p, p + ml)); p += ml; const i2 = rel();
      info = ` msg=${JSON.stringify(m)} inner->@${i2}`; kids.push(i2); break; }
  }
  console.log(`${String(at).padStart(5)} ${name}${info}`);
  if (VERIFY) {
    if (visited.has(at)) errs.push(`node @${at} visited twice`);
    visited.add(at);
    for (const k of kids) {
      if (k < 0 || k >= blob.length) errs.push(`node @${at}: child @${k} out of bounds`);
      if (k === at) errs.push(`node @${at} points at itself`);
    }
    if (name.startsWith("?")) errs.push(`node @${at}: unknown op`);
  }
  for (const k of kids) node(k, depth + 1);
}

const visited = new Set<number>();
const errs: string[] = [];
console.log(`blob: ${blob.length}B  hosts:${c.hosts.length} unions:${c.unions.length} cbUnsafe:${c.cbUnsafe}`);
node(0, 0);
if (VERIFY) {
  if (errs.length) { console.error(`${errs.length} blob invariant violations:`); for (const e of errs) console.error(`  ${e}`); process.exit(1); }
  console.log(`verify: ${visited.size} nodes, all in-bounds`);
}
