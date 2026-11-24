// jsonschema.ts — zod's toJSONSchema, ported to asmzod internals.
// Tracks zod v4 core/to-json-schema.ts + json-schema-processors.ts; our
// `schema._zod` surface supplies def/parent/optin/optout/values/pattern/traits.
import { globalRegistry } from "./shared.ts";
import { ZodCodec, ZodTransform } from "./schema.ts";

type JSONSchema = Record<string, any>;

function assignProp<T extends object>(target: T, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

function assignProps<T extends object>(target: T, ...sources: object[]): T {
  for (const source of sources)
    for (const key of Reflect.ownKeys(source))
      if (Object.prototype.propertyIsEnumerable.call(source, key))
        assignProp(target, key, (source as any)[key]);
  return target;
}

type Processor = (schema: any, ctx: ToJSONSchemaContext, json: JSONSchema, params: ProcessParams) => void;

export interface ProcessParams {
  schemaPath: any[];
  path: (string | number)[];
}

export interface Seen {
  schema: JSONSchema;
  def?: JSONSchema;
  defId?: string;
  count: number;
  cycle?: (string | number)[];
  isParent?: boolean;
  ref?: any;
  path?: (string | number)[];
}

export interface ToJSONSchemaContext {
  processors: Record<string, Processor>;
  metadataRegistry: any;
  target: string;
  unrepresentable: any;
  override: (ctx: { zodSchema: any; jsonSchema: JSONSchema; path: (string | number)[] }) => void;
  io: "input" | "output";
  counter: number;
  seen: Map<any, Seen>;
  sharedDefsExtractedFor?: any;
  sharedEmitDoneFor?: any;
  cycles: "ref" | "throw";
  reused: "ref" | "inline";
  intersections: JSONSchema[][];
  deferred: (() => void)[];
  external?: { registry: any; uri?: (id: string) => string; defs: Record<string, JSONSchema> };
}

export function initializeContext(params: any): ToJSONSchemaContext {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4") target = "draft-04";
  if (target === "draft-7") target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {}),
    io: params?.io ?? "output",
    counter: 0,
    seen: new Map(),
    sharedDefsExtractedFor: undefined,
    sharedEmitDoneFor: undefined,
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    intersections: [],
    deferred: [],
    external: params?.external ?? undefined,
  };
}

export function handleUnrepresentable(
  schema: any, ctx: ToJSONSchemaContext, json: JSONSchema,
  params: ProcessParams, message: string
): boolean {
  const result =
    typeof ctx.unrepresentable === "function"
      ? ctx.unrepresentable({ zodSchema: schema, path: params.path, message })
      : ctx.unrepresentable;
  if (result === "any") return false;
  if (result === undefined || result === "throw") throw new Error(message);
  Object.assign(json, result);
  return true;
}

// our def.type names → the processor table's names
const PROC_TYPE: Record<string, string> = {
  discunion: "union",
  discriminatedUnion: "union",
  intersect: "intersection",
  nonopt: "nonoptional",
  exactopt: "optional",
  exactOptional: "optional",
  brand: "optional",
  effects: "optional",
  refine: "optional",
  superrefine: "optional",
  codec: "pipe",
  algoformat: "algoformat",
  stringbool: "stringbool",
};

export function processSchema(
  schema: any, ctx: ToJSONSchemaContext,
  _params: ProcessParams = { path: [], schemaPath: [] }
): JSONSchema {
  const def = schema._zod.def;

  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
    return seen.schema;
  }

  const result: Seen = { schema: {}, count: 1, cycle: undefined, path: _params.path };
  ctx.seen.set(schema, result);
  ctx.sharedDefsExtractedFor = undefined;
  ctx.sharedEmitDoneFor = undefined;

  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema as any;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path,
    };

    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      let ptype = PROC_TYPE[def.type] ?? def.type;
      if (def.type === "instof" || def.type === "instanceof")
        ptype = def.name === "promise" ? "promise" : def.name === "function" ? "function" : "custom";
      else if (def.type.startsWith("coerce_")) ptype = def.type.slice(7);
      const processor = ctx.processors[ptype];
      if (!processor)
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      processor(schema, ctx, _json, params);
    }

    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref) result.ref = parent;
      processSchema(parent, ctx, params);
      ctx.seen.get(parent)!.isParent = true;
    }
  }

  const meta = ctx.metadataRegistry.get(schema);
  if (meta) assignProps(result.schema, meta);

  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }

  if (ctx.io === "input" && "_prefault" in result.schema)
    result.schema.default ??= result.schema._prefault;
  delete result.schema._prefault;

  return ctx.seen.get(schema)!.schema;
}

function encodeJSONPointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function extractDefs(ctx: ToJSONSchemaContext, schema: any): void {
  const root = ctx.seen.get(schema);
  if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
  if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external) return;

  const idToSchema = new Map<string, any>();
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0])
        throw new Error(
          `Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`
        );
      idToSchema.set(id, entry[0]);
    }
  }

  const makeURI = (entry: [any, Seen]): { ref: string; defId?: string } => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id: string) => id);
      if (externalId) return { ref: uriGenerator(externalId) };
      const id: string = entry[1].defId ?? (entry[1].schema.id as string) ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}` };
    }

    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    if (entry[1] === root && !entry[1].schema.id) return { ref: uriPrefix };
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + encodeJSONPointerSegment(defId) };
  };

  const extractToDef = (entry: [any, Seen]): void => {
    if (entry[1].schema.$ref) return;
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId) seen.defId = defId;
    const schema = seen.schema;
    for (const key in schema) delete schema[key];
    schema.$ref = ref;
  };

  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle)
        throw new Error(
          "Cycle detected: " +
            `#/${seen.cycle?.join("/")}/<root>` +
            '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.'
        );
    }
  }

  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) { extractToDef(entry); continue; }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) { extractToDef(entry); continue; }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) { extractToDef(entry); continue; }
    if (seen.cycle) { extractToDef(entry); continue; }
    if (seen.count > 1 && ctx.reused === "ref") extractToDef(entry);
  }

  if (ctx.external) ctx.sharedDefsExtractedFor = ctx.external;
}

