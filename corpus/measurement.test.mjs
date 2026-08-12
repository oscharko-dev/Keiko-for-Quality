import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyMeasurement } from "./measurement.mjs";

const ran = (tokens) => ({ kind: "recall", tokens });
const threw = () => ({ kind: "error", tokens: 0 });

test("a run that reached the model is measured", () => {
  const { measured, errored } = classifyMeasurement([ran(1200), ran(900)], 2100);
  assert.equal(measured, true);
  assert.equal(errored, 0);
});

/**
 * The regression this module exists for. A misconfigured endpoint produced exactly this shape —
 * every case in the error branch, zero tokens — and the harness scored it as "recall 0/19", which
 * reads as a total quality collapse and sent the investigation after a regression that did not
 * exist. Refusing to score is the only honest output.
 */
test("a run where every case threw before the model is NOT measured", () => {
  const { measured, errored, attempted } = classifyMeasurement([threw(), threw(), threw()], 0);
  assert.equal(measured, false);
  assert.equal(errored, 3);
  assert.equal(attempted, 3);
});

test("an all-error run that spent tokens reports a harness failure, not an unreachable model", () => {
  const lateThrow = { kind: "error", tokens: 500 };
  const measurement = classifyMeasurement([lateThrow, lateThrow], 1_000);
  assert.deepEqual(measurement, {
    measured: false,
    reason: "harness_failed",
    errored: 2,
    attempted: 2,
  });
});

test("zero tokens is not measured even when cases did not throw", () => {
  // The engine can exit cleanly having dispatched nothing — a budget of zero, an empty inventory,
  // a stub. Cases that produced no model call cannot score the model.
  assert.equal(classifyMeasurement([ran(0), ran(0)], 0).measured, false);
});

test("a partial outage still measures, and reports what was lost", () => {
  // Some cases reached the model, so the scores over the rest are real — but the caller has to be
  // able to say that N cases were lost to the harness rather than to the reviewer.
  const { measured, errored, attempted } = classifyMeasurement([ran(800), threw(), ran(700)], 1500);
  assert.equal(measured, true);
  assert.equal(errored, 1);
  assert.equal(attempted, 3);
});

test("an empty run is not measured", () => {
  assert.equal(classifyMeasurement([], 0).measured, false);
});
