import { describe, expect, it } from "vitest";

import {
  BOUNDARY_OMISSION_EVIDENCE_POLICY,
  EXAMINER_CLAIM_DECISION_POLICY,
  EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES,
  REFERENCE_TRANSITION_EVIDENCE_POLICY,
  TEST_ISOLATION_EVIDENCE_POLICY,
} from "./claim-decision-policy.js";

describe("shared claim-decision policy", () => {
  it("derives one compact examiner capsule from the three canonical policies", () => {
    expect(EXAMINER_CLAIM_DECISION_POLICY).toBe(
      [
        `- test-isolation: ${TEST_ISOLATION_EVIDENCE_POLICY}`,
        `- reference-transition: ${REFERENCE_TRANSITION_EVIDENCE_POLICY}`,
        `- boundary-omission: ${BOUNDARY_OMISSION_EVIDENCE_POLICY}`,
      ].join("\n"),
    );
    expect(new TextEncoder().encode(EXAMINER_CLAIM_DECISION_POLICY).byteLength).toBeLessThanOrEqual(
      EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES,
    );
  });

  it("keeps clean reset and full-SHA transitions explicit beside their recall boundaries", () => {
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain(
      "SILENT (emit no claim): each case executes `vi.resetModules()` immediately before its awaited dynamic import",
    );
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain("That sequence loads a fresh module instance");
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain(
      "never call its reset redundant or insufficient",
    );
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain(
      "REPORT: the reset is shown missing, removed, late, or wrong",
    );
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain(
      "BYPASS (report): a static/top-level import or cached import promise was established before the reset",
    );

    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain(
      "SILENT (emit no claim): at the same action/dependency coordinate, one full 40-hex SHA or digest changes to another",
    );
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain("no shown local counterevidence exists");
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain("never request remote tag verification");
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain(
      "claim that the comment and immutable pin need alignment",
    );
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain("REPORT only SHA/digest-to-tag/branch");
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain("repo-proven pin mismatch");
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain("shown sync-contract desync");
    expect(REFERENCE_TRANSITION_EVIDENCE_POLICY).toContain(
      "`security`/`high`, including first-party actions; never critical",
    );
  });

  it("requires runtime boundary walks and shown preserve-state evidence for omitted clears", () => {
    expect(BOUNDARY_OMISSION_EVIDENCE_POLICY).toContain(
      "compare empty, exact-boundary, and just-outside inputs after runtime normalization against old behavior",
    );
    expect(BOUNDARY_OMISSION_EVIDENCE_POLICY).toContain(
      "report an explicit clear omitted from an optional update only when shown consumer code preserves existing state on absence",
    );
    expect(BOUNDARY_OMISSION_EVIDENCE_POLICY).toContain(
      "without that consumer evidence, leave silent",
    );
  });
});
