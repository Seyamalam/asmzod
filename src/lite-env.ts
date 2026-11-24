// evaluated before index.ts via lite.ts's import order — forces the
// portable engine even where a native addon could load
const p = (globalThis as any).process;
if (p) { p.env = { ...p.env, AZ_ENGINE: "portable" }; }
export {};
