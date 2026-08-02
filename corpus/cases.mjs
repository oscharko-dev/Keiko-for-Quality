/**
 * The seeded-defect corpus.
 *
 * Each case is a minimal two-commit history: a `base` that is correct and a `head` that introduces
 * exactly one known defect — or, for the precision cases, no defect at all. Small diffs are
 * deliberate: a case that fails should point at one behaviour, not at a haystack, and a large diff
 * would measure the model's stamina rather than its judgement.
 *
 * `expect.find` is the recall bar. `expect.find === false` is the precision bar, and those cases
 * matter more than they look: a reviewer that reports something on every change trains its readers
 * to ignore it, which is worse than one that misses a defect.
 *
 * `severity` and `category` are the classification the rule text asks for. They are scored
 * separately from detection, because a found defect filed as a nit is a different failure from a
 * missed defect.
 */
export const CASES = [
  {
    id: "auth-prefix-compare",
    lang: "ts",
    file: "src/auth.ts",
    category: "security",
    severity: "critical",
    base: `export function checkToken(provided: string, expected: string): boolean {
  return provided === expected;
}
`,
    head: `export function checkToken(provided: string, expected: string): boolean {
  // Compare only the prefix so short tokens validate faster.
  return provided.slice(0, 8) === expected.slice(0, 8);
}
`,
    expect: { find: true, about: "authentication bypass via prefix comparison" },
  },
  {
    id: "sql-string-concat",
    lang: "ts",
    file: "src/query.ts",
    category: "security",
    severity: "critical",
    base: `export function findUser(db: Db, name: string): Promise<Row[]> {
  return db.query("SELECT * FROM users WHERE name = ?", [name]);
}
`,
    head: `export function findUser(db: Db, name: string): Promise<Row[]> {
  return db.query(\`SELECT * FROM users WHERE name = '\${name}'\`);
}
`,
    expect: { find: true, about: "SQL injection through interpolated input" },
  },
  {
    id: "path-traversal",
    lang: "ts",
    file: "src/files.ts",
    category: "security",
    severity: "high",
    base: `import { resolve, relative } from "node:path";

export function readInWorkspace(root: string, requested: string): string {
  const target = resolve(root, requested);
  if (relative(root, target).startsWith("..")) throw new Error("outside workspace");
  return target;
}
`,
    head: `import { resolve } from "node:path";

export function readInWorkspace(root: string, requested: string): string {
  return resolve(root, requested);
}
`,
    expect: { find: true, about: "removed workspace-escape guard" },
  },
  {
    id: "unclosed-handle",
    lang: "ts",
    file: "src/config.ts",
    category: "bug",
    // Corrected after the first measured run. The rubric this corpus scores against says high is
    // "wrong behaviour on a reachable path"; the handle leaks on every call, so high is right and
    // the original medium was my error, not the model's.
    severity: "high",
    base: `import { open } from "node:fs/promises";

export async function loadConfig(path: string): Promise<string> {
  const handle = await open(path);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
`,
    head: `import { open } from "node:fs/promises";

export async function loadConfig(path: string): Promise<string> {
  const handle = await open(path);
  return handle.readFile("utf8");
}
`,
    expect: { find: true, about: "leaked file handle" },
  },
  {
    id: "swallowed-error",
    lang: "ts",
    file: "src/sync.ts",
    category: "bug",
    severity: "high",
    base: `export async function sync(client: Client): Promise<void> {
  try {
    await client.push();
  } catch (error) {
    logger.error("push failed", { correlationId: client.id });
    throw error;
  }
}
`,
    head: `export async function sync(client: Client): Promise<void> {
  try {
    await client.push();
  } catch {
    // ignore
  }
}
`,
    expect: { find: true, about: "silently swallowed failure" },
  },
  {
    id: "off-by-one",
    lang: "ts",
    file: "src/window.ts",
    category: "bug",
    // Corrected: `lastN(items, 10)` on three items silently returns all three instead of erroring.
    // Wrong behaviour on a reachable path — high by the same rubric.
    severity: "high",
    base: `export function lastN<T>(items: readonly T[], n: number): readonly T[] {
  return items.slice(Math.max(0, items.length - n));
}
`,
    head: `export function lastN<T>(items: readonly T[], n: number): readonly T[] {
  return items.slice(items.length - n);
}
`,
    expect: { find: true, about: "negative index when n exceeds length" },
  },
  {
    id: "race-check-then-act",
    lang: "ts",
    file: "src/lock.ts",
    category: "bug",
    severity: "high",
    base: `export async function acquire(store: Store, key: string): Promise<boolean> {
  return store.setIfAbsent(key, "held");
}
`,
    head: `export async function acquire(store: Store, key: string): Promise<boolean> {
  if (await store.has(key)) return false;
  await store.set(key, "held");
  return true;
}
`,
    expect: { find: true, about: "check-then-act race replacing an atomic operation" },
  },
  {
    id: "weakened-assertion",
    lang: "ts",
    file: "src/parser.test.ts",
    category: "test",
    severity: "high",
    base: `it("rejects a malformed header", () => {
  expect(() => parse(MALFORMED)).toThrow(ValidationError);
});
`,
    head: `it("rejects a malformed header", () => {
  expect(() => parse(MALFORMED)).not.toBeUndefined();
});
`,
    expect: { find: true, about: "assertion weakened so it can no longer fail" },
  },
  {
    id: "missing-timeout",
    lang: "ts",
    file: "src/fetchers.ts",
    category: "bug",
    // A removed timeout is a removed safety check, which the rubric puts at high. The model filed
    // it as `performance`; the rule text now says a removed guard is `bug` regardless of what it
    // guards against, because "performance" should mean the cost of correct code.
    severity: "high",
    base: `export function fetchModel(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(30_000) });
}
`,
    head: `export function fetchModel(url: string): Promise<Response> {
  return fetch(url);
}
`,
    expect: { find: true, about: "removed request timeout" },
  },
  {
    id: "secret-in-log",
    lang: "ts",
    file: "src/audit.ts",
    category: "security",
    severity: "high",
    base: `export function recordAuth(logger: Logger, user: string): void {
  logger.info("auth attempt", { user });
}
`,
    head: `export function recordAuth(logger: Logger, user: string, token: string): void {
  logger.info("auth attempt", { user, token });
}
`,
    expect: { find: true, about: "credential written to a log" },
  },

  // --- Precision cases: a correct change must produce no finding. ---
  {
    id: "clean-refactor",
    lang: "ts",
    file: "src/format.ts",
    category: null,
    severity: null,
    base: `export function label(kind: string): string {
  if (kind === "a") return "Alpha";
  if (kind === "b") return "Beta";
  return "Unknown";
}
`,
    head: `const LABELS: Record<string, string> = { a: "Alpha", b: "Beta" };

export function label(kind: string): string {
  return LABELS[kind] ?? "Unknown";
}
`,
    expect: { find: false, about: "behaviour-preserving refactor" },
  },
  {
    id: "clean-added-guard",
    lang: "ts",
    file: "src/divide.ts",
    category: null,
    severity: null,
    base: `export function ratio(a: number, b: number): number {
  return a / b;
}
`,
    head: `export function ratio(a: number, b: number): number {
  if (b === 0) throw new RangeError("division by zero");
  return a / b;
}
`,
    expect: { find: false, about: "a change that strictly improves safety" },
  },
  {
    id: "clean-added-test",
    lang: "ts",
    file: "src/ratio.test.ts",
    category: null,
    severity: null,
    base: `it("divides", () => {
  expect(ratio(6, 3)).toBe(2);
});
`,
    head: `it("divides", () => {
  expect(ratio(6, 3)).toBe(2);
});

it("rejects a zero denominator", () => {
  expect(() => ratio(1, 0)).toThrow(RangeError);
});
`,
    expect: { find: false, about: "a strengthened test suite" },
  },
];
