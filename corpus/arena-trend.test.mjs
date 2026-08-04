import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseBaselineFilename,
  compareBaselineVersions,
  safeRate,
  summarizeBaseline,
  renderBaselineSection,
  computeDelta,
  computeDeltasByBot,
  renderDeltaSection,
  renderTrendReport,
} from "./arena-trend.mjs";

/**
 * Tests for the arena trend report's pure computation.
 *
 * Run with `node --test corpus/*.test.mjs`. No network, no filesystem, no model spend: file
 * discovery and reading (`corpus/arena-trend.mjs`'s own `main`) is the impure seam and is
 * intentionally not exercised here, the same "thin and untested" boundary `corpus/arena.test.mjs`
 * draws around that module's own `main`.
 *
 * The two fixtures below carry the real `aggregate` blocks from
 * `corpus/evidence/arena-baseline-v0.10.0.json` and `corpus/evidence/arena-baseline-v0.11.0.json`
 * (copied, not read — this suite stays hermetic even if those files are ever edited or removed),
 * trimmed to the `schemaVersion` and `aggregate` fields this module actually reads. v0.10.0's
 * `aggregate` genuinely has no `actedUpon` block — it predates issue #56 — which is exactly the
 * shape `summarizeBaseline` has to tolerate rather than throw on.
 */

const BASELINE_V0_10_0 = {
  schemaVersion: 1,
  generatedAt: "2026-08-02T17:01:53.881Z",
  targetRepo: "oscharko-dev/Keiko",
  aggregate: {
    prCount: 2,
    bots: {
      kfq: {
        findingsPosted: 66,
        distinctFindings: 49,
        duplicateVariants: 17,
        incompleteNotices: 5,
        filesTouched: 38,
        uniqueToBot: 36,
        threads: { resolved: 60, unresolved: 11, outdated: 0 },
        coFound: { kfq: null, coderabbit: 9, codex: 8 },
        coFoundAllThree: 4,
      },
      coderabbit: {
        findingsPosted: 53,
        distinctFindings: 53,
        duplicateVariants: 0,
        incompleteNotices: 0,
        filesTouched: 37,
        uniqueToBot: 41,
        threads: { resolved: 53, unresolved: 0, outdated: 0 },
        coFound: { kfq: 9, coderabbit: null, codex: 7 },
        coFoundAllThree: 4,
      },
      codex: {
        findingsPosted: 22,
        distinctFindings: 22,
        duplicateVariants: 0,
        incompleteNotices: 0,
        filesTouched: 19,
        uniqueToBot: 11,
        threads: { resolved: 22, unresolved: 0, outdated: 0 },
        coFound: { kfq: 8, coderabbit: 7, codex: null },
        coFoundAllThree: 4,
      },
    },
    // No `actedUpon` key at all — the real file does not have one either.
  },
};

const BASELINE_V0_11_0 = {
  schemaVersion: 1,
  generatedAt: "2026-08-02T22:30:00.000Z",
  targetRepo: "oscharko-dev/Keiko",
  aggregate: {
    prCount: 3,
    bots: {
      kfq: {
        findingsPosted: 124,
        distinctFindings: 95,
        duplicateVariants: 29,
        incompleteNotices: 7,
        filesTouched: 69,
        uniqueToBot: 76,
        threads: { resolved: 66, unresolved: 49, outdated: 16 },
        coFound: { kfq: null, coderabbit: 9, codex: 13 },
        coFoundAllThree: 4,
      },
      coderabbit: {
        findingsPosted: 53,
        distinctFindings: 53,
        duplicateVariants: 0,
        incompleteNotices: 0,
        filesTouched: 37,
        uniqueToBot: 41,
        threads: { resolved: 53, unresolved: 0, outdated: 0 },
        coFound: { kfq: 9, coderabbit: null, codex: 7 },
        coFoundAllThree: 4,
      },
      codex: {
        findingsPosted: 46,
        distinctFindings: 46,
        duplicateVariants: 0,
        incompleteNotices: 0,
        filesTouched: 35,
        uniqueToBot: 29,
        threads: { resolved: 27, unresolved: 11, outdated: 8 },
        coFound: { kfq: 13, coderabbit: 7, codex: null },
        coFoundAllThree: 4,
      },
    },
    actedUpon: {
      kfq: {
        total: 95,
        actedUpon: 64,
        resolvedWithoutChange: 13,
        openUnaddressed: 18,
        outdatedByRebase: 0,
        hadOpportunity: 85,
        actedUponWithOpportunity: 64,
      },
      coderabbit: {
        total: 53,
        actedUpon: 49,
        resolvedWithoutChange: 4,
        openUnaddressed: 0,
        outdatedByRebase: 0,
        hadOpportunity: 53,
        actedUponWithOpportunity: 49,
      },
      codex: {
        total: 46,
        actedUpon: 32,
        resolvedWithoutChange: 4,
        openUnaddressed: 10,
        outdatedByRebase: 0,
        hadOpportunity: 42,
        actedUponWithOpportunity: 32,
      },
    },
  },
};

