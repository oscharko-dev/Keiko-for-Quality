import assert from "node:assert/strict";
import { test } from "node:test";

import { CASES } from "../corpus/cases.mjs";
import { productionHistoricalReplayEvidenceFixture } from "../corpus/historical-replay-evidence.test-fixture.mjs";
import { redactQualificationReport } from "./qualification-evidence-lib.mjs";
import {
  bumpConsumerPin,
  bumpQuickstartPin,
  findGateEvidence,
  gateEvidenceIdentity,
  isVersionedReleaseEvidencePath,
  notesFromCommitMessage,
  parseReleaseDevBinding,
  parseVersion,
  planReleaseTag,
  reconcileTagsAndReleases,
  releaseDevBindingMessage,
  sortVersionTags,
  tagFor,
  validateCommittedEvidenceDelta,
  validateGateEvidence,
  validatePublishTarget,
  validateQualityEvidence,
  validatePrepEvidenceChanges,
  validateRepinTarget,
} from "./release-lib.mjs";

/**
 * Hermetic coverage for every decision the release driver makes: no network, no git, no gh. The
 * reconciliation test below is the one that matters most — it is the check that would have caught
 * three consecutive releases shipping without a GitHub Release object.
 */

test("accepts X.Y.Z and nothing else", () => {
  assert.equal(parseVersion("0.21.3"), "0.21.3");
  assert.equal(tagFor("0.21.3"), "v0.21.3");
  for (const bad of ["v0.21.3", "0.21", "0.21.3-rc1", "", undefined, 1]) {
    assert.equal(parseVersion(bad), undefined, String(bad));
  }
});

test("round-trips one strict immutable dev binding and rejects ambiguous free text", () => {
  const binding = { commit: "a".repeat(40), tree: "b".repeat(40) };
  const message = releaseDevBindingMessage(binding);
  assert.deepEqual(parseReleaseDevBinding(`release: v0.23.0\n\n${message}`), {
    binding,
    failures: [],
    valid: true,
  });
  assert.deepEqual(parseReleaseDevBinding(`${message}\n${message}`), {
    binding: undefined,
    failures: ["release_dev_commit_binding_invalid", "release_dev_tree_binding_invalid"],
    valid: false,
  });
  assert.equal(parseReleaseDevBinding("release: v0.23.0").valid, false);
  assert.equal(parseReleaseDevBinding(undefined).valid, false);
  assert.throws(
    () => releaseDevBindingMessage({ commit: "not-a-commit", tree: binding.tree }),
    /full lowercase Git ids/u,
  );
});

