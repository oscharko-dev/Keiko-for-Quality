import type { EngineFinding } from "../engine/result.js";

export interface SourceTransition {
  readonly path: string;
  readonly base: string;
  readonly head: string;
}

export interface CrossFileRegression {
  readonly path: string;
  readonly line: number;
  readonly category: NonNullable<EngineFinding["category"]>;
  readonly severity: NonNullable<EngineFinding["severity"]>;
  readonly content: string;
}

interface AdvancingFunction {
  readonly name: string;
  readonly parameter: string;
  readonly line: number;
  readonly path: string;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

function functionShape(
  line: string,
): { readonly name: string; readonly parameters: readonly string[] } | undefined {
  const marker = "function ";
  const markerAt = line.indexOf(marker);
  const open = line.indexOf("(", markerAt + marker.length);
  const close = line.lastIndexOf(")");
  if (markerAt < 0 || open < 0 || close <= open) return undefined;
  const rawName = line.slice(markerAt + marker.length, open).trim();
  const generic = rawName.indexOf("<");
  const name = generic < 0 ? rawName : rawName.slice(0, generic);
  if (!IDENTIFIER.test(name)) return undefined;
  const parameters = line
    .slice(open + 1, close)
    .split(",")
    .map((part) => {
      const separator = part.indexOf(":");
      return (separator < 0 ? part : part.slice(0, separator)).trim();
    })
    .filter((parameter) => IDENTIFIER.test(parameter));
  return { name, parameters };
}

function removedPositiveGuard(base: string, head: string, parameter: string): boolean {
  const guarded = base.split("\n").some((line) => {
    const compact = line.replace(/\s+/gu, " ").trim();
    return (
      compact.startsWith("if (") &&
      (compact.includes(`${parameter} <= 0`) || compact.includes(`${parameter} < 1`)) &&
      compact.includes("throw ")
    );
  });
  if (!guarded) return false;
  return !head.split("\n").some((line) => {
    const compact = line.replace(/\s+/gu, " ").trim();
    return compact.startsWith("if (") && compact.includes(parameter) && compact.includes("throw ");
  });
}

function advancingFunction(file: SourceTransition): AdvancingFunction | undefined {
  for (const line of file.head.split("\n")) {
    const shape = functionShape(line);
    if (shape === undefined) continue;
    for (const parameter of shape.parameters) {
      if (!removedPositiveGuard(file.base, file.head, parameter)) continue;
      const loopLine = file.head
        .split("\n")
        .findIndex((candidate) => candidate.includes(`+= ${parameter}`));
      if (loopLine >= 0) {
        return { name: shape.name, parameter, line: loopLine + 1, path: file.path };
      }
    }
  }
  return undefined;
}

function shownZeroCaller(files: readonly SourceTransition[], target: AdvancingFunction): boolean {
  return files.some(
    (file) =>
      file.path !== target.path &&
      file.head
        .split("\n")
        .some((line) => line.includes(`${target.name}(`) && line.includes("?? 0")),
  );
}

/** Finds a removed positive-step guard only when this diff also shows a zero-valued caller. */
export function detectCrossFileRegressions(
  files: readonly SourceTransition[],
): readonly CrossFileRegression[] {
  const findings: CrossFileRegression[] = [];
  for (const file of files) {
    const target = advancingFunction(file);
    if (target === undefined || !shownZeroCaller(files, target)) continue;
    findings.push({
      path: target.path,
      line: target.line,
      category: "bug",
      severity: "high",
      content:
        "Restore the positive-step guard.\n\n" +
        `The loop advances with \`${target.parameter}\`, but the change removes the shown ` +
        `non-positive guard while another changed file now calls \`${target.name}\` with a ` +
        "`?? 0` fallback. That reachable zero step prevents the loop index from advancing and " +
        "can hang the caller indefinitely.",
    });
  }
  return findings;
}
