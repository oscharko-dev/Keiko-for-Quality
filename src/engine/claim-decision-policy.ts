/**
 * Compact claim-decision policy shared by the serialized rule and both examiner roles.
 *
 * This module deliberately has no imports. The rule and generation workflow both depend on it,
 * so keeping it a leaf prevents a policy-sharing fix from creating an engine import cycle.
 */
export const TEST_ISOLATION_EVIDENCE_POLICY = [
  "Test-isolation decision — SILENT (emit no claim): each case executes `vi.resetModules()`",
  "immediately before its awaited dynamic import, whether directly in the test or through shown",
  "per-case setup. That sequence loads a fresh module instance; never call its reset redundant or",
  "insufficient, and never demand or invent a module clear/reset helper. REPORT: the reset is shown",
  "missing, removed, late, or wrong after tracing suite setup and shared state. BYPASS (report): the",
  "module under test or a shared-state dependency was imported at top level or cached before the",
  "reset; unrelated framework or helper imports are not bypass evidence. A removed per-case reset",
  "before a later dynamic import is reportable when an earlier case imported the same mutable",
  "module: the later import reuses that earlier module instance and its state.",
].join(" ");

export const REFERENCE_TRANSITION_EVIDENCE_POLICY = [
  "Reference-transition decision — SILENT (emit no claim): at the same action/dependency coordinate,",
  "one full 40-hex SHA or digest changes to another and no shown local counterevidence exists. An",
  "adjacent version comment does not change that decision: never request remote tag verification or",
  "claim that the comment and immutable pin need alignment. REPORT only SHA/digest-to-tag/branch, a",
  "repo-proven pin mismatch, or shown sync-contract desync. Mutable references are `security`/`high`,",
  "including first-party actions; never critical. Never invent remote mapping, validity, staleness,",
  "or cadence.",
].join(" ");

export const BOUNDARY_OMISSION_EVIDENCE_POLICY = [
  "Boundary/omission table — BOUNDS: compare empty, exact-boundary, and just-outside inputs after",
  "runtime normalization against old behavior. CLEAR: report an explicit clear omitted from an optional",
  "update only when shown consumer code preserves existing state on absence; without that consumer",
  "evidence, leave silent.",
].join(" ");

export const WORKFLOW_TRUST_EVIDENCE_POLICY = [
  "Privileged-workflow decision — REPORT `security`/`critical`: a `pull_request_target` or other",
  "trusted-context workflow changes checkout from the trusted base SHA to the candidate head SHA",
  "before install or execution, so candidate code runs with base-repository authority. SILENT: the",
  "workflow keeps the trusted base checkout and only fetches candidate Git objects as review data.",
].join(" ");

export const DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY = [
  "Diagnostic-context decision — SILENT: a catch block only adds an already-available non-secret",
  "primitive field to structured log context and rethrows the identical error. REPORT only when",
  "the added context can disclose a secret or payload, or the change replaces, wraps, or swallows",
  "the thrown error.",
].join(" ");

export const SENSITIVE_OUTPUT_EVIDENCE_POLICY = [
  "Sensitive-output decision — REPORT `security`/`critical`: changed code passes a raw token,",
  "secret, password, credential, authorization value, or session identifier into a logger,",
  "diagnostic, error, telemetry, or console sink. The shown direct flow is sufficient evidence;",
  "do not require a separate runtime caller before reporting the disclosure. SILENT only when the",
  "value is demonstrably redacted or hashed before the sink, or never reaches an output sink.",
].join(" ");

export const TRIGGER_AND_GUARD_EVIDENCE_POLICY = [
  "Trigger/guard decision — UNIT: when a changed value feeds a unit-sensitive API, trace every",
  "shown producer branch and state the exact branch whose units mismatch; a mixed-unit producer",
  "cannot share one conversion silently. GUARD: when a range or termination guard is removed on a",
  "claim that no caller reaches it, check every shown caller. Report when one supplies the rejected",
  "value, naming that trigger and the resulting wrong behavior; without shown producer or caller",
  "evidence, leave silent.",
].join(" ");

export const MIRRORED_VALIDATOR_EVIDENCE_POLICY = [
  "Mirrored-validator decision — when a changed audit, preflight, or compatibility check states",
  "that it mirrors a shown production validator, compare every required predicate in both. Report",
  "a loosened mirror that omits shown required fields and therefore accepts objects production",
  "rejects; do not infer parity or drift without both implementations in evidence.",
].join(" ");

export const PARALLEL_MAPPING_EVIDENCE_POLICY = [
  "Parallel-mapping decision — compare every changed output key, field, capability, or enum member",
  "with the source field or helper named on that same entry and with its adjacent siblings. REPORT",
  "`bug`/`high` when a keyed output visibly calls or reads a different sibling's source while that",
  "sibling reads the first key's source; symmetric repetition is not evidence of correctness.",
  "SILENT when a shown contract or explicit translation table proves the cross-map intentional.",
].join(" ");

export const HELPER_CONTROL_FLOW_EVIDENCE_POLICY = [
  "Helper/import — SILENT: every helper exit shown returns required call argument or throws before",
  "the consumer; never invent `undefined` after that throw. Imports do not execute exports; guarded",
  "platform calls stay silent. REPORT: shown invalid return, fallthrough, or caught failure reaches",
  "the consumer, or module evaluation runs unavailable platform work before the guard.",
].join(" ");

