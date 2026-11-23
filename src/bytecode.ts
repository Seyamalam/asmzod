// bytecode.ts — schema -> engine blob compiler (see FORMAT.md)
import { BW, u64, str, encodeValue, type HostTable } from "./codec.ts";
import { reg, regId } from "./ffi.ts";

export interface Compiled {
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
};

const NUM_CHECK: Record<string, number> = {
  gt: 0x01, gte: 0x02, min: 0x02, lt: 0x03, lte: 0x04, max: 0x04,
  int: 0x05, finite: 0x06, multipleOf: 0x07, safeInt: 0x08,
};

export function compile(schema: SchemaLike): Compiled {
  const w = new BW();
  const hosts: HostTable = [];
  const unions: SchemaLike[] = [];
  emit(w, schema, hosts, unions);
  return { blob: w.out(), hosts, unions };
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
        w.u64(regId(reg.regex, c.regex));
        // embed /src/flags so the engine can emit zod's `pattern` issue field
        const src = enc.encode(`/${c.regex.source}/${c.regex.flags}`);
        w.u64(src.length); w.raw(src); break;
      }
      default: break; // no params
    }
  }
}

function emitNumChecks(w: BW, checks: any[], isBig: boolean) {
  w.u8(checks.length);
  for (const c of checks) {
    const code = NUM_CHECK[c.kind];
    if (code === undefined) throw new Error(`asmzod: unsupported number check ${c.kind}`);
    w.u8(code);
    checkMsg(w, c.message);
    if (c.kind === "gt" || c.kind === "gte" || c.kind === "min" ||
        c.kind === "lt" || c.kind === "lte" || c.kind === "max" ||
        c.kind === "multipleOf") {
      if (isBig) w.i64(BigInt(c.value)); else w.f64(c.value);
    }
  }
}

function emit(w: BW, s: SchemaLike, hosts: HostTable, unions: SchemaLike[]): void {
  const d = s._def;
  switch (d.type) {
    case "string": w.u8(0x01); emitStrChecks(w, d.checks); return;
    case "number": w.u8(0x02); emitNumChecks(w, d.checks, false); return;
    case "boolean": w.u8(0x03); return;
    case "bigint": w.u8(0x04); emitNumChecks(w, d.checks, true); return;

    case "object": {
      w.u8(0x05);
      w.u8(d.mode === "strict" ? 1 : d.mode === "passthrough" ? 2 : 0);
      const cf = w.field();
      const keys = Object.keys(d.shape);
      w.u64(keys.length);
      const fps: number[] = [];
      for (const k of keys) {
        const kb = enc.encode(k);
        w.u64(kb.length); w.raw(kb);
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
      const db = enc.encode(d.disc);
      w.u64(db.length); w.raw(db);
      const entries = [...d.optionsMap.entries()];
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

    case "literal":
      w.u8(0x09);
      w.raw(encodeValue(d.value, hosts));
      return;

    case "enum":
      w.u8(0x0a);
      w.u64(d.values.length);
      for (const v of d.values) {
        const b = enc.encode(v);
        w.u64(b.length); w.raw(b);
      }
      return;

    case "optional": case "nullable": case "nonoptional": {
      w.u8(d.type === "optional" ? 0x0b : d.type === "nullable" ? 0x0c : 0x23);
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
      // optinStart: trailing items that can be absent in input. Omittable =
      // optional/default/prefault/catch; transparent wrappers propagate;
      // pipe truncates (its optin is its own).
      const omittable = (s: SchemaLike): boolean => {
        const d = (s as any)._def;
        switch (d?.type) {
          case "optional": case "default": case "prefault": case "catch": return true;
          case "nullable": case "readonly": case "refine": case "brand": case "transform":
            return omittable(d.inner ?? d.innerType ?? d.in);
          case "union": return (d.options as SchemaLike[]).some(omittable);
          default: return false;
        }
      };
      let minItems = d.items.length;
      while (minItems > 0 && omittable(d.items[minItems - 1])) minItems--;
      w.u64(BigInt(minItems));
      // optoutStart: trailing items whose output may be absent — optional and
      // transparent wrappers; everything else truncates the count there
      const optoutOptional = (s: SchemaLike): boolean => {
        const d = (s as any)._def;
        switch (d?.type) {
          case "optional": return true;
          case "nullable": case "readonly": case "refine": case "brand":
          case "transform": case "catch":
            return optoutOptional(d.inner ?? d.innerType ?? d.in);
          case "pipe": return optoutOptional(d.out ?? d.inner ?? d.in);
          default: return false;
        }
      };
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

    case "any": case "unknown": w.u8(0x15); return;
    case "never": w.u8(0x16); return;
    case "null": w.u8(0x17); return;
    case "undefined": case "void": w.u8(0x18); return;
    case "nan": w.u8(0x19); return;

    case "lazy": {
      w.u8(0x1a);
      let blob: Uint8Array | null = null;
      const getter = d.getter;
      const cbid = regId(reg.lazy, () => (blob ??= compile(getter()).blob));
      w.u64(cbid);
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
      const op = { coerce_str: 0x1c, coerce_num: 0x1d, coerce_bool: 0x1e, coerce_bigint: 0x1f }[d.type]!;
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