test("parseBaselineFilename extracts the version from a well-formed baseline filename", () => {
  assert.deepEqual(parseBaselineFilename("arena-baseline-v0.11.0.json"), {
    version: "0.11.0",
    major: 0,
    minor: 11,
    patch: 0,
  });
});

test("parseBaselineFilename returns null for anything else in the evidence directory", () => {
  assert.equal(parseBaselineFilename("arena-latest.json"), null);
  assert.equal(parseBaselineFilename("arena-baseline-v0.11.0.md"), null);
  assert.equal(parseBaselineFilename("arena-baseline-v1.json"), null);
  assert.equal(parseBaselineFilename("not-a-baseline-at-all.json"), null);
});

test("compareBaselineVersions orders numerically, not lexically", () => {
  // The regression this pins: "0.10.0" sorts BEFORE "0.9.10" as a plain string (the character '1'
  // is less than '9'), which would silently read a newer release as older the first time this
  // project ships a double-digit minor version. Comparing the parsed numbers avoids that trap.
  const v9 = parseBaselineFilename("arena-baseline-v0.9.10.json");
  const v10 = parseBaselineFilename("arena-baseline-v0.10.0.json");
  assert.ok(compareBaselineVersions(v9, v10) < 0, "0.9.10 must sort before 0.10.0");
  assert.ok(
    "0.10.0" < "0.9.10",
    "sanity check: plain string comparison really does get this backwards",
  );
});

test("compareBaselineVersions is stable and orders equal versions as equal", () => {
  const v = parseBaselineFilename("arena-baseline-v1.2.3.json");
  assert.equal(compareBaselineVersions(v, v), 0);
});

test("safeRate divides normally and guards a zero denominator with null, never Infinity or NaN", () => {
  assert.equal(safeRate(1, 2), 0.5);
  assert.equal(safeRate(0, 10), 0);
  assert.equal(safeRate(5, 0), null);
  assert.equal(safeRate(0, 0), null);
});

test("summarizeBaseline rejects a schemaVersion this module was not written for", () => {
  const wrongVersion = { ...BASELINE_V0_11_0, schemaVersion: 2 };
  assert.throws(() => summarizeBaseline("v0.11.0", wrongVersion), /schemaVersion/);
});

test("summarizeBaseline extracts posted/distinct/duplicate numbers per bot", () => {
  const summary = summarizeBaseline("v0.10.0", BASELINE_V0_10_0);
  assert.equal(summary.label, "v0.10.0");
  assert.equal(summary.prCount, 2);
  assert.deepEqual(summary.bots.kfq, {
    posted: 66,
    distinct: 49,
    duplicateVariants: 17,
    duplicateRate: 17 / 49,
    actedUponAdjustedRate: null,
  });
  assert.equal(
    summary.bots.coderabbit.duplicateRate,
    0,
    "0 duplicate variants is a real 0%, not n/a",
  );
});

test("summarizeBaseline reports hasActedUpon: false and a null rate when the block is absent entirely", () => {
  const summary = summarizeBaseline("v0.10.0", BASELINE_V0_10_0);
  assert.equal(summary.hasActedUpon, false);
  for (const arenaId of ["kfq", "coderabbit", "codex"]) {
    assert.equal(summary.bots[arenaId].actedUponAdjustedRate, null);
  }
});

test("summarizeBaseline computes the acted-upon adjusted rate when the block is present", () => {
  const summary = summarizeBaseline("v0.11.0", BASELINE_V0_11_0);
  assert.equal(summary.hasActedUpon, true);
  assert.equal(summary.bots.kfq.actedUponAdjustedRate, 64 / 85);
  assert.equal(summary.bots.coderabbit.actedUponAdjustedRate, 49 / 53);
  assert.equal(summary.bots.codex.actedUponAdjustedRate, 32 / 42);
});

test("summarizeBaseline tolerates an actedUpon block that omits one bot's entry", () => {
  const partial = {
    ...BASELINE_V0_11_0,
    aggregate: {
      ...BASELINE_V0_11_0.aggregate,
      actedUpon: { kfq: BASELINE_V0_11_0.aggregate.actedUpon.kfq },
    },
  };
  const summary = summarizeBaseline("v0.11.0-partial", partial);
  assert.equal(summary.hasActedUpon, true, "the block itself is present");
  assert.equal(summary.bots.kfq.actedUponAdjustedRate, 64 / 85);
  assert.equal(
    summary.bots.coderabbit.actedUponAdjustedRate,
    null,
    "a bot missing from an otherwise-present block reads as no data, not a crash",
  );
});

