import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HISTORICAL_REPLAY_DIAGNOSTIC_ARTIFACT,
  buildHistoricalReplayDiagnostic,
  validateHistoricalReplayDiagnostic,
} from "./historical-replay-diagnostic-lib.mjs";
import { validateHistoricalReplayEvidence } from "./historical-replay-evidence-lib.mjs";

function cases() {
  return [
    {
      databaseId: 11,
      stage: "binding",
      disposition: "unmeasured",
      reasonCode: "missing_historical_binding",
      usage: { callCount: 0, tokens: 0 },
    },
    {
      databaseId: 12,
      stage: "challenge_planner",
      disposition: "undecided",
      reasonCode: "json_or_envelope_invalid",
      usage: { callCount: 2, tokens: 180 },
    },
    {
      databaseId: 13,
      stage: "falsifier",
      disposition: "kept",
      reasonCode: "no_defeater_found",
      usage: { callCount: 3, tokens: 320 },
    },
  ];
}

test("builds the exact text-free per-case diagnostic and never passes as release evidence", () => {
  const diagnostic = buildHistoricalReplayDiagnostic({
    databaseIds: [11, 12, 13],
    cases: cases(),
    attemptedCases: 2,
    accountedTokens: 500,
  });

  assert.equal(diagnostic.artifact, HISTORICAL_REPLAY_DIAGNOSTIC_ARTIFACT);
  assert.equal(validateHistoricalReplayDiagnostic(diagnostic), true);
  assert.deepEqual(validateHistoricalReplayEvidence(diagnostic), {
    valid: false,
    failures: ["root_shape"],
  });
  assert.deepEqual(Object.keys(diagnostic).sort(), ["artifact", "cases", "schemaVersion"]);
  assert.deepEqual(Object.keys(diagnostic.cases[1]).sort(), [
    "databaseId",
    "disposition",
    "reasonCode",
    "stage",
    "usage",
  ]);
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /path|body|evidence|prompt|response|model|label|reply/iu,
  );
});

test("a negative challenge search is a kept trace but a negative truth search is not", () => {
  const challengeNoMatch = {
    databaseId: 21,
    stage: "challenge_retrieval",
    disposition: "kept",
    reasonCode: "retrieval_no_match",
    usage: { callCount: 2, tokens: 200 },
  };
  const diagnostic = buildHistoricalReplayDiagnostic({
    databaseIds: [21],
    cases: [challengeNoMatch],
    attemptedCases: 1,
    accountedTokens: 200,
  });

  assert.equal(validateHistoricalReplayDiagnostic(diagnostic), true);
  assert.equal(
    validateHistoricalReplayDiagnostic({
      ...diagnostic,
      cases: [{ ...challengeNoMatch, stage: "truth_retrieval" }],
    }),
    false,
  );
});

test("accepts a zero-token closed direct proof as an attempted kept case", () => {
  const directProof = {
    databaseId: 22,
    stage: "truth_initial",
    disposition: "kept",
    reasonCode: "direct_proof",
    usage: { callCount: 0, tokens: 0 },
  };
  const diagnostic = buildHistoricalReplayDiagnostic({
    databaseIds: [22],
    cases: [directProof],
    attemptedCases: 1,
    accountedTokens: 0,
  });

  assert.equal(validateHistoricalReplayDiagnostic(diagnostic), true);
  assert.equal(
    validateHistoricalReplayDiagnostic({
      ...diagnostic,
      cases: [{ ...directProof, disposition: "refuted" }],
    }),
    false,
  );
});

test("rejects extra text, open vocabularies, reordered ids, and accounting mismatches", () => {
  const extra = {
    schemaVersion: 1,
    artifact: HISTORICAL_REPLAY_DIAGNOSTIC_ARTIFACT,
    cases: cases().map((entry) => ({ ...entry })),
    findingBody: "must not fit",
  };
  assert.equal(validateHistoricalReplayDiagnostic(extra), false);

  const freeReason = {
    schemaVersion: 1,
    artifact: HISTORICAL_REPLAY_DIAGNOSTIC_ARTIFACT,
    cases: [{ ...cases()[0], reasonCode: "some prose" }],
  };
  assert.equal(validateHistoricalReplayDiagnostic(freeReason), false);

  assert.throws(
    () =>
      buildHistoricalReplayDiagnostic({
        databaseIds: [12, 11, 13],
        cases: cases(),
        attemptedCases: 2,
        accountedTokens: 500,
      }),
    /requested population/u,
  );
  assert.throws(
    () =>
      buildHistoricalReplayDiagnostic({
        databaseIds: [11, 12, 13],
        cases: cases(),
        attemptedCases: 3,
        accountedTokens: 500,
      }),
    /execution accounting/u,
  );
  assert.throws(
    () =>
      buildHistoricalReplayDiagnostic({
        databaseIds: [11, 12, 13],
        cases: cases(),
        attemptedCases: 2,
        accountedTokens: 499,
      }),
    /execution accounting/u,
  );
});
