import assert from "node:assert/strict";
import { test } from "node:test";

import { SEED_CASES } from "./seed-gate-cases.mjs";
import {
  LOCAL_REPORT_SCHEMA,
  applySeed,
  assertSeedCaseShape,
  evaluateAttempt,
  renderEvidence,
  settleCase,
  summarizeGate,
} from "./seed-gate-lib.mjs";

// Hermetic coverage for the consumer-seed gate's pure half (corpus/seed-gate-lib.mjs) and the
// shipped case set's shape. Zero model calls, zero git, zero filesystem: seed-gate.mjs itself is
// a script with side effects and real spend, so — like run.mjs before it (see gate.test.mjs's
// header) — it is never imported here; everything it decides with is tested through the lib.
//
// The one invariant worth naming: an `incomplete` attempt must never grade as found, even when
// the seeded finding is sitting right there in its report. That is incomplete-never-clean
// (CONTRIBUTING.md) applied to the gate itself, and the test below pins it directly.

const SEEDED_FILE = "packages/example/src/thing.ts";

const CASE_FIXTURE = {
  id: "fixture-case",
  tier: 1,
  required: true,
  file: SEEDED_FILE,
  find: "const guard = value === true;",
  replace: "const guard = value !== undefined;",
  rationale: "fixture",
};

function reportWith({ outcome = "complete", findings = [] } = {}) {
  return {
    schema: LOCAL_REPORT_SCHEMA,
    settlement: { outcome, reason: outcome === "complete" ? null : "engine_status_not_success" },
    findings,
    spend: { engine: 100, classify: 10, total: 110, allotted: 150000 },
    inventory: { total: 1, reviewable: 1, reviewed: 1 },
    ruleDigest: "d".repeat(64),
    engineVersion: "v1.8.4",
  };
}

function findingAt(path, startLine, endLine) {
  return { path, startLine, endLine, category: "bug", severity: "high", body: "seeded defect" };
}

test("the shipped seed case set is well-formed", () => {
  assert.equal(assertSeedCaseShape(SEED_CASES), SEED_CASES);
});

test("assertSeedCaseShape refuses a no-op seed", () => {
  assert.throws(
    () => assertSeedCaseShape([{ ...CASE_FIXTURE, replace: CASE_FIXTURE.find }]),
    /no defect is planted/,
  );
});

test("applySeed replaces exactly once and reports 1-based lines", () => {
  const content = "line one\nline two\nconst guard = value === true;\nline four\n";
  const applied = applySeed(content, CASE_FIXTURE);
  assert.equal(applied.ok, true);
  assert.match(applied.content, /value !== undefined/);
  assert.doesNotMatch(applied.content, /value === true/);
  assert.equal(applied.seedStartLine, 3);
  assert.equal(applied.seedEndLine, 3);
});

test("applySeed spans multi-line replacements", () => {
  const seedCase = { ...CASE_FIXTURE, find: "a();\nb();", replace: "b();\na();\nc();" };
  const applied = applySeed("start\na();\nb();\nend\n", seedCase);
  assert.equal(applied.ok, true);
  assert.equal(applied.seedStartLine, 2);
  assert.equal(applied.seedEndLine, 4);
});

test("applySeed refuses a stale seed and an ambiguous one, distinctly", () => {
  const stale = applySeed("nothing matches here\n", CASE_FIXTURE);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /stale/);
  const twice = `${CASE_FIXTURE.find}\n${CASE_FIXTURE.find}\n`;
  const ambiguous = applySeed(twice, CASE_FIXTURE);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.reason, /ambiguous/);
});

const SEED_RANGE = { seedStartLine: 10, seedEndLine: 11 };

test("evaluateAttempt refuses an unknown report schema", () => {
  assert.throws(
    () => evaluateAttempt({ schema: "something/v2" }, CASE_FIXTURE, SEED_RANGE),
    /unexpected report schema/,
  );
});

