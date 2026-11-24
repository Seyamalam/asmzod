// bytecode.ts — schema -> engine blob compiler (see FORMAT.md)
import { BW, u64, str, encodeValue, hostIndex, type HostTable } from "./codec.ts";
import { reg, regId } from "./ffi.ts";
import { paramMsg } from "./shared.ts";

export interface Compiled {
  cbUnsafe: boolean;
  blob: Uint8Array;
  hosts: HostTable; // seed values for embedded hostrefs (literal/default/catch)
  unions: SchemaLike[]; // union defs in emission order — issues carry `_u` index
}

export interface SchemaLike { _def: any }

const enc = new TextEncoder();

const STR_CHECK: Record<string, number> = {
  min: 0x01, max: 0x02, length: 0x03,
  email: 0x04, uuid: 0x05, url: 0x06,
  startsWith: 0x07, endsWith: 0x08, includes: 0x09,
  regex: 0x0a, lowercase: 0x0b, uppercase: 0x0c,
  ipv4: 0x0d, ipv6: 0x0e, ulid: 0x0f, nanoid: 0x10,
  cuid2: 0x11, base64: 0x12, hex: 0x13,
  datetime: 0x14, datestr: 0x15, timestr: 0x16,
  hash: 0x18,
};

const NUM_CHECK: Record<string, number> = {
  gt: 0x01, gte: 0x02, min: 0x02, lt: 0x03, lte: 0x04, max: 0x04,
  int: 0x05, finite: 0x06, multipleOf: 0x07, safeInt: 0x08,
};

// true while emit produces a node that reaches a JS callback (regex checks
// are the only ones reachable through the N-API handler set — refine/lazy/
// coerce/custom opcodes fall back at dispatch anyway)
let cbUnsafe = false;
const lazyThunks = new Map<() => unknown, () => Uint8Array>();

// union defs land in a single global table — `_u` issue indexes must resolve
// even when the union node was emitted by a lazy subschema compiled later
const unionReg: SchemaLike[] = [];

export function compile(schema: SchemaLike): Compiled {
  const w = new BW();
  const hosts: HostTable = [];
  const unions: SchemaLike[] = unionReg;
  const outer = cbUnsafe;
  cbUnsafe = false;
  emit(w, schema, hosts, unions);
  const unsafe = cbUnsafe;
  cbUnsafe = outer;
  return { cbUnsafe: unsafe, blob: w.out(), hosts, unions };
}

function checkMsg(w: BW, msg: string | undefined) {
  const b = msg ? enc.encode(msg) : new Uint8Array(0);
  w.u64(b.length);
  w.raw(b);
}

function emitStrChecks(w: BW, checks: any[]) {
  w.u8(checks.length);
  for (const c of checks) {
    const code = STR_CHECK[c.kind];
    if (code === undefined) throw new Error(`asmzod: unsupported string check ${c.kind}`);
    w.u8(code);
    checkMsg(w, c.message);
    switch (c.kind) {
      case "min": case "max": case "length":
        w.u64(c.value); break;
      case "uuid":
        w.u8(c.version ?? 0); break;
      case "startsWith": case "endsWith": case "includes": {
        const b = enc.encode(c.value);
        w.u64(b.length); w.raw(b); break;
      }
      case "regex": {
        // the engines only ever `.test` — a global regex would carry lastIndex
        // state across parses, so register a non-global equivalent
        const re = c.regex.global ? new RegExp(c.regex.source, c.regex.flags.replace("g", "")) : c.regex;
        w.u64(regId(reg.regex, re));
        // embed /src/flags so the engine can emit zod's `pattern` issue field
        const src = enc.encode(c.format === "template_literal"
          ? c.regex.source
          : `/${c.regex.source}/${c.regex.flags}`);
        w.u64(src.length); w.raw(src);
        // optional format-name override (e.g. "emoji") — emitted as the
        // issue's `validation` field instead of "regex"
        const fmt = enc.encode(c.format ?? "");
        w.u64(fmt.length); w.raw(fmt); break;
      }
      case "hash": {
        w.u64(BigInt(c.body)); w.u8(c.alpha); w.u8(c.pad);
        const f = enc.encode(c.format);
        w.u64(f.length); w.raw(f); break;
      }
      default: break; // no params
    }
  }
}

