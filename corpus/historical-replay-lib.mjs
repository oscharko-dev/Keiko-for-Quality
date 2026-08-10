// The zero-token precision replay: score a deterministic keep/drop decision against findings whose
// disposition was corroborated by both a reader reply and the pull request's later git history.
//
// This module never reads finding bodies, replies, repository files, or a model credential. The
// verifier under measurement runs elsewhere and hands this scorer one closed decision per database
// id. Keeping labels and decisions in separate arrays is deliberate: it makes accidental label
// leakage into a verifier visible at the call site instead of convenient inside this instrument.
//
// `fixed_confirmed` is the positive class: the reader said the finding was fixed and a later commit
// touched its region. `refuted_confirmed` is the negative class: the reader refuted it and no later
// commit touched its region. Every other harvest label remains in the report but is excluded from
// grading; uncertain evidence must not improve either side of the score.

import { HARVEST_LABELS } from "./harvest-lib.mjs";

export const HISTORICAL_REPLAY_DECISIONS = ["keep", "drop", "unmeasured"];

const POSITIVE_LABEL = "fixed_confirmed";
const NEGATIVE_LABEL = "refuted_confirmed";
const GRADED_LABELS = new Set([POSITIVE_LABEL, NEGATIVE_LABEL]);
const LABEL_SET = new Set(HARVEST_LABELS);
const DECISION_SET = new Set(HISTORICAL_REPLAY_DECISIONS);
const EXCLUDED_LABELS = HARVEST_LABELS.filter((label) => !GRADED_LABELS.has(label));

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function assertRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("historical replay records must be a non-empty array");
  }
  const ids = new Set();
  for (const record of records) {
    if (record === null || typeof record !== "object") {
      throw new Error("every historical replay record must be an object");
    }
    if (!isPositiveInteger(record.pullRequest)) {
      throw new Error("every historical replay record needs a positive pullRequest number");
    }
    if (!isPositiveInteger(record.databaseId)) {
      throw new Error("every historical replay record needs a positive databaseId");
    }
    if (ids.has(record.databaseId)) {
      throw new Error(`duplicate historical replay databaseId: ${String(record.databaseId)}`);
    }
    ids.add(record.databaseId);
    if (typeof record.label !== "string" || !LABEL_SET.has(record.label)) {
      throw new Error(`unknown historical replay label for ${String(record.databaseId)}`);
    }
  }
  return ids;
}

function assertDecisions(decisions, recordIds) {
  if (!Array.isArray(decisions)) {
    throw new TypeError("historical replay decisions must be an array");
  }
  const byId = new Map();
  for (const entry of decisions) {
    if (entry === null || typeof entry !== "object" || !isPositiveInteger(entry.databaseId)) {
      throw new Error("every historical replay decision needs a positive databaseId");
    }
    if (byId.has(entry.databaseId)) {
      throw new Error(`duplicate historical replay decision: ${String(entry.databaseId)}`);
    }
    if (typeof entry.decision !== "string" || !DECISION_SET.has(entry.decision)) {
      throw new Error(`unknown historical replay decision for ${String(entry.databaseId)}`);
    }
    if (!recordIds.has(entry.databaseId)) {
      throw new Error(`historical replay decision has no record: ${String(entry.databaseId)}`);
    }
    byId.set(entry.databaseId, entry.decision);
  }
  for (const databaseId of recordIds) {
    if (!byId.has(databaseId)) {
      throw new Error(`historical replay record has no decision: ${String(databaseId)}`);
    }
  }
  return byId;
}

function emptyExcludedByLabel() {
  return Object.fromEntries(EXCLUDED_LABELS.map((label) => [label, 0]));
}

function tallyGradedDecision(record, decision, confusionMatrix, unmeasured) {
  if (record.label === POSITIVE_LABEL) {
    if (decision === "keep") confusionMatrix.truePositive += 1;
    else if (decision === "drop") confusionMatrix.falseNegative += 1;
    else unmeasured.fixedConfirmed += 1;
    return;
  }
  if (decision === "keep") confusionMatrix.falsePositive += 1;
  else if (decision === "drop") confusionMatrix.trueNegative += 1;
  else unmeasured.refutedConfirmed += 1;
}

