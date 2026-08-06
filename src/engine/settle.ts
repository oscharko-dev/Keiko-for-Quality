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
      /**
       * The paths the engine reports it actually reviewed on this run.
       *
       * Present so a caller can tell "not reviewed yet" from "reviewed, and the run fell short
       * elsewhere". A budget-truncated run has real verdicts for the files it reached; without
       * this set the only safe assumption is that none of them are trustworthy, which is what
       * made a large pull request re-price every file on every push and never converge
       * (Keiko-for-Quality#75).
       *
       * Empty whenever the manifest could not be read — a rejected schema leaves no coverage data
       * to believe, and an empty set denies memoization rather than guessing.
       */
      readonly coveredPaths: ReadonlySet<string>;
    };

function incomplete(
  mode: SettlementMode,
  reason: ReasonCode,
  findings: readonly EngineFinding[],
  counts: Record<string, number> = {},
  covered: ReadonlySet<string> = NO_COVERED_PATHS,
): Settlement {
  return { status: "incomplete", mode, reason, counts, findings, coveredPaths: covered };
}

/**
 * The safe default: no path is known to have been reviewed.
 *
 * Every incomplete settlement that does not deliberately pass a covered set gets this, so adding
 * a new incomplete branch can only ever deny memoization, never grant it by omission.
 */
const NO_COVERED_PATHS: ReadonlySet<string> = new Set();

/**
 * Whether an incompleteness leaves the verdicts for reviewed files intact.
 *
 * Two different facts wear the same "incomplete" label. A budget overrun or a coverage gap means
 * the engine did not reach every file — but what it did reach, it judged properly, and discarding
 * those verdicts costs the whole review again on the next push. A rejected schema, a bad terminal
 * state, an implausible finding count, or a failed coverage entry mean the manifest itself is not
 * to be believed, so nothing it says about any file may be replayed later with confidence it
 * never earned.
 *
 * `publication_degraded` (v0.13.0) is not produced by this module — `review.ts`'s own
 * `reportDegradedPublication` constructs it directly — but this function is the one shared
 * authority every caller (`review.ts`, `action/main.ts`, `cli.ts`) consults for the identical
 * question, regardless of which subsystem raised the reason, so it belongs here rather than as a
 * one-off condition at each call site. It survives for the strongest possible version of this
 * function's own rule: the ENGINE's verdict was `complete` — every reviewable path was reached and
 * judged — and only the DELIVERY of that verdict to GitHub had a hiccup on one finding. Nothing
 * about the engine's own coverage is in question, which a budget overrun or a coverage gap cannot
 * claim; discarding those verdicts would cost the whole review again on a retry over a failure that
 * was never the engine's to begin with.
 *
 * The distinction lives here, once, rather than as a condition at each call site: a new reason
 * code is denied by default and has to be argued into this list.
 */
export function verdictsSurviveIncompleteness(reason: ReasonCode): boolean {
  return (
    reason === "settlement.incomplete.budget_exceeded" ||
    reason === "settlement.incomplete.coverage_gap" ||
    reason === "settlement.incomplete.publication_degraded"
  );
}

/**
 * The engine statuses that mean "this run FINISHED and its result is to be believed".
 *
 * `completed_with_warnings` and `completed_with_errors` (v1.8.4 `output.go`) are not failure
 * states: the run dispatched everything, collected its comments, and wrote a well-formed result —
 * the caveats live in `warnings`, each one typed and usually naming its file. Reading either as
 * "engine broke" is the exact defect class the budget hoist above this was built for: eight runs
 * on oscharko-dev/Keiko#3002 finished `completed_with_errors` (verified by re-running the same
 * diff against the same engine and provider, 2026-08-06), and every one settled
 * `engine_status_not_success`, discarded its findings, and re-paid the whole review next push.
 *
 * `budget_exceeded` is deliberately NOT here: it arrives with `summary.budget_exceeded` set, so
 * `budgetDisqualifier` already owns it before any status check runs — listing it would claim an
 * authority this branch never exercises.
 */
const FINISHED_STATUSES: ReadonlySet<string> = new Set<string>([
  "success",
  "completed_with_warnings",
  "completed_with_errors",
]);