function compactTypeUnion(schema: JSONSchema): void {
  const options = schema.anyOf;
  if (!Array.isArray(options) || options.length === 0 || schema.type !== undefined) return;
  const types: any[] = [];
  for (const option of options) {
    if (!option || typeof option !== "object") return;
    compactTypeUnion(option);
    const keys = Object.keys(option);
    if (keys.length !== 1 || keys[0] !== "type") return;
    const type = option.type;
    for (const member of Array.isArray(type) ? type : [type]) {
      if (typeof member !== "string") return;
      if (!types.includes(member)) types.push(member);
    }
  }
  delete schema.anyOf;
  schema.type = types.length === 1 ? types[0] : types;
}

const FOLDABLE_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const UNION_KEYS = ["oneOf", "anyOf"] as const;

function undeclaredConstraint(member: JSONSchema): JSONSchema | null {
  const extra = member.additionalProperties;
  if (extra === undefined || extra === false || typeof extra !== "object" || extra === null) return null;
  return Object.keys(extra).length ? extra : null;
}

function foldObjects(members: JSONSchema[]): JSONSchema | null {
  const objects: JSONSchema[] = [];
  for (const member of members) {
    if (typeof member !== "object" || member.type !== "object") return null;
    for (const key in member) if (!FOLDABLE_KEYS.has(key)) return null;
    objects.push(member);
  }
  const properties: Record<string, any> = {};
  const required = new Set<string>();
  for (const object of objects) {
    for (const key in object.properties) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      const parts: any[] = [];
      for (const other of objects) {
        const part = other.properties?.[key] ?? undeclaredConstraint(other);
        if (part === null || part === undefined) continue;
        if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part))) parts.push(part);
      }
      const merged =
        parts.length === 1 ? parts[0] : (foldObjects(parts) ?? { allOf: parts });
      assignProp(properties, key, merged);
    }
    for (const key of object.required ?? []) required.add(key);
  }
  const folded: JSONSchema = { type: "object", properties };
  if (required.size) folded.required = [...required];
  if (objects.every((object) => object.additionalProperties === false)) {
    folded.additionalProperties = false;
  } else {
    const constraints: JSONSchema[] = [];
    for (const object of objects) {
      const constraint = undeclaredConstraint(object);
      if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint)))
        constraints.push(constraint);
    }
    if (constraints.length === 1) folded.additionalProperties = constraints[0];
    else if (constraints.length > 1) folded.additionalProperties = { allOf: constraints };
  }
  return folded;
}

function foldIntersection(json: JSONSchema): void {
  const allOf = json.allOf;
  if (!Array.isArray(allOf) || allOf.length < 2) return;
  for (const key of FOLDABLE_KEYS) if (key in json) return;
  const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
  let folded: JSONSchema | null = null;
  if (!unions.length) {
    folded = foldObjects(allOf);
  } else {
    const union = unions[0];
    const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]))!;
    if (Object.keys(union).length !== 1) return;
    const rest = allOf.filter((m) => m !== union);
    const branches = union[keyword].map((branch: any) => foldObjects([...rest, branch]));
    if (branches.some((b: any) => !b)) return;
    folded = { [keyword]: branches };
  }
  if (!folded) return;
  delete json.allOf;
  assignProps(json, folded);
}

export function finalize(ctx: ToJSONSchemaContext, schema: any): JSONSchema {
  const root = ctx.seen.get(schema);
  if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");

  const flattenRef = (zodSchema: any) => {
    const seen = ctx.seen.get(zodSchema)!;
    if (seen.ref === null) return;
    const schema = seen.def ?? seen.schema;
    const _cached = { ...schema };
    const ref = seen.ref;
    seen.ref = null;

    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref)!;
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema.allOf = schema.allOf ?? [];
        schema.allOf.push(refSchema);
      } else {
        assignProps(schema, refSchema);
      }
      assignProps(schema, _cached);

      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf") continue;
          if (!(key in _cached)) delete schema[key];
        }
      }

      if (refSchema.$ref && refSeen.def) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf") continue;
          if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key]))
            delete schema[key];
        }
      }
    }

    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema) {
            if (key === "$ref" || key === "allOf") continue;
            if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key]))
              delete schema[key];
          }
        }
      }
    }

    ctx.override({ zodSchema, jsonSchema: schema, path: seen.path ?? [] });
  };

  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
    if (ctx.target !== "openapi-3.0")
      for (const entry of ctx.seen.entries()) compactTypeUnion(entry[1].def ?? entry[1].schema);
    for (const rewrite of ctx.deferred) rewrite();

    if (ctx.intersections.length) {
      const carriers = new Map<JSONSchema[], JSONSchema[]>();
      for (const seen of ctx.seen.values()) {
        for (const json of [seen.schema, seen.def]) {
          const allOf = json?.allOf;
          if (!Array.isArray(allOf)) continue;
          const existing = carriers.get(allOf);
          if (existing) existing.push(json!);
          else carriers.set(allOf, [json!]);
        }
      }
      for (const allOf of ctx.intersections)
        for (const json of carriers.get(allOf) ?? []) foldIntersection(json);
    }
  }

  const result: JSONSchema = {};
  if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
  else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
  else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";

  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id) throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }

  assignProps(result, root.defId ? root.schema : (root.def ?? root.schema));

  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== undefined && result.id === rootMetaId) delete result.id;

  const defs = ctx.external?.defs ?? {};
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        if (seen.def.id === seen.defId) delete seen.def.id;
        assignProp(defs, seen.defId, seen.def);
      }
    }
  }
  if (ctx.external) ctx.sharedEmitDoneFor = ctx.external;

  if (!ctx.external && Object.keys(defs).length > 0) {
    if (ctx.target === "draft-2020-12") result.$defs = defs;
    else result.definitions = defs;
  }

  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors),
        },
      },
      enumerable: false,
      writable: false,
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}

