import { dirname, extname } from "node:path";

import type { CommitSha } from "../core/brands.js";
import { run } from "../git/exec.js";
import { readTextAtCommit, type GitContext } from "../git/plumbing.js";
import { acquireDefaultAstGrep } from "./ast-grep-acquire.js";
import type { RepositoryEvidenceEntry } from "./evidence.js";

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
}

const JAVASCRIPT: LanguageSpec = {
  language: "JavaScript",
  identifierKinds: "identifier,property_identifier,shorthand_property_identifier",
};
const TYPESCRIPT: LanguageSpec = {
  language: "TypeScript",
  identifierKinds: "identifier,property_identifier,shorthand_property_identifier",
};
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, LanguageSpec>> = {
  ".c": { language: "C", identifierKinds: "identifier,field_identifier,type_identifier" },
  ".cc": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
  },
  ".cpp": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
  },
  ".cs": { language: "CSharp", identifierKinds: "identifier" },
  ".cts": TYPESCRIPT,
  ".cxx": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
  },
  ".go": { language: "Go", identifierKinds: "identifier,field_identifier,type_identifier" },
  ".h": { language: "C", identifierKinds: "identifier,field_identifier,type_identifier" },
  ".hh": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
  },
  ".hpp": {
    language: "Cpp",
    identifierKinds: "identifier,field_identifier,type_identifier,namespace_identifier",
  },
  ".java": { language: "Java", identifierKinds: "identifier" },
  ".js": JAVASCRIPT,
  ".jsx": JAVASCRIPT,
  ".mjs": JAVASCRIPT,
  ".mts": TYPESCRIPT,
  ".py": { language: "Python", identifierKinds: "identifier" },
  ".pyi": { language: "Python", identifierKinds: "identifier" },
  ".rs": { language: "Rust", identifierKinds: "identifier,field_identifier,type_identifier" },
  ".ts": TYPESCRIPT,
  ".tsx": {
    language: "Tsx",
    identifierKinds: "identifier,property_identifier,shorthand_property_identifier",
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
  readonly candidatePaths: readonly string[];
  readonly terms: readonly string[];
  /** Absolute whole-review boundary. Absent only for standalone callers. */
  readonly deadlineMs?: number;
}

export interface StructuralSearchDependencies {
  readonly acquireBinary?: () => Promise<string>;
}

