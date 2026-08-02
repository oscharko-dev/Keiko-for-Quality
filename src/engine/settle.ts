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
 */
export type Settlement =
  | { readonly status: "complete"; readonly findings: readonly EngineFinding[] }
  | {
      readonly status: "incomplete";
      readonly reason: ReasonCode;
      readonly counts: Readonly<Record<string, number>>;
    };

function incomplete(reason: ReasonCode, counts: Record<string, number> = {}): Settlement {
  return { status: "incomplete", reason, counts };
}

/** Paths the engine claims it actually reviewed, or safely reused a prior review for. */
function coveredPaths(result: EngineResult): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const entry of result.coverage.completed) covered.add(entry.path);
  for (const entry of result.coverage.reused) covered.add(entry.path);
  return covered;
}

/**
 * The reconciliation the engine cannot perform for itself.
 *
 * The engine reports what it selected and finished. Only an independently computed inventory can
 * answer whether what it selected was everything that changed — which is the question that matters
 * when the engine's own path filters differ from the consumer's review profile.
 */
function findCoverageGap(inventory: Inventory, result: EngineResult): number {
  const covered = coveredPaths(result);
  let gap = 0;
  for (const path of inventory.reviewablePaths) {
    if (!covered.has(path)) gap += 1;
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

export function settle(
  inventory: Inventory,
  result: EngineResult,
  profile: CompiledProfile,
  config: RuntimeConfig,
): Settlement {
  // An unfamiliar manifest schema means every field below may have shifted meaning. Reading it
  // anyway would be guessing about whether a review happened.
  if (result.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
    return incomplete("engine.run.schema_rejected");
  }
  if (result.terminalState !== "complete") {
    return incomplete("settlement.incomplete.terminal_state");
  }
  if (result.coverage.failed.length > 0) {
    return incomplete("settlement.incomplete.coverage_failed", {
      failed: result.coverage.failed.length,
    });
  }
  const gap = findCoverageGap(inventory, result);
  if (gap > 0) {
    return incomplete("settlement.incomplete.coverage_gap", {
      gap,
      reviewable: inventory.reviewablePaths.size,
    });
  }
  const unlisted = unlistedWarnings(profile, result);
  if (unlisted > 0) {
    return incomplete("settlement.incomplete.warning_not_allowlisted", { unlisted });
  }
  if (result.budgetExceeded || result.totalTokens > config.tokenBudget) {
    return incomplete("settlement.incomplete.budget_exceeded", { tokens: result.totalTokens });
  }
  // A result carrying more findings than the consumer believes plausible is more likely a
  // misconfigured model or a prompt-injection success than a genuinely terrible change.
  if (result.findings.length > config.maxFindings) {
    return incomplete("settlement.incomplete.engine_error", { findings: result.findings.length });
  }
  return { status: "complete", findings: result.findings };
}