function emitNumChecks(w: BW, checks: any[], isBig: boolean, hosts: HostTable) {
  // fuse adjacent lower+upper bound pairs into one RANGE record
  // ([9][lo f64][hi f64][flags]) when neither carries a custom message.
  // The engine still checks both sides independently (NaN or an inverted
  // range emits the same two issues zod would), so behavior is identical —
  // one fewer record dispatch per bound pair.
  const LO: Record<string, number> = { gt: 0, gte: 1, min: 1 };
  const HI: Record<string, number> = { lt: 0, lte: 1, max: 1 };
  const nomsg = (x: any) => !x.message;
  type R = { kind: "one"; c: any } | { kind: "range"; lo: number; loIncl: number; hi: number; hiIncl: number };
  const recs: R[] = [];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i], n = checks[i + 1];
    if (!isBig && n && nomsg(c) && nomsg(n) &&
        ((LO[c.kind] !== undefined && HI[n.kind] !== undefined) ||
         (HI[c.kind] !== undefined && LO[n.kind] !== undefined))) {
      const lo = LO[c.kind] !== undefined ? c : n;
      const hi = LO[c.kind] !== undefined ? n : c;
      recs.push({ kind: "range", lo: lo.value, loIncl: LO[lo.kind], hi: hi.value, hiIncl: HI[hi.kind] });
      i++;
    } else recs.push({ kind: "one", c });
  }
  w.u8(recs.length);
  for (const r of recs) {
    if (r.kind === "range") {
      w.u8(9); checkMsg(w, undefined); w.f64(r.lo); w.f64(r.hi); w.u8(r.loIncl | (r.hiIncl << 1));
      continue;
    }
    const c = r.c;
    const code = NUM_CHECK[c.kind];
    if (code === undefined) throw new Error(`asmzod: unsupported number check ${c.kind}`);
    if (c.kind === "gt" || c.kind === "gte" || c.kind === "min" ||
        c.kind === "lt" || c.kind === "lte" || c.kind === "max" ||
        c.kind === "multipleOf") {
      const bv = isBig ? BigInt(c.value) : undefined;
      if (bv !== undefined && BigInt.asIntN(64, bv) !== bv) {
        // bound doesn't fit i64: code|0x10 + u64 host index to the real
        // bigint — native engines bail to portable for these records
        w.u8(code | 0x10);
        checkMsg(w, c.message);
        w.u64(hostIndex(hosts, bv));
        continue;
      }
      w.u8(code);
      checkMsg(w, c.message);
      if (isBig) w.i64(bv!); else w.f64(c.value);
      continue;
    }
    w.u8(code);
    checkMsg(w, c.message);
  }
}

// schemas currently on the emit stack — re-entering one means the graph is
// recursive (getter options, direct self-reference without z.lazy); defer it
// through the lazy-ref op so runtime resolves the schema's own compiled blob
const emitStack = new Set<SchemaLike>();
const refThunks = new Map<SchemaLike, () => Uint8Array>();
function refThunk(s: SchemaLike): () => Uint8Array {
  let th = refThunks.get(s);
  if (!th) {
    let blob: Uint8Array | null = null;
    th = () => (blob ??= compile(s).blob);
    refThunks.set(s, th);
  }
  return th;
}

function emit(w: BW, s: SchemaLike, hosts: HostTable, unions: SchemaLike[]): void {
  const d = s._def ?? (s as any)._zod?.def;
  // schema-level {error}/message param -> 0x2A msgwrap node: the engine
  // scopes the message to issues raised at this node's path depth
  const m = paramMsg(d?.error ?? d?.message);
  if (m !== undefined && m !== "") {
    w.u8(0x2A);
    checkMsg(w, m);
    const f = w.field();
    const at = w.pos;
    emitNode(w, s, hosts, unions);
    w.patchField(f, at);
    return;
  }
  if (emitStack.has(s)) {
    w.u8(0x1a);
    w.u64(regId(reg.lazy, refThunk(s)));
    return;
  }
  emitStack.add(s);
  try {
    emitNode(w, s, hosts, unions);
  } finally {
    emitStack.delete(s);
  }
}

