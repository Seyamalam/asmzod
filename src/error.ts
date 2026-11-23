// error.ts — ZodError + issue types (zod3-compatible shape)

export type IssuePath = (string | number)[];

export interface ZodIssue {
  code: string;
  path: IssuePath;
  message: string;
  [key: string]: unknown;
}

export class ZodError<T = unknown> extends Error {
  issues: ZodIssue[] = [];

  constructor(issues: ZodIssue[]) {
    super();
    this.name = "ZodError";
    this.issues = issues;
    this.message = JSON.stringify(issues, null, 2);
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

  format(): { _errors: string[] } & Record<string, any> {
    const root: any = { _errors: [] };
    for (const issue of this.issues) {
      let cur = root;
      for (const p of issue.path) {
        const key = typeof p === "number" ? p : p;
        if (cur[key] === undefined) cur[key] = { _errors: [] };
        cur = cur[key];
      }
      cur._errors.push(issue.message);
    }
    return root;
  }

  flatten(): { formErrors: string[]; fieldErrors: Record<string, string[]> } {
    const formErrors: string[] = [];
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of this.issues) {
      if (issue.path.length === 0) {
        formErrors.push(issue.message);
      } else {
        const k = String(issue.path[0]);
        (fieldErrors[k] ??= []).push(issue.message);
      }
    }
    return { formErrors, fieldErrors };
  }

  toString(): string {
    return this.message;
  }
}
