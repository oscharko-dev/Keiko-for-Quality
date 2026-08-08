import { test } from "node:test";
import assert from "node:assert/strict";

import {
  actionableRate,
  classifyReply,
  gradePullRequest,
  isCoverageNotice,
  renderReport,
  sumRecords,
  verdictOf,
} from "./precision-gate-lib.mjs";

const BOT = "keiko-for-quality";

function thread(nodes) {
  return { comments: { nodes } };
}

function comment(login, body) {
  return { author: { login }, body };
}

/**
 * The classifier is graded against verbatim reply openings from the window that motivated the
 * gate — a classifier tuned on invented phrasing would measure its author's imagination.
 */
test("classifies real refutations from the audited window", () => {
  for (const body of [
    "Refuted after verification: the early return happens BEFORE a new sequence token is issued.",
    "Refuted with one clarification: `stray.bin` is written inside the mkdtemp work directory.",
    "Not applicable: import.meta.dirname is standard Node since 20.11.",
    "This is a false positive — the parser never normalizes header names.",
    "The guard already exists at line 655, so nothing is missing here.",
  ]) {
    assert.equal(classifyReply(body), "refuted", body.slice(0, 40));
  }
});

test("classifies real fixes from the audited window", () => {
  for (const body of [
    "Fixed in c69e2757 — `downloadAssets` wraps its own assembly in try/catch.",
    "Applied in b0b331ca: a duplicated capability id now refuses the whole file.",
    "Addressed on this head.",
  ]) {
    assert.equal(classifyReply(body), "fixed", body.slice(0, 40));
  }
});

// Both verdicts appear in most substantive replies; position is what separates them.
test("the verdict that appears first wins", () => {
  assert.equal(
    classifyReply("Fixed in abc123 — the guard was missing, not already handled."),
    "fixed",
  );
  assert.equal(
    classifyReply("Refuted: applying this diff would reintroduce a pinned regression."),
    "refuted",
  );
});

test("a reply it cannot read is never counted as a fix", () => {
  assert.equal(classifyReply("ok"), "unclassified");
  assert.equal(classifyReply(""), "unclassified");
  assert.equal(classifyReply(undefined), "unclassified");
});

test("coverage notices are recognised and never graded as findings", () => {
  assert.equal(isCoverageNotice("This change was not fully reviewed."), true);
  const record = gradePullRequest(
    [
      thread([comment(BOT, "**This change was not fully reviewed.** ... was not fully reviewed")]),
      thread([comment(BOT, "**A real finding.**"), comment("human", "Fixed in abc123")]),
    ],
    BOT,
  );
  assert.deepEqual(record, {
    findings: 1,
    fixed: 1,
    refuted: 0,
    unanswered: 0,
    unclassified: 0,
  });
});

test("threads another author opened are not this reviewer's findings", () => {
  const record = gradePullRequest(
    [thread([comment("coderabbitai", "**Their finding.**"), comment("human", "Fixed in abc")])],
    BOT,
  );
  assert.equal(record.findings, 0);
});

// The reviewer's own follow-up on its own thread is not an answer to itself.
test("only a reply from someone else counts as the disposition", () => {
  const record = gradePullRequest(
    [thread([comment(BOT, "**Finding.**"), comment(BOT, "Fixed in abc123")])],
    BOT,
  );
  assert.deepEqual(record, {
    findings: 1,
    fixed: 0,
    refuted: 0,
    unanswered: 1,
    unclassified: 0,
  });
});

test("the rate is the fixed share of the ANSWERED findings only", () => {
  const totals = sumRecords([
    { findings: 10, fixed: 2, refuted: 6, unanswered: 1, unclassified: 1 },
    { findings: 2, fixed: 2, refuted: 0, unanswered: 0, unclassified: 0 },
  ]);
  assert.equal(totals.findings, 12);
  assert.equal(actionableRate(totals), 4 / 10);
});

// Absent means absent, here as everywhere else in this product.
test("a window with nothing graded has no rate and no verdict against it", () => {
  const totals = { findings: 3, fixed: 0, refuted: 0, unanswered: 3, unclassified: 0 };
  assert.equal(actionableRate(totals), undefined);
  assert.equal(verdictOf(undefined, 0.5), "GREY");
});

test("the verdict turns exactly at the threshold", () => {
  assert.equal(verdictOf(0.5, 0.5), "GREEN");
  assert.equal(verdictOf(0.49, 0.5), "RED");
});

test("the report states the rate, the population, and the verdict", () => {
  const totals = { findings: 82, fixed: 14, refuted: 55, unanswered: 11, unclassified: 2 };
  const text = renderReport({
    repo: "oscharko-dev/Keiko",
    identity: BOT,
    threshold: 0.5,
    perPr: [
      {
        number: 3037,
        record: { findings: 38, fixed: 3, refuted: 34, unanswered: 1, unclassified: 0 },
      },
    ],
    totals,
    generatedAt: "2026-08-08T21:00:00Z",
  });
  assert.match(text, /Actionable rate: 20\.3%/);
  assert.match(text, /14 fixed \/ 69 graded/);
  assert.match(text, /RED/);
  assert.match(text, /## PR #3037/);
});
