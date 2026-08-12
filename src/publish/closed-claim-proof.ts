import type { JudgeableFinding, VerificationEvidenceRef } from "./substantiate.js";
import { decodeEvidenceSourcePath } from "./evidence-path.js";

/** A deterministic proof licensed only by source material bound by the caller. */
export interface ClosedClaimProof {
  readonly evidenceRefs: readonly VerificationEvidenceRef[];
}

export const CLOSED_REFUTATION_RULE_IDS = [
  "diagnostic_context_noop",
  "terminal_helper_contract",
  "reset_before_dynamic_import",
  "redaction_assertion_proves_contract",
] as const;

export type ClosedRefutationRuleId = (typeof CLOSED_REFUTATION_RULE_IDS)[number];

export interface ClosedClaimRefutation extends ClosedClaimProof {
  readonly ruleId: ClosedRefutationRuleId;
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
  /** Complete immutable HEAD blobs for repository paths already rendered in `text`. */
  readonly headRepositorySources: ReadonlyMap<string, string>;
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

interface AwaitedFileRead {
  readonly receiver: string;
  readonly line: SourceLine;
  readonly index: number;
}

interface DiagnosticContextAddition {
  readonly field: string;
  readonly line: SourceLine;
  readonly index: number;
}

const HEAD_ROW = /^H:([1-9]\d*)\| (.*)$/u;
const BASE_ROW = /^B:([1-9]\d*)\| (.*)$/u;
const CHANGED_HEAD_ROW = /^D:H:([1-9]\d*)\| \+(.*)$/u;
const REPOSITORY_LABEL = /^H([1-8]) = (.+)$/u;
const REPOSITORY_ROW = /^H([1-8]):([1-9]\d*)\| (.*)$/u;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const SENSITIVE_CONTEXT_FIELD =
  /(?:authorization|body|content|credential|password|payload|secret|session|token)/iu;
const LOG_METHODS = new Set(["debug", "error", "info", "log", "warn"]);
const PRIMITIVE_TYPES = new Set(["bigint", "boolean", "number", "string"]);
const MUTATION_SUFFIXES = [
  "++",
  "--",
  "&&=",
  "||=",
  "??=",
  ">>>=",
  "**=",
  "<<=",
  ">>=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
];
const MAX_CLAIM_CHARS = 8_192;
function sourceRows(source: string | undefined): readonly string[] | undefined {
  if (source === undefined) return undefined;
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n");
}

function rowMatchesSource(row: RegExpExecArray, source: readonly string[] | undefined): boolean {
  const line = Number(row[1]);
  return source !== undefined && row[2] !== undefined && source[line - 1] === row[2];
}

function boundSourceRow(
  row: string,
  head: readonly string[] | undefined,
  base: readonly string[] | undefined,
): -1 | 0 | 1 {
  const headRow = HEAD_ROW.exec(row);
  if (headRow !== null) return rowMatchesSource(headRow, head) ? 1 : -1;
  const baseRow = BASE_ROW.exec(row);
  if (baseRow !== null) return rowMatchesSource(baseRow, base) ? 1 : -1;
  const changed = CHANGED_HEAD_ROW.exec(row);
  if (changed !== null) return rowMatchesSource(changed, head) ? 1 : -1;
  return 0;
}

function dossierMatchesSources(
  text: string,
  head: readonly string[] | undefined,
  base: readonly string[] | undefined,
): boolean {
  let sourceRowsSeen = 0;
  for (const row of text.split("\n")) {
    const bound = boundSourceRow(row, head, base);
    if (bound < 0) return false;
    sourceRowsSeen += bound;
  }
  return sourceRowsSeen > 0;
}

function defusedRepositoryLine(value: string): string {
  return value
    .replaceAll("<repository_evidence>", "<repository-evidence>")
    .replaceAll("</repository_evidence>", "</repository-evidence>")
    .replaceAll("<change_evidence>", "<change-evidence>")
    .replaceAll("</change_evidence>", "</change-evidence>");
}

function hasExactHeadBinding(text: string, headCommit: string | undefined): boolean {
  return (
    headCommit !== undefined &&
    /^[0-9a-f]{40}$/u.test(headCommit) &&
    text.split("\n").includes(`Exact HEAD commit: ${headCommit}`)
  );
}

function repositoryPaths(text: string): ReadonlyMap<string, string> | undefined {
  const paths = new Map<string, string>();
  for (const row of text.split("\n")) {
    const label = REPOSITORY_LABEL.exec(row);
    if (label === null) continue;
    const [number, encodedPath] = [label[1], label[2]];
    if (number === undefined || encodedPath === undefined || paths.has(number)) return undefined;
    const path = decodeEvidenceSourcePath(encodedPath);
    if (path === undefined) return undefined;
    paths.set(number, path);
  }
  return paths;
}

function boundRepositoryRow(
  match: RegExpExecArray,
  paths: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, string>,
): readonly [string, string] | undefined {
  const path = paths.get(match[1] ?? "");
  const line = Number(match[2]);
  const source = path === undefined ? undefined : sources.get(path);
  const sourceLine = sourceRows(source)?.[line - 1];
  return path !== undefined &&
    source !== undefined &&
    sourceLine !== undefined &&
    defusedRepositoryLine(sourceLine) === match[3]
    ? [path, source]
    : undefined;
}

function boundRepositorySources(
  text: string,
  sources: ReadonlyMap<string, string>,
  headCommit: string | undefined,
): ReadonlyMap<string, string> | undefined {
  if (sources.size === 0) return new Map();
  if (!hasExactHeadBinding(text, headCommit)) return undefined;
  const paths = repositoryPaths(text);
  if (paths === undefined) return undefined;
  const bound = new Map<string, string>();
  for (const row of text.split("\n")) {
    const match = REPOSITORY_ROW.exec(row);
    if (match === null) continue;
    const entry = boundRepositoryRow(match, paths, sources);
    if (entry === undefined) return undefined;
    bound.set(...entry);
  }
  return bound.size === sources.size ? bound : undefined;
}

/**
 * Establish the trusted-evidence boundary after callers have read immutable Git sources. The
 * dossier rows are checked against those sources so arbitrary `H:`/`D:H:` prose cannot be branded.
 */
export function bindTrustedHunkEvidence(input: {
  readonly text: string;
  readonly headSource: string | undefined;
  readonly baseSource: string | undefined;
  readonly headCommit?: string;
  readonly headRepositorySources?: ReadonlyMap<string, string>;
}): TrustedHunkEvidence | undefined {
  const head = sourceRows(input.headSource);
  const base = sourceRows(input.baseSource);
  if (input.text === "" || !dossierMatchesSources(input.text, head, base)) return undefined;
  const repositorySources = boundRepositorySources(
    input.text,
    input.headRepositorySources ?? new Map(),
    input.headCommit,
  );
  if (repositorySources === undefined) return undefined;
  return Object.freeze({
    text: input.text,
    headSource: input.headSource,
    baseSource: input.baseSource,
    headRepositorySources: repositorySources,
    [TRUSTED_HUNK_EVIDENCE]: true,
  }) as TrustedHunkEvidence;
}

function carriesTrustedEvidenceBrand(value: object): boolean {
  return (
    Object.hasOwn(value, TRUSTED_HUNK_EVIDENCE) &&
    Reflect.get(value, TRUSTED_HUNK_EVIDENCE) === true
  );
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
  return previous === "" || "=(,:[,!&|?{};".includes(previous);
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

function refutationRefsAt(line: number): readonly VerificationEvidenceRef[] {
  return [...refsAt(line), `B:${String(line)}` as VerificationEvidenceRef];
}

function insideFinding(line: number, finding: JudgeableFinding): boolean {
  return line >= finding.startLine && line <= finding.endLine;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function sinkUsesCaughtBinding(text: string, binding: string): boolean {
  const argument = escaped(binding);
  return new RegExp(String.raw`^\s*window\.reportError\(\s*${argument}\s*\)\s*;?\s*$`, "u").test(
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

function mentionsBinding(text: string, binding: string): boolean {
  return new RegExp(String.raw`\b${escaped(binding)}\b`, "u").test(text);
}

function scanBraceBalance(code: string, initialBalance: number): number {
  let balance = initialBalance;
  for (const character of code) {
    if (character === "{") balance += 1;
    if (character === "}") balance -= 1;
    if (balance === 0) return 0;
  }
  return balance;
}

function matchingBrace(lines: readonly SourceLine[], openingIndex: number): number | undefined {
  const openingCode = lines[openingIndex]?.code ?? "";
  const openingOffset = openingCode.lastIndexOf("{");
  if (openingOffset < 0) return undefined;

  let balance = scanBraceBalance(openingCode.slice(openingOffset), 0);
  if (balance === 0) return openingIndex;
  for (let index = openingIndex + 1; index < lines.length; index += 1) {
    balance = scanBraceBalance(lines[index]?.code ?? "", balance);
    if (balance === 0) return index;
  }
  return undefined;
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
    if (candidate === undefined) return undefined;
    if (sinkUsesCaughtBinding(candidate.code, binding)) {
      const sinkWasAssigned = lines
        .slice(0, index)
        .some(
          (prior) =>
            /\bwindow\s*\.\s*reportError\s*(?:(?:&&|\|\||\?\?)?=(?!=)|\+\+|--)/u.test(prior.code) ||
            /\bObject\.defineProperty\(\s*window\s*,\s*["']reportError["']/u.test(prior.code),
        );
      return candidate.changed && insideFinding(candidate.line, finding) && !sinkWasAssigned
        ? candidate
        : undefined;
    }
    if (/^\s*(?:return|throw)\b/u.test(candidate.code)) return undefined;
    if (mentionsBinding(candidate.code, binding)) return undefined;
  }
  return undefined;
}

function catchDisclosureProof(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
): ClosedClaimProof | undefined {
  if (!disclosureClaim(finding.content)) return undefined;
  for (const [catchIndex, line] of lines.entries()) {
    const binding = catchBinding(finding, line);
    if (binding === undefined) continue;
    const sink = changedSinkInCatch(finding, lines, catchIndex, binding);
    if (sink !== undefined) return { evidenceRefs: refsAt(sink.line) };
  }
  return undefined;
}

function unhandledFileReadClaim(content: string): boolean {
  const claim = content.slice(0, MAX_CLAIM_CHARS);
  return (
    /\bfile\.text\s*\(\s*\)/iu.test(claim) &&
    /\b(?:reject\w*|unhandled|uncaught|propagat\w*|read(?:ing)?\s+fail\w*)\b/iu.test(claim) &&
    /\b(?:catch|error\s+handling)\b/iu.test(claim)
  );
}

function awaitedFileReadAtFinding(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
): AwaitedFileRead | undefined {
  const matches: AwaitedFileRead[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.changed || !insideFinding(line.line, finding)) continue;
    const read = /\bawait\s+([A-Za-z_$][\w$]*)\.text\s*\(\s*\)/u.exec(line.code);
    if (read?.[1] === undefined || /\.catch\s*\(/u.test(line.code.slice(read.index))) continue;
    matches.push({ receiver: read[1], line, index });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function inputFileBinding(
  lines: readonly SourceLine[],
  read: AwaitedFileRead,
  handlerOpening: number,
): boolean {
  const receiver = escaped(read.receiver);
  const declaration = new RegExp(
    String.raw`^\s*const\s+${receiver}\s*=\s*[A-Za-z_$][\w$]*\.target\.files\?\.\[0\]\s*;?\s*$`,
    "u",
  );
  return lines.slice(handlerOpening + 1, read.index).some((line) => declaration.test(line.code));
}

function enclosingAsyncInputHandler(
  lines: readonly SourceLine[],
  read: AwaitedFileRead,
): { readonly name: string; readonly opening: number; readonly closing: number } | undefined {
  for (let index = read.index; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.depth < 1) continue;
    const declaration =
      /^\s*async\s+function\s+([A-Za-z_$][\w$]*)\s*\([^)]*ChangeEvent<HTMLInputElement>[^)]*\)[^{]*\{/u.exec(
        line.code,
      );
    const name = declaration?.[1];
    if (name === undefined) continue;
    const closing = matchingBrace(lines, index);
    if (closing !== undefined && read.index > index && read.index < closing) {
      return { name, opening: index, closing };
    }
  }
  return undefined;
}

function nextCodeLine(lines: readonly SourceLine[], index: number): string {
  for (let cursor = index; cursor < lines.length; cursor += 1) {
    const code = lines[cursor]?.code.trim() ?? "";
    if (code !== "") return code;
  }
  return "";
}

function tryCatchesRead(
  lines: readonly SourceLine[],
  tryIndex: number,
  readIndex: number,
): boolean {
  const line = lines[tryIndex];
  if (line === undefined || !/\btry\s*\{/u.test(line.code)) return false;
  const closing = matchingBrace(lines, tryIndex);
  if (closing === undefined || closing < readIndex) return false;
  const closingCode = lines[closing]?.code ?? "";
  return /\bcatch\b/u.test(closingCode) || /^catch\b/u.test(nextCodeLine(lines, closing + 1));
}

function readIsInsideCaughtTry(
  lines: readonly SourceLine[],
  readIndex: number,
  handler: { readonly opening: number; readonly closing: number },
): boolean {
  return lines
    .slice(handler.opening + 1, readIndex + 1)
    .some((_line, offset) => tryCatchesRead(lines, handler.opening + 1 + offset, readIndex));
}

function soleDiscardedHandlerCall(
  lines: readonly SourceLine[],
  handler: { readonly name: string; readonly opening: number; readonly closing: number },
): SourceLine | undefined {
  const name = escaped(handler.name);
  const occurrence = new RegExp(String.raw`\b${name}\b`, "gu");
  const uses = lines.flatMap((line) => [...line.code.matchAll(occurrence)].map(() => line));
  if (uses.length !== 2) return undefined;
  const opening = lines[handler.opening];
  const closing = lines[handler.closing];
  if (opening === undefined || closing === undefined) return undefined;
  const call = uses.find((line) => line.line < opening.line || line.line > closing.line);
  if (!call?.changed) return undefined;
  const discarded = new RegExp(String.raw`\bvoid\s+${name}\s*\([^)]*\)`, "u");
  const invocation = discarded.exec(call.code);
  if (invocation === null || /\.(?:catch|then)\s*\(/u.test(call.code)) return undefined;
  const suffix = call.code.slice(invocation.index + invocation[0].length).trimStart();
  return suffix.startsWith(";") || suffix.startsWith("}") ? call : undefined;
}

function unhandledFileReadProof(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
): ClosedClaimProof | undefined {
  if (!unhandledFileReadClaim(finding.content)) return undefined;
  const read = awaitedFileReadAtFinding(finding, lines);
  if (read === undefined) return undefined;
  const handler = enclosingAsyncInputHandler(lines, read);
  if (
    handler === undefined ||
    !inputFileBinding(lines, read, handler.opening) ||
    readIsInsideCaughtTry(lines, read.index, handler)
  ) {
    return undefined;
  }
  const call = soleDiscardedHandlerCall(lines, handler);
  return call === undefined
    ? undefined
    : { evidenceRefs: [...refsAt(read.line.line), ...refsAt(call.line)] };
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

function importsMap(code: string): boolean {
  const trimmed = code.trimStart();
  if (!trimmed.startsWith("import ")) return false;
  const fromOffset = trimmed.lastIndexOf(" from ");
  const clause = fromOffset < 0 ? trimmed : trimmed.slice(0, fromOffset);
  return /\bMap\b/u.test(clause);
}

function destructuresMap(code: string): boolean {
  for (const keyword of ["const", "let", "var"] as const) {
    const opening = code.indexOf(`${keyword} {`);
    if (opening < 0) continue;
    const closing = code.indexOf("}", opening + keyword.length + 2);
    if (closing > opening && /\bMap\b/u.test(code.slice(opening, closing + 1))) return true;
  }
  return false;
}

function parameterShadowsMap(code: string): boolean {
  const opening = code.indexOf("(");
  const closing = code.indexOf(")", opening + 1);
  if (opening < 0 || closing < 0) return false;
  if (!/\bMap\b/u.test(code.slice(opening + 1, closing))) return false;
  const suffix = code.slice(closing + 1).trimStart();
  return suffix.startsWith("=>") || suffix.startsWith("{");
}

function nativeMapIsUnshadowed(lines: readonly SourceLine[]): boolean {
  const directBinding = /\b(?:const|let|var|class|function|interface|type)\s+Map\b/u;
  return !lines.some(
    (line) =>
      directBinding.test(line.code) ||
      importsMap(line.code) ||
      destructuresMap(line.code) ||
      parameterShadowsMap(line.code),
  );
}

function initializesNativeMap(code: string, receiver: string): boolean {
  const declaration = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Map\b/u.exec(code);
  if (declaration?.[1] !== receiver) return false;
  let suffix = code.slice(declaration[0].length).trimStart();
  if (suffix.startsWith("<")) {
    const genericEnd = suffix.indexOf(">");
    if (genericEnd < 1 || genericEnd > 256) return false;
    suffix = suffix.slice(genericEnd + 1).trimStart();
  }
  return suffix.startsWith("(");
}

function mapDeclaration(lines: readonly SourceLine[], write: MapWrite): SourceLine | undefined {
  const matches = lines.filter(
    (line) => line.line < write.line.line && initializesNativeMap(line.code, write.receiver),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function inputLoopIterable(
  line: SourceLine | undefined,
  declaration: SourceLine,
  write: MapWrite,
): string | undefined {
  if (line === undefined) return undefined;
  if (line.line <= declaration.line || line.line >= write.line.line) return undefined;
  if (line.depth !== declaration.depth) return undefined;
  return /^\s*for\s*\(\s*const\s+[A-Za-z_$][\w$]*\s+of\s+([A-Za-z_$][\w$]*)\s*\)\s*\{/u.exec(
    line.code,
  )?.[1];
}

function hasArrayInputGuard(
  lines: readonly SourceLine[],
  declaration: SourceLine,
  opening: number,
  iterable: string,
): boolean {
  const rejectingGuard = `if(!Array.isArray(${iterable}))return`;
  return lines
    .slice(0, opening)
    .some(
      (line) =>
        line.line > declaration.line && line.code.replace(/\s/gu, "").startsWith(rejectingGuard),
    );
}

function loopRepeatsAfterWrite(
  lines: readonly SourceLine[],
  opening: number,
  write: MapWrite,
): number | undefined {
  const closing = matchingBrace(lines, opening);
  if (closing === undefined || lines[closing] === undefined) return undefined;
  if (lines[closing].line <= write.line.line) return undefined;
  if (lines.slice(opening + 1, closing).some((candidate) => /\bbreak\b/u.test(candidate.code))) {
    return undefined;
  }
  const writeIndex = lines.indexOf(write.line);
  if (writeIndex < 0) return undefined;
  const exitsAfterWrite = lines
    .slice(writeIndex + 1, closing)
    .some((candidate) => /^\s*(?:return|throw)\b/u.test(candidate.code));
  return exitsAfterWrite ? undefined : closing;
}

function enclosingInputLoop(
  lines: readonly SourceLine[],
  declaration: SourceLine,
  write: MapWrite,
): { readonly opening: number; readonly closing: number } | undefined {
  if (write.line.depth !== declaration.depth + 1) return undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const iterable = inputLoopIterable(line, declaration, write);
    if (iterable === undefined || !hasArrayInputGuard(lines, declaration, index, iterable))
      continue;
    const closing = loopRepeatsAfterWrite(lines, index, write);
    if (closing !== undefined) return { opening: index, closing };
  }
  return undefined;
}

function receiverBindingIsStable(
  lines: readonly SourceLine[],
  declaration: SourceLine,
  write: MapWrite,
  throughIndex: number,
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
  const writerOverridden = new RegExp(String.raw`\b${receiver}\.set\s*=(?!=)`, "u");
  return !lines
    .slice(0, throughIndex)
    .some(
      (line) =>
        line.line > declaration.line &&
        line !== write.line &&
        (redeclared.test(line.code) ||
          reassigned.test(line.code) ||
          writerOverridden.test(line.code)),
    );
}

function hasDuplicateGuard(
  lines: readonly SourceLine[],
  declaration: SourceLine,
  write: MapWrite,
): boolean {
  const key = escaped(write.key).replace(/\s+/gu, String.raw`\s*`);
  const duplicateLookup = new RegExp(
    String.raw`\b[A-Za-z_$][\w$]*\.(?:has|get)\(\s*${key}\s*\)`,
    "u",
  );
  return lines.some(
    (line) =>
      line.line > declaration.line &&
      line.line < write.line.line &&
      duplicateLookup.test(line.code),
  );
}

function writesEveryInputToStableNativeMap(
  lines: readonly SourceLine[],
  declaration: SourceLine,
  write: MapWrite,
): boolean {
  if (!nativeMapIsUnshadowed(lines)) return false;
  const loop = enclosingInputLoop(lines, declaration, write);
  return (
    loop !== undefined &&
    receiverBindingIsStable(lines, declaration, write, loop.closing) &&
    !hasDuplicateGuard(lines, declaration, write)
  );
}

function duplicateMapProof(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
): ClosedClaimProof | undefined {
  const claim = finding.content.slice(0, MAX_CLAIM_CHARS);
  if (!/\bduplicate[sd]?\b/iu.test(claim)) return undefined;
  if (!/\b(?:overwrit\w*|discard\w*|collision\w*|reject\w*)\b/iu.test(claim)) return undefined;
  const write = mapWriteAtFinding(finding, lines);
  if (write === undefined) return undefined;
  const declaration = mapDeclaration(lines, write);
  if (declaration === undefined || !writesEveryInputToStableNativeMap(lines, declaration, write)) {
    return undefined;
  }
  return { evidenceRefs: refsAt(write.line.line) };
}

function soleSourceDifference(
  head: readonly SourceLine[],
  base: readonly SourceLine[],
  changed: ReadonlySet<number>,
): number | undefined {
  if (head.length !== base.length || changed.size !== 1) return undefined;
  const differences = head.flatMap((line, index) =>
    line.text === base[index]?.text ? [] : [index],
  );
  const index = differences.length === 1 ? differences[0] : undefined;
  return index !== undefined && changed.has(index + 1) ? index : undefined;
}

function soleObjectRange(code: string): readonly [number, number] | undefined {
  const objectOpen = code.indexOf("{");
  const objectClose = code.indexOf("}", objectOpen + 1);
  if (
    objectOpen < 0 ||
    objectClose < objectOpen ||
    objectOpen !== code.lastIndexOf("{") ||
    objectClose !== code.lastIndexOf("}")
  ) {
    return undefined;
  }
  return [objectOpen, objectClose];
}

function leavesLogCallOpen(call: string, callOpen: number): boolean {
  let depth = 1;
  for (let index = callOpen + 1; index < call.length; index += 1) {
    if (call[index] === "(") depth += 1;
    if (call[index] === ")") depth -= 1;
    if (depth <= 0) return false;
  }
  return depth === 1;
}

function opensQualifiedLogCall(beforeObject: string): boolean {
  if (!beforeObject.endsWith(",")) return false;
  const call = beforeObject.slice(0, -1).trimEnd();
  const callOpen = call.indexOf("(");
  if (callOpen <= 0 || !leavesLogCallOpen(call, callOpen)) return false;
  const calleeParts = call.slice(0, callOpen).trim().split(".");
  const method = calleeParts.at(-1);
  return (
    method !== undefined &&
    LOG_METHODS.has(method) &&
    calleeParts.length >= 2 &&
    calleeParts.every((part) => IDENTIFIER.test(part))
  );
}

function structuredLogParts(
  code: string,
): readonly [string, readonly string[], string] | undefined {
  const range = soleObjectRange(code);
  if (range === undefined) return undefined;
  const [objectOpen, objectClose] = range;
  const beforeObject = code.slice(0, objectOpen).trimEnd();
  const afterObject = code.slice(objectClose + 1).trim();
  if (!opensQualifiedLogCall(beforeObject) || (afterObject !== ")" && afterObject !== ");")) {
    return undefined;
  }
  const entries = code
    .slice(objectOpen + 1, objectClose)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return [code.slice(0, objectOpen + 1), entries, code.slice(objectClose)];
}

function appendedLogContextEntry(
  headCall: readonly [string, readonly string[], string] | undefined,
  baseCall: readonly [string, readonly string[], string] | undefined,
): string | undefined {
  if (headCall === undefined || baseCall === undefined) return undefined;
  const [headPrefix, headEntries, headSuffix] = headCall;
  const [basePrefix, baseEntries, baseSuffix] = baseCall;
  if (headPrefix !== basePrefix || headSuffix !== baseSuffix) return undefined;
  if (headEntries.length !== baseEntries.length + 1) return undefined;
  if (!baseEntries.every((entry, index) => headEntries[index] === entry)) return undefined;
  return headEntries.at(-1);
}

function contextField(entry: string | undefined): string | undefined {
  const parts = entry?.split(":").map((part) => part.trim()) ?? [];
  if (parts.length === 1 && IDENTIFIER.test(parts[0] ?? "")) return parts[0];
  if (parts.length === 2 && parts[0] === parts[1] && IDENTIFIER.test(parts[0] ?? "")) {
    return parts[0];
  }
  return undefined;
}

function addedPrimitiveContext(
  head: readonly SourceLine[],
  base: readonly SourceLine[],
  index: number,
): DiagnosticContextAddition | undefined {
  const headLine = head[index];
  const baseLine = base[index];
  if (headLine === undefined || baseLine === undefined) return undefined;
  const added = appendedLogContextEntry(
    structuredLogParts(headLine.code),
    structuredLogParts(baseLine.code),
  );
  const field = contextField(added);
  return field === undefined || SENSITIVE_CONTEXT_FIELD.test(field)
    ? undefined
    : { field, line: headLine, index };
}

function primitiveParameter(parameters: string, field: string): boolean {
  return parameters.split(",").some((parameter) => {
    const parts = parameter.split(":").map((part) => part.trim());
    if (parts.length !== 2) return false;
    const rawName = (parts[0] ?? "").replace(/^readonly\s+/u, "");
    const name = rawName.endsWith("?") ? rawName.slice(0, -1) : rawName;
    const type = parts[1]?.split("=", 1)[0]?.trim();
    return name === field && type !== undefined && PRIMITIVE_TYPES.has(type);
  });
}

function identifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/u.test(character);
}

function mutatesIdentifier(code: string, field: string): boolean {
  let offset = code.indexOf(field);
  while (offset >= 0) {
    const before = code[offset - 1];
    const after = code[offset + field.length];
    if (!identifierCharacter(before) && !identifierCharacter(after)) {
      const prefix = code.slice(0, offset).trimEnd();
      const suffix = code.slice(offset + field.length).trimStart();
      if (
        prefix.endsWith("++") ||
        prefix.endsWith("--") ||
        MUTATION_SUFFIXES.some((operator) => suffix.startsWith(operator)) ||
        (suffix.startsWith("=") && suffix[1] !== "=" && suffix[1] !== ">")
      ) {
        return true;
      }
    }
    offset = code.indexOf(field, offset + field.length);
  }
  return false;
}

function enclosingFunction(
  lines: readonly SourceLine[],
  addition: DiagnosticContextAddition,
): { readonly opening: number; readonly closing: number; readonly parameters: string } | undefined {
  for (let index = addition.index; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const declaration = /\b(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)[^{]*\{/u.exec(
      line.code,
    );
    const parameters = declaration?.[1];
    if (parameters === undefined) continue;
    const closing = matchingBrace(lines, index);
    if (closing !== undefined && addition.index > index && addition.index < closing) {
      return { opening: index, closing, parameters };
    }
  }
  return undefined;
}

function primitiveParameterIsStable(
  lines: readonly SourceLine[],
  addition: DiagnosticContextAddition,
  fn: { readonly opening: number; readonly parameters: string },
): boolean {
  if (!primitiveParameter(fn.parameters, addition.field)) return false;
  return !lines
    .slice(fn.opening + 1, addition.index)
    .some((line) => mutatesIdentifier(line.code, addition.field));
}

function enclosingRethrowingCatch(
  lines: readonly SourceLine[],
  addition: DiagnosticContextAddition,
): boolean {
  for (let index = addition.index; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const binding = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/u.exec(line.code)?.[1];
    if (binding === undefined) continue;
    const closing = matchingBrace(lines, index);
    if (closing === undefined || addition.index <= index || addition.index >= closing) continue;
    const body = lines.slice(index + 1, closing);
    const escapedBinding = escaped(binding);
    const rethrow = new RegExp(String.raw`^\s*throw\s+${escapedBinding}\s*;?\s*$`, "u");
    return (
      body.filter((candidate) => rethrow.test(candidate.code)).length === 1 &&
      !body.some((candidate) => mutatesIdentifier(candidate.code, binding))
    );
  }
  return false;
}

function terminalHelperClaim(content: string): boolean {
  const claim = content.slice(0, MAX_CLAIM_CHARS);
  const describesInvalidResult = [
    /\bundefined\b/iu,
    /\bnull\b/iu,
    /fall(?:s|ing)?\s*through/iu,
    /without\s+return/iu,
    /invalid\s+(?:argument|command|path)/iu,
    /fails?\s+to\s+return/iu,
  ].some((pattern) => pattern.test(claim));
  return (
    /\b(?:spawn|command|executable|tool|helper|path)\b/iu.test(claim) && describesInvalidResult
  );
}

function changedSpawnHelper(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
): { readonly name: string; readonly line: SourceLine } | undefined {
  const matches = lines.flatMap((line) => {
    if (!line.changed || !insideFinding(line.line, finding)) return [];
    const name = /\bspawn\s*\(\s*([A-Za-z_$][\w$]*)\s*\(/u.exec(line.code)?.[1];
    return name === undefined ? [] : [{ name, line }];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function namedFunctionRange(
  lines: readonly SourceLine[],
  name: string,
): { readonly opening: number; readonly closing: number } | undefined {
  const expected = escaped(name);
  const declaration = new RegExp(
    String.raw`^\s*(?:export\s+)?function\s+${expected}\s*\([^)]*\)\s*(?::\s*[^\{]+)?\{\s*$`,
    "u",
  );
  const openings = lines.flatMap((line, index) => (declaration.test(line.code) ? [index] : []));
  if (openings.length !== 1) return undefined;
  const opening = openings[0];
  const closing = opening === undefined ? undefined : matchingBrace(lines, opening);
  return opening === undefined || closing === undefined ? undefined : { opening, closing };
}

function withoutOptionalSemicolon(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/u.test(value);
}

function isStringLiteralExpression(value: string): boolean {
  const quote = value[0];
  if (value.length < 2 || quote === undefined || value.at(-1) !== quote) return false;
  if (quote === '"' || quote === "'") return quotedLiteral(value) !== undefined;
  if (quote !== "`") return false;
  for (let index = 1; index < value.length - 1; index += 1) {
    if (value[index] === "`") return false;
    if (value[index] === "\\") index += 1;
  }
  return true;
}

function provenStringBinding(text: string): string | undefined {
  const statement = withoutOptionalSemicolon(text);
  if (!statement.startsWith("const ")) return undefined;
  const assignment = statement.indexOf("=", 6);
  if (assignment < 0) return undefined;
  const binding = statement.slice(6, assignment).trim();
  const value = statement.slice(assignment + 1).trim();
  return isIdentifier(binding) && isStringLiteralExpression(value) ? binding : undefined;
}

function provenStringBindings(lines: readonly SourceLine[]): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const line of lines) {
    const binding = provenStringBinding(line.text);
    if (binding !== undefined) bindings.add(binding);
  }
  return bindings;
}

function validStringReturn(line: SourceLine, bindings: ReadonlySet<string>): boolean {
  const returnAt = line.code.search(/\breturn\b/u);
  if (returnAt < 0) return true;
  const value = withoutOptionalSemicolon(line.text.slice(returnAt + "return".length)).trim();
  if (value === "") return false;
  if (bindings.has(value)) return true;
  return isStringLiteralExpression(value);
}

function helperReturnsOrThrows(
  lines: readonly SourceLine[],
  range: { readonly opening: number; readonly closing: number },
): boolean {
  const opening = lines[range.opening];
  if (opening === undefined) return false;
  const body = lines.slice(range.opening + 1, range.closing);
  const stringBindings = provenStringBindings(body);
  if (
    body.some((line) =>
      /\b(?:async\s+function|catch|finally|function|yield)\b|=>/u.test(line.code),
    ) ||
    body.some((line) => !validStringReturn(line, stringBindings))
  ) {
    return false;
  }
  const returns = body.filter((line) => /\breturn\b/u.test(line.code));
  if (returns.length === 0) return false;
  const terminal = body.findLast((line) => line.code.trim() !== "");
  if (terminal?.depth !== opening.depth + 1) return false;
  const terminalStatement = withoutOptionalSemicolon(terminal.code);
  return terminalStatement.startsWith("throw ") || terminalStatement.startsWith("return ");
}

function terminalHelperRefutation(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
): ClosedClaimRefutation | undefined {
  if (!terminalHelperClaim(finding.content)) return undefined;
  const consumer = changedSpawnHelper(finding, lines);
  if (consumer === undefined) return undefined;
  const range = namedFunctionRange(lines, consumer.name);
  const consumerIndex = lines.indexOf(consumer.line);
  if (range === undefined || range.closing >= consumerIndex) return undefined;
  const reassigned = new RegExp(
    String.raw`\b${escaped(consumer.name)}\s*(?:(?:&&|\|\||\?\?)?=(?!=)|\+\+|--)`,
    "u",
  );
  const shadowedParameter = new RegExp(
    String.raw`(?:\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\b${escaped(consumer.name)}\b|\([^)]*\b${escaped(consumer.name)}\b[^)]*\)\s*=>)`,
    "u",
  );
  if (
    // Scan every line outside the proved helper body. A same-line parameter can shadow the call,
    // and a later module-scope assignment can execute before an exported consumer is invoked.
    lines.some(
      (line, index) =>
        (index < range.opening || index > range.closing) &&
        (reassigned.test(line.code) || shadowedParameter.test(line.code)),
    )
  ) {
    return undefined;
  }
  if (!helperReturnsOrThrows(lines, range)) return undefined;
  return { ruleId: "terminal_helper_contract", evidenceRefs: refsAt(consumer.line.line) };
}

function resetIsolationClaim(content: string): boolean {
  const claim = content.slice(0, MAX_CLAIM_CHARS);
  return (
    /(?:resetModules|module\s+(?:cache|registry)|state\s+bleed|cross[- ](?:test|case))/iu.test(
      claim,
    ) &&
    /(?:redundan|unnecess|remove|ineffective|insufficient|still\s+(?:cache|share|reuse)|does\s+not)/iu.test(
      claim,
    )
  );
}

interface DynamicImportPair {
  readonly target: string;
  readonly reset: SourceLine;
  readonly imported: SourceLine;
}

function previousCodeLine(lines: readonly SourceLine[], index: number): SourceLine | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor];
    if (line !== undefined && line.code.trim() !== "") return line;
  }
  return undefined;
}

function dynamicImportPairs(
  lines: readonly SourceLine[],
): readonly DynamicImportPair[] | undefined {
  const pairs: DynamicImportPair[] = [];
  let imports = 0;
  for (const [index, line] of lines.entries()) {
    const dynamicImports = [...line.text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu)];
    if (dynamicImports.length === 0) continue;
    if (dynamicImports.length !== 1) return undefined;
    const target = /\bawait\s+import\(\s*["']([^"']+)["']\s*\)/u.exec(line.text)?.[1];
    if (target === undefined) return undefined;
    imports += 1;
    const reset = previousCodeLine(lines, index);
    if (
      reset?.depth !== line.depth ||
      withoutOptionalSemicolon(reset.code) !== "vi.resetModules()"
    ) {
      return undefined;
    }
    pairs.push({ target, reset, imported: line });
  }
  return imports === 0 ? undefined : pairs;
}

function staticallyImportsTarget(
  lines: readonly SourceLine[],
  targets: ReadonlySet<string>,
): boolean {
  return lines.some((line) => {
    const statement = withoutOptionalSemicolon(line.text);
    if (!statement.startsWith("import ")) return false;
    const fromAt = statement.lastIndexOf(" from ");
    const target = fromAt < 0 ? undefined : quotedLiteral(statement.slice(fromAt + 6).trim());
    return target !== undefined && targets.has(target);
  });
}

interface NamedImport {
  readonly names: readonly string[];
  readonly source: string;
}

function namedImport(text: string): NamedImport | undefined {
  const statement = withoutOptionalSemicolon(text);
  if (!statement.startsWith("import")) return undefined;
  const specifiers = statement.slice("import".length).trimStart();
  if (!specifiers.startsWith("{")) return undefined;
  const closing = specifiers.indexOf("}");
  if (closing < 0) return undefined;
  const remainder = specifiers.slice(closing + 1).trim();
  if (!remainder.startsWith("from ")) return undefined;
  const source = quotedLiteral(remainder.slice("from ".length).trim());
  if (source === undefined) return undefined;
  const names = specifiers
    .slice(1, closing)
    .split(",")
    .map((specifier) => specifier.trim());
  return { names, source };
}

function importsVitestViDirectly(lines: readonly SourceLine[]): boolean {
  return lines.some((line) => {
    const imported = namedImport(line.text);
    return imported?.source === "vitest" && imported.names.includes("vi");
  });
}

function resetIsolationRefutation(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
): ClosedClaimRefutation | undefined {
  if (!resetIsolationClaim(finding.content)) return undefined;
  const pairs = dynamicImportPairs(lines);
  if (pairs === undefined) return undefined;
  const targets = new Set(pairs.map((pair) => pair.target));
  if (
    pairs.length < 2 ||
    targets.size !== 1 ||
    staticallyImportsTarget(lines, targets) ||
    !importsVitestViDirectly(lines) ||
    lines.some(
      (line) =>
        /\b(?:const|let|var|function|class)\s+vi\b/u.test(line.code) ||
        /\bcatch\s*\(\s*vi\b/u.test(line.code) ||
        /\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\bvi\b/u.test(line.code) ||
        /[(,]\s*vi\s*[,)=:]/u.test(line.code) ||
        /\bvi\s+as\s+[A-Za-z_$]/u.test(line.code),
    )
  ) {
    return undefined;
  }
  const changed = pairs.find(
    (pair) =>
      (pair.reset.changed || pair.imported.changed) &&
      (insideFinding(pair.reset.line, finding) || insideFinding(pair.imported.line, finding)),
  );
  if (changed === undefined) return undefined;
  return {
    ruleId: "reset_before_dynamic_import",
    evidenceRefs: refsAt(changed.reset.line),
  };
}

function redactionClaim(content: string): boolean {
  const claim = content.slice(0, MAX_CLAIM_CHARS);
  return (
    /(?:redact|mask|saniti[sz]|leak|expos)/iu.test(claim) &&
    /(?:secret|sensitive|deployment|suffix|model\s*id)/iu.test(claim)
  );
}

function quotedLiteral(value: string): string | undefined {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (!value.startsWith("'") || !value.endsWith("'") || value.slice(1, -1).includes("\\")) {
    return undefined;
  }
  return value.slice(1, -1);
}

interface ExactAssertion {
  readonly functionName: string;
  readonly input: string;
  readonly expected: string;
  readonly line: SourceLine;
}

function afterWhitespace(text: string, offset: number): number {
  let cursor = offset;
  while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function afterToken(text: string, offset: number, token: string): number | undefined {
  const cursor = afterWhitespace(text, offset);
  return text.startsWith(token, cursor) ? cursor + token.length : undefined;
}

interface ParsedToken {
  readonly value: string;
  readonly after: number;
}

function identifierToken(text: string, offset: number): ParsedToken | undefined {
  const start = afterWhitespace(text, offset);
  let after = start;
  while (identifierCharacter(text[after])) after += 1;
  const value = text.slice(start, after);
  return isIdentifier(value) ? { value, after } : undefined;
}

function quotedToken(text: string, offset: number): ParsedToken | undefined {
  const start = afterWhitespace(text, offset);
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return undefined;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") {
      cursor += 1;
    } else if (text[cursor] === quote) {
      return { value: text.slice(start, cursor + 1), after: cursor + 1 };
    }
  }
  return undefined;
}

function completedExactAssertion(
  text: string,
  functionName: ParsedToken,
  input: ParsedToken,
  expected: ParsedToken,
  line: SourceLine,
): ExactAssertion | undefined {
  const closing = afterToken(text, expected.after, ")");
  if (closing === undefined || withoutOptionalSemicolon(text.slice(closing)) !== "") {
    return undefined;
  }
  const inputValue = quotedLiteral(input.value);
  const expectedValue = quotedLiteral(expected.value);
  if (inputValue === undefined || expectedValue === undefined) return undefined;
  return { functionName: functionName.value, input: inputValue, expected: expectedValue, line };
}

function parsedExactAssertion(text: string, line: SourceLine): ExactAssertion | undefined {
  const functionAt = afterToken(text, 0, "expect(");
  if (functionAt === undefined) return undefined;
  const functionName = identifierToken(text, functionAt);
  if (functionName === undefined) return undefined;
  const inputAt = afterToken(text, functionName.after, "(");
  if (inputAt === undefined) return undefined;
  const input = quotedToken(text, inputAt);
  if (input === undefined) return undefined;
  const expectedAt = afterToken(text, input.after, ")).toBe(");
  if (expectedAt === undefined) return undefined;
  const expected = quotedToken(text, expectedAt);
  if (expected === undefined) return undefined;
  return completedExactAssertion(text, functionName, input, expected, line);
}

function exactAssertionAtLine(
  line: SourceLine,
  finding: JudgeableFinding,
): ExactAssertion | undefined {
  if (!line.changed || !insideFinding(line.line, finding)) return undefined;
  return parsedExactAssertion(line.text, line);
}

function changedExactAssertion(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
): ExactAssertion | undefined {
  const matches = lines.flatMap((line) => {
    const match = exactAssertionAtLine(line, finding);
    return match === undefined ? [] : [match];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizedRelativePath(from: string, target: string): string | undefined {
  if (!target.startsWith("./") && !target.startsWith("../")) return undefined;
  const parts = [...from.split("/").slice(0, -1), ...target.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return undefined;
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return normalized.join("/");
}

function importedSource(
  evidence: TrustedHunkEvidence,
  finding: JudgeableFinding,
  testLines: readonly SourceLine[],
  functionName: string,
): string | undefined {
  const imports = testLines.flatMap((line) => {
    const imported = namedImport(line.text);
    return imported?.names.filter((name) => name === functionName).length === 1
      ? [imported.source]
      : [];
  });
  if (imports.length !== 1) return undefined;
  const path = normalizedRelativePath(finding.path, imports[0] ?? "");
  if (path === undefined) return undefined;
  const javascriptExtension = [".js", ".cjs", ".mjs"].find((extension) => path.endsWith(extension));
  const candidates =
    javascriptExtension === undefined
      ? [path]
      : [
          path,
          `${path.slice(0, -javascriptExtension.length)}.ts`,
          `${path.slice(0, -javascriptExtension.length)}.tsx`,
        ];
  const matches = candidates.flatMap((candidate) => {
    const source = evidence.headRepositorySources.get(candidate);
    return source === undefined ? [] : [source];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function shadowsImportedBinding(lines: readonly SourceLine[], functionName: string): boolean {
  const name = escaped(functionName);
  const declaration = new RegExp(String.raw`\b(?:const|let|var|function|class)\s+${name}\b`, "u");
  const parameter = new RegExp(
    String.raw`(?:\bcatch\s*\(\s*${name}\b|\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\b${name}\b|(?:\(|,)\s*${name}\s*(?:[,)=:]))`,
    "u",
  );
  return lines.some((line) => declaration.test(line.code) || parameter.test(line.code));
}

interface SeparatorDeclaration {
  readonly binding: string;
  readonly separator: string;
  readonly line: SourceLine;
}

function soleSeparatorDeclaration(
  body: readonly SourceLine[],
  parameter: string,
): SeparatorDeclaration | undefined {
  const declarationPattern = new RegExp(
    String.raw`^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*${escaped(parameter)}\.indexOf\(\s*(["'][^"']+["'])\s*\)\s*;?\s*$`,
    "u",
  );
  const declarations = body.flatMap((line) => {
    const match = declarationPattern.exec(line.text);
    const separator = match?.[2] === undefined ? undefined : quotedLiteral(match[2]);
    return match?.[1] === undefined || separator === undefined
      ? []
      : [{ binding: match[1], separator, line }];
  });
  return declarations.length === 1 ? declarations[0] : undefined;
}

function hasExactRedactionReturn(
  body: readonly SourceLine[],
  parameter: string,
  binding: string,
): boolean {
  const returnPattern = new RegExp(
    String.raw`^\s*return\s+${escaped(binding)}\s*===\s*-1\s*\?\s*${escaped(parameter)}\s*:\s*${escaped(parameter)}\.slice\(\s*0\s*,\s*${escaped(binding)}\s*\)\s*;?\s*$`,
    "u",
  );
  return (
    body.filter((line) => returnPattern.test(line.code)).length === 1 &&
    body.filter((line) => /\breturn\b/u.test(line.code)).length === 1
  );
}

function redactionBindingsAreStable(
  body: readonly SourceLine[],
  parameter: string,
  declaration: SeparatorDeclaration,
): boolean {
  return !body.some(
    (line) =>
      mutatesIdentifier(line.code, parameter) ||
      (line !== declaration.line && mutatesIdentifier(line.code, declaration.binding)),
  );
}

function assertionMatchesSeparator(assertion: ExactAssertion, separator: string): boolean {
  const separatorIndex = assertion.input.indexOf(separator);
  const expected = separatorIndex < 0 ? assertion.input : assertion.input.slice(0, separatorIndex);
  return assertion.expected === expected;
}

function implementationProvesFirstSeparatorRedaction(
  source: string,
  assertion: ExactAssertion,
): boolean {
  const lines = sourceLines(source, new Set());
  const range = namedFunctionRange(lines, assertion.functionName);
  if (range === undefined) return false;
  const opening = lines[range.opening]?.code ?? "";
  const parameter = new RegExp(
    String.raw`\bfunction\s+${escaped(assertion.functionName)}\s*\(\s*([A-Za-z_$][\w$]*)`,
    "u",
  ).exec(opening)?.[1];
  if (parameter === undefined) return false;
  const body = lines.slice(range.opening + 1, range.closing);
  const declaration = soleSeparatorDeclaration(body, parameter);
  if (declaration === undefined || declaration.separator === "") return false;
  if (
    !hasExactRedactionReturn(body, parameter, declaration.binding) ||
    !redactionBindingsAreStable(body, parameter, declaration)
  ) {
    return false;
  }
  return assertionMatchesSeparator(assertion, declaration.separator);
}

function redactionAssertionRefutation(
  finding: JudgeableFinding,
  lines: readonly SourceLine[],
  evidence: TrustedHunkEvidence,
): ClosedClaimRefutation | undefined {
  if (!redactionClaim(finding.content) || !/(?:^|\.)test\.[cm]?[jt]sx?$/u.test(finding.path)) {
    return undefined;
  }
  const assertion = changedExactAssertion(finding, lines);
  if (assertion === undefined) return undefined;
  const functionName = escaped(assertion.functionName);
  if (
    shadowsImportedBinding(lines, assertion.functionName) ||
    lines.some(
      (line) =>
        /\b(?:vi\.)?(?:mock|spyOn)\s*\(/u.test(line.code) ||
        new RegExp(String.raw`\b${functionName}\s*=(?!=)`, "u").test(line.code),
    )
  ) {
    return undefined;
  }
  const implementation = importedSource(evidence, finding, lines, assertion.functionName);
  if (
    implementation === undefined ||
    !implementationProvesFirstSeparatorRedaction(implementation, assertion)
  ) {
    return undefined;
  }
  return {
    ruleId: "redaction_assertion_proves_contract",
    evidenceRefs: refsAt(assertion.line.line),
  };
}

function diagnosticContextRefutation(
  finding: JudgeableFinding,
  head: readonly SourceLine[],
  baseSource: string | undefined,
  changed: ReadonlySet<number>,
): ClosedClaimRefutation | undefined {
  if (baseSource === undefined) return undefined;
  const base = sourceLines(baseSource, new Set());
  const index = soleSourceDifference(head, base, changed);
  if (index === undefined || !insideFinding(index + 1, finding)) return undefined;
  const addition = addedPrimitiveContext(head, base, index);
  if (addition === undefined) return undefined;
  const fn = enclosingFunction(head, addition);
  if (
    fn === undefined ||
    !primitiveParameterIsStable(head, addition, fn) ||
    !enclosingRethrowingCatch(head, addition)
  ) {
    return undefined;
  }
  return {
    ruleId: "diagnostic_context_noop",
    evidenceRefs: refutationRefsAt(addition.line.line),
  };
}

/**
 * Refute only a closed, source-bound no-op transition: one non-secret primitive is appended to an
 * existing structured log context and the catch still rethrows the identical error. This executes
 * before probabilistic substantiation so serving variance cannot turn the measured clean twin into
 * a release-blocking false positive.
 */
export function closedClaimRefutation(
  finding: JudgeableFinding,
  evidence: TrustedHunkEvidence,
): ClosedClaimRefutation | undefined {
  if (!carriesTrustedEvidenceBrand(evidence)) return undefined;
  if (evidence.headSource === undefined) return undefined;
  const changed = changedHeadLines(evidence.text);
  const head = sourceLines(evidence.headSource, changed);
  const sourceDecision =
    terminalHelperRefutation(finding, head) ??
    resetIsolationRefutation(finding, head) ??
    redactionAssertionRefutation(finding, head, evidence);
  return sourceDecision ?? diagnosticContextRefutation(finding, head, evidence.baseSource, changed);
}

/** Return a proof only when exact, source-bound changed code closes the whole claim. */
export function closedClaimProof(
  finding: JudgeableFinding,
  evidence: TrustedHunkEvidence,
): ClosedClaimProof | undefined {
  if (!carriesTrustedEvidenceBrand(evidence)) return undefined;
  if (evidence.headSource === undefined || evidence.baseSource !== undefined) return undefined;
  const lines = sourceLines(evidence.headSource, changedHeadLines(evidence.text));
  return (
    catchDisclosureProof(finding, lines) ??
    duplicateMapProof(finding, lines) ??
    unhandledFileReadProof(finding, lines)
  );
}
