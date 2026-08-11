// Strict, text-free schema for an explicitly requested private historical replay trace.
//
// This is deliberately not historical replay release evidence. It carries only one database id,
// closed terminal state, and numeric usage per population record. Paths, finding prose, evidence,
// refs, prompts, model output, labels, and replies have no field through which they can enter.

export const HISTORICAL_REPLAY_DIAGNOSTIC_ARTIFACT =
  "keiko-for-quality/private-historical-replay-diagnostic";

const ROOT_KEYS = ["artifact", "cases", "schemaVersion"];
const CASE_KEYS = ["databaseId", "disposition", "reasonCode", "stage", "usage"];
const USAGE_KEYS = ["callCount", "tokens"];

export const HISTORICAL_DIAGNOSTIC_STAGES = [
  "population",
  "binding",
  "source",
  "evidence",
  "budget",
  "verification",
  "preflight",
  "truth_initial",
  "truth_retrieval",
  "truth_followup",
  "challenge_planner",
  "challenge_retrieval",
  "falsifier",
];

export const HISTORICAL_DIAGNOSTIC_DISPOSITIONS = [
  "unmeasured",
  "kept",
  "refuted",
  "insufficient_evidence",
  "undecided",
];

export const HISTORICAL_DIAGNOSTIC_REASON_CODES = [
  "outside_corroborated_population",
  "missing_historical_binding",
  "invalid_historical_binding",
  "finding_body_unavailable",
  "source_unavailable",
  "evidence_unavailable",
  "verification_error",
  "diff_echo",
  "unreadable_hunk",
  "budget",
  "request_transport_or_status",
  "usage_invalid",
  "finish_reason_nonstop",
  "json_or_envelope_invalid",
  "semantic_shape_invalid",
  "retrieval_error",
  "retrieval_no_match",
  "context_limit",
  "direct_proof",
  "contradicted",
  "already_handled",
  "not_introduced",
  "missing_definition",
  "missing_caller",
  "missing_contract",
  "missing_runtime",
  "missing_change_context",
  "no_defeater_found",
  "counterexample",
  "existing_guard",
  "unchanged_base",
  "causality_unproven",
];

const STAGES = new Set(HISTORICAL_DIAGNOSTIC_STAGES);
const DISPOSITIONS = new Set(HISTORICAL_DIAGNOSTIC_DISPOSITIONS);
const REASONS = new Set(HISTORICAL_DIAGNOSTIC_REASON_CODES);
const VERIFIER_STAGES = new Set(["verification", ...HISTORICAL_DIAGNOSTIC_STAGES.slice(6)]);
const HISTORICAL_TERMINAL_STAGES = new Set(HISTORICAL_DIAGNOSTIC_STAGES.slice(0, 6));
const NON_ATTEMPTED_STAGES = new Set(HISTORICAL_DIAGNOSTIC_STAGES.slice(0, 5));
const REQUEST_FAILURES = new Set([
  "budget",
  "request_transport_or_status",
  "usage_invalid",
  "finish_reason_nonstop",
  "json_or_envelope_invalid",
  "semantic_shape_invalid",
]);
const TRUTH_REASONS = new Set([
  "direct_proof",
  "contradicted",
  "already_handled",
  "not_introduced",
  "missing_definition",
  "missing_caller",
  "missing_contract",
  "missing_runtime",
  "missing_change_context",
]);
const FALSIFIER_REASONS = new Set([
  "no_defeater_found",
  "counterexample",
  "existing_guard",
  "unchanged_base",
  "causality_unproven",
  "missing_definition",
  "missing_caller",
  "missing_contract",
  "missing_runtime",
  "missing_change_context",
]);

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

function reasonAllowedAtStage(stage, reason) {
  if (stage === "population") return reason === "outside_corroborated_population";
  if (stage === "binding") {
    return [
      "missing_historical_binding",
      "invalid_historical_binding",
      "finding_body_unavailable",
    ].includes(reason);
  }
  if (stage === "source") return reason === "source_unavailable";
  if (stage === "evidence") return reason === "evidence_unavailable";
  if (stage === "budget") return reason === "budget";
  if (stage === "verification") return reason === "verification_error";
  if (stage === "preflight") return ["diff_echo", "unreadable_hunk", "budget"].includes(reason);
  if (stage === "truth_retrieval" || stage === "challenge_retrieval") {
    return ["retrieval_error", "retrieval_no_match", "context_limit"].includes(reason);
  }
  if (stage === "truth_initial" || stage === "truth_followup") {
    return REQUEST_FAILURES.has(reason) || TRUTH_REASONS.has(reason);
  }
  if (stage === "challenge_planner") return REQUEST_FAILURES.has(reason);
  return stage === "falsifier" && (REQUEST_FAILURES.has(reason) || FALSIFIER_REASONS.has(reason));
}

