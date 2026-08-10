// Strict validation for the public, aggregate-only historical replay evidence.
//
// The paid driver owns measurement. This module owns the release boundary: it accepts exactly the
// schema emitted by `buildRedactedHistoricalReplayEvidence`, proves its aggregate arithmetic, and
// refuses a report too small to represent the calibrated historical population. It contains no
// model call, git operation, file access, finding prose, or permissive repair path.

const ROOT_KEYS = [
  "artifact",
  "binding",
  "budget",
  "execution",
  "generatedAt",
  "holdoutFromPullRequest",
  "plan",
  "schemaVersion",
  "scope",
  "score",
];
const SCOPE = {
  measuredStage:
    "post-generation-truth-deterministic-contract-challenge-falsifier-referee-closed-runtime-fact-workflow",
  historicalHeadSource: "immutable GitHub originalCommit for the review comment",
  historicalBaseSource:
    "unique merge-base of harvested current target ref and original review commit",
  historicalDiffSource:
    "exact single-change unified diff from derived merge-base to immutable originalCommit",
  repositoryContextSource:
    "bounded exact originalCommit and derived-merge-base trees with optional truth retrieval, mandatory deterministic contract challenge retrieval, and closed catalog runtime facts from exact anchored syntax in bounded immutable blobs",
  verificationWorkflow:
    "truth judge, optional truth retrieval and rerun, mandatory deterministic independent contract challenge, adversarial falsifier, reduced independent referee, optional closed runtime fact detector",
  pullRequestEventBase: "not available in harvest; not measured",
  candidateGeneration: "not measured",
  classificationAndPrWideRanking: "not measured",
  endToEndRecall: "not measured",
};
const BINDING_KEYS = [
  "endpointSha256",
  "harvestSha256",
  "model",
  "protocol",
  "reviewerTree",
  "sourceSha256",
  "strictness",
];
const SOURCE_DIGEST_KEYS = [
  "driver",
  "evidenceBuilder",
  "repositoryContext",
  "retrievedEvidence",
  "scorer",
  "substantiation",
];
const BUDGET_KEYS = [
  "configuredMaxTokens",
  "estimatedMaximumEndpointRequests",
  "estimatedStartWorkTokens",
  "estimatedTokensPerCase",
];
const PLAN_KEYS = [
  "configuredMaxTokens",
  "corroboratedCases",
  "estimatedAffordableCases",
  "estimatedCostExcessCases",
  "estimatedMaximumEndpointRequests",
  "estimatedStartWorkTokens",
  "localUnmeasured",
  "locallyBoundCases",
  "populationRecords",
  "structurallyUnmeasuredCases",
];
const EXECUTION_KEYS = [
  "accountedTokens",
  "attemptedCases",
  "configuredMaxTokens",
  "corroboratedCases",
  "corroboratedDecisions",
  "estimatedAttemptedTokens",
  "populationDecisions",
  "populationRecords",
  "stageCounters",
  "unmeasuredByReason",
];
const REASON_KEYS = [
  "budget",
  "evidenceUnavailable",
  "findingBodyUnavailable",
  "invalidHistoricalBinding",
  "missingHistoricalBinding",
  "outsideCorroboratedPopulation",
  "sourceUnavailable",
  "verificationError",
  "verificationUndecided",
];
const DECISION_KEYS = ["drop", "keep", "unmeasured"];
const STAGE_COUNTER_KEYS = [
  "budgetBlocked",
  "challengeExpanded",
  "challengeFailed",
  "challengeNoMatches",
  "challengePlanned",
  "challengeRetrievalPerformed",
  "confirmed",
  "droppedInsufficientEvidence",
  "falsifierDefeated",
  "retrievalExpanded",
  "retrievalFailed",
  "retrievalNoMatches",
  "retrievalPerformed",
  "retrievalRequested",
  "truthRefuted",
  "undecided",
];
const SCORE_KEYS = ["all", "chronological", "holdoutFromPullRequest", "schemaVersion"];
const COMPARISON_KEYS = ["after", "before"];
const POPULATION_KEYS = [
  "confusionMatrix",
  "eligible",
  "eligibleDecisions",
  "excluded",
  "groundTruth",
  "metrics",
  "records",
  "unmeasured",
];
const EXCLUDED_KEYS = ["byLabel", "total"];
const EXCLUDED_LABEL_KEYS = [
  "fixed_unconfirmed",
  "refuted_contradicted",
  "refuted_unconfirmed",
  "unanswered",
  "unclassified",
];
const GROUND_TRUTH_KEYS = ["fixedConfirmed", "refutedConfirmed"];
const CONFUSION_KEYS = ["falseNegative", "falsePositive", "trueNegative", "truePositive"];
const UNMEASURED_KEYS = ["fixedConfirmed", "refutedConfirmed", "total"];
const METRIC_KEYS = ["decisionCoverage", "falsePositiveRejection", "fixedRetention", "precision"];

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const MAX_ENDPOINT_REQUESTS_PER_CASE = 4;
/**
 * Worst-case ledger reservation for one historical case. Substantiation can make four sequential
 * model calls, so budgeting only one 32k request per case makes dry-run affordability misleading.
 */
