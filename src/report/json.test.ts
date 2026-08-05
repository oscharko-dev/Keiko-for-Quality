import { describe, expect, it } from "vitest";

import { FINDING_CATEGORIES, FINDING_SEVERITIES } from "../engine/classify.js";
import { JSON_REPORT_SCHEMA, buildJsonReport, renderJsonReport, type JsonReport } from "./json.js";
import type { ReportFinding, ReportInput } from "./types.js";

const RULE_DIGEST = "f".repeat(64);

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

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    outcome: "complete",
    findings: [FINDING_A, FINDING_B],
    spend: { engine: 15234, classify: 812, total: 16046, allotted: 50000 },
    inventory: { total: 12, reviewable: 9, reviewed: 9 },
    ruleDigest: RULE_DIGEST,
    engineVersion: "1.8.4",
    ...overrides,
  };
}

/** The exact expected shape for `baseInput()`, written independently of `json.ts`'s own
 *  construction order so this test does not simply restate the implementation. */
const EXPECTED_FIXTURE_REPORT: JsonReport = {
  schema: "keiko-for-quality.local-report/v1",
  settlement: { outcome: "complete", reason: null },
  engineVersion: "1.8.4",
  ruleDigest: RULE_DIGEST,
  spend: { engine: 15234, classify: 812, total: 16046, allotted: 50000 },
  inventory: { total: 12, reviewable: 9, reviewed: 9 },
  findings: [
    {
      path: "src/engine/settle.ts",
      startLine: 42,
      endLine: 47,
      category: "bug",
      severity: "high",
      body: FINDING_A.body,
    },
    {
      path: "src/publish/sanitize.ts",
      startLine: 10,
      endLine: 10,
      category: "documentation",
      severity: "low",
      body: FINDING_B.body,
    },
  ],
};

describe("buildJsonReport", () => {
  it("carries the documented schema v1 identifier", () => {
    expect(buildJsonReport(baseInput()).schema).toBe(JSON_REPORT_SCHEMA);
    expect(JSON_REPORT_SCHEMA).toBe("keiko-for-quality.local-report/v1");
  });

  it("produces the exact structure for a fixed input, field for field", () => {
    expect(buildJsonReport(baseInput())).toEqual(EXPECTED_FIXTURE_REPORT);
  });

  it("keeps every finding's path and line anchor unchanged", () => {
    const report = buildJsonReport(baseInput());
    expect(report.findings[0]).toMatchObject({
      path: "src/engine/settle.ts",
      startLine: 42,
      endLine: 47,
    });
    expect(report.findings[1]).toMatchObject({
      path: "src/publish/sanitize.ts",
      startLine: 10,
      endLine: 10,
    });
  });

  it("passes every category and severity value through unchanged", () => {
    for (const category of FINDING_CATEGORIES) {
      for (const severity of FINDING_SEVERITIES) {
        const finding: ReportFinding = { ...FINDING_A, category, severity };
        const [rendered] = buildJsonReport(baseInput({ findings: [finding] })).findings;
        expect(rendered?.category).toBe(category);
        expect(rendered?.severity).toBe(severity);
      }
    }
  });

  it("forwards spend and inventory without recomputation", () => {
    const input = baseInput({
      spend: { engine: 1, classify: 2, total: 3, allotted: 4 },
      inventory: { total: 5, reviewable: 6, reviewed: 7 },
    });
    const report = buildJsonReport(input);
    expect(report.spend).toEqual({ engine: 1, classify: 2, total: 3, allotted: 4 });
    expect(report.inventory).toEqual({ total: 5, reviewable: 6, reviewed: 7 });
  });
});

