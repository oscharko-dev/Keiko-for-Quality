import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CASES } from "../corpus/cases.mjs";
import {
  QUALIFICATION_EVIDENCE_ARTIFACT,
  redactQualificationReport,
  validateQualificationEvidence,
} from "./qualification-evidence-lib.mjs";

const SECRET = "PRIVATE_FINDING_BODY_must_never_cross_the_boundary";

function binding(overrides = {}) {
  return {
    measuredAt: "2026-08-09T09:00:00.000Z",
    strictness: "default",
    adapter: { version: "0.23.0", commit: "a".repeat(40) },
    engine: { sha256: "b".repeat(64) },
    rule: { sha256: "c".repeat(64) },
    corpus: { cases: "d".repeat(64), scorer: "e".repeat(64) },
    model: { id: "gpt-oss-120b", protocol: "openai", endpointDigest: "f".repeat(64) },
    ...overrides,
  };
}

function rawResult(testCase, index) {
  const seeded = testCase.defect !== null;
  return {
    id: testCase.id,
    kind: seeded ? "recall" : "precision",
    pass: true,
    detail: `${SECRET}_${testCase.id}`,
    findings: seeded
      ? [{ content: SECRET, reply: SECRET, path: `/private/${SECRET}`, unknown: SECRET }]
      : [],
    rejected: [],
    classified: seeded ? true : undefined,
    severityAdjacent: seeded ? false : undefined,
    noise: 0,
    tokens: index + 1,
    rejectedSanitization: 0,
    suppressedIntraRun: index % 2,
    engine: { status: SECRET, stderr: SECRET },
    futureField: SECRET,
  };
}

function rawReport() {
  return {
    measured: true,
    binding: binding(),
    results: CASES.map(rawResult),
    tokens: 999_999_999,
    aggregates: { futureUntrustedSummary: SECRET },
    futureTopLevelField: SECRET,
  };
}

test("redacts raw qualification reports to fixed identifiers, booleans, counts and digests", () => {
  const evidence = redactQualificationReport(rawReport());
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.artifact, QUALIFICATION_EVIDENCE_ARTIFACT);
  assert.equal(evidence.redacted, true);
  assert.equal(evidence.reason, "measured");
  assert.equal(evidence.results.length, CASES.length);
  assert.equal(
    evidence.tokens,
    evidence.results.reduce((sum, result) => sum + result.tokens, 0),
  );
  assert.ok(!serialized.includes(SECRET));
  for (const forbidden of ["findings", "detail", "reply", "engine", "futureField"]) {
    assert.ok(!Object.hasOwn(evidence.results[0], forbidden), forbidden);
  }
  assert.deepEqual(validateQualificationEvidence(evidence), {
    valid: true,
    complete: true,
    failures: [],
  });
});

test("the public schema rejects raw reports, extra fields and inconsistent aggregates", () => {
  const evidence = redactQualificationReport(rawReport());
  assert.equal(validateQualificationEvidence(rawReport()).valid, false);
  assert.equal(
    validateQualificationEvidence({ ...evidence, leakedFindingBody: SECRET }).valid,
    false,
  );
  assert.equal(
    validateQualificationEvidence({
      ...evidence,
      aggregates: { ...evidence.aggregates, severeHits: evidence.aggregates.severeHits + 1 },
    }).valid,
    false,
  );
});

test("aggregate validation is independent of JSON object key order", () => {
  const evidence = redactQualificationReport(rawReport());
  const aggregates = Object.fromEntries(Object.entries(evidence.aggregates).reverse());
  assert.deepEqual(validateQualificationEvidence({ ...evidence, aggregates }), {
    valid: true,
    complete: true,
    failures: [],
  });
});

