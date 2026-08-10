/**
 * Bounded exact-HEAD repository retrieval for the independent finding judge.
 *
 * This module contains no model logic. The caller may run the initial deterministic stage, ask the
 * judge for one small list of identifiers, then run the explicit follow-up stage once. Every Git
 * access is a shell-free, read-only command against the supplied commit; candidate source, paths,
 * and terms are never executed or materialized in the worktree.
 */

import type { CommitSha } from "../core/brands.js";
import { ExecFailure, gitEnvironment, run, runBoundedLineRecords } from "../git/exec.js";
import { readTextAtCommit, verifyCommit, type GitContext } from "../git/plumbing.js";
import {
  extractEvidenceIdentifiers,
  isOutsideAnchorContext,
  type EvidenceLineRange,
  type RepositoryEvidenceContext,
  type RepositoryEvidenceEntry,
  type RepositoryEvidenceKind,
} from "./evidence.js";
import {
  findAstAnchorOwnerAtHead,
  findAstCallerOwnerAtHead,
  isStructurallySearchablePath,
  normalizedStructuralTerms,
  searchAstGrepAtHead,
  type AnchorOwner,
  type AnchorOwnerSearchRequest,
  type CallerOwnerSearchRequest,
  type StructuralSearchRequest,
} from "./ast-grep-search.js";

export const MAX_REPOSITORY_INITIAL_TERMS = 6;
export const MAX_REPOSITORY_FOLLOW_UP_TERMS = 3;

const MAX_GREP_TERMS = 8;
const MAX_RAW_MATCHES = 96;
const MAX_STRUCTURAL_CANDIDATE_PATHS_PER_TERM = 4;
const MAX_DETERMINISTIC_FALLBACK_TERMS = 3;
const FALLBACK_DECLARATION_RADIUS = 32;
const MAX_CODE_ENTRIES = 12;
const MAX_CODE_PATHS = 5;
const MAX_MANIFEST_FILES = 3;
const MAX_MANIFEST_SCAN_FILES = 8;
const MAX_MANIFEST_LINES = 4;
const MAX_MANIFEST_CANDIDATES = 48;
const MAX_MATCH_LINE_CHARS = 300;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 512 * 1024;
const RETRIEVAL_TERM = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u;
const TEST_PATH = /(?:(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|(?:\.spec|\.test)\.[^/]+$)/u;
const DECLARATION_HINT =
  /\b(?:class|const|def|enum|fn|func|function|interface|let|module|struct|trait|type|var)\b/u;
const MANIFEST_HINT =
  /\b(?:dependencies|devDependencies|engines|go|jsx|module|node|peerDependencies|python|react|runtime|rust-version|target|typescript|version)\b/iu;

const TERM_STOP_WORDS: ReadonlySet<string> = new Set([
  "config",
  "data",
  "error",
  "length",
  "input",
  "item",
  "path",
  "result",
  "state",
  "test",
  "text",
  "the",
  "value",
]);

const MANIFEST_NAMES = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "mise.toml",
  "global.json",
  "Directory.Build.props",
] as const;

const LOCKFILE_NAMES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "uv.lock",
] as const;

const MANIFEST_AND_LOCKFILE_NAMES = [...MANIFEST_NAMES, ...LOCKFILE_NAMES] as const;

const RUNTIME_MANIFESTS: ReadonlySet<string> = new Set([
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "go.mod",
]);

export interface RepositoryContextRequest {
  /** Trusted base checkout containing the candidate Git objects, never a candidate checkout. */
  readonly repositoryPath: string;
  readonly pathValue: string;
  readonly head: CommitSha;
  readonly base: CommitSha;
  readonly reviewPath: string;
  /** Path of the same file in BASE; differs from `reviewPath` for a rename. */
  readonly baseReviewPath: string;
  /** Finding range whose already-visible near window same-file retrieval must not duplicate. */
  readonly findingAnchor: EvidenceLineRange;
  /** Exact BASE projection of `findingAnchor`; absent means same-file BASE lookup is ineligible. */
  readonly baseFindingAnchor?: EvidenceLineRange;
  readonly findingContent: string;
  readonly anchorText: string;
  readonly unifiedDiff?: string;
  /** Absolute whole-review boundary. Absent only for standalone/replay callers. */
  readonly deadlineMs?: number;
}

/** Closed failure signal so a requested follow-up cannot silently masquerade as zero matches. */
export class RepositoryContextRetrievalError extends Error {
  public constructor(cause?: unknown) {
    super("repository context retrieval failed", { cause });
    this.name = "RepositoryContextRetrievalError";
  }
}

interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly content: string;
}

interface RankedGrepMatch extends GrepMatch {
  readonly termRank: number;
}

interface RankedEvidenceEntry extends RepositoryEvidenceEntry {
  readonly termRank: number;
}

interface GrepTermResult {
  readonly sightings: readonly GrepMatch[];
  readonly truncated: boolean;
}

interface GrepSearchResult {
  readonly matches: readonly RankedGrepMatch[];
  readonly candidatePaths: readonly string[];
  readonly truncated: boolean;
}

export type RepositoryEvidenceSide = "H" | "B";

/** Exact immutable source selected for one explicit verifier follow-up. */
export interface RepositoryFollowUpContext {
  readonly sourceCommit: CommitSha;
  readonly side: RepositoryEvidenceSide;
  readonly entries: readonly RepositoryEvidenceEntry[];
}

function eligibleRepositorySighting(
  request: RepositoryContextRequest,
  sighting: GrepMatch,
  allowDistantReviewPath: boolean,
): boolean {
  if (sighting.path !== request.reviewPath) return true;
  return allowDistantReviewPath && isOutsideAnchorContext(sighting.line, request.findingAnchor);
}

function eligibleStructuralPath(
  request: RepositoryContextRequest,
  sighting: GrepMatch,
  allowDistantReviewPath: boolean,
): boolean {
  if (sighting.path !== request.reviewPath) return true;
  // A same-file lexical sighting inside the visible window is enough to parse this one bounded
  // immutable blob: AST may find the requested producer/consumer farther away after git grep's
  // per-file prefix was consumed by near-anchor duplicates.
  return canSearchReviewedPath(request, allowDistantReviewPath);
}

function canSearchReviewedPath(
  request: RepositoryContextRequest,
  allowDistantReviewPath: boolean,
): boolean {
  return (
    allowDistantReviewPath &&
    Number.isSafeInteger(request.findingAnchor.startLine) &&
    Number.isSafeInteger(request.findingAnchor.endLine) &&
    request.findingAnchor.startLine > 0 &&
    request.findingAnchor.endLine >= request.findingAnchor.startLine
  );
}

function validTerm(term: string): boolean {
  const tail = term.split(".").at(-1)?.toLowerCase() ?? "";
  const qualified = term.includes(".");
  // `length` alone is too broad, while `String.length` is an exact and bounded Git literal.
  return (
    term.length >= 3 &&
    term.length <= 80 &&
    RETRIEVAL_TERM.test(term) &&
    !TERM_STOP_WORDS.has(term.toLowerCase()) &&
    (qualified || !TERM_STOP_WORDS.has(tail))
  );
}

