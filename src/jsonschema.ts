// jsonschema.ts — z.toJSONSchema parity (draft 2020-12). Core coverage:
// primitives + checks, object/array/tuple/record, union/enum/literal,
// wrappers. bigint/date/map/set/function throw like zod.
type JSONSchema = Record<string, unknown>;

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const SAFE_INT_MIN = -9007199254740991;
const SAFE_INT_MAX = 9007199254740991;

// zod's own patterns for the formats where it emits one
const FORMAT_PATTERN: Record<string, string> = {
  email: "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
  uuid: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
};
const FORMAT_FORMAT: Record<string, string> = {
  email: "email", uuid: "uuid", url: "uri", ipv4: "ipv4", ipv6: "ipv6",
  datetime: "date-time", date: "date", time: "time", duration: "duration",
};

const UNREPRESENTABLE = new Set([
  "bigint", "date", "map", "set", "symbol", "function", "promise",
]);

function inner(d: any): any {
  return d.inner ?? d.innerType ?? d.in ?? d.element;
}

function isOmittable(d: any): boolean {
  const t = d?.type;
  if (t === "optional" || t === "default" || t === "prefault" || t === "catch") return true;
  if (t === "nullable" || t === "readonly" || t === "refine" || t === "brand" || t === "transform")
    return isOmittable(inner(d));
  if (t === "union") return (d.options as any[]).some((o) => isOmittable((o as any)._def));
  return false;
}

function applyChecks(js: JSONSchema, d: any, isString: boolean, isNum: boolean): void {
  for (const c of (d.checks as any[] | undefined) ?? []) {
    const k = c.kind;
    switch (k) {
      case "min":
        if (isString) js.minLength = c.value;
        break;
      case "max":
        if (isString) js.maxLength = c.value;
        break;
      case "gte":
        if (isNum) js.minimum = c.value;
        break;
      case "lte":
        if (isNum) js.maximum = c.value;
        break;
      case "gt": if (isNum) js.exclusiveMinimum = c.value; break;
      case "lt": if (isNum) js.exclusiveMaximum = c.value; break;
      case "length":
        if (isString) { js.minLength = c.value; js.maxLength = c.value; }
        break;
      case "multipleOf":
        if (isNum) js.multipleOf = c.value;
        break;
      default: {
        const fmt = FORMAT_FORMAT[k];
        if (fmt && isString) {
          js.format = fmt;
          const pat = FORMAT_PATTERN[k];
          if (pat) js.pattern = pat;
        }
        break;
      }
    }
  }
}

