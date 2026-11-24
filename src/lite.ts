// asmzod/lite — portable-only entry. No native probing reaches the engine:
// safe to bundle for Cloudflare Workers, browsers, and any runtime where
// binary addons can't load. Same zod-compatible API; validation runs on
// the TypeScript bytecode interpreter.
import "./lite-env.ts";
export * from "./index.ts";
