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
  corpusReviewDeadlineMs,
  qualificationEngineImplementation,
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

test("the corpus deadline is one real absolute review boundary", () => {
  assert.equal(corpusReviewDeadlineMs(10_000), 10_000 + CORPUS_REVIEW_TIMEOUT_SECONDS * 1_000);
  assert.throws(() => corpusReviewDeadlineMs(Number.NaN), /clock/u);
});

test("staged binding ignores a fetched but unused classic engine", () => {
  assert.equal(
    qualificationEngineImplementation({
      singleShot: true,
      binary: "/tmp/unused-ocr",
      repositoryRoot: "/repo",
    }),
    "/repo/src/engine/single-shot.ts",
  );
  assert.equal(
    qualificationEngineImplementation({
      singleShot: false,
      binary: "/tmp/ocr",
      repositoryRoot: "/repo",
    }),
    "/tmp/ocr",
  );
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
