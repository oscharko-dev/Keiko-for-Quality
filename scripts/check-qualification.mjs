#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { CASES } from "../corpus/cases.mjs";
import { cliPathArgument } from "./cli-args.mjs";
import {
  QUALIFICATION_EVIDENCE_ARTIFACT,
  validateQualificationEvidence,
} from "./qualification-evidence-lib.mjs";

/**
 * Applies the promotion thresholds to a corpus report.
 *
 * Separating this from `corpus/run.mjs` is deliberate. The runner answers "what happened"; this
 * answers "is that good enough to keep shipping". A scheduled re-qualification needs the second
 * question to have a stable, reviewable definition that does not move every time the corpus grows.
 *
 * Classification is measured but not gated. Severity at the critical/high boundary has residual
 * variance the rule text cannot remove — the same defect class has come back one step apart inside
 * a single run — and severity is presentation-only in this product: it gates nothing, blocks
 * nothing, and changes no decision. Gating on it would fail releases over a label.
 *
 * Usage: node scripts/check-qualification.mjs <report.json>
 */

const THRESHOLDS = {
  /** Every seeded critical or high defect must be found. A missed one is the failure that matters. */
  severeRecall: 1,
  /** A reviewer that fires on clean changes trains its readers to ignore it. */
  precision: 0.95,
  /** A finding that cannot be published is not a review. */
  publishable: 1,
};

const reportPath = cliPathArgument(process.argv[2], {
  usage: "usage: check-qualification.mjs <report.json>",
  mustEndWith: ".json",
});

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const isRedactedEvidence = report?.artifact === QUALIFICATION_EVIDENCE_ARTIFACT;
if (isRedactedEvidence) {
  const schema = validateQualificationEvidence(report);
  if (!schema.valid) {
    console.error(`FAIL qualification evidence schema: ${schema.failures.join(", ")}`);
    process.exit(1);
  }
}
const byId = new Map((report.results ?? []).map((r) => [r.id, r]));

/**
 * Every denominator comes from the corpus definition, never from the report.
 *
 * Deriving them from the report lets a case that crashed — or never ran at all — leave both sides
 * of its fraction and silently raise the score. Selecting precision cases by the result's `kind`
 * did exactly that: a thrown case is recorded as `kind: "error"`, so one crash among five clean
 * cases produced 4/4 = 100% precision and a passing threshold over a case that never executed.
 * A missing result is now a failure, which is the only reading that cannot flatter a broken run.
 */
function score(predicate) {
  const selected = CASES.filter(predicate);
  const passed = selected.filter((c) => byId.get(c.id)?.pass === true).length;
  return { value: selected.length === 0 ? 1 : passed / selected.length, of: selected.length };
}

const isSevere = (c) => c.defect !== null && ["critical", "high"].includes(c.defect.severity);
function rejectionCount(result) {
  if (Number.isSafeInteger(result?.rejectedCount) && result.rejectedCount >= 0) {
    return result.rejectedCount;
  }
  return Array.isArray(result?.rejected) ? result.rejected.length : 1;
}

const publishedCleanly = (c) => rejectionCount(byId.get(c.id)) === 0;

const measured = {
  severeRecall: score(isSevere),
  precision: score((c) => c.defect === null),
  publishable: {
    value: CASES.filter(publishedCleanly).length / CASES.length,
    of: CASES.length,
  },
};

const failures = [];
for (const [name, floor] of Object.entries(THRESHOLDS)) {
  const { value, of } = measured[name];
  const line =
    `${name.padEnd(13)} ${(value * 100).toFixed(1)}% of ${String(of)} ` +
    `(floor ${(floor * 100).toFixed(1)}%)`;
  if (value < floor) {
    failures.push(line);
    console.error(`FAIL ${line}`);
  } else {
    console.log(`ok   ${line}`);
  }
}

