import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlan,
  buildSweepRows,
  estimateStageCost,
  FULL_CORPUS_CASE_COUNT,
  FULL_CORPUS_MINUTES,
  FULL_CORPUS_TOKENS_HIGH,
  FULL_CORPUS_TOKENS_LOW,
  parseArgs,
  renderDryRunPlan,
  renderEvidenceMarkdown,
  renderSweepTable,
  STRICTNESS_LEVELS,
  summarizeStageReport,
  USAGE,
} from "./operating-point-sweep.mjs";
import { registerTsExtensionHooks } from "./rule-source.mjs";

/**
 * Hermetic coverage for corpus/operating-point-sweep.mjs's planning, cost-estimation, aggregation,
 * and rendering — every function this file imports is pure (a plan, a report-shaped object, or a
 * string in; a plan, a row, or a document out). Zero model calls, zero child processes, zero
 * filesystem writes anywhere below: `run`/`main`/`runStage`/`spawnRunMjs` are never imported, and
 * the entry-point guard at the bottom of operating-point-sweep.mjs is what makes importing the pure
 * half of that file safe in the first place — mirroring corpus/arena.mjs and corpus/arena.test.mjs,
 * which take the identical shape for the identical reason.
 *
 * A real, paid sweep is exercised nowhere in this repository's automated suite, by design — see
 * AGENTS.md's "Three commands spend real money" and this script's own header comment. What CI can
 * hold instead is that the plan this script prints, the arithmetic it derives from a report, and the
 * document it writes are each correct on their own terms.
 */

registerTsExtensionHooks();
const { SUBSTANTIATION_STRICTNESS_LEVELS } = await import("../src/publish/substantiate.ts");

test("STRICTNESS_LEVELS mirrors substantiate.ts's own export by value", () => {
  // The two are duplicated on purpose (operating-point-sweep.mjs's own doc comment explains why:
  // importing the real export would pull in the TS resolve hooks on every import of this file,
  // including this test's own). This is the pin that keeps the duplicate honest.
  assert.deepEqual(STRICTNESS_LEVELS, SUBSTANTIATION_STRICTNESS_LEVELS);
});

test("parseArgs defaults to every level, full corpus, and no flags set", () => {
  const options = parseArgs([]);
  assert.deepEqual(options.stages, ["lenient", "default", "strict", "paranoid"]);
  assert.equal(options.only, undefined);
  assert.equal(options.dryRun, false);
  assert.equal(options.evidence, undefined);
});

test("parseArgs reads --only, --dry-run, and --evidence", () => {
  const options = parseArgs([
    "--only",
    "workflow-head-checkout",
    "--dry-run",
    "--evidence",
    "out.md",
  ]);
  assert.equal(options.only, "workflow-head-checkout");
  assert.equal(options.dryRun, true);
  assert.equal(options.evidence, "out.md");
});

test("parseArgs normalises --stages to canonical ordinal order regardless of input order", () => {
  const options = parseArgs(["--stages", "strict,lenient"]);
  assert.deepEqual(options.stages, ["lenient", "strict"]);
});

test("parseArgs trims whitespace and ignores case in --stages", () => {
  const options = parseArgs(["--stages", " Strict , Default "]);
  assert.deepEqual(options.stages, ["default", "strict"]);
});

test("parseArgs rejects an unknown level, naming it and the valid vocabulary", () => {
  assert.throws(() => parseArgs(["--stages", "extreme"]), /unknown level "extreme"/);
});

test("parseArgs rejects an empty --stages value", () => {
  assert.throws(() => parseArgs(["--stages", " , "]), /requires at least one level/);
});

test("parseArgs rejects an unknown flag, pointing at USAGE", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unknown option: --bogus/);
});

test("parseArgs rejects a flag missing its value instead of reading past the end of argv", () => {
  assert.throws(() => parseArgs(["--only"]), /--only requires a value/);
});

test("USAGE names every flag this script accepts", () => {
  for (const flag of ["--stages", "--only", "--dry-run", "--evidence"]) {
    assert.ok(USAGE.includes(flag), `USAGE should mention ${flag}`);
  }
});

test("estimateStageCost: full corpus matches the given range and case count exactly", () => {
  const cost = estimateStageCost(undefined);
  assert.equal(cost.cases, FULL_CORPUS_CASE_COUNT);
  assert.equal(cost.isProportional, false);
  assert.equal(cost.tokensLow, FULL_CORPUS_TOKENS_LOW);
  assert.equal(cost.tokensHigh, FULL_CORPUS_TOKENS_HIGH);
  assert.equal(cost.minutes, FULL_CORPUS_MINUTES);
});

