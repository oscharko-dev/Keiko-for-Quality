import type { JudgeableFinding, VerificationEvidenceRef } from "./substantiate.js";

/** A deterministic proof licensed only by source material bound by the caller. */
export interface ClosedClaimProof {
  readonly evidenceRefs: readonly VerificationEvidenceRef[];
}

const TRUSTED_HUNK_EVIDENCE: unique symbol = Symbol("keiko-for-quality.trusted-hunk-evidence");

/**
 * Exact source plus the bounded dossier rendered from it. Production constructs this only after
 * Git object binding; the historical replay does the same from immutable original commits.
 */
export interface TrustedHunkEvidence {
  readonly text: string;
  readonly headSource: string | undefined;
  readonly baseSource: string | undefined;
  readonly [TRUSTED_HUNK_EVIDENCE]: true;
}

interface SourceLine {
  readonly line: number;
  readonly text: string;
  readonly code: string;
  readonly changed: boolean;
  readonly depth: number;
}

interface MapWrite {
  readonly receiver: string;
  readonly key: string;
  readonly line: SourceLine;
}

const HEAD_ROW = /^H:([1-9]\d*)\| (.*)$/u;
const BASE_ROW = /^B:([1-9]\d*)\| (.*)$/u;
const CHANGED_HEAD_ROW = /^D:H:([1-9]\d*)\| \+(.*)$/u;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const MAX_CLAIM_CHARS = 8_192;
const ERROR_SINK = [
  String.raw`(?:window\.)?reportError`,
  "(?:captureException|captureError|reportException|recordException)",
  String.raw`(?:console|logger|telemetry|diagnostics?)\.(?:error|exception|report|record)`,
].join("|");

function sourceRows(source: string | undefined): readonly string[] | undefined {
  if (source === undefined) return undefined;
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n");
}

function rowMatchesSource(row: RegExpExecArray, source: readonly string[] | undefined): boolean {
  const line = Number(row[1]);
  return source !== undefined && row[2] !== undefined && source[line - 1] === row[2];
}

function dossierMatchesSources(
  text: string,
  head: readonly string[] | undefined,
  base: readonly string[] | undefined,
): boolean {
  let sourceRowsSeen = 0;
  for (const row of text.split("\n")) {
    const headRow = HEAD_ROW.exec(row);
    if (headRow !== null) {
      if (!rowMatchesSource(headRow, head)) return false;
      sourceRowsSeen += 1;
      continue;
    }
    const baseRow = BASE_ROW.exec(row);
    if (baseRow !== null) {
      if (!rowMatchesSource(baseRow, base)) return false;
      sourceRowsSeen += 1;
      continue;
    }
    const changed = CHANGED_HEAD_ROW.exec(row);
    if (changed !== null && !rowMatchesSource(changed, head)) return false;
  }
  return sourceRowsSeen > 0;
}

/**
 * Establish the trusted-evidence boundary after callers have read immutable Git sources. The
 * dossier rows are checked against those sources so arbitrary `H:`/`D:H:` prose cannot be branded.
 */
export function bindTrustedHunkEvidence(input: {
  readonly text: string;
  readonly headSource: string | undefined;
  readonly baseSource: string | undefined;
}): TrustedHunkEvidence | undefined {
  const head = sourceRows(input.headSource);
  const base = sourceRows(input.baseSource);
  if (input.text === "" || !dossierMatchesSources(input.text, head, base)) return undefined;
  return Object.freeze({ ...input, [TRUSTED_HUNK_EVIDENCE]: true }) as TrustedHunkEvidence;
}

function carriesTrustedEvidenceBrand(value: object): boolean {
  return Reflect.get(value, TRUSTED_HUNK_EVIDENCE) === true;
}

function changedHeadLines(evidence: string): ReadonlySet<number> {
  const changed = new Set<number>();
  for (const row of evidence.split("\n")) {
    const diff = CHANGED_HEAD_ROW.exec(row);
    if (diff?.[1] !== undefined) changed.add(Number(diff[1]));
  }
  return changed;
}

type LexicalState = "code" | "single" | "double" | "template" | "block" | "regex";

interface MaskCursor {
  state: LexicalState;
  escaped: boolean;
}

interface MaskStep {
  readonly text: string;
  readonly skip: number;
  readonly stop: boolean;
  readonly significant?: string;
}

