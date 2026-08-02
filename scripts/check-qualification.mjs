#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { CASES } from "../corpus/cases.mjs";

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

const reportPath = process.argv[2];
if (reportPath === undefined) {
  console.error("usage: check-qualification.mjs <report.json>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
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
const publishedCleanly = (c) => (byId.get(c.id)?.rejected ?? [{}]).length === 0;

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
    console.log(`     regressed: ${testCase.id} — ${String(result.detail)}`);
  }
}

const binding = report.binding;
if (binding !== undefined) {
  console.log(
    `     measured with adapter ${String(binding.adapter.version)} @ ${String(binding.adapter.commit).slice(0, 12)}, ` +
      `engine ${String(binding.engine.sha256).slice(0, 12)}, rule ${String(binding.rule.sha256).slice(0, 12)}, ` +
      `model ${String(binding.model.id)} (${String(binding.model.protocol)})`,
  );
}

process.exitCode = failures.length === 0 ? 0 : 1;