test("estimateStageCost: --only narrows to one case, proportionally, and says so", () => {
  const cost = estimateStageCost("workflow-head-checkout");
  assert.equal(cost.cases, 1);
  assert.equal(cost.isProportional, true);
  assert.equal(cost.tokensLow, Math.round(FULL_CORPUS_TOKENS_LOW / FULL_CORPUS_CASE_COUNT));
  assert.equal(cost.tokensHigh, Math.round(FULL_CORPUS_TOKENS_HIGH / FULL_CORPUS_CASE_COUNT));
  // Split, so a failure names WHICH bound broke (Sonar S9073).
  assert.ok(cost.minutes > 0);
  assert.ok(cost.minutes < FULL_CORPUS_MINUTES);
});

test("buildPlan sums the per-stage estimate across every requested stage, not a flat total", () => {
  const plan = buildPlan({ stages: ["lenient", "default", "strict", "paranoid"], only: undefined });
  assert.equal(plan.totalTokensLow, FULL_CORPUS_TOKENS_LOW * 4);
  assert.equal(plan.totalTokensHigh, FULL_CORPUS_TOKENS_HIGH * 4);
  assert.equal(plan.totalMinutes, FULL_CORPUS_MINUTES * 4);
});

test("buildPlan on a narrowed --only + two stages costs a small fraction of the full sweep", () => {
  const full = buildPlan({ stages: STRICTNESS_LEVELS, only: undefined });
  const narrow = buildPlan({ stages: ["default", "strict"], only: "one-case" });
  assert.ok(narrow.totalTokensHigh < full.totalTokensHigh / 10);
});

test("renderDryRunPlan leads with the structural limitation, not the price", () => {
  const plan = buildPlan({ stages: STRICTNESS_LEVELS, only: undefined });
  const text = renderDryRunPlan(plan);
  assert.ok(text.startsWith("OPERATING-POINT SWEEP — PLAN ONLY, NOTHING SPENT YET"));
  const limitationIndex = text.indexOf("corpus/run.mjs never calls src/publish/substantiate.ts");
  const priceIndex = text.indexOf("per-stage estimate:");
  assert.ok(limitationIndex > -1, "the structural limitation must be stated");
  assert.ok(priceIndex > -1, "the cost estimate must be stated");
  assert.ok(limitationIndex < priceIndex, "the limitation must precede the price, not follow it");
});

test("renderDryRunPlan names every requested stage in order and the --only scope", () => {
  const plan = buildPlan({ stages: ["lenient", "strict"], only: "clean-added-guard" });
  const text = renderDryRunPlan(plan);
  assert.ok(text.includes("lenient -> strict"));
  assert.ok(text.includes("only: clean-added-guard"));
  assert.ok(text.includes("PROPORTIONAL estimate"));
});

function measuredReport(overrides = {}) {
  return {
    measured: true,
    binding: {
      engine: { sha256: "1".repeat(64) },
      rule: { sha256: "2".repeat(64) },
      corpus: { cases: "3".repeat(64), scorer: "4".repeat(64) },
      model: { id: "gpt-oss-120b" },
    },
    results: [
      { id: "case-a", kind: "recall", pass: true, tokens: 1000, rejected: [] },
      { id: "case-b", kind: "recall", pass: false, tokens: 800, rejected: [] },
      { id: "case-c", kind: "precision", pass: true, tokens: 500, rejected: [] },
      { id: "case-d", kind: "precision", pass: true, tokens: 400, rejected: [{}] },
    ],
    tokens: 2700,
    ...overrides,
  };
}

test("summarizeStageReport computes recall/precision/publishable from results[], like run.mjs's own scoreboard", () => {
  const summary = summarizeStageReport(measuredReport());
  assert.equal(summary.measured, true);
  assert.equal(summary.seeded, 2);
  assert.equal(summary.found, 1);
  assert.equal(summary.recall, 0.5);
  assert.equal(summary.clean, 2);
  assert.equal(summary.silent, 2);
  assert.equal(summary.precision, 1);
  assert.equal(summary.publishableTotal, 4);
  // case-d carries one rejected-sanitization entry, so only 3 of the 4 cases are publishable.
  assert.equal(summary.publishableOk, 3);
  assert.equal(summary.tokens, 2700);
});

test("summarizeStageReport reports recall/precision as null, never NaN, when a corpus has none of that kind", () => {
  const summary = summarizeStageReport(
    measuredReport({
      results: [{ id: "x", kind: "precision", pass: true, tokens: 10, rejected: [] }],
    }),
  );
  assert.equal(summary.recall, null);
  assert.equal(summary.precision, 1);
});

test("summarizeStageReport passes an unmeasured report through as unmeasured, with its reason", () => {
  const summary = summarizeStageReport({ measured: false, reason: "model_unreached", tokens: 0 });
  assert.equal(summary.measured, false);
  assert.equal(summary.reason, "model_unreached");
});

