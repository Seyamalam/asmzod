// flake.ts — run bun test N times, report tests that flip pass<->fail.
// usage: bun scripts/flake.ts [N]
import { $ } from "bun";

const N = Number(process.argv[2] ?? 5);
const seen = new Map<string, { pass: number; fail: number }>();

for (let i = 0; i < N; i++) {
  const out = await $`bun test 2>&1`.text();
  for (const line of out.split("\n")) {
    const m = line.match(/^\((pass|fail)\) (.+?)(?: \[[\d.]+ms\])?$/);
    if (!m) continue;
    const key = m[2]!;
    const e = seen.get(key) ?? { pass: 0, fail: 0 };
    if (m[1] === "pass") e.pass++; else e.fail++;
    seen.set(key, e);
  }
  console.error(`run ${i + 1}/${N} done`);
}

const flaky = [...seen.entries()].filter(([, e]) => e.pass > 0 && e.fail > 0);
if (flaky.length) {
  console.log("flaky tests:");
  for (const [k, e] of flaky) console.log(`  ${k}: ${e.pass} pass / ${e.fail} fail`);
  process.exit(1);
}
console.log(`${N} runs, ${seen.size} tests, no flakes`);
