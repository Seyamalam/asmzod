// Simulates the worker fetch path in any runtime (bun/node/deno).
import worker from "./worker.ts";
const good = new Request("http://x/", { method: "POST", body: JSON.stringify({ name: "a", email: "a@b.com" }) });
const bad = new Request("http://x/", { method: "POST", body: JSON.stringify({ name: "", email: "no" }) });
console.log(await (await worker.fetch(good)).json());
console.log((await (await worker.fetch(bad)).json()).issues.map((i: any) => i.code + "@" + i.path));
