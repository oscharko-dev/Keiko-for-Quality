import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CASES } from "./cases.mjs";
import { FIXED_PATH } from "./fixed-path.mjs";
import { registerTsExtensionHooks } from "./rule-source.mjs";
import {
  CORPUS_REVIEW_TIMEOUT_SECONDS,
  STAGED_QUALIFICATION_ENGINE_ENTRYPOINTS,
  corpusReviewDeadlineMs,
  qualificationEngineIdentity,
  qualificationOutcomeFromLocalReview,
  singleShotCorpusContextOptions,
  singleShotCorpusDispatch,
} from "./single-shot-invocation.mjs";

registerTsExtensionHooks();
const { commitSha } = await import("../src/core/brands.ts");
const { loadReviewProfile } = await import("../src/config/profile.ts");
const { createSilentDiagnostics } = await import("../src/diagnostics/sink.ts");

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: FIXED_PATH,
      GIT_AUTHOR_NAME: "corpus",
      GIT_AUTHOR_EMAIL: "corpus@example.test",
      GIT_COMMITTER_NAME: "corpus",
      GIT_COMMITTER_EMAIL: "corpus@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

function write(repo, path, content) {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "kfq-corpus-dispatch-"));
  git(repo, ["init", "-q"]);
  write(repo, "src/normal.ts", "export const value = 1;\n");
  write(repo, "critical/policy.txt", "must remain\n");
  write(repo, "assets/image.bin", Buffer.from([0, 1, 2, 3]));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);

  write(repo, "src/normal.ts", "export const value = 2;\n");
  write(repo, "assets/image.bin", Buffer.from([0, 4, 5, 6]));
  git(repo, ["rm", "-q", "critical/policy.txt"]);
  // A gitlink can point at any commit object already present in the repository. It remains object
  // metadata and never initializes a submodule during Inventory classification.
  git(repo, ["update-index", "--add", "--cacheinfo", `160000,${base},vendor/dependency`]);
  git(repo, ["add", "src/normal.ts", "assets/image.bin"]);
  git(repo, ["commit", "-qm", "head"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  return { repo, base, head };
}

function caseFixture(testCase, writeFixture = write) {
  const repo = mkdtempSync(join(tmpdir(), `kfq-corpus-case-${testCase.id}-`));
  try {
    git(repo, ["init", "-q"]);
    for (const file of testCase.files) writeFixture(repo, file.path, file.base);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]);

    for (const file of testCase.files) writeFixture(repo, file.path, file.head);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "head"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    return { repo, base, head };
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}

function contextPackFixture() {
  const repo = mkdtempSync(join(tmpdir(), "kfq-corpus-context-pack-"));
  try {
    git(repo, ["init", "-q"]);
    write(repo, "src/helper.ts", "export function computeAllowance(value) { return value * 2; }\n");
    for (const path of ["src/eligible.ts", "src/tiny.ts", "src/mechanical.ts"]) {
      write(repo, path, "export const baseline = 1;\n");
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]);

    const eligible = [
      'import { computeAllowance } from "./helper.js";',
      ...Array.from(
        { length: 60 },
        (_, index) => `export const eligible${String(index)} = computeAllowance(${String(index)});`,
      ),
      "",
    ].join("\n");
    write(repo, "src/eligible.ts", eligible);
    write(
      repo,
      "src/tiny.ts",
      'import { computeAllowance } from "./helper.js";\nexport const tiny = computeAllowance(1);\n',
    );
    write(repo, "src/mechanical.ts", eligible.replaceAll("eligible", "mechanical"));
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "head"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    return {
      repo,
      pair: { base: commitSha(base), head: commitSha(head), mergeBase: commitSha(base) },
    };
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}

test("the corpus deadline is one real absolute review boundary", () => {
  assert.equal(corpusReviewDeadlineMs(10_000), 10_000 + CORPUS_REVIEW_TIMEOUT_SECONDS * 1_000);
  assert.throws(() => corpusReviewDeadlineMs(Number.NaN), /clock/u);
});

