import { CASES } from "../corpus/cases.mjs";

/**
 * Public qualification evidence is deliberately a different schema from `OCR_REPORT`.
 *
 * The raw report is an operator diagnostic: it contains complete finding bodies and may contain
 * rejected model output. This artifact is the release record: public case ids, booleans, counts,
 * digests and identifiers only. Keeping the schemas distinct makes accidentally committing an
 * `OCR_REPORT` a release-gate failure rather than a documentation mistake.
 */
export const QUALIFICATION_EVIDENCE_ARTIFACT = "keiko-for-quality/qualification-evidence";
export const QUALIFICATION_EVIDENCE_SCHEMA_VERSION = 2;

const VERSION = /^\d+\.\d+\.\d+$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/u;
const RESULT_KINDS = new Set(["recall", "precision", "publishability", "error"]);
const REASONS = new Set(["measured", "no_cases", "model_unreached"]);
const PROTOCOLS = new Set(["openai", "anthropic"]);
const STRICTNESS_LEVELS = new Set(["lenient", "default", "strict", "paranoid"]);
const CASE_BY_ID = new Map(CASES.map((testCase) => [testCase.id, testCase]));

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function natural(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`qualification evidence: ${label} must be a non-negative integer`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    throw new TypeError(`qualification evidence: ${label} must be boolean`);
  }
  return value;
}

function optionalBoolean(value, label) {
  return value === undefined ? null : boolean(value, label);
}

function exactString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`qualification evidence: ${label} is invalid`);
  }
  return value;
}

function digest(value, label) {
  return exactString(value, SHA256, label);
}

function bindingFrom(rawBinding) {
  const binding = record(rawBinding);
  const adapter = record(binding?.adapter);
  const engine = record(binding?.engine);
  const rule = record(binding?.rule);
  const corpus = record(binding?.corpus);
  const model = record(binding?.model);
  const measuredAt = binding?.measuredAt;
  if (typeof measuredAt !== "string" || !Number.isFinite(Date.parse(measuredAt))) {
    throw new TypeError("qualification evidence: binding.measuredAt is invalid");
  }
  const protocol = model?.protocol;
  if (!PROTOCOLS.has(protocol)) {
    throw new TypeError("qualification evidence: binding.model.protocol is invalid");
  }
  const strictness = binding?.strictness;
  if (!STRICTNESS_LEVELS.has(strictness)) {
    throw new TypeError("qualification evidence: binding.strictness is invalid");
  }
  return {
    measuredAt: new Date(measuredAt).toISOString(),
    strictness,
    adapter: {
      version: exactString(adapter?.version, VERSION, "binding.adapter.version"),
      commit: exactString(adapter?.commit, COMMIT, "binding.adapter.commit"),
    },
    engine: { sha256: digest(engine?.sha256, "binding.engine.sha256") },
    rule: { sha256: digest(rule?.sha256, "binding.rule.sha256") },
    corpus: {
      cases: digest(corpus?.cases, "binding.corpus.cases"),
      scorer: digest(corpus?.scorer, "binding.corpus.scorer"),
    },
    model: {
      id: exactString(model?.id, SAFE_MODEL_ID, "binding.model.id"),
      protocol,
      endpointDigest: digest(model?.endpointDigest, "binding.model.endpointDigest"),
    },
  };
}

function resultFrom(rawResult, seen) {
  const result = record(rawResult);
  if (result === undefined) {
    throw new TypeError("qualification evidence: every result must be an object");
  }
  const id = result.id;
  if (typeof id !== "string" || !CASE_BY_ID.has(id) || seen.has(id)) {
    throw new TypeError("qualification evidence: result id is unknown or duplicated");
  }
  seen.add(id);
  if (!RESULT_KINDS.has(result.kind)) {
    throw new TypeError(`qualification evidence: result kind is invalid for ${id}`);
  }
  if (!Array.isArray(result.findings) || !Array.isArray(result.rejected)) {
    throw new TypeError(`qualification evidence: result arrays are invalid for ${id}`);
  }
  const rejectedCount = natural(result.rejected.length, `${id}.rejectedCount`);
  const rejectedSanitization = natural(
    result.rejectedSanitization ?? rejectedCount,
    `${id}.rejectedSanitization`,
  );
  if (rejectedCount !== rejectedSanitization) {
    throw new TypeError(`qualification evidence: rejection counts disagree for ${id}`);
  }
  return {
    id,
    kind: result.kind,
    pass: boolean(result.pass, `${id}.pass`),
    classified: optionalBoolean(result.classified, `${id}.classified`),
    severityAdjacent: optionalBoolean(result.severityAdjacent, `${id}.severityAdjacent`),
    noise: natural(result.noise ?? 0, `${id}.noise`),
    tokens: natural(result.tokens, `${id}.tokens`),
    findingCount: natural(result.findings.length, `${id}.findingCount`),
    rejectedCount,
    rejectedSanitization,
    suppressedIntraRun: natural(result.suppressedIntraRun ?? 0, `${id}.suppressedIntraRun`),
  };
}