test("a complete report with a nearby finding in the seeded file is found and line-anchored", () => {
  const report = reportWith({ findings: [findingAt(SEEDED_FILE, 12, 14)] });
  const grade = evaluateAttempt(report, CASE_FIXTURE, SEED_RANGE);
  assert.equal(grade.found, true);
  assert.equal(grade.lineAnchored, true);
  assert.equal(grade.noiseCount, 0);
});

test("a distant finding in the seeded file still counts as found, but not line-anchored", () => {
  const report = reportWith({ findings: [findingAt(SEEDED_FILE, 400, 401)] });
  const grade = evaluateAttempt(report, CASE_FIXTURE, SEED_RANGE);
  assert.equal(grade.found, true);
  assert.equal(grade.lineAnchored, false);
});

test("a file-level finding (null anchors) counts as found without a line anchor", () => {
  const report = reportWith({ findings: [findingAt(SEEDED_FILE, null, null)] });
  const grade = evaluateAttempt(report, CASE_FIXTURE, SEED_RANGE);
  assert.equal(grade.found, true);
  assert.equal(grade.lineAnchored, false);
});

test("findings in other files are noise, never a pass", () => {
  const report = reportWith({ findings: [findingAt("packages/example/src/other.ts", 10, 11)] });
  const grade = evaluateAttempt(report, CASE_FIXTURE, SEED_RANGE);
  assert.equal(grade.found, false);
  assert.equal(grade.noiseCount, 1);
});

test("an incomplete report never grades as found, even with the seeded finding present", () => {
  const report = reportWith({ outcome: "incomplete", findings: [findingAt(SEEDED_FILE, 10, 11)] });
  const grade = evaluateAttempt(report, CASE_FIXTURE, SEED_RANGE);
  assert.equal(grade.found, false);
  assert.equal(grade.outcome, "incomplete");
});

function gradeOf(overrides) {
  return {
    outcome: "complete",
    found: false,
    lineAnchored: false,
    fileFindingCount: 0,
    noiseCount: 0,
    spendTotal: 50,
    ...overrides,
  };
}

test("settleCase distinguishes passed, missed, and never-complete", () => {
  const passed = settleCase(CASE_FIXTURE, [gradeOf({ found: true, lineAnchored: true })]);
  assert.equal(passed.status, "passed");
  assert.equal(passed.lineAnchored, true);
  const missed = settleCase(CASE_FIXTURE, [gradeOf(), gradeOf()]);
  assert.equal(missed.status, "missed");
  const wedged = settleCase(CASE_FIXTURE, [gradeOf({ outcome: "incomplete" })]);
  assert.equal(wedged.status, "never-complete");
  assert.equal(missed.spendTotal, 100);
});

test("summarizeGate goes red only on required failures", () => {
  const requiredPass = {
    id: "a",
    tier: 1,
    required: true,
    status: "passed",
    lineAnchored: true,
    attempts: [],
    spendTotal: 1,
  };
  const advisoryMiss = {
    id: "b",
    tier: 2,
    required: false,
    status: "missed",
    lineAnchored: false,
    attempts: [],
    spendTotal: 1,
  };
  const green = summarizeGate([requiredPass, advisoryMiss]);
  assert.equal(green.green, true);
  assert.deepEqual(green.advisoryFailed, ["b"]);
  const red = summarizeGate([{ ...requiredPass, status: "missed" }]);
  assert.equal(red.green, false);
  assert.deepEqual(red.requiredFailed, ["a"]);
});

test("renderEvidence names the verdict, every case, and the spend", () => {
  const result = settleCase(CASE_FIXTURE, [gradeOf({ found: true })]);
  const summary = summarizeGate([result]);
  const evidence = renderEvidence({
    dateIso: "2026-08-06",
    gateVersion: "0.19.1",
    model: "gpt-oss-120b (openai)",
    base: "origin/dev @ abc123def456",
    caseResults: [result],
    summary,
  });
  assert.match(evidence, /GREEN/);
  assert.match(evidence, /fixture-case/);
  assert.match(evidence, /Total spend \(tokens\): 50/);
});
