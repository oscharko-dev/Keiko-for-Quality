import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  executeSonarMainGateCli,
  runSonarMainGate,
  runSonarMainGateCli,
} from "./check-sonar-main-quality-gate.mjs";
import {
  KEIKO_GATE_CONDITIONS,
  KEIKO_GATE_ID,
  KEIKO_GATE_NAME,
} from "./sonar-quality-gate-contract.mjs";

const headSha = "a".repeat(40);
const newMeasures = {
  new_coverage: 90,
  new_duplicated_lines: 0,
  new_duplicated_lines_density: 0,
  new_lines: 100,
  new_lines_to_cover: 50,
  new_maintainability_rating: 1,
  new_reliability_rating: 1,
  new_security_hotspots: 0,
  new_security_hotspots_reviewed: 100,
  new_security_rating: 1,
  new_violations: 0,
};
const overallMeasures = { security_hotspots: 0, security_hotspots_reviewed: 100 };
const customGate = {
  conditions: KEIKO_GATE_CONDITIONS,
  id: Number(KEIKO_GATE_ID),
  name: KEIKO_GATE_NAME,
};

function measurePayload(measures, period = true) {
  return {
    component: {
      measures: Object.entries(measures).map(([metric, value]) =>
        period ? { metric, periods: [{ value: String(value) }] } : { metric, value: String(value) },
      ),
    },
  };
}

function passingLoad(path) {
  if (path.includes("project_analyses")) return { analyses: [{ revision: headSha }] };
  if (path.includes("project_status")) return { projectStatus: { status: "OK" } };
  if (path.includes("issues/search")) return { total: 0 };
  if (path.includes("qualitygates/show")) return customGate;
  if (path.includes("metricKeys=security_hotspots")) return measurePayload(overallMeasures, false);
  return measurePayload(newMeasures);
}

describe("SonarCloud dev evidence gate", () => {
  it("accepts exact clean dev evidence", async () => {
    const logs = [];
    await runSonarMainGate({
      headSha,
      load: async (path) => passingLoad(path),
      log: (message) => logs.push(message),
    });
    assert.deepEqual(logs, [`sonar-main-quality-gate: PASS - dev is clean at ${headSha}.`]);
  });

  it("queries all unresolved dev issues, not only the leak period", async () => {
    const paths = [];
    await runSonarMainGate({
      headSha,
      load: async (path) => {
        paths.push(path);
        return passingLoad(path);
      },
      log: () => undefined,
    });
    const issuePath = paths.find((path) => path.includes("issues/search"));
    const measurePath = paths.find((path) => path.includes("metricKeys=new_coverage"));
    assert(issuePath.includes("branch=dev"));
    assert.equal(issuePath.includes("sinceLeakPeriod"), false);
    assert.match(measurePath, /new_maintainability_rating/u);
    assert.match(measurePath, /new_reliability_rating/u);
    assert.match(measurePath, /new_security_rating/u);
  });

  it("rejects any inherited open issue and stale analyses", async () => {
    await assert.rejects(
      runSonarMainGate({
        headSha,
        load: async (path) => (path.includes("issues/search") ? { total: 1 } : passingLoad(path)),
      }),
      /1 unresolved issue/u,
    );
    await assert.rejects(
      runSonarMainGate({
        headSha,
        load: async (path) =>
          path.includes("project_analyses")
            ? { analyses: [{ revision: "b".repeat(40) }] }
            : passingLoad(path),
      }),
      /current head commit/u,
    );
  });

  it("rejects a missing or non-A rating on dev", async () => {
    await assert.rejects(
      runSonarMainGate({
        headSha,
        load: async (path) =>
          path.includes("metricKeys=new_coverage")
            ? measurePayload({
                ...newMeasures,
                new_reliability_rating: 2,
                new_security_rating: undefined,
              })
            : passingLoad(path),
      }),
      /reliability rating condition failed at 2.*security rating metric is missing/u,
    );
  });

  it("adapts CLI variables and reports missing revision input", async () => {
    const calls = [];
    await runSonarMainGateCli({
      env: { SONAR_HEAD_SHA: headSha, SONAR_TOKEN: "redacted" },
      run: async (input) => calls.push(input),
    });
    assert.deepEqual(calls, [{ headSha, token: "redacted" }]);
    const errors = [];
    const exits = [];
    await executeSonarMainGateCli({
      env: {},
      error: (message) => errors.push(message),
      setExitCode: (value) => exits.push(value),
    });
    assert.deepEqual(errors, ["sonar-main-quality-gate: FAIL - SONAR_HEAD_SHA is required."]);
    assert.deepEqual(exits, [1]);
  });
});
