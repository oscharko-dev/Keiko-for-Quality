import assert from "node:assert/strict";
import { test } from "node:test";

import {
  engineArguments,
  engineEvidence,
  scoreCleanCase,
  singleShotCorpusConcurrency,
  skipRetryAfterBudgetStop,
} from "./engine-invocation.mjs";

/**
 * The property the whole extraction exists for: a case WITHOUT `budgetTokens` is invoked with an
 * argv byte-identical to what the harness has always built. Asserted against the literal array,
 * not against "engineArguments(rule) plus nothing", so a change to the historical shape fails here
 * and has to be made on purpose — this is the recorded measurement basis of every existing case.
 */
test("unbudgeted argv is byte-identical to the historical invocation", () => {
  assert.deepEqual(engineArguments("/tmp/rule.json"), [
    "review",
    "--from",
    "HEAD~1",
    "--to",
    "HEAD",
    "--format",
    "json",
    "--rule",
    "/tmp/rule.json",
  ]);
});

test("a budgeted case appends the production budget flag AND sequential dispatch", () => {
  assert.deepEqual(engineArguments("/tmp/rule.json", 25_000), [
    "review",
    "--from",
    "HEAD~1",
    "--to",
    "HEAD",
    "--format",
    "json",
    "--rule",
    "/tmp/rule.json",
    "--max-tokens-budget",
    "25000",
    "--concurrency",
    "1",
  ]);
});

test("staged corpus dispatch is sequential only for a budget-pressure case", () => {
  assert.equal(singleShotCorpusConcurrency(undefined), 2);
  assert.equal(singleShotCorpusConcurrency(25_000), 1);
});

// The retry matrix. Production's rule: a budget-stopped attempt is never re-run
// (engine.resume_skipped_budget_exceeded, src/review.ts); everything else keeps the harness's
// existing one-retry-on-non-success behaviour.
test("budgeted + budget_exceeded -> the retry is skipped", () => {
  const stopped = {
    status: "budget_exceeded",
    summary: { budget_exceeded: true, files_reviewed: 2 },
  };
  assert.equal(skipRetryAfterBudgetStop(stopped, 25_000), true);
});

test("budgeted but NOT budget-stopped (an ordinary failure) -> the retry still fires", () => {
  const failed = { status: "failed", summary: { budget_exceeded: false, files_reviewed: 0 } };
  assert.equal(skipRetryAfterBudgetStop(failed, 25_000), false);
});

// The double gate: even if an unbudgeted engine ever reported budget_exceeded, the unbudgeted
// case's behaviour must not change — its measurement basis predates this module.
test("unbudgeted + budget_exceeded (paranoia case) -> today's behaviour, retry fires", () => {
  const stopped = { status: "failed", summary: { budget_exceeded: true } };
  assert.equal(skipRetryAfterBudgetStop(stopped, undefined), false);
});

test("a malformed result (no summary) never skips the retry", () => {
  assert.equal(skipRetryAfterBudgetStop({ status: "failed" }, 25_000), false);
  assert.equal(skipRetryAfterBudgetStop(undefined, 25_000), false);
});

test("a budget-pressure clean case cannot earn precision credit unless the stop occurred", () => {
  const didNotStop = { status: "success", summary: { budget_exceeded: false } };
  assert.deepEqual(scoreCleanCase(didNotStop, 25_000, 0), {
    pass: false,
    detail: "UNMEASURED: budget pressure did not trigger",
  });
  assert.deepEqual(
    scoreCleanCase({ status: "budget_exceeded", summary: { budget_exceeded: true } }, 25_000, 0),
    { pass: true, detail: "silent" },
  );
  assert.deepEqual(scoreCleanCase(didNotStop, undefined, 0), { pass: true, detail: "silent" });
  assert.deepEqual(scoreCleanCase(didNotStop, undefined, 2), {
    pass: false,
    detail: "2 unwanted finding(s)",
  });
  assert.throws(() => scoreCleanCase(didNotStop, undefined, -1), /non-negative safe integer/u);
  assert.throws(() => scoreCleanCase(didNotStop, undefined, 1.5), /non-negative safe integer/u);
});

test("engineEvidence records the stop, the progress, and the coverage question", () => {
  const evidence = engineEvidence({
    status: "failed",
    summary: { budget_exceeded: true, files_reviewed: 2, total_tokens: 24_812 },
    manifest: { coverage: { selected: [{ path: "a" }], completed: [{ path: "a" }], failed: [] } },
  });
  assert.deepEqual(evidence, {
    status: "failed",
    budget_exceeded: true,
    files_reviewed: 2,
    total_tokens: 24_812,
    manifest_present: true,
    coverage: { selected: 1, completed: 1, reused: 0, failed: 0, waived: 0 },
  });
});

// The shape the field documentation predicts (settle.ts: "no released engine emits a manifest") —
// evidence must say so honestly rather than fabricating empty lists.
test("engineEvidence reports an absent manifest as absent, not as empty coverage", () => {
  const evidence = engineEvidence({
    status: "failed",
    summary: { budget_exceeded: true, files_reviewed: 1, total_tokens: 6_100 },
  });
  assert.equal(evidence.manifest_present, false);
  assert.equal(evidence.coverage, null);
});
