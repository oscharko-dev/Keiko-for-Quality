import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE,
  HISTORICAL_REPLAY_EVIDENCE_ARTIFACT,
  validateHistoricalReplayEvidence,
} from "./historical-replay-evidence-lib.mjs";
import { productionHistoricalReplayEvidenceFixture } from "./historical-replay-evidence.test-fixture.mjs";

test("accepts the production-shaped 92/66 replay with 61 measurable and attempted cases", () => {
  const evidence = productionHistoricalReplayEvidenceFixture();

  assert.equal(evidence.artifact, HISTORICAL_REPLAY_EVIDENCE_ARTIFACT);
  assert.equal(evidence.plan.populationRecords, 92);
  assert.equal(evidence.plan.corroboratedCases, 66);
  assert.equal(evidence.plan.locallyBoundCases, 61);
  assert.equal(evidence.execution.attemptedCases, 61);
  assert.deepEqual(evidence.execution.stageCounters, {
    confirmed: 21,
    directProved: 0,
    truthRefuted: 30,
    falsifierDefeated: 6,
    droppedInsufficientEvidence: 4,
    retrievalRequested: 10,
    retrievalPerformed: 8,
    retrievalExpanded: 6,
    retrievalNoMatches: 2,
    retrievalFailed: 0,
    challengePlanned: 30,
    challengeRetrievalPerformed: 30,
    challengeExpanded: 28,
    challengeNoMatches: 2,
    challengeFailed: 0,
    undecided: 0,
    budgetBlocked: 0,
  });
  assert.equal(evidence.score.all.before.eligible, 66);
  assert.equal(evidence.score.chronological.training.before.eligible, 24);
  assert.equal(evidence.score.chronological.holdout.before.eligible, 42);
  assert.deepEqual(validateHistoricalReplayEvidence(evidence), { valid: true, failures: [] });
});

test("accepts confirmed findings whose independent challenge search found no counterevidence", () => {
  const evidence = productionHistoricalReplayEvidenceFixture();
  evidence.execution.stageCounters.challengeExpanded -= 2;
  evidence.execution.stageCounters.challengeNoMatches += 2;

  assert.deepEqual(validateHistoricalReplayEvidence(evidence), { valid: true, failures: [] });

  const noMatchWithoutConfirmation = productionHistoricalReplayEvidenceFixture();
  noMatchWithoutConfirmation.execution.stageCounters.challengeNoMatches =
    noMatchWithoutConfirmation.execution.stageCounters.confirmed + 1;
  noMatchWithoutConfirmation.execution.stageCounters.challengeExpanded =
    noMatchWithoutConfirmation.execution.stageCounters.challengePlanned -
    noMatchWithoutConfirmation.execution.stageCounters.challengeNoMatches;
  assert.ok(
    validateHistoricalReplayEvidence(noMatchWithoutConfirmation).failures.includes(
      "execution_stage_arithmetic",
    ),
  );
});

test("accounts for zero-call direct proofs outside the challenge path", () => {
  const evidence = productionHistoricalReplayEvidenceFixture();
  evidence.execution.stageCounters.directProved = 2;
  evidence.execution.stageCounters.challengePlanned -= 2;
  evidence.execution.stageCounters.challengeRetrievalPerformed -= 2;
  evidence.execution.stageCounters.challengeExpanded -= 2;

  assert.deepEqual(validateHistoricalReplayEvidence(evidence), { valid: true, failures: [] });

  evidence.execution.stageCounters.directProved = evidence.execution.stageCounters.confirmed + 1;
  assert.ok(
    validateHistoricalReplayEvidence(evidence).failures.includes("execution_stage_arithmetic"),
  );
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
  planFloor.plan.locallyBoundCases = 60;
  planFloor.plan.structurallyUnmeasuredCases = 6;
  planFloor.plan.estimatedAffordableCases = 60;
  planFloor.plan.estimatedCostExcessCases = 0;
  planFloor.plan.estimatedStartWorkTokens = 60 * HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE;
  planFloor.plan.estimatedMaximumEndpointRequests = 240;
  planFloor.plan.localUnmeasured.evidenceUnavailable = 2;
  planFloor.budget.estimatedStartWorkTokens = 60 * HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE;
  planFloor.budget.estimatedMaximumEndpointRequests = 240;
  assert.ok(validateHistoricalReplayEvidence(planFloor).failures.includes("plan_population_floor"));

  const executionFloor = productionHistoricalReplayEvidenceFixture();
  executionFloor.execution.attemptedCases = 60;
  executionFloor.execution.estimatedAttemptedTokens =
    60 * HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE;
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

  const stageTerminal = productionHistoricalReplayEvidenceFixture();
  stageTerminal.execution.stageCounters.truthRefuted -= 1;
  assert.ok(
    validateHistoricalReplayEvidence(stageTerminal).failures.includes("execution_stage_arithmetic"),
  );

  const stageRetrieval = productionHistoricalReplayEvidenceFixture();
  stageRetrieval.execution.stageCounters.retrievalFailed += 1;
  assert.ok(
    validateHistoricalReplayEvidence(stageRetrieval).failures.includes(
      "execution_stage_arithmetic",
    ),
  );

  const stageExtra = productionHistoricalReplayEvidenceFixture();
  stageExtra.execution.stageCounters.privateCaseIds = 1;
  assert.ok(validateHistoricalReplayEvidence(stageExtra).failures.includes("execution_shape"));

  const oldSchema = productionHistoricalReplayEvidenceFixture();
  oldSchema.schemaVersion = 4;
  assert.ok(validateHistoricalReplayEvidence(oldSchema).failures.includes("identity"));

  const missingStages = productionHistoricalReplayEvidenceFixture();
  delete missingStages.execution.stageCounters;
  assert.ok(validateHistoricalReplayEvidence(missingStages).failures.includes("execution_shape"));

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
