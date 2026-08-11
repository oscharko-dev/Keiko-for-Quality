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

interface FunctionShape {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
}

interface AdvancingFunction {
  readonly name: string;
  readonly parameter: string;
  readonly parameterIndex: number;
  readonly line: number;
  readonly path: string;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const IDENTIFIER_PART = /[\w$]/u;

function matchingClose(text: string, open: number, opening: string, closing: string): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === opening) depth += 1;
    if (text[index] !== closing) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function parameterNames(source: string): readonly string[] {
  return source.split(",").map((part) => {
    const separator = part.indexOf(":");
    return (separator < 0 ? part : part.slice(0, separator)).trim();
  });
}

function functionHeader(
  line: string,
): { readonly name: string; readonly parameters: readonly string[] } | undefined {
  const marker = "function ";
  const markerAt = line.indexOf(marker);
  const open = line.indexOf("(", markerAt + marker.length);
  if (markerAt < 0 || open < 0) return undefined;
  const close = matchingClose(line, open, "(", ")");
  if (close < 0) return undefined;
  const rawName = line.slice(markerAt + marker.length, open).trim();
  const generic = rawName.indexOf("<");
  const name = generic < 0 ? rawName : rawName.slice(0, generic);
  const parameters = parameterNames(line.slice(open + 1, close));
  if (!IDENTIFIER.test(name) || parameters.some((parameter) => !IDENTIFIER.test(parameter))) {
    return undefined;
  }
  return { name, parameters };
}

function functionEndLine(lines: readonly string[], start: number): number | undefined {
  let depth = 0;
  let opened = false;
  for (let lineIndex = start; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined) break;
    for (const character of line) {
      if (character === "{") {
        opened = true;
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
      }
    }
    if (opened && depth === 0) return lineIndex + 1;
  }
  return undefined;
}

function functionShapes(source: string): readonly FunctionShape[] {
  const lines = source.split("\n");
  const shapes: FunctionShape[] = [];
  for (const [index, line] of lines.entries()) {
    const header = functionHeader(line);
    if (header === undefined) continue;
    const endLine = functionEndLine(lines, index);
    if (endLine !== undefined) shapes.push({ ...header, startLine: index + 1, endLine });
  }
  return shapes;
}

function functionLines(source: string, shape: FunctionShape): readonly string[] {
  return source.split("\n").slice(shape.startLine - 1, shape.endLine);
}

function positiveGuard(line: string, parameter: string): boolean {
  const compact = line.replace(/\s+/gu, " ").trim();
  return (
    compact.startsWith("if (") &&
    (compact.includes(`${parameter} <= 0`) || compact.includes(`${parameter} < 1`)) &&
    compact.includes("throw ")
  );
}

function removedPositiveGuard(
  base: string,
  head: string,
  headShape: FunctionShape,
  parameter: string,
): boolean {
  const baseShape = functionShapes(base).find((shape) => shape.name === headShape.name);
  if (baseShape === undefined) return false;
  const baseGuarded = functionLines(base, baseShape).some((line) => positiveGuard(line, parameter));
  const headGuarded = functionLines(head, headShape).some((line) => positiveGuard(line, parameter));
  return baseGuarded && !headGuarded;
}

function advancingFunction(file: SourceTransition): AdvancingFunction | undefined {
  for (const shape of functionShapes(file.head)) {
    for (const [parameterIndex, parameter] of shape.parameters.entries()) {
      if (!removedPositiveGuard(file.base, file.head, shape, parameter)) continue;
      const relativeLine = functionLines(file.head, shape).findIndex((line) =>
        line.includes(`+= ${parameter}`),
      );
      if (relativeLine >= 0) {
        return {
          name: shape.name,
          parameter,
          parameterIndex,
          line: shape.startLine + relativeLine,
          path: file.path,
        };
      }
    }
  }
  return undefined;
}

function callOpen(line: string, name: string, offset: number): number | undefined {
  let cursor = offset;
  while (cursor < line.length) {
    const found = line.indexOf(name, cursor);
    if (found < 0) return undefined;
    const before = line[found - 1];
    let open = found + name.length;
    while (line[open] === " " || line[open] === "\t") open += 1;
    if ((before === undefined || !IDENTIFIER_PART.test(before)) && line[open] === "(") return open;
    cursor = found + name.length;
  }
  return undefined;
}

function splitArguments(source: string): readonly string[] {
  const arguments_: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (character !== "," || depth !== 0) continue;
    arguments_.push(source.slice(start, index).trim());
    start = index + 1;
  }
  arguments_.push(source.slice(start).trim());
  return arguments_;
}

function callArguments(line: string, name: string): readonly (readonly string[])[] {
  const calls: (readonly string[])[] = [];
  let offset = 0;
  while (offset < line.length) {
    const open = callOpen(line, name, offset);
    if (open === undefined) break;
    const close = matchingClose(line, open, "(", ")");
    if (close < 0) break;
    calls.push(splitArguments(line.slice(open + 1, close)));
    offset = close + 1;
  }
  return calls;
}

function shownZeroCaller(files: readonly SourceTransition[], target: AdvancingFunction): boolean {
  return files.some(
    (file) =>
      file.path !== target.path &&
      file.head
        .split("\n")
        .some((line) =>
          callArguments(line, target.name).some((arguments_) =>
            /\?\?\s*0\b/u.test(arguments_[target.parameterIndex] ?? ""),
          ),
        ),
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
        "`?? 0` fallback for that step. The reachable zero prevents the loop index from " +
        "advancing and can hang the caller indefinitely.",
    });
  }
  return findings;
}
