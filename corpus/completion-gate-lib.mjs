// Pure logic for the completion gate (corpus/completion-gate.mjs).
//
// Why this exists, stated plainly because it is a correction of this repository's own blind spot.
//
// The seeded corpus asks "does the reviewer find a defect I planted?" and the consumer-seed gate
// asks the same question against real consumer files. Both are RECALL instruments, and both run
// on tiny diffs — one or two files, tens of thousands of tokens. On 2026-08-06 both were green
// while the reviewer was, in production, failing to finish nineteen-file reviews: Keiko#3011 ended
// `settlement.incomplete.engine_error` in CI after 1.76M tokens, and `incomplete.coverage_gap`
// locally after 1.63M. Neither gate could see it, because neither ever ran a review large enough
// to fail that way. Green was true and useless.
//
// So this gate asks a different question, and only this one: **does a review of a real, full-size
// pull request RUN TO COMPLETION?** Not whether it found anything — whether it finished.
//
// The measured quantity is a RATE, never a single verdict. That is not a stylistic choice. A
// re-run of Keiko#3011 minutes after the fix settled `complete` without the fix's own retry path
// firing at all: same input, same model, different engine behaviour. One green run proves the
// pipeline can complete, and nothing else. `incomplete-never-clean` remains correct — an engine
// that genuinely cannot finish a file SHOULD report incomplete — but a reviewer that reports
// incomplete nine times in ten is worthless regardless of how correct each label is. The rate is
// the product quality; the label is only its honesty.

/** The only report schema this gate understands — same wire contract the seed gate reads. */
export const LOCAL_REPORT_SCHEMA = "keiko-for-quality.local-report/v1";

/**
 * Outcomes this gate distinguishes. `measurement-failed` is deliberately NOT an incomplete: a
 * review that never produced a parseable report says nothing about the reviewer's completion
 * behaviour, and folding it into the rate would let a broken harness masquerade as a broken
 * product (or hide one).
 */
export const ATTEMPT_OUTCOMES = ["complete", "incomplete", "abandoned", "measurement-failed"];

/**
 * Grades one CLI report. Pure — the report is parsed `--format json` output. Throws on a schema
 * this gate does not understand, because grading an unknown wire format measures nothing.
 */
export function gradeAttempt(report) {
  if (report.schema !== LOCAL_REPORT_SCHEMA) {
    throw new Error(`unexpected report schema: ${String(report.schema)}`);
  }
  const outcome = report.settlement.outcome;
  return {
    outcome,
    // Present only for a non-complete outcome, and always a closed-vocabulary reason code — this
    // is what turns "the rate is bad" into "the rate is bad FOR THIS REASON", which is the only
    // form of the measurement anyone can act on.
    ...(report.settlement.reason === null ? {} : { reason: report.settlement.reason }),
    findings: report.findings.length,
    reviewable: report.inventory.reviewable,
    reviewed: report.inventory.reviewed,
    spendTotal: report.spend.total,
  };
}

/** The outcome for an attempt whose CLI run never yielded a gradeable report. */
export function measurementFailure(detail) {
  return {
    outcome: "measurement-failed",
    detail,
    findings: 0,
    reviewable: 0,
    reviewed: 0,
    spendTotal: 0,
  };
}

/**
 * Aggregates every attempt into the number this gate exists to produce.
 *
 * `completionRate` counts only attempts that actually measured something: measurement failures are
 * reported separately and never silently improve or worsen the rate. A run set with zero gradeable
 * attempts has no rate at all (`null`) rather than a misleading `0` or `1`.
 */
