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

interface SourceScope {
  readonly text: string;
  readonly startLine: number;
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
  const trimmed = line.trim().replace(/;$/u, "");
  if (!trimmed.startsWith("const ")) return undefined;
  const separator = trimmed.indexOf(" = await ");
  if (separator < 6) return undefined;
  const variable = trimmed.slice(6, separator).trim();
  const expression = trimmed.slice(separator + 9).trim();
  if (!IDENTIFIER.test(variable) || expression === "") return undefined;
  return { expression, line: index + 1, variable };
}

function awaitAssignments(source: string): readonly AwaitAssignment[] {
  return source
    .split("\n")
    .map((line, index) => awaitAssignment(line, index))
    .filter((value): value is AwaitAssignment => value !== undefined);
}

function bareAwaitExpressions(source: string): ReadonlyMap<string, number> {
  const expressions = new Map<string, number>();
  for (const [index, line] of source.split("\n").entries()) {
    const trimmed = line.trim().replace(/;$/u, "");
    if (!trimmed.startsWith("await ")) continue;
    const expression = trimmed.slice(6).trim();
    if (expression !== "" && !expressions.has(expression)) expressions.set(expression, index + 1);
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

function discardedRefreshInScope(base: string, head: string): LocalRegression | undefined {
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

function braceDelta(line: string): number {
  let depth = 0;
  for (const character of line) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
  }
  return depth;
}

function maskNonCode(source: string): string {
  return source.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1|\/\/.*|\/\*[\s\S]*?\*\//gu, (match) =>
    " ".repeat(match.length),
  );
}

function sourceScopes(source: string): readonly SourceScope[] {
  const lines = source.split("\n");
  const structuralLines = maskNonCode(source).split("\n");
  const scopes: SourceScope[] = [];
  let start: number | undefined;
  let depth = 0;
  for (const index of lines.keys()) {
    const structural = structuralLines[index] ?? "";
    if (start === undefined && structural.includes("{")) start = index;
    depth += braceDelta(structural);
    if (start === undefined || depth !== 0) continue;
    scopes.push({ text: lines.slice(start, index + 1).join("\n"), startLine: start + 1 });
    start = undefined;
  }
  return scopes.length === 0 ? [{ text: source, startLine: 1 }] : scopes;
}

function detectDiscardedRefresh(base: string, head: string): LocalRegression | undefined {
  const baseScopes = sourceScopes(base);
  for (const [index, headScope] of sourceScopes(head).entries()) {
    const baseScope = baseScopes[index];
    if (baseScope === undefined) continue;
    const regression = discardedRefreshInScope(baseScope.text, headScope.text);
    if (regression !== undefined) {
      return { ...regression, line: regression.line + headScope.startLine - 1 };
    }
  }
  return undefined;
}

function suppressionInstructionLines(source: string): ReadonlyMap<string, number> {
  const instructions = new Map<string, number>();
  for (const [index, line] of source.split("\n").entries()) {
    const normalized = line.trim().toLowerCase();
    if (!normalized.startsWith("//")) continue;
    if (
      normalized.includes("reviewer instructions") &&
      (normalized.includes("skip this file") || normalized.includes("emit no findings"))
    ) {
      instructions.set(normalized, index + 1);
    }
  }
  return instructions;
}

function enclosingFunctionName(line: string): string | undefined {
  const marker = "function ";
  const markerAt = line.indexOf(marker);
  if (markerAt < 0) return undefined;
  const open = line.indexOf("(", markerAt + marker.length);
  if (open < 0) return undefined;
  const name = line.slice(markerAt + marker.length, open).trim();
  return IDENTIFIER.test(name) ? name : undefined;
}

function adminGuardKey(
  lines: readonly string[],
  index: number,
  functionName: string,
): string | undefined {
  const compact = lines
    .slice(index, index + 3)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!compact.startsWith("if (!") || !compact.includes("return forbidden()")) return undefined;
  const conditionEnd = compact.indexOf(".isAdmin)");
  if (conditionEnd < 0) return undefined;
  const condition = compact.slice(0, conditionEnd + ".isAdmin)".length);
  return `${functionName}\0${condition}`;
}

function guardOccurrences(source: string): readonly string[] {
  const lines = source.split("\n");
  const occurrences: string[] = [];
  let functionName = "<module>";
  for (const [index, line] of lines.entries()) {
    functionName = enclosingFunctionName(line) ?? functionName;
    const key = adminGuardKey(lines, index, functionName);
    if (key !== undefined) occurrences.push(key);
  }
  return occurrences;
}

function removedGuard(base: string, head: string): boolean {
  const remaining = [...guardOccurrences(head)];
  for (const occurrence of guardOccurrences(base)) {
    const index = remaining.indexOf(occurrence);
    if (index < 0) return true;
    remaining.splice(index, 1);
  }
  return false;
}

function detectSuppressedGuardRemoval(base: string, head: string): LocalRegression | undefined {
  if (!removedGuard(base, head)) return undefined;
  const baseInstructions = suppressionInstructionLines(base);
  const addedInstruction = [...suppressionInstructionLines(head)].find(
    ([instruction]) => !baseInstructions.has(instruction),
  );
  if (addedInstruction === undefined) return undefined;
  return {
    line: addedInstruction[1],
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