describe("the file-level 0-anchor sentinel", () => {
  it("renders both line anchors as null keys, never omitted, for a 0-anchor finding", () => {
    // `isFileLevel` (types.ts) is the shared decision both renderers make; this pins what JSON
    // renders it TO. It is not an edge case: every deterministic-gate finding is emitted with
    // `startLine: 0, endLine: 0` (review.ts, contracts/change-pass.ts) and `cli.ts` passes both
    // fields straight through, so a local run whose only findings come from the contract gates
    // takes this branch for all of them. Keys, not just values: docs/local-report-schema.md
    // promises consumers a fixed key set, so an omitted `startLine` is a DIFFERENT wire shape
    // from `null` — the same rule `settlement.reason` is pinned under below.
    const finding: ReportFinding = { ...FINDING_A, startLine: 0, endLine: 0 };
    const [rendered] = buildJsonReport(baseInput({ findings: [finding] })).findings;

    expect(rendered).toHaveProperty("startLine", null);
    expect(rendered).toHaveProperty("endLine", null);
    expect(Object.keys(rendered ?? {})).toEqual([
      "path",
      "startLine",
      "endLine",
      "category",
      "severity",
      "body",
    ]);
    // Nulling the anchors is the whole translation — nothing else about the finding changes.
    expect(rendered?.path).toBe(FINDING_A.path);
    expect(rendered?.category).toBe(FINDING_A.category);
    expect(rendered?.severity).toBe(FINDING_A.severity);
    expect(rendered?.body).toBe(FINDING_A.body);
  });

  it("keeps a file-level and a line-anchored finding side by side in one report", () => {
    const report = buildJsonReport(
      baseInput({ findings: [{ ...FINDING_A, startLine: 0, endLine: 0 }, FINDING_B] }),
    );
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]).toMatchObject({ startLine: null, endLine: null });
    expect(report.findings[1]).toMatchObject({ startLine: 10, endLine: 10 });
  });
});

describe("settlement distinctness", () => {
  it("distinguishes an incomplete, empty-findings run from a complete, empty-findings run", () => {
    const complete = buildJsonReport(baseInput({ outcome: "complete", findings: [] }));
    const incomplete = buildJsonReport(
      baseInput({
        outcome: "incomplete",
        findings: [],
        reason: "settlement.incomplete.coverage_gap",
      }),
    );

    expect(complete.findings).toEqual([]);
    expect(incomplete.findings).toEqual([]);
    // The array lengths agree; only `settlement` may tell the two apart, so the assertion targets
    // exactly that field rather than the whole object.
    expect(complete.settlement).not.toEqual(incomplete.settlement);
    expect(complete.settlement).toEqual({ outcome: "complete", reason: null });
    expect(incomplete.settlement).toEqual({
      outcome: "incomplete",
      reason: "settlement.incomplete.coverage_gap",
    });
  });

  it("renders an abandoned run distinctly from both complete and incomplete", () => {
    const abandoned = buildJsonReport(
      baseInput({ outcome: "abandoned", findings: [], reason: "publish.abandoned_stale_head" }),
    );
    expect(abandoned.settlement).toEqual({
      outcome: "abandoned",
      reason: "publish.abandoned_stale_head",
    });
  });

  it("keeps an incomplete run's partial findings visible alongside the incomplete outcome", () => {
    // Mirrors `Settlement`'s "verdicts survive incompleteness" case (engine/settle.ts): a budget
    // overrun or coverage gap still carries real findings for the files it did reach.
    const report = buildJsonReport(
      baseInput({
        outcome: "incomplete",
        findings: [FINDING_A],
        reason: "settlement.incomplete.budget_exceeded",
      }),
    );
    expect(report.settlement.outcome).toBe("incomplete");
    expect(report.findings).toHaveLength(1);
  });

  it("renders a reason of null, never an omitted key, when none was given", () => {
    const report = buildJsonReport(baseInput({ outcome: "complete" }));
    expect(report.settlement).toHaveProperty("reason", null);
    expect(Object.keys(report.settlement)).toEqual(["outcome", "reason"]);
  });
});

describe("empty findings, complete outcome", () => {
  it("renders an unmistakably clean report", () => {
    const report = buildJsonReport(baseInput({ findings: [] }));
    expect(report.settlement).toEqual({ outcome: "complete", reason: null });
    expect(report.findings).toEqual([]);
  });
});

describe("renderJsonReport", () => {
  it("is byte-stable for a fixed input", () => {
    expect(renderJsonReport(baseInput())).toBe(JSON.stringify(EXPECTED_FIXTURE_REPORT, null, 2));
  });

  it("is deterministic across repeated calls on the same input", () => {
    const input = baseInput();
    expect(renderJsonReport(input)).toBe(renderJsonReport(input));
    expect(buildJsonReport(input)).toEqual(buildJsonReport(input));
  });

  it("parses back to a structure carrying the same finding count and outcome", () => {
    const input = baseInput();
    const parsed = JSON.parse(renderJsonReport(input)) as JsonReport;
    expect(parsed.findings).toHaveLength(input.findings.length);
    expect(parsed.settlement.outcome).toBe(input.outcome);
  });
});