// Named individually rather than counted: a re-qualification issue that says "1 case regressed" is
// not actionable, and the case id is the only part of a failure that is safe to publish. Absent
// results are named too — "the case did not run" and "the case failed" are different problems and
// only one of them is about review quality.
for (const testCase of CASES) {
  const result = byId.get(testCase.id);
  if (result === undefined) {
    console.log(`     absent:    ${testCase.id} — no result in the report`);
  } else if (result.pass !== true) {
    const detail = isRedactedEvidence
      ? [
          `kind=${String(result.kind)}`,
          `findings=${String(result.findingCount)}`,
          `tokens=${String(result.tokens)}`,
          `rejected=${String(result.rejectedCount)}`,
          `sanitizer=${String(result.rejectedSanitization)}`,
          `suppressed=${String(result.suppressedIntraRun)}`,
        ].join(", ")
      : String(result.detail);
    console.log(`     regressed: ${testCase.id} — ${detail}`);
  }
}

const binding = report.binding;
if (binding !== undefined) {
  console.log(
    `     measured with adapter ${String(binding.adapter.version)} @ ${String(binding.adapter.commit).slice(0, 12)}, ` +
      `engine ${String(binding.engine.sha256).slice(0, 12)}, rule ${String(binding.rule.sha256).slice(0, 12)}, ` +
      `model ${String(binding.model.id)} (${String(binding.model.protocol)}), ` +
      `strictness ${String(binding.strictness)}`,
  );
}

// --- Reported-only trend lines -----------------------------------------------------------------
//
// Cost-per-finding has no home anywhere else in this repository — corpus/run.mjs computes these
// same numbers first, per run. They ride along on every qualification report for that reason, but
// they are deliberately NOT folded into the pass/fail verdict above: this file already treats
// severity the same way (presentation-only, gates nothing — see the file's own doc comment), and a
// token or noise count moving is a trend worth a maintainer's attention, not a release blocker.
//
// A report written before corpus/run.mjs grew an `aggregates` block carries no such field at all —
// every number below is computed straight from `report.results` (and `CASES`, the same denominator
// source the thresholds above use) whenever `aggregates`, or the specific field read from it, is
// absent, so this file reads an old report exactly as it always could.
console.log("");
console.log("trend (reported only — does not gate promotion):");

const reportResults = report.results ?? [];
const totalTokens =
  typeof report.tokens === "number"
    ? report.tokens
    : reportResults.reduce((sum, r) => sum + (typeof r.tokens === "number" ? r.tokens : 0), 0);
const totalNoise = reportResults.reduce(
  (sum, r) => sum + (typeof r.noise === "number" ? r.noise : 0),
  0,
);
// Recomputed from CASES + byId rather than read from `report.aggregates.severeHits`, so this
// fallback can never disagree with the severeRecall verdict printed above over the very same
// report — both walk the identical `isSevere` selection.
const severeHitsFallback = CASES.filter(isSevere).filter(
  (c) => byId.get(c.id)?.pass === true,
).length;
// Named and computed up front rather than nested inside the choice below: the ratio is pure
// arithmetic over numbers already in hand, so evaluating it even when the report carries its own
// `aggregates` costs nothing and leaves one flat question — reported, or recomputed — at the
// point of use. `null` is the no-severe-hits answer, and stays distinct from the `undefined` an
// `aggregates` block without the field yields; the printer below folds both to "n/a".
const recomputedTokensPerSevereHit =
  severeHitsFallback > 0 ? Math.round(totalTokens / severeHitsFallback) : null;
const tokensPerSevereHit =
  report.aggregates !== undefined
    ? report.aggregates.tokensPerSevereHit
    : recomputedTokensPerSevereHit;

console.log(`     ${"tokens".padEnd(18)} ${String(totalTokens)} total`);
console.log(
  `     ${"tokens/severe-hit".padEnd(18)} ` +
    (tokensPerSevereHit === null || tokensPerSevereHit === undefined
      ? "n/a"
      : String(tokensPerSevereHit)),
);
console.log(
  `     ${"noise".padEnd(18)} ${String(totalNoise)} finding(s) not about the seeded defect`,
);

process.exitCode = failures.length === 0 ? 0 : 1;
