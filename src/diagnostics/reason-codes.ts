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
  // A settlement's `reason` is published in the incomplete notice, so it answers "why was my
  // change not fully reviewed" for a reader who has no access to the log. It must therefore name
  // a SETTLEMENT outcome. The two below replace codes borrowed from other families — an engine
  // diagnostic and a publication diagnostic — which described where the trouble was detected
  // rather than what it meant for coverage. Those codes keep their diagnostic role unchanged.
  // Counted mode has no manifest, so a run that fails there fails on the engine's own top-level
  // `status` field — not on a terminal state it never reported. `terminal_state` said the wrong
  // thing and, carrying no counts, told an operator nothing about how much went unreviewed.
  "settlement.incomplete.engine_status_not_success",
  "settlement.incomplete.schema_rejected",
  "settlement.incomplete.publication_degraded",

  // Publication
  "publish.identity_resolved",
  "publish.identity_unresolved",
  "publish.finding_published",
  "publish.finding_suppressed_duplicate",
  // Suppressed by the phrasing-independent similarity gate (Keiko-for-Quality#38) rather than an
  // exact marker match — kept distinct from the code above so an operator tuning the gate can tell
  // the two mechanisms apart.
  "publish.finding_suppressed_similar",
  "publish.finding_rejected_sanitization",
  "publish.finding_rejected_placement",
  "publish.readback_failed",
  "publish.api_failed",
  "publish.incomplete_notice_published",
  "publish.abandoned_stale_head",

  // Deduplication against a settled disposition (Keiko-for-Quality#64), distinct from the two
  // `publish.finding_suppressed_*` codes above: those suppress against a still-open conversation,
  // this one suppresses against a RESOLVED one whose last reply was a substantive disposition —
  // never a bare resolve, which must keep a genuinely recurred defect publishable (Keiko-for-
  // Quality#38's contract, unchanged). A separate top-level prefix rather than another
  // `publish.finding_suppressed_*` variant because the decision it reports on belongs to a
  // different question: not "is this the same finding" but "did someone already settle it."
  "dedup.dispositioned",

  // Run-summary comment (Keiko-for-Quality#31): a single, marker-identified issue comment this
  // reviewer upserts once per pull request, independent of every finding conversation above. Never
  // affects completeness — the same "pure add-on layer" posture as memoization below.
  "publish.summary_published",
  "publish.summary_updated",
  "publish.summary_upsert_failed",
  "publish.summary_disabled",

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
  // A content-key match a stored entry's own `prPathSetDigest` refused to replay because the pull
  // request's changed-file set moved since that entry was written (v0.10.0, issue #50). Distinct
  // from an ordinary content miss so production can tell the two apart.
  "cache.context_invalidated",
  "cache.appended",

  // Classification repair (v0.11.0). Emitted only when at least one finding arrived without a
  // usable category/severity pair and the constrained re-ask ran. `failed` on this record is the
  // honest residue: findings that stayed unclassified rather than being guessed at, and `tokens`
  // is what the repair itself spent, so the extra calls never hide inside the engine's own total.
  "classify.repaired",
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
  dedup:
    "A finding was suppressed against a settled disposition rather than published. No action " +
    "unless the disposition itself was wrong — reopen the original thread to contest it.",
  config: "The supplied configuration was rejected. Compare it against the documented schema.",
  run: "Run lifecycle marker.",
  cache:
    "The review store could not be read or written, or a save was skipped. Coverage is unaffected; only re-review cost is.",
};
