import { FINDING_CATEGORIES, FINDING_SEVERITIES } from "../engine/classify.js";

/**
 * The structural input this module's renderers consume.
 *
 * `epic #94`'s local-review-core work extracts a publication-free orchestrator from
 * `src/review.ts` in parallel with this module, and that orchestrator will eventually produce a
 * `LocalReviewReport` this package documents as carrying AT LEAST the fields mirrored below. This
 * file does not import that type — `src/review.ts` is off limits to this module by design, the
 * same reason `publish/presentation.ts` mirrors `ReviewOutcome` as its own `SummaryOutcome` rather
 * than importing it: a leaf module (here, the report renderers) must not depend on the top-level
 * orchestrator, only the orchestrator may depend on it. `ReportInput` is therefore this module's
 * OWN structural type, deliberately narrower than whatever `LocalReviewReport` ends up carrying.
 * Because every field below is read-only and consumed by simple, direct assignment (no `as` casts,
 * no reflection), a real `LocalReviewReport` value that carries at least these fields, with the
 * same field names and compatible types, is assignable to `ReportInput` without any adapter.
 *
 * Deliberately excluded, and left for a follow-up once the real orchestrator exposes them:
 * - A per-finding stable identity for cross-run deduplication (issue #97's fuller JSON scope asks
 *   for one; nothing in this module's binding interface provides the content-addressed material —
 *   blob ids and rule digest — needed to compute it honestly).
 * - A dropped/rejected-findings count. `LocalReviewReport.quality.rejectedSanitization` now carries
 *   the final selected sanitizer loss for production-path corpus grading, but `ReportInput` does not
 *   yet expose the broader quality block, so neither renderer can surface it. Fabricating a zero
 *   would misreport a run where sanitization actually dropped something, so this remains absent
 *   from schema v1 rather than guessed at.
 * - `identity`/`inputs`/`cache` sections from issue #97's full Scope section (engine digest, model
 *   id, protocol, repository path, base/head SHA, profile path, cache hit/miss/append counts).
 *   `ruleDigest` and `engineVersion` below are the only identity fields the binding interface for
 *   this task promises; the rest need `ReportInput` to grow once the orchestrator carries them.
 *   Schema v1 is additive-only by design (issue #97), so adding them later is a compatible change.
 */

/**
 * The closed finding-category vocabulary.
 *
 * Re-exported from `engine/classify.ts` rather than restated, per issue #97's own "Existing
 * Capability Review" note that this vocabulary already lives there. Importing the same frozen
 * array — not copying its string literals by hand — means a future category addition or rename in
 * `classify.ts` cannot silently drift out of step with what this module renders.
 */
export { FINDING_CATEGORIES };
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** The closed finding-severity vocabulary. See `FINDING_CATEGORIES` above for why this is re-exported. */
export { FINDING_SEVERITIES };
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * A review's settlement outcome.
 *
 * Mirrors `ReviewOutcome` (`src/review.ts`) and `SummaryOutcome` (`src/publish/presentation.ts`)
 * without importing either, for the same reason `presentation.ts` states for its own copy: this
 * stays a leaf module.
 */
export const REPORT_OUTCOMES = ["complete", "incomplete", "abandoned"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

/** One finding, anchored to the repository-relative location the engine reported it against. */
export interface ReportFinding {
  /** Repository-relative path. Not re-validated here — the orchestrator boundary already did. */
  readonly path: string;
  /**
   * 1-based, inclusive — with one carved-out sentinel: `0` on BOTH fields means a file-level
   * finding (the deterministic contract gates emit these; see docs/local-report-schema.md). The
   * renderers translate the sentinel — JSON to `null`, SARIF to a region-less location — so no
   * consumer ever sees a literal 0. Both ask `isFileLevel` below rather than re-testing the two
   * fields themselves.
   */
  readonly startLine: number;
  /** 1-based, inclusive; equal to `startLine` for a single-line finding, `0` for file-level. */
  readonly endLine: number;
  /**
   * Absent when the finding stayed unclassified — a real state this pipeline refuses to paper
   * over with a fabricated value (CONTRIBUTING.md). JSON renders the key as `null` rather than
   * omitting it, so a consumer reading the field always finds it and never has to distinguish
   * "unclassified" from "this writer is older than the field"; SARIF reports the `unclassified`
   * rule and level `none`.
   */
  readonly category?: FindingCategory;
  readonly severity?: FindingSeverity;
  /** Sanitized Markdown. Rendered as-is: sanitization is this module's caller's responsibility. */
  readonly body: string;
}

/**
 * The 0-anchor sentinel above, as one predicate: the single decision point both renderers share.
 * The JSON `null`/`null` anchors and the SARIF region-less location are two renderings of THIS
 * question, not two independent readings of the convention — which is what they were while the
 * comparison was written out character-for-character in each renderer, where either copy could
 * have drifted (to `<= 0`, or to testing `startLine` alone) with every test still green. Only the
 * question lives here; each renderer keeps its own comment for why its format answers it the way
 * it does, because that reasoning is format-specific and does not generalize.
 *
 * Takes the two anchors rather than a whole `ReportFinding` so anything holding a line range — a
 * test, a later third renderer — can ask without assembling a finding around it.
 */
export function isFileLevel(finding: Pick<ReportFinding, "startLine" | "endLine">): boolean {
  return finding.startLine === 0 && finding.endLine === 0;
}

/** Token/spend accounting for one run, as accumulated by the run ledger. */
export interface ReportSpend {
  readonly engine: number;
  readonly classify: number;
  /** The run's total spend. Not necessarily `engine + classify` by construction in every caller,
   *  so this module carries it as its own reported field rather than deriving it. */
  readonly total: number;
  readonly allotted: number;
}

/** Inventory accounting for one run. */
export interface ReportInventory {
  readonly total: number;
  readonly reviewable: number;
  /** Reviewable paths the engine actually covered — may be less than `reviewable` on a run that
   *  settles incomplete over a coverage gap. */
  readonly reviewed: number;
}

/** The complete structural input to both renderers in this directory. */
export interface ReportInput {
  readonly outcome: ReportOutcome;
  readonly findings: readonly ReportFinding[];
  readonly spend: ReportSpend;
  readonly inventory: ReportInventory;
  readonly ruleDigest: string;
  readonly engineVersion: string;
  /**
   * Why the run did not settle `complete`. Optional so a `LocalReviewReport` that has not yet
   * grown this exact field name remains assignment-compatible; absent is rendered the same as an
   * unrecorded reason, never as a fabricated one. Meaningful only when `outcome !== "complete"`,
   * but this module renders whatever it is given without second-guessing `outcome` against it.
   */
  readonly reason?: string;
}
