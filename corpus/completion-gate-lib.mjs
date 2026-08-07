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
  const interval = wilsonInterval(complete, graded.length);
  const verdict = verdictFor(interval, threshold);
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
    ...(interval === undefined ? {} : { interval }),
    verdict,
    // Green is now the STATISTICAL claim, not the arithmetic one: the interval's lower bound must
    // clear the threshold. A point estimate that happens to sit above it on four draws is not
    // evidence the reviewer finishes reliably, and this gate refuses to call it one.
    green: verdict === "GREEN",
    spendTotal: attempts.reduce((sum, attempt) => sum + attempt.spendTotal, 0),
  };
}

/** `PR #3011 (19 files), PR #3008 (12 files)` — named apart from the template that uses it so no
 *  template nests inside another (Sonar S4624). */
function describeTargets(targets) {
  return targets.map((t) => `${t.label} (${String(t.files ?? 0)} files)`).join(", ");
}

/**
 * Size classes for stratifying the rate, in CHANGED LINES.
 *
 * A single aggregate rate over mixed pull requests is the cheapest way to mislead yourself here.
 * Kumar 2026 (arXiv:2606.15689) measured detection collapsing with diff size — F1 0.657 under ten
 * changed lines against 0.043 past a hundred and fifty — and completion is subject to the same
 * pressure for the same reason: more files and more lines mean more per-file conversations, each
 * of which can exhaust its tool rounds.
 *
 * This is diagnosis, not accounting. An aggregate of 50% over mixed sizes could mean the reviewer
 * fails half the time everywhere, or that it finishes every small change and no large one. Those
 * are different products and they need different fixes, and only the stratified rate tells them
 * apart. A stratum is never a substitute for measuring the size that matters: if large changes are
 * the ones that fail, the sample that decides the question has to be large changes.
 */
export const SIZE_CLASSES = [
  { key: "lines_lt_50", label: "<50 lines", max: 50 },
  { key: "lines_50_250", label: "50-250 lines", max: 250 },
  { key: "lines_250_1000", label: "250-1000 lines", max: 1000 },
  { key: "lines_gte_1000", label: ">=1000 lines", max: Number.POSITIVE_INFINITY },
];

/** The class a target falls into, by its changed-line count. */
export function sizeClassOf(changedLines) {
  return SIZE_CLASSES.find((c) => changedLines < c.max) ?? SIZE_CLASSES[SIZE_CLASSES.length - 1];
}

/**
 * The rate within each size class that actually has attempts, each with its own interval and
 * verdict — computed by exactly the same functions as the aggregate, so a stratum and the whole
 * are never judged by two different standards.
 */
export function stratify(results, threshold) {
  const byClass = new Map();
  for (const result of results) {
    const key = sizeClassOf(result.changedLines ?? 0).key;
    const bucket = byClass.get(key) ?? [];
    bucket.push(...result.attempts);
    byClass.set(key, bucket);
  }
  return SIZE_CLASSES.filter((c) => byClass.has(c.key)).map((c) => ({
    label: c.label,
    ...summarizeRuns(byClass.get(c.key) ?? [], threshold),
  }));
}

/**
 * Wilson score interval for a proportion, at 95%.
 *
 * The completion rate is a proportion measured on a handful of very expensive draws, and a bare
 * point estimate invites exactly the error this gate was built to prevent. On 2026-08-06 four
 * measurements read 25%, 50%, 50%, 50% and were reported as an improvement followed by a plateau.
 * Their intervals are [4.6%, 69.9%] and [15.0%, 85.0%]: they overlap almost entirely, and not one
 * of those comparisons was supported by its own data.
 *
 * Wilson rather than the textbook normal approximation because n here is single digits and the
 * proportion sits near the boundaries, which is precisely where the normal approximation produces
 * intervals running past 0 or 1.
 */
export function wilsonInterval(successes, total, z = 1.96) {
  if (total <= 0) return undefined;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/**
 * The verdict, with the sample's own precision folded in.
 *
 * Three states rather than two, because two cannot express the situation this gate is usually in.
 * `GREEN` means the interval's LOWER bound clears the threshold — the data supports the claim.
 * `RED` means its UPPER bound falls short — the data refutes it. `INCONCLUSIVE` means the interval
 * spans the threshold, which is not a soft red: it is the honest statement that this many runs
 * cannot decide the question either way, and the answer is more runs rather than a louder verdict.
 */
export function verdictFor(interval, threshold) {
  if (interval === undefined) return "INCONCLUSIVE";
  // Strictly greater, not `>=`. A bound that merely TOUCHES the threshold has not cleared it, and a
  // gate that calls a tie a pass is a gate that rounds in its own favour — the one direction this
  // instrument must never round. The tie is close to unreachable in practice (`low` comes out of a
  // square root, so exact equality with 0.8 is a float accident), which is precisely why it is
  // worth pinning: an unreachable branch is decided once, here, rather than discovered later by
  // whoever happens to hit it.
  if (interval.low > threshold) return "GREEN";
  if (interval.high < threshold) return "RED";
  return "INCONCLUSIVE";
}

/** The interval as a reader should see it: bounds and width, because the width is the part that
 *  says whether any comparison to another measurement is meaningful at all. */
function describeInterval(interval) {
  if (interval === undefined) return "n/a (nothing gradeable)";
  return (
    `[${ratePercent(interval.low)}, ${ratePercent(interval.high)}] ` +
    `(width ${ratePercent(interval.high - interval.low)})`
  );
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
  strata,
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
    `- Targets: ${describeTargets(targets)}`,
    `- **Completion rate: ${ratePercent(summary.completionRate)}** ` +
      `(${String(summary.complete)}/${String(summary.graded)} graded attempts) — ` +
      `**${summary.verdict}** against a ${ratePercent(summary.threshold)} threshold`,
    `- 95% interval: ${describeInterval(summary.interval)}`,
    ...(summary.verdict === "INCONCLUSIVE"
      ? [
          "- **This sample cannot decide the question.** The interval spans the threshold, so the",
          "  data neither supports nor refutes the bar. The answer is more runs, not a louder verdict.",
        ]
      : []),
    `- Measurement failures (excluded from the rate): ${String(summary.measurementFailures)}`,
    `- Total spend (tokens): ${String(summary.spendTotal)}`,
    "",
  ];
  if (strata !== undefined && strata.length > 1) {
    lines.push(
      "## Rate by change size",
      "",
      "A single aggregate over mixed pull requests hides the effect size matters most for. Each",
      "row is judged by the same standard as the whole.",
      "",
      "| size | rate | 95% interval | verdict |",
      "| --- | --- | --- | --- |",
    );
    for (const s of strata) {
      lines.push(
        `| ${s.label} | ${ratePercent(s.completionRate)} (${String(s.complete)}/${String(s.graded)}) ` +
          `| ${describeInterval(s.interval)} | ${s.verdict} |`,
      );
    }
    lines.push("");
  }
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
