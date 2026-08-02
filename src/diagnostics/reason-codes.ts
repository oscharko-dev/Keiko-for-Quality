/**
 * The closed vocabulary of things this reviewer is allowed to say about a run.
 *
 * Diagnostics exist to let an operator act, not to explain a defect. Anything richer than a code
 * plus bounded numeric context would eventually carry candidate content, model output, or a
 * credential into a log that the consumer's whole organization can read.
 */
export const REASON_CODES = [
  // Run lifecycle
  "run.started",
  "run.finished",
  "run.failed",

  // Eligibility
  "eligibility.accepted",
  "eligibility.skipped.draft",
  "eligibility.skipped.fork",
  "eligibility.skipped.base_branch",
  "eligibility.skipped.edit_not_retarget",

  // Review pair
  "review_pair.resolved",
  "review_pair.merge_base_unresolved",

  // Inventory
  "inventory.completed",
  "inventory.empty",
  "inventory.unclassified_path",

  // Engine acquisition
  "engine.acquire.unsupported_platform",
  "engine.acquire.download_failed",
  "engine.acquire.digest_mismatch",
  "engine.acquire.verified",

  // Engine execution
  "engine.run.completed",
  "engine.run.timeout",
  "engine.run.spawn_failed",
  "engine.run.nonzero_exit",
  "engine.run.output_unparsable",
  "engine.run.schema_rejected",

  // Settlement
  "settlement.complete",
  // Which coverage question was actually answered. Recorded on every run, because a consumer
  // deciding how far to trust a clean result needs to know whether identities or only counts were
  // reconciled.
  "settlement.mode.reconciled",
  "settlement.mode.counted",
  "settlement.incomplete.terminal_state",
  "settlement.incomplete.coverage_gap",
  "settlement.incomplete.coverage_failed",
  "settlement.incomplete.warning_not_allowlisted",
  "settlement.incomplete.budget_exceeded",
  "settlement.incomplete.engine_error",

  // Publication
  "publish.identity_resolved",
  "publish.identity_unresolved",
  "publish.finding_published",
  "publish.finding_suppressed_duplicate",
  "publish.finding_rejected_sanitization",
  "publish.finding_rejected_placement",
  "publish.readback_failed",
  "publish.api_failed",
  "publish.incomplete_notice_published",
  "publish.abandoned_stale_head",

  // Configuration
  "config.invalid",
  "config.loaded",

  // Review-cache memoization (v0.9.0). None of these ever affect completeness — memoization is a
  // pure optimization layer, and its own failure gates only re-review cost, never coverage. See
  // `src/cache/review-cache.ts`'s doc comment for why replay is sound and why only a `complete`
  // settlement may write an entry.
  "cache.store_loaded",
  "cache.store_rejected",
  "cache.store_write_failed",
  "cache.hits",
  "cache.appended",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const REASON_CODE_SET: ReadonlySet<string> = new Set<string>(REASON_CODES);

export function isReasonCode(value: string): value is ReasonCode {
  return REASON_CODE_SET.has(value);
}

/**
 * Operator guidance per code family. Kept coarse on purpose: a precise remediation string would
 * drift from the code that emits it, and a stale runbook is worse than a general one.
 */
export const REASON_CODE_GUIDANCE: Readonly<Record<string, string>> = {
  eligibility: "The head was not reviewed by policy. No action unless the policy is wrong.",
  review_pair: "The base/head pair could not be resolved. Check that both commits are fetched.",
  inventory: "A changed path had no classification. Extend the review profile to cover it.",
  engine: "The engine could not be acquired or completed. Check the pin and the model endpoint.",
  settlement: "The review did not complete. Treat the pull request as unreviewed.",
  publish: "Findings could not be published. Check the App installation and its permissions.",
  config: "The supplied configuration was rejected. Compare it against the documented schema.",
  run: "Run lifecycle marker.",
  cache:
    "The review store could not be read or written, or a save was skipped. Coverage is unaffected; only re-review cost is.",
};
