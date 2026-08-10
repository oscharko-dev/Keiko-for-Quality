import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateSonarPullRequest,
  executeSonarPullRequestGateCli,
  finiteNumber,
  isAnalyzableChange,
  measuresFromPayload,
  runSonarPullRequestGate,
  runSonarPullRequestGateCli,
  sonarJson,
} from "./check-sonar-pr-quality-gate.mjs";
import {
  KEIKO_GATE_CONDITIONS,
  KEIKO_GATE_ID,
  KEIKO_GATE_NAME,
} from "./sonar-quality-gate-contract.mjs";

const headSha = "a".repeat(40);
const passingMeasures = {
  new_coverage: 86,
  new_duplicated_lines: 0,
  new_duplicated_lines_density: 0,
  new_lines: 50,
  new_lines_to_cover: 20,
  new_maintainability_rating: 1,
  new_reliability_rating: 1,
  new_security_hotspots: 0,
  new_security_hotspots_reviewed: 100,
  new_security_rating: 1,
  new_violations: 0,
};
const passingRatings = {
  new_maintainability_rating: 1,
  new_reliability_rating: 1,
  new_security_rating: 1,
};
const passingOverallMeasures = { security_hotspots: 0, security_hotspots_reviewed: 100 };
const passingGate = {
  conditions: KEIKO_GATE_CONDITIONS,
  id: Number(KEIKO_GATE_ID),
  name: KEIKO_GATE_NAME,
};

function evaluate(overrides) {
  return evaluateSonarPullRequest({
    analysis: { commitSha: headSha, qualityGateStatus: "OK" },
    customGate: passingGate,
    headSha,
    issuesTotal: 0,
    measures: passingMeasures,
    overallMeasures: passingOverallMeasures,
    ...(overrides ?? {}),
  });
}

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
  if (path.includes("project_pull_requests")) {
    return {
      pullRequests: [{ commit: { sha: headSha }, key: "42", status: { qualityGateStatus: "OK" } }],
    };
  }
  if (path.includes("issues/search")) return { total: 0 };
  if (path.includes("qualitygates/show")) return passingGate;
  if (path.includes("metricKeys=security_hotspots")) {
    return measurePayload(passingOverallMeasures, false);
  }
  return measurePayload(passingMeasures);
}