/** Closed, stable identifier validation for the judge's one optional follow-up request. */
function boundedRetrieveTerms(terms: readonly string[], maximum: number): readonly string[] {
  if (maximum <= 0) return [];
  const accepted: string[] = [];
  const seen = new Set<string>();
  const ceiling = Math.min(MAX_REPOSITORY_INITIAL_TERMS, Math.max(0, maximum));
  for (const term of terms) {
    if (!validTerm(term) || seen.has(term)) continue;
    seen.add(term);
    accepted.push(term);
    if (accepted.length === ceiling) break;
  }
  return accepted;
}

export function validatedRetrieveTerms(terms: readonly string[]): readonly string[] {
  return boundedRetrieveTerms(terms, MAX_REPOSITORY_FOLLOW_UP_TERMS);
}

function expandedSearchTerms(terms: readonly string[]): readonly string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const tail = term.split(".").at(-1) ?? term;
    // Prefer the exact qualified name. A broad tail such as `length` must never run before the
    // bounded `String.length` query and flood the complete repository.
    for (const candidate of [term, tail]) {
      if (!validTerm(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      expanded.push(candidate);
      if (expanded.length === MAX_GREP_TERMS) return expanded;
    }
  }
  return expanded;
}

function mergeFollowUpSearches(
  primary: GrepSearchResult,
  fallback: GrepSearchResult,
  fallbackTermOffset: number,
): GrepSearchResult {
  return {
    matches: [
      ...primary.matches,
      ...fallback.matches.map((match) => ({
        ...match,
        termRank: match.termRank + fallbackTermOffset,
      })),
    ],
    candidatePaths: [...new Set([...primary.candidatePaths, ...fallback.candidatePaths])],
    truncated: primary.truncated || fallback.truncated,
  };
}

