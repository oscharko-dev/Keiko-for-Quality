import { buildHistoricalReplayReport } from "./historical-replay-lib.mjs";
import { buildRedactedHistoricalReplayEvidence } from "./historical-replay.mjs";
import { HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE } from "./historical-replay-evidence-lib.mjs";

const HOLDOUT_FROM_PULL_REQUEST = 3037;
const CONFIGURED_MAX_TOKENS = 61_000_000;

function records(count, pullRequest, label, firstId) {
  return Array.from({ length: count }, (_, index) => ({
    pullRequest,
    databaseId: firstId + index,
    label,
  }));
}

function calibratedRecords() {
  return [
    ...records(9, 3031, "fixed_confirmed", 1),
    ...records(13, 3031, "refuted_confirmed", 100),
    ...records(2, 3032, "fixed_confirmed", 200),
    ...records(6, 3037, "fixed_confirmed", 300),
    ...records(30, 3037, "refuted_confirmed", 400),
    ...records(4, 3040, "refuted_confirmed", 500),
    ...records(2, 3041, "refuted_confirmed", 600),
    ...records(15, 3037, "refuted_contradicted", 700),
    ...records(11, 3037, "unanswered", 800),
  ];
}

function calibratedDecisions(sourceRecords) {
  let trainingFalsePositives = 2;
  let holdoutFalsePositives = 2;
  let holdoutUnmeasured = 5;
  return sourceRecords.map((record) => {
    let decision = "unmeasured";
    if (record.label === "fixed_confirmed") decision = "keep";
    if (record.label === "refuted_confirmed" && record.pullRequest < HOLDOUT_FROM_PULL_REQUEST) {
      decision = trainingFalsePositives > 0 ? "keep" : "drop";
      trainingFalsePositives -= 1;
    }
    if (record.label === "refuted_confirmed" && record.pullRequest >= HOLDOUT_FROM_PULL_REQUEST) {
      if (holdoutFalsePositives > 0) {
        decision = "keep";
        holdoutFalsePositives -= 1;
      } else if (holdoutUnmeasured > 0) {
        decision = "unmeasured";
        holdoutUnmeasured -= 1;
      } else {
        decision = "drop";
      }
    }
    return { databaseId: record.databaseId, decision };
  });
}

function reasonCounts(overrides = {}) {
  return {
    outsideCorroboratedPopulation: 0,
    missingHistoricalBinding: 0,
    invalidHistoricalBinding: 0,
    findingBodyUnavailable: 0,
    sourceUnavailable: 0,
    evidenceUnavailable: 0,
    budget: 0,
    verificationUndecided: 0,
    verificationError: 0,
    ...overrides,
  };
}

/** Production-shaped, aggregate-only v5 evidence over the calibrated 92/66 historical cohort. */
export function productionHistoricalReplayEvidenceFixture({ reviewerTree = "a".repeat(40) } = {}) {
  const sourceRecords = calibratedRecords();
  const decisions = calibratedDecisions(sourceRecords);
  const score = buildHistoricalReplayReport({
    records: sourceRecords,
    decisions,
    holdoutFromPullRequest: HOLDOUT_FROM_PULL_REQUEST,
  });
  const estimatedAffordableCases = Math.floor(
    CONFIGURED_MAX_TOKENS / HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE,
  );
  const plan = {
    populationRecords: 92,
    corroboratedCases: 66,
    locallyBoundCases: 61,
    structurallyUnmeasuredCases: 5,
    estimatedAffordableCases,
    estimatedCostExcessCases: 61 - estimatedAffordableCases,
    estimatedStartWorkTokens: 61 * HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE,
    configuredMaxTokens: CONFIGURED_MAX_TOKENS,
    estimatedMaximumEndpointRequests: estimatedAffordableCases * 4,
    localUnmeasured: reasonCounts({ invalidHistoricalBinding: 4, evidenceUnavailable: 1 }),
  };
  return buildRedactedHistoricalReplayEvidence({
    generatedAt: "2026-08-09T10:00:00.000Z",
    harvestSha256: "1".repeat(64),
    holdoutFromPullRequest: HOLDOUT_FROM_PULL_REQUEST,
    endpoint: "https://gateway.example.test/v1",
    implementation: {
      reviewerTree,
      sourceSha256: {
        driver: "2".repeat(64),
        scorer: "3".repeat(64),
        evidenceBuilder: "4".repeat(64),
        repositoryContext: "5".repeat(64),
        retrievedEvidence: "6".repeat(64),
        substantiation: "7".repeat(64),
      },
    },
    plan,
    execution: {
      populationRecords: 92,
      corroboratedCases: 66,
      attemptedCases: 61,
      estimatedAttemptedTokens: 61 * HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE,
      accountedTokens: 900_000,
      configuredMaxTokens: CONFIGURED_MAX_TOKENS,
      populationDecisions: { keep: 21, drop: 40, unmeasured: 31 },
      corroboratedDecisions: { keep: 21, drop: 40, unmeasured: 5 },
      stageCounters: {
        confirmed: 21,
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
      },
      unmeasuredByReason: reasonCounts({
        outsideCorroboratedPopulation: 26,
        invalidHistoricalBinding: 4,
        evidenceUnavailable: 1,
      }),
    },
    score,
  });
}
