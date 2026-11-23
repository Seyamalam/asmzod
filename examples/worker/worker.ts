// Cloudflare Worker running asmzod on the portable bytecode interpreter.
// No FFI, no native libs — just TS.
import { z } from "../../src/index.ts";

const User = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().gte(0).optional(),
});

export default {
  async fetch(req: Request): Promise<Response> {
    const body = await req.json().catch(() => null);
    const r = User.safeParse(body);
    return Response.json(
      r.success ? { ok: true, data: r.data } : { ok: false, issues: r.error.issues },
      { status: r.success ? 200 : 422 },
    );
  },
};