test("staged binding ignores a fetched but unused classic engine", () => {
  assert.deepEqual(
    qualificationEngineIdentity({
      singleShot: true,
      binary: "/tmp/unused-ocr",
      repositoryRoot: "/repo",
    }),
    {
      kind: "source-closure",
      repositoryRoot: "/repo",
      entrypoints: STAGED_QUALIFICATION_ENGINE_ENTRYPOINTS,
    },
  );
  assert.equal(STAGED_QUALIFICATION_ENGINE_ENTRYPOINTS.includes("src/review.ts"), true);
  assert.equal(
    STAGED_QUALIFICATION_ENGINE_ENTRYPOINTS.includes("src/engine/single-shot.ts"),
    false,
  );
  assert.deepEqual(
    qualificationEngineIdentity({
      singleShot: false,
      binary: "/tmp/ocr",
      repositoryRoot: "/repo",
    }),
    { kind: "file", path: "/tmp/ocr" },
  );
});

test("publication-quality local results ignore provisional sanitizer rejects", () => {
  const { result, plan } = qualificationOutcomeFromLocalReview(
    {
      outcome: "complete",
      findings: [
        {
          path: "src/a.ts",
          startLine: 4,
          endLine: 4,
          category: "bug",
          severity: "high",
          body: "Fix the bound.\n\nWhen input is empty, the index is negative.",
        },
      ],
      spend: { engine: 10, classify: 5, total: 15, allotted: 100 },
      inventory: { total: 2, reviewable: 2, reviewed: 2 },
      ruleDigest: "a".repeat(64),
      engineVersion: "v1",
      cacheHits: 0,
      cacheMisses: 2,
    },
    [
      { code: "publish.finding_suppressed_intra_run" },
      { code: "publish.finding_rejected_sanitization" },
    ],
  );

  assert.equal(result.status, "success");
  assert.equal(result.summary.total_tokens, 15);
  assert.equal(result.summary.files_reviewed, 2);
  assert.equal(result.summary.budget_exceeded, false);
  assert.equal(result.manifest.coverage.selected.length, 2);
  assert.equal(result.manifest.coverage.completed.length, 2);
  assert.deepEqual(result.comments, [
    {
      path: "src/a.ts",
      startLine: 4,
      endLine: 4,
      category: "bug",
      severity: "high",
      content: "Fix the bound.\n\nWhen input is empty, the index is negative.",
    },
  ]);
  assert.equal(plan.survivors[0]?.sanitizedBody, result.comments[0]?.content);
  assert.deepEqual(plan.counters, { rejectedSanitization: 0, suppressedIntraRun: 1 });
});

test("publication-quality local results retain the final sanitizer loss from settlement", () => {
  const { plan } = qualificationOutcomeFromLocalReview(
    {
      outcome: "incomplete",
      reason: "settlement.incomplete.publication_degraded",
      findings: [],
      spend: { engine: 10, classify: 5, total: 15, allotted: 100 },
      inventory: { total: 1, reviewable: 1, reviewed: 1 },
      ruleDigest: "c".repeat(64),
      engineVersion: "v1",
      cacheHits: 0,
      cacheMisses: 1,
    },
    [
      { code: "publish.finding_rejected_sanitization" },
      {
        code: "settlement.incomplete.publication_degraded",
        counts: { rejected_sanitization: 1 },
      },
    ],
  );

  assert.equal(plan.counters.rejectedSanitization, 1);
});

test("an incomplete local budget stop remains an explicit budget-pressure result", () => {
  const { result } = qualificationOutcomeFromLocalReview(
    {
      outcome: "incomplete",
      reason: "settlement.incomplete.budget_exceeded",
      findings: [],
      spend: { engine: 25_000, classify: 0, total: 25_000, allotted: 25_000 },
      inventory: { total: 5, reviewable: 5, reviewed: 2 },
      ruleDigest: "b".repeat(64),
      engineVersion: "v1",
      cacheHits: 0,
      cacheMisses: 5,
    },
    [],
  );

  assert.equal(result.status, "budget_exceeded");
  assert.equal(result.summary.budget_exceeded, true);
  assert.equal(result.summary.files_reviewed, 2);
});

test("a corpus case repository is removed when fixture construction fails", () => {
  let createdRepo;
  assert.throws(
    () =>
      caseFixture(
        { id: "cleanup-failure", files: [{ path: "src/a.ts", base: "old\n", head: "new\n" }] },
        (repo) => {
          createdRepo = repo;
          throw new Error("fixture write failed");
        },
      ),
    /fixture write failed/u,
  );
  assert.notEqual(createdRepo, undefined);
  assert.equal(existsSync(createdRepo), false);
});

