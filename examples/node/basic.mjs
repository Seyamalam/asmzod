// examples/node/basic.mjs — run: node examples/node/basic.mjs
import { z } from "../../dist/index.js"; // or "asmzod" when installed

const User = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  age: z.number().int().min(0).optional(),
  tags: z.array(z.string()),
});

const good = { id: "123e4567-e89b-42d3-a456-426614174000", name: "ada", tags: ["a", "b"] };
const bad = { id: "nope", name: "", tags: "not-array" };

console.log("ok:", User.safeParse(good).success);
const r = User.safeParse(bad);
if (!r.success) console.log(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