describe("SonarCloud pull-request evidence gate", () => {
  it("accepts exact-head, zero-issue evidence", () => {
    assert.deepEqual(evaluate(), []);
  });

  it("rejects a stale analysis and every nonzero issue count", () => {
    const failures = evaluate({
      analysis: { commitSha: "b".repeat(40), qualityGateStatus: "OK" },
      issuesTotal: 1,
    });
    assert(failures.includes("SonarCloud analysis is not bound to the current head commit."));
    assert(failures.includes("SonarCloud reports 1 unresolved issue(s)."));
    assert(evaluate({ issuesTotal: -1 }).includes("SonarCloud reports -1 unresolved issue(s)."));
    assert(
      evaluate({ measures: { ...passingMeasures, new_violations: -1 } }).includes(
        "SonarCloud reports -1 new violation(s).",
      ),
    );
  });

  it("enforces 85% coverage, 3% duplication, zero violations, and reviewed hotspots", () => {
    const failures = evaluate({
      measures: {
        ...passingMeasures,
        new_coverage: 84.9,
        new_duplicated_lines: 1,
        new_duplicated_lines_density: 3.1,
        new_security_hotspots: 1,
        new_security_hotspots_reviewed: 99,
        new_violations: 1,
      },
      overallMeasures: { security_hotspots: 1, security_hotspots_reviewed: 99 },
    });
    assert.deepEqual(failures, [
      "SonarCloud reports 1 new violation(s).",
      "New-code coverage condition failed at 84.9%.",
      "New-code duplication condition failed at 3.1%.",
      "New-code security-hotspot review condition failed at 99%.",
      "Overall security-hotspot review condition failed at 99%.",
    ]);
  });

  it("loads all three rating conditions directly and accepts only Sonar rating A", () => {
    const failures = evaluate({
      measures: {
        ...passingMeasures,
        new_maintainability_rating: 2,
        new_reliability_rating: undefined,
        new_security_rating: 0,
      },
    });
    assert.deepEqual(
      failures.filter((failure) => failure.includes("rating")),
      [
        "New-code maintainability rating condition failed at 2.",
        "New-code reliability rating metric is missing.",
        "New-code security rating metric is invalid.",
      ],
    );
  });

  it("allows missing new-code rate metrics only for a non-coverable change", () => {
    assert.deepEqual(
      evaluate({ analyzable: false, measures: { ...passingRatings, new_violations: 0 } }),
      [],
    );
    const applicableFailures = evaluate({
      analyzable: true,
      measures: { ...passingRatings, new_violations: 0 },
    });
    assert.equal(
      applicableFailures.filter((failure) => failure === "New-code line count metric is missing.")
        .length,
      1,
    );
  });

  it("fails closed with deterministic evidence failures when measures are omitted", () => {
    const failures = evaluate({ measures: undefined });
    assert(failures.includes("New-code violation metric is missing."));
    assert(failures.includes("New-code maintainability rating metric is missing."));
    assert(failures.includes("New-code line count metric is missing."));
  });

  it("classifies source and test-only diffs without reading the checkout", () => {
    const execute = (git, _arguments, options) => {
      assert.equal(git, "/usr/bin/git");
      assert.equal(options.encoding, "utf8");
      return "M\tREADME.md\nM\tsrc/review.test.ts\n";
    };
    assert.equal(isAnalyzableChange({ base: "b".repeat(40), execute, head: headSha }), false);
    assert.equal(
      isAnalyzableChange({
        base: "b".repeat(40),
        execute: () => "M\tscripts/check-sonar-pr-quality-gate.mjs\n",
        head: headSha,
      }),
      true,
    );
    assert.equal(isAnalyzableChange(), true);
    for (const input of [
      { base: "0".repeat(40), head: headSha },
      { base: "not-a-commit", head: headSha },
      { base: "b".repeat(40), head: "not-a-commit" },
      { base: "b".repeat(40), head: "0".repeat(40) },
    ]) {
      assert.equal(
        isAnalyzableChange({
          ...input,
          execute: () => assert.fail("invalid ids must not run git"),
        }),
        true,
      );
    }
  });

  it("parses all supported Sonar measure shapes", () => {
    assert.deepEqual(
      measuresFromPayload({
        component: {
          measures: [
            { metric: "period", period: { value: "1" } },
            { metric: "periods", periods: [{ value: "2" }] },
            { metric: "value", value: "3" },
            { metric: "invalid", value: "not-a-number" },
          ],
        },
      }),
      { invalid: undefined, period: 1, periods: 2, value: 3 },
    );
  });

  it("accepts only finite numbers and canonical numeric strings", () => {
    for (const [value, expected] of [
      [0, 0],
      [1.25, 1.25],
      ["0", 0],
      ["-1.25", -1.25],
      ["1.25e2", 125],
    ]) {
      assert.equal(finiteNumber(value), expected);
    }
    for (const value of [false, [], " ", "\t", "0x0", "+0", "00", Number.NaN, Infinity]) {
      assert.equal(finiteNumber(value), undefined);
    }
  });

  it("fails closed when PR issue or measure evidence is coercible but nonnumeric", async () => {
    for (const malformed of [false, [], " \t"]) {
      await assert.rejects(
        runSonarPullRequestGate({
          base: "b".repeat(40),
          execute: () => "M\tsrc/review.ts\n",
          headSha,
          load: async (path) =>
            path.includes("issues/search") ? { total: malformed } : passingLoad(path),
          pullRequest: "42",
        }),
        /SonarCloud issue total is missing/u,
      );
      await assert.rejects(
        runSonarPullRequestGate({
          base: "b".repeat(40),
          execute: () => "M\tsrc/review.ts\n",
          headSha,
          load: async (path) => {
            if (!path.includes("metricKeys=new_coverage")) return passingLoad(path);
            const payload = measurePayload(passingMeasures);
            const measure = payload.component.measures.find(
              (candidate) => candidate.metric === "new_violations",
            );
            measure.periods[0].value = malformed;
            return payload;
          },
          pullRequest: "42",
        }),
        /New-code violation metric is missing/u,
      );
    }
  });

  it("loads the live-shaped API evidence and emits a commit-bound receipt", async () => {
    const logs = [];
    const paths = [];
    await runSonarPullRequestGate({
      base: "b".repeat(40),
      execute: () => "M\tsrc/review.ts\n",
      headSha,
      load: async (path) => {
        paths.push(path);
        return passingLoad(path);
      },
      log: (message) => logs.push(message),
      pullRequest: "42",
      token: "redacted",
    });
    assert.deepEqual(logs, [`sonar-pr-quality-gate: PASS - PR #42 is clean at ${headSha}.`]);
    const measurePath = paths.find(
      (path) => path.includes("metricKeys=new_coverage") && path.includes("pullRequest=42"),
    );
    assert.match(measurePath, /new_maintainability_rating/u);
    assert.match(measurePath, /new_reliability_rating/u);
    assert.match(measurePath, /new_security_rating/u);
  });

  it("adapts CLI variables and fails closed without required identity", async () => {
    const calls = [];
    await runSonarPullRequestGateCli({
      env: {
        SONAR_BASE_SHA: "b".repeat(40),
        SONAR_HEAD_SHA: headSha,
        SONAR_PULL_REQUEST: "42",
        SONAR_TOKEN: "redacted",
      },
      run: async (input) => calls.push(input),
    });
    assert.deepEqual(calls, [
      {
        base: "b".repeat(40),
        headSha,
        pullRequest: "42",
        token: "redacted",
      },
    ]);
    const errors = [];
    const exits = [];
    await executeSonarPullRequestGateCli({
      env: {},
      error: (message) => errors.push(message),
      setExitCode: (value) => exits.push(value),
    });
    assert.deepEqual(errors, [
      "sonar-pr-quality-gate: FAIL - SONAR_PULL_REQUEST and SONAR_HEAD_SHA are required.",
    ]);
    assert.deepEqual(exits, [1]);
  });

  it("uses authenticated requests without exposing the token in failures", async () => {
    let observed;
    const payload = await sonarJson("/api/example", "secret", async (url, options) => {
      observed = { options, url };
      return { json: async () => ({ ok: true }), ok: true, status: 200 };
    });
    assert.deepEqual(payload, { ok: true });
    assert.equal(observed.options.headers.Authorization, "Bearer secret");
    for (const token of [undefined, ""]) {
      await sonarJson("/api/example", token, async (url, options) => {
        observed = { options, url };
        return { json: async () => ({}), ok: true, status: 200 };
      });
      assert.deepEqual(observed.options.headers, {});
    }
    await assert.rejects(
      sonarJson("/api/example", "secret", async () => ({ ok: false, status: 503 })),
      { message: "SonarCloud API returned 503." },
    );
  });
});