/**
 * Warning types whose `file` names a path the engine dispatched but did not properly review.
 *
 * From the pinned release's own emission sites (`internal/agent/agent.go`, `internal/scan/agent.go`):
 * `subtask_error` / `scan_subtask_error` are a per-file review that errored or panicked;
 * `token_threshold_exceeded` is a file whose assembled prompt was refused before the first model
 * call. All three leave the file inside `files_reviewed` — that counter counts dispatch, not
 * completion — so the count-based gap check below can never see them. The warning's `file` field
 * is the only identity the engine offers for them, and identity beats cardinality: it lets the
 * settlement say WHICH files the next run still owes, not merely how many.
 *
 * `token_budget_reached` is deliberately absent: it belongs to the budget family, which
 * `budgetDisqualifier` already settles via `summary.budget_exceeded`. If it ever arrived without
 * that flag, `unlistedWarnings` would still fail the run closed rather than letting it pass.
 */
const SUBTASK_FAILURE_WARNING_TYPES: ReadonlySet<string> = new Set<string>([
  "subtask_error",
  "scan_subtask_error",
  "token_threshold_exceeded",
]);

/**
 * The paths the engine's own warnings disown — dispatched, counted, but not properly reviewed.
 *
 * A warning of a failure type without a `file` contributes nothing here; it stays visible to
 * `unlistedWarnings`, which fails the run closed on anything it cannot attribute.
 */
function engineFailurePaths(result: EngineResult): ReadonlySet<string> {
  const failed = new Set<string>();
  for (const warning of result.warnings) {
    if (SUBTASK_FAILURE_WARNING_TYPES.has(warning.type) && warning.file !== "") {
      failed.add(warning.file);
    }
  }
  return failed;
}

/** Paths the engine claims it actually reviewed, or safely reused a prior review for. */
function coveredPaths(result: EngineResult): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const entry of result.coverage.completed) covered.add(entry.path);
  for (const entry of result.coverage.reused) covered.add(entry.path);
  return covered;
}

/**
 * The paths a truncated run's verdicts may be memoized for — `coveredPaths` widened by the one
 * coverage fact a manifest-less engine still proves.
 *
 * `coveredPaths` reads the run manifest and nothing else, and no published engine release emits a
 * manifest (this module's own header says so). So on the engine this product actually pins, that
 * set is ALWAYS empty, and the truncation persistence built for Keiko-for-Quality#75 — "a
 * budget-truncated run keeps the verdicts it earned so the next push pays only for the tail" — has
 * never once written an entry in production. Measured on oscharko-dev/Keiko#2981: thirteen
 * consecutive runs, every one truncated, every one storing nothing, every one re-pricing all 37
 * files from zero. The mechanism was not wrong; it was unreachable.
 *
 * A finding is the missing evidence. The engine cannot report a defect at `path` without having
 * opened `path`, so every path named by a surviving finding was demonstrably reviewed — an
 * identity, not a count, which is exactly what `coveredPaths` could not supply here. A path the
 * manifest explicitly `failed` is excluded even when it carries a finding: a file whose review
 * fell over partway may have produced one finding and missed three, and freezing that as its
 * verdict is the laundering `review-cache.ts` warns about. When there is no manifest there is no
 * failed list either, so nothing is subtracted and the finding paths stand alone.
 *
 * Deliberately NOT used by `findCoverageGap`, which asks a different question: whether the engine
 * covered everything the inventory says changed. A finding proves one file was opened; it proves
 * nothing about the files that produced none, and crediting it there would shrink the gap this
 * adapter exists to detect.
 */
function memoizablePaths(result: EngineResult): ReadonlySet<string> {
  const covered = new Set(coveredPaths(result));
  const failed = new Set(result.coverage.failed.map((entry) => entry.path));
  // The same laundering rule, fed from the second failure source (2026-08-06): a path a
  // subtask-failure warning names is a review that fell over partway, whether the manifest exists
  // to say so or not. On the manifest-less pinned release the warnings are the ONLY failed-list
  // there is, so without this line a finding produced moments before its file's loop died would
  // freeze as that file's verdict.
  for (const path of engineFailurePaths(result)) failed.add(path);
  for (const finding of result.findings) {
    const path = finding.path as string;
    if (!failed.has(path)) covered.add(path);
  }
  return covered;
}