function aggregatesFrom(results) {
  const tokens = results.reduce((sum, result) => sum + result.tokens, 0);
  const findingsGraded = results.reduce((sum, result) => {
    const testCase = CASE_BY_ID.get(result.id);
    return testCase?.defect === null ? sum : sum + result.findingCount;
  }, 0);
  const severeHits = results.filter((result) => {
    const defect = CASE_BY_ID.get(result.id)?.defect;
    return (
      result.kind === "recall" &&
      result.pass &&
      defect !== null &&
      defect !== undefined &&
      ["critical", "high"].includes(defect.severity)
    );
  }).length;
  return {
    findingsGraded,
    tokensPerFinding: findingsGraded > 0 ? Math.round(tokens / findingsGraded) : null,
    severeHits,
    tokensPerSevereHit: severeHits > 0 ? Math.round(tokens / severeHits) : null,
    suppressedIntraRun: results.reduce((sum, result) => sum + result.suppressedIntraRun, 0),
    rejectedSanitization: results.reduce((sum, result) => sum + result.rejectedSanitization, 0),
  };
}

/**
 * Converts one private `OCR_REPORT` into the only qualification JSON a release may commit.
 *
 * No raw string is spread or copied. Finding bodies, paths, replies, scorer details, engine status
 * strings and unknown future fields therefore cannot cross this boundary accidentally.
 */
export function redactQualificationReport(rawReport) {
  const raw = record(rawReport);
  if (raw === undefined || !Array.isArray(raw.results)) {
    throw new TypeError("qualification evidence: raw report shape is invalid");
  }
  const measured = boolean(raw.measured, "measured");
  const reason = measured ? "measured" : raw.reason;
  if (!REASONS.has(reason)) {
    throw new TypeError("qualification evidence: measurement reason is invalid");
  }
  const seen = new Set();
  const results = raw.results.map((result) => resultFrom(result, seen));
  const tokens = results.reduce((sum, result) => sum + result.tokens, 0);
  return {
    schemaVersion: QUALIFICATION_EVIDENCE_SCHEMA_VERSION,
    artifact: QUALIFICATION_EVIDENCE_ARTIFACT,
    redacted: true,
    measured,
    reason,
    binding: bindingFrom(raw.binding),
    results,
    tokens,
    aggregates: aggregatesFrom(results),
  };
}

