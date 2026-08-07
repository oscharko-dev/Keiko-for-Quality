import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_REPORT_SCHEMA,
  estimateSpend,
  gradeAttempt,
  measurementFailure,
  renderEvidence,
  sizeClassOf,
  stratify,
  summarizeRuns,
  verdictFor,
  wilsonInterval,
} from "./completion-gate-lib.mjs";

// Hermetic coverage for the completion gate's pure half. Zero model calls, zero git, zero
// filesystem — completion-gate.mjs itself spends more money per run than any other harness here
// and is never imported by a test, exactly as run.mjs and seed-gate.mjs are not.
//
// The invariant worth naming: a measurement failure must never move the completion rate. A harness
// that cannot run is not evidence that the product cannot finish, and folding the two together
// would let either one hide the other.

function reportWith({ outcome = "complete", reason = null, findings = 0, reviewed = 19 } = {}) {
  return {
    schema: LOCAL_REPORT_SCHEMA,
    settlement: { outcome, reason },
    findings: Array.from({ length: findings }, () => ({ path: "a.ts" })),
    spend: { engine: 1_000_000, classify: 5_000, total: 1_005_000, allotted: 2_000_000 },
    inventory: { total: 19, reviewable: 19, reviewed },
    ruleDigest: "d".repeat(64),
    engineVersion: "v1.8.4",
  };
}

test("gradeAttempt refuses an unknown report schema", () => {
  assert.throws(() => gradeAttempt({ schema: "other/v2" }), /unexpected report schema/);
});

test("gradeAttempt carries the reason only for a non-complete settlement", () => {
  assert.equal(gradeAttempt(reportWith()).reason, undefined);
  const incomplete = gradeAttempt(
    reportWith({
      outcome: "incomplete",
      reason: "settlement.incomplete.coverage_gap",
      reviewed: 17,
    }),
  );
  assert.equal(incomplete.outcome, "incomplete");
  assert.equal(incomplete.reason, "settlement.incomplete.coverage_gap");
  assert.equal(incomplete.reviewed, 17);
});

test("the completion rate counts complete over GRADED attempts only", () => {
  const summary = summarizeRuns(
    [
      gradeAttempt(reportWith()),
      gradeAttempt(reportWith()),
      gradeAttempt(
        reportWith({ outcome: "incomplete", reason: "settlement.incomplete.engine_error" }),
      ),
    ],
    0.5,
  );
  assert.equal(summary.graded, 3);
  assert.equal(summary.complete, 2);
  assert.ok(Math.abs(summary.completionRate - 2 / 3) < 1e-9);
  // The verdict is deliberately NOT asserted here: this test is about the arithmetic, and three
  // draws decide nothing either way (see the verdict tests below).
});

test("a measurement failure never moves the rate, in either direction", () => {
  const complete = gradeAttempt(reportWith());
  const broken = measurementFailure("worktree add failed");
  const withFailure = summarizeRuns([complete, broken], 0.9);
  // One complete attempt out of one GRADED attempt: the broken harness run is reported, not scored.
  assert.equal(withFailure.completionRate, 1);
  assert.equal(withFailure.graded, 1);
  assert.equal(withFailure.attempts, 2);
  assert.equal(withFailure.measurementFailures, 1);
});

test("a run set with nothing gradeable has no rate and never passes", () => {
  const summary = summarizeRuns([measurementFailure("x"), measurementFailure("y")], 0.01);
  assert.equal(summary.completionRate, null);
  assert.equal(summary.green, false);
});