/**
 * The engine's own budget stop, checked ahead of every terminal-state and status check on both
 * settlement paths.
 *
 * A budget stop does not present as a budget stop. `--max-tokens-budget` makes the engine stop
 * dispatching new files and then exit non-`success` with `summary.budget_exceeded: true`, so a run
 * that hit its ceiling reports BOTH facts at once — and whichever check runs first is the reason
 * the pull request is told. That ordering used to put the generic one first, and the cost was not
 * cosmetic:
 *
 * - The published notice named `settlement.incomplete.engine_status_not_success`, which says only
 *   "the engine did not say success". Every incomplete run on oscharko-dev/Keiko#2970 and #2981 —
 *   twenty in one day, not one clean settlement between them — carried that code, and it told
 *   nobody the runs were dying against a ceiling the consumer could simply raise.
 * - `verdictsSurviveIncompleteness` denies memoization for that code, and rightly: a bad terminal
 *   state means the manifest is not to be believed. But a budget stop is the one incompleteness
 *   whose verdicts DO survive, so the misclassification also discarded every verdict the run had
 *   already paid for — turning each truncated run into a total loss, and each following push into
 *   a full re-payment that truncated in the same place.
 *
 * Checked before the status and terminal-state branches because it explains them; checked after
 * `settleReconciled`'s schema branch because an unrecognised manifest schema means the coverage
 * this carries is not readable either. It leaves `commonDisqualifier`'s own ordering untouched:
 * an unlisted warning and a finding flood are not caused by a budget stop, so their precedence on
 * the success path is unchanged.
 */
