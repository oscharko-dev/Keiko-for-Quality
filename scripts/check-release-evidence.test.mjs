import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { CASES } from "../corpus/cases.mjs";
import { productionHistoricalReplayEvidenceFixture } from "../corpus/historical-replay-evidence.test-fixture.mjs";
import { redactQualificationReport } from "./qualification-evidence-lib.mjs";
import {
  checkDownloadedReleaseEvidence,
  executeReleaseEvidenceCli,
  parseReleaseEvidenceArgs,
} from "./check-release-evidence.mjs";

const VERSION = "0.24.0";
const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);

function qualificationEvidence({ precisionMisses = 0 } = {}) {
  const cleanIds = new Set(
    CASES.filter((testCase) => testCase.defect === null)
      .slice(0, precisionMisses)
      .map((testCase) => testCase.id),
  );
  return redactQualificationReport({
    measured: true,
    binding: {
      measuredAt: "2026-08-12T12:00:00.000Z",
      strictness: "paranoid",
      adapter: { version: VERSION, commit: HEAD },
      engine: { sha256: "c".repeat(64) },
      rule: { sha256: "d".repeat(64) },
      corpus: { cases: "e".repeat(64), scorer: "f".repeat(64) },
      model: {
        id: "gpt-oss-120b",
        protocol: "openai",
        endpointDigest: "0".repeat(64),
      },
    },
    results: CASES.map((testCase) => ({
      id: testCase.id,
      kind: testCase.defect === null ? "precision" : "recall",
      pass: !cleanIds.has(testCase.id),
      findings: testCase.defect === null ? [] : [{}],
      rejected: [],
      tokens: 1,
      rejectedSanitization: 0,
      suppressedIntraRun: 0,
    })),
  });
}

function reports() {
  const reviewer = HEAD.slice(0, 12);
  return {
    seed: [
      "# Consumer-seed gate",
      `- Reviewer under test: keiko-for-quality ${VERSION}`,
      `- Reviewer tree: ${reviewer} (clean)`,
      "- Model: gpt-oss-120b (openai)",
      "- Verdict: GREEN (required failures: none)",
    ].join("\n"),
    completion: [
      "# Completion gate",
      `- Reviewer under test: keiko-for-quality ${VERSION}`,
      `- Reviewer tree: ${reviewer} (clean)`,
      "- Model: gpt-oss-120b (openai)",
      "- **Completion rate: 100.0%** (3/3 graded attempts, threshold 80.0%) — GREEN",
    ].join("\n"),
    qualification: qualificationEvidence(),
    historicalReplay: productionHistoricalReplayEvidenceFixture({ reviewerTree: TREE }),
  };
}

function writeReports(directory, overrides = {}) {
  const content = { ...reports(), ...overrides };
  const paths = {
    seed: join(directory, `seed-gate-2026-08-12-v${VERSION}.md`),
    completion: join(directory, `completion-2026-08-12-v${VERSION}.md`),
    qualification: join(directory, `qualification-2026-08-12-v${VERSION}.json`),
    historicalReplay: join(directory, `historical-replay-2026-08-12-v${VERSION}.json`),
  };
  writeFileSync(paths.seed, content.seed);
  writeFileSync(paths.completion, content.completion);
  writeFileSync(paths.qualification, JSON.stringify(content.qualification));
  writeFileSync(paths.historicalReplay, JSON.stringify(content.historicalReplay));
  return paths;
}

function argv(paths) {
  return [
    "--version",
    VERSION,
    "--head",
    HEAD,
    "--tree",
    TREE,
    "--seed",
    paths.seed,
    "--completion",
    paths.completion,
    "--qualification",
    paths.qualification,
    "--historical",
    paths.historicalReplay,
  ];
}

test("strictly parses one version, immutable head/tree, and four distinct evidence paths", () => {
  const paths = {
    seed: "seed.md",
    completion: "completion.md",
    qualification: "qualification.json",
    historicalReplay: "historical.json",
  };
  assert.deepEqual(parseReleaseEvidenceArgs(argv(paths)), {
    expected: { version: VERSION, head: HEAD, tree: TREE },
    paths: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, resolve(path)])),
  });
});

