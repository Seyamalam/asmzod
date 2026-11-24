// error.ts — ZodError + issue types (zod3-compatible shape)

export type IssuePath = (string | number)[];

export interface ZodIssue {
  code: string;
  path: IssuePath;
  message: string;
  [key: string]: unknown;
}

// bigint can't JSON.stringify — zod's replacer stringifies it
const _jsonReplacer = (_k: string, v: any) => (typeof v === "bigint" ? v.toString() : v);

const _stringifyIssues = (issues: any[]): string =>
  JSON.stringify(issues, _jsonReplacer, 2);

// _zod slot on errors: { def: issues, message?: string, traits: Set }
function _getMessage(this: any): string {
  const z = this._zod;
  z.message ??= _stringifyIssues(z.def);
  return z.message;
}
function _setMessage(this: any, v: string): void {
  this._zod.message = v;
}
const _messageDesc: PropertyDescriptor = {
  get: _getMessage, set: _setMessage, enumerable: true, configurable: true,
};

// prototypes carrying the lazy toString already — intrinsics are seeded so a
// foreign receiver's proto is never touched
const _installedToString = new WeakSet<object>([Object.prototype, Error.prototype]);

function _installToString(inst: any): void {
  const proto = Object.getPrototypeOf(inst);
  if (_installedToString.has(proto)) return;
  _installedToString.add(proto);
  Object.defineProperty(proto, "toString", {
    configurable: true, enumerable: false,
    get(this: any) {
      const value = () => this.message;
      Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
      return value;
    },
    set(this: any, value: unknown) {
      Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
    },
  });
}

// helper methods: non-enumerable lazy getters on the shared prototype — first
// access materializes a bound own property so detached calls keep working
function _lazyMethod(proto: object, key: string, make: (self: any) => unknown): void {
  Object.defineProperty(proto, key, {
    configurable: true, enumerable: false,
    get(this: any) {
      const value = make(this);
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
      return value;
    },
    set(this: any, value: unknown) {
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
    },
  });
}

const _installedErrorProtos = new WeakSet<object>([Object.prototype, Error.prototype]);

