import { dirname, extname, isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import type { CommitSha } from "../core/brands.js";
import { run } from "../git/exec.js";
import { readTextAtCommit, verifyCommit, type GitContext } from "../git/plumbing.js";
import { acquireDefaultAstGrep } from "./ast-grep-acquire.js";
import type { EvidenceLineRange } from "./evidence.js";
import {
  CLOSED_RUNTIME_FACT_CATALOG,
  CLOSED_RUNTIME_FACT_CATALOG_VERSION,
  type ClosedRuntimeFact,
  type ClosedRuntimeFactSide,
} from "./runtime-fact-catalog.js";

export const MAX_CLOSED_RUNTIME_FACTS = 2;

export interface ClosedRuntimeFactsRequest {
  readonly context: GitContext;
  readonly commit: CommitSha;
  readonly path: string;
  readonly side: ClosedRuntimeFactSide;
  readonly findingAnchor: EvidenceLineRange;
  /** Absolute whole-review boundary. Absent only for standalone callers. */
  readonly deadlineMs?: number;
}

export interface ClosedRuntimeFactsDependencies {
  readonly acquireBinary?: () => Promise<string>;
}

export class ClosedRuntimeFactsError extends Error {
  public constructor(cause?: unknown) {
    super("closed runtime facts unavailable", { cause });
    this.name = "ClosedRuntimeFactsError";
  }
}

const MAX_RUNTIME_SOURCE_BYTES = 192 * 1024;
const MAX_RUNTIME_OUTPUT_BYTES = 384 * 1024;
const RUNTIME_PROCESS_TIMEOUT_MS = 2_000;
const OBJECT_SPREAD_RULE_ID = "kfq-closed-runtime-object-spread";
const SPREAD_TOKEN_BYTES = 3;

type RuntimeLanguage = "JavaScript" | "TypeScript" | "Tsx";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, RuntimeLanguage>> = {
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".mts": "TypeScript",
  ".ts": "TypeScript",
  ".tsx": "Tsx",
};

interface SourceRange {
  readonly byteOffset: { readonly start: number; readonly end: number };
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
}

interface RuntimeSource {
  readonly bytes: Buffer;
  readonly lastLine: number;
  readonly language: RuntimeLanguage;
}

function validAnchor(anchor: EvidenceLineRange): boolean {
  return (
    Number.isSafeInteger(anchor.startLine) &&
    Number.isSafeInteger(anchor.endLine) &&
    anchor.startLine > 0 &&
    anchor.endLine >= anchor.startLine
  );
}

function safeRuntimePath(path: string): boolean {
  if (path === "" || path.length > 4_096 || isAbsolute(path) || path.endsWith("/")) return false;
  // eslint-disable-next-line no-control-regex -- Git paths containing controls are never eligible.
  if (/[\u0000-\u001f\u007f-\u009f\\]/u.test(path) || /^[A-Za-z]:/u.test(path)) return false;
  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function runtimeLanguage(path: string): RuntimeLanguage | undefined {
  return safeRuntimePath(path) ? LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] : undefined;
}

function boundedTimeout(request: ClosedRuntimeFactsRequest): number {
  const contextMaximum = Math.min(RUNTIME_PROCESS_TIMEOUT_MS, request.context.timeoutMs);
  if (!Number.isSafeInteger(contextMaximum) || contextMaximum <= 0) {
    throw new ClosedRuntimeFactsError();
  }
  if (request.deadlineMs === undefined) return contextMaximum;
  const remaining = Math.max(0, Math.trunc(request.deadlineMs - Date.now()));
  if (remaining === 0) throw new ClosedRuntimeFactsError();
  return Math.min(contextMaximum, remaining);
}

function inlineObjectSpreadRule(language: RuntimeLanguage): string {
  return [
    `id: ${OBJECT_SPREAD_RULE_ID}`,
    `language: ${language}`,
    "severity: hint",
    "message: closed runtime object spread",
    "rule:",
    "  kind: spread_element",
    "  inside:",
    "    kind: object",
  ].join("\n");
}

function scanArguments(language: RuntimeLanguage, maximumMatches: number): readonly string[] {
  return [
    "scan",
    "--stdin",
    "--inline-rules",
    inlineObjectSpreadRule(language),
    "--json=compact",
    "--color",
    "never",
    "--threads",
    "1",
    "--max-results",
    String(maximumMatches),
  ];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClosedRuntimeFactsError();
  }
  return value as Readonly<Record<string, unknown>>;
}

function safeInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new ClosedRuntimeFactsError();
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

function sourceRange(value: unknown, source: RuntimeSource): SourceRange {
  const range = asRecord(value);
  const offsets = asRecord(range.byteOffset);
  const start = asRecord(range.start);
  const end = asRecord(range.end);
  const parsed: SourceRange = {
    byteOffset: {
      start: safeInteger(offsets.start, source.bytes.byteLength),
      end: safeInteger(offsets.end, source.bytes.byteLength),
    },
    start: {
      line: safeInteger(start.line, source.lastLine),
      column: safeInteger(start.column, MAX_RUNTIME_SOURCE_BYTES),
    },
    end: {
      line: safeInteger(end.line, source.lastLine),
      column: safeInteger(end.column, MAX_RUNTIME_SOURCE_BYTES),
    },
  };
  if (parsed.byteOffset.end <= parsed.byteOffset.start || parsed.end.line < parsed.start.line) {
    throw new ClosedRuntimeFactsError();
  }
  if (
    lineAtByteOffset(source.bytes, parsed.byteOffset.start) !== parsed.start.line ||
    lineAtByteOffset(source.bytes, parsed.byteOffset.end) !== parsed.end.line
  ) {
    throw new ClosedRuntimeFactsError();
  }
  return parsed;
}