test("fails closed on unknown, duplicate, missing, malformed, and reused arguments", () => {
  const paths = {
    seed: "seed.md",
    completion: "completion.md",
    qualification: "qualification.json",
    historicalReplay: "historical.json",
  };
  const valid = argv(paths);
  const badArguments = [
    [...valid, "--unknown", "value"],
    [...valid, "--version", VERSION],
    valid.slice(0, -1),
    valid.with(1, "v0.24.0"),
    valid.with(3, HEAD.toUpperCase()),
    valid.with(5, "short"),
    valid.with(valid.indexOf("--seed") + 1, "seed.json"),
    valid.with(valid.indexOf("--completion") + 1, paths.seed),
  ];
  for (const arguments_ of badArguments) {
    assert.throws(() => parseReleaseEvidenceArgs(arguments_), Error);
  }
});

test("accepts only four correctly named artifacts that bind one releasable candidate", () => {
  const directory = mkdtempSync(join(tmpdir(), "kfq-release-evidence-check-"));
  try {
    const paths = writeReports(directory);
    const checked = [];
    assert.deepEqual(
      checkDownloadedReleaseEvidence({
        expected: { version: VERSION, head: HEAD, tree: TREE },
        paths,
        checkQualification: (path) => checked.push(path),
      }),
      { version: VERSION, head: HEAD, tree: TREE },
    );
    assert.deepEqual(checked, [paths.qualification]);

    const wrongKind = { ...paths, seed: paths.completion, completion: paths.seed };
    assert.throws(
      () =>
        checkDownloadedReleaseEvidence({
          expected: { version: VERSION, head: HEAD, tree: TREE },
          paths: wrongKind,
          checkQualification: () => undefined,
        }),
      /argument names the wrong evidence kind/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects red gates and every candidate identity mismatch before promotion", () => {
  const directory = mkdtempSync(join(tmpdir(), "kfq-release-evidence-binding-"));
  try {
    const base = reports();
    const cases = [
      {
        overrides: { seed: base.seed.replace("GREEN", "RED") },
        expected: { version: VERSION, head: HEAD, tree: TREE },
        failure: /gate:seed_not_green/u,
      },
      {
        overrides: {},
        expected: { version: VERSION, head: "c".repeat(40), tree: TREE },
        failure: /qualification_reviewer_mismatch/u,
      },
      {
        overrides: {},
        expected: { version: VERSION, head: HEAD, tree: "c".repeat(40) },
        failure: /historical_reviewer_mismatch/u,
      },
    ];
    for (const candidate of cases) {
      const paths = writeReports(directory, candidate.overrides);
      assert.throws(
        () =>
          checkDownloadedReleaseEvidence({
            expected: candidate.expected,
            paths,
            checkQualification: () => assert.fail("promotion must not run over invalid evidence"),
          }),
        candidate.failure,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the real CLI applies the existing qualification promotion floor without spending tokens", () => {
  const directory = mkdtempSync(join(tmpdir(), "kfq-release-evidence-cli-"));
  try {
    const script = join("scripts", "check-release-evidence.mjs");
    const validPaths = writeReports(directory);
    const passing = spawnSync(process.execPath, [script, ...argv(validPaths)], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    assert.equal(passing.status, 0, `${passing.stdout}\n${passing.stderr}`);
    assert.match(passing.stdout, new RegExp(`PASS - v${VERSION} binds ${HEAD} / ${TREE}`, "u"));

    const failingPaths = writeReports(directory, {
      qualification: qualificationEvidence({ precisionMisses: 3 }),
    });
    const failing = spawnSync(process.execPath, [script, ...argv(failingPaths)], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /qualification promotion thresholds are not green/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI reports one closed failure without an uncaught stack", () => {
  const errors = [];
  const exits = [];
  executeReleaseEvidenceCli({
    argv: [],
    error: (message) => errors.push(message),
    log: () => assert.fail("a rejected command must not log PASS"),
    setExitCode: (value) => exits.push(value),
  });
  assert.match(errors[0], /FAIL - missing required argument/u);
  assert.match(errors[1], /^usage: node scripts\/check-release-evidence\.mjs/u);
  assert.deepEqual(exits, [1]);
});
