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

/** The whole policy block injected into each mandatory examiner, assembled from canonical text. */
export const EXAMINER_CLAIM_DECISION_POLICY = [
  `- test-isolation: ${TEST_ISOLATION_EVIDENCE_POLICY}`,
  `- reference-transition: ${REFERENCE_TRANSITION_EVIDENCE_POLICY}`,
  `- boundary-omission: ${BOUNDARY_OMISSION_EVIDENCE_POLICY}`,
  `- workflow-trust: ${WORKFLOW_TRUST_EVIDENCE_POLICY}`,
  `- diagnostic-context: ${DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY}`,
  `- trigger-guard: ${TRIGGER_AND_GUARD_EVIDENCE_POLICY}`,
  `- mirrored-validator: ${MIRRORED_VALIDATOR_EVIDENCE_POLICY}`,
].join("\n");

/** Prevent a focused examiner fix from silently becoming another copy of the complete rule. */
export const EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES = 3_500;