const DECLARED_IDENTIFIER =
  /\b(?:class|const|enum|function|interface|let|type|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gu;

function declarationDistance(line: number, anchor: EvidenceLineRange): number {
  if (line < anchor.startLine) return anchor.startLine - line;
  if (line > anchor.endLine) return line - anchor.endLine;
  return 0;
}

function declarationsNearAnchor(
  request: RepositoryContextRequest,
  source: string | undefined,
): readonly string[] {
  if (source === undefined) return [];
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  const first = Math.max(1, request.findingAnchor.startLine - FALLBACK_DECLARATION_RADIUS);
  const last = Math.min(lines.length, request.findingAnchor.endLine + FALLBACK_DECLARATION_RADIUS);
  const declarations: { readonly identifier: string; readonly line: number }[] = [];
  for (let line = first; line <= last; line += 1) {
    for (const match of (lines[line - 1] ?? "").matchAll(DECLARED_IDENTIFIER)) {
      const identifier = match[1];
      if (identifier !== undefined) declarations.push({ identifier, line });
    }
  }
  declarations.sort(
    (left, right) =>
      declarationDistance(left.line, request.findingAnchor) -
        declarationDistance(right.line, request.findingAnchor) ||
      left.line - right.line ||
      left.identifier.localeCompare(right.identifier),
  );
  return declarations.map(({ identifier }) => identifier);
}

function takeFallbackTerms(
  candidates: readonly string[],
  primary: readonly string[],
): readonly string[] {
  const excluded = new Set(primary);
  const accepted: string[] = [];
  for (const candidate of candidates) {
    if (!validTerm(candidate) || excluded.has(candidate) || accepted.includes(candidate)) continue;
    accepted.push(candidate);
    if (accepted.length === MAX_DETERMINISTIC_FALLBACK_TERMS) break;
  }
  return accepted;
}

/**
 * A planner can name only the private helper at the changed line. When every occurrence of that
 * helper is already in the H/B evidence window, repeating the same lookup produces no independent
 * challenge even though the adjacent public owner has callers and tests elsewhere. Derive at most
 * three additional identifiers from a 32-line exact-commit neighbourhood, ordered by proximity,
 * then fall back to the same bounded code-shaped vocabulary used by initial retrieval.
 *
 * These are search terms, not evidence: Git still has to find them in the immutable selected tree,
 * and the ordinary structural/failure policy still decides whether any returned line is usable.
 */
function deterministicFallbackTerms(
  request: RepositoryContextRequest,
  source: string | undefined,
  primary: readonly string[],
): readonly string[] {
  return takeFallbackTerms(
    [
      ...declarationsNearAnchor(request, source),
      ...extractEvidenceIdentifiers({
        findingContent: request.findingContent,
        anchorText: request.anchorText,
        ...(request.unifiedDiff === undefined ? {} : { unifiedDiff: request.unifiedDiff }),
      }),
    ],
    primary,
  );
}

function plannerTermsBelongToFinding(
  request: RepositoryContextRequest,
  primary: readonly string[],
): boolean {
  const visible = new Set(
    extractEvidenceIdentifiers({
      findingContent: request.findingContent,
      anchorText: request.anchorText,
      ...(request.unifiedDiff === undefined ? {} : { unifiedDiff: request.unifiedDiff }),
    }).flatMap((term) => [term, term.split(".").at(-1) ?? term]),
  );
  return primary.some((term) => visible.has(term) || visible.has(term.split(".").at(-1) ?? term));
}

function safeRepositoryPath(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || path.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex -- candidate paths containing controls are unsafe.
  if (/[\u0000-\u001f\u007f-\u009f\\]/u.test(path) || /^[A-Za-z]:/u.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function remainingRepositoryMs(request: RepositoryContextRequest): number {
  if (request.deadlineMs === undefined) return GIT_TIMEOUT_MS;
  const remaining = Math.max(0, Math.trunc(request.deadlineMs - Date.now()));
  if (remaining === 0) throw new RepositoryContextRetrievalError();
  return Math.min(GIT_TIMEOUT_MS, remaining);
}

function boundedRepositoryTimeout(deadlineMs: number | undefined, maximumMs: number): number {
  if (deadlineMs === undefined) return maximumMs;
  const remaining = Math.max(0, Math.trunc(deadlineMs - Date.now()));
  if (remaining === 0) throw new RepositoryContextRetrievalError();
  return Math.min(maximumMs, remaining);
}

function gitContext(request: RepositoryContextRequest): GitContext {
  return {
    cwd: request.repositoryPath,
    pathValue: request.pathValue,
    timeoutMs: remainingRepositoryMs(request),
  };
}

function emptyContext(head: CommitSha): RepositoryEvidenceContext {
  return { headCommit: head, entries: [] };
}

async function verifiedContext(request: RepositoryContextRequest): Promise<GitContext | undefined> {
  if (!safeRepositoryPath(request.reviewPath)) return undefined;
  const context = gitContext(request);
  try {
    await verifyCommit(context, request.head);
    return context;
  } catch {
    return undefined;
  }
}

async function strictlyVerifiedContext(request: RepositoryContextRequest): Promise<GitContext> {
  if (!safeRepositoryPath(request.reviewPath)) throw new RepositoryContextRetrievalError();
  const context = gitContext(request);
  try {
    await verifyCommit(context, request.head);
    return context;
  } catch (error) {
    throw new RepositoryContextRetrievalError(error);
  }
}

function grepArguments(head: CommitSha, terms: readonly string[]): readonly string[] {
  return [
    "--no-pager",
    "grep",
    "--no-ext-grep",
    "-n",
    "-I",
    "-z",
    "-w",
    "-F",
    "-m",
    "12",
    ...terms.flatMap((term) => ["-e", term]),
    head,
    "--",
  ];
}

function quietGrepArguments(head: CommitSha, terms: readonly string[]): readonly string[] {
  return [
    "--no-pager",
    "grep",
    "--no-ext-grep",
    "-q",
    "-I",
    "-w",
    "-F",
    ...terms.flatMap((term) => ["-e", term]),
    head,
    "--",
  ];
}

interface GrepDelimiters {
  readonly pathEnd: number;
  readonly lineEnd: number;
  readonly contentEnd: number;
}

function grepDelimiters(output: string, cursor: number): GrepDelimiters | undefined {
  const pathEnd = output.indexOf("\0", cursor);
  if (pathEnd < 0) return undefined;
  const lineEnd = output.indexOf("\0", pathEnd + 1);
  if (lineEnd < 0) return undefined;
  const contentEnd = output.indexOf("\n", lineEnd + 1);
  return contentEnd < 0 ? undefined : { pathEnd, lineEnd, contentEnd };
}

function grepMatchAt(
  output: string,
  cursor: number,
  delimiters: GrepDelimiters,
  head: CommitSha,
): GrepMatch | undefined {
  const prefix = `${head}:`;
  const prefixedPath = output.slice(cursor, delimiters.pathEnd);
  if (!prefixedPath.startsWith(prefix)) return undefined;
  const path = prefixedPath.slice(prefix.length);
  const line = Number(output.slice(delimiters.pathEnd + 1, delimiters.lineEnd));
  const content = output.slice(delimiters.lineEnd + 1, delimiters.contentEnd);
  if (!safeRepositoryPath(path) || !Number.isSafeInteger(line) || line < 1) return undefined;
  return { path, line, content };
}

function parseGrepOutput(output: string, head: CommitSha): readonly GrepMatch[] {
  const matches: GrepMatch[] = [];
  let cursor = 0;
  while (cursor < output.length && matches.length < MAX_RAW_MATCHES) {
    const delimiters = grepDelimiters(output, cursor);
    if (delimiters === undefined) break;
    const match = grepMatchAt(output, cursor, delimiters, head);
    if (match !== undefined) matches.push(match);
    cursor = delimiters.contentEnd + 1;
  }
  return matches;
}

function parseCompleteGrepRecords(
  records: readonly Buffer[],
  head: CommitSha,
): readonly GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const record of records) {
    const output = record.toString("utf8");
    const delimiters = grepDelimiters(output, 0);
    if (delimiters?.contentEnd !== output.length - 1) {
      throw new RepositoryContextRetrievalError();
    }
    const match = grepMatchAt(output, 0, delimiters, head);
    if (match === undefined) throw new RepositoryContextRetrievalError();
    matches.push(match);
  }
  return matches;
}

async function grepTermAtHead(
  context: GitContext,
  head: CommitSha,
  term: string,
  strict = false,
  deadlineMs?: number,
): Promise<GrepTermResult> {
  if (strict && !(await strictGrepHasMatch(context, head, [term], deadlineMs))) {
    return { sightings: [], truncated: false };
  }
  try {
    const timeoutMs = boundedRepositoryTimeout(deadlineMs, context.timeoutMs);
    if (strict) {
      const streamed = await runBoundedLineRecords("git", grepArguments(head, [term]), {
        cwd: context.cwd,
        timeoutMs,
        maximumBytes: GIT_MAX_BUFFER,
        maximumRecords: MAX_RAW_MATCHES,
        env: { ...gitEnvironment(context.pathValue), GIT_LITERAL_PATHSPECS: "1" },
      });
      return {
        sightings: parseCompleteGrepRecords(streamed.records, head),
        truncated: streamed.status === "stdout_truncated",
      };
    }
    // Initial retrieval remains best-effort and buffered: an overflowing/noisy automatic term is
    // isolated and skipped. Only the judge-requested follow-up needs to distinguish saturation so
    // it can fail closed through structural retrieval instead of accepting a lexical prefix.
    const result = await run("git", grepArguments(head, [term]), {
      cwd: context.cwd,
      timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...gitEnvironment(context.pathValue), GIT_LITERAL_PATHSPECS: "1" },
    });
    return {
      sightings: parseGrepOutput(result.stdout.toString("utf8"), head),
      truncated: false,
    };
  } catch (error) {
    if (strict) throw new RepositoryContextRetrievalError(error);
    return { sightings: [], truncated: false };
  }
}