/**
 * Scores one already-validated population.
 *
 * An `unmeasured` decision is never folded into a favourable cell. It lowers both decision
 * coverage and, according to its ground-truth class, the corresponding retention/rejection rate.
 * Precision itself is defined over findings the candidate policy would keep; when it keeps none,
 * the rate is absent (`null`), not a fabricated 0% or 100%.
 */
function scorePopulationUnchecked(records, decisionById) {
  const confusionMatrix = {
    truePositive: 0,
    falseNegative: 0,
    falsePositive: 0,
    trueNegative: 0,
  };
  const unmeasured = { fixedConfirmed: 0, refutedConfirmed: 0, total: 0 };
  const eligibleDecisions = { keep: 0, drop: 0, unmeasured: 0 };
  const excludedByLabel = emptyExcludedByLabel();
  let fixedConfirmed = 0;
  let refutedConfirmed = 0;

  for (const record of records) {
    const decision = decisionById.get(record.databaseId);
    if (!GRADED_LABELS.has(record.label)) {
      excludedByLabel[record.label] += 1;
      continue;
    }

    eligibleDecisions[decision] += 1;
    if (record.label === POSITIVE_LABEL) {
      fixedConfirmed += 1;
    } else {
      refutedConfirmed += 1;
    }
    tallyGradedDecision(record, decision, confusionMatrix, unmeasured);
  }

  unmeasured.total = unmeasured.fixedConfirmed + unmeasured.refutedConfirmed;
  const eligible = fixedConfirmed + refutedConfirmed;
  const measured = eligibleDecisions.keep + eligibleDecisions.drop;
  const kept = confusionMatrix.truePositive + confusionMatrix.falsePositive;
  return {
    records: records.length,
    eligible,
    groundTruth: { fixedConfirmed, refutedConfirmed },
    excluded: {
      total: records.length - eligible,
      byLabel: excludedByLabel,
    },
    eligibleDecisions,
    confusionMatrix,
    unmeasured,
    metrics: {
      precision: ratio(confusionMatrix.truePositive, kept),
      fixedRetention: ratio(confusionMatrix.truePositive, fixedConfirmed),
      falsePositiveRejection: ratio(confusionMatrix.trueNegative, refutedConfirmed),
      decisionCoverage: ratio(measured, eligible),
    },
  };
}

function keepAll(records) {
  return new Map(records.map((record) => [record.databaseId, "keep"]));
}

function comparePopulation(records, decisionById) {
  return {
    before: scorePopulationUnchecked(records, keepAll(records)),
    after: scorePopulationUnchecked(records, decisionById),
  };
}

/** Score one population without a train/holdout split. */
export function scoreHistoricalPopulation(records, decisions) {
  const ids = assertRecords(records);
  const decisionById = assertDecisions(decisions, ids);
  return comparePopulation(records, decisionById);
}

/**
 * Builds the complete before/after report and a chronological transfer check.
 *
 * Pull requests below `holdoutFromPullRequest` form the training/vorlauf side; that pull request
 * and every later one form the holdout. Both halves must contain at least one corroborated example,
 * otherwise a typo in the boundary could emit a valid-looking report that measured no transfer.
 */
export function buildHistoricalReplayReport({ records, decisions, holdoutFromPullRequest }) {
  const ids = assertRecords(records);
  const decisionById = assertDecisions(decisions, ids);
  if (!isPositiveInteger(holdoutFromPullRequest)) {
    throw new Error("historical replay holdoutFromPullRequest must be a positive integer");
  }

  const trainingRecords = records.filter((record) => record.pullRequest < holdoutFromPullRequest);
  const holdoutRecords = records.filter((record) => record.pullRequest >= holdoutFromPullRequest);
  if (!trainingRecords.some((record) => GRADED_LABELS.has(record.label))) {
    throw new Error("historical replay training split has no corroborated examples");
  }
  if (!holdoutRecords.some((record) => GRADED_LABELS.has(record.label))) {
    throw new Error("historical replay holdout split has no corroborated examples");
  }

  return {
    schemaVersion: 1,
    holdoutFromPullRequest,
    all: comparePopulation(records, decisionById),
    chronological: {
      training: comparePopulation(trainingRecords, decisionById),
      holdout: comparePopulation(holdoutRecords, decisionById),
    },
  };
}