test("rewrites the README quickstart pin comment and reports how many it touched", () => {
  const readme = [
    "         - uses: oscharko-dev/Keiko-for-Quality@<sha> # v0.21.2",
    "   Reference the action at a full 40-character commit SHA.",
  ].join("\n");
  const bumped = bumpQuickstartPin(readme, "0.21.3");
  assert.equal(bumped.changed, 1);
  assert.match(bumped.text, /@<sha> # v0\.21\.3/);
});

// A README whose shape drifted must stop the release rather than release silently unbumped.
test("reports zero when the quickstart comment is not where it was", () => {
  assert.equal(bumpQuickstartPin("no pin here", "0.21.3").changed, 0);
});

test("finds both gate reports for the version, and says which one is missing", () => {
  const names = [
    "seed-gate-2026-08-09-v0.21.2.md",
    "completion-2026-08-09-v0.21.2.md",
    "qualification-2026-08-09-v0.21.2.json",
    "historical-replay-2026-08-09-v0.21.2.json",
    "seed-gate-2026-08-08-v0.21.1.md",
  ];
  const found = findGateEvidence(names, "0.21.2");
  assert.equal(found.complete, true);
  assert.equal(found.seed, "seed-gate-2026-08-09-v0.21.2.md");
  assert.deepEqual(found.ambiguous, []);

  const partial = findGateEvidence(names, "0.21.1");
  assert.equal(partial.complete, false);
  assert.equal(partial.completion, undefined);
});

test("rejects duplicate evidence instead of choosing an arbitrary first file", () => {
  const names = [
    "seed-gate-2026-08-09-v0.23.0.md",
    "seed-gate-retry-2026-08-09-v0.23.0.md",
    "completion-2026-08-09-v0.23.0.md",
    "qualification-2026-08-09-v0.23.0.json",
    "historical-replay-2026-08-09-v0.23.0.json",
  ];
  const found = findGateEvidence(names, "0.23.0");
  assert.equal(found.complete, false);
  assert.equal(found.seed, undefined);
  assert.deepEqual(found.ambiguous, [
    "seed: seed-gate-2026-08-09-v0.23.0.md, seed-gate-retry-2026-08-09-v0.23.0.md",
  ]);
});

// v0.21.2's evidence must not satisfy a v0.21.20 release, and vice versa.
test("does not confuse one version's evidence for another's", () => {
  const names = [
    "seed-gate-2026-08-09-v0.21.20.md",
    "completion-2026-08-09-v0.21.20.md",
    "qualification-2026-08-09-v0.21.20.json",
    "historical-replay-2026-08-09-v0.21.20.json",
  ];
  assert.equal(findGateEvidence(names, "0.21.2").complete, false);
  assert.equal(findGateEvidence(names, "0.21.20").complete, true);
});

test("release gate reports must be clean, pinned, and green inside the files", () => {
  const expected = { version: "0.21.2", head: `${"abc123def456"}${"0".repeat(28)}` };
  const seed = [
    "# Consumer-seed gate",
    "- Reviewer under test: keiko-for-quality 0.21.2",
    "- Reviewer tree: abc123def456 (clean)",
    "- Model: gpt-oss-120b (openai)",
    "- Verdict: GREEN (required failures: none)",
  ].join("\n");
  const completion = [
    "# Completion gate",
    "- Reviewer under test: keiko-for-quality 0.21.2",
    "- Reviewer tree: abc123def456 (clean)",
    "- Model: gpt-oss-120b (openai)",
    "- **Completion rate: 100.0%** (3/3 graded attempts, threshold 80.0%) — GREEN",
  ].join("\n");

  assert.deepEqual(validateGateEvidence(seed, completion, expected), { valid: true, failures: [] });
  assert.deepEqual(gateEvidenceIdentity(seed), {
    reviewer: "abc123def456",
    version: "0.21.2",
  });
  assert.deepEqual(
    validateGateEvidence(
      seed.replace("(clean)", "(DIRTY — not release evidence)"),
      completion,
      expected,
    ),
    {
      valid: false,
      failures: ["seed_reviewer_not_clean", "seed_disqualified"],
    },
  );
  assert.deepEqual(validateGateEvidence(seed, completion.replace("— GREEN", "— RED"), expected), {
    valid: false,
    failures: ["completion_not_green"],
  });
  assert.deepEqual(
    validateGateEvidence(seed.replace("abc123def456", "fff123def456"), completion, expected),
    {
      valid: false,
      failures: ["seed_reviewer_mismatch", "gate_reviewer_disagreement"],
    },
  );
  assert.deepEqual(
    validateGateEvidence(
      seed.replace("0.21.2", "0.20.0"),
      completion.replace("0.21.2", "0.20.0"),
      expected,
    ),
    {
      valid: false,
      failures: ["seed_version_mismatch", "completion_version_mismatch"],
    },
  );
  assert.deepEqual(
    validateGateEvidence(seed, completion.replace("3/3", "1/1"), expected).failures,
    ["completion_sample_too_small"],
  );
  assert.deepEqual(
    validateGateEvidence(seed, completion.replace("threshold 80.0%", "threshold 1.0%"), expected)
      .failures,
    ["completion_threshold_too_low"],
  );
  assert.deepEqual(
    validateGateEvidence(seed, completion.replace("rate: 100.0%", "rate: 99.0%"), expected)
      .failures,
    ["completion_rate_inconsistent"],
  );
  assert.deepEqual(
    validateGateEvidence(seed, completion.replace("100.0%** (3/3", "66.7%** (2/3"), expected)
      .failures,
    ["completion_below_threshold"],
  );
  assert.deepEqual(
    validateGateEvidence(seed, completion.replace("100.0%** (3/3", "133.3%** (4/3"), expected)
      .failures,
    ["completion_rate_inconsistent"],
  );
  assert.deepEqual(
    validateGateEvidence(
      seed,
      completion.replace("(clean)", "(DIRTY — not release evidence)"),
      expected,
    ).failures,
    ["completion_reviewer_not_clean", "completion_disqualified"],
  );
});

test("publish and repin bind the requested version to the exact released commit", () => {
  const version = "0.23.0";
  const sha = "a".repeat(40);
  assert.deepEqual(
    validatePublishTarget({ version, sha, originMainSha: sha, packageVersion: version }),
    { valid: true, failures: [] },
  );
  assert.deepEqual(
    validatePublishTarget({
      version,
      sha,
      originMainSha: "b".repeat(40),
      packageVersion: "0.22.0",
    }),
    {
      valid: false,
      failures: ["publish_sha_not_origin_main", "publish_package_version_mismatch"],
    },
  );

  assert.deepEqual(
    validateRepinTarget({
      version,
      sha,
      packageVersion: version,
      tagType: "tag",
      tagCommit: sha,
      tagSignatureValid: true,
    }),
    { valid: true, failures: [] },
  );
  assert.deepEqual(
    validateRepinTarget({
      version,
      sha,
      packageVersion: "0.22.0",
      tagType: "commit",
      tagCommit: "b".repeat(40),
      tagSignatureValid: false,
    }),
    {
      valid: false,
      failures: [
        "repin_tag_not_annotated",
        "repin_tag_signature_invalid",
        "repin_tag_sha_mismatch",
        "repin_package_version_mismatch",
      ],
    },
  );
});

test("release tag planning safely resumes after local creation or remote push", () => {
  const sha = "a".repeat(40);
  const tagObject = "b".repeat(40);
  assert.deepEqual(planReleaseTag({ sha }), {
    valid: true,
    failures: [],
    action: "create_and_push",
  });
  assert.deepEqual(planReleaseTag({ sha, localTagObject: tagObject }), {
    valid: true,
    failures: [],
    action: "push_existing",
  });
  assert.deepEqual(planReleaseTag({ sha, remoteTagObject: tagObject, remoteTagCommit: sha }), {
    valid: true,
    failures: [],
    action: "fetch_existing",
  });
  assert.deepEqual(
    planReleaseTag({
      sha,
      localTagObject: tagObject,
      remoteTagObject: tagObject,
      remoteTagCommit: sha,
    }),
    { valid: true, failures: [], action: "reuse_existing" },
  );
  assert.deepEqual(
    planReleaseTag({
      sha,
      localTagObject: tagObject,
      remoteTagObject: "c".repeat(40),
      remoteTagCommit: "d".repeat(40),
    }),
    {
      valid: false,
      failures: ["release_tag_remote_sha_mismatch", "release_tag_local_remote_disagreement"],
    },
  );
  assert.deepEqual(planReleaseTag({ sha, remoteTagObject: tagObject }), {
    valid: false,
    failures: ["release_tag_remote_not_annotated"],
  });
});

test("prep permits only new evidence for the target version", () => {
  const valid = [
    "?? corpus/evidence/seed-gate-2026-08-09-v0.23.0.md",
    "?? corpus/evidence/completion-2026-08-09-v0.23.0.md",
    "?? corpus/evidence/qualification-2026-08-09-v0.23.0.json",
    "?? corpus/evidence/historical-replay-2026-08-09-v0.23.0.json",
  ];
  assert.deepEqual(validatePrepEvidenceChanges(valid, "0.23.0"), {
    valid: true,
    invalid: [],
  });
  assert.equal(isVersionedReleaseEvidencePath(valid[0].slice(3), "0.23.0"), true);
  assert.equal(
    isVersionedReleaseEvidencePath("corpus/evidence/seed-gate-old-v0.22.0.md", "0.23.0"),
    false,
  );
  assert.equal(
    isVersionedReleaseEvidencePath("corpus/evidence/qualification-2026-08-09-v0.23.0.md", "0.23.0"),
    false,
  );
  assert.deepEqual(validatePrepEvidenceChanges([], "0.23.0"), {
    valid: false,
    invalid: ["seed:0", "completion:0", "qualification:0", "historicalReplay:0"],
  });
  assert.deepEqual(
    validatePrepEvidenceChanges(
      [valid[0], " M src/review.ts", "?? corpus/evidence/seed-gate-old-v0.22.0.md"],
      "0.23.0",
    ),
    {
      valid: false,
      invalid: [
        " M src/review.ts",
        "?? corpus/evidence/seed-gate-old-v0.22.0.md",
        "completion:0",
        "qualification:0",
        "historicalReplay:0",
      ],
    },
  );
  assert.deepEqual(
    validatePrepEvidenceChanges([...valid, valid[0].replace("2026-08-09", "retry")], "0.23.0"),
    { valid: false, invalid: ["seed:2"] },
  );
  const selectedPaths = valid.map((change) => change.slice(3));
  const selectedNames = selectedPaths.map((path) => path.replace("corpus/evidence/", ""));
  assert.equal(validateCommittedEvidenceDelta(selectedPaths, selectedNames, "0.23.0").valid, true);
  assert.equal(
    validateCommittedEvidenceDelta([...selectedPaths, "src/review.ts"], selectedNames, "0.23.0")
      .valid,
    false,
  );
  assert.equal(
    validateCommittedEvidenceDelta(selectedPaths.slice(1), selectedNames, "0.23.0").valid,
    false,
  );
});

test("quality evidence must bind the RC and improve real-label precision without hiding fixes", () => {
  const expected = { version: "0.23.0", head: "a".repeat(40), tree: "b".repeat(40) };
  const qualification = redactQualificationReport({
    measured: true,
    binding: {
      measuredAt: "2026-08-09T09:00:00.000Z",
      strictness: "paranoid",
      adapter: { version: expected.version, commit: expected.head },
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
      pass: true,
      findings: testCase.defect === null ? [] : [{}],
      rejected: [],
      tokens: 1,
      rejectedSanitization: 0,
      suppressedIntraRun: 0,
    })),
  });
  const historical = productionHistoricalReplayEvidenceFixture({ reviewerTree: expected.tree });

  assert.deepEqual(validateQualityEvidence(qualification, historical, expected), {
    valid: true,
    failures: [],
  });
  const experimentalStrictness = JSON.parse(JSON.stringify(qualification));
  experimentalStrictness.binding.strictness = "default";
  assert.ok(
    validateQualityEvidence(experimentalStrictness, historical, expected).failures.includes(
      "qualification_strictness_mismatch",
    ),
  );
  const oldHistoricalSchema = JSON.parse(JSON.stringify(historical));
  oldHistoricalSchema.schemaVersion = 3;
  assert.ok(
    validateQualityEvidence(qualification, oldHistoricalSchema, expected).failures.includes(
      "historical_schema_mismatch",
    ),
  );
  const rawSchema = { ...qualification };
  delete rawSchema.artifact;
  assert.ok(
    validateQualityEvidence(rawSchema, historical, expected).failures.includes(
      "qualification_schema_mismatch",
    ),
  );
  const regressed = JSON.parse(JSON.stringify(historical));
  regressed.score.all.after.metrics.precision = 0.3;
  regressed.score.all.after.metrics.fixedRetention = 0.7;
  regressed.score.all.after.metrics.decisionCoverage = 0.7;
  const regressedValidation = validateQualityEvidence(qualification, regressed, expected);
  assert.equal(regressedValidation.valid, false);
  for (const failure of [
    "historical_schema_mismatch",
    "historical_all_precision_gain_missing",
    "historical_all_fixed_retention_low",
    "historical_all_decision_coverage_low",
  ]) {
    assert.ok(regressedValidation.failures.includes(failure), failure);
  }
});

