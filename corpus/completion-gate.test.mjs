import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_REPORT_SCHEMA,
  estimateSpend,
  gradeAttempt,
  measurementFailure,
  renderEvidence,
  summarizeRuns,
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
  assert.equal(summary.green, true);
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
  assert.equal(withFailure.green, true);
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
  assert.equal(summarizeRuns(attempts, 0.8).green, true);
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
  assert.match(evidence, /RED/);
  assert.match(evidence, /settlement\.incomplete\.coverage_gap: 1/);
  // Never mistakable for a qualification, which has its own shape contract.
  assert.doesNotMatch(evidence, /^# Qualification/m);
});
