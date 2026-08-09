import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HISTORICAL_REPLAY_EVIDENCE_ARTIFACT,
  validateHistoricalReplayEvidence,
} from "./historical-replay-evidence-lib.mjs";
import { productionHistoricalReplayEvidenceFixture } from "./historical-replay-evidence.test-fixture.mjs";

test("accepts the production-shaped 92/66 replay with 62 bound and attempted cases", () => {
  const evidence = productionHistoricalReplayEvidenceFixture();

  assert.equal(evidence.artifact, HISTORICAL_REPLAY_EVIDENCE_ARTIFACT);
  assert.equal(evidence.plan.populationRecords, 92);
  assert.equal(evidence.plan.corroboratedCases, 66);
  assert.equal(evidence.plan.locallyBoundCases, 62);
  assert.equal(evidence.execution.attemptedCases, 62);
  assert.equal(evidence.score.all.before.eligible, 66);
  assert.equal(evidence.score.chronological.training.before.eligible, 24);
  assert.equal(evidence.score.chronological.holdout.before.eligible, 42);
  assert.deepEqual(validateHistoricalReplayEvidence(evidence), { valid: true, failures: [] });
});

test("rejects the former metrics-only release fixture", () => {
  const oldFixture = {
    schemaVersion: 3,
    binding: { reviewerTree: "a".repeat(40), model: "gpt-oss-120b", protocol: "openai" },
    score: {
      all: {
        before: { metrics: { precision: 0.25 } },
        after: { metrics: { precision: 0.75, fixedRetention: 1, decisionCoverage: 1 } },
      },
      chronological: {
        holdout: {
          before: { metrics: { precision: 0.14 } },
          after: { metrics: { precision: 0.75, fixedRetention: 1, decisionCoverage: 1 } },
        },
      },
    },
  };

  assert.deepEqual(validateHistoricalReplayEvidence(oldFixture), {
    valid: false,
    failures: ["root_shape"],
  });
});

test("rejects digest, aggregate arithmetic, population-floor, and extra-field tampering", () => {
  const identity = productionHistoricalReplayEvidenceFixture();
  identity.artifact = "keiko-for-quality/raw-historical-replay";
  assert.ok(validateHistoricalReplayEvidence(identity).failures.includes("identity"));

  const digest = productionHistoricalReplayEvidenceFixture();
  digest.binding.sourceSha256.substantiation = "not-a-digest";
  assert.ok(validateHistoricalReplayEvidence(digest).failures.includes("binding_value"));

  const arithmetic = productionHistoricalReplayEvidenceFixture();
  arithmetic.score.all.after.confusionMatrix.truePositive -= 1;
  assert.ok(validateHistoricalReplayEvidence(arithmetic).failures.includes("score_arithmetic"));

  const planFloor = productionHistoricalReplayEvidenceFixture();
  planFloor.plan.locallyBoundCases = 61;
  planFloor.plan.structurallyUnmeasuredCases = 5;
  planFloor.plan.estimatedStartWorkTokens = 61 * 32_000;
  planFloor.plan.localUnmeasured.sourceUnavailable = 5;
  planFloor.budget.estimatedStartWorkTokens = 61 * 32_000;
  assert.ok(validateHistoricalReplayEvidence(planFloor).failures.includes("plan_population_floor"));

  const executionFloor = productionHistoricalReplayEvidenceFixture();
  executionFloor.execution.attemptedCases = 61;
  executionFloor.execution.estimatedAttemptedTokens = 61 * 32_000;
  assert.ok(
    validateHistoricalReplayEvidence(executionFloor).failures.includes(
      "execution_population_floor",
    ),
  );

  const zeroAccountedTokens = productionHistoricalReplayEvidenceFixture();
  zeroAccountedTokens.execution.accountedTokens = 0;
  assert.ok(
    validateHistoricalReplayEvidence(zeroAccountedTokens).failures.includes("execution_arithmetic"),
  );

  const wrongBoundary = productionHistoricalReplayEvidenceFixture();
  wrongBoundary.holdoutFromPullRequest = 3038;
  wrongBoundary.score.holdoutFromPullRequest = 3038;
  assert.ok(validateHistoricalReplayEvidence(wrongBoundary).failures.includes("holdout_boundary"));

  const cosmeticHoldout = productionHistoricalReplayEvidenceFixture();
  cosmeticHoldout.score.chronological.training.before.eligible = 65;
  cosmeticHoldout.score.chronological.holdout.before.eligible = 1;
  assert.ok(
    validateHistoricalReplayEvidence(cosmeticHoldout).failures.includes("score_population_binding"),
  );

  const wrongGroundTruth = productionHistoricalReplayEvidenceFixture();
  wrongGroundTruth.score.all.before.groundTruth.fixedConfirmed = 16;
  wrongGroundTruth.score.all.before.groundTruth.refutedConfirmed = 50;
  assert.ok(
    validateHistoricalReplayEvidence(wrongGroundTruth).failures.includes(
      "score_population_binding",
    ),
  );

  const extra = productionHistoricalReplayEvidenceFixture();
  extra.privateFindingBody = "must never cross the public evidence boundary";
  assert.deepEqual(validateHistoricalReplayEvidence(extra), {
    valid: false,
    failures: ["root_shape"],
  });
});
