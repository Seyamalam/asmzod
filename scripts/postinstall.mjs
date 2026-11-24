// postinstall: build the native engine if a toolchain exists.
// Ships prebuilt artifacts in the package, so this is a best-effort
// refresh for source installs — silent success when clang/make are absent.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const asm = join(root, "asm");
const want = process.platform === "darwin"
  ? ["asmzod.node", "libasmzod.dylib"]
  : ["asmzod.node", "libasmzod.so"];

if (existsSync(asm) && want.some(f => !existsSync(join(asm, f)))) {
  try {
    execFileSync("make", ["-C", asm], { stdio: "ignore" });
  } catch {
    // no toolchain — portable engine covers this runtime
  }
}