function dispositionMatches(stage, disposition, reason) {
  if (HISTORICAL_TERMINAL_STAGES.has(stage)) return disposition === "unmeasured";
  if (["request_transport_or_status", "usage_invalid", "finish_reason_nonstop"].includes(reason)) {
    return disposition === "undecided";
  }
  if (
    ["json_or_envelope_invalid", "semantic_shape_invalid", "retrieval_error", "budget"].includes(
      reason,
    )
  ) {
    return disposition === "undecided";
  }
  if (reason === "unreadable_hunk") return disposition === "undecided";
  if (reason === "retrieval_no_match") {
    return disposition === (stage === "challenge_retrieval" ? "kept" : "insufficient_evidence");
  }
  if (["diff_echo", "context_limit"].includes(reason)) {
    return disposition === "insufficient_evidence";
  }
  if (["contradicted", "already_handled", "not_introduced"].includes(reason)) {
    return disposition === "refuted";
  }
  if (
    ["counterexample", "existing_guard", "unchanged_base", "causality_unproven"].includes(reason)
  ) {
    return disposition === "refuted";
  }
  if (reason === "no_defeater_found") return disposition === "kept";
  return (
    [
      "missing_definition",
      "missing_caller",
      "missing_contract",
      "missing_runtime",
      "missing_change_context",
    ].includes(reason) && disposition === "insufficient_evidence"
  );
}

function validCase(value) {
  const selected = exactRecord(value, CASE_KEYS);
  const usage = exactRecord(selected?.usage, USAGE_KEYS);
  return (
    selected !== undefined &&
    usage !== undefined &&
    positive(selected.databaseId) &&
    STAGES.has(selected.stage) &&
    DISPOSITIONS.has(selected.disposition) &&
    REASONS.has(selected.reasonCode) &&
    natural(usage.callCount) &&
    usage.callCount <= 4 &&
    natural(usage.tokens) &&
    reasonAllowedAtStage(selected.stage, selected.reasonCode) &&
    dispositionMatches(selected.stage, selected.disposition, selected.reasonCode) &&
    (!NON_ATTEMPTED_STAGES.has(selected.stage) || (usage.callCount === 0 && usage.tokens === 0))
  );
}

/** Exact schema validation, intentionally independent from the public evidence validator. */
export function validateHistoricalReplayDiagnostic(value) {
  const root = exactRecord(value, ROOT_KEYS);
  if (
    root === undefined ||
    root.schemaVersion !== 1 ||
    root.artifact !== HISTORICAL_REPLAY_DIAGNOSTIC_ARTIFACT ||
    !Array.isArray(root.cases) ||
    root.cases.length === 0 ||
    !root.cases.every(validCase)
  ) {
    return false;
  }
  const ids = root.cases.map((entry) => entry.databaseId);
  return new Set(ids).size === ids.length;
}

/**
 * Binds the private trace to the exact requested population and aggregate execution accounting.
 * Those bindings are checked, not serialized, keeping each record at the closed minimum.
 */
export function buildHistoricalReplayDiagnostic({
  databaseIds,
  cases,
  attemptedCases,
  accountedTokens,
}) {
  if (
    !Array.isArray(databaseIds) ||
    databaseIds.length === 0 ||
    !databaseIds.every(positive) ||
    new Set(databaseIds).size !== databaseIds.length ||
    !natural(attemptedCases) ||
    !natural(accountedTokens)
  ) {
    throw new Error("historical diagnostic binding is malformed");
  }
  const diagnostic = {
    schemaVersion: 1,
    artifact: HISTORICAL_REPLAY_DIAGNOSTIC_ARTIFACT,
    cases,
  };
  if (!validateHistoricalReplayDiagnostic(diagnostic)) {
    throw new Error("historical diagnostic trace is malformed");
  }
  const actualIds = cases.map((entry) => entry.databaseId);
  if (
    actualIds.length !== databaseIds.length ||
    actualIds.some((id, index) => id !== databaseIds[index])
  ) {
    throw new Error("historical diagnostic trace does not match the requested population");
  }
  const attempted = cases.filter((entry) => VERIFIER_STAGES.has(entry.stage)).length;
  const tokens = cases.reduce((total, entry) => total + entry.usage.tokens, 0);
  if (attempted !== attemptedCases || tokens !== accountedTokens) {
    throw new Error("historical diagnostic trace does not match execution accounting");
  }
  return diagnostic;
}