function _zodErrorInit(inst: any, def: any[]): void {
  inst.name = "$ZodError";
  if (!inst._zod) {
    Object.defineProperty(inst, "_zod", { value: {}, enumerable: false, writable: true, configurable: true });
  }
  inst._zod.def = def;
  (inst._zod.traits ??= new Set()).add("$ZodError");
  Object.defineProperty(inst, "issues", { value: def, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(inst, "message", _messageDesc);
  _installToString(inst);
}

function _zodClassicErrorInit(inst: any, issues: any[]): void {
  _zodErrorInit(inst, issues);
  inst.name = "ZodError";
  inst._zod.traits.add("ZodError");

  const proto = Object.getPrototypeOf(inst);
  if (_installedErrorProtos.has(proto)) return;
  _installedErrorProtos.add(proto);

  _lazyMethod(proto, "format", (self) => (mapper: any) => formatError(self, mapper));
  _lazyMethod(proto, "flatten", (self) => (mapper: any) => flattenError(self, mapper));
  _lazyMethod(proto, "addIssue", (self) => (issue: any) => {
    self.issues.push(issue);
    self.message = _stringifyIssues(self.issues);
  });
  _lazyMethod(proto, "addIssues", (self) => (issues: any) => {
    self.issues.push(...issues);
    self.message = _stringifyIssues(self.issues);
  });
  Object.defineProperty(proto, "isEmpty", {
    configurable: true, enumerable: false,
    get(this: any) { return this.issues.length === 0; },
  });
}

// not a real Error — zod's $ZodError is a structural type only
export class $ZodError<T = unknown> {
  _zod!: any;
  name!: string;
  issues!: T[];
  message!: string;
  constructor(issues: T[] = []) { _zodErrorInit(this, issues as any[]); }
  static init(inst: any, def: any[]): void { _zodErrorInit(inst, def); }
  static [Symbol.hasInstance](inst: any): boolean {
    return !!inst?._zod?.traits?.has("$ZodError") || inst instanceof Error;
  }
}

// the real-Error variant — safeParse/parse throw and return this
export class $ZodEncodeError extends Error {
  constructor(name: string) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
export { $ZodEncodeError as ZodEncodeError };

export class ZodRealError<T = unknown> extends Error {
  _zod!: any;
  declare name: string;
  issues!: T[];
  declare message: string;
  constructor(issues: T[] = []) {
    super();
    _zodClassicErrorInit(this, issues as any[]);
    this._zod.traits.add("ZodRealError");
  }
  static init(inst: any, issues: any[]): void { _zodClassicErrorInit(inst, issues); }
  static [Symbol.hasInstance](inst: any): boolean {
    return inst instanceof Error || !!inst?._zod?.traits?.has("ZodError");
  }
}

export class ZodError<T = unknown> extends ZodRealError<T> {
  static init(inst: any, issues: any[]): void { _zodClassicErrorInit(inst, issues); }
  static create(issues: any[]): ZodError { return new ZodError(issues); }
  get errors(): any[] { return this.issues; }
}
Object.defineProperty(ZodRealError, "name", { value: "ZodError" });

// proto-safe own-key creation, like zod's util node()
function _node<T>(obj: any, key: PropertyKey, make: () => T): T {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    if (key === "__proto__") {
      Object.defineProperty(obj, key, { value: make(), writable: true, enumerable: true, configurable: true });
    } else {
      obj[key] = make();
    }
  }
  return obj[key];
}

export function flattenError<U>(error: $ZodError, mapper: (i: any) => U = (i) => i.message): { formErrors: U[]; fieldErrors: Record<PropertyKey, U[]> } {
  const fieldErrors: Record<PropertyKey, any> = {};
  const formErrors: U[] = [];
  for (const sub of error.issues as any[]) {
    if (sub.path.length > 0) {
      _node<U[]>(fieldErrors, sub.path[0], () => []).push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}

// wrapper issues whose nested issues inherit the wrapper's path —
// formatError and treeifyError share this traversal
const _nested = (issue: any): any[] | null =>
  issue.code === "invalid_union" && issue.errors?.length ? issue.errors
    : issue.code === "invalid_key" || issue.code === "invalid_element" ? issue.issues != null ? [issue.issues] : null
    : null;

export function formatError<U>(error: $ZodError, mapper: (i: any) => U = (i) => i.message): any {
  const fieldErrors: any = { _errors: [] };
  const processError = (error: { issues: any[] }, path: PropertyKey[] = []) => {
    for (const issue of error.issues) {
      const nested = _nested(issue);
      if (nested) {
        nested.map((issues) => processError({ issues }, [...path, ...issue.path]));
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr: any = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i]!;
            const terminal = i === fullpath.length - 1;
            // `_errors` is reserved by this legacy format — merge instead of
            // treating it as a child key
            if (el === "_errors") {
              if (terminal) curr._errors.push(mapper(issue));
              i++;
              continue;
            }
            // path elements may collide with inherited names — guard the read
            // and create the node with defineProperty so "__proto__" becomes a
            // real own key
            if (!Object.prototype.hasOwnProperty.call(curr, el)) {
              Object.defineProperty(curr, el, {
                value: { _errors: [] },
                enumerable: true, writable: true, configurable: true,
              });
            }
            const node = curr[el];
            if (terminal) node._errors.push(mapper(issue));
            curr = node;
            i++;
          }
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}

export function treeifyError<U>(error: $ZodError, mapper: (i: any) => U = (i) => i.message): any {
  const result: any = { errors: [] };
  const processError = (error: { issues: any[] }, path: PropertyKey[] = []) => {
    for (const issue of error.issues) {
      const nested = _nested(issue);
      if (nested) {
        nested.map((issues) => processError({ issues }, [...path, ...issue.path]));
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          result.errors.push(mapper(issue));
          continue;
        }
        let curr: any = result;
        let i = 0;
        while (i < fullpath.length) {
          const el = fullpath[i]!;
          const terminal = i === fullpath.length - 1;
          if (typeof el === "string") {
            curr.properties ??= {};
            if (!Object.prototype.hasOwnProperty.call(curr.properties, el)) {
              Object.defineProperty(curr.properties, el, {
                value: { errors: [] },
                enumerable: true, writable: true, configurable: true,
              });
            }
            curr = curr.properties[el];
          } else {
            curr.items ??= [];
            curr.items[el] ??= { errors: [] };
            curr = curr.items[el];
          }
          if (terminal) curr.errors.push(mapper(issue));
          i++;
        }
      }
    }
  };
  processError(error);
  return result;
}

export function toDotPath(_path: readonly (string | number | symbol | { key: PropertyKey })[]): string {
  const segs: string[] = [];
  const path: PropertyKey[] = _path.map((seg: any) => (typeof seg === "object" ? seg.key : seg));
  for (const seg of path) {
    if (typeof seg === "number") segs.push(`[${seg}]`);
    else if (typeof seg === "symbol") segs.push(`[${JSON.stringify(String(seg))}]`);
    else if (/[^\w$]/.test(seg)) segs.push(`[${JSON.stringify(seg)}]`);
    else {
      if (segs.length) segs.push(".");
      segs.push(seg);
    }
  }
  return segs.join("");
}

export function prettifyError(error: { issues: any[] }): string {
  const lines: string[] = [];
  const issues = [...error.issues].sort((a, b) => (a.path ?? []).length - (b.path ?? []).length);
  for (const issue of issues) {
    lines.push(`✖ ${issue.message}`);
    if (issue.path?.length) lines.push(`  → at ${toDotPath(issue.path)}`);
  }
  return lines.join("\n");
}
