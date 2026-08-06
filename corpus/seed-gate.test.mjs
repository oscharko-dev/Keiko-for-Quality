import assert from "node:assert/strict";
import { test } from "node:test";

import { SEED_CASES } from "./seed-gate-cases.mjs";
import {
  LOCAL_REPORT_SCHEMA,
  applySeed,
  assertSeedCaseShape,
  evaluateAttempt,
  isMultiStep,
  locateSeedRange,
  observedPathOf,
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

test("assertSeedCaseShape refuses every other malformed shape, each with its own message", () => {
  assert.throws(() => assertSeedCaseShape([]), /non-empty array/);
  assert.throws(() => assertSeedCaseShape("cases"), /non-empty array/);
  assert.throws(() => assertSeedCaseShape([{ ...CASE_FIXTURE, id: "" }]), /needs an id/);
  assert.throws(() => assertSeedCaseShape([CASE_FIXTURE, CASE_FIXTURE]), /duplicate id/);
  assert.throws(
    () => assertSeedCaseShape([{ ...CASE_FIXTURE, rationale: "" }]),
    /rationale must be a non-empty string/,
  );
  assert.throws(() => assertSeedCaseShape([{ ...CASE_FIXTURE, tier: 3 }]), /tier must be 1/);
  assert.throws(
    () => assertSeedCaseShape([{ ...CASE_FIXTURE, required: "yes" }]),
    /explicit boolean/,
  );
});

// The multi-push shape (PRWeaver, arXiv:2608.02693). Its whole point is that the LAST push does
// not touch the observed file, so the validator must accept exactly that — while still refusing a
// case that never plants anything in the file it claims to watch.
const OTHER_FILE = "packages/example/src/caller.ts";

const MULTI_FIXTURE = {
  id: "multi-fixture",
  tier: 2,
  required: false,
  rationale: "fixture",
  observedFile: SEEDED_FILE,
  steps: [
    {
      label: "push 1",
      edits: [
        { file: SEEDED_FILE, find: "const guard = true;", replace: "const guard = flag();" },
        { file: OTHER_FILE, find: "const flag = () => false;", replace: "const flag = () => cfg;" },
      ],
    },
    {
      label: "push 2",
      edits: [{ file: OTHER_FILE, find: "const cfg = false;", replace: "const cfg = env.X;" }],
    },
  ],
};

test("a multi-push case is accepted, and identified as one", () => {
  const cases = [MULTI_FIXTURE];
  assert.equal(assertSeedCaseShape(cases), cases);
  assert.equal(isMultiStep(MULTI_FIXTURE), true);
  assert.equal(isMultiStep(CASE_FIXTURE), false);
  assert.equal(observedPathOf(MULTI_FIXTURE), SEEDED_FILE);
  assert.equal(observedPathOf(CASE_FIXTURE), SEEDED_FILE);
});

test("the two case forms are mutually exclusive", () => {
  assert.throws(
    () => assertSeedCaseShape([{ ...MULTI_FIXTURE, file: SEEDED_FILE, find: "a", replace: "b" }]),
    /pick one form/,
  );
});

test("a multi-push case must plant something in the file it watches", () => {
  assert.throws(
    () => assertSeedCaseShape([{ ...MULTI_FIXTURE, observedFile: "packages/example/src/nope.ts" }]),
    /no edit touches observedFile/,
  );
});

test("a multi-push case needs at least two steps and an observedFile", () => {
  assert.throws(
    () => assertSeedCaseShape([{ ...MULTI_FIXTURE, steps: [MULTI_FIXTURE.steps[0]] }]),
    /at least 2 steps/,
  );
  const withoutObserved = { ...MULTI_FIXTURE };
  delete withoutObserved.observedFile;
  assert.throws(() => assertSeedCaseShape([withoutObserved]), /needs an observedFile/);
});

test("locateSeedRange finds the planted text in the final tree, or refuses to guess", () => {
  const content = "line one\nline two\nconst guard = flag();\nline four\n";
  assert.deepEqual(locateSeedRange(content, "const guard = flag();"), {
    seedStartLine: 3,
    seedEndLine: 3,
  });
  // Absent and ambiguous both yield no range: a line anchor nobody established is never asserted.
  assert.equal(locateSeedRange(content, "not here"), undefined);
  assert.equal(
    locateSeedRange(`${content}const guard = flag();\n`, "const guard = flag();"),
    undefined,
  );
});

test("an attempt with no located range still passes on the file, without a line anchor", () => {
  const report = reportWith({ findings: [findingAt(SEEDED_FILE, 12, 14)] });
  const grade = evaluateAttempt(report, MULTI_FIXTURE, undefined);
  assert.equal(grade.found, true);
  assert.equal(grade.lineAnchored, false);
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
  assert.equal(green.releaseVerdict, "GREEN");
  assert.deepEqual(green.advisoryFailed, ["b"]);
  const red = summarizeGate([{ ...requiredPass, status: "missed" }]);
  assert.equal(red.green, false);
  assert.equal(red.releaseVerdict, "RED");
  assert.deepEqual(red.requiredFailed, ["a"]);
});

test("a selection that omits a required case is PARTIAL, never release-green", () => {
  const requiredPass = {
    id: "a",
    tier: 1,
    required: true,
    status: "passed",
    lineAnchored: true,
    attempts: [],
    spendTotal: 1,
  };
  const partial = summarizeGate([requiredPass], ["b-omitted"]);
  assert.equal(partial.green, true);
  assert.equal(partial.releaseVerdict, "PARTIAL");
  assert.deepEqual(partial.omittedRequired, ["b-omitted"]);
  const evidence = renderEvidence({
    dateIso: "2026-08-06",
    gateVersion: "0.19.1",
    reviewerTree: "abc123def456 (clean)",
    model: "gpt-oss-120b (openai)",
    base: "origin/dev @ abc123def456",
    caseResults: [requiredPass],
    summary: partial,
  });
  assert.match(evidence, /Verdict: PARTIAL/);
  assert.match(evidence, /NOT release evidence/);
  assert.match(evidence, /b-omitted/);
  assert.doesNotMatch(evidence, /Verdict: GREEN/);
});

test("renderEvidence names the verdict, every case, and the spend", () => {
  const result = settleCase(CASE_FIXTURE, [gradeOf({ found: true })]);
  const summary = summarizeGate([result]);
  const evidence = renderEvidence({
    dateIso: "2026-08-06",
    gateVersion: "0.19.1",
    reviewerTree: "abc123def456 (clean)",
    model: "gpt-oss-120b (openai)",
    base: "origin/dev @ abc123def456",
    caseResults: [result],
    summary,
  });
  assert.match(evidence, /GREEN/);
  assert.match(evidence, /Reviewer tree: abc123def456 \(clean\)/);
  assert.match(evidence, /fixture-case/);
  assert.match(evidence, /Total spend \(tokens\): 50/);
});

test("renderEvidence names required failures on a red run and flags a file-level-only pass", () => {
  const missed = settleCase(CASE_FIXTURE, [gradeOf()]);
  const anchorless = settleCase({ ...CASE_FIXTURE, id: "anchorless-case" }, [
    gradeOf({ found: true, fileFindingCount: 1 }),
  ]);
  const evidence = renderEvidence({
    dateIso: "2026-08-06",
    gateVersion: "0.19.1",
    reviewerTree: "abc123def456 (DIRTY — not release evidence)",
    model: "gpt-oss-120b (openai)",
    base: "origin/dev @ abc123def456",
    caseResults: [missed, anchorless],
    summary: summarizeGate([missed, anchorless]),
  });
  assert.match(evidence, /RED/);
  assert.match(evidence, /required failures: fixture-case/);
  assert.match(evidence, /DIRTY/);
  assert.match(evidence, /file-level only/);
});