test("the public schema fails closed for invalid result identities, kinds and counts", () => {
  const mutations = [
    (evidence) => {
      evidence.results[1].id = evidence.results[0].id;
    },
    (evidence) => {
      evidence.results[0].kind = "unknown";
    },
    (evidence) => {
      evidence.results[0].rejectedSanitization = 1;
    },
  ];

  for (const mutate of mutations) {
    const evidence = redactQualificationReport(rawReport());
    mutate(evidence);
    const validation = validateQualificationEvidence(evidence);
    assert.equal(validation.valid, false);
    assert.ok(validation.failures.includes("result_value"));
  }
});

test("the public binding distinguishes substantiation operating points", () => {
  const evidence = redactQualificationReport(rawReport());
  assert.equal(evidence.binding.strictness, "default");
  assert.equal(
    validateQualificationEvidence({
      ...evidence,
      binding: { ...evidence.binding, strictness: "unknown" },
    }).valid,
    false,
  );
});

test("the normal promotion checker reads redacted evidence without private diagnostics", () => {
  const directory = mkdtempSync(join(tmpdir(), "kfq-qualification-evidence-test-"));
  const path = join(directory, "qualification.json");
  try {
    writeFileSync(path, JSON.stringify(redactQualificationReport(rawReport())));
    const output = execFileSync(process.execPath, ["scripts/check-qualification.mjs", path], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    assert.match(output, /severeRecall\s+100\.0%/u);
    assert.match(output, /severeRecall.*floor 85\.0%/u);
    assert.match(output, /precision\s+100\.0%/u);
    assert.ok(!output.includes(SECRET));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the severe-recall floor tolerates four misses but rejects five of thirty", () => {
  const severe = CASES.filter(
    (testCase) =>
      testCase.defect !== null && ["critical", "high"].includes(testCase.defect.severity),
  );
  assert.equal(severe.length, 30);

  for (const [misses, expectedStatus, expectedRate] of [
    [4, 0, "86.7%"],
    [5, 1, "83.3%"],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "kfq-qualification-floor-test-"));
    const path = join(directory, "qualification.json");
    try {
      const raw = rawReport();
      const byId = new Map(raw.results.map((result) => [result.id, result]));
      for (const testCase of severe.slice(0, misses)) {
        const result = byId.get(testCase.id);
        assert.ok(result !== undefined);
        result.pass = false;
      }
      writeFileSync(path, JSON.stringify(redactQualificationReport(raw)));
      const checked = spawnSync(process.execPath, ["scripts/check-qualification.mjs", path], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });
      assert.equal(checked.status, expectedStatus);
      assert.match(
        `${checked.stdout}${checked.stderr}`,
        new RegExp(expectedRate.replace(".", "\\."), "u"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("the promotion checker explains a redacted regression with safe aggregate fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "kfq-qualification-evidence-test-"));
  const path = join(directory, "qualification.json");
  try {
    const raw = rawReport();
    const cleanIndex = CASES.findIndex((testCase) => testCase.defect === null);
    assert.notEqual(cleanIndex, -1);
    const cleanResult = raw.results[cleanIndex];
    assert.ok(cleanResult !== undefined);
    cleanResult.pass = false;
    cleanResult.findings = [{ content: SECRET }];
    writeFileSync(path, JSON.stringify(redactQualificationReport(raw)));

    const checked = spawnSync(process.execPath, ["scripts/check-qualification.mjs", path], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    assert.equal(checked.status, 1);
    assert.match(
      checked.stdout,
      /kind=precision, findings=1, tokens=\d+, rejected=0, sanitizer=0, suppressed=\d+/u,
    );
    assert.ok(!checked.stdout.includes(SECRET));
    assert.ok(!checked.stderr.includes(SECRET));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("redaction fails closed on duplicate case ids and unsafe provenance strings", () => {
  const duplicate = rawReport();
  duplicate.results[1] = duplicate.results[0];
  assert.throws(() => redactQualificationReport(duplicate), /unknown or duplicated/u);

  const unsafe = rawReport();
  unsafe.binding = binding({ adapter: { version: "0.23.0", commit: SECRET } });
  assert.throws(() => redactQualificationReport(unsafe), /adapter\.commit is invalid/u);
});