function emitNode(w: BW, s: SchemaLike, hosts: HostTable, unions: SchemaLike[]): void {
  const d = s._def ?? (s as any)._zod?.def;
  switch (d.type) {
    case "string": w.u8(0x01); emitStrChecks(w, d.checks); return;
    case "number": w.u8(0x02); emitNumChecks(w, d.checks, false, hosts); return;
    case "boolean": w.u8(0x03); return;
    case "bigint": w.u8(0x04); emitNumChecks(w, d.checks, true, hosts); return;

    case "object": {
      w.u8(0x05);
      w.u8(d.mode === "strict" ? 1 : d.mode === "passthrough" ? 2 : 0);
      const cf = w.field();
      const keys = Object.keys(d.shape);
      w.u64(keys.length);
      const fps: number[] = [];
      for (const k of keys) {
        // absent key handling, mirroring zod's handlePropertyResult rungs:
        // 0 -> required (nonoptional issue when inner accepts undefined);
        // 1 -> defaulted-in + optional-out (run, swallow failure);
        // 2 -> optin==="optional" + optional-out (contributes nothing);
        // 3 -> omittable-in but non-optional-out (run, failures surface)
        const fo = (d.shape[k] as any)._zod;
        const opt = fo?.optin === undefined ? 0
          : fo.optout === "optional" ? (fo.optin === "optional" ? 2 : 1)
          : 3;
        w.u8(opt);
        const kb = enc.encode(k);
        w.u64(kb.length); w.raw(kb);
        fps.push(w.field());
      }
      // convention catchalls (strict->never, passthrough->unknown) are kept in
      // _def for API compat but the engine's mode byte already covers them —
      // compiling them would change strict into per-key never failures
      if (d.catchall && d.mode !== "strict" && d.mode !== "passthrough") {
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
      w.u8(0x06);
      const f = w.field();
      w.u64(d.minLen ?? -1n); // u64_MAX = absent; -1n encodes as all-ones
      w.u64(d.maxLen ?? -1n);
      w.u8(d.exactLen ? 1 : 0);
      const at = w.pos;
      emit(w, d.element, hosts, unions);
      w.patchField(f, at);
      return;
    }

    case "union": {
      w.u8(0x07);
      w.u64(d.options.length);
      const fps = d.options.map(() => w.field());
      const uidx = unions.length;
      unions.push(s);
      w.u64(BigInt(uidx)); // fixed slot after fields — asm reads it on allfail
      d.options.forEach((o: SchemaLike, i: number) => {
        const at = w.pos;
        emit(w, o, hosts, unions);
        w.patchField(fps[i], at);
      });
      return;
    }

    case "discunion": {
      w.u8(0x08);
      const disc = d.discriminator ?? d.disc;
      const db = enc.encode(disc);
      w.u64(db.length); w.raw(db);
      const map: Map<any, any> = (s as any).discMap?.() ?? d.optionsMap;
      // ambiguous slots hold null — no option can claim that value, so the
      // compiled table just omits them and lookup falls to the no-match path
      const entries = [...map.entries()].filter(([, o]) => o != null);
      w.u64(entries.length);
      const fps: number[] = [];
      for (const [k] of entries) {
        const kb = enc.encode(k);
        w.u64(kb.length); w.raw(kb);
        fps.push(w.field());
      }
      entries.forEach(([, o], i) => {
        const at = w.pos;
        emit(w, o as SchemaLike, hosts, unions);
        w.patchField(fps[i], at);
      });
      return;
    }

    case "literal": {
      const vals: any[] | undefined = d.values ?? (Array.isArray(d.value) ? d.value : undefined);
      if (vals && vals.length > 1) {
        // multi-value literal = closed enum-like set. all-string members join
        // the enum node (single invalid_value issue); mixed members emit a
        // union of single literals — membership stays correct, ZodLiteral._run
        // still gives the right issue shape when run at TS level
        if (vals.some((v: any) => typeof v !== "string")) {
          const opts = vals.map((v: any) => ({
            _def: { type: "literal", value: v },
            _run: (x: any) => x === v
              ? { ok: true as const, value: x }
              : { ok: false as const, issues: [{ code: "invalid_value", values: [v], path: [], message: `Invalid input: expected ${JSON.stringify(v)}` }] },
          }));
          emit(w, { _def: { type: "union", options: opts } } as any, hosts, unions);
          return;
        }
        w.u8(0x0a);
        w.u64(vals.length);
        for (const v of vals) {
          const b = enc.encode(v);
          w.u64(b.length); w.raw(b);
        }
        return;
      }
      w.u8(0x09);
      w.raw(encodeValue(vals ? vals[0] : d.value, hosts));
      return;
    }

    case "enum":
      // string members only — mixed-type enums (native numeric enums) throw so
      // containers fall back to ZodEnum's TS-level _run with correct semantics
      if (d.values.some((v: any) => typeof v !== "string"))
        throw new Error(`asmzod: cannot compile schema type ${d.type}`);
      w.u8(0x0a);
      w.u64(d.values.length);
      for (const v of d.values) {
        const b = enc.encode(v);
        w.u64(b.length); w.raw(b);
      }
      return;

    case "exactOptional":
      // transparent: parses inner directly; only object fields treat it
      // specially (absent ok, explicit undefined rejected)
      emit(w, d.inner, hosts, unions);
      return;

    case "optional":
      // a defaulted inner substitutes its own value for undefined, making
      // the optional wrapper semantically transparent — emit it directly
      if (d.inner?._zod?.optin === "defaulted") { emit(w, d.inner, hosts, unions); return; }
      w.u8(0x0b);
      {
        const fp = w.field();
        const at = w.pos;
        emit(w, d.inner, hosts, unions);
        w.patchField(fp, at);
        return;
      }
    case "nullable": case "nonoptional": {
      w.u8(d.type === "nullable" ? 0x0c : 0x23);
      const f = w.field();
      const at = w.pos;
      emit(w, d.inner, hosts, unions);
      w.patchField(f, at);
      return;
    }

    case "default": case "catch": {
      w.u8(d.type === "default" ? 0x0d : 0x0e);
      const f = w.field();
      w.raw(encodeValue(d.value, hosts));
      const at = w.pos;
      emit(w, d.inner, hosts, unions);
      w.patchField(f, at);
      return;
    }

    case "refine": {
      w.u8(0x0f);
      const f = w.field();
      w.u64(d.cbid);
      checkMsg(w, d.message);
      const at = w.pos;
      emit(w, d.inner, hosts, unions);
      w.patchField(f, at);
      return;
    }

    case "transform": {
      w.u8(0x10);
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
      w.u8(0x11);
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
      w.u8(0x12);
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
      w.u8(0x13);
      w.u64(d.items.length);
      const fps = d.items.map(() => w.field());
      const rf = w.field();
      // optinStart/optoutStart via the _zod ladder — wrappers propagate
      const omittable = (s: SchemaLike): boolean => (s as any)._zod?.optin !== undefined;
      let minItems = d.items.length;
      while (minItems > 0 && omittable(d.items[minItems - 1])) minItems--;
      w.u64(BigInt(minItems));
      const optoutOptional = (s: SchemaLike): boolean => (s as any)._zod?.optout === "optional";
      let optoutStart = d.items.length;
      while (optoutStart > 0 && optoutOptional(d.items[optoutStart - 1])) optoutStart--;
      w.u64(BigInt(optoutStart));
      d.items.forEach((it: SchemaLike, i: number) => {
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
      w.u8(0x14);
      const fk = w.field(), fv = w.field();
      if (d.keyType) {
        const at = w.pos;
        emit(w, d.keyType, hosts, unions);
        w.patchField(fk, at);
      }
      const at = w.pos;
      emit(w, d.valueType, hosts, unions);
      w.patchField(fv, at);
      return;
    }

    case "map": {
      w.u8(0x24);
      const fk = w.field(), fv = w.field();
      const kat = w.pos;
      emit(w, d.keyType, hosts, unions);
      w.patchField(fk, kat);
      const vat = w.pos;
      emit(w, d.valueType, hosts, unions);
      w.patchField(fv, vat);
      return;
    }

    case "set": {
      w.u8(0x25);
      const fv = w.field();
      const at = w.pos;
      emit(w, d.valueType, hosts, unions);
      w.patchField(fv, at);
      return;
    }

    case "any": case "unknown": w.u8(0x15); return;
    case "never": w.u8(0x16); return;
    case "null": w.u8(0x17); return;
    case "undefined": case "void": w.u8(0x18); return;
    case "nan": w.u8(0x19); return;

    case "lazy": {
      w.u8(0x1a);
      // one thunk per getter — recursive schemas must map to ONE cbid so
      // the N-API lazytab resolves the subschema to a stable blob ptr
      let th = lazyThunks.get(d.getter);
      if (!th) {
        let blob: Uint8Array | null = null;
        const getter = d.getter;
        th = () => (blob ??= compile(getter()).blob);
        lazyThunks.set(d.getter, th);
      }
      w.u64(regId(reg.lazy, th));
      return;
    }

    case "instof": {
      w.u8(0x1b);
      w.u64(regId(reg.ctor, d.ctor));
      const nb = enc.encode(d.name);
      w.u64(nb.length); w.raw(nb);
      return;
    }

    case "coerce_str": case "coerce_num": case "coerce_bool": case "coerce_bigint": {
      const op = ({ coerce_str: 0x1c, coerce_num: 0x1d, coerce_bool: 0x1e, coerce_bigint: 0x1f } as Record<string, number>)[d.type]!;
      w.u8(op);
      const f = w.field();
      const at = w.pos;
      emit(w, d.inner, hosts, unions);
      w.patchField(f, at);
      return;
    }

    case "date": {
      w.u8(0x20);
      w.u8(d.checks.length);
      for (const c of d.checks) {
        w.u8(c.kind === "min" ? 0x01 : 0x02);
        checkMsg(w, c.message);
        w.f64(c.value);
      }
      return;
    }

    case "symbol": w.u8(0x21); return;

    case "custom": {
      w.u8(0x22);
      w.u64(d.cbid);
      checkMsg(w, d.message);
      return;
    }

    default:
      throw new Error(`asmzod: cannot compile schema type ${d.type}`);
  }
}