export const HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE = 32_000 * MAX_ENDPOINT_REQUESTS_PER_CASE;
const CALIBRATED_POPULATION_RECORDS = 92;
const CALIBRATED_CORROBORATED_CASES = 66;
const MINIMUM_LOCALLY_BOUND_CASES = 62;
const MINIMUM_ATTEMPTED_CASES = 62;
const CALIBRATED_HOLDOUT_FROM_PULL_REQUEST = 3037;
const CALIBRATED_FIXED_CONFIRMED = 17;
const CALIBRATED_REFUTED_CONFIRMED = 49;
const CALIBRATED_TRAINING_ELIGIBLE = 24;
const CALIBRATED_HOLDOUT_ELIGIBLE = 42;

export const HISTORICAL_REPLAY_EVIDENCE_ARTIFACT = "keiko-for-quality/historical-replay-evidence";

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function sameKeys(value, expected) {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const wanted = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactRecord(value, keys) {
  const selected = record(value);
  return selected !== undefined && sameKeys(selected, keys) ? selected : undefined;
}

function natural(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function allNatural(value, keys) {
  return keys.every((key) => natural(value[key]));
}

function sum(value, keys) {
  return keys.reduce((total, key) => total + value[key], 0);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function metric(value) {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
  );
}

function sameMetric(actual, expected) {
  return actual === expected;
}

function mark(failures, failure) {
  if (!failures.includes(failure)) failures.push(failure);
}

function validateScope(value, failures) {
  const scope = exactRecord(value, Object.keys(SCOPE));
  if (
    scope === undefined ||
    Object.entries(SCOPE).some(([key, expected]) => scope[key] !== expected)
  ) {
    mark(failures, "scope");
  }
}

function validateBinding(value, failures) {
  const binding = exactRecord(value, BINDING_KEYS);
  const sourceSha256 = exactRecord(binding?.sourceSha256, SOURCE_DIGEST_KEYS);
  if (binding === undefined || sourceSha256 === undefined) {
    mark(failures, "binding_shape");
    return;
  }
  if (
    binding.model !== "gpt-oss-120b" ||
    binding.protocol !== "openai" ||
    binding.strictness !== "paranoid" ||
    typeof binding.harvestSha256 !== "string" ||
    !SHA256.test(binding.harvestSha256) ||
    typeof binding.endpointSha256 !== "string" ||
    !SHA256.test(binding.endpointSha256) ||
    typeof binding.reviewerTree !== "string" ||
    !COMMIT.test(binding.reviewerTree) ||
    SOURCE_DIGEST_KEYS.some(
      (key) => typeof sourceSha256[key] !== "string" || !SHA256.test(sourceSha256[key]),
    )
  ) {
    mark(failures, "binding_value");
  }
}

function reasonCounts(value) {
  const reasons = exactRecord(value, REASON_KEYS);
  return reasons !== undefined && allNatural(reasons, REASON_KEYS) ? reasons : undefined;
}

function decisionCounts(value) {
  const decisions = exactRecord(value, DECISION_KEYS);
  return decisions !== undefined && allNatural(decisions, DECISION_KEYS) ? decisions : undefined;
}

function validatePlanAndBudget(planValue, budgetValue, failures) {
  const plan = exactRecord(planValue, PLAN_KEYS);
  const budget = exactRecord(budgetValue, BUDGET_KEYS);
  const localUnmeasured = reasonCounts(plan?.localUnmeasured);
  const numericPlanKeys = PLAN_KEYS.filter((key) => key !== "localUnmeasured");
  if (
    plan === undefined ||
    budget === undefined ||
    localUnmeasured === undefined ||
    !allNatural(plan, numericPlanKeys) ||
    !allNatural(budget, BUDGET_KEYS) ||
    !positive(plan.configuredMaxTokens)
  ) {
    mark(failures, "plan_shape");
    return undefined;
  }

  const expectedAffordable = Math.min(
    plan.locallyBoundCases,
    Math.floor(plan.configuredMaxTokens / HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE),
  );
  if (
    plan.populationRecords < plan.corroboratedCases ||
    plan.corroboratedCases !== plan.locallyBoundCases + plan.structurallyUnmeasuredCases ||
    plan.estimatedAffordableCases !== expectedAffordable ||
    plan.estimatedCostExcessCases !== plan.locallyBoundCases - expectedAffordable ||
    plan.estimatedStartWorkTokens !==
      plan.locallyBoundCases * HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE ||
    plan.estimatedMaximumEndpointRequests !==
      plan.estimatedAffordableCases * MAX_ENDPOINT_REQUESTS_PER_CASE ||
    sum(localUnmeasured, REASON_KEYS) !== plan.structurallyUnmeasuredCases ||
    localUnmeasured.outsideCorroboratedPopulation !== 0 ||
    budget.estimatedTokensPerCase !== HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE ||
    budget.configuredMaxTokens !== plan.configuredMaxTokens ||
    budget.estimatedStartWorkTokens !== plan.estimatedStartWorkTokens ||
    budget.estimatedMaximumEndpointRequests !== plan.estimatedMaximumEndpointRequests
  ) {
    mark(failures, "plan_arithmetic");
  }
  if (
    plan.populationRecords !== CALIBRATED_POPULATION_RECORDS ||
    plan.corroboratedCases !== CALIBRATED_CORROBORATED_CASES ||
    plan.locallyBoundCases < MINIMUM_LOCALLY_BOUND_CASES
  ) {
    mark(failures, "plan_population_floor");
  }
  return { ...plan, localUnmeasured };
}

function validateExecution(value, plan, failures) {
  const execution = exactRecord(value, EXECUTION_KEYS);
  const populationDecisions = decisionCounts(execution?.populationDecisions);
  const corroboratedDecisions = decisionCounts(execution?.corroboratedDecisions);
  const stageCounters = exactRecord(execution?.stageCounters, STAGE_COUNTER_KEYS);
  const unmeasuredByReason = reasonCounts(execution?.unmeasuredByReason);
  const numericKeys = EXECUTION_KEYS.filter(
    (key) =>
      ![
        "corroboratedDecisions",
        "populationDecisions",
        "stageCounters",
        "unmeasuredByReason",
      ].includes(key),
  );
  if (
    execution === undefined ||
    populationDecisions === undefined ||
    corroboratedDecisions === undefined ||
    stageCounters === undefined ||
    unmeasuredByReason === undefined ||
    !allNatural(execution, numericKeys) ||
    !allNatural(stageCounters, STAGE_COUNTER_KEYS) ||
    !positive(execution.configuredMaxTokens)
  ) {
    mark(failures, "execution_shape");
    return undefined;
  }

  const successfulOrDecided =
    corroboratedDecisions.keep +
    corroboratedDecisions.drop +
    unmeasuredByReason.verificationUndecided +
    unmeasuredByReason.verificationError;
  const validatedOutcomes = execution.attemptedCases - unmeasuredByReason.verificationError;
  const terminalStageOutcomes =
    stageCounters.confirmed +
    stageCounters.truthRefuted +
    stageCounters.falsifierDefeated +
    stageCounters.droppedInsufficientEvidence +
    stageCounters.undecided;
  if (
    plan === undefined ||
    execution.populationRecords !== plan.populationRecords ||
    execution.corroboratedCases !== plan.corroboratedCases ||
    execution.configuredMaxTokens !== plan.configuredMaxTokens ||
    execution.attemptedCases > plan.locallyBoundCases ||
    execution.estimatedAttemptedTokens !==
      execution.attemptedCases * HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE ||
    execution.accountedTokens > execution.configuredMaxTokens ||
    (execution.attemptedCases > 0 && execution.accountedTokens === 0) ||
    sum(populationDecisions, DECISION_KEYS) !== execution.populationRecords ||
    sum(corroboratedDecisions, DECISION_KEYS) !== execution.corroboratedCases ||
    populationDecisions.keep !== corroboratedDecisions.keep ||
    populationDecisions.drop !== corroboratedDecisions.drop ||
    populationDecisions.unmeasured !==
      execution.populationRecords -
        execution.corroboratedCases +
        corroboratedDecisions.unmeasured ||
    unmeasuredByReason.outsideCorroboratedPopulation !==
      execution.populationRecords - execution.corroboratedCases ||
    sum(unmeasuredByReason, REASON_KEYS) !== populationDecisions.unmeasured ||
    execution.attemptedCases < successfulOrDecided ||
    execution.attemptedCases > successfulOrDecided + unmeasuredByReason.budget
  ) {
    mark(failures, "execution_arithmetic");
  }
  if (
    validatedOutcomes < 0 ||
    terminalStageOutcomes !== validatedOutcomes ||
    stageCounters.confirmed !== corroboratedDecisions.keep ||
    stageCounters.truthRefuted +
      stageCounters.falsifierDefeated +
      stageCounters.droppedInsufficientEvidence !==
      corroboratedDecisions.drop ||
    stageCounters.undecided !==
      unmeasuredByReason.verificationUndecided + stageCounters.budgetBlocked ||
    stageCounters.budgetBlocked > unmeasuredByReason.budget ||
    stageCounters.retrievalRequested > 2 * validatedOutcomes ||
    stageCounters.retrievalPerformed > validatedOutcomes ||
    stageCounters.retrievalPerformed > stageCounters.retrievalRequested ||
    stageCounters.retrievalExpanded +
      stageCounters.retrievalNoMatches +
      stageCounters.retrievalFailed !==
      stageCounters.retrievalPerformed ||
    stageCounters.retrievalFailed > stageCounters.undecided ||
    stageCounters.retrievalNoMatches > stageCounters.droppedInsufficientEvidence ||
    stageCounters.retrievalRequested - stageCounters.retrievalPerformed >
      stageCounters.droppedInsufficientEvidence ||
    stageCounters.challengePlanned > validatedOutcomes ||
    stageCounters.challengeRetrievalPerformed > stageCounters.challengePlanned ||
    stageCounters.challengeExpanded + stageCounters.challengeNoMatches >
      stageCounters.challengeRetrievalPerformed ||
    stageCounters.challengePlanned !==
      stageCounters.challengeExpanded +
        stageCounters.challengeNoMatches +
        stageCounters.challengeFailed ||
    stageCounters.challengeRetrievalPerformed -
      stageCounters.challengeExpanded -
      stageCounters.challengeNoMatches >
      stageCounters.challengeFailed ||
    stageCounters.challengeFailed > stageCounters.undecided ||
    stageCounters.challengeNoMatches > stageCounters.droppedInsufficientEvidence ||
    stageCounters.challengeExpanded < stageCounters.confirmed + stageCounters.falsifierDefeated
  ) {
    mark(failures, "execution_stage_arithmetic");
  }
  if (execution.attemptedCases < MINIMUM_ATTEMPTED_CASES) {
    mark(failures, "execution_population_floor");
  }
  return {
    ...execution,
    populationDecisions,
    corroboratedDecisions,
    stageCounters,
    unmeasuredByReason,
  };
}

function validatePopulation(value, failures) {
  const population = exactRecord(value, POPULATION_KEYS);
  const groundTruth = exactRecord(population?.groundTruth, GROUND_TRUTH_KEYS);
  const excluded = exactRecord(population?.excluded, EXCLUDED_KEYS);
  const excludedByLabel = exactRecord(excluded?.byLabel, EXCLUDED_LABEL_KEYS);
  const eligibleDecisions = decisionCounts(population?.eligibleDecisions);
  const confusionMatrix = exactRecord(population?.confusionMatrix, CONFUSION_KEYS);
  const unmeasured = exactRecord(population?.unmeasured, UNMEASURED_KEYS);
  const metrics = exactRecord(population?.metrics, METRIC_KEYS);
  if (
    population === undefined ||
    groundTruth === undefined ||
    excluded === undefined ||
    excludedByLabel === undefined ||
    eligibleDecisions === undefined ||
    confusionMatrix === undefined ||
    unmeasured === undefined ||
    metrics === undefined ||
    !natural(population.records) ||
    !natural(population.eligible) ||
    !allNatural(groundTruth, GROUND_TRUTH_KEYS) ||
    !natural(excluded.total) ||
    !allNatural(excludedByLabel, EXCLUDED_LABEL_KEYS) ||
    !allNatural(confusionMatrix, CONFUSION_KEYS) ||
    !allNatural(unmeasured, UNMEASURED_KEYS) ||
    !METRIC_KEYS.every((key) => metric(metrics[key]))
  ) {
    mark(failures, "score_shape");
    return undefined;
  }

  const kept = confusionMatrix.truePositive + confusionMatrix.falsePositive;
  const measured = eligibleDecisions.keep + eligibleDecisions.drop;
  if (
    population.eligible !== groundTruth.fixedConfirmed + groundTruth.refutedConfirmed ||
    population.records !== population.eligible + excluded.total ||
    excluded.total !== sum(excludedByLabel, EXCLUDED_LABEL_KEYS) ||
    unmeasured.total !== unmeasured.fixedConfirmed + unmeasured.refutedConfirmed ||
    groundTruth.fixedConfirmed !==
      confusionMatrix.truePositive + confusionMatrix.falseNegative + unmeasured.fixedConfirmed ||
    groundTruth.refutedConfirmed !==
      confusionMatrix.falsePositive + confusionMatrix.trueNegative + unmeasured.refutedConfirmed ||
    eligibleDecisions.keep !== kept ||
    eligibleDecisions.drop !== confusionMatrix.falseNegative + confusionMatrix.trueNegative ||
    eligibleDecisions.unmeasured !== unmeasured.total ||
    sum(eligibleDecisions, DECISION_KEYS) !== population.eligible ||
    !sameMetric(metrics.precision, ratio(confusionMatrix.truePositive, kept)) ||
    !sameMetric(
      metrics.fixedRetention,
      ratio(confusionMatrix.truePositive, groundTruth.fixedConfirmed),
    ) ||
    !sameMetric(
      metrics.falsePositiveRejection,
      ratio(confusionMatrix.trueNegative, groundTruth.refutedConfirmed),
    ) ||
    !sameMetric(metrics.decisionCoverage, ratio(measured, population.eligible))
  ) {
    mark(failures, "score_arithmetic");
  }
  return {
    ...population,
    groundTruth,
    excluded: { ...excluded, byLabel: excludedByLabel },
    eligibleDecisions,
    confusionMatrix,
    unmeasured,
    metrics,
  };
}

function samePopulationBasis(left, right) {
  return (
    left.records === right.records &&
    left.eligible === right.eligible &&
    GROUND_TRUTH_KEYS.every((key) => left.groundTruth[key] === right.groundTruth[key]) &&
    left.excluded.total === right.excluded.total &&
    EXCLUDED_LABEL_KEYS.every((key) => left.excluded.byLabel[key] === right.excluded.byLabel[key])
  );
}

function keepAllBaseline(population) {
  return (
    population.eligibleDecisions.keep === population.eligible &&
    population.eligibleDecisions.drop === 0 &&
    population.eligibleDecisions.unmeasured === 0 &&
    population.confusionMatrix.truePositive === population.groundTruth.fixedConfirmed &&
    population.confusionMatrix.falsePositive === population.groundTruth.refutedConfirmed &&
    population.confusionMatrix.falseNegative === 0 &&
    population.confusionMatrix.trueNegative === 0 &&
    population.unmeasured.total === 0
  );
}

function validateComparison(value, failures) {
  const comparison = exactRecord(value, COMPARISON_KEYS);
  if (comparison === undefined) {
    mark(failures, "score_shape");
    return undefined;
  }
  const before = validatePopulation(comparison.before, failures);
  const after = validatePopulation(comparison.after, failures);
  if (
    before !== undefined &&
    after !== undefined &&
    (!samePopulationBasis(before, after) || !keepAllBaseline(before))
  ) {
    mark(failures, "score_arithmetic");
  }
  return before === undefined || after === undefined ? undefined : { before, after };
}

function aggregatePopulation(all, training, holdout, failures) {
  const scalarKeys = ["records", "eligible"];
  const aggregateObjects = [
    ["groundTruth", GROUND_TRUTH_KEYS],
    ["eligibleDecisions", DECISION_KEYS],
    ["confusionMatrix", CONFUSION_KEYS],
    ["unmeasured", UNMEASURED_KEYS],
  ];
  const scalarsMatch = scalarKeys.every((key) => all[key] === training[key] + holdout[key]);
  const objectsMatch = aggregateObjects.every(([field, keys]) =>
    keys.every((key) => all[field][key] === training[field][key] + holdout[field][key]),
  );
  const exclusionsMatch =
    all.excluded.total === training.excluded.total + holdout.excluded.total &&
    EXCLUDED_LABEL_KEYS.every(
      (key) =>
        all.excluded.byLabel[key] ===
        training.excluded.byLabel[key] + holdout.excluded.byLabel[key],
    );
  if (!scalarsMatch || !objectsMatch || !exclusionsMatch) mark(failures, "score_arithmetic");
}

function validateScore(value, holdoutFromPullRequest, plan, execution, failures) {
  const score = exactRecord(value, SCORE_KEYS);
  const chronological = exactRecord(score?.chronological, ["holdout", "training"]);
  if (
    score === undefined ||
    chronological === undefined ||
    score.schemaVersion !== 1 ||
    !positive(score.holdoutFromPullRequest) ||
    score.holdoutFromPullRequest !== holdoutFromPullRequest
  ) {
    mark(failures, "score_shape");
    return;
  }
  const all = validateComparison(score.all, failures);
  const training = validateComparison(chronological.training, failures);
  const holdout = validateComparison(chronological.holdout, failures);
  if (all === undefined || training === undefined || holdout === undefined) return;

  for (const phase of ["before", "after"]) {
    aggregatePopulation(all[phase], training[phase], holdout[phase], failures);
  }
  if (
    all.before.groundTruth.fixedConfirmed !== CALIBRATED_FIXED_CONFIRMED ||
    all.before.groundTruth.refutedConfirmed !== CALIBRATED_REFUTED_CONFIRMED ||
    training.before.eligible !== CALIBRATED_TRAINING_ELIGIBLE ||
    holdout.before.eligible !== CALIBRATED_HOLDOUT_ELIGIBLE ||
    plan === undefined ||
    execution === undefined ||
    all.before.records !== plan.populationRecords ||
    all.before.eligible !== plan.corroboratedCases ||
    all.before.eligible !== CALIBRATED_CORROBORATED_CASES ||
    DECISION_KEYS.some(
      (key) => all.after.eligibleDecisions[key] !== execution.corroboratedDecisions[key],
    )
  ) {
    mark(failures, "score_population_binding");
  }
}

/**
 * Validates one release-grade schema-v5 historical replay artifact.
 *
 * The return shape mirrors the qualification evidence validator so release code can fail closed
 * without learning this schema's internals.
 */
export function validateHistoricalReplayEvidence(report) {
  const failures = [];
  const root = exactRecord(report, ROOT_KEYS);
  if (root === undefined) return { valid: false, failures: ["root_shape"] };
  if (root.schemaVersion !== 5 || root.artifact !== HISTORICAL_REPLAY_EVIDENCE_ARTIFACT) {
    mark(failures, "identity");
  }
  if (
    typeof root.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(root.generatedAt)) ||
    new Date(root.generatedAt).toISOString() !== root.generatedAt
  ) {
    mark(failures, "generated_at");
  }
  if (root.holdoutFromPullRequest !== CALIBRATED_HOLDOUT_FROM_PULL_REQUEST) {
    mark(failures, "holdout_boundary");
  }
  validateScope(root.scope, failures);
  validateBinding(root.binding, failures);
  const plan = validatePlanAndBudget(root.plan, root.budget, failures);
  const execution = validateExecution(root.execution, plan, failures);
  validateScore(root.score, root.holdoutFromPullRequest, plan, execution, failures);
  return { valid: failures.length === 0, failures };
}
