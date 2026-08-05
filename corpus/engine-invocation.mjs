/**
 * The two decisions `corpus/run.mjs` makes around every engine invocation, extracted as pure
 * functions so `node --test` can hold them without spawning the script (whose import runs the
 * harness — the same reason `rule-source.mjs` exists as its own module).
 *
 * Both exist for the budget-pressure precision cases (cycle 2 of the 2026-08-05 optimization
 * wave). Production produced its 18%-precision false positives under
 * `settlement.incomplete.budget_exceeded` across 38 files, while every single-file clean case
 * passes at full budget — so the corpus has to be able to reproduce the CONDITION, not just the
 * code. A case opts in by declaring `budgetTokens`; every case that does not is invoked with an
 * argv byte-identical to what this harness has always built, which is what keeps the recorded
 * measurement basis of the existing cases intact.
 */

/**
 * The argv for one engine invocation.
 *
 * Unbudgeted (no `budgetTokens`): exactly the historical argv, nothing appended. Budgeted: the
 * production budget flag (`--max-tokens-budget`, mirroring `reviewArguments` in
 * `src/engine/run.ts`) plus `--concurrency 1` — and the second flag is load-bearing, not a tidiness
 * choice. The engine checks its budget only between file dispatches; the v0.12.0 live telemetry
 * (corpus/evidence/live-telemetry-2026-08-04-v0.12.0-first-run.md) measured a 5-file run
 * dispatching everything at once, spending 998k against an 80k ceiling that consequently "governed
 * nothing". Sequential dispatch is what makes the budget bite between files, which is the entire
 * point of a pressure case.
 */
export function engineArguments(rulePath, budgetTokens = undefined) {
  const args = ["review", "--from", "HEAD~1", "--to", "HEAD", "--format", "json"];
  args.push("--rule", rulePath);
  if (budgetTokens !== undefined) {
    args.push("--max-tokens-budget", String(budgetTokens), "--concurrency", "1");
  }
  return args;
}

/**
 * Whether the harness's one status-triggered retry must be skipped for this result.
 *
 * Production never re-runs a budget-stopped attempt (`engine.resume_skipped_budget_exceeded`,
 * src/review.ts): the resume's budget could only be carved from what the first attempt left, and a
 * budget-stopped attempt left nothing. The harness retry fires on any `status !== "success"` —
 * which a budget stop is — so without this guard a budgeted case would run twice, spend its budget
 * twice, and grade only the second truncation.
 *
 * Gated on BOTH the case being budgeted and the engine reporting `budget_exceeded`, rather than on
 * the engine flag alone: the double gate makes the unchanged measurement basis of unbudgeted cases
 * provable from this file's own logic, instead of resting on the assumption that an unbudgeted
 * engine never sets the flag.
 */
export function skipRetryAfterBudgetStop(result, budgetTokens = undefined) {
  return budgetTokens !== undefined && result?.summary?.budget_exceeded === true;
}

/**
 * The engine facts a budget-pressure case needs recorded to be actionable: whether the stop
 * happened, how far the engine got, and — the open question cycle 3's fix decision turns on —
 * whether this engine release reports per-path coverage at all when it stops on budget
 * (`settle.ts` documents that no released engine emits a manifest; this measures instead of
 * assuming). Counts and path lists only, never finding content, matching the report's redaction
 * discipline.
 */
export function engineEvidence(result) {
  const coverage = result?.manifest?.coverage;
  const coverageLists =
    coverage === undefined || coverage === null
      ? null
      : {
          selected: (coverage.selected ?? []).length,
          completed: (coverage.completed ?? []).length,
          reused: (coverage.reused ?? []).length,
          failed: (coverage.failed ?? []).length,
          waived: (coverage.waived ?? []).length,
        };
  return {
    status: result?.status ?? null,
    budget_exceeded: result?.summary?.budget_exceeded === true,
    files_reviewed: result?.summary?.files_reviewed ?? null,
    total_tokens: result?.summary?.total_tokens ?? null,
    manifest_present: result?.manifest !== undefined && result?.manifest !== null,
    coverage: coverageLists,
  };
}