function isTransforming(_schema: any, _ctx?: { seen: Set<any> }): boolean {
  const ctx = _ctx ?? { seen: new Set() };
  if (ctx.seen.has(_schema)) return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  const t = def.type;

  if (t === "transform") return true;
  if (t === "array") return isTransforming(def.element, ctx);
  if (t === "set") return isTransforming(def.valueType, ctx);
  if (t === "lazy") return isTransforming(def.getter(), ctx);
  if (
    t === "promise" || t === "instof" ||
    t === "optional" || t === "exactOptional" || t === "nonoptional" || t === "nonopt" ||
    t === "nullable" || t === "readonly" || t === "brand" ||
    t === "default" || t === "prefault" || t === "catch" ||
    t === "effects" || t === "refine" || t === "superrefine"
  )
    return isTransforming(def.innerType ?? def.inner ?? def.in, ctx);
  if (t === "intersection" || t === "intersect")
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  if (t === "record" || t === "map")
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  if (t === "pipe" || t === "codec") {
    if (t === "codec" || _schema._zod.traits.has(ZodCodec)) return true;
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (t === "object") {
    for (const key in def.shape)
      if (isTransforming(def.shape[key], ctx)) return true;
    return false;
  }
  if (t === "union" || t === "discunion") {
    for (const option of def.options)
      if (isTransforming(option, ctx)) return true;
    return false;
  }
  if (t === "tuple") {
    for (const item of def.items) if (isTransforming(item, ctx)) return true;
    if (def.rest && isTransforming(def.rest, ctx)) return true;
    return false;
  }
  return false;
}

export const createToJSONSchemaMethod =
  (schema: any, processors: Record<string, Processor> = {}) =>
  (params?: any): JSONSchema => {
    const ctx = initializeContext({ ...params, processors });
    processSchema(schema, ctx);
    extractDefs(ctx, schema);
    return finalize(ctx, schema);
  };

export const createStandardJSONSchemaMethod =
  (schema: any, io: "input" | "output", processors: Record<string, Processor> = {}) =>
  (params?: any): JSONSchema => {
    const { libraryOptions, target } = params ?? {};
    const ctx = initializeContext({ ...(libraryOptions ?? {}), target, io, processors });
    processSchema(schema, ctx);
    extractDefs(ctx, schema);
    return finalize(ctx, schema);
  };

// ==================== CHECK AGGREGATION ====================

type Bound = number | bigint | Date;
interface CheckAggregate {
  minimum?: Bound; maximum?: Bound;
  exclusiveMinimum?: Bound; exclusiveMaximum?: Bound;
  multipleOf?: number[];
  format?: string; isInt?: boolean;
  patterns?: Set<RegExp>;
  mime?: string[]; contentEncoding?: string; laxFormat?: boolean;
}

const narrowMin = (agg: CheckAggregate, key: "minimum" | "exclusiveMinimum", value: Bound): void => {
  if (agg[key] === undefined || value > agg[key]) agg[key] = value;
};
const narrowMax = (agg: CheckAggregate, key: "maximum" | "exclusiveMaximum", value: Bound): void => {
  if (agg[key] === undefined || value < agg[key]) agg[key] = value;
};
const narrowBoth = (agg: CheckAggregate, value: number): void => {
  narrowMin(agg, "minimum", value);
  narrowMax(agg, "maximum", value);
};
const addDivisor = (agg: CheckAggregate, value: number): void => {
  agg.multipleOf ??= [];
  if (!agg.multipleOf.includes(value)) agg.multipleOf.push(value);
};
const addPattern = (agg: CheckAggregate, pattern: RegExp): void => {
  agg.patterns ??= new Set();
  agg.patterns.add(pattern);
};
const intersectMime = (agg: CheckAggregate, mime: string | string[]): void => {
  const arr = Array.isArray(mime) ? mime : [mime];
  agg.mime = agg.mime ? agg.mime.filter((m) => arr.includes(m)) : [...arr];
};
const setFormat = (agg: CheckAggregate, format: string): void => {
  agg.format = format;
  if (format.includes("int")) agg.isInt = true;
};

const NUMBER_FORMAT_RANGES: Record<string, [number, number]> = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-3.4028234663852886e38, 3.4028234663852886e38],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE],
};
const BIGINT_FORMAT_RANGES: Record<string, [bigint, bigint]> = {
  int64: [BigInt("-9223372036854775808"), BigInt("9223372036854775807")],
  uint64: [BigInt(0), BigInt("18446744073709551615")],
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// zod's runtime/lax charset patterns swap for exact block forms in emitted
// schemas (parse paths never overflow; the exact form does)
const exactPatterns: Record<string, string> = {
  "^[0-9a-zA-Z+/]*={0,2}$": "^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$",
  "^[A-Za-z0-9_-]*$": "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$",
};
const exactPattern = (p: RegExp): RegExp => {
  const src = exactPatterns[p.source];
  return src === undefined ? p : new RegExp(src, p.flags);
};

// pattern each named string format carries into the emitted schema; algorithmic
// formats (url, jwt, …) carry none, matching zod's def.pattern
const FORMAT_JS_PAT: Record<string, string | undefined> = {
  email: "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
  uuid: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
  uuidv4: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
  uuidv6: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-6[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
  uuidv7: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
  guid: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
  cuid: "^[cC][0-9a-z]{6,}$",
  cuid2: "^[0-9a-z]+$",
  ulid: "^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$",
  nanoid: "^[a-zA-Z0-9_-]{21}$",
  xid: "^[0-9a-vA-V]{20}$",
  ksuid: "^[A-Za-z0-9]{27}$",
  e164: "^\\+[1-9]\\d{6,14}$",
  emoji: "^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}⃝])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$",
  hex: "^[0-9a-fA-F]*$",
  ipv4: "^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$",
  ipv6: "^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$",
  cidrv4: "^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\/([0-9]|[1-2][0-9]|3[0-2])$",
  cidrv6: "^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))\\/(12[0-8]|1[01][0-9]|[0-9]{1,2})$",
  hostname: "^(?=.{1,253}\\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\\.?$",
  base64: "^[0-9a-zA-Z+/]*={0,2}$",
  base64url: "^[A-Za-z0-9_-]*$",
};

// check records that carry a named string format
const NAMED_STR_FORMATS = new Set([
  "email", "uuid", "uuidv4", "uuidv6", "uuidv7", "guid", "url", "emoji", "nanoid",
  "cuid", "cuid2", "ulid", "xid", "ksuid", "e164", "base64", "base64url", "jwt",
  "hex", "ipv4", "ipv6", "cidrv4", "cidrv6", "datetime", "date", "time",
  "duration", "hostname", "httpurl", "httpUrl", "mac", "domain", "slugify",
]);

function mergeAgg(agg: CheckAggregate, sub: CheckAggregate): void {
  if (sub.minimum !== undefined) narrowMin(agg, "minimum", sub.minimum);
  if (sub.maximum !== undefined) narrowMax(agg, "maximum", sub.maximum);
  if (sub.exclusiveMinimum !== undefined) narrowMin(agg, "exclusiveMinimum", sub.exclusiveMinimum);
  if (sub.exclusiveMaximum !== undefined) narrowMax(agg, "exclusiveMaximum", sub.exclusiveMaximum);
  for (const m of sub.multipleOf ?? []) addDivisor(agg, m);
  for (const p of sub.patterns ?? []) addPattern(agg, p);
  if (sub.format) setFormat(agg, sub.format);
  if (sub.isInt) agg.isInt = true;
  if (sub.mime) intersectMime(agg, sub.mime);
  if (sub.contentEncoding) agg.contentEncoding = sub.contentEncoding;
  if (sub.laxFormat) agg.laxFormat = true;
}

function aggChecks(schema: any): CheckAggregate {
  const agg: CheckAggregate = {};
  const d = schema._zod?.def ?? schema._def;
  const st = d.type;
  // zod check defs contribute to _zod.bag at attach; third-party checks only
  // land there. merge bag fields so onattach contributions are honored
  const bag = schema._zod?.bag;
  if (bag) {
    if (bag.minimum !== undefined) narrowMin(agg, "minimum", bag.minimum);
    if (bag.maximum !== undefined) narrowMax(agg, "maximum", bag.maximum);
    if (bag.exclusiveMinimum !== undefined) narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
    if (bag.exclusiveMaximum !== undefined) narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
    for (const m of bag.multipleOf ?? []) addDivisor(agg, m);
    for (const p of bag.patterns ?? []) addPattern(agg, p);
    if (bag.format) setFormat(agg, bag.format);
    if (bag.isInt) agg.isInt = true;
    if (bag.mime) intersectMime(agg, bag.mime);
    if (bag.contentEncoding) agg.contentEncoding = bag.contentEncoding;
  }
  // a format schema is its own first check — `z.int32()`/`z.uuid()` defs carry format
  if (d.format !== undefined) {
    if (st === "number" && NUMBER_FORMAT_RANGES[d.format]) {
      setFormat(agg, d.format);
      const [mn, mx] = NUMBER_FORMAT_RANGES[d.format];
      narrowMin(agg, "minimum", mn); narrowMax(agg, "maximum", mx);
    } else if (st === "bigint" && BIGINT_FORMAT_RANGES[d.format]) {
      setFormat(agg, d.format);
      const [mn, mx] = BIGINT_FORMAT_RANGES[d.format];
      narrowMin(agg, "minimum", mn); narrowMax(agg, "maximum", mx);
    } else if (st === "string") {
      setFormat(agg, d.format);
      if (d.pattern) addPattern(agg, d.pattern);
      if (d.format === "base64" || d.format === "base64url") agg.contentEncoding = d.format;
    }
  }
  for (const c of d.checks ?? []) {
    if (!c || typeof c === "function") continue;
    const k = c.kind;
    // bounds — the record kinds read differently per host type
    if (k === "gte" || k === "gt") {
      narrowMin(agg, k === "gte" ? "minimum" : "exclusiveMinimum", c.value);
      continue;
    }
    if (k === "lte" || k === "lt") {
      narrowMax(agg, k === "lte" ? "maximum" : "exclusiveMaximum", c.value);
      continue;
    }
    if (st === "number" || st === "bigint") {
      if (k === "min") { narrowMin(agg, "minimum", c.value); continue; }
      if (k === "max") { narrowMax(agg, "maximum", c.value); continue; }
      if (k === "multipleOf") { addDivisor(agg, c.value); continue; }
      if (k === "int" || k === "safeInt" || k === "safe") {
        setFormat(agg, "safeint");
        narrowMin(agg, "minimum", Number.MIN_SAFE_INTEGER);
        narrowMax(agg, "maximum", Number.MAX_SAFE_INTEGER);
        continue;
      }
      if (k === "format" && c.format && NUMBER_FORMAT_RANGES[c.format]) {
        setFormat(agg, c.format);
        const [mn, mx] = NUMBER_FORMAT_RANGES[c.format];
        narrowMin(agg, "minimum", mn); narrowMax(agg, "maximum", mx);
        continue;
      }
      continue;
    }
    // string / array / file / set / map / tuple cardinality
    if (k === "min") { narrowMin(agg, "minimum", c.value); continue; }
    if (k === "max") { narrowMax(agg, "maximum", c.value); continue; }
    if (k === "length" || k === "exact" || k === "size") {
      if (k === "size") { if (c.min !== undefined) narrowMin(agg, "minimum", c.min); if (c.max !== undefined) narrowMax(agg, "maximum", c.max); if (c.exact !== undefined) narrowBoth(agg, c.exact); continue; }
      narrowBoth(agg, c.value ?? c.length ?? c.exact); continue;
    }
    if (k === "mime") { intersectMime(agg, c.value ?? c.mime); continue; }
    // string-format surface
    if (k === "regex") {
      const fmt = c.format ?? "regex";
      setFormat(agg, fmt);
      if (c.regex) addPattern(agg, c.regex);
      if (fmt === "base64" || fmt === "base64url") agg.contentEncoding = fmt;
      if (c.local || c.precision === -1) agg.laxFormat = true;
      continue;
    }
    if (k === "startsWith") { addPattern(agg, new RegExp("^" + escapeRegex(c.value) + ".*")); continue; }
    if (k === "endsWith") { addPattern(agg, new RegExp(".*" + escapeRegex(c.value) + "$")); continue; }
    if (k === "includes") {
      addPattern(agg, c.position !== undefined
        ? new RegExp("^.{" + c.position + ",}" + escapeRegex(c.value))
        : new RegExp(escapeRegex(c.value)));
      continue;
    }
    if (NAMED_STR_FORMATS.has(k) || c.fmt) {
      const fmt = c.fmt ?? (k === "httpUrl" ? "httpurl" : k);
      setFormat(agg, fmt);
      const src = k === "nanoid" ? `^[a-zA-Z0-9_-]{${c.length ?? 21}}$`
        : (c.pat?.source ?? FORMAT_JS_PAT[fmt]);
      if (src !== undefined) addPattern(agg, new RegExp(src, fmt === "emoji" ? "u" : undefined));
      if (fmt === "base64" || fmt === "base64url") agg.contentEncoding = fmt;
      if (c.local || c.precision === -1) agg.laxFormat = true;
      continue;
    }
    if (k === "multipleOf") { addDivisor(agg, c.value); continue; }
    if (k === "schemacheck") { mergeAgg(agg, aggChecks(c.schema)); continue; }
  }
  return agg;
}

const formatMap: Record<string, string | undefined> = {
  guid: "uuid",
  url: "uri",
  httpurl: "uri",
  httpUrl: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: "",
  template_literal: "",
};

// ==================== PROCESSORS ====================

const stringProcessor: Processor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggChecks(schema);
  if (typeof minimum === "number") json.minLength = minimum;
  if (typeof maximum === "number") json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "") delete json.format;
    if (format === "time" || laxFormat) delete json.format;
  }
  if (contentEncoding) json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const patternList = [...patterns].map(exactPattern);
    if (patternList.length === 1) json.pattern = patternList[0].source;
    else if (patternList.length > 1) {
      json.allOf = patternList.map((regex) => ({
        ...(ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0"
          ? { type: "string" }
          : {}),
        pattern: regex.source,
      }));
    }
  }
};

