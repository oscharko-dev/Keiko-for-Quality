import { ValidationError, repoPath, type RepoPath } from "../core/brands.js";
import { asArray, asObject, asString, parseJson } from "../core/validate.js";

/**
 * A strict, versioned reading of the engine's JSON result.
 *
 * This parser is intentionally narrow. It extracts only what the completeness decision and the
 * publisher need, and it treats anything it does not recognise as a reason to distrust the run
 * rather than a field to ignore. The asymmetry is deliberate: a permissive parser that shrugs at an
 * unfamiliar state will eventually shrug at the state that means "this review did not finish".
 */

/** The manifest schema this adapter was written against. */
export const SUPPORTED_MANIFEST_SCHEMA = "ocr.run-manifest/v1";

export type TerminalState = "complete" | "partial" | "failed" | "skipped";

/**
 * The released engine's top-level outcome.
 *
 * Distinct from `terminal_state`, which belongs to the run manifest. v1.8.4 emits only this.
 *
 * The full stdout vocabulary of the pinned release (`cmd/opencodereview/output.go`, v1.8.4):
 * `success` (finished, no warnings), `completed_with_warnings` (finished; every reservation is in
 * `warnings`), `completed_with_errors` (finished; at least one per-file subtask failed — the failed
 * paths are in `warnings`, and `files_reviewed` still counts them, because it counts dispatch, not
 * completion), `budget_exceeded` (the engine's own budget gate stopped dispatch; overrides the
 * warning statuses), and `skipped` (nothing to review). `failed` appears only on stderr
 * (`emitFailureUsage`) — a run that died outright writes no parsable stdout result at all, so
 * parsing it here means the engine itself never claimed it.
 *
 * Every value the engine can actually say must be in `RUN_STATUSES`: an unlisted value parses to
 * `unknown`, and `unknown` settles as an engine failure. That mapping gap is exactly how eight
 * consecutive runs on oscharko-dev/Keiko#3002 — each one finished, reviewed, and carrying findings
 * — settled `engine_status_not_success`, discarded their verdicts, and re-paid the full review on
 * every push (2026-08-06). Same defect class as the budget stop this file's `summary` parsing
 * exists for: a state the engine reports precisely, collapsed into "not success".
 */
export type RunStatus =
  | "success"
  | "skipped"
  | "failed"
  | "completed_with_warnings"
  | "completed_with_errors"
  | "budget_exceeded"
  | "unknown";

const RUN_STATUSES: ReadonlySet<string> = new Set<string>([
  "success",
  "skipped",
  "failed",
  "completed_with_warnings",
  "completed_with_errors",
  "budget_exceeded",
]);

const TERMINAL_STATES: ReadonlySet<string> = new Set<string>([
  "complete",
  "partial",
  "failed",
  "skipped",
]);

export interface EngineFinding {
  readonly path: RepoPath;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly severity: string | undefined;
  readonly category: string | undefined;
}

export interface EngineWarning {
  readonly type: string;
  readonly file: string;
  /**
   * Why a `subtask_error` happened, as a closed-vocabulary class rather than the engine's own
   * message (2026-08-06).
   *
   * `subtask_error` is the engine's catch-all for a per-file review that did not finish, and it
   * covers two failures that need opposite responses. Tool-budget exhaustion — the loop counting
   * `MaxToolRequestTimes` down to zero, surfacing as "main_task did not complete before stopping"
   * — is answered by giving the file more rounds (`MAX_TOOL_ROUNDS_PER_FILE`, run.ts). An LLM
   * transport error or a per-file timeout is not, and more rounds would only cost more.
   *
   * Without this class the two are indistinguishable in every diagnostic we emit, which means a
   * change to the round ceiling could not be evaluated at all — the whole point of raising it.
   * The engine's message text itself is never carried anywhere: it is matched against a fixed
   * pattern here and reduced to a name, the same discipline `model-proxy.ts` applies to 400
   * bodies.
   */
  readonly cause?: WarningCause;
}

/** Closed vocabulary for `EngineWarning.cause`. `other` means the message matched no known
 *  pattern — deliberately not "unknown", because the engine DID say something and this adapter
 *  simply has no name for it yet. */
export type WarningCause = "tool_budget" | "non_retryable" | "other";

export interface CoverageEntry {
  readonly path: string;
}

