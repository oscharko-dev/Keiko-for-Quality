/**
 * Compact claim-decision policy shared by the serialized rule and both examiner roles.
 *
 * This module deliberately has no imports. The rule and generation workflow both depend on it,
 * so keeping it a leaf prevents a policy-sharing fix from creating an engine import cycle.
 */
export const TEST_ISOLATION_EVIDENCE_POLICY = [
  "Treat a dynamic import after a shown `beforeEach` module-registry reset as fresh; leave it silent.",
  "Report only a missing, removed, late, wrong, or bypassed reset after tracing suite setup,",
  "import timing, and shared state. Never invent an unshown reset helper.",
].join(" ");

export const REFERENCE_TRANSITION_EVIDENCE_POLICY = [
  "At one action/dependency coordinate, one full 40-hex SHA to another remains immutable and is",
  "clean by itself; shown local counterevidence still applies. Version comments do not prove remote",
  "tag mapping. Review changed coordinates; report only SHA-to-tag/branch, repo-proven pin mismatch,",
  "or shown sync-contract desync. Mutable references are `security`/`high`, including first-party",
  "actions; never critical. Never invent remote mapping, validity, staleness, or cadence.",
].join(" ");

/** The whole policy block injected into each mandatory examiner, assembled from canonical text. */
export const EXAMINER_CLAIM_DECISION_POLICY = [
  `- test-isolation: ${TEST_ISOLATION_EVIDENCE_POLICY}`,
  `- reference-transition: ${REFERENCE_TRANSITION_EVIDENCE_POLICY}`,
].join("\n");

/** Prevent a focused examiner fix from silently becoming another copy of the complete rule. */
export const EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES = 800;
