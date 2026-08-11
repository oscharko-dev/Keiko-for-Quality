import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KEIKO_GATE_CONDITIONS,
  KEIKO_GATE_ID,
  KEIKO_GATE_NAME,
  REPOSITORY_GATE_CONTRACT,
  countAwareRateFailures,
  gateContractFailures,
} from "./sonar-quality-gate-contract.mjs";

describe("Sonar Free-plan gate contract", () => {
  it("pins the Keiko Banking Grade conditions and the zero-open-issue policy", () => {
    assert.deepEqual(REPOSITORY_GATE_CONTRACT, {
      nativeGateStatus: "OK",
      newCodeCoverageMinimum: 85,
      newCodeDuplicationMaximum: 3,
      newCodeHotspotReviewMinimum: 100,
      newCodeRatingMaximum: 1,
      newViolationsMaximum: 0,
      overallHotspotReviewMinimum: 100,
      unresolvedIssuesMaximum: 0,
    });
  });

  it("accepts the exact public gate independent of condition order", () => {
    assert.deepEqual(
      gateContractFailures({
        conditions: [...KEIKO_GATE_CONDITIONS].reverse(),
        id: Number(KEIKO_GATE_ID),
        name: KEIKO_GATE_NAME,
      }),
      [],
    );
  });

  it("rejects missing, renamed, and condition-drifted definitions", () => {
    assert.deepEqual(gateContractFailures(undefined), [
      "Keiko Banking Grade definition is missing.",
    ]);
    assert.deepEqual(gateContractFailures({ conditions: [], id: "9", name: "Sonar way" }), [
      "Keiko Banking Grade identity does not match the governed contract.",
      "Keiko Banking Grade conditions drifted from the repository contract.",
    ]);
    for (const malformed of [null, "Sonar way", [], 1]) {
      assert.deepEqual(gateContractFailures(malformed), [
        "Keiko Banking Grade definition is missing.",
      ]);
    }
    assert.deepEqual(
      gateContractFailures({ conditions: [null], id: 156389, name: KEIKO_GATE_NAME }),
      ["Keiko Banking Grade conditions drifted from the repository contract."],
    );
  });

  it("fails closed for missing applicability evidence", () => {
    const base = { label: "Coverage", violates: (value) => value < 85 };
    assert.deepEqual(countAwareRateFailures({ ...base, count: undefined, rate: undefined }), [
      "Coverage applicability count is missing.",
    ]);
    assert.deepEqual(countAwareRateFailures({ ...base, count: 0, rate: undefined }), []);
    assert.deepEqual(countAwareRateFailures({ ...base, count: 2, rate: undefined }), [
      "Coverage rate is missing despite a positive applicability count.",
    ]);
    assert.deepEqual(countAwareRateFailures({ ...base, count: 2, rate: 84.9 }), [
      "Coverage condition failed at 84.9%.",
    ]);
    assert.deepEqual(countAwareRateFailures({ ...base, count: -1, rate: 90 }), [
      "Coverage applicability count is invalid.",
    ]);
    for (const rate of [-1, 101]) {
      assert.deepEqual(countAwareRateFailures({ ...base, count: 2, rate }), [
        "Coverage rate is invalid.",
      ]);
    }
  });
});
