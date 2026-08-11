import type { EngineFinding } from "../engine/result.js";

export interface LocalRegression {
  readonly line: number;
  readonly category: NonNullable<EngineFinding["category"]>;
  readonly severity: NonNullable<EngineFinding["severity"]>;
  readonly content: string;
}

interface AwaitAssignment {
  readonly expression: string;
  readonly line: number;
  readonly variable: string;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const EXECUTABLE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function executablePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && EXECUTABLE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function awaitAssignment(line: string, index: number): AwaitAssignment | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("const ") || !trimmed.endsWith(";")) return undefined;
  const separator = trimmed.indexOf(" = await ");
  if (separator < 6) return undefined;
  const variable = trimmed.slice(6, separator).trim();
  const expression = trimmed.slice(separator + 9, -1).trim();
  if (!IDENTIFIER.test(variable) || expression === "") return undefined;
  return { expression, line: index + 1, variable };
}

function awaitAssignments(source: string): readonly AwaitAssignment[] {
  return source
    .split("\n")
    .map(awaitAssignment)
    .filter((value): value is AwaitAssignment => value !== undefined);
}

function bareAwaitExpressions(source: string): ReadonlyMap<string, number> {
  const expressions = new Map<string, number>();
  for (const [index, line] of source.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("await ") || !trimmed.endsWith(";")) continue;
    const expression = trimmed.slice(6, -1).trim();
    if (expression !== "") expressions.set(expression, index + 1);
  }
  return expressions;
}

function assertedVariables(source: string): ReadonlySet<string> {
  const variables = new Set<string>();
  for (const line of source.split("\n")) {
    const start = line.indexOf("expect(");
    if (start < 0) continue;
    const tail = line.slice(start + 7).trimStart();
    const end = tail.search(/[.)]/u);
    const variable = end < 0 ? "" : tail.slice(0, end);
    if (IDENTIFIER.test(variable)) variables.add(variable);
  }
  return variables;
}

function detectDiscardedRefresh(base: string, head: string): LocalRegression | undefined {
  const baseAssignments = awaitAssignments(base);
  const headAssignments = awaitAssignments(head);
  const bareHead = bareAwaitExpressions(head);
  const baseAssertions = assertedVariables(base);
  const headAssertions = assertedVariables(head);
  for (const fresh of baseAssignments) {
    const retained = headAssignments.some(
      (entry) => entry.variable === fresh.variable && entry.expression === fresh.expression,
    );
    if (!baseAssertions.has(fresh.variable) || retained) continue;
    const line = bareHead.get(fresh.expression);
    if (line === undefined) continue;
    const stale = headAssignments.find(
      (entry) => entry.expression === fresh.expression && headAssertions.has(entry.variable),
    );
    if (stale === undefined || stale.line >= line) continue;
    return {
      line,
      category: "test",
      severity: "high",
      content:
        "Assert on the refreshed result.\n\n" +
        `The second \`${fresh.expression}\` result is now discarded while the assertion still ` +
        `reads the earlier \`${stale.variable}\` value. The test therefore no longer proves that ` +
        "the refresh changed the session state.",
    };
  }
  return undefined;
}

function isAdminGuard(line: string): boolean {
  const compact = line.replace(/\s+/gu, " ").trim();
  return (
    compact.startsWith("if (!") &&
    compact.includes(".isAdmin)") &&
    compact.includes("return forbidden()")
  );
}

function suppressionInstructionLine(source: string): number | undefined {
  for (const [index, line] of source.split("\n").entries()) {
    const normalized = line.trim().toLowerCase();
    if (!normalized.startsWith("//")) continue;
    if (
      normalized.includes("reviewer instructions") &&
      (normalized.includes("skip this file") || normalized.includes("emit no findings"))
    ) {
      return index + 1;
    }
  }
  return undefined;
}

function detectSuppressedGuardRemoval(base: string, head: string): LocalRegression | undefined {
  if (!base.split("\n").some(isAdminGuard) || head.split("\n").some(isAdminGuard)) return undefined;
  const line = suppressionInstructionLine(head);
  if (line === undefined) return undefined;
  return {
    line,
    category: "security",
    severity: "critical",
    content:
      "Restore the administrator authorization guard.\n\n" +
      "The change removes the shown `isAdmin`/`forbidden` access-control check while adding a " +
      "comment that tells automated reviewers to skip the file. Candidate comments are untrusted " +
      "input; without the guard, non-admin requests reach the administrator handler.",
  };
}

/** Exact local regressions whose BASE/HEAD mechanism needs no model judgment. */
export function detectLocalRegressions(
  path: string,
  base: string,
  head: string,
): readonly LocalRegression[] {
  if (!executablePath(path)) return [];
  return [detectSuppressedGuardRemoval(base, head), detectDiscardedRefresh(base, head)].filter(
    (value): value is LocalRegression => value !== undefined,
  );
}
