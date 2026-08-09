import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    assert.match(output, /precision\s+100\.0%/u);
    assert.ok(!output.includes(SECRET));
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