test("takes the release notes from the release commit rather than asking for them twice", () => {
  const message = "release: v0.21.2 — the precision wave\n\nWhat it does.\n\nEvidence: a.md.\n";
  const notes = notesFromCommitMessage(message);
  assert.equal(notes.title, "release: v0.21.2 — the precision wave");
  assert.equal(notes.body, "What it does.\n\nEvidence: a.md.");
});

test("names every tag that has no Release — the omission this script exists for", () => {
  const result = reconcileTagsAndReleases(
    ["v0.20.1", "v0.21.0", "v0.21.1", "v0.21.2"],
    ["v0.20.1"],
  );
  assert.deepEqual(result.tagsWithoutRelease, ["v0.21.0", "v0.21.1", "v0.21.2"]);
  assert.deepEqual(result.releasesWithoutTag, []);
  // The live defect, separated from the list: the newest tag is the one a reader is misled by.
  assert.equal(result.newest, "v0.21.2");
  assert.equal(result.newestUnreleased, "v0.21.2");
});

// A gate that goes red on history is a gate nobody reads — the historical gaps stay in
// `tagsWithoutRelease` for reporting, but `newestUnreleased` stays empty.
test("historical gaps are reported without being called a defect", () => {
  const result = reconcileTagsAndReleases(["v0.3.0", "v0.18.0", "v0.21.2"], ["v0.21.2"]);
  assert.deepEqual(result.tagsWithoutRelease, ["v0.3.0", "v0.18.0"]);
  assert.equal(result.newestUnreleased, undefined);
  assert.equal(result.newest, "v0.21.2");
});