function startsRegex(previous: string): boolean {
  return previous === "" || "=(:,[!&|?{};".includes(previous);
}

function closesMaskedState(state: LexicalState, current: string): boolean {
  if (state === "single") return current === "'";
  if (state === "double") return current === '"';
  if (state === "template") return current === "`";
  return state === "regex" && current === "/";
}

function maskNonCode(cursor: MaskCursor, current: string, next: string): MaskStep {
  if (cursor.state === "block") {
    if (current === "*" && next === "/") {
      cursor.state = "code";
      return { text: "  ", skip: 1, stop: false };
    }
    return { text: " ", skip: 0, stop: false };
  }
  if (cursor.escaped) {
    cursor.escaped = false;
    return { text: " ", skip: 0, stop: false };
  }
  if (current === "\\") {
    cursor.escaped = true;
    return { text: " ", skip: 0, stop: false };
  }
  if (closesMaskedState(cursor.state, current)) cursor.state = "code";
  return { text: " ", skip: 0, stop: false };
}

function quoteState(current: string): LexicalState {
  if (current === "'") return "single";
  if (current === '"') return "double";
  return "template";
}

function isQuote(current: string): boolean {
  return ["'", '"', "`"].includes(current);
}

function maskCode(cursor: MaskCursor, current: string, next: string, previous: string): MaskStep {
  if (current === "/" && next === "/") return { text: "", skip: 0, stop: true };
  if (current === "/" && next === "*") {
    cursor.state = "block";
    return { text: "  ", skip: 1, stop: false };
  }
  if (isQuote(current)) {
    cursor.state = quoteState(current);
    return { text: " ", skip: 0, stop: false };
  }
  if (current === "/" && startsRegex(previous)) {
    cursor.state = "regex";
    return { text: " ", skip: 0, stop: false };
  }
  return {
    text: current,
    skip: 0,
    stop: false,
    ...(/\s/u.test(current) ? {} : { significant: current }),
  };
}

function maskLine(rawLine: string, cursor: MaskCursor): string {
  let output = "";
  let previous = "";
  for (let index = 0; index < rawLine.length; index += 1) {
    const current = rawLine[index] ?? "";
    const next = rawLine[index + 1] ?? "";
    const step =
      cursor.state === "code"
        ? maskCode(cursor, current, next, previous)
        : maskNonCode(cursor, current, next);
    if (step.stop) return output.padEnd(rawLine.length, " ");
    output += step.text;
    index += step.skip;
    if (step.significant !== undefined) previous = step.significant;
  }
  if (["single", "double", "regex"].includes(cursor.state)) cursor.state = "code";
  return output;
}

/** Mask prose-shaped syntax while preserving code offsets and structural braces. */
function maskSource(source: string): readonly string[] {
  const cursor: MaskCursor = { state: "code", escaped: false };
  return (sourceRows(source) ?? []).map((line) => maskLine(line, cursor));
}

function sourceLines(source: string, changed: ReadonlySet<number>): readonly SourceLine[] {
  const raw = sourceRows(source) ?? [];
  const masked = maskSource(source);
  let depth = 0;
  return raw.map((text, index) => {
    const code = masked[index] ?? "";
    const line = { line: index + 1, text, code, changed: changed.has(index + 1), depth };
    for (const character of code) {
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }
    return line;
  });
}

function refsAt(line: number): readonly VerificationEvidenceRef[] {
  return [
    `D:H:${String(line)}` as VerificationEvidenceRef,
    `H:${String(line)}` as VerificationEvidenceRef,
  ];
}