test("reasons are histogrammed most-frequent first, so the next fix is the top line", () => {
  const gap = () =>
    gradeAttempt(
      reportWith({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
    );
  const err = () =>
    gradeAttempt(
      reportWith({ outcome: "incomplete", reason: "settlement.incomplete.engine_error" }),
    );
  const summary = summarizeRuns([gap(), err(), gap(), gap()], 0.8);
  assert.deepEqual(Object.keys(summary.reasons), [
    "settlement.incomplete.coverage_gap",
    "settlement.incomplete.engine_error",
  ]);
  assert.equal(summary.reasons["settlement.incomplete.coverage_gap"], 3);
  assert.equal(summary.green, false);
});

test("the threshold decides green, not the presence of any single failure", () => {
  const attempts = [
    gradeAttempt(reportWith()),
    gradeAttempt(reportWith()),
    gradeAttempt(reportWith()),
    gradeAttempt(reportWith()),
    gradeAttempt(
      reportWith({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
    ),
  ];
  // Five draws cannot support an 80% claim, and cannot refute it either — the honest verdict is
  // the same at both thresholds, and it is not "green because 4/5 rounds up".
  assert.equal(summarizeRuns(attempts, 0.8).verdict, "INCONCLUSIVE");
  assert.equal(summarizeRuns(attempts, 0.9).verdict, "INCONCLUSIVE");
  assert.equal(summarizeRuns(attempts, 0.9).green, false);
});

test("estimateSpend scales with files and runs", () => {
  const estimate = estimateSpend([{ files: 10 }, { files: 9 }], 2);
  assert.equal(estimate.files, 19);
  assert.equal(estimate.runs, 2);
  // Split, so a failure names WHICH half broke (Sonar S9073).
  assert.ok(estimate.low > 0);
  assert.ok(estimate.high > estimate.low);
});

test("renderEvidence leads with the rate and names every incomplete reason", () => {
  const attempts = [
    gradeAttempt(reportWith()),
    gradeAttempt(
      reportWith({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
    ),
  ];
  const summary = summarizeRuns(attempts, 0.9);
  const evidence = renderEvidence({
    dateIso: "2026-08-06",
    gateVersion: "0.19.2",
    reviewerTree: "abc123def456 (clean)",
    model: "gpt-oss-120b (openai)",
    targets: [{ label: "PR #3011", files: 19 }],
    results: [{ label: "PR #3011", attempts }],
    summary,
  });
  assert.match(evidence, /Completion rate: 50\.0%/);
  // Two draws against a 90% bar: not refuted, merely undecided.
  assert.match(evidence, /INCONCLUSIVE/);
  assert.match(evidence, /settlement\.incomplete\.coverage_gap: 1/);
  // Never mistakable for a qualification, which has its own shape contract.
  assert.doesNotMatch(evidence, /^# Qualification/m);
});

// Sample size, folded into the verdict. Added 2026-08-06 after four measurements were reported as
// 25% → 50% → 50% → 50%, an improvement followed by a plateau — a reading not one of them
// supported: their intervals are [4.6%, 69.9%] and [15.0%, 85.0%] and overlap almost entirely.
test("wilsonInterval widens as the sample shrinks, and never leaves [0, 1]", () => {
  const four = wilsonInterval(2, 4);
  const fifty = wilsonInterval(25, 50);
  assert.ok(four.high - four.low > fifty.high - fifty.low);
  for (const i of [wilsonInterval(0, 3), wilsonInterval(3, 3), four, fifty]) {
    assert.ok(i.low >= 0);
    assert.ok(i.high <= 1);
  }
  assert.equal(wilsonInterval(0, 0), undefined);
});

test("a four-run 50% is INCONCLUSIVE against an 80% bar, not RED", () => {
  // The exact shape of every completion measurement taken on 2026-08-06. Calling it RED claims the
  // data refutes the bar; it does not — the interval reaches 85%.
  const attempts = [
    gradeAttempt(reportWith()),
    gradeAttempt(reportWith()),
    gradeAttempt(
      reportWith({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
    ),
    gradeAttempt(
      reportWith({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
    ),
  ];
  const summary = summarizeRuns(attempts, 0.8);
  assert.equal(summary.completionRate, 0.5);
  assert.equal(summary.verdict, "INCONCLUSIVE");
  assert.equal(summary.green, false);
});

test("RED requires the data to REFUTE the bar, not merely to miss it", () => {
  // Twenty runs, four complete: the interval tops out well below 80%, so the bar is genuinely out
  // of reach rather than merely unproven.
  const attempts = [
    ...Array.from({ length: 4 }, () => gradeAttempt(reportWith())),
    ...Array.from({ length: 16 }, () =>
      gradeAttempt(
        reportWith({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
      ),
    ),
  ];
  assert.equal(summarizeRuns(attempts, 0.8).verdict, "RED");
});

test("GREEN requires the interval's LOWER bound to clear the bar", () => {
  const allComplete = (n) => Array.from({ length: n }, () => gradeAttempt(reportWith()));
  // Four perfect runs are not evidence of an 80% rate — the lower bound sits near 51%.
  assert.equal(summarizeRuns(allComplete(4), 0.8).verdict, "INCONCLUSIVE");
  // Enough perfect runs, and the claim is finally supported by its own data.
  assert.equal(summarizeRuns(allComplete(40), 0.8).verdict, "GREEN");
});

// The boundary the prose above leaves open: does a bound that TOUCHES the bar clear it? It does
// not. A gate that scores a tie as a pass rounds in its own favour, and this instrument exists to
// stop exactly that. Driven directly rather than through `summarizeRuns`, because the tie is a
// float accident no run count reproduces on purpose — which is why it is pinned here instead of
// left for whoever eventually lands on it.
test("a bound that merely touches the bar is not GREEN", () => {
  assert.equal(verdictFor({ low: 0.8, high: 0.95 }, 0.8), "INCONCLUSIVE");
  assert.equal(verdictFor({ low: 0.8000001, high: 0.95 }, 0.8), "GREEN");
  // The RED side is already strict and stays that way: an upper bound ON the bar has not refuted it.
  assert.equal(verdictFor({ low: 0.4, high: 0.8 }, 0.8), "INCONCLUSIVE");
});

test("the evidence says plainly when its own sample cannot decide", () => {
  const attempts = [
    gradeAttempt(reportWith()),
    gradeAttempt(
      reportWith({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
    ),
  ];
  const evidence = renderEvidence({
    dateIso: "2026-08-06",
    gateVersion: "0.19.2",
    reviewerTree: "abc123def456 (clean)",
    model: "gpt-oss-120b (openai)",
    targets: [{ label: "PR #3011", files: 19 }],
    results: [{ label: "PR #3011", attempts }],
    summary: summarizeRuns(attempts, 0.8),
  });
  assert.match(evidence, /INCONCLUSIVE/);
  assert.match(evidence, /95% interval/);
  assert.match(evidence, /cannot decide the question/);
});

test("the rate is reported per size class, so an aggregate cannot hide where it fails", () => {
  // Small changes all finish, large ones never do. The aggregate is 50% — a number that describes
  // neither half, and would send the next fix to the wrong place.
  const complete = () => gradeAttempt(reportWith());
  const gap = () =>
    gradeAttempt(
      reportWith({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
    );
  const results = [
    { label: "small", changedLines: 20, attempts: [complete(), complete()] },
    { label: "large", changedLines: 4000, attempts: [gap(), gap()] },
  ];
  const strata = stratify(results, 0.8);
  assert.equal(strata.length, 2);
  assert.equal(strata[0].label, "<50 lines");
  assert.equal(strata[0].completionRate, 1);
  assert.equal(strata[1].label, ">=1000 lines");
  assert.equal(strata[1].completionRate, 0);
});

test("a stratum is judged by exactly the standard the whole run is", () => {
  // Two flawless small runs are no more conclusive than two flawless runs anywhere else.
  const results = [
    {
      label: "small",
      changedLines: 10,
      attempts: [gradeAttempt(reportWith()), gradeAttempt(reportWith())],
    },
  ];
  assert.equal(stratify(results, 0.8)[0].verdict, "INCONCLUSIVE");
});

// `git diff --numstat` writes `-` for a binary file, so a target containing one has no measurable
// line count. Coercing that to 0 put it in the SMALLEST class — a change that may be enormous
// reported under "<50 lines", and every rate in that row then partly about something else.
test("a change whose size could not be measured joins no size class, and is counted out loud", () => {
  const attempt = () => gradeAttempt(reportWith());
  const strata = stratify(
    [
      { label: "measured", changedLines: 40, attempts: [attempt(), attempt()] },
      { label: "binary", changedLines: undefined, attempts: [attempt()] },
    ],
    0.8,
  );
  // The measured target is alone in its row: 2 graded, not 3.
  assert.equal(strata.length, 1);
  assert.equal(strata[0].graded, 2);
  assert.equal(strata.unstratifiable, 1);
});

// A row missing from a table reads as a row that was empty. It has to say so.
test("renderEvidence names the attempts that appear in no size row", () => {
  const attempt = () => gradeAttempt(reportWith());
  const results = [
    { label: "small", changedLines: 10, attempts: [attempt()] },
    { label: "large", changedLines: 9000, attempts: [attempt()] },
    { label: "binary", changedLines: undefined, attempts: [attempt()] },
  ];
  const attempts = results.flatMap((r) => r.attempts);
  const evidence = renderEvidence({
    dateIso: "2026-08-07",
    gateVersion: "0.19.2",
    reviewerTree: "abc123def456 (clean)",
    model: "gpt-oss-120b (openai)",
    targets: [{ label: "x", files: 1 }],
    results: [{ label: "x", attempts }],
    summary: summarizeRuns(attempts, 0.8),
    strata: stratify(results, 0.8),
  });
  assert.match(evidence, /1 attempt\(s\) appear in no size class/);
  assert.match(evidence, /binary files/);
});

// The first version of the message above lived inside the size table, which only renders with more
// than one row. So the two shapes where the dropped attempts matter MOST — a lone measurable target
// beside a binary one, and nothing measurable at all — printed no table and said nothing. Raised by
// CodeRabbit against the commit that added the message.
test("dropped attempts are named even when no size table is rendered", () => {
  const attempt = () => gradeAttempt(reportWith());
  const render = (results) =>
    renderEvidence({
      dateIso: "2026-08-07",
      gateVersion: "0.19.2",
      reviewerTree: "abc123def456 (clean)",
      model: "gpt-oss-120b (openai)",
      targets: [{ label: "x", files: 1 }],
      results: [{ label: "x", attempts: results.flatMap((r) => r.attempts) }],
      summary: summarizeRuns(
        results.flatMap((r) => r.attempts),
        0.8,
      ),
      strata: stratify(results, 0.8),
    });

  // One row: the table is suppressed, the note is not.
  const oneRow = render([
    { label: "small", changedLines: 10, attempts: [attempt()] },
    { label: "binary", changedLines: undefined, attempts: [attempt()] },
  ]);
  assert.doesNotMatch(oneRow, /## Rate by change size/);
  assert.match(oneRow, /1 attempt\(s\) appear in no size class/);

  // No rows at all: still said.
  const noRows = render([
    { label: "binary", changedLines: undefined, attempts: [attempt(), attempt()] },
  ]);
  assert.doesNotMatch(noRows, /## Rate by change size/);
  assert.match(noRows, /2 attempt\(s\) appear in no size class/);
});

// `verdictFor` says INCONCLUSIVE for a straddling interval AND for no interval at all. Only the
// first is about an interval; asserting it for the second states something untrue in an artefact
// whose entire job is not to.
test("a run with nothing graded says so, instead of claiming an interval spans the bar", () => {
  const evidence = renderEvidence({
    dateIso: "2026-08-07",
    gateVersion: "0.19.2",
    reviewerTree: "abc123def456 (clean)",
    model: "gpt-oss-120b (openai)",
    targets: [{ label: "x", files: 1 }],
    results: [{ label: "x", attempts: [measurementFailure("worktree add failed")] }],
    summary: summarizeRuns([measurementFailure("worktree add failed")], 0.8),
  });
  assert.match(evidence, /Nothing was graded/);
  assert.doesNotMatch(evidence, /interval spans the threshold/);
});

test("sizeClassOf places a change in exactly one class, at every boundary", () => {
  assert.equal(sizeClassOf(0).key, "lines_lt_50");
  assert.equal(sizeClassOf(49).key, "lines_lt_50");
  assert.equal(sizeClassOf(50).key, "lines_50_250");
  assert.equal(sizeClassOf(249).key, "lines_50_250");
  assert.equal(sizeClassOf(250).key, "lines_250_1000");
  assert.equal(sizeClassOf(999).key, "lines_250_1000");
  assert.equal(sizeClassOf(1000).key, "lines_gte_1000");
  assert.equal(sizeClassOf(500_000).key, "lines_gte_1000");
});