export interface EngineCoverage {
  readonly selected: readonly CoverageEntry[];
  readonly completed: readonly CoverageEntry[];
  readonly reused: readonly CoverageEntry[];
  readonly failed: readonly CoverageEntry[];
  readonly waived: readonly CoverageEntry[];
}

export interface EngineResult {
  /**
   * False when the engine emitted no run manifest at all.
   *
   * It does exactly that for a `skipped` run — verified against the real binary, which answers
   * `{"status":"skipped","message":"No supported files changed.","comments":[]}` with no
   * `manifest` key. Without this flag the absence reads as a parse failure, and the run gets
   * reported as a malformed engine error rather than as the coverage question it actually is.
   */
  readonly manifestPresent: boolean;
  /** Top-level outcome. The only terminal signal a released engine provides. */
  readonly status: RunStatus;
  /** Files the engine says it reviewed. The denominator for degraded reconciliation. */
  readonly filesReviewed: number;
  readonly schemaVersion: string;
  readonly terminalState: TerminalState | "unknown";
  readonly coverage: EngineCoverage;
  readonly findings: readonly EngineFinding[];
  readonly warnings: readonly EngineWarning[];
  readonly totalTokens: number;
  readonly budgetExceeded: boolean;
  /**
   * Findings this parser refused and dropped, rather than taking the whole result down with them
   * (2026-08-06, Keiko#3011).
   *
   * `optionalToken`'s doc comment already tells half of this story: one finding's malformed
   * `category` used to discard every OTHER finding in the same result, because `parseFindings`
   * builds its list with a single `.map()` and any throw escapes it. That fix stopped at the two
   * vocabulary fields, on the reasoning that a bad path or an inverted line range "is not
   * something a retry can repair, so there is nothing to gain by being lenient there".
   *
   * The reasoning was right about the FINDING and wrong about the RUN. On Keiko#3011 the engine
   * finished a nineteen-file review costing 1.76M tokens, and a structural defect in one finding
   * — the pinned model does emit `start_line: 0`, which `parseLine`'s own comment documents —
   * threw a `ValidationError` out of `parseEngineResult`. That error is not an `EngineRunError`,
   * so it bypassed the resume path entirely and landed in the generic catch that reports every
   * exception as `settlement.incomplete.engine_error`: the whole review discarded, eighteen
   * innocent files unreviewed, and a diagnostic blaming the engine for this adapter's refusal.
   *
   * Dropping the one finding is still rejection, not repair — nothing here invents a line number
   * or rewrites a path. It only scopes the refusal to the element that earned it. A count, not a
   * reason, because diagnostics carry no free text; `review.ts` records it so a run that quietly
   * loses findings this way is visible instead of silent.
   */
  readonly rejectedFindings: number;
  /**
   * The engine's own tool-call tally for the run: total, and per tool name.
   *
   * The engine has emitted this since v1.8.4 (`jsonToolCalls`, cmd/opencodereview/output.go) and
   * this adapter has never read it, which left the one question that matters for the tool-round
   * ceiling unanswerable: rounds are consumed by tool calls, so "why did this file need sixty
   * rounds" is really "which tool did it call sixty times". Empty when the engine reported none.
   */
  readonly toolCalls: ToolCallCounts;
}

/** Total tool calls and the per-tool breakdown, both from the engine's own tally. */
export interface ToolCallCounts {
  readonly total: number;
  readonly byTool: Readonly<Record<string, number>>;
}

/**
 * Bounds chosen so a hostile or degenerate result cannot exhaust memory or flood a pull request.
 *
 * Exported so a second finding source can apply the SAME bounds rather than restate them —
 * `contracts/change-pass.ts`'s cross-file pass validates its own candidates against
 * `maxBodyChars` from here, so the one content-length bound the engine's findings must respect
 * cannot silently drift from the one this second, independent source respects.
 */
export const LIMITS = {
  maxResultBytes: 32 * 1024 * 1024,
  maxFindings: 1000,
  maxWarnings: 1000,
  maxCoverage: 20000,
  maxBodyChars: 20000,
  maxLine: 10_000_000,
} as const;

function parseCoverageEntries(value: unknown, field: string): CoverageEntry[] {
  if (value === undefined) return [];
  return asArray(value, field, LIMITS.maxCoverage).map((entry, i) => {
    const object = asObject(entry, `${field}[${String(i)}]`);
    return { path: asString(object.path, `${field}[${String(i)}].path`) };
  });
}