function matchLine(value: unknown, source: RuntimeSource): number {
  const record = asRecord(value);
  if (
    record.file !== "STDIN" ||
    record.language !== source.language ||
    record.ruleId !== OBJECT_SPREAD_RULE_ID ||
    typeof record.text !== "string" ||
    !record.text.startsWith("...")
  ) {
    throw new ClosedRuntimeFactsError();
  }
  const range = sourceRange(record.range, source);
  const matched = source.bytes
    .subarray(range.byteOffset.start, range.byteOffset.end)
    .toString("utf8");
  if (matched !== record.text) throw new ClosedRuntimeFactsError();
  return range.start.line + 1;
}

function parseMatchLines(
  output: Buffer,
  source: RuntimeSource,
  maximumMatches: number,
): readonly number[] {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch (error) {
    throw new ClosedRuntimeFactsError(error);
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch (error) {
    throw new ClosedRuntimeFactsError(error);
  }
  if (!Array.isArray(value) || value.length > maximumMatches) {
    throw new ClosedRuntimeFactsError();
  }
  return value.map((match) => matchLine(match, source));
}

function factAt(request: ClosedRuntimeFactsRequest, line: number): ClosedRuntimeFact {
  return {
    catalogVersion: CLOSED_RUNTIME_FACT_CATALOG_VERSION,
    id: "ecmascript.object_spread.nullish_source_is_noop",
    statement: CLOSED_RUNTIME_FACT_CATALOG["ecmascript.object_spread.nullish_source_is_noop"],
    source: { path: request.path, side: request.side, line },
  };
}

async function exactRuntimeSource(
  request: ClosedRuntimeFactsRequest,
  language: RuntimeLanguage,
): Promise<RuntimeSource | undefined> {
  const context = { ...request.context, timeoutMs: boundedTimeout(request) };
  try {
    await verifyCommit(context, request.commit);
    const text = await readTextAtCommit(context, request.commit, request.path);
    if (text === undefined) return undefined;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength > MAX_RUNTIME_SOURCE_BYTES) return undefined;
    return { bytes, lastLine: text.split("\n").length - 1, language };
  } catch (error) {
    throw new ClosedRuntimeFactsError(error);
  }
}

async function scanObjectSpreads(
  request: ClosedRuntimeFactsRequest,
  source: RuntimeSource,
  dependencies: ClosedRuntimeFactsDependencies,
): Promise<readonly number[]> {
  try {
    // Every AST spread node owns a distinct three-byte `...` token. This source-derived ceiling is
    // therefore at least the total possible match count for the bounded blob, unlike a fixed
    // prefix cap that could silently stop before the finding anchor. Output remains independently
    // bounded; an exceptionally noisy or overlapping result fails closed instead of being partial.
    const maximumMatches = Math.floor(source.bytes.byteLength / SPREAD_TOKEN_BYTES) + 1;
    const binary =
      dependencies.acquireBinary === undefined
        ? await acquireDefaultAstGrep(request.deadlineMs)
        : await dependencies.acquireBinary();
    const result = await run(binary, scanArguments(source.language, maximumMatches), {
      cwd: dirname(binary),
      timeoutMs: boundedTimeout(request),
      maxBuffer: MAX_RUNTIME_OUTPUT_BYTES,
      input: source.bytes,
      env: { PATH: "", HOME: dirname(binary), LC_ALL: "C", NO_COLOR: "1" },
    });
    if (result.stderr !== "") throw new ClosedRuntimeFactsError();
    return parseMatchLines(result.stdout, source, maximumMatches);
  } catch (error) {
    if (error instanceof ClosedRuntimeFactsError) throw error;
    throw new ClosedRuntimeFactsError(error);
  }
}

/**
 * Detect closed, versioned runtime facts at one reviewed range without executing candidate code.
 *
 * The only source is a blob at the supplied immutable commit. A digest-pinned ast-grep executable
 * receives that complete bounded blob through stdin and may select only syntax covered by the
 * closed catalog. Its source-derived result ceiling cannot stop before an anchored match; a fixed
 * output-byte ceiling still makes exceptionally noisy results fail closed rather than partial.
 */
export async function collectClosedRuntimeFactsAtCommit(
  request: ClosedRuntimeFactsRequest,
  dependencies: ClosedRuntimeFactsDependencies = {},
): Promise<readonly ClosedRuntimeFact[]> {
  if (!validAnchor(request.findingAnchor)) return [];
  const language = runtimeLanguage(request.path);
  if (language === undefined) return [];
  const source = await exactRuntimeSource(request, language);
  if (source === undefined) return [];
  const lines = await scanObjectSpreads(request, source, dependencies);
  const selected = [...new Set([...lines].sort((left, right) => left - right))]
    .filter(
      (line) => line >= request.findingAnchor.startLine && line <= request.findingAnchor.endLine,
    )
    .slice(0, MAX_CLOSED_RUNTIME_FACTS);
  return selected.map((line) => factAt(request, line));
}