function takeUniqueMatches(
  seen: Set<string>,
  candidates: readonly RankedGrepMatch[],
  maximum: number,
): readonly RankedGrepMatch[] {
  if (maximum <= 0) return [];
  const selected: RankedGrepMatch[] = [];
  for (const match of candidates) {
    const key = `${match.path}\u0000${String(match.line)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(match);
    if (selected.length === maximum) return selected;
  }
  return selected;
}

function matchQuota(termIndex: number, termCount: number): number {
  const base = Math.floor(MAX_RAW_MATCHES / termCount);
  const remainder = MAX_RAW_MATCHES % termCount;
  return base + (termIndex < remainder ? 1 : 0);
}

function interleaveMatches(
  groups: readonly (readonly RankedGrepMatch[])[],
): readonly RankedGrepMatch[] {
  const selected: RankedGrepMatch[] = [];
  const maximumGroupLength = Math.max(0, ...groups.map((group) => group.length));
  // One result from every term per round makes the fixed reservations reach the final evidence
  // selector. Earlier (higher-relevance) terms still win every round and own duplicate sightings.
  for (let offset = 0; offset < maximumGroupLength; offset += 1) {
    for (const group of groups) {
      const match = group[offset];
      if (match !== undefined) selected.push(match);
    }
  }
  return selected;
}

function takeCandidatePaths(
  seen: Set<string>,
  sightings: readonly GrepMatch[],
  request: RepositoryContextRequest,
  allowDistantReviewPath: boolean,
): readonly string[] {
  const selected: string[] = [];
  const sameFile = allowDistantReviewPath
    ? sightings.find(
        (sighting) =>
          sighting.path === request.reviewPath &&
          eligibleStructuralPath(request, sighting, allowDistantReviewPath),
      )
    : undefined;
  // Reserve the reviewed file before lexical path order consumes the four AST slots. This is the
  // one path the caller already proved relevant; all other paths retain their original order.
  const ordered = sameFile === undefined ? sightings : [sameFile, ...sightings];
  for (const sighting of ordered) {
    if (
      !eligibleStructuralPath(request, sighting, allowDistantReviewPath) ||
      seen.has(sighting.path)
    ) {
      continue;
    }
    seen.add(sighting.path);
    selected.push(sighting.path);
    if (selected.length === MAX_STRUCTURAL_CANDIDATE_PATHS_PER_TERM) return selected;
  }
  return selected;
}

function interleavePaths(groups: readonly (readonly string[])[]): readonly string[] {
  const selected: string[] = [];
  const maximumGroupLength = Math.max(0, ...groups.map((group) => group.length));
  for (let offset = 0; offset < maximumGroupLength; offset += 1) {
    for (const group of groups) {
      const path = group[offset];
      if (path !== undefined) selected.push(path);
    }
  }
  return selected;
}

function reserveReviewedPathAfterTruncation(
  paths: readonly string[],
  request: RepositoryContextRequest,
  allowDistantReviewPath: boolean,
  truncated: boolean,
): readonly string[] {
  if (!truncated || !canSearchReviewedPath(request, allowDistantReviewPath)) return paths;
  const withoutReviewed = paths.filter((path) => path !== request.reviewPath);
  // Keep every already-selected fallback path. The reviewed path may be absent on the selected
  // side (a deletion searched in HEAD or an addition searched in BASE); replacing the fourth real
  // candidate with that absent path would make the later four-readable-blob cap see only three.
  return [request.reviewPath, ...withoutReviewed];
}

async function grepAtHead(
  context: GitContext,
  request: RepositoryContextRequest,
  terms: readonly string[],
  strict = false,
  allowDistantReviewPath = false,
): Promise<GrepSearchResult> {
  if (terms.length === 0) return { matches: [], candidatePaths: [], truncated: false };
  const seenMatches = new Set<string>();
  const seenPaths = new Set<string>();
  const groups: (readonly RankedGrepMatch[])[] = [];
  const pathGroups: (readonly string[])[] = [];
  let truncated = false;
  for (const [termIndex, term] of terms.entries()) {
    const result = await grepTermAtHead(context, request.head, term, strict, request.deadlineMs);
    truncated ||= result.truncated;
    pathGroups.push(
      takeCandidatePaths(seenPaths, result.sightings, request, allowDistantReviewPath),
    );
    const ranked = result.sightings
      .filter((match) => eligibleRepositorySighting(request, match, allowDistantReviewPath))
      .map((match) => ({ ...match, termRank: termIndex }));
    groups.push(
      result.truncated
        ? []
        : takeUniqueMatches(seenMatches, ranked, matchQuota(termIndex, terms.length)),
    );
  }
  const candidatePaths = interleavePaths(pathGroups);
  return {
    matches: interleaveMatches(groups),
    candidatePaths: reserveReviewedPathAfterTruncation(
      candidatePaths,
      request,
      allowDistantReviewPath,
      truncated,
    ),
    truncated,
  };
}

async function strictGrepHasMatch(
  context: GitContext,
  head: CommitSha,
  terms: readonly string[],
  deadlineMs?: number,
): Promise<boolean> {
  try {
    const timeoutMs = boundedRepositoryTimeout(deadlineMs, context.timeoutMs);
    await run("git", quietGrepArguments(head, terms), {
      cwd: context.cwd,
      timeoutMs,
      maxBuffer: 4096,
      env: { ...gitEnvironment(context.pathValue), GIT_LITERAL_PATHSPECS: "1" },
    });
    return true;
  } catch (error) {
    if (error instanceof ExecFailure && error.code === 1 && !error.timedOut) return false;
    throw new RepositoryContextRetrievalError(error);
  }
}

function matchKind(match: GrepMatch): RepositoryEvidenceKind {
  if (TEST_PATH.test(match.path)) return "test";
  return DECLARATION_HINT.test(match.content) ? "definition" : "callsite";
}

function asCodeEntry(match: RankedGrepMatch): RankedEvidenceEntry {
  return { ...match, kind: matchKind(match) };
}

function addCodeEntry<Entry extends RepositoryEvidenceEntry>(
  selected: Entry[],
  paths: Set<string>,
  entry: Entry | undefined,
): boolean {
  if (
    entry === undefined ||
    selected.length === MAX_CODE_ENTRIES ||
    selected.some((item) => item.path === entry.path && item.line === entry.line)
  ) {
    return false;
  }
  if (!paths.has(entry.path) && paths.size === MAX_CODE_PATHS) return false;
  paths.add(entry.path);
  selected.push(entry);
  return true;
}

function reserveRankedEntries(
  candidates: readonly RankedEvidenceEntry[],
  selected: RankedEvidenceEntry[],
  paths: Set<string>,
): void {
  const reservedRanks = new Set<number>();
  for (const candidate of candidates) {
    if (reservedRanks.has(candidate.termRank)) continue;
    if (addCodeEntry(selected, paths, candidate)) reservedRanks.add(candidate.termRank);
    if (selected.length === MAX_CODE_ENTRIES) return;
  }
}

function withoutTermRank(entry: RankedEvidenceEntry): RepositoryEvidenceEntry {
  return {
    path: entry.path,
    line: entry.line,
    content: entry.content,
    kind: entry.kind,
  };
}

function boundedCodeEntries(
  matches: readonly RankedGrepMatch[],
  request: RepositoryContextRequest,
  allowDistantReviewPath: boolean,
): readonly RepositoryEvidenceEntry[] {
  // `grepAtHead` already orders matches by term relevance and fixed fair reservations. Sorting by
  // path here would silently replace that semantic order with repository naming.
  const candidates = matches
    .filter(
      (match) =>
        eligibleRepositorySighting(request, match, allowDistantReviewPath) &&
        match.content.length <= MAX_MATCH_LINE_CHARS,
    )
    .map(asCodeEntry);
  const selected: RankedEvidenceEntry[] = [];
  const paths = new Set<string>();
  reserveRankedEntries(candidates, selected, paths);
  for (const kind of ["definition", "test", "callsite"] as const) {
    addCodeEntry(
      selected,
      paths,
      candidates.find((entry) => entry.kind === kind),
    );
  }
  for (const candidate of candidates) {
    addCodeEntry(selected, paths, candidate);
    if (selected.length === MAX_CODE_ENTRIES) break;
  }
  return selected.map(withoutTermRank);
}

function boundedEvidenceEntries(
  structural: readonly RepositoryEvidenceEntry[],
  lexical: readonly RepositoryEvidenceEntry[],
  request: RepositoryContextRequest,
  termAnchorCount: number,
): readonly RepositoryEvidenceEntry[] {
  const eligible = (
    entries: readonly RepositoryEvidenceEntry[],
  ): readonly RepositoryEvidenceEntry[] =>
    entries.filter(
      (entry) =>
        eligibleRepositorySighting(request, entry, true) &&
        entry.content.length <= MAX_MATCH_LINE_CHARS,
    );
  const structuralCandidates = eligible(structural);
  const lexicalCandidates = eligible(lexical);
  const selected: RepositoryEvidenceEntry[] = [];
  const paths = new Set<string>();
  // `searchAstGrepAtHead` places one hit for each requested term at the front. Preserve that front
  // before kind/path diversity: the verifier consumes only the first three distinct paths, so a
  // definition/test/callsite trio for term zero must not evict terms one and two downstream.
  for (const entry of structuralCandidates.slice(0, Math.max(0, termAnchorCount))) {
    addCodeEntry(selected, paths, entry);
  }
  for (const kind of ["definition", "test", "callsite"] as const) {
    addCodeEntry(
      selected,
      paths,
      structuralCandidates.find((entry) => entry.kind === kind),
    );
  }
  const reservedStructuralPaths = new Set(selected.map((entry) => entry.path));
  for (const entry of structuralCandidates) {
    if (reservedStructuralPaths.has(entry.path)) continue;
    if (addCodeEntry(selected, paths, entry)) reservedStructuralPaths.add(entry.path);
  }
  // Lexical anchors remain independent evidence, not ballast. Reserve their available type
  // diversity before structural context windows and repeated sightings consume the twelve slots.
  for (const kind of ["definition", "test", "callsite"] as const) {
    addCodeEntry(
      selected,
      paths,
      lexicalCandidates.find((entry) => entry.kind === kind),
    );
  }
  for (const entry of structuralCandidates) addCodeEntry(selected, paths, entry);
  for (const candidate of lexicalCandidates) {
    addCodeEntry(selected, paths, candidate);
    if (selected.length === MAX_CODE_ENTRIES) break;
  }
  return selected;
}

function lexicalNeedsStructuralFallback(
  matches: readonly GrepMatch[],
  entries: readonly RepositoryEvidenceEntry[],
  terms: readonly string[],
): boolean {
  if (matches.length === 0) return false;
  return (
    matches.length === MAX_RAW_MATCHES ||
    entries.length < 2 ||
    !entries.some((entry) => entry.kind === "definition") ||
    terms.some((term) => term.includes("."))
  );
}

function hasNoStructuralCandidate(result: GrepSearchResult): boolean {
  return result.matches.length === 0 && result.candidatePaths.length === 0 && !result.truncated;
}

function requiresStructuralFallback(
  result: GrepSearchResult,
  lexical: readonly RepositoryEvidenceEntry[],
  terms: readonly string[],
): boolean {
  return (
    result.truncated ||
    (result.matches.length === 0 && result.candidatePaths.length > 0) ||
    lexicalNeedsStructuralFallback(result.matches, lexical, terms)
  );
}

export interface RepositoryContextDependencies {
  /** HEAD is the default; BASE is allowed only for the planner's closed `base` challenge axis. */
  readonly sourceSide?: RepositoryEvidenceSide;
  /** Reserve exact manifest/lockfile sightings before repository-wide lexical search results. */
  readonly preferManifests?: boolean;
  readonly anchorOwnerSearch?: (
    request: AnchorOwnerSearchRequest,
  ) => Promise<AnchorOwner | undefined>;
  readonly callerOwnerSearch?: (
    request: CallerOwnerSearchRequest,
  ) => Promise<AnchorOwner | undefined>;
  readonly structuralSearch?: (
    request: StructuralSearchRequest,
  ) => Promise<readonly RepositoryEvidenceEntry[]>;
}

interface FollowUpSearch {
  readonly terms: readonly string[];
  readonly expandedTerms: readonly string[];
  readonly result: GrepSearchResult;
  readonly usedFallback: boolean;
  readonly preservePrimaryEvidence: boolean;
  readonly ownerTerm?: string;
  readonly ownerTermAlreadySearched?: boolean;
}

function followUpSourceRequest(
  request: RepositoryContextRequest,
  side: RepositoryEvidenceSide,
): RepositoryContextRequest {
  if (side === "H") return request;
  return {
    ...request,
    head: request.base,
    reviewPath: request.baseReviewPath,
    // An unmappable HEAD anchor must not make the complete BASE-side reviewed file eligible.
    findingAnchor: request.baseFindingAnchor ?? { startLine: 0, endLine: 0 },
  };
}

async function readFollowUpReviewSource(
  context: GitContext,
  request: RepositoryContextRequest,
): Promise<string | undefined> {
  try {
    return await readTextAtCommit(
      {
        ...context,
        timeoutMs: boundedRepositoryTimeout(request.deadlineMs, context.timeoutMs),
      },
      request.head,
      request.reviewPath,
    );
  } catch (error) {
    throw new RepositoryContextRetrievalError(error);
  }
}

function mayUseAdjacentFallback(
  request: RepositoryContextRequest,
  primaryTerms: readonly string[],
  result: GrepSearchResult,
): boolean {
  return (
    result.matches.length === 0 &&
    !result.truncated &&
    (result.candidatePaths.length > 0 || plannerTermsBelongToFinding(request, primaryTerms))
  );
}

function hasClearLexicalEvidence(
  search: GrepSearchResult,
  terms: readonly string[],
  request: RepositoryContextRequest,
): boolean {
  const lexical = boundedCodeEntries(search.matches, request, true);
  return lexical.length > 0 && !requiresStructuralFallback(search, lexical, terms);
}

function hasParserIndependentLexicalEvidence(
  search: GrepSearchResult,
  request: RepositoryContextRequest,
): boolean {
  const lexical = boundedCodeEntries(search.matches, request, true);
  // Candidate paths deliberately include the reviewed file even when its only sighting is inside
  // the already-visible anchor. Judge only the eligible lines which can enter the new evidence;
  // an anchor-only code candidate must not erase an independent exact lockfile sighting.
  return lexical.length > 0 && lexical.every((entry) => !isStructurallySearchablePath(entry.path));
}

async function collectPlannerFollowUpSearch(
  context: GitContext,
  request: RepositoryContextRequest,
  retrieveTerms: readonly string[],
): Promise<FollowUpSearch> {
  const primaryTerms = validatedRetrieveTerms(retrieveTerms);
  const primaryExpanded = expandedSearchTerms(primaryTerms);
  const primary = await grepAtHead(context, request, primaryExpanded, true, true);
  const preservePrimaryEvidence =
    hasClearLexicalEvidence(primary, primaryTerms, request) ||
    // Exact package/lockfile sightings are parser-independent positive evidence. Record that
    // before owner enrichment adds a code path; an optional owner parser failure must not erase
    // the primary result merely because the merged candidate set later becomes AST-capable.
    hasParserIndependentLexicalEvidence(primary, request);
  if (!mayUseAdjacentFallback(request, primaryTerms, primary)) {
    return {
      terms: primaryTerms,
      expandedTerms: primaryExpanded,
      result: primary,
      usedFallback: false,
      preservePrimaryEvidence,
    };
  }
  const source = await readFollowUpReviewSource(context, request);
  const fallbackTerms = deterministicFallbackTerms(request, source, primaryTerms);
  const remainingTermSlots = Math.max(0, MAX_GREP_TERMS - primaryExpanded.length);
  const fallbackExpanded = expandedSearchTerms(fallbackTerms).slice(0, remainingTermSlots);
  if (fallbackExpanded.length === 0) {
    return {
      terms: primaryTerms,
      expandedTerms: primaryExpanded,
      result: primary,
      usedFallback: false,
      preservePrimaryEvidence,
    };
  }
  const fallback = await grepAtHead(context, request, fallbackExpanded, true, true);
  return {
    terms: [...primaryTerms, ...fallbackTerms],
    expandedTerms: [...primaryExpanded, ...fallbackExpanded],
    result: mergeFollowUpSearches(primary, fallback, primaryExpanded.length),
    usedFallback: true,
    preservePrimaryEvidence,
  };
}

function ownerAlreadySearched(search: FollowUpSearch, owner: string): boolean {
  return search.expandedTerms.some((term) => (term.split(".").at(-1) ?? term) === owner);
}

function mergeOwnerSearch(
  search: FollowUpSearch,
  owner: string,
  ownerResult: GrepSearchResult,
  request: RepositoryContextRequest,
): FollowUpSearch {
  if (ownerAlreadySearched(search, owner)) {
    return { ...search, ownerTerm: owner, ownerTermAlreadySearched: true };
  }
  const ownerRank = search.expandedTerms.length;
  const ownerCandidatePaths = [request.reviewPath, ...ownerResult.candidatePaths];
  const candidatePaths = search.preservePrimaryEvidence
    ? [...ownerCandidatePaths, ...search.result.candidatePaths]
    : [...search.result.candidatePaths, ...ownerCandidatePaths];
  return {
    ...search,
    terms: [...search.terms, owner],
    expandedTerms: [...search.expandedTerms, owner],
    result: {
      // The planner's clear positive evidence remains first. Owner paths are reserved separately
      // below so this optional enrichment cannot consume the verifier's three chunks first.
      matches: [
        ...search.result.matches,
        ...ownerResult.matches.map((match) => ({ ...match, termRank: ownerRank })),
      ],
      // Ambiguous primary evidence owns the parser's four-blob budget. Owner enrichment may use
      // only remaining slots; it can lead solely when the primary lexical evidence is already
      // independently sufficient and structure is optional.
      candidatePaths: [...new Set(candidatePaths)],
      truncated: search.result.truncated || ownerResult.truncated,
    },
    ownerTerm: owner,
    ownerTermAlreadySearched: false,
  };
}

async function enrichWithAnchorOwner(
  context: GitContext,
  request: RepositoryContextRequest,
  search: FollowUpSearch,
  dependencies: RepositoryContextDependencies,
): Promise<FollowUpSearch> {
  const ownerSearch = dependencies.anchorOwnerSearch ?? findAstAnchorOwnerAtHead;
  const callerOwnerSearch = dependencies.callerOwnerSearch ?? findAstCallerOwnerAtHead;
  let owner: AnchorOwner | undefined;
  try {
    owner = await ownerSearch({
      context,
      head: request.head,
      reviewPath: request.reviewPath,
      findingAnchor: request.findingAnchor,
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    });
  } catch {
    // Owner discovery is enrichment. The planner's ordinary lexical/structural path below still
    // fails closed on ambiguity, while an unavailable owner cannot turn a valid no-match into a
    // fabricated match or erase already-collected positive evidence.
    return search;
  }
  if (owner === undefined || !validTerm(owner.name)) return search;
  if (ownerAlreadySearched(search, owner.name)) {
    return await enrichWithCallerOwner(
      context,
      request,
      { ...search, ownerTerm: owner.name, ownerTermAlreadySearched: true },
      owner,
      callerOwnerSearch,
    );
  }
  try {
    const ownerResult = await grepAtHead(context, request, [owner.name], true, true);
    return await enrichWithCallerOwner(
      context,
      request,
      mergeOwnerSearch(search, owner.name, ownerResult, request),
      owner,
      callerOwnerSearch,
    );
  } catch {
    return search;
  }
}

type CallerOwnerSearch = NonNullable<RepositoryContextDependencies["callerOwnerSearch"]>;

async function enrichWithCallerOwner(
  context: GitContext,
  request: RepositoryContextRequest,
  search: FollowUpSearch,
  owner: AnchorOwner,
  callerOwnerSearch: CallerOwnerSearch,
): Promise<FollowUpSearch> {
  try {
    const caller = await callerOwnerSearch({
      context,
      head: request.head,
      reviewPath: request.reviewPath,
      findingAnchor: request.findingAnchor,
      ownerName: owner.name,
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    });
    if (
      caller === undefined ||
      caller.name === owner.name ||
      !validTerm(caller.name) ||
      ownerAlreadySearched(search, caller.name)
    ) {
      return search;
    }
    const callerResult = await grepAtHead(context, request, [caller.name], true, true);
    return mergeOwnerSearch(search, caller.name, callerResult, request);
  } catch {
    // This is a bounded optional depth-one hop. The already collected owner evidence remains exact
    // positive evidence when caller-owner discovery is unavailable.
    return search;
  }
}

async function collectFollowUpSearch(
  context: GitContext,
  request: RepositoryContextRequest,
  retrieveTerms: readonly string[],
  dependencies: RepositoryContextDependencies,
): Promise<FollowUpSearch> {
  const planner = await collectPlannerFollowUpSearch(context, request, retrieveTerms);
  return await enrichWithAnchorOwner(context, request, planner, dependencies);
}

function manifestCandidates(reviewPath: string, includeLockfiles: boolean): readonly string[] {
  const names = includeLockfiles ? MANIFEST_AND_LOCKFILE_NAMES : MANIFEST_NAMES;
  const reviewSegments = reviewPath.split("/").slice(0, -1);
  const reviewDirectory = reviewSegments.join("/");
  const segments = [...reviewSegments];
  const directories: string[] = [];
  while (segments.length > 0) {
    directories.push(segments.join("/"));
    segments.pop();
  }
  const nested = directories.flatMap((directory) =>
    names.map((name) => (directory === "" ? name : `${directory}/${name}`)),
  );
  const reviewName = reviewPath.split("/").at(-1) ?? "";
  const reviewedManifest = (names as readonly string[]).includes(reviewName) ? [reviewPath] : [];
  const siblingLockfiles = includeLockfiles
    ? LOCKFILE_NAMES.map((name) => (reviewDirectory === "" ? name : `${reviewDirectory}/${name}`))
    : [];
  const reservedRoot = names.length;
  return [
    ...new Set([
      ...reviewedManifest,
      ...siblingLockfiles,
      ...nested.slice(
        0,
        MAX_MANIFEST_CANDIDATES - reservedRoot - reviewedManifest.length - siblingLockfiles.length,
      ),
      ...names,
    ]),
  ];
}

function boundedPreferredEntries(
  preferred: readonly RepositoryEvidenceEntry[],
  remaining: readonly RepositoryEvidenceEntry[],
): readonly RepositoryEvidenceEntry[] {
  const leadingPaths = new Set([...new Set(preferred.map((entry) => entry.path))].slice(0, 2));
  const leading = preferred.filter((entry) => leadingPaths.has(entry.path));
  const deferred = preferred.filter((entry) => !leadingPaths.has(entry.path));
  const selected: RepositoryEvidenceEntry[] = [];
  const paths = new Set<string>();
  // Two exact configuration paths are reserved first, but the third verifier chunk remains
  // available for an independent caller/test/structural counterexample when one exists.
  for (const entry of [...leading, ...remaining, ...deferred]) {
    addCodeEntry(selected, paths, entry);
    if (selected.length === MAX_CODE_ENTRIES) break;
  }
  return selected;
}

async function existingManifestPaths(
  context: GitContext,
  head: CommitSha,
  candidates: readonly string[],
  deadlineMs?: number,
  strict = false,
): Promise<readonly string[]> {
  try {
    const timeoutMs = boundedRepositoryTimeout(deadlineMs, context.timeoutMs);
    const result = await run(
      "git",
      ["--no-pager", "ls-tree", "-rz", "--name-only", head, "--", ...candidates],
      {
        cwd: context.cwd,
        timeoutMs,
        maxBuffer: GIT_MAX_BUFFER,
        env: { ...gitEnvironment(context.pathValue), GIT_LITERAL_PATHSPECS: "1" },
      },
    );
    const existing = new Set(result.stdout.toString("utf8").split("\0").filter(safeRepositoryPath));
    return candidates
      .filter((candidate) => existing.has(candidate))
      .slice(0, MAX_MANIFEST_SCAN_FILES);
  } catch (error) {
    if (strict) throw new RepositoryContextRetrievalError(error);
    return [];
  }
}

function relevantManifestLines(
  path: string,
  text: string,
  terms: readonly string[],
  termOnly = false,
): readonly number[] {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const selected = new Set<number>();
  const runtime = RUNTIME_MANIFESTS.has(path.split("/").at(-1) ?? "");
  lines.forEach((line, index) => {
    const termMatch = terms.some((term) => manifestLineContainsTerm(line, term));
    const relevant = termMatch || (!termOnly && (runtime || MANIFEST_HINT.test(line)));
    if (!relevant) return;
    for (
      let current = Math.max(0, index - 1);
      current <= Math.min(lines.length - 1, index + 1);
      current += 1
    ) {
      if ((lines[current]?.length ?? Number.POSITIVE_INFINITY) <= MAX_MATCH_LINE_CHARS) {
        selected.add(current + 1);
      }
    }
  });
  return [...selected].slice(0, MAX_MANIFEST_LINES);
}

function manifestLineContainsTerm(line: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:$|[^A-Za-z0-9_$])`, "u").test(line);
}

