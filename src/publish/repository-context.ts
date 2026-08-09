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
  normalizedStructuralTerms,
  searchAstGrepAtHead,
  type StructuralSearchRequest,
} from "./ast-grep-search.js";

export const MAX_REPOSITORY_INITIAL_TERMS = 6;
export const MAX_REPOSITORY_FOLLOW_UP_TERMS = 3;

const MAX_GREP_TERMS = 8;
const MAX_RAW_MATCHES = 96;
const MAX_STRUCTURAL_CANDIDATE_PATHS_PER_TERM = 4;
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
  return {
    matches: interleaveMatches(groups),
    candidatePaths: interleavePaths(pathGroups),
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
  readonly structuralSearch?: (
    request: StructuralSearchRequest,
  ) => Promise<readonly RepositoryEvidenceEntry[]>;
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

function manifestCandidates(reviewPath: string): readonly string[] {
  const segments = reviewPath.split("/").slice(0, -1);
  const directories: string[] = [];
  while (segments.length > 0) {
    directories.push(segments.join("/"));
    segments.pop();
  }
  const nested = directories.flatMap((directory) =>
    MANIFEST_NAMES.map((name) => (directory === "" ? name : `${directory}/${name}`)),
  );
  const reservedRoot = MANIFEST_NAMES.length;
  return [
    ...new Set([...nested.slice(0, MAX_MANIFEST_CANDIDATES - reservedRoot), ...MANIFEST_NAMES]),
  ];
}

async function existingManifestPaths(
  context: GitContext,
  head: CommitSha,
  candidates: readonly string[],
  deadlineMs?: number,
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
  } catch {
    return [];
  }
}

function relevantManifestLines(
  path: string,
  text: string,
  terms: readonly string[],
): readonly number[] {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const selected = new Set<number>();
  const runtime = RUNTIME_MANIFESTS.has(path.split("/").at(-1) ?? "");
  lines.forEach((line, index) => {
    const relevant =
      runtime || MANIFEST_HINT.test(line) || terms.some((term) => line.includes(term));
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

async function manifestEntries(
  context: GitContext,
  request: RepositoryContextRequest,
  terms: readonly string[],
): Promise<readonly RepositoryEvidenceEntry[]> {
  const candidates = manifestCandidates(request.reviewPath);
  const paths = await existingManifestPaths(context, request.head, candidates, request.deadlineMs);
  const entries: RepositoryEvidenceEntry[] = [];
  let includedFiles = 0;
  for (const path of paths) {
    try {
      const text = await readTextAtCommit(
        {
          ...context,
          timeoutMs: boundedRepositoryTimeout(request.deadlineMs, context.timeoutMs),
        },
        request.head,
        path,
      );
      if (text === undefined) continue;
      const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
      const relevant = relevantManifestLines(path, text, terms);
      if (relevant.length === 0) continue;
      includedFiles += 1;
      for (const line of relevant) {
        const content = lines[line - 1];
        if (content !== undefined) entries.push({ path, line, content, kind: "manifest" });
      }
      if (includedFiles === MAX_MANIFEST_FILES) break;
    } catch {
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
  const terms = validatedRetrieveTerms(retrieveTerms);
  const result = await grepAtHead(context, sourceRequest, expandedSearchTerms(terms), true, true);
  remainingRepositoryMs(sourceRequest);
  const lexical = boundedCodeEntries(result.matches, sourceRequest, true);
  if (hasNoStructuralCandidate(result)) {
    return { sourceCommit: sourceRequest.head, side, entries: lexical };
  }
  const structuralRequired = requiresStructuralFallback(result, lexical, terms);
  const structuralTerms = normalizedStructuralTerms(terms);
  try {
    const structural = await (dependencies.structuralSearch ?? searchAstGrepAtHead)({
      context,
      head: sourceRequest.head,
      reviewPath: sourceRequest.reviewPath,
      findingAnchor: sourceRequest.findingAnchor,
      candidatePaths: result.candidatePaths,
      terms: structuralTerms,
      ...(sourceRequest.deadlineMs === undefined ? {} : { deadlineMs: sourceRequest.deadlineMs }),
    });
    return {
      sourceCommit: sourceRequest.head,
      side,
      entries: boundedEvidenceEntries(structural, lexical, sourceRequest, structuralTerms.length),
    };
  } catch (error) {
    if (structuralRequired) {
      // The judge requested this fallback because lexical evidence was ambiguous. Returning those
      // hits as if structure had verified them would turn an unavailable tool into false evidence.
      throw new RepositoryContextRetrievalError(error);
    }
    // A clear lexical definition remains exact positive evidence. Structural body enrichment is
    // useful but optional on this path, so tool acquisition or parsing failure must not erase it.
    return { sourceCommit: sourceRequest.head, side, entries: lexical };
  }
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
