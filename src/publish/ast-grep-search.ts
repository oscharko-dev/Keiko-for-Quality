import { dirname, extname } from "node:path";

import type { CommitSha } from "../core/brands.js";
import { run } from "../git/exec.js";
import { readTextAtCommit, type GitContext } from "../git/plumbing.js";
import { acquireDefaultAstGrep } from "./ast-grep-acquire.js";
import {
  isOutsideAnchorContext,
  type EvidenceLineRange,
  type RepositoryEvidenceEntry,
} from "./evidence.js";

export const MAX_STRUCTURAL_FILES = 4;
export const MAX_STRUCTURAL_TERMS = 3;
export const MAX_STRUCTURAL_FILE_BYTES = 192 * 1024;
export const MAX_STRUCTURAL_TOTAL_BYTES = 512 * 1024;

const MAX_STRUCTURAL_MATCHES = 24;
const MAX_STRUCTURAL_OUTLINE_NODES = 512;
const MAX_STRUCTURAL_OUTPUT_BYTES = 384 * 1024;
const STRUCTURAL_PROCESS_TIMEOUT_MS = 2_000;
const MAX_ENTRY_LINE_CHARS = 300;

interface LanguageSpec {
  readonly language: string;
  readonly identifierKinds: string;
  readonly callKind: string;
}

const JAVASCRIPT: LanguageSpec = {
  language: "JavaScript",
  identifierKinds: "identifier,property_identifier,shorthand_property_identifier",
  callKind: "call_expression",
};
const TYPESCRIPT: LanguageSpec = {
  language: "TypeScript",
  identifierKinds: "identifier,property_identifier,shorthand_property_identifier",
  callKind: "call_expression",
};
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, LanguageSpec>> = {
  ".c": {
    language: "C",
    identifierKinds: "identifier,field_identifier,type_identifier",
    callKind: "call_expression",
  },
  ".cc": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
    callKind: "call_expression",
  },
  ".cpp": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
    callKind: "call_expression",
  },
  ".cs": {
    language: "CSharp",
    identifierKinds: "identifier",
    callKind: "invocation_expression",
  },
  ".cts": TYPESCRIPT,
  ".cxx": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
    callKind: "call_expression",
  },
  ".go": {
    language: "Go",
    identifierKinds: "identifier,field_identifier,type_identifier",
    callKind: "call_expression",
  },
  ".h": {
    language: "C",
    identifierKinds: "identifier,field_identifier,type_identifier",
    callKind: "call_expression",
  },
  ".hh": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
    callKind: "call_expression",
  },
  ".hpp": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
    callKind: "call_expression",
  },
  ".java": {
    language: "Java",
    identifierKinds: "identifier",
    callKind: "method_invocation",
  },
  ".js": JAVASCRIPT,
  ".jsx": JAVASCRIPT,
  ".mjs": JAVASCRIPT,
  ".mts": TYPESCRIPT,
  ".py": { language: "Python", identifierKinds: "identifier", callKind: "call" },
  ".pyi": { language: "Python", identifierKinds: "identifier", callKind: "call" },
  ".rs": {
    language: "Rust",
    identifierKinds: "identifier,field_identifier,type_identifier",
    callKind: "call_expression",
  },
  ".ts": TYPESCRIPT,
  ".tsx": {
    language: "Tsx",
    identifierKinds: "identifier,property_identifier,shorthand_property_identifier",
    callKind: "call_expression",
  },
};

export class AstGrepSearchError extends Error {
  public constructor(cause?: unknown) {
    super("ast-grep structural retrieval failed", { cause });
    this.name = "AstGrepSearchError";
  }
}

export interface StructuralSearchRequest {
  readonly context: GitContext;
  readonly head: CommitSha;
  readonly reviewPath: string;
  readonly findingAnchor: EvidenceLineRange;
  readonly candidatePaths: readonly string[];
  readonly terms: readonly string[];
  /** Absolute whole-review boundary. Absent only for standalone callers. */
  readonly deadlineMs?: number;
}

export interface StructuralSearchDependencies {
  readonly acquireBinary?: () => Promise<string>;
}

/** Exact-commit owner discovery for the reviewed anchor, before caller retrieval. */
export interface AnchorOwnerSearchRequest {
  readonly context: GitContext;
  readonly head: CommitSha;
  readonly reviewPath: string;
  readonly findingAnchor: EvidenceLineRange;
  /** Absolute whole-review boundary. Absent only for standalone callers. */
  readonly deadlineMs?: number;
}