test("staged corpus dispatch uses production structural classification, not matching globs", async () => {
  const { repo, base, head } = fixture();
  try {
    const profile = loadReviewProfile(
      JSON.stringify({
        version: 1,
        reviewRelevant: ["src/**", "assets/**", "vendor/**"],
        excluded: [],
        generated: [],
        deletionCritical: ["critical/**"],
        benignWarnings: [],
        pathInstructions: [],
      }),
    );
    const result = await singleShotCorpusDispatch({
      repositoryPath: repo,
      pair: { base: commitSha(base), head: commitSha(head), mergeBase: commitSha(base) },
      profile,
      pathValue: FIXED_PATH,
      renameDetectionPercent: 50,
      diagnostics: createSilentDiagnostics(),
    });
    assert.deepEqual(
      new Set(result.expectedReviewablePaths),
      new Set(["critical/policy.txt", "src/normal.ts"]),
    );
    assert.equal(result.expectedReviewablePaths.includes("assets/image.bin"), false);
    assert.equal(result.expectedReviewablePaths.includes("vendor/dependency"), false);
    assert.deepEqual(result.mechanicallyCleanPaths, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("staged corpus forwards eligible production context packs without lowering the tiny-file threshold", async () => {
  const { repo, pair } = contextPackFixture();
  try {
    const forwarded = await singleShotCorpusContextOptions({
      repositoryPath: repo,
      pair,
      pathValue: FIXED_PATH,
      expectedReviewablePaths: ["src/eligible.ts", "src/tiny.ts", "src/mechanical.ts"],
      mechanicallyCleanPaths: ["src/mechanical.ts"],
    });
    assert.ok(forwarded.contextPacks instanceof Map);
    assert.match(forwarded.contextPacks.get("src/eligible.ts") ?? "", /src\/helper\.ts:1:/u);
    assert.equal(forwarded.contextPacks.has("src/tiny.ts"), false);
    assert.equal(forwarded.contextPacks.has("src/mechanical.ts"), false);

    const tinyOnly = await singleShotCorpusContextOptions({
      repositoryPath: repo,
      pair,
      pathValue: FIXED_PATH,
      expectedReviewablePaths: ["src/tiny.ts"],
      mechanicallyCleanPaths: [],
    });
    assert.deepEqual(tinyOnly, {});
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * The v0.23.0 qualification first discovered an unclassified `package.json` in its final case,
 * after the preceding cases had already spent 584,237 model tokens. Build every fixture through
 * production Inventory here, for free, so a future path/profile gap fails `verify` before a paid
 * run. Requiring at least one dispatch also preserves this case set's no-zero-token rule.
 */
test("every corpus fixture is classified and dispatches reviewable content before a paid run", async () => {
  const profileSource = readFileSync(new URL("./profile.json", import.meta.url), "utf8");
  const profile = loadReviewProfile(profileSource);
  for (const testCase of CASES) {
    const { repo, base, head } = caseFixture(testCase);
    try {
      const pair = { base: commitSha(base), head: commitSha(head), mergeBase: commitSha(base) };
      const result = await singleShotCorpusDispatch({
        repositoryPath: repo,
        pair,
        profile,
        pathValue: FIXED_PATH,
        renameDetectionPercent: 50,
        diagnostics: createSilentDiagnostics(),
      });
      assert.ok(
        result.expectedReviewablePaths.length > 0,
        `${testCase.id} would spend zero tokens because it dispatches no reviewable path`,
      );
      if (testCase.id === "clean-version-bump-twin") {
        assert.deepEqual(result.expectedReviewablePaths, ["src/examplepkg/version.ts"]);
        assert.deepEqual(result.mechanicallyCleanPaths, []);

        const incompleteProfile = JSON.parse(profileSource);
        incompleteProfile.excluded = incompleteProfile.excluded.filter(
          (entry) => entry.pattern !== "**/package.json",
        );
        await assert.rejects(
          singleShotCorpusDispatch({
            repositoryPath: repo,
            pair,
            profile: loadReviewProfile(JSON.stringify(incompleteProfile)),
            pathValue: FIXED_PATH,
            renameDetectionPercent: 50,
            diagnostics: createSilentDiagnostics(),
          }),
          /unclassified changed path/u,
        );
      }
    } catch (error) {
      throw new Error(`${testCase.id}: ${String(error)}`, { cause: error });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});
