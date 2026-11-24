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
  const t = d.type;
  if (UNREPRESENTABLE.has(t))
    throw new Error(`${t[0].toUpperCase()}${t.slice(1)} cannot be represented in JSON Schema`);
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
      return { type: "string", enum: d.values };
    }
    case "literal": {
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
      return toSchema(inner(d)._def);
    case "transform":
      return toSchema(inner(d)._def);
    case "pipe":
      return toSchema((d.out ?? d.inner ?? d.in)._def);
    case "intersect":
      return { allOf: [toSchema((d.left as any)._def), toSchema((d.right as any)._def)] };
    case "lazy":
      return toSchema((d.getter as () => { _def: any })()._def);
    case "nonopt": case "nonoptional":
      return toSchema(inner(d)._def);
    default:
      throw new Error(`asmzod: toJSONSchema does not know schema type ${t}`);
  }
}

export function toJSONSchema(schema: { _def: any }): JSONSchema {
  return { $schema: DRAFT, ...toSchema(schema._def) };
}
