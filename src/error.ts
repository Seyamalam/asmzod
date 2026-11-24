// error.ts — ZodError + issue types (zod3-compatible shape)

export type IssuePath = (string | number)[];

export interface ZodIssue {
  code: string;
  path: IssuePath;
  message: string;
  [key: string]: unknown;
}

// zod recomputes .message lazily — issues added after construction show up
const _stringify = (issues: ZodIssue[]): string => {
  try {
    return JSON.stringify(issues, null, 2);
  } catch {
    return JSON.stringify(issues, (_k, v) =>
      typeof v === "bigint" ? `${v}n` : v, 2);
  }
};

export class $ZodError<T = unknown> extends Error {
  issues: ZodIssue[] = [];

  constructor(issues: ZodIssue[] = []) {
    super();
    this.name = "$ZodError";
    this.issues = issues;
  }

  override get message(): string { return _stringify(this.issues); }
  override set message(v: string) {
    Object.defineProperty(this, "message", { value: v, writable: true, configurable: true });
  }
}

export class ZodError<T = unknown> extends $ZodError<T> {
  constructor(issues: ZodIssue[] = []) {
    super(issues);
    this.name = "ZodError";
  }

  get errors(): ZodIssue[] {
    return this.issues;
  }

  static create(issues: ZodIssue[]): ZodError {
    return new ZodError(issues);
  }

  get isEmpty(): boolean {
    return this.issues.length === 0;
  }

  addIssue(issue: ZodIssue): void {
    this.issues.push(issue);
  }

  addIssues(issues: ZodIssue[]): void {
    this.issues.push(...issues);
  }

  format(mapper?: (i: ZodIssue) => unknown): { _errors: unknown[] } & Record<string, any> {
    return formatError(this, mapper as any);
  }

  flatten(mapper?: (i: ZodIssue) => unknown): { formErrors: unknown[]; fieldErrors: Record<string, unknown[]> } {
    return flattenError(this, mapper as any);
  }

  override toString(): string {
    return this.message;
  }
}

// zod's real-Error variant — in our hierarchy ZodError already extends Error,
// so this exists purely for the instanceof surface
export class ZodRealError<T = unknown> extends ZodError<T> {}

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
  for (const sub of error.issues) {
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
