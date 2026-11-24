// bench/realworld.ts — realistic payloads vs zod
import { z } from "../src/index";

const Z: any = process.argv.includes("--v3")
  ? (await import("zod/v3")).z
  : await import("zod");

let sink: unknown = null;
function bench(fn: () => unknown, iters: number): number {
  for (let w = 0; w < 8; w++) sink = fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) sink = fn();
  return ((performance.now() - t0) * 1000) / iters;
}

// tsconfig-shaped object
const TsConfig = z.object({
  compilerOptions: z.object({
    target: z.string().optional(),
    strict: z.boolean().optional(),
    paths: z.record(z.string(), z.array(z.string())).optional(),
  }).optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});
const tsconfig = { compilerOptions: { target: "es2022", strict: true, paths: { "~/*": ["./src/*"] } }, include: ["src"], exclude: ["node_modules"] };

// GeoJSON-shaped FeatureCollection
const GeoJSON = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.object({
    type: z.literal("Feature"),
    geometry: z.object({ type: z.string(), coordinates: z.array(z.any()) }),
    properties: z.record(z.string(), z.unknown()),
  })),
});
const geo = { type: "FeatureCollection", features: Array.from({ length: 50 }, (_, i) => ({
  type: "Feature", geometry: { type: "Point", coordinates: [i * 0.1, i * -0.1] }, properties: { id: i, name: `p${i}` },
})) };

// package-lock-shaped object
const PkgLock = z.object({
  name: z.string(), lockfileVersion: z.number(),
  packages: z.record(z.string(), z.object({
    version: z.string(), resolved: z.string().optional(), integrity: z.string().optional(),
    dev: z.boolean().optional(), dependencies: z.record(z.string(), z.string()).optional(),
  }).partial()),
});
const lock = { name: "x", lockfileVersion: 3, packages: Object.fromEntries(
  Array.from({ length: 100 }, (_, i) => [`node_modules/dep${i}`, { version: `1.${i}.0`, dev: i % 2 === 0, dependencies: { a: "^1.0.0" } }])) };

console.log("            asmzod   zod     ratio");
for (const [label, schema, data, iters] of [
  ["tsconfig", TsConfig, tsconfig, 20000],
  ["geojson", GeoJSON, geo, 3000],
  ["pkg-lock", PkgLock, lock, 3000],
] as const) {
  const a = bench(() => (schema as any).safeParse(data), iters);
  // build the equivalent zod schema inline (same shapes, zod factories)
  const b = bench(() => zodEquiv(label).safeParse(data), iters);
  console.log(`${label.padEnd(10)} ${a.toFixed(2)}µs  ${b.toFixed(2)}µs  ${(a / b).toFixed(2)}x`);
}

function zodEquiv(label: string): any {
  if (label === "tsconfig") return Z.object({
    compilerOptions: Z.object({
      target: Z.string().optional(), strict: Z.boolean().optional(),
      paths: Z.record(Z.string(), Z.array(Z.string())).optional(),
    }).optional(),
    include: Z.array(Z.string()).optional(), exclude: Z.array(Z.string()).optional(),
  });
  if (label === "geojson") return Z.object({
    type: Z.literal("FeatureCollection"),
    features: Z.array(Z.object({
      type: Z.literal("Feature"),
      geometry: Z.object({ type: Z.string(), coordinates: Z.array(Z.any()) }),
      properties: Z.record(Z.string(), Z.unknown()),
    })),
  });
  return Z.object({
    name: Z.string(), lockfileVersion: Z.number(),
    packages: Z.record(Z.string(), Z.object({
      version: Z.string(), resolved: Z.string().optional(), integrity: Z.string().optional(),
      dev: Z.boolean().optional(), dependencies: Z.record(Z.string(), Z.string()).optional(),
    }).partial()),
  });
}