function insideFinding(line: number, finding: JudgeableFinding): boolean {
  return line >= finding.startLine && line <= finding.endLine;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function sinkUsesCaughtBinding(text: string, binding: string): boolean {
  const argument = escaped(binding);
  return new RegExp(String.raw`\b(?:${ERROR_SINK})\s*\(\s*${argument}\s*(?:[,)]|$)`, "u").test(
    text,
  );
}

function disclosureClaim(content: string): boolean {
  const claim = content.slice(0, MAX_CLAIM_CHARS);
  return (
    /(?:saniti[sz]|redact|leak|expos|secret|sensitive)/iu.test(claim) &&
    /(?:error|exception|report|log|telemetry|parser)/iu.test(claim)
  );
}

function bindingReassigned(text: string, binding: string): boolean {
  const name = escaped(binding);
  return new RegExp(
    String.raw`\b${name}\s*(?:\+\+|--|(?:&&|\|\||\?\?|[-+*/%&|^])?=(?!=))`,
    "u",
  ).test(text);
}

function matchingBrace(lines: readonly SourceLine[], openingIndex: number): number | undefined {
  let balance = 0;
  for (let index = openingIndex; index < lines.length; index += 1) {
    const code = lines[index]?.code ?? "";
    const openingOffset = index === openingIndex ? code.lastIndexOf("{") : 0;
    if (openingOffset < 0) return undefined;
    for (const character of code.slice(openingOffset)) {
      if (character === "{") {
        balance += 1;
      }
      if (character === "}") balance -= 1;
      if (balance === 0) return index;
    }
  }
  return undefined;
}

function baseContainsCaughtSink(baseSource: string | undefined): boolean {
  if (baseSource === undefined) return false;
  const priorSink = new RegExp(String.raw`\b(?:${ERROR_SINK})\s*\(\s*[A-Za-z_$][\w$]*\s*[,)]`, "u");
  return maskSource(baseSource).some((line) => priorSink.test(line));
}

function catchBinding(finding: JudgeableFinding, line: SourceLine): string | undefined {
  if (line.line < finding.startLine - 8 || line.line > finding.endLine) return undefined;
  const binding = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/u.exec(line.code)?.[1];
  return binding !== undefined && IDENTIFIER.test(binding) ? binding : undefined;
}

function changedSinkInCatch(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
  catchIndex: number,
  binding: string,
): SourceLine | undefined {
  const closeIndex = matchingBrace(lines, catchIndex);
  if (closeIndex === undefined) return undefined;
  for (let index = catchIndex + 1; index < closeIndex; index += 1) {
    const candidate = lines[index];
    if (candidate === undefined || bindingReassigned(candidate.code, binding)) return undefined;
    if (!candidate.changed || !insideFinding(candidate.line, finding)) continue;
    if (sinkUsesCaughtBinding(candidate.code, binding)) return candidate;
  }
  return undefined;
}

function catchDisclosureProof(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
  baseSource: string | undefined,
): ClosedClaimProof | undefined {
  if (!disclosureClaim(finding.content) || baseContainsCaughtSink(baseSource)) return undefined;
  for (const [catchIndex, line] of lines.entries()) {
    const binding = catchBinding(finding, line);
    if (binding === undefined) continue;
    const sink = changedSinkInCatch(finding, lines, catchIndex, binding);
    if (sink !== undefined) return { evidenceRefs: refsAt(sink.line) };
  }
  return undefined;
}

function mapWriteAtFinding(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
): MapWrite | undefined {
  for (const line of lines) {
    if (!line.changed || !insideFinding(line.line, finding)) continue;
    const call =
      /^\s*([A-Za-z_$][\w$]*)\.set\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*,/u.exec(
        line.code,
      );
    if (call?.[1] !== undefined && call[2] !== undefined) {
      return { receiver: call[1], key: call[2], line };
    }
  }
  return undefined;
}

function nativeMapIsUnshadowed(lines: readonly SourceLine[]): boolean {
  return !lines.some((line) =>
    /\b(?:const|let|var|class|function|interface|type)\s+Map\b|\bimport\s+(?:Map\b|\*\s+as\s+Map\b|\{[^}]*\bMap\b)|\([^)]*\bMap\b[^)]*\)\s*(?:=>|\{)/u.test(
      line.code,
    ),
  );
}

