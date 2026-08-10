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
  "missing, removed, late, or wrong after tracing suite setup and shared state. BYPASS (report): a",
  "static/top-level import or cached import promise was established before the reset.",
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

/** The whole policy block injected into each mandatory examiner, assembled from canonical text. */
export const EXAMINER_CLAIM_DECISION_POLICY = [
  `- test-isolation: ${TEST_ISOLATION_EVIDENCE_POLICY}`,
  `- reference-transition: ${REFERENCE_TRANSITION_EVIDENCE_POLICY}`,
  `- boundary-omission: ${BOUNDARY_OMISSION_EVIDENCE_POLICY}`,
].join("\n");

/** Prevent a focused examiner fix from silently becoming another copy of the complete rule. */
export const EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES = 1_550;
