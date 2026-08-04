import { describe, expect, it } from "vitest";

import { FINDING_CATEGORIES } from "../engine/classify.js";
import {
  SARIF_SCHEMA_URI,
  SARIF_VERSION,
  TOOL_NAME,
  buildSarifLog,
  renderSarifReport,
  severityToLevel,
  type SarifLog,
} from "./sarif.js";
import type { FindingSeverity, ReportFinding, ReportInput } from "./types.js";

const RULE_DIGEST = "c".repeat(64);

const FINDING: ReportFinding = {
  path: "src/engine/settle.ts",
  startLine: 42,
  endLine: 47,
  category: "bug",
  severity: "high",
  body: "The coverage gap counter never resets between runs, so a transient gap from a prior push keeps blocking every later one even after it clears.",
};

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    outcome: "complete",
    findings: [FINDING],
    spend: { engine: 15234, classify: 812, total: 16046, allotted: 50000 },
    inventory: { total: 12, reviewable: 9, reviewed: 9 },
    ruleDigest: RULE_DIGEST,
    engineVersion: "1.8.4",
    ...overrides,
  };
}

describe("severity to level mapping", () => {
  const TABLE: readonly (readonly [FindingSeverity, "error" | "warning" | "note"])[] = [
    ["critical", "error"],
    ["high", "error"],
    ["medium", "warning"],
    ["low", "note"],
  ];

  it.each(TABLE)("maps %s to %s", (severity, level) => {
    expect(severityToLevel(severity)).toBe(level);
  });

  it.each(TABLE)("carries the %s -> %s mapping through a built result", (severity, level) => {
    const log = buildSarifLog(baseInput({ findings: [{ ...FINDING, severity }] }));
    expect(log.runs[0].results[0]?.level).toBe(level);
  });
});

describe("rules derived from categories", () => {
  it("declares one rule per category plus the fixed unclassified rule", () => {
    const [run] = buildSarifLog(baseInput()).runs;
    expect(run.tool.driver.rules).toHaveLength(FINDING_CATEGORIES.length + 1);
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual([
      ...FINDING_CATEGORIES.map((category) => `keiko-for-quality/${category}`),
      "keiko-for-quality/unclassified",
    ]);
  });

  it("declares the full rule set even when no finding uses most categories", () => {
    const [run] = buildSarifLog(baseInput({ findings: [] })).runs;
    expect(run.tool.driver.rules).toHaveLength(FINDING_CATEGORIES.length + 1);
  });

  it("references a result's rule by the category-derived id", () => {
    const [run] = buildSarifLog(
      baseInput({ findings: [{ ...FINDING, category: "security" }] }),
    ).runs;
    expect(run.results[0]?.ruleId).toBe("keiko-for-quality/security");
  });
});