function sameKeys(value, expected) {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const ROOT_KEYS = [
  "aggregates",
  "artifact",
  "binding",
  "measured",
  "reason",
  "redacted",
  "results",
  "schemaVersion",
  "tokens",
];
const BINDING_KEYS = ["adapter", "corpus", "engine", "measuredAt", "model", "rule", "strictness"];
const RESULT_KEYS = [
  "classified",
  "findingCount",
  "id",
  "kind",
  "noise",
  "pass",
  "rejectedCount",
  "rejectedSanitization",
  "severityAdjacent",
  "suppressedIntraRun",
  "tokens",
];
const AGGREGATE_KEYS = [
  "findingsGraded",
  "rejectedSanitization",
  "severeHits",
  "suppressedIntraRun",
  "tokensPerFinding",
  "tokensPerSevereHit",
];

function validateIdentity(root, failures) {
  if (
    root.schemaVersion !== QUALIFICATION_EVIDENCE_SCHEMA_VERSION ||
    root.artifact !== QUALIFICATION_EVIDENCE_ARTIFACT ||
    root.redacted !== true
  ) {
    failures.push("identity");
  }
  if (typeof root.measured !== "boolean" || !REASONS.has(root.reason)) {
    failures.push("measurement");
  }
  if (
    (root.measured === true && root.reason !== "measured") ||
    (root.measured === false && root.reason === "measured")
  ) {
    failures.push("measurement_reason");
  }
}

function hasBindingShape(binding) {
  const adapter = record(binding?.adapter);
  const engine = record(binding?.engine);
  const rule = record(binding?.rule);
  const corpus = record(binding?.corpus);
  const model = record(binding?.model);
  return (
    binding !== undefined &&
    sameKeys(binding, BINDING_KEYS) &&
    adapter !== undefined &&
    sameKeys(adapter, ["commit", "version"]) &&
    engine !== undefined &&
    sameKeys(engine, ["sha256"]) &&
    rule !== undefined &&
    sameKeys(rule, ["sha256"]) &&
    corpus !== undefined &&
    sameKeys(corpus, ["cases", "scorer"]) &&
    model !== undefined &&
    sameKeys(model, ["endpointDigest", "id", "protocol"])
  );
}

function validateBinding(rawBinding, failures) {
  const binding = record(rawBinding);
  if (!hasBindingShape(binding)) {
    failures.push("binding_shape");
    return;
  }
  try {
    bindingFrom(binding);
  } catch {
    failures.push("binding_value");
  }
}

function validateResultValues(result, seen) {
  const id = result.id;
  if (typeof id !== "string" || !CASE_BY_ID.has(id) || seen.has(id)) {
    throw new TypeError("qualification evidence: result id is unknown or duplicated");
  }
  seen.add(id);
  if (!RESULT_KINDS.has(result.kind)) {
    throw new TypeError(`qualification evidence: result kind is invalid for ${id}`);
  }
  boolean(result.pass, `${id}.pass`);
  if (result.classified !== null) boolean(result.classified, `${id}.classified`);
  if (result.severityAdjacent !== null) {
    boolean(result.severityAdjacent, `${id}.severityAdjacent`);
  }
  for (const key of [
    "noise",
    "tokens",
    "findingCount",
    "rejectedCount",
    "rejectedSanitization",
    "suppressedIntraRun",
  ]) {
    natural(result[key], `${id}.${key}`);
  }
  if (result.rejectedCount !== result.rejectedSanitization) {
    throw new TypeError(`qualification evidence: rejection counts disagree for ${id}`);
  }
}

function validateResults(rawResults, failures) {
  if (!Array.isArray(rawResults)) {
    failures.push("results_shape");
    return;
  }
  const seen = new Set();
  for (const result of rawResults) {
    const resultRecord = record(result);
    if (resultRecord === undefined || !sameKeys(resultRecord, RESULT_KEYS)) {
      failures.push("result_shape");
      continue;
    }
    try {
      validateResultValues(resultRecord, seen);
    } catch {
      failures.push("result_value");
    }
  }
}

function validateAggregateValues(root, aggregates, failures) {
  try {
    const expectedAggregates = aggregatesFrom(root.results);
    if (AGGREGATE_KEYS.some((key) => aggregates[key] !== expectedAggregates[key])) {
      failures.push("aggregates_value");
    }
    const expectedTokens = root.results.reduce((sum, result) => sum + result.tokens, 0);
    if (root.tokens !== expectedTokens) failures.push("tokens_value");
  } catch {
    failures.push("aggregates_value");
  }
}

function validateAggregates(root, failures) {
  const aggregates = record(root.aggregates);
  if (aggregates === undefined || !sameKeys(aggregates, AGGREGATE_KEYS)) {
    failures.push("aggregates_shape");
    return;
  }
  if (Array.isArray(root.results)) validateAggregateValues(root, aggregates, failures);
}

function hasCompleteCaseCoverage(results) {
  const ids = Array.isArray(results) ? new Set(results.map((result) => result?.id)) : new Set();
  return ids.size === CASES.length && CASES.every((testCase) => ids.has(testCase.id));
}

/** Strict schema validation used by both the checker and the release gate. */
export function validateQualificationEvidence(report) {
  const failures = [];
  const root = record(report);
  if (root === undefined || !sameKeys(root, ROOT_KEYS)) {
    return { valid: false, complete: false, failures: ["root_shape"] };
  }
  validateIdentity(root, failures);
  validateBinding(root.binding, failures);
  validateResults(root.results, failures);
  validateAggregates(root, failures);
  const complete = hasCompleteCaseCoverage(root.results);
  return { valid: failures.length === 0, complete, failures: [...new Set(failures)] };
}
