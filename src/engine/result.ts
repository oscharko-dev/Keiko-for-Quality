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
 */
export type RunStatus = "success" | "skipped" | "failed" | "unknown";

const RUN_STATUSES: ReadonlySet<string> = new Set<string>(["success", "skipped", "failed"]);

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
}

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

function parseLine(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > LIMITS.maxLine
  ) {
    throw new ValidationError(field);
  }
  return value;
}

function parseFindings(value: unknown, field: string): EngineFinding[] {
  if (value === undefined || value === null) return [];
  return asArray(value, field, LIMITS.maxFindings).map((entry, i) => {
    const scope = `${field}[${String(i)}]`;
    const object = asObject(entry, scope);
    const start = parseLine(object.start_line, `${scope}.start_line`);
    const end = parseLine(object.end_line, `${scope}.end_line`);
    if (end < start) throw new ValidationError(`${scope}.end_line`);
    return {
      // The engine's path comes from candidate-controlled input and is used to address the GitHub
      // API, so it is re-validated here rather than trusted because the engine echoed it.
      path: repoPath(asString(object.path, `${scope}.path`), `${scope}.path`),
      content: asString(object.content, `${scope}.content`, LIMITS.maxBodyChars),
      startLine: start,
      endLine: end,
      severity: optionalToken(object.severity),
      category: optionalToken(object.category),
    };
  });
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

function parseWarnings(value: unknown, field: string): EngineWarning[] {
  if (value === undefined || value === null) return [];
  return asArray(value, field, LIMITS.maxWarnings).map((entry, i) => {
    const scope = `${field}[${String(i)}]`;
    const object = asObject(entry, scope);
    return {
      type: asString(object.type, `${scope}.type`, 200),
      // Not a validated repository path: the engine also reports warnings without a file.
      file: typeof object.file === "string" ? object.file.slice(0, 1024) : "",
    };
  });
}

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
    findings: parseFindings(root.comments, "result.comments"),
    warnings: parseWarnings(root.warnings, "result.warnings"),
    totalTokens: summary.totalTokens,
    budgetExceeded: summary.budgetExceeded,
  };
}