function parseCoverage(value: unknown, field: string): EngineCoverage {
  const object = asObject(value, field);
  return {
    selected: parseCoverageEntries(object.selected, `${field}.selected`),
    completed: parseCoverageEntries(object.completed, `${field}.completed`),
    reused: parseCoverageEntries(object.reused, `${field}.reused`),
    failed: parseCoverageEntries(object.failed, `${field}.failed`),
    waived: parseCoverageEntries(object.waived, `${field}.waived`),
  };
}

/**
 * `report/types.ts`'s shared contract: `startLine`/`endLine` are 1-based, with exactly one
 * carved-out sentinel — both fields `0` together, meaning file-level (`isFileLevel`). That
 * sentinel is only ever constructed directly, as a literal `{ startLine: 0, endLine: 0 }` pair, by
 * deterministic code in review.ts (the contract gate and pin-desync findings) — it never passes
 * through this parser, which is model-facing only (`parseFindings`, `unwrapInnerLines`). `0` is
 * therefore never a legitimate value here: a model-produced `{ start_line: 0, end_line: 5 }` used
 * to parse successfully into a finding neither renderer's file-level sentinel nor SARIF's spec can
 * represent, since `end < start` (the only cross-field check) is false whenever `start` is `0`.
 */
function parseLine(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > LIMITS.maxLine
  ) {
    throw new ValidationError(field);
  }
  return value;
}

/**
 * Every finding the engine emitted, minus the ones this parser refused.
 *
 * The refusal is per element and the survivors are unaffected — see `EngineResult.rejectedFindings`
 * for the incident that made the difference between "this finding is unusable" and "this run is
 * unusable" worth 1.76M tokens. The array bound itself still throws: a `comments` field that is not
 * an array, or one past `maxFindings`, is a malformed RESULT rather than a malformed element, and
 * there is no element boundary to scope a refusal to.
 */
function parseFindings(
  value: unknown,
  field: string,
): { findings: EngineFinding[]; rejected: number } {
  if (value === undefined || value === null) return { findings: [], rejected: 0 };
  const findings: EngineFinding[] = [];
  let rejected = 0;
  asArray(value, field, LIMITS.maxFindings).forEach((entry, i) => {
    try {
      findings.push(parseOneFinding(entry, `${field}[${String(i)}]`));
    } catch (error) {
      // Only this parser's own refusals are scoped away. Anything else escaping `parseOneFinding`
      // is a defect in this adapter, not a malformed finding, and must not be swallowed as one.
      if (!(error instanceof ValidationError)) throw error;
      rejected += 1;
    }
  });
  return { findings, rejected };
}

function parseOneFinding(entry: unknown, scope: string): EngineFinding {
  const object = asObject(entry, scope);
  const start = parseLine(object.start_line, `${scope}.start_line`);
  const end = parseLine(object.end_line, `${scope}.end_line`);
  if (end < start) throw new ValidationError(`${scope}.end_line`);
  // The engine's path comes from candidate-controlled input and is used to address the GitHub
  // API, so it is re-validated here rather than trusted because the engine echoed it.
  const path = repoPath(asString(object.path, `${scope}.path`), `${scope}.path`);
  const content = asString(object.content, `${scope}.content`, LIMITS.maxBodyChars);
  const severity = optionalToken(object.severity);
  const category = optionalToken(object.category);

  // See `unwrapEnvelopeContent` below: the model sometimes answers with a full finding
  // envelope stuffed into `content` instead of `content`'s prose. When that shape appears, the
  // inner envelope is what the model actually meant to file, and the fields below adopt it
  // field-by-field, falling back to this outer envelope wherever the inner one is absent or
  // invalid.
  const unwrapped = unwrapEnvelopeContent(content, `${scope}.content`);
  if (unwrapped === undefined) {
    return { path, content, startLine: start, endLine: end, severity, category };
  }
  return {
    path: unwrapped.path ?? path,
    content: unwrapped.content,
    startLine: unwrapped.startLine ?? start,
    endLine: unwrapped.endLine ?? end,
    severity: unwrapped.severity ?? severity,
    category: unwrapped.category ?? category,
  };
}