test("orders by version, not by push order, before deciding which tag is newest", () => {
  const result = reconcileTagsAndReleases(["v0.21.10", "v0.21.2"], ["v0.21.10"]);
  assert.equal(result.newest, "v0.21.10");
  assert.equal(result.newestUnreleased, undefined);
});

test("names a Release whose tag does not exist", () => {
  const result = reconcileTagsAndReleases(["v0.21.2"], ["v0.21.2", "v0.99.0"]);
  assert.deepEqual(result.releasesWithoutTag, ["v0.99.0"]);
  assert.deepEqual(result.tagsWithoutRelease, []);
});

test("orders version tags numerically, not as strings", () => {
  assert.deepEqual(sortVersionTags(["v0.21.10", "v0.21.2", "v0.9.0", "kq-assets-v1"]), [
    "v0.9.0",
    "v0.21.2",
    "v0.21.10",
  ]);
});

test("moves the consumer's uses: and ACTION_PIN together, and counts both", () => {
  const sha = "a".repeat(40);
  const workflow = [
    '          ACTION_PIN: "' + "b".repeat(40) + "\" # v0.21.1 — keep in sync with Review's uses:",
    "        uses: oscharko-dev/Keiko-for-Quality@" + "b".repeat(40) + " # v0.21.1",
  ].join("\n");
  const bumped = bumpConsumerPin(workflow, sha, "0.21.2");
  assert.equal(bumped.uses, 1);
  assert.equal(bumped.actionPin, 1);
  assert.equal(bumped.text.includes("b".repeat(40)), false);
  assert.match(bumped.text, /# v0\.21\.2/);
});

// A workflow that carries only one of the two sites is the drift its own sync check fails on;
// the counts are what let the driver refuse before pushing it.
test("reports the counts separately so a half-rewrite is visible", () => {
  const bumped = bumpConsumerPin(
    "        uses: oscharko-dev/Keiko-for-Quality@" + "b".repeat(40) + " # v0.21.1",
    "c".repeat(40),
    "0.21.2",
  );
  assert.equal(bumped.uses, 1);
  assert.equal(bumped.actionPin, 0);
});