interface SourceCandidate {
  readonly path: string;
  readonly source: string;
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
      line: safeInteger(start.line, source.source.split("\n").length),
      column: safeInteger(start.column, MAX_STRUCTURAL_FILE_BYTES),
    },
    end: {
      line: safeInteger(end.line, source.source.split("\n").length),
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

function exactTerms(terms: readonly string[]): readonly string[] {
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

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
  const content = source.source.split("\n")[line];
  return content === undefined || content.length > MAX_ENTRY_LINE_CHARS ? undefined : content;
}

function validMatchedText(record: Record<string, unknown>, terms: readonly string[]): string {
  if (typeof record.text !== "string" || !terms.includes(record.text)) {
    throw new AstGrepSearchError();
  }
  return record.text;
}

function occurrenceEntry(
  value: unknown,
  source: SourceCandidate,
  terms: readonly string[],
): RepositoryEvidenceEntry | undefined {
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
  return content === undefined
    ? undefined
    : {
        path: source.path,
        line: range.start.line + 1,
        content,
        kind: /(?:(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|(?:\.spec|\.test)\.[^/]+$)/u.test(
          source.path,
        )
          ? "test"
          : "callsite",
      };
}

function parseOccurrences(
  value: unknown,
  source: SourceCandidate,
  terms: readonly string[],
): readonly RepositoryEvidenceEntry[] {
  if (!Array.isArray(value) || value.length > MAX_STRUCTURAL_MATCHES) {
    throw new AstGrepSearchError();
  }
  return value
    .map((item) => occurrenceEntry(item, source, terms))
    .filter((item): item is RepositoryEvidenceEntry => item !== undefined);
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

function definitionEntry(
  record: Record<string, unknown>,
  source: SourceCandidate,
  terms: readonly string[],
): RepositoryEvidenceEntry | undefined {
  if (typeof record.name !== "string") throw new AstGrepSearchError();
  const range = sourceRange(record.range, source);
  if (!terms.includes(record.name)) return undefined;
  const line = identifierLine(source, range, record.name);
  const content = line === undefined ? undefined : sourceLine(source, line);
  return line === undefined || content === undefined
    ? undefined
    : { path: source.path, line: line + 1, content, kind: "definition" };
}

function outlineMembers(record: Record<string, unknown>): readonly unknown[] {
  if (record.members === undefined) return [];
  if (!Array.isArray(record.members)) throw new AstGrepSearchError();
  return record.members as unknown[];
}

function outlineDefinitions(
  items: unknown,
  source: SourceCandidate,
  terms: readonly string[],
): readonly RepositoryEvidenceEntry[] {
  if (!Array.isArray(items)) throw new AstGrepSearchError();
  const definitions: RepositoryEvidenceEntry[] = [];
  const pending: unknown[] = [...(items as unknown[])];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    if (visited > MAX_STRUCTURAL_OUTLINE_NODES) throw new AstGrepSearchError();
    const record = asRecord(pending.shift());
    const definition = definitionEntry(record, source, terms);
    if (definition !== undefined) definitions.push(definition);
    pending.push(...outlineMembers(record));
  }
  return definitions;
}

function parseOutline(
  value: unknown,
  source: SourceCandidate,
  terms: readonly string[],
): readonly RepositoryEvidenceEntry[] {
  if (!Array.isArray(value) || value.length !== 1) throw new AstGrepSearchError();
  const file = asRecord(value[0]);
  if (file.path !== "STDIN" || file.language !== source.spec.language) {
    throw new AstGrepSearchError();
  }
  return outlineDefinitions(file.items, source, terms);
}

async function inspectSource(
  binaryPath: string,
  source: SourceCandidate,
  terms: readonly string[],
  deadlineMs?: number,
): Promise<readonly RepositoryEvidenceEntry[]> {
  const [matches, outline] = await Promise.all([
    toolJson(
      binaryPath,
      [
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
      ],
      source,
      deadlineMs,
    ),
    toolJson(
      binaryPath,
      [
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
      ],
      source,
      deadlineMs,
    ),
  ]);
  return [...parseOutline(outline, source, terms), ...parseOccurrences(matches, source, terms)];
}

async function sourceCandidates(
  request: StructuralSearchRequest,
): Promise<readonly SourceCandidate[]> {
  const paths = [...new Set(request.candidatePaths.slice(0, 32))]
    .filter((path) => path !== request.reviewPath && languageForPath(path) !== undefined)
    .sort((left, right) => left.localeCompare(right, "en"))
    .slice(0, MAX_STRUCTURAL_FILES);
  const read = await Promise.all(
    paths.map(async (path): Promise<SourceCandidate | undefined> => {
      const spec = languageForPath(path);
      if (spec === undefined) return undefined;
      const source = await readTextAtCommit(
        {
          ...request.context,
          timeoutMs: structuralTimeoutMs(request.deadlineMs, request.context.timeoutMs),
        },
        request.head,
        path,
      );
      if (source === undefined) return undefined;
      const bytes = Buffer.from(source, "utf8");
      return bytes.byteLength > MAX_STRUCTURAL_FILE_BYTES
        ? undefined
        : { path, source, bytes, spec };
    }),
  );
  const selected: SourceCandidate[] = [];
  let total = 0;
  for (const source of read) {
    if (source === undefined) continue;
    total += source.bytes.byteLength;
    if (total > MAX_STRUCTURAL_TOTAL_BYTES) break;
    selected.push(source);
  }
  return selected;
}

/** Structural fallback over exact immutable HEAD blobs, supplied to ast-grep only through stdin. */
export async function searchAstGrepAtHead(
  request: StructuralSearchRequest,
  dependencies: StructuralSearchDependencies = {},
): Promise<readonly RepositoryEvidenceEntry[]> {
  const terms = exactTerms(request.terms);
  if (terms.length === 0) return [];
  structuralTimeoutMs(request.deadlineMs, STRUCTURAL_PROCESS_TIMEOUT_MS);
  const sources = await sourceCandidates(request);
  if (sources.length === 0) return [];
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
  const entries = (
    await Promise.all(
      sources.map((source) => inspectSource(binaryPath, source, terms, request.deadlineMs)),
    )
  ).flat();
  const unique = new Map<string, RepositoryEvidenceEntry>();
  for (const entry of entries) {
    const key = `${entry.path}\u0000${String(entry.line)}`;
    const existing = unique.get(key);
    if (existing === undefined || (entry.kind === "definition" && existing.kind !== "definition")) {
      unique.set(key, entry);
    }
  }
  return [...unique.values()].slice(0, MAX_STRUCTURAL_MATCHES);
}
