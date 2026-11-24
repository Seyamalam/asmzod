// codec.ts — tagged binary value encoding/decoding (see FORMAT.md)

const enc = new TextEncoder();
const dec = new TextDecoder();

// host values table: things that can't serialize (Date, Map, Set, class
// instances, functions, symbols) cross the boundary as tag 8 + u64 index
export type HostTable = unknown[];

export function hostIndex(hosts: HostTable, v: unknown): number {
  hosts.push(v);
  return hosts.length - 1;
}

export function encodeValue(v: unknown, hosts: HostTable): Uint8Array {
  switch (typeof v) {
    case "undefined": return u8(0);
    case "boolean": return cat(u8(2), u8(v ? 1 : 0));
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
      // beyond i64 the tagged i64 can't hold it — hostref carries the real
      // bigint so portable checks compare exactly (zod semantics)
      if (v > 9223372036854775807n || v < -9223372036854775808n)
        return cat(u8(8), u64(hostIndex(hosts, v)));
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
        const keys = Object.keys(v as object);
        const parts = [u8(6), u64(keys.length)];
        for (const k of keys) {
          const kb = enc.encode(k);
          parts.push(u64(kb.length), kb, encodeValue((v as any)[k], hosts));
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

function isPlainObject(v: object): boolean {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

// ---- readers on absolute pointers ----
// ---- memory backend: set by whichever native driver is active ----
// decodeAt/view are only used on the native path; the portable engine has
// its own byte-reader and never touches these.
export interface MemBackend {
  view(p: number, n: number): Uint8Array;
  u8(p: number): number;
  f64(p: number): number;
  i64(p: number): bigint;
  u64(p: number): bigint;
}
let mem: MemBackend | null = null;
export function setMemBackend(b: MemBackend) { mem = b; }
function need(): MemBackend {
  if (!mem) throw new Error("asmzod: no native memory backend installed");
  return mem;
}

export function view(p: number, n: number): Uint8Array {
  if (n <= 0) return new Uint8Array(0);
  return need().view(p, n);
}
export function rd64u(p: number): bigint {
  return need().u64(p);
}

// decode tagged value inside a byte buffer -> [value, nextOffset]
// used by the N-API backend, which gets its issue region as an ArrayBuffer
// rather than a pointer into pooled memory.
export function decodeValueAt(buf: Uint8Array, off: number, hosts: HostTable): [unknown, number] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return decAt(buf, dv, off, hosts);
}

// dv is threaded through — a fresh DataView per recursion level was the cost
function decAt(buf: Uint8Array, dv: DataView, off: number, hosts: HostTable): [unknown, number] {
  // u64 reads via two u32s — getBigUint64 allocates a BigInt per call
  const u64 = (o: number) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
  const tag = buf[off];
  switch (tag) {
    case 0: return [undefined, off + 1];
    case 1: return [null, off + 1];
    case 2: return [buf[off + 1] !== 0, off + 2];
    case 3: return [dv.getFloat64(off + 1, true), off + 9];
    case 4: {
      const n = u64(off + 1);
      return [dec.decode(buf.subarray(off + 9, off + 9 + n)), off + 9 + n];
    }
    case 5: return [dv.getBigInt64(off + 1, true), off + 9];
    case 6: {
      const nf = u64(off + 1);
      let cur = off + 9;
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < nf; i++) {
        const kl = u64(cur);
        const k = dec.decode(buf.subarray(cur + 8, cur + 8 + kl));
        const [v, np] = decAt(buf, dv, cur + 8 + kl, hosts);
        obj[k] = v;
        cur = np;
      }
      return [obj, cur];
    }
    case 7: {
      const n = u64(off + 1);
      let cur = off + 9;
      const arr: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const [v, np] = decAt(buf, dv, cur, hosts);
        arr.push(v);
        cur = np;
      }
      return [arr, cur];
    }
    case 8: return [hosts[u64(off + 1)], off + 9];
    default: throw new Error(`asmzod: corrupt value tag ${tag} at buf+${off}`);
  }
}

// decode tagged value at absolute ptr -> [value, nextPtr]
export function decodeAt(p: number, hosts: HostTable): [unknown, number] {
  const m = need();
  const tag = m.u8(p);
  switch (tag) {
    case 0: return [undefined, p + 1];
    case 1: return [null, p + 1];
    case 2: return [m.u8(p + 1) !== 0, p + 2];
    case 3: return [m.f64(p + 1), p + 9];
    case 4: {
      const n = Number(m.u64(p + 1));
      return [dec.decode(view(p + 9, n)), p + 9 + n];
    }
    case 5: return [m.i64(p + 1), p + 9];
    case 6: {
      const nf = Number(rd64u(p + 1));
      let cur = p + 9;
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < nf; i++) {
        const kl = Number(rd64u(cur));
        const k = dec.decode(view(cur + 8, kl));
        const [v, np] = decodeAt(cur + 8 + kl, hosts);
        obj[k] = v;
        cur = np;
      }
      return [obj, cur];
    }
    case 7: {
      const n = Number(rd64u(p + 1));
      let cur = p + 9;
      const arr: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const [v, np] = decodeAt(cur, hosts);
        arr.push(v);
        cur = np;
      }
      return [arr, cur];
    }
    case 8: return [hosts[Number(rd64u(p + 1))], p + 9];
    default: throw new Error(`asmzod: corrupt value tag ${tag} at ${p}`);
  }
}

// ---- byte writers ----
export function u8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}
export function u64(v: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
}
export function i64(v: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
  return b;
}
export function f64(v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
}
export function str(s: string): Uint8Array {
  return enc.encode(s);
}
export function cat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// growable writer for the bytecode compiler
export class BW {
  bytes: number[] = [];
  get pos() { return this.bytes.length; }
  u8(v: number) { this.bytes.push(v & 0xff); }
  raw(b: Uint8Array) { for (const x of b) this.bytes.push(x); }
  u64(v: number | bigint) { this.raw(u64(v)); }
  i64(v: number | bigint) { this.raw(i64(v)); }
  f64(v: number) { this.raw(f64(v)); }
  str(s: string) { this.raw(str(s)); }
  // reserve an i64 field, return its position for later patching
  field(): number { const p = this.bytes.length; this.raw(i64(0)); return p; }
  patchField(at: number, targetPos: number) {
    const rel = BigInt(targetPos - at);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, rel, true);
    for (let i = 0; i < 8; i++) this.bytes[at + i] = b[i];
  }
  out(): Uint8Array { return new Uint8Array(this.bytes); }
}