/** One exact direct-call lookup used for the optional depth-one caller-owner hop. */
export interface CallerOwnerSearchRequest extends AnchorOwnerSearchRequest {
  readonly ownerName: string;
}

export interface AnchorOwner {
  readonly name: string;
  readonly definition: RepositoryEvidenceEntry;
}

interface SourceCandidate {
  readonly path: string;
  readonly source: string;
  readonly lines: readonly string[];
  readonly bytes: Buffer;
  readonly spec: LanguageSpec;
}

interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

interface SourceRange {
  readonly byteOffset: { readonly start: number; readonly end: number };
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

interface OutlineNode {
  readonly name: string;
  readonly range: SourceRange;
}

type StructuralEvidenceKind = "definition" | "test" | "callsite";
type StructuralEvidenceEntry = RepositoryEvidenceEntry & {
  readonly kind: StructuralEvidenceKind;
};

interface StructuralHit {
  readonly anchor: StructuralEvidenceEntry;
  readonly source: SourceCandidate;
  readonly ownerRange?: SourceRange;
  readonly termRank: number;
  readonly pathRank: number;
}

interface PrioritizedStructuralEntry {
  readonly entry: StructuralEvidenceEntry;
  readonly anchor: boolean;
}

const STRUCTURAL_KIND_ORDER = {
  definition: 0,
  test: 1,
  callsite: 2,
} as const;

const DEFINITION_CONTEXT_OFFSETS = [1, 2, 3] as const;
const OCCURRENCE_CONTEXT_OFFSETS = [-1, 1] as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AstGrepSearchError();
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new AstGrepSearchError();
  }
  return value as number;
}

function lineAtByteOffset(bytes: Buffer, offset: number): number {
  let line = 0;
  for (let index = 0; index < offset; index += 1) {
    if (bytes[index] === 0x0a) line += 1;
  }
  return line;
}

function sourceRange(value: unknown, source: SourceCandidate): SourceRange {
  const range = asRecord(value);
  const offsets = asRecord(range.byteOffset);
  const start = asRecord(range.start);
  const end = asRecord(range.end);
  const parsed = {
    byteOffset: {
      start: safeInteger(offsets.start, source.bytes.byteLength),
      end: safeInteger(offsets.end, source.bytes.byteLength),
    },
    start: {
      line: safeInteger(start.line, source.lines.length),
      column: safeInteger(start.column, MAX_STRUCTURAL_FILE_BYTES),
    },
    end: {
      line: safeInteger(end.line, source.lines.length),
      column: safeInteger(end.column, MAX_STRUCTURAL_FILE_BYTES),
    },
  };
  if (parsed.byteOffset.end < parsed.byteOffset.start || parsed.end.line < parsed.start.line) {
    throw new AstGrepSearchError();
  }
  if (
    lineAtByteOffset(source.bytes, parsed.byteOffset.start) !== parsed.start.line ||
    lineAtByteOffset(source.bytes, parsed.byteOffset.end) !== parsed.end.line
  ) {
    throw new AstGrepSearchError();
  }
  return parsed;
}

/** Exact identifier tails consumed by ast-grep and by the collector's term-anchor reservation. */
export function normalizedStructuralTerms(terms: readonly string[]): readonly string[] {
  const accepted: string[] = [];
  for (const term of terms.slice(0, MAX_STRUCTURAL_TERMS)) {
    const tail = term.split(".").at(-1) ?? term;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(tail) || accepted.includes(tail)) continue;
    accepted.push(tail);
    if (accepted.length === MAX_STRUCTURAL_TERMS) break;
  }
  return accepted;
}

function languageForPath(path: string): LanguageSpec | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
}