function toSchema(d: any): JSONSchema {
  const regId = ctx.idMap?.get(d);
  if (regId !== undefined) {
    if (!ctx.emitted!.has(regId)) {
      ctx.emitted!.add(regId);
      ctx.defs![regId] = toSchema(d);
    }
    return { $ref: `#/$defs/${regId}` } as any;
  }
  const t = d.type;
  if (UNREPRESENTABLE.has(t)) {
    if (ctx.unrepresentable === "any") return {};
    throw new Error(`${t[0].toUpperCase()}${t.slice(1)} cannot be represented in JSON Schema`);
  }
  switch (t) {
    case "string": {
      const js: JSONSchema = { type: "string" };
      applyChecks(js, d, true, false);
      return js;
    }
    case "number": {
      const isInt = (d.checks as any[] | undefined)?.some((c) => c.kind === "int") ?? false;
      const js: JSONSchema = { type: isInt ? "integer" : "number" };
      applyChecks(js, d, false, true);
      if (isInt) {
        if (js.minimum === undefined) js.minimum = SAFE_INT_MIN;
        if (js.maximum === undefined) js.maximum = SAFE_INT_MAX;
      }
      return js;
    }
    case "boolean": return { type: "boolean" };
    case "null": return { type: "null" };
    case "nan": case "never": return { not: {} };
    case "any": case "unknown": return {};
    case "undefined": case "void": return { not: {} };
    case "object": {
      const js: JSONSchema = { type: "object" };
      const shape = (d.shape ?? {}) as Record<string, any>;
      if (Object.getOwnPropertySymbols(shape).length) {
        if (ctx.unrepresentable !== "any")
          throw new Error("Symbol keys cannot be represented in JSON Schema");
      }
      const props: Record<string, JSONSchema> = {};
      const req: string[] = [];
      for (const [k, s] of Object.entries(shape)) {
        props[k] = toSchema((s as any)._def);
        if (!isOmittable((s as any)._def)) req.push(k);
      }
      js.properties = props;
      if (req.length) js.required = req;
      const mode = d.mode ?? "strip";
      if (mode === "strip" || mode === "strict") js.additionalProperties = false;
      else if (mode === "passthrough") js.additionalProperties = {};
      else if (d.catchall?._def) js.additionalProperties = toSchema(d.catchall._def);
      return js;
    }
    case "array": {
      // zod orders constraint keys before "type"
      const js: JSONSchema = {};
      if (d.minLen !== undefined) js.minItems = d.minLen;
      if (d.maxLen !== undefined) js.maxItems = d.maxLen;
      js.type = "array";
      js.items = toSchema(inner(d)._def);
      return js;
    }
    case "tuple": {
      const items = (d.items as any[]).map((it) => toSchema(it._def));
      const js: JSONSchema = {
        type: "array",
        prefixItems: items,
        items: d.rest ? toSchema((d.rest as any)._def) : false,
        minItems: items.length,
      };
      if (!d.rest) js.maxItems = items.length;
      return js;
    }
    case "record": {
      const js: JSONSchema = { type: "object" };
      if (d.keyType) js.propertyNames = toSchema(d.keyType._def);
      js.additionalProperties = toSchema(d.valueType._def);
      return js;
    }
    case "union": case "discunion": case "discriminated_union": {
      const rawOpts = d.options ?? (d.optionsMap instanceof Map ? [...d.optionsMap.values()] : []);
      const opts = (rawOpts as any[]).map((o) => toSchema(o._def));
      if (opts.every((o) => Object.keys(o).length === 1 && typeof o.type === "string")) {
        return { type: opts.map((o) => o.type as string) };
      }
      return { [t === "union" ? "anyOf" : "oneOf"]: opts };
    }
    case "enum": {
      const vals: any[] = d.values ?? Object.values(d.entries ?? {});
      if (vals.length === 0) return { not: {} };
      return { type: "string", enum: vals };
    }
    case "literal": {
      const vals: any[] | undefined = d.values ?? (Array.isArray(d.value) ? d.value : undefined);
      if (vals && vals.length === 0) return { not: {} };
      const v = d.value;
      const ty = v === null ? "null" : typeof v === "bigint" ? "string" : typeof v;
      return { type: ty, const: typeof v === "bigint" ? v.toString() : v };
    }
    case "optional":
      return toSchema(inner(d)._def);
    case "nullable": {
      const js = toSchema(inner(d)._def);
      if (typeof js.type === "string") return { ...js, type: [js.type, "null"] };
      if (Array.isArray(js.type)) return { ...js, type: [...(js.type as string[]), "null"] };
      return { anyOf: [js, { type: "null" }] };
    }
    case "default": case "prefault": {
      const js = toSchema(inner(d)._def);
      const dv = typeof d.value === "function" ? d.value() : d.value;
      return { default: dv, ...js };
    }
    case "catch": case "refine": case "brand": case "readonly":
    case "coerce_str": case "coerce_num": case "coerce_bool": case "coerce_bigint":
      return toSchema(inner(d)._def);
    case "transform":
      return toSchema(inner(d)._def);
    case "pipe":
      return toSchema((d.out ?? d.inner ?? d.in)._def);
    case "intersect":
      return { allOf: [toSchema((d.left as any)._def), toSchema((d.right as any)._def)] };
    case "lazy": {
      // recursion guard — a self-referencing lazy emits {} on revisit
      if (ctx.seen?.has(d)) return {};
      (ctx.seen ??= new Set()).add(d);
      try { return toSchema((d.getter as () => { _def: any })()._def); }
      finally { ctx.seen.delete(d); }
    }
    // zod processes promise/instanceof as a ref to the inner schema
    case "instof": case "promise":
      return d.inner || d.innerType ? toSchema((d.inner ?? d.innerType)._def) : { type: "object" };
    case "file": {
      const js: JSONSchema = { type: "string", format: "binary", contentEncoding: "binary" };
      const checks = d.checks ?? [];
      const mime = checks.filter((c: any) => c.kind === "mime").map((c: any) => c.value);
      const minC = checks.find((c: any) => c.kind === "min" || c.kind === "minSize");
      const maxC = checks.find((c: any) => c.kind === "max" || c.kind === "maxSize");
      if (minC) js.minLength = minC.value;
      if (maxC) js.maxLength = maxC.value;
      if (mime.length === 1) js.contentMediaType = mime[0];
      else if (mime.length > 1) js.anyOf = mime.map((m: string) => ({ contentMediaType: m }));
      return js;
    }
    case "nonopt": case "nonoptional":
      return toSchema(inner(d)._def);
    default:
      throw new Error(`asmzod: toJSONSchema does not know schema type ${t}`);
  }
}

export function toJSONSchema(schema: { _def: any }, params?: { unrepresentable?: string; metadata?: any }): JSONSchema {
  const prev = ctx.unrepresentable;
  const prevIds = ctx.idMap, prevDefs = ctx.defs, prevEmitted = ctx.emitted;
  if (params?.metadata) {
    const { byDef } = _collectIds(schema, params.metadata);
    ctx.idMap = byDef; ctx.defs = {}; ctx.emitted = new Set();
  }
  ctx.unrepresentable = params?.unrepresentable;
  try {
    const out = toSchema(schema._def);
    if (ctx.defs && Object.keys(ctx.defs).length) (out as any).$defs = ctx.defs;
    return { $schema: DRAFT, ...out };
  }
  finally {
    ctx.unrepresentable = prev;
    ctx.idMap = prevIds; ctx.defs = prevDefs; ctx.emitted = prevEmitted;
  }
}
const ctx: { unrepresentable?: string; seen?: Set<any>; idMap?: Map<any, string>; defs?: Record<string, JSONSchema>; emitted?: Set<string> } = {};

function _collectIds(root: any, reg: any): { byDef: Map<any, string> } {
  const byDef = new Map<any, string>();
  const byId = new Map<string, any>();
  const seen = new Set<any>();
  const visit = (s: any): void => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    const id = reg.get?.(s)?.id;
    if (id !== undefined) {
      const prev = byId.get(id);
      if (prev !== undefined && prev !== s)
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      byId.set(id, s);
      byDef.set(s._def ?? s.def, id);
    }
    const def = (s as any)._def ?? (s as any).def;
    if (!def || typeof def !== "object") return;
    for (const v of Object.values(def)) {
      if ((v as any)?._def || (v as any)?.def) { visit(v); continue; }
      if (Array.isArray(v)) { for (const e of v) if (e?._def || e?.def) visit(e); continue; }
      if (v && typeof v === "object")
        for (const e of Object.values(v)) if (e?._def || e?.def) visit(e);
    }
  };
  visit(root);
  return { byDef };
}
