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
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const SENSITIVE_CONTEXT_FIELD =
  /(?:authorization|body|content|credential|password|payload|secret|session|token)/iu;
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

function structuredLogParts(
  code: string,
): readonly [string, readonly string[], string] | undefined {
  const call =
    /^(\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:debug|error|info|log|warn)\s*\([^{}]*,\s*\{)([^{}]*)(\}\s*\)\s*;?\s*)$/u.exec(
      code,
    );
  if (call?.[1] === undefined || call[2] === undefined || call[3] === undefined) return undefined;
  const entries = call[2]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return [call[1], entries, call[3]];
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
  const field = /^([A-Za-z_$][\w$]*)(?:\s*:\s*\1)?$/u.exec(added ?? "")?.[1];
  return field === undefined || SENSITIVE_CONTEXT_FIELD.test(field)
    ? undefined
    : { field, line: headLine, index };
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
  const field = escaped(addition.field);
  const declaration = new RegExp(
    String.raw`(?:^|,)\s*(?:readonly\s+)?${field}\??\s*:\s*(?:bigint|boolean|number|string)\b`,
    "u",
  );
  if (!declaration.test(fn.parameters)) return false;
  const assignment = new RegExp(
    String.raw`\b${field}\s*(?:\+\+|--|(?:&&|\|\||\?\?|[-+*/%&|^])?=(?!=))`,
    "u",
  );
  return !lines.slice(fn.opening + 1, addition.index).some((line) => assignment.test(line.code));
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
    const assignment = new RegExp(
      String.raw`\b${escapedBinding}\s*(?:\+\+|--|(?:&&|\|\||\?\?|[-+*/%&|^])?=(?!=))`,
      "u",
    );
    return (
      body.filter((candidate) => rethrow.test(candidate.code)).length === 1 &&
      !body.some((candidate) => assignment.test(candidate.code))
    );
  }
  return false;
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
): ClosedClaimProof | undefined {
  if (!carriesTrustedEvidenceBrand(evidence)) return undefined;
  if (evidence.headSource === undefined || evidence.baseSource === undefined) return undefined;
  const changed = changedHeadLines(evidence.text);
  const head = sourceLines(evidence.headSource, changed);
  const base = sourceLines(evidence.baseSource, new Set());
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
  return { evidenceRefs: refutationRefsAt(addition.line.line) };
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