/**
 * `category` and `severity` are vocabulary, not structure. A malformed value here used to throw
 * exactly like a malformed path or an inverted line range — but `parseFindings` builds its list
 * with one `.map()`, so one finding's bad token discarded every OTHER finding in the same result
 * too. A model answering `"category": "bug (logic)"` destroyed an otherwise-complete review over a
 * formatting slip, and the caller could not tell "the model wrote nonsense" from "this run did not
 * finish" — both surfaced as the same thrown `ValidationError`. A malformed value degrades to
 * `undefined` instead, exactly like an absent one, so the finding still reaches
 * `needsClassification` → `repairClassification` (classify.ts) — the machinery that already exists
 * to re-ask the model for these two fields specifically, in a prompt small enough that compliance
 * is not a coin flip. This is not the reject-rather-than-repair rule bending: nothing here invents
 * or rewrites a classification, it only stops a vocabulary slip from taking a structurally sound
 * finding down with it. Structural fields — path, content, the line range, above — are untouched and
 * still throw: a bad path or an inverted range is not something a retry can repair, so there is
 * nothing to gain by being lenient there.
 */
function optionalToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  return /^[a-z][a-z0-9_-]*$/i.test(value) ? value : undefined;
}

/**
 * The finding-envelope keys other than `content` that the rule text (`CATCH_ALL_RULE` in
 * `rule-file.ts`) instructs the model to emit alongside it. Any one of these, found as a sibling
 * of a `content` string inside a parsed object, is enough to suspect the model nested its answer
 * instead of writing prose — see `unwrapEnvelopeContent` below.
 */
const ENVELOPE_KEYS = ["path", "start_line", "end_line", "category", "severity"] as const;

/** Adopts the inner envelope's `path` — through the same validators the outer envelope uses —
 *  only when it is present and valid; otherwise the caller keeps its own.
 */
function unwrapInnerPath(inner: Record<string, unknown>, field: string): RepoPath | undefined {
  const pathField = `${field}.path`;
  try {
    return repoPath(asString(inner.path, pathField), pathField);
  } catch {
    return undefined;
  }
}

/**
 * Adopts the inner envelope's line range only as a matched pair: `start_line` and `end_line` must
 * both be individually valid (via `parseLine`, the same validator the outer envelope uses) AND
 * satisfy the same non-inverted-range rule `parseFindings` enforces on the outer pair. Anything
 * less and both fall back to the outer pair together — mixing an inner `start_line` with an outer
 * `end_line` (or vice versa) would silently produce a range neither the model nor this parser ever
 * actually validated together.
 */
function unwrapInnerLines(
  inner: Record<string, unknown>,
  field: string,
): { readonly startLine: number; readonly endLine: number } | undefined {
  try {
    const startLine = parseLine(inner.start_line, `${field}.start_line`);
    const endLine = parseLine(inner.end_line, `${field}.end_line`);
    if (endLine < startLine) throw new ValidationError(`${field}.end_line`);
    return { startLine, endLine };
  } catch {
    return undefined;
  }
}

interface UnwrappedEnvelope {
  readonly content: string;
  readonly path: RepoPath | undefined;
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
  readonly severity: string | undefined;
  readonly category: string | undefined;
}

/**
 * Recovers a finding the model filed as a JSON envelope nested inside its own `content` field.
 *
 * Measured, not hypothesized: a same-day 32-case qualification run over gpt-oss-120b produced six
 * findings, across two arms, whose `content` was itself a JSON object carrying the finding
 * envelope's own keys — a body beginning `{"path": "src/candidate-deliverability.ts",
 * "start_line": 4, "end_line": 4, "category": "bug", "severity": "high", "content": "The
 * predicate excludes only needs-review, so a rejected candidate still reads as deliverable."}`.
 * That cost two things: the raw JSON was published verbatim as a review comment body (it
 * contains no HTML or links, so `sanitizeFindingBody` had no reason to reject it), and in the
 * `status-union-widened-consumer-missed` case the corpus scored a genuinely correct finding a
 * miss, because the NESTED path named the correct consumer file while the outer envelope named
 * the changed file the engine was actually looking at — the model found the defect and filed it
 * in the wrong field.
 *
 * This is the same recoverable-format-error family `optionalToken` above already treats
 * leniently: the model's judgement was sound and only its envelope shape is wrong, so both
 * discarding the finding and publishing the raw JSON are worse outcomes than deterministically
 * taking what the model plainly meant. It does not bend "reject rather than repair" any more than
 * `optionalToken` does, and for the same reason: the outer envelope has already validated in full
 * by the time this runs, so there is always a structurally sound finding to fall back to — this
 * only decides, field by field, which of two well-formed candidates to keep.
 *
 * Unwraps at most one level. A `content` string that, after unwrapping, is again a nested envelope
 * is left as literal text, because this function is called exactly once per finding (from
 * `parseFindings`) and its result is never fed back into itself. A model nesting its answer twice
 * is not the single format slip this exists to recover; guessing through a second layer of it
 * would be exactly the kind of guess "reject rather than repair" does forbid.
 */
