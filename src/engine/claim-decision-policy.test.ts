import { describe, expect, it } from "vitest";

import {
  EXAMINER_CLAIM_DECISION_POLICY,
  EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES,
  REFERENCE_TRANSITION_EVIDENCE_POLICY,
  TEST_ISOLATION_EVIDENCE_POLICY,
} from "./claim-decision-policy.js";

describe("shared claim-decision policy", () => {
  it("derives one compact examiner capsule from the two canonical policies", () => {
    expect(EXAMINER_CLAIM_DECISION_POLICY).toBe(
      [
        `- test-isolation: ${TEST_ISOLATION_EVIDENCE_POLICY}`,
        `- reference-transition: ${REFERENCE_TRANSITION_EVIDENCE_POLICY}`,
      ].join("\n"),
    );
    expect(new TextEncoder().encode(EXAMINER_CLAIM_DECISION_POLICY).byteLength).toBeLessThanOrEqual(
      EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES,
    );
  });

  it("keeps clean reset and full-SHA transitions explicit beside their recall boundaries", () => {
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain(
      "dynamic import after a shown `beforeEach` module-registry reset as fresh; leave it silent",
    );
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain(
      "missing, removed, late, wrong, or bypassed reset",
    );
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain("Never invent an unshown reset helper");

    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain(
      "one full 40-hex SHA to another remains immutable and is clean by itself",
    );
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain(
      "shown local counterevidence still applies",
    );
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain(
      "Version comments do not prove remote tag mapping",
    );
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain("Review changed coordinates");
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain("report only SHA-to-tag/branch");
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain("repo-proven pin mismatch");
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain("shown sync-contract desync");
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain(
      "`security`/`high`, including first-party actions; never critical",
    );
  });
});