/** Whether the pinned parser has a closed language mapping for this repository path. */
export function isStructurallySearchablePath(path: string): boolean {
  return languageForPath(path) !== undefined;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function inlineRule(spec: LanguageSpec, terms: readonly string[]): string {
  const regex = terms.map(regexEscape).join("|");
  return [
    "id: kfq-structural-identifiers",
    `language: ${spec.language}`,
    "severity: hint",
    "message: bounded structural identifier",
    "rule:",
    "  all:",
    `    - kind: ${spec.identifierKinds}`,
    `    - regex: '^(?:${regex})$'`,
  ].join("\n");
}

function callerInlineRule(spec: LanguageSpec, ownerName: string): string {
  return [
    "id: kfq-direct-owner-call",
    `language: ${spec.language}`,
    "severity: hint",
    "message: bounded direct owner call",
    "rule:",
    "  all:",
    `    - kind: ${spec.callKind}`,
    "    - has:",
    "        all:",
    "          - kind: identifier",
    `          - regex: '^${regexEscape(ownerName)}$'`,
  ].join("\n");
}

function structuralTimeoutMs(deadlineMs: number | undefined, maximumMs: number): number {
  if (deadlineMs === undefined) return maximumMs;
  const remaining = Math.max(0, Math.trunc(deadlineMs - Date.now()));
  if (remaining === 0) throw new AstGrepSearchError();
  return Math.min(maximumMs, remaining);
}

function toolOptions(
  binaryPath: string,
  input: Buffer,
  deadlineMs?: number,
): Parameters<typeof run>[2] {
  return {
    cwd: dirname(binaryPath),
    timeoutMs: structuralTimeoutMs(deadlineMs, STRUCTURAL_PROCESS_TIMEOUT_MS),
    maxBuffer: MAX_STRUCTURAL_OUTPUT_BYTES,
    input,
    env: { PATH: "", HOME: dirname(binaryPath), LC_ALL: "C", NO_COLOR: "1" },
  };
}

async function toolJson(
  binaryPath: string,
  args: readonly string[],
  source: SourceCandidate,
  deadlineMs?: number,
): Promise<unknown> {
  try {
    const result = await run(binaryPath, args, toolOptions(binaryPath, source.bytes, deadlineMs));
    if (result.stderr !== "") throw new AstGrepSearchError();
    return JSON.parse(result.stdout.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof AstGrepSearchError) throw error;
    throw new AstGrepSearchError(error);
  }
}

function sourceLine(source: SourceCandidate, line: number): string | undefined {
  const content = source.lines[line];
  return content === undefined || content.length > MAX_ENTRY_LINE_CHARS ? undefined : content;
}

function validMatchedText(record: Record<string, unknown>, terms: readonly string[]): string {
  if (typeof record.text !== "string" || !terms.includes(record.text)) {
    throw new AstGrepSearchError();
  }
  return record.text;
}

function smallestContainingRange(
  nodes: readonly OutlineNode[],
  occurrence: SourceRange,
): SourceRange | undefined {
  let selected: SourceRange | undefined;
  for (const node of nodes) {
    if (
      node.range.byteOffset.start > occurrence.byteOffset.start ||
      node.range.byteOffset.end < occurrence.byteOffset.end
    ) {
      continue;
    }
    if (
      selected === undefined ||
      node.range.byteOffset.end - node.range.byteOffset.start <
        selected.byteOffset.end - selected.byteOffset.start
    ) {
      selected = node.range;
    }
  }
  return selected;
}

function occurrenceHit(
  value: unknown,
  source: SourceCandidate,
  terms: readonly string[],
  nodes: readonly OutlineNode[],
  pathRank: number,
): StructuralHit | undefined {
  const record = asRecord(value);
  if (record.file !== "STDIN" || record.language !== source.spec.language) {
    throw new AstGrepSearchError();
  }
  const text = validMatchedText(record, terms);
  const range = sourceRange(record.range, source);
  if (
    source.bytes.subarray(range.byteOffset.start, range.byteOffset.end).toString("utf8") !== text
  ) {
    throw new AstGrepSearchError();
  }
  const content = sourceLine(source, range.start.line);
  const ownerRange = smallestContainingRange(nodes, range);
  return content === undefined
    ? undefined
    : {
        anchor: {
          path: source.path,
          line: range.start.line + 1,
          content,
          kind: /(?:(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|(?:\.spec|\.test)\.[^/]+$)/u.test(
            source.path,
          )
            ? "test"
            : "callsite",
        },
        source,
        ...(ownerRange === undefined ? {} : { ownerRange }),
        termRank: terms.indexOf(text),
        pathRank,
      };
}

function parseOccurrences(
  value: unknown,
  source: SourceCandidate,
  terms: readonly string[],
  nodes: readonly OutlineNode[],
  pathRank: number,
): readonly StructuralHit[] {
  if (!Array.isArray(value) || value.length > MAX_STRUCTURAL_MATCHES) {
    throw new AstGrepSearchError();
  }
  return value
    .map((item) => occurrenceHit(item, source, terms, nodes, pathRank))
    .filter((item): item is StructuralHit => item !== undefined);
}

function identifierLine(
  source: SourceCandidate,
  range: SourceRange,
  name: string,
): number | undefined {
  const finalLine = Math.min(range.end.line, range.start.line + 16);
  const identifier = new RegExp(`(^|[^A-Za-z0-9_$])${regexEscape(name)}([^A-Za-z0-9_$]|$)`, "u");
  for (let line = range.start.line; line <= finalLine; line += 1) {
    if (identifier.test(sourceLine(source, line) ?? "")) return line;
  }
  return undefined;
}

function definitionHit(
  node: OutlineNode,
  source: SourceCandidate,
  terms: readonly string[],
  pathRank: number,
): StructuralHit | undefined {
  const termRank = terms.indexOf(node.name);
  if (termRank < 0) return undefined;
  const line = identifierLine(source, node.range, node.name);
  const content = line === undefined ? undefined : sourceLine(source, line);
  return line === undefined || content === undefined
    ? undefined
    : {
        anchor: { path: source.path, line: line + 1, content, kind: "definition" },
        source,
        ownerRange: node.range,
        termRank,
        pathRank,
      };
}

function outlineMembers(record: Record<string, unknown>): readonly unknown[] {
  if (record.members === undefined) return [];
  if (!Array.isArray(record.members)) throw new AstGrepSearchError();
  return record.members as unknown[];
}

function outlineNodes(items: unknown, source: SourceCandidate): readonly OutlineNode[] {
  if (!Array.isArray(items)) throw new AstGrepSearchError();
  const nodes: OutlineNode[] = [];
  const pending: unknown[] = [...(items as unknown[])];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    if (visited > MAX_STRUCTURAL_OUTLINE_NODES) throw new AstGrepSearchError();
    const record = asRecord(pending.shift());
    if (typeof record.name !== "string") throw new AstGrepSearchError();
    nodes.push({ name: record.name, range: sourceRange(record.range, source) });
    pending.push(...outlineMembers(record));
  }
  return nodes;
}

function parseOutline(value: unknown, source: SourceCandidate): readonly OutlineNode[] {
  if (!Array.isArray(value) || value.length !== 1) throw new AstGrepSearchError();
  const file = asRecord(value[0]);
  if (file.path !== "STDIN" || file.language !== source.spec.language) {
    throw new AstGrepSearchError();
  }
  return outlineNodes(file.items, source);
}

function validOwnerName(name: string): boolean {
  return name.length >= 3 && name.length <= 80 && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
}

function scanArguments(source: SourceCandidate, terms: readonly string[]): readonly string[] {
  return [
    "scan",
    "--stdin",
    "--inline-rules",
    inlineRule(source.spec, terms),
    "--json=compact",
    "--color",
    "never",
    "--threads",
    "1",
    "--max-results",
    String(MAX_STRUCTURAL_MATCHES),
  ];
}

function callerScanArguments(source: SourceCandidate, ownerName: string): readonly string[] {
  return [
    "scan",
    "--stdin",
    "--inline-rules",
    callerInlineRule(source.spec, ownerName),
    "--json=compact",
    "--color",
    "never",
    "--threads",
    "1",
    "--max-results",
    String(MAX_STRUCTURAL_MATCHES),
  ];
}

function outlineArguments(source: SourceCandidate): readonly string[] {
  return [
    "outline",
    "--stdin",
    "--lang",
    source.spec.language,
    "--json=compact",
    "--items",
    "structure",
    "--view",
    "expanded",
    "--color",
    "never",
    "--threads",
    "1",
  ];
}

async function inspectSource(
  binaryPath: string,
  source: SourceCandidate,
  terms: readonly string[],
  pathRank: number,
  deadlineMs?: number,
): Promise<readonly StructuralHit[]> {
  const [matches, outline] = await Promise.all([
    toolJson(binaryPath, scanArguments(source, terms), source, deadlineMs),
    toolJson(binaryPath, outlineArguments(source), source, deadlineMs),
  ]);
  const nodes = parseOutline(outline, source);
  const definitions = nodes
    .map((node) => definitionHit(node, source, terms, pathRank))
    .filter((hit): hit is StructuralHit => hit !== undefined);
  return [...definitions, ...parseOccurrences(matches, source, terms, nodes, pathRank)];
}

async function sourceCandidates(
  request: StructuralSearchRequest,
): Promise<readonly SourceCandidate[]> {
  const paths = [...new Set(request.candidatePaths.slice(0, 32))].filter(
    (path) =>
      languageForPath(path) !== undefined &&
      (path !== request.reviewPath ||
        (Number.isSafeInteger(request.findingAnchor.startLine) &&
          Number.isSafeInteger(request.findingAnchor.endLine) &&
          request.findingAnchor.startLine > 0 &&
          request.findingAnchor.endLine >= request.findingAnchor.startLine)),
  );
  const selected: SourceCandidate[] = [];
  let total = 0;
  // Read in caller rank order. Parallel reads here would retain up to 32 one-megabyte Git blobs
  // before applying the 512 KiB structural cap; sequential backfill keeps at most one unadmitted
  // blob in flight while still skipping absent, unsupported, or oversized leading paths.
  for (const path of paths) {
    if (selected.length === MAX_STRUCTURAL_FILES) break;
    const spec = languageForPath(path);
    if (spec === undefined) continue;
    const source = await readTextAtCommit(
      {
        ...request.context,
        timeoutMs: structuralTimeoutMs(request.deadlineMs, request.context.timeoutMs),
      },
      request.head,
      path,
    );
    if (source === undefined) continue;
    const bytes = Buffer.from(source, "utf8");
    if (
      bytes.byteLength > MAX_STRUCTURAL_FILE_BYTES ||
      total + bytes.byteLength > MAX_STRUCTURAL_TOTAL_BYTES
    ) {
      continue;
    }
    total += bytes.byteLength;
    selected.push({ path, source, lines: source.split("\n"), bytes, spec });
  }
  return selected;
}

function compareStructuralHits(left: StructuralHit, right: StructuralHit): number {
  return (
    left.termRank - right.termRank ||
    left.pathRank - right.pathRank ||
    STRUCTURAL_KIND_ORDER[left.anchor.kind] - STRUCTURAL_KIND_ORDER[right.anchor.kind] ||
    left.anchor.line - right.anchor.line
  );
}

function uniqueStructuralHits(hits: readonly StructuralHit[]): readonly StructuralHit[] {
  const unique = new Map<string, StructuralHit>();
  for (const hit of [...hits].sort(compareStructuralHits)) {
    const key = `${hit.anchor.path}\u0000${String(hit.anchor.line)}`;
    const existing = unique.get(key);
    if (
      existing === undefined ||
      STRUCTURAL_KIND_ORDER[hit.anchor.kind] < STRUCTURAL_KIND_ORDER[existing.anchor.kind]
    ) {
      unique.set(key, hit);
    }
  }
  return [...unique.values()].sort(compareStructuralHits);
}

function reserveFirstHit(
  hits: readonly StructuralHit[],
  reserved: StructuralHit[],
  matches: (hit: StructuralHit) => boolean,
): void {
  const hit = hits.find(matches);
  if (hit !== undefined && !reserved.includes(hit)) reserved.push(hit);
}

function reservedStructuralHits(
  hits: readonly StructuralHit[],
  termCount: number,
  pathCount: number,
): readonly StructuralHit[] {
  const reserved: StructuralHit[] = [];
  // This order is a cross-layer contract: the verifier accepts only three path chunks. One anchor
  // for every requested term must therefore precede kind/path diversity, or several term-zero
  // sightings can consume that later boundary before term one and term two ever reach it.
  for (let termRank = 0; termRank < termCount; termRank += 1) {
    reserveFirstHit(hits, reserved, (hit) => hit.termRank === termRank);
  }
  for (const kind of ["definition", "test", "callsite"] as const) {
    reserveFirstHit(hits, reserved, (hit) => hit.anchor.kind === kind);
  }
  for (let pathRank = 0; pathRank < pathCount; pathRank += 1) {
    reserveFirstHit(hits, reserved, (hit) => hit.pathRank === pathRank);
  }
  return reserved;
}

function inclusiveRangeEndLine(source: SourceCandidate, range: SourceRange): number {
  // ast-grep ranges are half-open. Reading `range.end.line` as inclusive would admit the first
  // line of the next sibling whenever a node ends at column zero; the final owned byte cannot.
  if (range.byteOffset.end <= range.byteOffset.start) return range.start.line;
  return lineAtByteOffset(source.bytes, range.byteOffset.end - 1);
}

function validAnchorRange(anchor: EvidenceLineRange): boolean {
  return (
    Number.isSafeInteger(anchor.startLine) &&
    Number.isSafeInteger(anchor.endLine) &&
    anchor.startLine >= 1 &&
    anchor.endLine >= anchor.startLine
  );
}

function ownsCompleteAnchor(
  node: OutlineNode,
  source: SourceCandidate,
  first: number,
  last: number,
): boolean {
  return (
    validOwnerName(node.name) &&
    node.range.start.line <= first &&
    inclusiveRangeEndLine(source, node.range) >= last
  );
}

function narrowerOwner(candidate: OutlineNode, selected: OutlineNode | undefined): boolean {
  return (
    selected === undefined ||
    candidate.range.byteOffset.end - candidate.range.byteOffset.start <
      selected.range.byteOffset.end - selected.range.byteOffset.start
  );
}

function anchorOwner(
  nodes: readonly OutlineNode[],
  source: SourceCandidate,
  anchor: EvidenceLineRange,
): AnchorOwner | undefined {
  if (!validAnchorRange(anchor)) return undefined;
  const first = anchor.startLine - 1;
  const last = anchor.endLine - 1;
  let selected: OutlineNode | undefined;
  for (const node of nodes) {
    if (ownsCompleteAnchor(node, source, first, last) && narrowerOwner(node, selected))
      selected = node;
  }
  if (selected === undefined) return undefined;
  const line = identifierLine(source, selected.range, selected.name);
  const content = line === undefined ? undefined : sourceLine(source, line);
  return line === undefined || content === undefined
    ? undefined
    : {
        name: selected.name,
        definition: {
          path: source.path,
          line: line + 1,
          content,
          kind: "definition",
        },
      };
}

function smallestContainingOwner(
  nodes: readonly OutlineNode[],
  occurrence: SourceRange,
): OutlineNode | undefined {
  let selected: OutlineNode | undefined;
  for (const node of nodes) {
    if (
      !validOwnerName(node.name) ||
      node.range.byteOffset.start > occurrence.byteOffset.start ||
      node.range.byteOffset.end < occurrence.byteOffset.end
    ) {
      continue;
    }
    if (narrowerOwner(node, selected)) selected = node;
  }
  return selected;
}

function ownerFromNode(node: OutlineNode, source: SourceCandidate): AnchorOwner | undefined {
  const line = identifierLine(source, node.range, node.name);
  const content = line === undefined ? undefined : sourceLine(source, line);
  return line === undefined || content === undefined
    ? undefined
    : {
        name: node.name,
        definition: { path: source.path, line: line + 1, content, kind: "definition" },
      };
}

function directCallRange(
  candidate: unknown,
  source: SourceCandidate,
  ownerName: string,
  findingAnchor: EvidenceLineRange,
): SourceRange | undefined {
  const record = asRecord(candidate);
  if (
    record.file !== "STDIN" ||
    record.language !== source.spec.language ||
    typeof record.text !== "string"
  ) {
    throw new AstGrepSearchError();
  }
  const range = sourceRange(record.range, source);
  const exact = source.bytes
    .subarray(range.byteOffset.start, range.byteOffset.end)
    .toString("utf8");
  if (exact !== record.text) throw new AstGrepSearchError();
  // The AST rule admits call nodes with an exact identifier child. Requiring the call itself to
  // begin with that identifier excludes method/property calls such as `api.ownerName()` and any
  // identifier which appears only in an argument. Comments, strings and imports are not call
  // nodes and therefore never reach this boundary in the first place.
  if (!exact.startsWith(ownerName) || !/^\s*\(/u.test(exact.slice(ownerName.length))) {
    return undefined;
  }
  return isOutsideAnchorContext(range.start.line + 1, findingAnchor) ? range : undefined;
}

function directCallRanges(
  value: unknown,
  source: SourceCandidate,
  ownerName: string,
  findingAnchor: EvidenceLineRange,
): readonly SourceRange[] {
  if (!Array.isArray(value) || value.length > MAX_STRUCTURAL_MATCHES) {
    throw new AstGrepSearchError();
  }
  return value
    .map((candidate) => directCallRange(candidate, source, ownerName, findingAnchor))
    .filter((range): range is SourceRange => range !== undefined)
    .sort((left, right) => left.byteOffset.start - right.byteOffset.start);
}

function contextEntries(hit: StructuralHit): readonly StructuralEvidenceEntry[] {
  const anchorLine = hit.anchor.line - 1;
  const startLine = hit.ownerRange?.start.line ?? 0;
  const endLine =
    hit.ownerRange === undefined
      ? Math.max(0, hit.source.lines.length - 1)
      : inclusiveRangeEndLine(hit.source, hit.ownerRange);
  const offsets =
    hit.anchor.kind === "definition" ? DEFINITION_CONTEXT_OFFSETS : OCCURRENCE_CONTEXT_OFFSETS;
  const entries: StructuralEvidenceEntry[] = [];
  for (const offset of offsets) {
    const line = anchorLine + offset;
    if (line < startLine || line > endLine) continue;
    const content = sourceLine(hit.source, line);
    if (content === undefined || content.trim() === "") continue;
    entries.push({
      path: hit.anchor.path,
      line: line + 1,
      content,
      kind: hit.anchor.kind,
    });
  }
  return entries;
}

function interleaveContextEntries(
  hits: readonly StructuralHit[],
): readonly PrioritizedStructuralEntry[] {
  const groups = hits.map(contextEntries);
  const entries: PrioritizedStructuralEntry[] = [];
  const maximumLength = Math.max(0, ...groups.map((group) => group.length));
  for (let offset = 0; offset < maximumLength; offset += 1) {
    for (const group of groups) {
      const entry = group[offset];
      if (entry !== undefined) entries.push({ entry, anchor: false });
    }
  }
  return entries;
}

function boundedStructuralEntries(
  hits: readonly StructuralHit[],
  termCount: number,
  pathCount: number,
  request: StructuralSearchRequest,
): readonly RepositoryEvidenceEntry[] {
  // Anchors that establish requested-term, evidence-kind, and caller-ranked-path diversity are
  // non-negotiable. Their AST-owned source windows come next; repeated identifier sightings are
  // ballast and may use only what remains of the fixed structural result budget.
  const eligible = (entry: RepositoryEvidenceEntry): boolean =>
    entry.path !== request.reviewPath || isOutsideAnchorContext(entry.line, request.findingAnchor);
  const ranked = uniqueStructuralHits(hits.filter((hit) => eligible(hit.anchor)));
  const reserved = reservedStructuralHits(ranked, termCount, pathCount);
  const reservation = new Set(reserved);
  const ballast = ranked.filter((hit) => !reservation.has(hit));
  const prioritized: PrioritizedStructuralEntry[] = [
    ...reserved.map((hit) => ({ entry: hit.anchor, anchor: true })),
    ...interleaveContextEntries(reserved),
    ...ballast.map((hit) => ({ entry: hit.anchor, anchor: true })),
  ].filter((candidate) => eligible(candidate.entry));
  const unique = new Map<string, PrioritizedStructuralEntry>();
  for (const candidate of prioritized) {
    const key = `${candidate.entry.path}\u0000${String(candidate.entry.line)}`;
    const existing = unique.get(key);
    if (existing === undefined) {
      if (unique.size < MAX_STRUCTURAL_MATCHES) unique.set(key, candidate);
      continue;
    }
    if (
      candidate.anchor &&
      (!existing.anchor ||
        STRUCTURAL_KIND_ORDER[candidate.entry.kind] < STRUCTURAL_KIND_ORDER[existing.entry.kind])
    ) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()].map(({ entry }) => entry);
}

/** Structural fallback over exact immutable HEAD blobs, supplied to ast-grep only through stdin. */
export async function searchAstGrepAtHead(
  request: StructuralSearchRequest,
  dependencies: StructuralSearchDependencies = {},
): Promise<readonly RepositoryEvidenceEntry[]> {
  const terms = normalizedStructuralTerms(request.terms);
  if (terms.length === 0) return [];
  structuralTimeoutMs(request.deadlineMs, STRUCTURAL_PROCESS_TIMEOUT_MS);
  const sources = await sourceCandidates(request);
  if (sources.length === 0) {
    // No candidate path means there was no structural search to run. Candidate paths with no
    // readable, supported, bounded blob mean the requested fallback was unavailable, not that the
    // repository contained zero matches; the caller decides whether that unavailable result is
    // optional or must fail the verification closed.
    if (request.candidatePaths.length === 0) return [];
    throw new AstGrepSearchError();
  }
  let binaryPath: string;
  try {
    structuralTimeoutMs(request.deadlineMs, STRUCTURAL_PROCESS_TIMEOUT_MS);
    binaryPath =
      dependencies.acquireBinary === undefined
        ? await acquireDefaultAstGrep(request.deadlineMs)
        : await dependencies.acquireBinary();
    structuralTimeoutMs(request.deadlineMs, STRUCTURAL_PROCESS_TIMEOUT_MS);
  } catch (error) {
    throw new AstGrepSearchError(error);
  }
  const hits: StructuralHit[] = [];
  // Keep the process fan-out bounded to one blob at a time. `inspectSource` deliberately runs that
  // blob's scan and outline together, so structural retrieval starts at most two parser processes
  // concurrently even when all four source slots are populated.
  for (const [pathRank, source] of sources.entries()) {
    hits.push(...(await inspectSource(binaryPath, source, terms, pathRank, request.deadlineMs)));
  }
  return boundedStructuralEntries(hits, terms.length, sources.length, request);
}

/**
 * Find the smallest named AST structure that owns the complete reviewed anchor.
 *
 * The source is the same bounded immutable blob used by structural retrieval and reaches the
 * digest-pinned parser only through stdin. Returning `undefined` is a valid "no named owner"
 * result; acquisition, execution, and malformed-output failures remain distinguishable errors so
 * the caller can preserve clear lexical evidence without mistaking infrastructure loss for proof.
 */
export async function findAstAnchorOwnerAtHead(
  request: AnchorOwnerSearchRequest,
  dependencies: StructuralSearchDependencies = {},
): Promise<AnchorOwner | undefined> {
  structuralTimeoutMs(request.deadlineMs, STRUCTURAL_PROCESS_TIMEOUT_MS);
  const sourceRequest: StructuralSearchRequest = {
    ...request,
    candidatePaths: [request.reviewPath],
    terms: [],
  };
  const source = (await sourceCandidates(sourceRequest))[0];
  if (source === undefined) return undefined;
  let binaryPath: string;
  try {
    binaryPath =
      dependencies.acquireBinary === undefined
        ? await acquireDefaultAstGrep(request.deadlineMs)
        : await dependencies.acquireBinary();
    structuralTimeoutMs(request.deadlineMs, STRUCTURAL_PROCESS_TIMEOUT_MS);
  } catch (error) {
    throw new AstGrepSearchError(error);
  }
  const outline = await toolJson(binaryPath, outlineArguments(source), source, request.deadlineMs);
  return anchorOwner(parseOutline(outline, source), source, request.findingAnchor);
}

/**
 * Find the owner of one distant direct call to `ownerName` in the reviewed immutable blob.
 *
 * This is deliberately not a general caller graph. The pinned parser proves one exact direct-call
 * identifier, the occurrence must lie outside the already-rendered anchor window, and only the
 * smallest named structure which owns the first eligible occurrence may be returned. A recursive
 * call is terminal (`undefined`) rather than walking outward to another ancestor.
 */
export async function findAstCallerOwnerAtHead(
  request: CallerOwnerSearchRequest,
  dependencies: StructuralSearchDependencies = {},
): Promise<AnchorOwner | undefined> {
  if (!validAnchorRange(request.findingAnchor) || !validOwnerName(request.ownerName)) {
    return undefined;
  }
  structuralTimeoutMs(request.deadlineMs, STRUCTURAL_PROCESS_TIMEOUT_MS);
  const sourceRequest: StructuralSearchRequest = {
    ...request,
    candidatePaths: [request.reviewPath],
    terms: [],
  };
  const source = (await sourceCandidates(sourceRequest))[0];
  if (source === undefined) return undefined;
  let binaryPath: string;
  try {
    binaryPath =
      dependencies.acquireBinary === undefined
        ? await acquireDefaultAstGrep(request.deadlineMs)
        : await dependencies.acquireBinary();
    structuralTimeoutMs(request.deadlineMs, STRUCTURAL_PROCESS_TIMEOUT_MS);
  } catch (error) {
    throw new AstGrepSearchError(error);
  }
  const [calls, outline] = await Promise.all([
    toolJson(
      binaryPath,
      callerScanArguments(source, request.ownerName),
      source,
      request.deadlineMs,
    ),
    toolJson(binaryPath, outlineArguments(source), source, request.deadlineMs),
  ]);
  const nodes = parseOutline(outline, source);
  for (const occurrence of directCallRanges(
    calls,
    source,
    request.ownerName,
    request.findingAnchor,
  )) {
    const caller = smallestContainingOwner(nodes, occurrence);
    if (caller === undefined) continue;
    // Do not turn recursion into a second hop by skipping the real owner and selecting an ancestor.
    if (caller.name === request.ownerName) return undefined;
    return ownerFromNode(caller, source);
  }
  return undefined;
}