interface ClaimDecisionPolicyRow {
  readonly label: string;
  readonly text: string;
  readonly relevant: (visibleEvidence: string) => boolean;
}

const OUTPUT_SINK_SIGNAL = /\b(?:console|diagnostic|error|log(?:ger)?|telemetry)\b/iu;
const SENSITIVE_VALUE_SIGNAL =
  /\b(?:authorization|credential|password|secret|session(?:id|identifier)?|token)\b/iu;
const IDENTIFIER_SIGNAL = /^[\w$]+$/u;
const MAPPING_VALUE_SIGNAL =
  /\b(?:is|get|has|can|supports|resolve|select|summarise|summarize)[A-Z][\w$]*\s*\(/u;

function mappingEntryVisible(evidence: string): boolean {
  return evidence.split("\n").some((line) => {
    const normalized = line
      .trim()
      .replace(/^\d+\s+/u, "")
      .replace(/^[+-]\s*/u, "");
    const separator = normalized.indexOf(":");
    if (separator <= 0) return false;
    const key = normalized.slice(0, separator).trim();
    const value = normalized.slice(separator + 1);
    return IDENTIFIER_SIGNAL.test(key) && MAPPING_VALUE_SIGNAL.test(value);
  });
}

const POLICY_ROWS: readonly ClaimDecisionPolicyRow[] = [
  {
    label: "test-isolation",
    text: TEST_ISOLATION_EVIDENCE_POLICY,
    relevant: (evidence) =>
      /(?:\b(?:beforeEach|describe|it|test)\s*\(|resetModules\b)/u.test(evidence),
  },
  {
    label: "reference-transition",
    text: REFERENCE_TRANSITION_EVIDENCE_POLICY,
    relevant: (evidence) =>
      /(?:\b(?:action|dependency|digest|image|pin)\b|uses:\s|@[0-9a-f]{40}\b)/iu.test(evidence),
  },
  {
    label: "helper-control-flow",
    text: HELPER_CONTROL_FLOW_EVIDENCE_POLICY,
    relevant: (evidence) => /\b(?:spawn|fallthrough|platform|win32)\b/iu.test(evidence),
  },
  {
    label: "boundary-omission",
    text: BOUNDARY_OMISSION_EVIDENCE_POLICY,
    relevant: (evidence) =>
      /(?:\b(?:boundary|clear(?:ed|ing|s)?|empty|index|offset|optional)\b|\?\?|\.slice\s*\()/iu.test(
        evidence,
      ),
  },
  {
    label: "workflow-trust",
    text: WORKFLOW_TRUST_EVIDENCE_POLICY,
    relevant: (evidence) =>
      /(?:\.github\/workflows|candidate head|pull_request_target|trusted base)/iu.test(evidence),
  },
  {
    label: "sensitive-output",
    text: SENSITIVE_OUTPUT_EVIDENCE_POLICY,
    relevant: (evidence) =>
      OUTPUT_SINK_SIGNAL.test(evidence) && SENSITIVE_VALUE_SIGNAL.test(evidence),
  },
  {
    label: "diagnostic-context",
    text: DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY,
    relevant: (evidence) =>
      /\b(?:catch|console|diagnostic|log(?:ger)?|telemetry)\b/iu.test(evidence),
  },
  {
    label: "trigger-guard",
    text: TRIGGER_AND_GUARD_EVIDENCE_POLICY,
    relevant: (evidence) =>
      /(?:Retry-After|setTimeout|\b(?:caller|guard|increment|loop)\b|\bsize\s*<=)/iu.test(evidence),
  },
  {
    label: "mirrored-validator",
    text: MIRRORED_VALIDATOR_EVIDENCE_POLICY,
    relevant: (evidence) =>
      /\b(?:audit|compatibility|preflight|validat(?:e|es|ed|ing|ion|or))\b/iu.test(evidence),
  },
  {
    label: "parallel-mapping",
    text: PARALLEL_MAPPING_EVIDENCE_POLICY,
    relevant: (evidence) =>
      /\b(?:capabilit|mapping|mapper)\b/iu.test(evidence) || mappingEntryVisible(evidence),
  },
];

function renderPolicyRows(rows: readonly ClaimDecisionPolicyRow[]): string {
  return rows.map((row) => `- ${row.label}: ${row.text}`).join("\n");
}

/**
 * Keeps every canonical decision available while moving the rows proved relevant by the shown
 * source to the top. This is deterministic routing, not model-selected policy: a missed signal can
 * only leave the original complete capsule order in place, never remove a rule.
 */
export function renderExaminerClaimDecisionPolicy(visibleEvidence: string): string {
  const relevant = POLICY_ROWS.filter((row) => row.relevant(visibleEvidence));
  const remaining = POLICY_ROWS.filter((row) => !row.relevant(visibleEvidence));
  return renderPolicyRows([...relevant, ...remaining]);
}

/** The whole policy block injected into each mandatory examiner, assembled from canonical text. */
export const EXAMINER_CLAIM_DECISION_POLICY = renderExaminerClaimDecisionPolicy("");

/** Prevent a focused examiner fix from silently becoming another copy of the complete rule. */
export const EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES = 5_100;