function unwrapEnvelopeContent(content: string, field: string): UnwrappedEnvelope | undefined {
  let inner: Record<string, unknown>;
  try {
    inner = asObject(parseJson(content, field), field);
  } catch {
    return undefined;
  }
  // `content` missing or non-string, or no sibling envelope key at all, means this is either
  // ordinary prose that happens to parse as JSON (a bare `{"debug": true}` quoted from the diff,
  // say) or an object this heuristic has no basis to treat as a nested finding. Silence beats a
  // guess: leave the finding exactly as it arrived.
  if (typeof inner.content !== "string") return undefined;
  if (!ENVELOPE_KEYS.some((key) => key in inner)) return undefined;

  // The inner content becomes the finding body, so it must clear the same bound the outer
  // content already had to: reused, not restated. In practice only the empty-string floor can
  // fire here — the inner string is nested inside the already-bounded outer one, so it can never
  // itself exceed `maxBodyChars`.
  let innerContent: string;
  try {
    innerContent = asString(inner.content, `${field}.content`, LIMITS.maxBodyChars);
  } catch {
    return undefined;
  }

  const lines = unwrapInnerLines(inner, field);
  return {
    content: innerContent,
    path: unwrapInnerPath(inner, field),
    startLine: lines?.startLine,
    endLine: lines?.endLine,
    severity: optionalToken(inner.severity),
    category: optionalToken(inner.category),
  };
}

/**
 * The one message this adapter recognises, matched against the pinned engine's own wording.
 *
 * `agent.executeSubtask` (v1.8.4) constructs it verbatim when `RunPerFile` returns without the
 * model having called `task_done`, which happens exactly when the tool-round counter reaches zero.
 * Matched loosely (case-insensitive, on the distinctive phrase) rather than by equality, so a
 * reworded engine release degrades to `other` — an unmatched cause, never a wrong one.
 */
const TOOL_BUDGET_MESSAGE = /main_task did not complete/i;
const NON_RETRYABLE_SINGLE_SHOT_MESSAGE =
  /^single_shot (?:core|integration) examiner request rejected$/u;

/** The class of a `subtask_error`, from the engine's own message. Never carries the message. */
function classifyWarning(type: string, message: unknown): WarningCause | undefined {
  if (type !== "subtask_error" && type !== "scan_subtask_error") return undefined;
  if (typeof message !== "string") return "other";
  if (NON_RETRYABLE_SINGLE_SHOT_MESSAGE.test(message)) return "non_retryable";
  return TOOL_BUDGET_MESSAGE.test(message) ? "tool_budget" : "other";
}

function parseWarnings(value: unknown, field: string): EngineWarning[] {
  if (value === undefined || value === null) return [];
  return asArray(value, field, LIMITS.maxWarnings).map((entry, i) => {
    const scope = `${field}[${String(i)}]`;
    const object = asObject(entry, scope);
    const type = asString(object.type, `${scope}.type`, 200);
    const cause = classifyWarning(type, object.message);
    return {
      type,
      // Not a validated repository path: the engine also reports warnings without a file.
      file: typeof object.file === "string" ? object.file.slice(0, 1024) : "",
      ...(cause === undefined ? {} : { cause }),
    };
  });
}