function budgetDisqualifier(
  mode: SettlementMode,
  result: EngineResult,
  config: RuntimeConfig,
): Settlement | undefined {
  if (!result.budgetExceeded && result.totalTokens <= config.tokenBudget) return undefined;
  return incomplete(
    mode,
    "settlement.incomplete.budget_exceeded",
    result.findings,
    { tokens: result.totalTokens },
    memoizablePaths(result),
  );
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
  const overBudget = budgetDisqualifier(mode, result, config);
  if (overBudget !== undefined) return overBudget;
  // A result carrying more findings than the consumer believes plausible is more likely a
  // misconfigured model or a prompt-injection success than a genuinely terrible change.
  if (result.findings.length > config.maxFindings) {
    // Deliberately carries NO findings, unlike every other incomplete branch: this branch's whole
    // claim is that a flood past the consumer's ceiling is a misconfigured model or a successful
    // prompt injection rather than a genuinely terrible change — publishing the flood anyway would
    // act on the very output just declared implausible, at two API calls per finding. The count in
    // `counts` still tells the operator how large the flood was.
    return incomplete(mode, "settlement.incomplete.engine_error", [], {
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
    // what it meant for coverage. The borrowed diagnostic was retired rather than kept: an audit
    // (2026-08-04) found no code path had ever emitted it under its own name — this branch was its
    // only real source, and this branch had already moved to the settlement code above. This
    // branch itself is dormant until an engine ships a manifest it can reach, which is exactly why
    // the unused diagnostic went unnoticed for as long as it did — the same taxonomy break as #57,
    // one family over.
    return incomplete("reconciled", "settlement.incomplete.schema_rejected", []);
  }
  // Before the terminal-state branch below, which a budget stop is a cause of — see
  // `budgetDisqualifier`. After the schema branch above, which decides whether the coverage this
  // would carry is readable at all.
  const overBudget = budgetDisqualifier("reconciled", result, config);
  if (overBudget !== undefined) return overBudget;
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
    return incomplete(
      "reconciled",
      "settlement.incomplete.coverage_gap",
      result.findings,
      { gap, reviewable: inventory.reviewablePaths.size },
      memoizablePaths(result),
    );
  }
  return (
    commonDisqualifier("reconciled", result, profile, config) ?? {
      status: "complete",
      mode: "reconciled",
      findings: result.findings,
    }
  );
}

/** Reviewable paths the engine is expected to dispatch: everything a cache hit did not answer. */
function unreviewedByEngine(inventory: Inventory, memoizedPaths: ReadonlySet<string>): number {
  return Math.max(0, inventory.reviewablePaths.size - memoizedPaths.size);
}

/**
 * The status check of the counted path, for statuses that mean the run itself is not to be
 * believed.
 *
 * Named for the field that actually failed: counted mode has no manifest, so there is no terminal
 * state to report and the old code said something the run never claimed. The counts are the
 * load-bearing half — a bare reason told an operator that the review was incomplete and nothing
 * whatever about how much of it was missing, which is the difference between "one file failed on
 * a large change" and "nothing was reviewed at all".
 *
 * Reached only by `failed`, `skipped`, and `unknown` (2026-08-06) — a status the pinned release
 * cannot say on stdout, a run that claims it had nothing to do while the inventory says otherwise
 * (the all-memoized case already settled in `settle()` before this), or a value this adapter has
 * never seen. For those, nothing the result carries is worth believing, which is why this branch
 * still forfeits verdicts while the finished statuses (`FINISHED_STATUSES`) keep them.
 */
function statusDisqualifier(result: EngineResult, expected: number): Settlement | undefined {
  if (FINISHED_STATUSES.has(result.status)) return undefined;
  return incomplete("counted", "settlement.incomplete.engine_status_not_success", result.findings, {
    reviewed: result.filesReviewed,
    expected,
  });
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
  const expected = unreviewedByEngine(inventory, memoizedPaths);
  // Before the status branch below rather than after it: `--max-tokens-budget` makes the engine
  // exit non-success, so the status check would otherwise claim every budget stop as its own and
  // report the symptom instead of the cause. See `budgetDisqualifier` for what that cost in
  // production.
  const overBudget = budgetDisqualifier("counted", result, config);
  if (overBudget !== undefined) return overBudget;
  const notFinished = statusDisqualifier(result, expected);
  if (notFinished !== undefined) return notFinished;
  // A finished run's own confession, checked before the count comparison because these paths are
  // invisible to it: `files_reviewed` counts dispatch, and every warning-named failure was
  // dispatched. Settled as a coverage gap — which it literally is — rather than as an engine
  // failure, so the verdicts for every OTHER file survive (`verdictsSurviveIncompleteness`), the
  // store keeps what this run paid for, and the notice can name how much is actually missing.
  // Eight runs on Keiko#3002 settled `engine_status_not_success` for want of this branch, each
  // discarding a finished review over (in the verified re-run) five files out of 33.
  const failedPaths = engineFailurePaths(result);
  if (failedPaths.size > 0) {
    return incomplete(
      "counted",
      "settlement.incomplete.coverage_gap",
      result.findings,
      {
        gap: failedPaths.size,
        reviewable: expected,
        reviewed: Math.max(0, result.filesReviewed - failedPaths.size),
      },
      memoizablePaths(result),
    );
  }
  if (result.filesReviewed < expected) {
    // `memoizablePaths`, not the empty default (2026-08-06): a count shortfall says nothing about
    // WHICH file is missing, but a finding still proves its own file was opened — the identical
    // evidence bar `budgetDisqualifier` already memoizes under. Withholding it here made every
    // count-gapped run re-pay even the files it demonstrably finished.
    return incomplete(
      "counted",
      "settlement.incomplete.coverage_gap",
      result.findings,
      {
        gap: expected - result.filesReviewed,
        reviewable: expected,
        reviewed: result.filesReviewed,
      },
      memoizablePaths(result),
    );
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
  // Memoization answering EVERY reviewable path is the success case, and it used to settle
  // incomplete. Observed in production on oscharko-dev/Keiko#2962: two reviewable files, two cache
  // hits, zero misses — the engine was handed nothing to dispatch, reported `skipped` as it should,
  // and the status check below read that as a failed run. The pull request then received a
  // blocking "this change was not fully reviewed" notice for a change that was, in fact, fully
  // answered. The better the store worked, the more often the reviewer called itself broken.
  //
  // With nothing dispatched, the engine's own account says nothing about this change's coverage:
  // every reviewable path is covered by a replayed verdict by construction. The disqualifiers
  // still apply — a warning or an implausible finding count is about the run, not about dispatch.
  if (unreviewedByEngine(inventory, memoizedPaths) === 0) {
    const mode: SettlementMode = result.manifestPresent ? "reconciled" : "counted";
    return (
      commonDisqualifier(mode, result, profile, config) ?? {
        status: "complete",
        mode,
        findings: result.findings,
      }
    );
  }
  return result.manifestPresent
    ? settleReconciled(inventory, result, profile, config, memoizedPaths)
    : settleCounted(inventory, result, profile, config, memoizedPaths);
}
