// compare.ts — run one schema+input through napi, ffi, portable and zod,
// side by side. usage: bun scripts/compare.ts '<schema-expr>' '<json-input>'
//   bun scripts/compare.ts 'z.string().min(2)' '"x"'
//   bun scripts/compare.ts 'z.object({a: z.number()})' '{"a":"no"}'
import { z } from "../src/index.ts";
import * as Z from "zod";
import * as napiBackend from "../src/native/napi.ts";
import { engineParse, portableEngineParse } from "../src/ffi.ts";
import { encodeValue } from "../src/codec.ts";

const [schemaExpr = "z.string()", inputExpr = '"x"'] = process.argv.slice(2);
const input = JSON.parse(inputExpr);

const mk = new Function("z", `return ${schemaExpr}`);
const az = mk(z);
const zz = mk(Z.z ?? Z);

const show = (r: unknown) => JSON.stringify(r, (k, v) => typeof v === "bigint" ? `${v}n` : v instanceof Map ? ["~map", [...v]] : v instanceof Set ? ["~set", [...v]] : v);
const c = (az as any)._compile();

console.log("schema:", schemaExpr);
console.log("input: ", inputExpr);
console.log();
console.log("zod   :", show((zz as any).safeParse(input)));
console.log("napi  :", show(napiBackend.parse(c.blob, input, c.hosts, c.cbUnsafe)));
const h1 = [...c.hosts];
console.log("ffi   :", show(engineParse(c.blob, encodeValue(input, h1), h1)));
const h2 = [...c.hosts];
console.log("port  :", show(portableEngineParse(c.blob, encodeValue(input, h2), h2)));
