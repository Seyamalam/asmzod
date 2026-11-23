// smoke test: drive az_parse directly with hand-built buffers
import { dlopen, ptr, toArrayBuffer, read } from "bun:ffi";

const lib = dlopen(new URL("../asm/libasmzod.dylib", import.meta.url).pathname, {
  az_parse: {
    args: ["pointer", "pointer", "pointer", "u64", "pointer", "u64", "pointer"],
    returns: "i64",
  },
  az_version: { args: [], returns: "u32" },
});

console.log("az_version:", lib.symbols.az_version());

const enc = new TextEncoder();
const dec = new TextDecoder();
function u64(v: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function strValue(s: string): Uint8Array {
  return concat(new Uint8Array([4]), u64(s.length), enc.encode(s));
}
function numValue(n: number): Uint8Array {
  const b = new Uint8Array(9);
  b[0] = 3;
  new DataView(b.buffer).setFloat64(1, n, true);
  return b;
}

const OUTV_CAP = 1 << 20, OUTE_CAP = 1 << 20;
const outv = new ArrayBuffer(OUTV_CAP);
const oute = new ArrayBuffer(OUTE_CAP);
const outvAddr = ptr(outv);
const cbtab = new ArrayBuffer(32);

// read u64 at absolute address
function rd64(p: number): bigint {
  return read.u64(p) as bigint;
}
// view n bytes at absolute address
function view(p: number, n: number): Uint8Array {
  return new Uint8Array(toArrayBuffer(p, 0, n));
}

// decode tagged value at absolute ptr -> [jsval, nextptr]
function decodeVal(p: number): [any, number] {
  const tag = read.u8(p);
  switch (tag) {
    case 0: return [undefined, p + 1];
    case 1: return [null, p + 1];
    case 2: return [read.u8(p + 1) !== 0, p + 2];
    case 3: return [read.f64(p + 1), p + 9];
    case 4: {
      const n = Number(rd64(p + 1));
      return [dec.decode(view(p + 9, n)), p + 9 + n];
    }
    case 5: return [read.i64(p + 1), p + 9];
    case 6: {
      const nf = Number(rd64(p + 1));
      let cur = p + 9;
      const obj: any = {};
      for (let i = 0; i < nf; i++) {
        const kl = Number(rd64(cur));
        const k = dec.decode(view(cur + 8, kl));
        const [v, np] = decodeVal(cur + 8 + kl);
        obj[k] = v;
        cur = np;
      }
      return [obj, cur];
    }
    case 7: {
      const n = Number(rd64(p + 1));
      let cur = p + 9;
      const arr: any[] = [];
      for (let i = 0; i < n; i++) {
        const [v, np] = decodeVal(cur);
        arr.push(v);
        cur = np;
      }
      return [arr, cur];
    }
    default: throw new Error("bad tag " + tag);
  }
}

function run(node: Uint8Array, input: Uint8Array) {
  const status = lib.symbols.az_parse(
    ptr(node), ptr(input),
    outvAddr, BigInt(OUTV_CAP),
    ptr(oute), BigInt(OUTE_CAP),
    ptr(cbtab),
  ) as bigint;
  const result: any = { status: Number(status) };
  if (status === 0n) {
    const op = Number(rd64(outvAddr));
    const ol = Number(rd64(outvAddr + 8));
    result.value = decodeVal(op)[0];
  } else if (status === -2n) {
    const cnt = Number(rd64(ptr(oute)));
    const issues: any[] = [];
    let cur = ptr(oute) + 3104;
    for (let i = 0; i < cnt; i++) {
      const [v, np] = decodeVal(cur);
      issues.push(v);
      cur = np;
    }
    result.issues = issues;
  }
  return result;
}

// test 1: string schema accepts string
const strNode = new Uint8Array([0x01, 0x00]);
console.log("string ok:", JSON.stringify(run(strNode, strValue("hello"))));

// test 2: number schema rejects string
const numNode = new Uint8Array([0x02]);
console.log("number vs string:", JSON.stringify(run(numNode, strValue("hello"))));

// test 3: number schema accepts number
console.log("number ok:", JSON.stringify(run(numNode, numValue(3.14))));

// test 4: object {a: string}
const objNode = concat(
  new Uint8Array([0x05, 0x00]),
  u64(0), u64(1),
  u64(1), enc.encode("a"),
  u64(0),
);
const objWithChild = concat(objNode, strNode);
new DataView(objWithChild.buffer).setBigUint64(27, 8n, true);

const objInput = concat(
  new Uint8Array([6]), u64(1),
  u64(1), enc.encode("a"), strValue("world"),
);
console.log("object ok:", JSON.stringify(run(objWithChild, objInput)));

// test 5: object wrong field type
console.log("object bad:", JSON.stringify(run(objWithChild, concat(
  new Uint8Array([6]), u64(1),
  u64(1), enc.encode("a"), numValue(42),
))));

// test 6: array of number
const arrNode = concat(
  new Uint8Array([0x06]),
  u64(9),          // elem off: field at byte1, child at byte9 -> rel 8? placeholder
  u64(0),          // min
  u64(0xffffffffffffffffn), // max absent
);
new DataView(arrNode.buffer).setBigUint64(1, 24n, true); // field at +1, child at +25 -> rel 24
const arrWithChild = concat(arrNode, numNode);
const arrInput = concat(new Uint8Array([7]), u64(3), numValue(1), numValue(2), numValue(3));
console.log("array ok:", JSON.stringify(run(arrWithChild, arrInput)));
const arrBad = concat(new Uint8Array([7]), u64(3), numValue(1), strValue("x"), numValue(3));
console.log("array bad:", JSON.stringify(run(arrWithChild, arrBad)));
