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
  // Suppressed as a near-duplicate of another finding in the SAME run (v0.12.0) — the model
  // described one defect twice in one pass, which no cross-run stage can see because both
  // candidates arrive before either is published. Kept distinct from the two cross-run codes
  // above so an operator can tell "the model repeats itself within a run" from "a later run
  // repeated an earlier one": they call for different remedies.
  "publish.finding_suppressed_intra_run",
  // Suppressed as a restatement of a still-open conversation a push marked OUTDATED — the one
  // shape no other stage here can see, because an outdated thread's line anchor is stale and every
  // sibling stage matches on location. Its own code rather than reusing `_similar` because it is
  // the code that answers a specific operator question — "how much of this pull request's comment
  // volume is one defect re-filed across pushes" — and because it is the only cross-run stage that
  // decided without a location, which is exactly what someone auditing a false suppression needs to
  // know first.
  "publish.finding_suppressed_outdated_recurrence",
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
  // Classification self-audit (v0.11.0): every classified finding re-derives category/severity
  // from its own text through the written ladder, because the measured miscalibration on
  // open-weight models roams between cases rather than sitting still. `changed` counts adopted
  // moves in either direction; the audit never invents and never touches unclassified findings.
  "classify.audited",

  // Bounded resume (#57, v0.11.0): the engine run ended without a usable success — a thrown run
  // error or a non-success status — and was re-invoked exactly once. Emitted at most once per
  // review; "incomplete never reads as clean" survives the resume regardless of which of the two
  // outcomes below follows it.
  "engine.resumed_once",
  // The resumed attempt ITSELF threw (v0.13.0) — a second timeout, spawn failure, or nonzero exit,
  // the same failure classes the resume exists to recover from, recurring on attempt two. Falls
  // back to the first attempt's own result (its status, coverage, and findings) rather than losing
  // every fact that attempt established: `settle()` still gets real data to judge, even though the
  // run is very likely to settle incomplete on it. `counts.spent` is the first attempt's own token
  // total — the only spend this outcome has anything measured to report.
  "engine.resume_failed",

  // The resume that deliberately did NOT happen (v0.12.0): the first attempt reported its budget
  // exhausted, and a second attempt cannot review more of a change than the budget allows — it can
  // only re-pay for what the first one already did and settle incomplete anyway. Recorded rather
  // than left silent because "no resume line in the log" would otherwise be indistinguishable
  // between a run that never needed one and a run that was denied one.
  "engine.resume_skipped_budget_exceeded",

  // Run-level spend accounting (v0.12.0): one record per engine execution naming what the review
  // actually cost — the engine's own reported total plus the classification side-calls. The parts
  // stay separate because they answer different questions (engine behaviour vs. adapter-added
  // calls), and `total` exists so the summary comment can state real spend instead of whichever
  // `counts.tokens` record happened to drain last — the defect that made the published "reported"
  // figure the classification audit's bill rather than the review's.
  "run.spend",

  // Classification audit skipped because the run's remaining allotment could not cover it
  // (v0.12.0). The audit is an add-on opinion, not a publication requirement — when the budget is
  // nearly spent, the honest move is to publish with the classification the engine and the repair
  // already produced and say the audit was skipped, not to overdraw the ceiling the consumer set.
  "classify.skipped_budget",

  // Cross-artifact review surface (v0.12.0, issue #80). `contracts.gate` is the deterministic
  // declared-pair shape check: counts only, no model involved, so a fired gate is a fact about two
  // declarations rather than an opinion. `contracts.change_pass` is the flag-gated one-call
  // change-level pass; its counts carry findings kept, tokens spent, and whether the remaining
  // allotment forced a skip — the same budget honesty the classification audit reports.
  "contracts.gate",
  "contracts.change_pass",

  // Loopback-proxy usage telemetry (v0.12.0): request and token counts as observed on the wire,
  // independent of the engine's self-report. `cached` carries the provider-reported cached prompt
  // tokens — the number that decides whether prefix caching is working at all, which no other
  // layer can see. Counts only, like every other record: the proxy never quotes what it forwards.
  "model.usage",

  // Superseded-notice cleanup: this reviewer's own past incomplete-review notices, resolved because
  // a later push moved the hunk they anchored (`github/client.ts`'s `resolveSupersededOwnNotices`).
  // Never affects completeness — a resolved GitHub thread is not a claim about review coverage, only
  // about whether an operator still has to look at it. Recorded only when `resolved > 0`, the same
  // "only when something happened" posture `run.spend` takes.
  "cleanup.superseded_notices_resolved",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const REASON_CODE_SET: ReadonlySet<string> = new Set<string>(REASON_CODES);

export function isReasonCode(value: string): value is ReasonCode {
  return REASON_CODE_SET.has(value);
}
