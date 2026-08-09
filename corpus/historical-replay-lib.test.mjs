import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildHistoricalReplayReport,
  scoreHistoricalPopulation,
} from "./historical-replay-lib.mjs";

const RECORDS = [
  { pullRequest: 10, databaseId: 1, label: "fixed_confirmed" },
  { pullRequest: 10, databaseId: 2, label: "refuted_confirmed" },
  { pullRequest: 10, databaseId: 3, label: "fixed_unconfirmed" },
  { pullRequest: 20, databaseId: 4, label: "fixed_confirmed" },
  { pullRequest: 20, databaseId: 5, label: "refuted_confirmed" },
  { pullRequest: 20, databaseId: 6, label: "refuted_confirmed" },
];

const DECISIONS = [
  { databaseId: 1, decision: "keep" },
  { databaseId: 2, decision: "drop" },
  { databaseId: 3, decision: "keep" },
  { databaseId: 4, decision: "drop" },
  { databaseId: 5, decision: "keep" },
  { databaseId: 6, decision: "unmeasured" },
];

test("reports the before baseline and the candidate confusion matrix without hiding retention", () => {
  const { before, after } = scoreHistoricalPopulation(RECORDS, DECISIONS);

  assert.deepEqual(before.confusionMatrix, {
    truePositive: 2,
    falseNegative: 0,
    falsePositive: 3,
    trueNegative: 0,
  });
  assert.deepEqual(before.metrics, {
    precision: 2 / 5,
    fixedRetention: 1,
    falsePositiveRejection: 0,
    decisionCoverage: 1,
  });

  assert.deepEqual(after.confusionMatrix, {
    truePositive: 1,
    falseNegative: 1,
    falsePositive: 1,
    trueNegative: 1,
  });
  assert.deepEqual(after.unmeasured, {
    fixedConfirmed: 0,
    refutedConfirmed: 1,
    total: 1,
  });
  assert.deepEqual(after.metrics, {
    precision: 1 / 2,
    fixedRetention: 1 / 2,
    falsePositiveRejection: 1 / 3,
    decisionCoverage: 4 / 5,
  });
  assert.equal(after.excluded.byLabel.fixed_unconfirmed, 1);
  assert.equal(after.excluded.total, 1);
});

test("an unmeasured decision never becomes a favourable confusion-matrix cell", () => {
  const records = [
    { pullRequest: 1, databaseId: 1, label: "fixed_confirmed" },
    { pullRequest: 1, databaseId: 2, label: "refuted_confirmed" },
  ];
  const decisions = [
    { databaseId: 1, decision: "unmeasured" },
    { databaseId: 2, decision: "unmeasured" },
  ];
  const { after } = scoreHistoricalPopulation(records, decisions);
  assert.deepEqual(after.confusionMatrix, {
    truePositive: 0,
    falseNegative: 0,
    falsePositive: 0,
    trueNegative: 0,
  });
  assert.deepEqual(after.metrics, {
    precision: null,
    fixedRetention: 0,
    falsePositiveRejection: 0,
    decisionCoverage: 0,
  });
});

test("the chronological split reports training and untouched holdout separately", () => {
  const report = buildHistoricalReplayReport({
    records: RECORDS,
    decisions: DECISIONS,
    holdoutFromPullRequest: 20,
  });

  assert.equal(report.chronological.training.after.groundTruth.fixedConfirmed, 1);
  assert.equal(report.chronological.training.after.groundTruth.refutedConfirmed, 1);
  assert.deepEqual(report.chronological.training.after.metrics, {
    precision: 1,
    fixedRetention: 1,
    falsePositiveRejection: 1,
    decisionCoverage: 1,
  });
  assert.equal(report.chronological.holdout.after.groundTruth.fixedConfirmed, 1);
  assert.equal(report.chronological.holdout.after.groundTruth.refutedConfirmed, 2);
  assert.deepEqual(report.chronological.holdout.after.metrics, {
    precision: 0,
    fixedRetention: 0,
    falsePositiveRejection: 0,
    decisionCoverage: 2 / 3,
  });
});

function repeatedRecords(count, pullRequest, label, firstId) {
  return Array.from({ length: count }, (_, index) => ({
    pullRequest,
    databaseId: firstId + index,
    label,
  }));
}

test("pins the measured 25.8% baseline and its 14.3% chronological holdout without bodies", () => {
  const records = [
    ...repeatedRecords(9, 3031, "fixed_confirmed", 1),
    ...repeatedRecords(13, 3031, "refuted_confirmed", 100),
    ...repeatedRecords(2, 3032, "fixed_confirmed", 200),
    ...repeatedRecords(6, 3037, "fixed_confirmed", 300),
    ...repeatedRecords(30, 3037, "refuted_confirmed", 400),
    ...repeatedRecords(4, 3040, "refuted_confirmed", 500),
    ...repeatedRecords(2, 3041, "refuted_confirmed", 600),
  ];
  const decisions = records.map((record) => ({ databaseId: record.databaseId, decision: "keep" }));
  const report = buildHistoricalReplayReport({
    records,
    decisions,
    holdoutFromPullRequest: 3037,
  });

  assert.equal(report.all.before.groundTruth.fixedConfirmed, 17);
  assert.equal(report.all.before.groundTruth.refutedConfirmed, 49);
  assert.equal(report.all.before.metrics.precision, 17 / 66);
  assert.equal(report.chronological.training.before.groundTruth.fixedConfirmed, 11);
  assert.equal(report.chronological.training.before.groundTruth.refutedConfirmed, 13);
  assert.equal(report.chronological.holdout.before.groundTruth.fixedConfirmed, 6);
  assert.equal(report.chronological.holdout.before.groundTruth.refutedConfirmed, 36);
  assert.equal(report.chronological.holdout.before.metrics.precision, 6 / 42);
});

test("rejects malformed labels, decisions, duplicate ids, and incomplete joins", () => {
  assert.throws(
    () =>
      scoreHistoricalPopulation(
        [{ pullRequest: 1, databaseId: 1, label: "probably_fixed" }],
        [{ databaseId: 1, decision: "keep" }],
      ),
    /unknown historical replay label/,
  );
  assert.throws(
    () => scoreHistoricalPopulation(RECORDS, [{ databaseId: 1, decision: "maybe" }]),
    /unknown historical replay decision/,
  );
  assert.throws(
    () =>
      scoreHistoricalPopulation(
        [
          { pullRequest: 1, databaseId: 1, label: "fixed_confirmed" },
          { pullRequest: 2, databaseId: 1, label: "refuted_confirmed" },
        ],
        [],
      ),
    /duplicate historical replay databaseId/,
  );
  assert.throws(
    () => scoreHistoricalPopulation(RECORDS, DECISIONS.slice(0, -1)),
    /historical replay record has no decision: 6/,
  );
  assert.throws(
    () => scoreHistoricalPopulation(RECORDS, [...DECISIONS, { databaseId: 999, decision: "drop" }]),
    /historical replay decision has no record: 999/,
  );
});

test("refuses a chronological boundary whose training or holdout side has no evidence", () => {
  assert.throws(
    () =>
      buildHistoricalReplayReport({
        records: RECORDS,
        decisions: DECISIONS,
        holdoutFromPullRequest: 1,
      }),
    /training split has no corroborated examples/,
  );
  assert.throws(
    () =>
      buildHistoricalReplayReport({
        records: RECORDS,
        decisions: DECISIONS,
        holdoutFromPullRequest: 99,
      }),
    /holdout split has no corroborated examples/,
  );
});