/**
 * The engine's tool-call tally, or zeroes when it reported none.
 *
 * Tolerant by design, and tolerant of SHAPE, not merely of absence: this is telemetry, and a
 * malformed tally must never cost a run its verdict. `asObject` would have thrown here, and
 * `parseBooked` rethrows after booking spend — so a `tool_calls` field the engine emitted as a
 * string, a number, or an array would have destroyed an otherwise complete review to protect a
 * diagnostic count. That is the same trade `parseFindings` was rewritten to stop making
 * (Keiko#3011, where one malformed finding discarded eighteen good ones), reintroduced one
 * function over by the very parser written to diagnose it. Found by this reviewer reviewing
 * itself, on the commit that added this function.
 *
 * Tool NAMES come from the engine's own fixed tool set, not from candidate content, but they are
 * still filtered to a conservative identifier shape before being used as diagnostic keys — a key
 * is a name in a log the whole organization reads.
 */
function parseToolCalls(value: unknown): ToolCallCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { total: 0, byTool: {} };
  }
  const object = value as Record<string, unknown>;
  const total =
    typeof object.total === "number" && Number.isFinite(object.total)
      ? Math.max(0, Math.trunc(object.total))
      : 0;
  return { total, byTool: parseByTool(object.by_tool) };
}

/** The per-tool half, split out to keep `parseToolCalls` under the complexity ceiling. Names come
 *  from the engine's own fixed tool set, not from candidate content, but they are still filtered to
 *  an identifier shape: a key lands in a log the consumer's whole organization reads. */
function parseByTool(raw: unknown): Record<string, number> {
  const byTool: Record<string, number> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return byTool;
  for (const [name, count] of Object.entries(raw as Record<string, unknown>)) {
    const usable = typeof count === "number" && Number.isFinite(count);
    if (usable && TOOL_NAME.test(name)) byTool[name] = Math.max(0, Math.trunc(count));
  }
  return byTool;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/i;

function parseSummary(value: unknown): {
  totalTokens: number;
  budgetExceeded: boolean;
  filesReviewed: number;
} {
  if (value === undefined || value === null) {
    return { totalTokens: 0, budgetExceeded: false, filesReviewed: 0 };
  }
  const object = asObject(value, "summary");
  const tokens = object.total_tokens;
  const reviewed = object.files_reviewed;
  return {
    totalTokens: typeof tokens === "number" && Number.isFinite(tokens) ? Math.trunc(tokens) : 0,
    budgetExceeded: object.budget_exceeded === true,
    filesReviewed:
      typeof reviewed === "number" && Number.isFinite(reviewed) ? Math.trunc(reviewed) : 0,
  };
}

/**
 * An unrecognised terminal state becomes `"unknown"` rather than an exception.
 *
 * The distinction matters: a parse failure and a state this adapter has never seen are both
 * "do not treat as clean", but only the second one still carries usable coverage data worth
 * reporting to an operator.
 */
function parseTerminalState(value: unknown): TerminalState | "unknown" {
  if (typeof value !== "string") return "unknown";
  return TERMINAL_STATES.has(value) ? (value as TerminalState) : "unknown";
}

export function parseEngineResult(text: string): EngineResult {
  if (text.length === 0 || text.length > LIMITS.maxResultBytes) {
    throw new ValidationError("result.size");
  }
  const root = asObject(parseJson(text, "result"), "result");
  const rawManifest = root.manifest;
  const manifestPresent = rawManifest !== undefined && rawManifest !== null;
  const manifest = manifestPresent ? asObject(rawManifest, "result.manifest") : {};
  const summary = parseSummary(root.summary);
  const rawStatus = root.status;
  const status: RunStatus =
    typeof rawStatus === "string" && RUN_STATUSES.has(rawStatus)
      ? (rawStatus as RunStatus)
      : "unknown";
  const comments = parseFindings(root.comments, "result.comments");

  return {
    manifestPresent,
    status,
    filesReviewed: summary.filesReviewed,
    schemaVersion: manifestPresent
      ? asString(manifest.schema_version, "result.manifest.schema_version", 128)
      : "",
    terminalState: parseTerminalState(manifest.terminal_state),
    coverage: manifestPresent
      ? parseCoverage(manifest.coverage, "result.manifest.coverage")
      : { selected: [], completed: [], reused: [], failed: [], waived: [] },
    findings: comments.findings,
    warnings: parseWarnings(root.warnings, "result.warnings"),
    totalTokens: summary.totalTokens,
    budgetExceeded: summary.budgetExceeded,
    rejectedFindings: comments.rejected,
    toolCalls: parseToolCalls(root.tool_calls),
  };
}
