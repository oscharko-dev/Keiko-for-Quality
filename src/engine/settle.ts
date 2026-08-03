import type { CompiledProfile } from "../config/profile.js";
import type { RuntimeConfig } from "../config/runtime.js";
import type { ReasonCode } from "../diagnostics/reason-codes.js";
import type { Inventory } from "../inventory/inventory.js";
import { SUPPORTED_MANIFEST_SCHEMA, type EngineFinding, type EngineResult } from "./result.js";

/**
 * The single decision that separates "reviewed" from "not reviewed".
 *
 * Everything upstream of this function gathers evidence; this is where the run is judged. It is
 * written as an ordered sequence of disqualifying checks rather than a score, because there is no
 * such thing as a review that is mostly complete: a consumer either got coverage of their change or
 * they did not, and only one of those may look clean.
 *
 * There are two paths, and the difference is a real difference in what can be proved.
 *
 * **Reconciled** — the engine emitted a run manifest. Every inventoried path is matched by identity
 * against the engine's own coverage partitions, so an omission is detected regardless of which file
 * it was.
 *
 * **Counted** — the engine emitted no manifest. Only `status` and a `files_reviewed` count exist, so
 * coverage is reconciled by cardinality: if the engine reviewed fewer files than the inventory says
 * are reviewable, something was skipped. That still catches omission, but not *which* file, and it
 * cannot detect a substitution that keeps the count intact.
 *
 * The counted path is not a convenience fallback. No published engine release emits a manifest —
 * `internal/session/manifest.go` exists only on the upstream default branch — so it is what a
 * digest-pinned release actually provides today. Which path ran is reported rather than hidden,
 * because a consumer deciding how far to trust a clean result needs to know which question was
 * answered.
 */
export type SettlementMode = "reconciled" | "counted";

export type Settlement =
  | {
      readonly status: "complete";
      readonly mode: SettlementMode;
      readonly findings: readonly EngineFinding[];
    }
  | {
      readonly status: "incomplete";
      readonly mode: SettlementMode;
      readonly reason: ReasonCode;
      readonly counts: Readonly<Record<string, number>>;
      /**
       * What the engine did return before the run fell short.
       *
       * Carried rather than dropped, because "the coverage was incomplete" and "there is nothing
       * to report" are different facts and the second one is usually false. Measured on Keiko
       * PR #2926: 89 files, 87 reviewed, 19 KB of engine output — and because a partial run
       * discarded its findings, the pull request received a blocking notice and not one finding.
       * On a large change a single failed file is the ordinary case, so dropping the rest makes the
       * reviewer useless exactly where it is worth the most.
       *
       * Publishing them does not soften the outcome: the run is still incomplete, the notice still
       * blocks, and nothing here may be read as a clean review.
       */
      readonly findings: readonly EngineFinding[];
    };

function incomplete(
  mode: SettlementMode,
  reason: ReasonCode,
  findings: readonly EngineFinding[],
  counts: Record<string, number> = {},
): Settlement {
  return { status: "incomplete", mode, reason, counts, findings };
}

/** Paths the engine claims it actually reviewed, or safely reused a prior review for. */
function coveredPaths(result: EngineResult): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const entry of result.coverage.completed) covered.add(entry.path);
  for (const entry of result.coverage.reused) covered.add(entry.path);
  return covered;
}

/** No memoization: every existing caller that does not pass one gets today's exact behaviour. */
const NO_MEMOIZED_PATHS: ReadonlySet<string> = new Set();

/**
 * The reconciliation the engine cannot perform for itself.
 *
 * The engine reports what it selected and finished. Only an independently computed inventory can
 * answer whether what it selected was everything that changed — which is the question that matters
 * when the engine's own path filters differ from the consumer's review profile.
 *
 * `memoizedPaths` (v0.9.0) is a reviewable path a cache hit answered instead of the engine. It was
 * excluded from the engine's own dispatch on purpose (see `buildRuleFile`'s exclude threading), so
 * it can never appear in `coveredPaths` — without crediting it here, every memoized path would
 * read as a permanent, un-fixable coverage gap instead of the deliberate skip it is.
 */
function findCoverageGap(
  inventory: Inventory,
  result: EngineResult,
  memoizedPaths: ReadonlySet<string>,
): number {
  const covered = coveredPaths(result);
  let gap = 0;
  for (const path of inventory.reviewablePaths) {
    if (!covered.has(path) && !memoizedPaths.has(path)) gap += 1;
  }
  return gap;
}

function unlistedWarnings(profile: CompiledProfile, result: EngineResult): number {
  let unlisted = 0;
  for (const warning of result.warnings) {
    if (!profile.benignWarnings.has(warning.type)) unlisted += 1;
  }
  return unlisted;
}