test("renderBaselineSection renders a markdown table with a row per bot, in ARENA_BOT_ORDER", () => {
  const summary = summarizeBaseline("v0.10.0", BASELINE_V0_10_0);
  const section = renderBaselineSection(summary);
  assert.match(section, /### v0\.10\.0 — 2 pull request\(s\)/);
  assert.match(section, /\| Bot \| Posted \| Distinct \| Duplicate variants \| Duplicate rate \|/);
  assert.match(section, /Keiko for Quality \| 66 \| 49 \| 17 \| 35% \|/);
  assert.match(section, /CodeRabbit \| 53 \| 53 \| 0 \| 0% \|/);
  const kfqRowIndex = section.indexOf("Keiko for Quality");
  const coderabbitRowIndex = section.indexOf("CodeRabbit");
  assert.ok(
    kfqRowIndex < coderabbitRowIndex,
    "rows follow ARENA_BOT_ORDER (kfq, coderabbit, codex)",
  );
});

test("renderBaselineSection notes the missing acted-upon data instead of a misleading n/a-only table", () => {
  const oldSummary = summarizeBaseline("v0.10.0", BASELINE_V0_10_0);
  assert.match(renderBaselineSection(oldSummary), /predates issue #56/);
  const newSummary = summarizeBaseline("v0.11.0", BASELINE_V0_11_0);
  assert.doesNotMatch(renderBaselineSection(newSummary), /predates issue #56/);
});

test("computeDelta reports signed count and rate movement between two baselines", () => {
  const from = summarizeBaseline("v0.10.0", BASELINE_V0_10_0);
  const to = summarizeBaseline("v0.11.0", BASELINE_V0_11_0);
  const delta = computeDelta(from, to, "kfq");
  assert.equal(delta.fromLabel, "v0.10.0");
  assert.equal(delta.toLabel, "v0.11.0");
  assert.equal(delta.posted, 124 - 66);
  assert.equal(delta.distinct, 95 - 49);
  assert.equal(delta.duplicateVariants, 29 - 17);
  assert.equal(delta.duplicateRate, 29 / 95 - 17 / 49);
});

test("computeDelta reports a null rate delta, not a false zero, when either side has no acted-upon data", () => {
  const from = summarizeBaseline("v0.10.0", BASELINE_V0_10_0);
  const to = summarizeBaseline("v0.11.0", BASELINE_V0_11_0);
  const delta = computeDelta(from, to, "kfq");
  assert.equal(
    delta.actedUponAdjustedRate,
    null,
    "v0.10.0 has no acted-upon rate to subtract from",
  );
});

test("computeDeltasByBot produces one delta per consecutive pair, per bot, in ARENA_BOT_ORDER", () => {
  const summaries = [
    summarizeBaseline("v0.10.0", BASELINE_V0_10_0),
    summarizeBaseline("v0.11.0", BASELINE_V0_11_0),
  ];
  const byBot = computeDeltasByBot(summaries);
  assert.deepEqual(Object.keys(byBot), ["kfq", "coderabbit", "codex"]);
  for (const arenaId of Object.keys(byBot)) {
    assert.equal(byBot[arenaId].length, 1, "two baselines produce exactly one consecutive pair");
  }
});

test("renderDeltaSection says there is nothing to compare with fewer than two baselines", () => {
  const summary = summarizeBaseline("v0.11.0", BASELINE_V0_11_0);
  const section = renderDeltaSection([summary]);
  assert.match(section, /nothing to compare/);
  assert.equal(
    renderDeltaSection([]),
    renderDeltaSection([]),
    "stays a pure function of its input",
  );
});

test("renderDeltaSection renders one subsection per bot with the signed movement", () => {
  const summaries = [
    summarizeBaseline("v0.10.0", BASELINE_V0_10_0),
    summarizeBaseline("v0.11.0", BASELINE_V0_11_0),
  ];
  const section = renderDeltaSection(summaries);
  assert.match(section, /#### Keiko for Quality/);
  assert.match(section, /#### CodeRabbit/);
  assert.match(section, /#### Codex/);
  // kfq: posted +58, distinct +46, duplicate variants +12, duplicate rate -4pp, acted-upon n/a
  // (v0.10.0 predates issue #56, so there is nothing to subtract it from).
  assert.match(section, /v0\.10\.0 \| v0\.11\.0 \| \+58 \| \+46 \| \+12 \| -4pp \| n\/a \|/);
});

test("renderTrendReport assembles a baseline section per input plus the delta section, oldest first", () => {
  const summaries = [
    summarizeBaseline("v0.10.0", BASELINE_V0_10_0),
    summarizeBaseline("v0.11.0", BASELINE_V0_11_0),
  ];
  const report = renderTrendReport(summaries);
  const v10Index = report.indexOf("### v0.10.0");
  const v11Index = report.indexOf("### v0.11.0");
  const deltaIndex = report.indexOf("## Cross-baseline deltas");
  assert.ok(v10Index !== -1 && v11Index !== -1 && deltaIndex !== -1);
  assert.ok(v10Index < v11Index, "baselines render oldest first");
  assert.ok(v11Index < deltaIndex, "the delta section follows every baseline table");
});

test("renderTrendReport is a pure function: identical input renders byte-identical output", () => {
  const summaries = [summarizeBaseline("v0.11.0", BASELINE_V0_11_0)];
  assert.equal(renderTrendReport(summaries), renderTrendReport(summaries));
});
