import { describe, expect, it } from "vitest";

import { buildJsonReport } from "./json.js";
import { buildSarifLog } from "./sarif.js";
import type { ReportFinding, ReportInput } from "./types.js";

/**
 * Cross-format agreement between the JSON and SARIF renderers.
 *
 * Issue #97's Deliverables ask for "a property test or table test asserting finding counts and
 * settlement agree across all three formats for the same report." The third format — human-
 * readable — is out of this module's scope (it is not owned by `src/report/`), so this file
 * covers the two formats this module does own: for the SAME `ReportInput`, the finding count and
 * the settlement outcome must never diverge between them. Both renderers are pure functions over
 * the same input by construction, so a divergence here would mean one of them dropped or
 * transformed something the other did not.
 */

const FINDING_A: ReportFinding = {
  path: "src/engine/settle.ts",
  startLine: 42,
  endLine: 47,
  category: "bug",
  severity: "high",
  body: "The coverage gap counter never resets between runs, so a transient gap from a prior push keeps blocking every later one even after it clears.",
};

const FINDING_B: ReportFinding = {
  path: "src/publish/sanitize.ts",
  startLine: 10,
  endLine: 10,
  category: "documentation",
  severity: "low",
  body: "This comment still describes the pre-neutralization behaviour; update it to match the current pass.",
};

/**
 * The 0-anchor file-level sentinel (`isFileLevel` in types.ts, docs/local-report-schema.md).
 *
 * Included here because the two renderers translate this input DIFFERENTLY — JSON to `null`/`null`
 * anchors, SARIF to a region-less location — so it is the one finding shape where a renderer could
 * plausibly lose a finding rather than merely render it oddly. What each format renders it to is
 * pinned in `json.test.ts` and `sarif.test.ts`; this file pins only that neither renderer drops it
 * or disagrees about the settlement it arrives with.
 */
const FINDING_C: ReportFinding = {
  path: "src/contracts/shape-gate.ts",
  startLine: 0,
  endLine: 0,
  category: "maintainability",
  severity: "medium",
  body: "The declared counterpart no longer covers this file's added union member, so the pair has drifted apart.",
};

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    outcome: "complete",
    findings: [FINDING_A, FINDING_B],
    spend: { engine: 15234, classify: 812, total: 16046, allotted: 50000 },
    inventory: { total: 12, reviewable: 9, reviewed: 9 },
    ruleDigest: "d".repeat(64),
    engineVersion: "1.8.4",
    ...overrides,
  };
}

const CASES: readonly ReportInput[] = [
  baseInput(),
  baseInput({ findings: [] }),
  baseInput({ findings: [FINDING_A] }),
  baseInput({ findings: [FINDING_C] }),
  baseInput({ findings: [FINDING_A, FINDING_B, FINDING_C] }),
  baseInput({ outcome: "incomplete", findings: [], reason: "settlement.incomplete.coverage_gap" }),
  baseInput({
    outcome: "incomplete",
    findings: [FINDING_A],
    reason: "settlement.incomplete.budget_exceeded",
  }),
  baseInput({ outcome: "abandoned", findings: [], reason: "publish.abandoned_stale_head" }),
];

describe("JSON/SARIF agreement", () => {
  it.each(CASES.map((input, index) => [index, input] as const))(
    "case %i: finding count and settlement outcome agree between JSON and SARIF",
    (_index, input) => {
      const json = buildJsonReport(input);
      const [sarifRun] = buildSarifLog(input).runs;

      expect(sarifRun.results).toHaveLength(json.findings.length);
      expect(sarifRun.properties.settlementOutcome).toBe(json.settlement.outcome);
      expect(sarifRun.properties.settlementReason).toBe(json.settlement.reason);
    },
  );

  it("agrees that a zero-finding incomplete run is not a zero-finding complete run, in both formats", () => {
    const incomplete = baseInput({
      outcome: "incomplete",
      findings: [],
      reason: "settlement.incomplete.coverage_gap",
    });
    const complete = baseInput({ outcome: "complete", findings: [] });

    const incompleteJson = buildJsonReport(incomplete);
    const completeJson = buildJsonReport(complete);
    expect(incompleteJson.findings).toEqual(completeJson.findings);
    expect(incompleteJson.settlement).not.toEqual(completeJson.settlement);

    const [incompleteRun] = buildSarifLog(incomplete).runs;
    const [completeRun] = buildSarifLog(complete).runs;
    expect(incompleteRun.results).toEqual(completeRun.results);
    expect(incompleteRun.invocations[0].executionSuccessful).toBe(false);
    expect(completeRun.invocations[0].executionSuccessful).toBe(true);
  });
});