async function manifestEntriesAtPath(
  context: GitContext,
  request: RepositoryContextRequest,
  path: string,
  terms: readonly string[],
  termOnly: boolean,
  strict: boolean,
): Promise<readonly RepositoryEvidenceEntry[] | undefined> {
  const text = await readTextAtCommit(
    {
      ...context,
      timeoutMs: boundedRepositoryTimeout(request.deadlineMs, context.timeoutMs),
    },
    request.head,
    path,
  );
  if (text === undefined) {
    if (strict) throw new RepositoryContextRetrievalError();
    return undefined;
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const relevant = relevantManifestLines(path, text, terms, termOnly);
  if (relevant.length === 0) return undefined;
  return relevant.flatMap((line) => {
    const content = lines[line - 1];
    return content === undefined ? [] : [{ path, line, content, kind: "manifest" as const }];
  });
}

async function manifestEntries(
  context: GitContext,
  request: RepositoryContextRequest,
  terms: readonly string[],
  termOnly = false,
  strict = false,
): Promise<readonly RepositoryEvidenceEntry[]> {
  const candidates = manifestCandidates(request.reviewPath, termOnly);
  const paths = await existingManifestPaths(
    context,
    request.head,
    candidates,
    request.deadlineMs,
    strict,
  );
  const entries: RepositoryEvidenceEntry[] = [];
  let includedFiles = 0;
  for (const path of paths) {
    try {
      const found = await manifestEntriesAtPath(context, request, path, terms, termOnly, strict);
      if (found === undefined) continue;
      includedFiles += 1;
      entries.push(...found);
      if (includedFiles === MAX_MANIFEST_FILES) break;
    } catch (error) {
      if (strict) throw new RepositoryContextRetrievalError(error);
      // One unreadable manifest does not make positive sightings from other files untrue.
    }
  }
  return entries;
}

async function collectCodeEntries(
  context: GitContext,
  request: RepositoryContextRequest,
  terms: readonly string[],
  strict = false,
): Promise<readonly RepositoryEvidenceEntry[]> {
  const result = await grepAtHead(context, request, expandedSearchTerms(terms), strict);
  return boundedCodeEntries(result.matches, request, false);
}

/** Initial deterministic stage: finding/anchor/diff identifiers plus relevant manifests. */
export async function collectInitialRepositoryContext(
  request: RepositoryContextRequest,
): Promise<RepositoryEvidenceContext> {
  try {
    remainingRepositoryMs(request);
  } catch {
    return emptyContext(request.head);
  }
  const context = await verifiedContext(request);
  if (context === undefined) return emptyContext(request.head);
  const extracted = extractEvidenceIdentifiers({
    findingContent: request.findingContent,
    anchorText: request.anchorText,
    ...(request.unifiedDiff === undefined ? {} : { unifiedDiff: request.unifiedDiff }),
  });
  const terms = boundedRetrieveTerms(extracted, MAX_REPOSITORY_INITIAL_TERMS);
  const [code, manifests] = await Promise.all([
    collectCodeEntries(context, request, terms),
    manifestEntries(context, request, expandedSearchTerms(terms)),
  ]);
  return { headCommit: request.head, entries: [...code, ...manifests] };
}

function structuralTermsForFollowUp(search: FollowUpSearch): readonly string[] {
  const matchedTerms = search.result.matches
    .map((match) => search.expandedTerms[match.termRank])
    .filter((term): term is string => term !== undefined);
  const candidates = search.usedFallback
    ? [...matchedTerms, ...search.expandedTerms]
    : search.terms;
  const ownerTail = search.ownerTerm?.split(".").at(-1);
  if (ownerTail === undefined) return normalizedStructuralTerms(candidates);
  // An owner which the bounded fallback search already selected is not optional enrichment: keep
  // its original match-ranked position. Only a newly appended owner term participates in the
  // primary-versus-enrichment ordering below.
  if (search.ownerTermAlreadySearched === true) return normalizedStructuralTerms(candidates);
  const withoutOwner = candidates.filter((term) => (term.split(".").at(-1) ?? term) !== ownerTail);
  if (withoutOwner.length === 0) return normalizedStructuralTerms(candidates);
  if (!search.preservePrimaryEvidence) {
    return normalizedStructuralTerms([...withoutOwner, ownerTail]);
  }
  // Preserve the planner's leading term, then reserve one of the three AST term slots for the
  // independently derived owner. That supplies caller/test context without allowing enrichment to
  // displace the clear primary evidence which justified the challenge lookup in the first place.
  return normalizedStructuralTerms([
    withoutOwner[0] ?? ownerTail,
    ownerTail,
    ...withoutOwner.slice(1),
  ]);
}

async function collectStructuralFollowUp(
  context: GitContext,
  request: RepositoryContextRequest,
  side: RepositoryEvidenceSide,
  search: FollowUpSearch,
  lexical: readonly RepositoryEvidenceEntry[],
  dependencies: RepositoryContextDependencies,
): Promise<RepositoryFollowUpContext> {
  const structuralRequired = requiresStructuralFallback(search.result, lexical, search.terms);
  // Prefer identifiers that produced eligible lexical evidence. A private anchor-only primary term
  // must not consume all three AST term slots ahead of its adjacent public-owner fallback.
  const structuralTerms = structuralTermsForFollowUp(search);
  try {
    const structural = await (dependencies.structuralSearch ?? searchAstGrepAtHead)({
      context,
      head: request.head,
      reviewPath: request.reviewPath,
      findingAnchor: request.findingAnchor,
      candidatePaths: search.result.candidatePaths,
      terms: structuralTerms,
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    });
    return {
      sourceCommit: request.head,
      side,
      entries: boundedEvidenceEntries(structural, lexical, request, structuralTerms.length),
    };
  } catch (error) {
    if (structuralRequired && !search.preservePrimaryEvidence) {
      throw new RepositoryContextRetrievalError(error);
    }
    // A clear lexical definition remains exact positive evidence. Structural body enrichment is
    // optional on this path, so tool acquisition or parsing failure must not erase it.
    return { sourceCommit: request.head, side, entries: lexical };
  }
}

function lexicalFollowUp(
  request: RepositoryContextRequest,
  side: RepositoryEvidenceSide,
  search: FollowUpSearch,
  lexical: readonly RepositoryEvidenceEntry[],
  preferredManifests: readonly RepositoryEvidenceEntry[],
): RepositoryFollowUpContext | undefined {
  if (
    !hasNoStructuralCandidate(search.result) &&
    search.result.candidatePaths.some(isStructurallySearchablePath)
  ) {
    return undefined;
  }
  return {
    sourceCommit: request.head,
    side,
    entries: boundedPreferredEntries(preferredManifests, lexical),
  };
}

async function structuralFollowUpWithManifests(
  context: GitContext,
  request: RepositoryContextRequest,
  side: RepositoryEvidenceSide,
  search: FollowUpSearch,
  lexical: readonly RepositoryEvidenceEntry[],
  preferredManifests: readonly RepositoryEvidenceEntry[],
  dependencies: RepositoryContextDependencies,
): Promise<RepositoryFollowUpContext> {
  try {
    const structural = await collectStructuralFollowUp(
      context,
      request,
      side,
      search,
      lexical,
      dependencies,
    );
    return {
      ...structural,
      entries: boundedPreferredEntries(preferredManifests, structural.entries),
    };
  } catch (error) {
    if (preferredManifests.length === 0) throw error;
    remainingRepositoryMs(request);
    // A configuration challenge may have exact parser-independent manifest evidence even when a
    // noisy identifier also made an unrelated code candidate structurally ambiguous. Preserve the
    // former; the optional parser failure cannot turn a verified package pin into infrastructure
    // loss or make the truncated lexical prefix evidence.
    return { sourceCommit: request.head, side, entries: preferredManifests };
  }
}

/** One caller-controlled follow-up stage. Invalid, prose, duplicate, and excess terms disappear. */
export async function collectRepositoryContextFollowUp(
  request: RepositoryContextRequest,
  retrieveTerms: readonly string[],
  dependencies: RepositoryContextDependencies = {},
): Promise<RepositoryFollowUpContext> {
  const side = dependencies.sourceSide ?? "H";
  const sourceRequest = followUpSourceRequest(request, side);
  remainingRepositoryMs(sourceRequest);
  const context = await strictlyVerifiedContext(sourceRequest);
  if (
    side === "B" &&
    request.baseFindingAnchor === undefined &&
    (await readFollowUpReviewSource(context, sourceRequest)) === undefined
  ) {
    // An added file has no reviewed BASE blob. A repository-wide search at BASE could only find a
    // same-named but unrelated construct, so withhold the challenge rather than laundering that
    // sighting into evidence for a file which did not exist on the selected side. An existing but
    // unmappable BASE file may still supply an explicitly requested cross-file contract.
    return { sourceCommit: sourceRequest.head, side, entries: [] };
  }
  const preferredManifests = dependencies.preferManifests
    ? await manifestEntries(
        context,
        sourceRequest,
        expandedSearchTerms(validatedRetrieveTerms(retrieveTerms)),
        true,
        true,
      )
    : [];
  const search = await collectFollowUpSearch(context, sourceRequest, retrieveTerms, dependencies);
  // Model scope remains capped at three identifiers. The optional second group is deterministic
  // and equally capped; both searches feed one structural invocation over at most four immutable
  // blobs, so this adds recall without adding another model or parser loop.
  remainingRepositoryMs(sourceRequest);
  const lexical = boundedCodeEntries(search.result.matches, sourceRequest, true);
  const lexicalOnly = lexicalFollowUp(sourceRequest, side, search, lexical, preferredManifests);
  return (
    lexicalOnly ??
    (await structuralFollowUpWithManifests(
      context,
      sourceRequest,
      side,
      search,
      lexical,
      preferredManifests,
      dependencies,
    ))
  );
}

/** Pure combination after at most one follow-up; a commit mismatch is rejected, never repaired. */
export function mergeRepositoryEvidenceContexts(
  initial: RepositoryEvidenceContext,
  followUp: RepositoryFollowUpContext,
): RepositoryEvidenceContext {
  if (followUp.side !== "H" || initial.headCommit !== followUp.sourceCommit) return initial;
  // The judge asked for the follow-up identifiers explicitly. Keep those facts ahead of automatic
  // initial sightings so the later 24-entry/8-path renderer budget cannot discard the answer it
  // requested merely because an alphabetically earlier initial path filled the budget first.
  return { headCommit: initial.headCommit, entries: [...followUp.entries, ...initial.entries] };
}
