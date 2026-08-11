import { describe, expect, it } from "vitest";

import {
  BOUNDARY_OMISSION_EVIDENCE_POLICY,
  DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY,
  EXAMINER_CLAIM_DECISION_POLICY,
  EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES,
  HELPER_CONTROL_FLOW_EVIDENCE_POLICY,
  MIRRORED_VALIDATOR_EVIDENCE_POLICY,
  PARALLEL_MAPPING_EVIDENCE_POLICY,
  REFERENCE_TRANSITION_EVIDENCE_POLICY,
  SENSITIVE_OUTPUT_EVIDENCE_POLICY,
  TEST_ISOLATION_EVIDENCE_POLICY,
  TRIGGER_AND_GUARD_EVIDENCE_POLICY,
  WORKFLOW_TRUST_EVIDENCE_POLICY,
  renderExaminerClaimDecisionPolicy,
} from "./claim-decision-policy.js";

describe("shared claim-decision policy", () => {
  it("derives one compact examiner capsule from every canonical policy", () => {
    expect(EXAMINER_CLAIM_DECISION_POLICY).toBe(
      [
        `- test-isolation: ${TEST_ISOLATION_EVIDENCE_POLICY}`,
        `- reference-transition: ${REFERENCE_TRANSITION_EVIDENCE_POLICY}`,
        `- boundary-omission: ${BOUNDARY_OMISSION_EVIDENCE_POLICY}`,
        `- workflow-trust: ${WORKFLOW_TRUST_EVIDENCE_POLICY}`,
        `- sensitive-output: ${SENSITIVE_OUTPUT_EVIDENCE_POLICY}`,
        `- diagnostic-context: ${DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY}`,
        `- trigger-guard: ${TRIGGER_AND_GUARD_EVIDENCE_POLICY}`,
        `- mirrored-validator: ${MIRRORED_VALIDATOR_EVIDENCE_POLICY}`,
        `- parallel-mapping: ${PARALLEL_MAPPING_EVIDENCE_POLICY}`,
        `- helper-control-flow: ${HELPER_CONTROL_FLOW_EVIDENCE_POLICY}`,
      ].join("\n"),
    );
    expect(new TextEncoder().encode(EXAMINER_CLAIM_DECISION_POLICY).byteLength).toBeLessThanOrEqual(
      EXAMINER_CLAIM_DECISION_POLICY_MAX_BYTES,
    );
  });

  it("prioritizes relevant decisions without removing any canonical policy", () => {
    const samples = [
      {
        evidence: 'logger.info("auth", { token });',
        first: SENSITIVE_OUTPUT_EVIDENCE_POLICY,
      },
      {
        evidence: 'catch (error) { logger.error("push", { attempt }); throw error; }',
        first: DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY,
      },
      {
        evidence: 'vi.resetModules(); const cache = await import("./cache.js");',
        first: TEST_ISOLATION_EVIDENCE_POLICY,
      },
      {
        evidence: "setTimeout(resolve, parseRetryAfter(header));",
        first: TRIGGER_AND_GUARD_EVIDENCE_POLICY,
      },
      {
        evidence:
          "figma: isJiraConnectorAuthorized(config),\njira: isFigmaConnectorAuthorized(config),",
        first: PARALLEL_MAPPING_EVIDENCE_POLICY,
      },
      {
        evidence: 'const compiler = windowsToolFromPath(env.PATH, "cl.exe"); spawn(compiler);',
        first: HELPER_CONTROL_FLOW_EVIDENCE_POLICY,
      },
    ];
    for (const sample of samples) {
      const rendered = renderExaminerClaimDecisionPolicy(sample.evidence);
      expect(rendered.split("\n")[0]).toContain(sample.first);
      for (const policy of [
        TEST_ISOLATION_EVIDENCE_POLICY,
        REFERENCE_TRANSITION_EVIDENCE_POLICY,
        BOUNDARY_OMISSION_EVIDENCE_POLICY,
        WORKFLOW_TRUST_EVIDENCE_POLICY,
        SENSITIVE_OUTPUT_EVIDENCE_POLICY,
        DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY,
        TRIGGER_AND_GUARD_EVIDENCE_POLICY,
        MIRRORED_VALIDATOR_EVIDENCE_POLICY,
        PARALLEL_MAPPING_EVIDENCE_POLICY,
        HELPER_CONTROL_FLOW_EVIDENCE_POLICY,
      ]) {
        expect(rendered.split(policy)).toHaveLength(2);
      }
    }
  });

  it("closes privileged checkout and harmless diagnostic-context decisions", () => {
    expect(WORKFLOW_TRUST_EVIDENCE_POLICY).toContain(
      "changes checkout from the trusted base SHA to the candidate head SHA",
    );
    expect(WORKFLOW_TRUST_EVIDENCE_POLICY).toContain("`security`/`critical`");
    expect(WORKFLOW_TRUST_EVIDENCE_POLICY).toContain(
      "only fetches candidate Git objects as review data",
    );
    expect(DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY).toContain(
      "adds an already-available non-secret primitive field",
    );
    expect(DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY).toContain("rethrows the identical error");
    expect(DIAGNOSTIC_CONTEXT_EVIDENCE_POLICY).toContain("disclose a secret or payload");
    expect(SENSITIVE_OUTPUT_EVIDENCE_POLICY).toContain("`security`/`critical`");
    expect(SENSITIVE_OUTPUT_EVIDENCE_POLICY).toContain("raw token");
    expect(SENSITIVE_OUTPUT_EVIDENCE_POLICY).toContain("do not require a separate runtime caller");
    expect(SENSITIVE_OUTPUT_EVIDENCE_POLICY).toContain("redacted or hashed before the sink");
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
      "BYPASS (report): the module under test or a shared-state dependency was imported at top level or cached before the reset",
    );
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain(
      "unrelated framework or helper imports are not bypass evidence",
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

  it("requires exact unit triggers, shown callers, and shown validator parity", () => {
    expect(TRIGGER_AND_GUARD_EVIDENCE_POLICY).toContain(
      "trace every shown producer branch and state the exact branch whose units mismatch",
    );
    expect(TRIGGER_AND_GUARD_EVIDENCE_POLICY).toContain("check every shown caller");
    expect(TRIGGER_AND_GUARD_EVIDENCE_POLICY).toContain(
      "naming that trigger and the resulting wrong behavior",
    );
    expect(MIRRORED_VALIDATOR_EVIDENCE_POLICY).toContain(
      "compare every required predicate in both",
    );
    expect(MIRRORED_VALIDATOR_EVIDENCE_POLICY).toContain("accepts objects production rejects");
    expect(PARALLEL_MAPPING_EVIDENCE_POLICY).toContain(
      "compare every changed output key, field, capability, or enum member",
    );
    expect(PARALLEL_MAPPING_EVIDENCE_POLICY).toContain(
      "calls or reads a different sibling's source",
    );
    expect(PARALLEL_MAPPING_EVIDENCE_POLICY).toContain(
      "explicit translation table proves the cross-map intentional",
    );
    expect(TEST_ISOLATION_EVIDENCE_POLICY).toContain(
      "A removed per-case reset before a later dynamic import is reportable",
    );
  });

  it("distinguishes fail-closed helper exits and inert imports from real execution paths", () => {
    expect(HELPER_CONTROL_FLOW_EVIDENCE_POLICY).toContain(
      "A terminal throw for the state prevents the call",
    );
    expect(HELPER_CONTROL_FLOW_EVIDENCE_POLICY).toContain(
      "invalid return, fallthrough, or catch-and-continue path",
    );
    expect(HELPER_CONTROL_FLOW_EVIDENCE_POLICY).toContain("import does not execute exports");
    expect(HELPER_CONTROL_FLOW_EVIDENCE_POLICY).toContain(
      "module evaluation runs unavailable platform code",
    );
    expect(HELPER_CONTROL_FLOW_EVIDENCE_POLICY).toContain("guarded calls remain silent");
  });
});