const numberProcessor: Processor = (schema, ctx, _json, params) => {
  const json = _json;
  const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggChecks(schema);
  json.type = isInt ? "integer" : "number";

  const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= ((minimum as number) ?? Number.NEGATIVE_INFINITY);
  const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= ((maximum as number) ?? Number.POSITIVE_INFINITY);
  const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";

  if (exMin) {
    if (legacy) { json.minimum = exclusiveMinimum; json.exclusiveMinimum = true; }
    else json.exclusiveMinimum = exclusiveMinimum;
  } else if (typeof minimum === "number") json.minimum = minimum;

  if (exMax) {
    if (legacy) { json.maximum = exclusiveMaximum; json.exclusiveMaximum = true; }
    else json.exclusiveMaximum = exclusiveMaximum;
  } else if (typeof maximum === "number") json.maximum = maximum;

  if (multipleOf) {
    const divisors = new Set<number>();
    for (const divisor of multipleOf) {
      if (Number.isFinite(divisor) && divisor !== 0) divisors.add(Math.abs(divisor));
      else handleUnrepresentable(schema, ctx, json, params,
        `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
    }
    const [first, ...rest] = divisors;
    if (first !== undefined) json.multipleOf = first;
    if (rest.length) json.allOf = [...(json.allOf ?? []), ...rest.map((m) => ({ multipleOf: m }))];
  }
};

const booleanProcessor: Processor = (_s, _c, json) => { json.type = "boolean"; };
const bigintProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "BigInt cannot be represented in JSON Schema"); };
const symbolProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "Symbols cannot be represented in JSON Schema"); };
const nullProcessor: Processor = (_s, ctx, json) => {
  if (ctx.target === "openapi-3.0") {
    json.type = "string"; json.nullable = true; json.enum = [null];
  } else json.type = "null";
};
const undefinedProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "Undefined cannot be represented in JSON Schema"); };
const voidProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "Void cannot be represented in JSON Schema"); };
const neverProcessor: Processor = (_s, _c, json) => { json.not = {}; };
const anyProcessor: Processor = () => {};
const unknownProcessor: Processor = () => {};
const dateProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "Date cannot be represented in JSON Schema"); };

const enumProcessor: Processor = (schema, _c, json) => {
  const def = schema._zod.def;
  const values = def.values ?? Object.values(def.entries ?? {});
  if (values.length === 0) { json.not = {}; return; }
  if (values.every((v: any) => typeof v === "number")) json.type = "number";
  if (values.every((v: any) => typeof v === "string")) json.type = "string";
  json.enum = values;
};

const literalProcessor: Processor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const values: any[] = def.values ?? (Array.isArray(def.value) ? def.value : [def.value]);
  if (values.length === 0) { json.not = {}; return; }
  const vals: any[] = [];
  for (const val of values) {
    if (val === undefined) {
      if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema"))
        return;
    } else if (typeof val === "bigint") {
      if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema"))
        return;
      vals.push(Number(val));
    } else vals.push(val);
  }
  if (vals.length === 0) {
  } else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
    else json.const = val;
  } else {
    if (vals.every((v) => typeof v === "number")) json.type = "number";
    if (vals.every((v) => typeof v === "string")) json.type = "string";
    if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
    if (vals.every((v) => v === null)) json.type = "null";
    json.enum = vals;
  }
};

const nanProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "NaN cannot be represented in JSON Schema"); };

const templateLiteralProcessor: Processor = (schema, _c, json) => {
  const pattern = schema._zod.pattern;
  if (!pattern) throw new Error("Pattern not found in template literal");
  json.type = "string";
  json.pattern = pattern.source;
};

const fileProcessor: Processor = (schema, _c, json) => {
  json.type = "string";
  json.format = "binary";
  json.contentEncoding = "binary";
  const { minimum, maximum, mime } = aggChecks(schema);
  if (minimum !== undefined) json.minLength = minimum;
  if (maximum !== undefined) json.maxLength = maximum;
  if (!mime) return;
  if (mime.length === 0) json.not = {};
  else if (mime.length === 1) json.contentMediaType = mime[0];
  else json.anyOf = mime.map((m) => ({ contentMediaType: m }));
};

const successProcessor: Processor = (_s, _c, json) => { json.type = "boolean"; };
const customProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema"); };
const functionProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "Function types cannot be represented in JSON Schema"); };
const transformProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema"); };
const mapProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "Map cannot be represented in JSON Schema"); };
const setProcessor: Processor = (schema, ctx, json, params) =>
  { handleUnrepresentable(schema, ctx, json, params, "Set cannot be represented in JSON Schema"); };

const algoformatProcessor: Processor = (schema, _c, json) => {
  const def = schema._zod.def;
  json.type = "string";
  if (def.format) json.format = def.format;
  if (def.pattern) json.pattern = def.pattern.source;
};

const stringboolProcessor: Processor = (_s, ctx, json) => {
  json.type = ctx.io === "input" ? "string" : "boolean";
};

const arrayProcessor: Processor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = aggChecks(schema);
  if (typeof minimum === "number") json.minItems = minimum;
  if (typeof maximum === "number") json.maxItems = maximum;
  json.type = "array";
  json.items = processSchema(def.element, ctx, { ...params, path: [...params.path, "items"] });
};

function inputOptin(schema: any): "optional" | "defaulted" | undefined {
  const def = schema._zod.def;
  if (def.type === "pipe" && def.in?._zod?.traits?.has(ZodTransform))
    return inputOptin(def.out);
  if (def.type === "catch") return inputOptin(def.innerType ?? def.inner);
  return schema._zod.optin;
}

const objectProcessor: Processor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const shape = def.shape;
  const symbolKeys = Object.getOwnPropertySymbols(shape);
  if (symbolKeys.length &&
    handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema"))
    return;

  json.type = "object";
  json.properties = {};
  for (const key in shape) {
    assignProp(json.properties, key,
      processSchema(shape[key], ctx, { ...params, path: [...params.path, "properties", key] }));
  }
  const requiredKeys: string[] = [];
  for (const key of Object.keys(shape)) {
    const field = def.shape[key];
    if (ctx.io === "input" ? inputOptin(field) === undefined : field._zod.optout === undefined)
      requiredKeys.push(key);
  }
  if (requiredKeys.length > 0) json.required = requiredKeys;

  if (def.catchall?._zod?.def?.type === "never" || def.catchall?._def?.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output") json.additionalProperties = false;
  } else {
    json.additionalProperties = processSchema(def.catchall, ctx,
      { ...params, path: [...params.path, "additionalProperties"] });
  }
};

const unionProcessor: Processor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x: any, i: number) =>
    processSchema(x, ctx, { ...params, path: [...params.path, isExclusive ? "oneOf" : "anyOf", i] }));
  if (isExclusive) json.oneOf = options;
  else json.anyOf = options;
};

const intersectionProcessor: Processor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = processSchema(def.left, ctx, { ...params, path: [...params.path, "allOf", 0] });
  const b = processSchema(def.right, ctx, { ...params, path: [...params.path, "allOf", 1] });
  const isSimpleIntersection = (val: any) => "allOf" in val && Object.keys(val).length === 1;
  const allOf = [
    ...(isSimpleIntersection(a) ? a.allOf : [a]),
    ...(isSimpleIntersection(b) ? b.allOf : [b]),
  ];
  json.allOf = allOf;
  ctx.intersections.push(allOf);
};

const tupleProcessor: Processor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "array";
  const prefixPath = ctx.target === "draft-2020-12" ? "prefixItems" : "items";
  const restPath =
    ctx.target === "draft-2020-12" ? "items" : ctx.target === "openapi-3.0" ? "items" : "additionalItems";
  const prefixItems = def.items.map((x: any, i: number) =>
    processSchema(x, ctx, { ...params, path: [...params.path, prefixPath, i] }));
  const rest = def.rest
    ? processSchema(def.rest, ctx,
        { ...params, path: [...params.path, restPath, ...(ctx.target === "openapi-3.0" ? [def.items.length] : [])] })
    : null;

  let minItems = def.items.length;
  while (minItems > 0) {
    const item = def.items[minItems - 1];
    const optional = ctx.io === "input" ? inputOptin(item) !== undefined : item._zod.optout === "optional";
    if (!optional) break;
    minItems--;
  }
  const maxItems = def.items.length;
  const isClosed = !def.rest;

  if (ctx.target === "draft-2020-12") {
    json.prefixItems = prefixItems;
    if (isClosed) json.items = false;
    else if (rest) json.items = rest;
    if (minItems > 0) json.minItems = minItems;
    if (isClosed) json.maxItems = maxItems;
  } else if (ctx.target === "openapi-3.0") {
    json.items = { anyOf: prefixItems };
    if (rest) json.items.anyOf.push(rest);
    if (minItems > 0) json.minItems = minItems;
    if (isClosed) json.maxItems = maxItems;
  } else {
    json.items = prefixItems;
    if (isClosed) json.additionalItems = false;
    else if (rest) json.additionalItems = rest;
    if (minItems > 0) json.minItems = minItems;
    if (isClosed) json.maxItems = maxItems;
  }

  const { minimum, maximum } = aggChecks(schema);
  if (typeof minimum === "number") json.minItems = minimum;
  if (typeof maximum === "number") json.maxItems = maximum;
};

function stringifyKeyNames(
  bySchema: Map<JSONSchema, Seen>, json: JSONSchema, visited: Set<JSONSchema>
): JSONSchema {
  if (json.$ref) {
    if (visited.has(json)) return json;
    visited.add(json);
    const def = bySchema.get(json)?.def;
    if (!def) return json;
    const inlined = stringifyKeyNames(bySchema, def, visited);
    return inlined === def ? json : inlined;
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = json[keyword];
    if (!Array.isArray(branches)) continue;
    const mapped = branches.map((branch: any) => stringifyKeyNames(bySchema, branch, visited));
    if (mapped.some((branch, i) => branch !== branches[i])) json = { ...json, [keyword]: mapped };
  }
  const types = Array.isArray(json.type) ? json.type : [json.type];
  const numericType = !types.includes("string") && types.some((t) => t === "number" || t === "integer");
  const values = json.enum ?? (json.const !== undefined ? [json.const] : undefined);
  if (!numericType && !values?.some((v: any) => typeof v === "number")) return json;

  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format, id, ...rest } = json;
  if (rest.enum) rest.enum = rest.enum.map((v: any) => (typeof v === "number" ? String(v) : v));
  else if (typeof rest.const === "number") rest.const = String(rest.const);
  if (!numericType) return rest;
  rest.type = "string";
  if (!values) rest.pattern = types.includes("number") ? "^-?\\d+(?:\\.\\d+)?$" : "^-?\\d+$";
  return rest;
}

const pendingRecords = new WeakMap<ToJSONSchemaContext, any[]>();

function rewriteKeyNames(ctx: ToJSONSchemaContext): void {
  const bySchema = new Map<JSONSchema, Seen>();
  for (const entry of ctx.seen.values())
    if (entry.def && !bySchema.has(entry.schema)) bySchema.set(entry.schema, entry);

  const rewrites = new Map<JSONSchema, JSONSchema>();
  for (const record of pendingRecords.get(ctx) ?? []) {
    const seen = ctx.seen.get(record);
    const names = (seen?.def ?? seen?.schema)?.propertyNames;
    if (!names || names === true || rewrites.has(names)) continue;
    const rewritten = stringifyKeyNames(bySchema, names, new Set());
    if (rewritten !== names) rewrites.set(names, rewritten);
  }
  if (!rewrites.size) return;
  for (const entry of ctx.seen.values()) {
    for (const carrier of [entry.schema, entry.def]) {
      const rewritten = carrier && rewrites.get(carrier.propertyNames);
      if (rewritten) carrier.propertyNames = rewritten;
    }
  }
}

const recordProcessor: Processor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  const keyType = def.keyType;
  const patterns = aggChecks(keyType).patterns;

  if (def.mode === "loose" && patterns && patterns.size > 0) {
    const valueSchema = processSchema(def.valueType, ctx,
      { ...params, path: [...params.path, "patternProperties", "*"] });
    json.patternProperties = {};
    for (const pattern of patterns)
      assignProp(json.patternProperties, pattern.source, valueSchema);
  } else {
    if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
      json.propertyNames = processSchema(def.keyType, ctx,
        { ...params, path: [...params.path, "propertyNames"] });
      let pending = pendingRecords.get(ctx);
      if (!pending) {
        pending = [];
        pendingRecords.set(ctx, pending);
        ctx.deferred.push(() => rewriteKeyNames(ctx));
      }
      pending.push(schema);
    }
    json.additionalProperties = processSchema(def.valueType, ctx,
      { ...params, path: [...params.path, "additionalProperties"] });
  }

  const keyValues = keyType._zod.values;
  const omittableOnInput = ctx.io === "input" && inputOptin(def.valueType) !== undefined;
  if (keyValues && !def.partial && !omittableOnInput) {
    const validKeyValues = [...keyValues].filter(
      (v): v is string | number => typeof v === "string" || typeof v === "number");
    if (validKeyValues.length > 0) json.required = validKeyValues.map(String);
  }
};

const innerRefProcessor: Processor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType ?? def.inner ?? def.in ?? def.getter?.(), ctx, params);
  ctx.seen.get(schema)!.ref = def.innerType ?? def.inner ?? def.in ?? def.getter?.();
};

const nullableProcessor: Processor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = processSchema(def.innerType ?? def.inner, ctx, params);
  const seen = ctx.seen.get(schema)!;
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType ?? def.inner;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};

const nonoptionalProcessor: Processor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType ?? def.inner, ctx, params);
  ctx.seen.get(schema)!.ref = def.innerType ?? def.inner;
};

const UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(
  value: unknown, schema: any, ctx: ToJSONSchemaContext, json: JSONSchema, params: ProcessParams
): any {
  let unrepresentable = false;
  const serialized = JSON.stringify(value, (_, val) => {
    if (typeof val !== "bigint") return val;
    unrepresentable = true;
    return null;
  });
  if (serialized === undefined) return UNREPRESENTABLE_DEFAULT;
  if (!unrepresentable) return JSON.parse(serialized);
  handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
  return UNREPRESENTABLE_DEFAULT;
}

const evalDefault = (def: any): any => {
  const raw = def.defaultValue !== undefined ? def.defaultValue : def.value;
  return typeof raw === "function" ? raw() : raw;
};

const defaultProcessor: Processor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = def.innerType ?? def.inner;
  processSchema(inner, ctx, params);
  ctx.seen.get(schema)!.ref = inner;
  const value = serializeDefaultValue(evalDefault(def), schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT) json.default = value;
};

const prefaultProcessor: Processor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = def.innerType ?? def.inner;
  processSchema(inner, ctx, params);
  ctx.seen.get(schema)!.ref = inner;
  if (ctx.io !== "input") return;
  const value = serializeDefaultValue(evalDefault(def), schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT) json._prefault = value;
};

const catchProcessor: Processor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = def.innerType ?? def.inner;
  processSchema(inner, ctx, params);
  ctx.seen.get(schema)!.ref = inner;
  let catchValue: any;
  try {
    catchValue = typeof def.catchValue === "function" ? def.catchValue(undefined)
      : typeof def.value === "function" ? def.value(undefined) : def.value;
  } catch {
    handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
    return;
  }
  json.default = catchValue;
};

const pipeProcessor: Processor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  // our `.check`/`refine` on a transform wraps it in ZodEffects — zod clones
  // instead, so unwrap refine-family layers before the trait check
  let inDef = def.in?._def;
  while (inDef && (inDef.type === "refine" || inDef.type === "effects" || inDef.type === "superrefine"))
    inDef = (inDef.innerType ?? inDef.inner)?._def;
  const inIsTransform = inDef?.type === "transform" || def.in?._zod?.traits?.has(ZodTransform);
  const innerType = ctx.io === "input" ? (inIsTransform ? def.out : def.in) : def.out;
  processSchema(innerType, ctx, params);
  ctx.seen.get(schema)!.ref = innerType;
};

const readonlyProcessor: Processor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = def.innerType ?? def.inner;
  processSchema(inner, ctx, params);
  ctx.seen.get(schema)!.ref = inner;
  json.readOnly = true;
};

const promiseProcessor: Processor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inner = def.innerType ?? def.inner ?? def.schema;
  processSchema(inner, ctx, params);
  ctx.seen.get(schema)!.ref = inner;
};

const optionalProcessor: Processor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inner = def.innerType ?? def.inner;
  processSchema(inner, ctx, params);
  ctx.seen.get(schema)!.ref = inner;
};

const lazyProcessor: Processor = (schema, ctx, _json, params) => {
  const innerType = schema._zod.innerType ?? schema._zod.def.getter?.();
  processSchema(innerType, ctx, params);
  ctx.seen.get(schema)!.ref = innerType;
};

const allProcessors: Record<string, Processor> = {
  string: stringProcessor,
  number: numberProcessor,
  boolean: booleanProcessor,
  bigint: bigintProcessor,
  symbol: symbolProcessor,
  null: nullProcessor,
  undefined: undefinedProcessor,
  void: voidProcessor,
  never: neverProcessor,
  any: anyProcessor,
  unknown: unknownProcessor,
  date: dateProcessor,
  enum: enumProcessor,
  literal: literalProcessor,
  nan: nanProcessor,
  template_literal: templateLiteralProcessor,
  file: fileProcessor,
  success: successProcessor,
  custom: customProcessor,
  instof: customProcessor,
  instanceof: customProcessor,
  function: functionProcessor,
  transform: transformProcessor,
  map: mapProcessor,
  set: setProcessor,
  algoformat: algoformatProcessor,
  stringbool: stringboolProcessor,
  array: arrayProcessor,
  object: objectProcessor,
  union: unionProcessor,
  intersection: intersectionProcessor,
  tuple: tupleProcessor,
  record: recordProcessor,
  nullable: nullableProcessor,
  nonoptional: nonoptionalProcessor,
  default: defaultProcessor,
  prefault: prefaultProcessor,
  catch: catchProcessor,
  pipe: pipeProcessor,
  readonly: readonlyProcessor,
  promise: promiseProcessor,
  optional: optionalProcessor,
  lazy: lazyProcessor,
};

// ==================== TOP-LEVEL ====================

export function toJSONSchema(input: any, params?: any): any {
  if ("_idmap" in input) {
    const registry = input;
    const ctx = initializeContext({ ...params, processors: allProcessors });
    const defs: any = {};
    for (const entry of registry._idmap.entries()) {
      const [, schema] = entry;
      processSchema(schema, ctx);
    }
    const schemas: Record<string, JSONSchema> = {};
    const external = { registry, uri: params?.uri, defs };
    ctx.external = external;
    for (const entry of registry._idmap.entries()) {
      const [key, schema] = entry;
      extractDefs(ctx, schema);
      assignProp(schemas, key, finalize(ctx, schema));
    }
    if (Object.keys(defs).length > 0) {
      const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas.__shared = { [defsSegment]: defs };
    }
    return { schemas };
  }

  const ctx = initializeContext({ ...params, processors: allProcessors });
  processSchema(input, ctx);
  extractDefs(ctx, input);
  return finalize(ctx, input);
}

export class JSONSchemaGenerator {
  private ctx: ToJSONSchemaContext;
  get metadataRegistry() { return this.ctx.metadataRegistry; }
  get target() { return this.ctx.target; }
  get unrepresentable() { return this.ctx.unrepresentable; }
  get override() { return this.ctx.override; }
  get io() { return this.ctx.io; }
  get counter() { return this.ctx.counter; }
  set counter(value: number) { this.ctx.counter = value; }
  get seen() { return this.ctx.seen; }

  constructor(params?: any) {
    let normalizedTarget = params?.target ?? "draft-2020-12";
    if (normalizedTarget === "draft-4") normalizedTarget = "draft-04";
    if (normalizedTarget === "draft-7") normalizedTarget = "draft-07";
    this.ctx = initializeContext({
      processors: allProcessors,
      target: normalizedTarget,
      ...(params?.metadata && { metadata: params.metadata }),
      ...(params?.unrepresentable && { unrepresentable: params.unrepresentable }),
      ...(params?.override && { override: params.override }),
      ...(params?.io && { io: params.io }),
    });
  }

  process(schema: any, _params: ProcessParams = { path: [], schemaPath: [] }): JSONSchema {
    return processSchema(schema, this.ctx, _params);
  }

  emit(schema: any, _params?: any): JSONSchema {
    if (_params) {
      if (_params.cycles) this.ctx.cycles = _params.cycles;
      if (_params.reused) this.ctx.reused = _params.reused;
      if (_params.external) this.ctx.external = _params.external;
    }
    this.ctx.sharedDefsExtractedFor = undefined;
    this.ctx.sharedEmitDoneFor = undefined;
    extractDefs(this.ctx, schema);
    const result = finalize(this.ctx, schema);
    const { "~standard": _, ...plainResult } = result;
    return plainResult;
  }
}