export function summarizeRuns(attempts, threshold) {
  const graded = attempts.filter((attempt) => attempt.outcome !== "measurement-failed");
  const complete = graded.filter((attempt) => attempt.outcome === "complete").length;
  const reasons = {};
  for (const attempt of graded) {
    if (attempt.outcome === "complete") continue;
    const key = attempt.reason ?? `${attempt.outcome}:unspecified`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  const completionRate = graded.length === 0 ? null : complete / graded.length;
  return {
    attempts: attempts.length,
    graded: graded.length,
    measurementFailures: attempts.length - graded.length,
    complete,
    completionRate,
    // Sorted by frequency: the top entry is where the next fix belongs, and an operator should not
    // have to sort a histogram by eye to find it.
    reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
    threshold,
    // A null rate never passes: "nothing was measured" is not evidence of health. Neither does a
    // rate below the threshold, however honest each individual incomplete was.
    green: completionRate !== null && completionRate >= threshold,
    spendTotal: attempts.reduce((sum, attempt) => sum + attempt.spendTotal, 0),
  };
}

/** Percentage with one decimal, or `n/a` when nothing was gradeable. */
function ratePercent(rate) {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

/**
 * Rough spend forecast, stated before a run rather than discovered after it. Deliberately a RANGE
 * anchored on measured runs (Keiko#3011: 1.09M-1.63M tokens for nineteen files across three
 * observed runs) scaled by file count — an estimate honest about being one, not a promise.
 */
export function estimateSpend(targets, runs) {
  const files = targets.reduce((sum, target) => sum + (target.files ?? 0), 0);
  const perFileLow = 57_000;
  const perFileHigh = 86_000;
  return { low: files * perFileLow * runs, high: files * perFileHigh * runs, files, runs };
}

/**
 * The evidence file — deliberately NOT shaped like `corpus/evidence/qualification-*.md`, which has
 * its own contract (corpus/evidence-shape.mjs) and answers a different question. A completion
 * measurement must never be mistakable for a qualification.
 */
export function renderEvidence({
  dateIso,
  gateVersion,
  reviewerTree,
  model,
  targets,
  results,
  summary,
}) {
  const lines = [
    `# Completion gate — ${dateIso}`,
    "",
    "Measures one thing only: how often a review of a real, full-size pull request RUNS TO",
    "COMPLETION. Not recall, not precision. See corpus/completion-gate-lib.mjs's header for why a",
    "rate, and not a single verdict, is the answerable form of this question.",
    "",
    `- Reviewer under test: keiko-for-quality ${gateVersion}`,
    `- Reviewer tree: ${reviewerTree}`,
    `- Model: ${model}`,
    `- Targets: ${targets.map((t) => `${t.label} (${String(t.files ?? 0)} files)`).join(", ")}`,
    `- **Completion rate: ${ratePercent(summary.completionRate)}** ` +
      `(${String(summary.complete)}/${String(summary.graded)} graded attempts, ` +
      `threshold ${ratePercent(summary.threshold)}) — ${summary.green ? "GREEN" : "RED"}`,
    `- Measurement failures (excluded from the rate): ${String(summary.measurementFailures)}`,
    `- Total spend (tokens): ${String(summary.spendTotal)}`,
    "",
  ];
  if (Object.keys(summary.reasons).length > 0) {
    lines.push("## Why the incomplete attempts were incomplete", "");
    for (const [reason, count] of Object.entries(summary.reasons)) {
      lines.push(`- ${reason}: ${String(count)}`);
    }
    lines.push(
      "",
      "Each of these is an honest label. The list is here to be shortened by fixes, not explained",
      "away: the top entry is where the next one belongs.",
      "",
    );
  }
  for (const result of results) {
    lines.push(`## ${result.label}`, "");
    result.attempts.forEach((attempt, index) => {
      const reason = attempt.reason === undefined ? "" : ` (${attempt.reason})`;
      const detail = attempt.detail === undefined ? "" : ` — ${attempt.detail}`;
      lines.push(
        `- Run ${String(index + 1)}: ${attempt.outcome}${reason}${detail}, ` +
          `reviewed ${String(attempt.reviewed)}/${String(attempt.reviewable)}, ` +
          `${String(attempt.findings)} finding(s), spend ${String(attempt.spendTotal)}`,
      );
    });
    lines.push("");
  }
  return lines.join("\n");
}