describe("tool.driver", () => {
  it('names the tool exactly "keiko-for-quality"', () => {
    const [run] = buildSarifLog(baseInput()).runs;
    expect(run.tool.driver.name).toBe("keiko-for-quality");
    expect(TOOL_NAME).toBe("keiko-for-quality");
  });

  it("carries the engine version and an informationUri", () => {
    const [run] = buildSarifLog(baseInput({ engineVersion: "9.9.9" })).runs;
    expect(run.tool.driver.version).toBe("9.9.9");
    expect(run.tool.driver.informationUri).toMatch(/^https:\/\//);
  });
});

describe("physicalLocation fidelity", () => {
  it("carries the finding's path (URI-encoded) and 1-based start/end lines", () => {
    const [run] = buildSarifLog(
      baseInput({ findings: [{ ...FINDING, path: "src/a b.ts", startLine: 3, endLine: 5 }] }),
    ).runs;
    const location = run.results[0]?.locations[0];
    expect(location?.physicalLocation.artifactLocation.uri).toBe("src/a%20b.ts");
    expect(location?.physicalLocation.region).toEqual({ startLine: 3, endLine: 5 });
  });

  it("keeps startLine and endLine equal for a single-line finding", () => {
    const [run] = buildSarifLog(
      baseInput({ findings: [{ ...FINDING, startLine: 10, endLine: 10 }] }),
    ).runs;
    expect(run.results[0]?.locations[0]?.physicalLocation.region).toEqual({
      startLine: 10,
      endLine: 10,
    });
  });
});

describe("incomplete never reads as clean", () => {
  it("reports a complete run as a successful invocation with no notifications", () => {
    const [run] = buildSarifLog(baseInput({ outcome: "complete" })).runs;
    expect(run.invocations[0].executionSuccessful).toBe(true);
    expect(run.invocations[0].toolExecutionNotifications).toEqual([]);
    expect(run.properties.settlementOutcome).toBe("complete");
  });

  it("reports an incomplete, empty-results run as an unsuccessful invocation with the reason present", () => {
    const [run] = buildSarifLog(
      baseInput({
        outcome: "incomplete",
        findings: [],
        reason: "settlement.incomplete.coverage_gap",
      }),
    ).runs;

    expect(run.results).toEqual([]);
    expect(run.invocations[0].executionSuccessful).toBe(false);
    expect(run.invocations[0].toolExecutionNotifications).toHaveLength(1);
    expect(run.invocations[0].toolExecutionNotifications[0]?.level).toBe("error");
    expect(run.invocations[0].toolExecutionNotifications[0]?.message.text).toContain(
      "settlement.incomplete.coverage_gap",
    );
    expect(run.properties.settlementOutcome).toBe("incomplete");
    expect(run.properties.settlementReason).toBe("settlement.incomplete.coverage_gap");
  });

  it("reports an abandoned run as an unsuccessful invocation distinctly from incomplete", () => {
    const [run] = buildSarifLog(
      baseInput({ outcome: "abandoned", findings: [], reason: "publish.abandoned_stale_head" }),
    ).runs;
    expect(run.invocations[0].executionSuccessful).toBe(false);
    expect(run.properties.settlementOutcome).toBe("abandoned");
    expect(run.properties.settlementReason).toBe("publish.abandoned_stale_head");
  });

  it("surfaces spend and inventory in run-level properties for every outcome", () => {
    const [run] = buildSarifLog(
      baseInput({
        outcome: "incomplete",
        reason: "settlement.incomplete.budget_exceeded",
        spend: { engine: 1, classify: 2, total: 3, allotted: 4 },
        inventory: { total: 5, reviewable: 6, reviewed: 2 },
      }),
    ).runs;
    expect(run.properties.spend).toEqual({ engine: 1, classify: 2, total: 3, allotted: 4 });
    expect(run.properties.inventory).toEqual({ total: 5, reviewable: 6, reviewed: 2 });
  });

  it("still lists real findings an incomplete run's reached files produced", () => {
    // Mirrors `Settlement`'s "verdicts survive incompleteness" case (engine/settle.ts).
    const [run] = buildSarifLog(
      baseInput({ outcome: "incomplete", reason: "settlement.incomplete.budget_exceeded" }),
    ).runs;
    expect(run.results).toHaveLength(1);
    expect(run.invocations[0].executionSuccessful).toBe(false);
  });
});

describe("renderSarifReport", () => {
  it("is deterministic across repeated calls on the same input", () => {
    const input = baseInput();
    expect(renderSarifReport(input)).toBe(renderSarifReport(input));
    expect(buildSarifLog(input)).toEqual(buildSarifLog(input));
  });

  it("round-trips through JSON.parse with the same run and result count", () => {
    const input = baseInput();
    const parsed = JSON.parse(renderSarifReport(input)) as SarifLog;
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].results).toHaveLength(input.findings.length);
  });
});

/**
 * Structural approximation of SARIF 2.1.0 conformance.
 *
 * This is not a substitute for validating against the official SARIF 2.1.0 JSON schema (issue
 * #97's own "Expected Verification" asks for that explicitly) — doing so needs a JSON-Schema
 * validator and a vendored copy of the schema, both of which are a new devDependency this task's
 * scope did not authorize adding. What follows instead asserts, by hand, the subset of required
 * top-level and per-object members this module's hand-rolled types are supposed to guarantee at
 * compile time already — a second, runtime check of the same invariants, not a superset of them.
 */
describe("SARIF 2.1.0 structural shape", () => {
  it("sets the required top-level members", () => {
    const log = buildSarifLog(baseInput());
    expect(log.$schema).toBe(SARIF_SCHEMA_URI);
    expect(log.version).toBe("2.1.0");
    expect(SARIF_VERSION).toBe("2.1.0");
    expect(log.runs).toHaveLength(1);
  });

  it("sets the required run and tool.driver members", () => {
    const [run] = buildSarifLog(baseInput()).runs;
    expect(typeof run.tool.driver.name).toBe("string");
    expect(run.tool.driver.name.length).toBeGreaterThan(0);
    expect(Array.isArray(run.results)).toBe(true);
    expect(Array.isArray(run.invocations)).toBe(true);
  });

  it("sets the required result members for every finding", () => {
    const [run] = buildSarifLog(baseInput()).runs;
    for (const result of run.results) {
      expect(typeof result.ruleId).toBe("string");
      expect(["error", "warning", "note", "none"]).toContain(result.level);
      expect(typeof result.message.text).toBe("string");
      expect(result.locations.length).toBeGreaterThan(0);
      const region = result.locations[0].physicalLocation.region;
      expect(typeof result.locations[0].physicalLocation.artifactLocation.uri).toBe("string");
      // A region is optional (file-level findings drop it); when present it carries real lines.
      expect(region).toBeDefined();
      expect(typeof region?.startLine).toBe("number");
      expect(typeof region?.endLine).toBe("number");
    }
  });
});