function mapDeclaration(lines: readonly SourceLine[], write: MapWrite): SourceLine | undefined {
  const receiver = escaped(write.receiver);
  const declaration = new RegExp(
    String.raw`^\s*const\s+${receiver}\s*=\s*new\s+Map(?:\s*<[^;]+>)?\s*\(`,
    "u",
  );
  const matches = lines.filter(
    (line) => line.line < write.line.line && declaration.test(line.code),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function isInputLoopCandidate(
  line: SourceLine | undefined,
  declaration: SourceLine,
  write: MapWrite,
): line is SourceLine {
  if (line === undefined) return false;
  if (line.line <= declaration.line || line.line >= write.line.line) return false;
  return line.depth === declaration.depth && /\bfor\s*\([^)]*\bof\b[^)]*\)\s*\{/u.test(line.code);
}

function loopRepeatsAfterWrite(
  lines: readonly SourceLine[],
  opening: number,
  write: MapWrite,
): number | undefined {
  const closing = matchingBrace(lines, opening);
  if (closing === undefined || lines[closing] === undefined) return undefined;
  if (lines[closing].line <= write.line.line) return undefined;
  const exits = lines
    .slice(write.line.line, closing)
    .some((candidate) => /^\s*(?:break|return|throw)\b/u.test(candidate.code));
  return exits ? undefined : closing;
}

function enclosingInputLoop(
  lines: readonly SourceLine[],
  declaration: SourceLine,
  write: MapWrite,
): { readonly opening: number; readonly closing: number } | undefined {
  if (write.line.depth !== declaration.depth + 1) return undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!isInputLoopCandidate(line, declaration, write)) continue;
    const closing = loopRepeatsAfterWrite(lines, index, write);
    if (closing !== undefined) return { opening: index, closing };
  }
  return undefined;
}

function receiverBindingIsStable(
  lines: readonly SourceLine[],
  declaration: SourceLine,
  write: MapWrite,
): boolean {
  const receiver = escaped(write.receiver);
  const redeclared = new RegExp(
    String.raw`\b(?:const|let|var|class|function)\s+${receiver}\b`,
    "u",
  );
  const reassigned = new RegExp(
    String.raw`\b${receiver}\s*(?:\+\+|--|(?:&&|\|\||\?\?|[-+*/%&|^])?=(?!=))`,
    "u",
  );
  return !lines.some(
    (line) =>
      line.line > declaration.line &&
      line.line < write.line.line &&
      (redeclared.test(line.code) || reassigned.test(line.code)),
  );
}

function hasDuplicateGuard(
  lines: readonly SourceLine[],
  declaration: SourceLine,
  write: MapWrite,
): boolean {
  const receiver = escaped(write.receiver);
  const key = escaped(write.key).replace(/\s+/gu, String.raw`\s*`);
  const directGuard = new RegExp(String.raw`\b${receiver}\.has\(\s*${key}\s*\)`, "u");
  return lines.some(
    (line) =>
      line.line > declaration.line && line.line < write.line.line && directGuard.test(line.code),
  );
}

function baseContainsMapWrite(baseSource: string | undefined, key: string): boolean {
  if (baseSource === undefined) return false;
  const escapedKey = escaped(key).replace(/\s+/gu, String.raw`\s*`);
  const priorWrite = new RegExp(String.raw`^\s*[A-Za-z_$][\w$]*\.set\(\s*${escapedKey}\s*,`, "u");
  return maskSource(baseSource).some((line) => priorWrite.test(line));
}

function duplicateMapProof(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
  baseSource: string | undefined,
): ClosedClaimProof | undefined {
  const claim = finding.content.slice(0, MAX_CLAIM_CHARS);
  if (!/\bduplicate[sd]?\b/iu.test(claim)) return undefined;
  if (!/\b(?:overwrit\w*|discard\w*|collision\w*|reject\w*)\b/iu.test(claim)) return undefined;
  const write = mapWriteAtFinding(finding, lines);
  if (write === undefined || baseContainsMapWrite(baseSource, write.key)) return undefined;
  const declaration = mapDeclaration(lines, write);
  if (
    declaration === undefined ||
    !nativeMapIsUnshadowed(lines) ||
    enclosingInputLoop(lines, declaration, write) === undefined ||
    !receiverBindingIsStable(lines, declaration, write) ||
    hasDuplicateGuard(lines, declaration, write)
  ) {
    return undefined;
  }
  return { evidenceRefs: refsAt(write.line.line) };
}

/** Return a proof only when exact, source-bound changed code closes the whole claim. */
export function closedClaimProof(
  finding: JudgeableFinding,
  evidence: TrustedHunkEvidence,
): ClosedClaimProof | undefined {
  if (!carriesTrustedEvidenceBrand(evidence)) return undefined;
  if (evidence.headSource === undefined) return undefined;
  const lines = sourceLines(evidence.headSource, changedHeadLines(evidence.text));
  return (
    catchDisclosureProof(finding, lines, evidence.baseSource) ??
    duplicateMapProof(finding, lines, evidence.baseSource)
  );
}