/** Disqualifiers that apply identically on both paths. */
function commonDisqualifier(
  mode: SettlementMode,
  result: EngineResult,
  profile: CompiledProfile,
  config: RuntimeConfig,
): Settlement | undefined {
  const unlisted = unlistedWarnings(profile, result);
  if (unlisted > 0) {
    return incomplete(mode, "settlement.incomplete.warning_not_allowlisted", result.findings, {
      unlisted,
    });
  }
  if (result.budgetExceeded || result.totalTokens > config.tokenBudget) {
    return incomplete(mode, "settlement.incomplete.budget_exceeded", result.findings, {
      tokens: result.totalTokens,
    });
  }
  // A result carrying more findings than the consumer believes plausible is more likely a
  // misconfigured model or a prompt-injection success than a genuinely terrible change.
  if (result.findings.length > config.maxFindings) {
    return incomplete(mode, "settlement.incomplete.engine_error", result.findings, {
      findings: result.findings.length,
    });
  }
  return undefined;
}

function settleReconciled(
  inventory: Inventory,
  result: EngineResult,
  profile: CompiledProfile,
  config: RuntimeConfig,
  memoizedPaths: ReadonlySet<string>,
): Settlement {
  // An unfamiliar manifest schema means every field below may have shifted meaning. Reading it
  // anyway would be guessing about whether a review happened.
  if (result.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
    // Nothing to carry: the result did not parse, so no finding from it is trustworthy.
    //
    // The reason is a SETTLEMENT code, not the `engine.run.schema_rejected` diagnostic this line
    // used to borrow. A settlement reason is published in the incomplete notice, so it has to
    // answer "why was my change not fully reviewed" for a reader with no access to the log;
    // naming an engine-execution diagnostic there said where the trouble was seen rather than
    // what it meant for coverage. The diagnostic keeps its own name where the manifest is
    // validated. Dormant until an engine ships a manifest this path can reach, which is exactly
    // why it went unnoticed — the same taxonomy break as #57, one family over.
    return incomplete("reconciled", "settlement.incomplete.schema_rejected", []);
  }
  if (result.terminalState !== "complete") {
    return incomplete("reconciled", "settlement.incomplete.terminal_state", result.findings);
  }
  if (result.coverage.failed.length > 0) {
    return incomplete("reconciled", "settlement.incomplete.coverage_failed", result.findings, {
      failed: result.coverage.failed.length,
    });
  }
  const gap = findCoverageGap(inventory, result, memoizedPaths);
  if (gap > 0) {
    return incomplete("reconciled", "settlement.incomplete.coverage_gap", result.findings, {
      gap,
      reviewable: inventory.reviewablePaths.size,
    });
  }
  return (
    commonDisqualifier("reconciled", result, profile, config) ?? {
      status: "complete",
      mode: "reconciled",
      findings: result.findings,
    }
  );
}

/**
 * Settlement against an engine that reports no coverage manifest.
 *
 * `files_reviewed` is the engine's own count of what it dispatched. Comparing it to the independent
 * inventory is weaker than matching identities, but it is not nothing: it is exactly the check that
 * catches the engine's path filters disagreeing with the consumer's review profile, which is the
 * omission this adapter exists to prevent.
 *
 * A memoized path (v0.9.0) was excluded from the engine's dispatch the same way, so it can never
 * contribute to `files_reviewed` either. The expected count shrinks by exactly the memoized count
 * rather than the reported count growing to match — shrinking the denominator is what still lets a
 * genuinely missing, non-memoized file register as a real shortfall.
 */
function settleCounted(
  inventory: Inventory,
  result: EngineResult,
  profile: CompiledProfile,
  config: RuntimeConfig,
  memoizedPaths: ReadonlySet<string>,
): Settlement {
  if (result.status !== "success") {
    return incomplete("counted", "settlement.incomplete.terminal_state", result.findings);
  }
  const expected = Math.max(0, inventory.reviewablePaths.size - memoizedPaths.size);
  if (result.filesReviewed < expected) {
    return incomplete("counted", "settlement.incomplete.coverage_gap", result.findings, {
      gap: expected - result.filesReviewed,
      reviewable: expected,
      reviewed: result.filesReviewed,
    });
  }
  return (
    commonDisqualifier("counted", result, profile, config) ?? {
      status: "complete",
      mode: "counted",
      findings: result.findings,
    }
  );
}

/**
 * @param memoizedPaths Reviewable paths a review-cache hit answered instead of the engine (v0.9.0).
 *   Defaults to empty, so every pre-existing caller keeps today's exact behaviour unchanged.
 */
export function settle(
  inventory: Inventory,
  result: EngineResult,
  profile: CompiledProfile,
  config: RuntimeConfig,
  memoizedPaths: ReadonlySet<string> = NO_MEMOIZED_PATHS,
): Settlement {
  return result.manifestPresent
    ? settleReconciled(inventory, result, profile, config, memoizedPaths)
    : settleCounted(inventory, result, profile, config, memoizedPaths);
}
