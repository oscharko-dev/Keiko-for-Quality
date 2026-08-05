import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkQualificationModel,
  DEVIATION_ENV,
  QUALIFICATION_MODEL,
} from "./qualification-model.mjs";

/**
 * The guard that refuses a paid run against the wrong model.
 *
 * `QUALIFICATION_MODEL` is imported rather than restated, unlike the module-private constants
 * `guidelines.test.ts` deliberately writes out: this one is not a boundary to pin against drift,
 * it is the single source of truth two call sites and a workflow already read. Restating it here
 * would create a second place to change and a way for the two to disagree.
 */

test("accepts the pinned model", () => {
  const result = checkQualificationModel({ OCR_LLM_MODEL: QUALIFICATION_MODEL });
  assert.equal(result.ok, true);
  assert.equal(result.allowed, false);
});

test("tolerates surrounding whitespace, which a shell export easily introduces", () => {
  assert.equal(checkQualificationModel({ OCR_LLM_MODEL: `  ${QUALIFICATION_MODEL} ` }).ok, true);
});

// The exact failure this guard exists for: a real, working chat model that this project does not
// measure against. It must be refused precisely BECAUSE it would otherwise produce a plausible,
// fully green report that means nothing about the reviewer that ships.
test("refuses a different model, however valid that model is elsewhere", () => {
  const result = checkQualificationModel({ OCR_LLM_MODEL: "gpt-5.4" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /gpt-5\.4/);
  assert.match(result.reason, new RegExp(QUALIFICATION_MODEL));
});

test("refuses an unset model rather than defaulting it", () => {
  const result = checkQualificationModel({});
  assert.equal(result.ok, false);
  // Named as absent rather than rendered as an empty string, so the message reads correctly for
  // the case where the operator simply forgot to export anything at all.
  assert.match(result.reason, /\(unset\)/);
});

test("refuses an empty model, which an unset shell variable expands to", () => {
  assert.equal(checkQualificationModel({ OCR_LLM_MODEL: "" }).ok, false);
});

test("the reason names both the fix and the escape hatch, since it is read by whoever is stuck", () => {
  const { reason } = checkQualificationModel({ OCR_LLM_MODEL: "something-else" });
  assert.match(reason, /OCR_LLM_MODEL=/);
  assert.match(reason, new RegExp(DEVIATION_ENV));
});

test("allows a deliberate cross-model experiment, and marks it as one", () => {
  const result = checkQualificationModel({
    OCR_LLM_MODEL: "gpt-5.4",
    [DEVIATION_ENV]: "1",
  });
  assert.equal(result.ok, true);
  // `allowed` is what lets the caller print "this is an experiment, not a qualification" — without
  // it a deviating run would be indistinguishable from a compliant one in the output.
  assert.equal(result.allowed, true);
});

// Only the exact string opts out. A truthy-looking value must not: an operator who wrote
// `OCR_ALLOW_MODEL_DEVIATION=true` expecting it to work should find out immediately, not discover
// it in a report footer after paying for the run.
test("only `1` opts out — no truthy-string coercion", () => {
  for (const value of ["true", "yes", "0", " 1", "1 "]) {
    const result = checkQualificationModel({ OCR_LLM_MODEL: "gpt-5.4", [DEVIATION_ENV]: value });
    assert.equal(result.ok, false, `${DEVIATION_ENV}=${JSON.stringify(value)} must not opt out`);
  }
});

// The pin itself. If this ever needs changing, it is a decision about what the product is measured
// against, not a detail to adjust while fixing something else.
test("the pinned model is gpt-oss-120b", () => {
  assert.equal(QUALIFICATION_MODEL, "gpt-oss-120b");
});