test("summarizeStageReport never throws on a missing or malformed report", () => {
  assert.doesNotThrow(() => summarizeStageReport(undefined));
  assert.doesNotThrow(() => summarizeStageReport(null));
  assert.doesNotThrow(() => summarizeStageReport({}));
  assert.equal(summarizeStageReport(undefined).measured, false);
  assert.equal(summarizeStageReport(null).measured, false);
  // No `reason` field at all (e.g. a truncated/corrupt OCR_REPORT) falls back to a fixed, honest
  // label rather than `undefined` leaking into a rendered table cell as the literal text "undefined".
  assert.equal(summarizeStageReport({}).reason, "report_unreadable");
});

test("buildSweepRows never fabricates the substantiation counts run.mjs cannot report", () => {
  const rows = buildSweepRows([
    { stage: "default", summary: summarizeStageReport(measuredReport()) },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "default");
  assert.equal(rows[0].found, "1/2");
  assert.equal(rows[0].silent, "2/2");
  assert.equal(rows[0].recall, "50.0%");
  assert.equal(rows[0].precision, "100.0%");
  for (const column of ["kept", "droppedVague", "droppedUnsupported", "droppedNitpick"]) {
    assert.equal(rows[0][column], "n/a*", `${column} must be flagged n/a, never a fabricated 0`);
  }
});

test("buildSweepRows renders an unmeasured stage as n/a across recall/precision too", () => {
  const rows = buildSweepRows([
    {
      stage: "strict",
      summary: summarizeStageReport({ measured: false, reason: "no_cases", tokens: 0 }),
    },
  ]);
  assert.equal(rows[0].found, "n/a");
  assert.equal(rows[0].recall, "n/a");
});

test("renderSweepTable is a GFM table with one row per stage and the n/a* footnote", () => {
  const rows = buildSweepRows([
    { stage: "default", summary: summarizeStageReport(measuredReport()) },
  ]);
  const table = renderSweepTable(rows);
  assert.ok(table.startsWith("| stage |"));
  assert.ok(table.includes("| --- |"));
  assert.ok(table.includes("| default |"));
  assert.ok(table.includes("never calls src/publish/substantiate.ts"));
});

test("renderEvidenceMarkdown titles itself a sweep, never a qualification, and says so explicitly", () => {
  const plan = buildPlan({ stages: ["default"], only: undefined });
  const doc = renderEvidenceMarkdown({
    generatedAtIso: "2026-08-06T00:00:00.000Z",
    plan,
    stageOutcomes: [{ stage: "default", exitCode: 0, durationMs: 1000, report: measuredReport() }],
  });
  assert.ok(doc.startsWith("# Substantiation strictness sweep — NOT a qualification"));
  assert.ok(!/^# Qualification/mu.test(doc), "must never open with a qualification-shaped title");
  assert.ok(doc.includes("not release evidence"));
});

test("renderEvidenceMarkdown includes the serving-variance caveat as prose, not only a code comment", () => {
  const plan = buildPlan({ stages: ["default"], only: undefined });
  const doc = renderEvidenceMarkdown({
    generatedAtIso: "2026-08-06T00:00:00.000Z",
    plan,
    stageOutcomes: [{ stage: "default", exitCode: 0, durationMs: 1000, report: measuredReport() }],
  });
  assert.ok(doc.includes("## Serving variance"));
  assert.ok(doc.includes("workflow-head-checkout"));
});

test("renderEvidenceMarkdown carries one binding line per stage and a spend total", () => {
  const plan = buildPlan({ stages: ["lenient", "default"], only: undefined });
  const doc = renderEvidenceMarkdown({
    generatedAtIso: "2026-08-06T00:00:00.000Z",
    plan,
    stageOutcomes: [
      { stage: "lenient", exitCode: 0, durationMs: 1000, report: measuredReport({ tokens: 1000 }) },
      { stage: "default", exitCode: 0, durationMs: 1000, report: measuredReport({ tokens: 2000 }) },
    ],
  });
  assert.ok(doc.includes("- lenient: engine 111111111111"));
  assert.ok(doc.includes("- default: engine 111111111111"));
  assert.ok(doc.includes("Total across 2 stage(s): 3,000 tokens."));
});

test("renderEvidenceMarkdown flags an unmeasured stage in its own Spend section instead of hiding it", () => {
  const plan = buildPlan({ stages: ["default"], only: undefined });
  const doc = renderEvidenceMarkdown({
    generatedAtIso: "2026-08-06T00:00:00.000Z",
    plan,
    stageOutcomes: [
      {
        stage: "default",
        exitCode: 2,
        durationMs: 1000,
        report: { measured: false, reason: "model_unreached", tokens: 0 },
      },
    ],
  });
  assert.ok(doc.includes("AT LEAST ONE STAGE DID NOT MEASURE"));
});
