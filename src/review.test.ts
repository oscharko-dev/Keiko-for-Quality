import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeKey,
  computePathSetDigest,
  modelId,
  protocol,
  SUPPORTED_STORE_SCHEMA,
  type CacheStore,
} from "./cache/review-cache.js";
import { compileProfile, type ReviewProfile } from "./config/profile.js";
import type { RuntimeConfig } from "./config/runtime.js";
import { blobId, commitSha, repoPath, sha256 } from "./core/brands.js";
import { createSilentDiagnostics } from "./diagnostics/sink.js";
import { currentPlatformDigest } from "./engine/pinned-release.js";
import { SUPPORTED_MANIFEST_SCHEMA } from "./engine/result.js";
import { promptIdentityDigest } from "./engine/rule-identity.js";
import {
  GitHubApiError,
  GitHubClient,
  type ReviewComment,
  type ReviewCommentInput,
} from "./github/client.js";
import { fingerprint, markerComment } from "./publish/marker.js";
import type { ReviewRequest } from "./review.js";

const acquireEngineMock = vi.fn();
vi.mock("./engine/acquire.js", () => ({ acquireEngine: acquireEngineMock }));

const runEngineMock = vi.fn();
vi.mock("./engine/run.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runEngine: runEngineMock,
}));

const { computeAllottedBudget, performReview } = await import("./review.js");
const { EngineRunError } = await import("./engine/run.js");

describe("computeAllottedBudget", () => {
  it("matches the worked example: 87 files, 3,175 changed lines", () => {
    // 1.3 * (87 * 40_000 + 3_175 * 60) = 1.3 * (3_480_000 + 190_500) = 1.3 * 3_670_500 = 4_771_650.
    expect(computeAllottedBudget(6_000_000, 87, 3_175)).toBe(4_771_650);
  });

  it("never exceeds the consumer's configured ceiling, however large the change", () => {
    expect(computeAllottedBudget(1_000_000, 87, 3_175)).toBe(1_000_000);
  });

  it("floors a tiny change rather than starving it", () => {
    // 1.3 * (1 * 40_000 + 5 * 60) = 1.3 * 40_300 = 52_390, below the 80_000 floor.
    expect(computeAllottedBudget(2_000_000, 1, 5)).toBe(80_000);
  });

  it("does not let the floor exceed a ceiling configured below it", () => {
    expect(computeAllottedBudget(50_000, 1, 5)).toBe(50_000);
  });

  it("caps a huge change at the ceiling rather than the raw estimate", () => {
    // 1.3 * (1000 * 40_000) = 52_000_000, far past the 6_000_000 ceiling.
    expect(computeAllottedBudget(100_000_000, 1000, 0)).toBe(6_000_000);
  });

  it("still applies the floor to a degenerate zero-file, zero-line input", () => {
    // `performReview` never calls this with an empty inventory — it short-circuits on
    // `reviewablePaths.size === 0` first — but the formula itself has no special case for it, and
    // the floor exists precisely so a small raw estimate never becomes a smaller allotment.
    expect(computeAllottedBudget(2_000_000, 0, 0)).toBe(80_000);
  });

  it("always returns an integer, guarding against floating-point residue from the 1.3 margin", () => {
    for (const [files, lines] of [
      [2, 1],
      [7, 13],
      [1, 0],
      [900, 12345],
    ] as const) {
      expect(Number.isInteger(computeAllottedBudget(6_000_000, files, lines))).toBe(true);
    }
  });

  it("scales with line count, but only as the weak secondary term the constant implies", () => {
    const withoutLines = computeAllottedBudget(6_000_000, 10, 0);
    const withLines = computeAllottedBudget(6_000_000, 10, 1000);
    // 60 tokens/line * 1000 lines * 1.3 margin = 78_000 — a small delta next to the 40_000/file term.
    expect(withLines - withoutLines).toBe(78_000);
  });
});

/**
 * `performReview` end to end, over a real git repository, with only the engine acquisition and
 * invocation mocked away (both make real network/process calls the other suites already avoid).
 * Everything else — `buildInventory`, the review-cache lookup, the exclude union, `settle`, and
 * `publishFindings` — is the real production code. This is what proves the exclude wiring reaches
 * the actual `runEngine` call, not only the settlement arithmetic `settle.test.ts` already covers
 * in isolation.
 */
describe("performReview: review-cache memoization end to end", () => {
  let repo: string;
  let baseSha: string;
  let headSha: string;
  let baseBlobA: string;
  let headBlobA: string;

  function git(args: readonly string[]): string {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  }

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "kfq-review-"));
    git(["init", "-q", "-b", "main"]);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/a.ts"), "export const a = 1;\n");
    await writeFile(join(repo, "src/b.ts"), "export const b = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
    baseSha = git(["rev-parse", "HEAD"]).trim();
    baseBlobA = git(["rev-parse", `${baseSha}:src/a.ts`]).trim();

    await writeFile(join(repo, "src/a.ts"), "export const a = 2;\n");
    await writeFile(join(repo, "src/b.ts"), "export const b = 2;\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "head", "--no-gpg-sign"]);
    headSha = git(["rev-parse", "HEAD"]).trim();
    headBlobA = git(["rev-parse", `${headSha}:src/a.ts`]).trim();
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const PROFILE = compileProfile({
    version: 1,
    reviewRelevant: ["src/**"],
    deletionCritical: [],
    generated: [],
    excluded: [],
    benignWarnings: [],
    pathInstructions: [],
  } satisfies ReviewProfile);

  const CONFIG: RuntimeConfig = {
    protocol: "anthropic",
    endpoint: "https://model.example.test/v1",
    model: "claude-sonnet-4-5",
    tokenEnvName: "MODEL_TOKEN",
    language: "English",
    concurrency: 4,
    fileTimeoutSeconds: 300,
    reviewTimeoutSeconds: 1800,
    tokenBudget: 2_000_000,
    maxFindings: 50,
    renameDetectionPercent: 50,
  };

  /** Counted-mode engine output: no `manifest` key, so `parseEngineResult` reports it as absent. */
  function engineStdout(filesReviewed: number): string {
    return JSON.stringify({
      status: "success",
      summary: { files_reviewed: filesReviewed, total_tokens: 100, budget_exceeded: false },
      comments: [],
    });
  }

  /** The same counted-mode output, carrying one publishable finding against `src/a.ts`. */
  function engineStdoutWithFinding(filesReviewed: number): string {
    return JSON.stringify({
      status: "success",
      summary: { files_reviewed: filesReviewed, total_tokens: 100, budget_exceeded: false },
      comments: [
        {
          path: "src/a.ts",
          content: "This line never validates the input length before using it as an index.",
          start_line: 1,
          end_line: 1,
          severity: "medium",
          category: "bug",
        },
      ],
    });
  }

  function baseRequest(cacheStore: CacheStore | undefined): ReviewRequest {
    const client = new GitHubClient("https://api.example.test", "unused");
    vi.spyOn(client, "getPullRequest").mockResolvedValue({
      headSha: commitSha(headSha),
      draft: false,
      baseRef: "dev",
      headRepoFullName: undefined,
    });
    vi.spyOn(client, "listReviewComments").mockResolvedValue([]);
    return {
      client,
      ref: { owner: "acme", repo: "widget" },
      pullNumber: 1,
      base: commitSha(baseSha),
      head: commitSha(headSha),
      repositoryPath: repo,
      config: CONFIG,
      profile: PROFILE,
      guidelines: { paths: [] },
      identity: "keiko-for-quality[bot]",
      env: {},
      pathValue: process.env.PATH ?? "/usr/bin:/bin",
      ...(cacheStore === undefined ? {} : { cacheStore }),
    };
  }

  it("threads a cache hit into the engine's own exclude list and credits it in settlement", async () => {
    const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
    const engineDigest = currentPlatformDigest();
    expect(engineDigest).toBeDefined();
    if (engineDigest === undefined) return;

    const model = modelId(CONFIG.model);
    const proto = protocol(CONFIG.protocol);
    const base = blobId(baseBlobA);
    const head = blobId(headBlobA);
    const key = computeKey(base, head, ruleDigest, engineDigest, model, proto);
    // Both src/a.ts and src/b.ts are modified in this fixture's base..head diff (see `beforeAll`),
    // neither is a rename, so the token list is exactly their bare paths — matching what
    // `computePrPathSetDigest` derives internally from the real inventory this run builds.
    const currentPathSet = computePathSetDigest(["src/a.ts", "src/b.ts"]);
    const store: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [
        {
          key,
          baseBlob: base,
          headBlob: head,
          ruleDigest,
          engineDigest,
          prPathSetDigest: currentPathSet,
          modelId: model,
          protocol: proto,
          findings: [],
        },
      ],
    };

    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    runEngineMock.mockResolvedValue({ stdout: engineStdout(1), ruleDigest: engineDigest });

    const report = await performReview(baseRequest(store), createSilentDiagnostics());

    // The engine was asked to skip exactly the hit path — proof the union reaches the real call,
    // not just a value threaded through settlement math.
    const [calledOptions] = runEngineMock.mock.calls[0] as [{ mechanicallyCleanPaths: string[] }];
    expect(calledOptions.mechanicallyCleanPaths).toContain("src/a.ts");

    expect(report.outcome).toBe("complete");
    expect(report.cacheHits).toBe(1);
    expect(report.cacheMisses).toBe(1);
    // Both changed files matched `reviewRelevant` and are ordinary edits — neither excluded nor a
    // pure rename — which is what the run summary's (Keiko-for-Quality#31) path accounting reports.
    expect(report.reviewablePaths).toBe(2);
    expect(report.excludedPaths).toBe(0);
    expect(report.mechanicallyClean).toBe(0);
    // src/a.ts's original entry survives untouched; src/b.ts is newly admitted.
    expect(report.updatedCacheStore?.entries).toHaveLength(2);
  });

  it("treats a hit rejected by the path-set digest as an ordinary miss: the file is reviewed and never memoized (v0.10.0, issue #50)", async () => {
    const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
    const engineDigest = currentPlatformDigest();
    expect(engineDigest).toBeDefined();
    if (engineDigest === undefined) return;

    const model = modelId(CONFIG.model);
    const proto = protocol(CONFIG.protocol);
    const base = blobId(baseBlobA);
    const head = blobId(headBlobA);
    const key = computeKey(base, head, ruleDigest, engineDigest, model, proto);
    // Deliberately the WRONG path-set digest — as if this entry were written for a pull request
    // whose changed-file set no longer matches this run's. src/a.ts's content-based key still
    // matches exactly, so this proves the rejection is the path-set gate, not a content miss.
    const stalePathSet = sha256("9".repeat(64));
    const store: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [
        {
          key,
          baseBlob: base,
          headBlob: head,
          ruleDigest,
          engineDigest,
          prPathSetDigest: stalePathSet,
          modelId: model,
          protocol: proto,
          findings: [],
        },
      ],
    };

    // The previous test in this block already recorded a call against these same shared mocks;
    // clear that history so `calls[0]` below is unambiguously this test's own invocation.
    acquireEngineMock.mockClear();
    runEngineMock.mockClear();
    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    // Both reviewable files are dispatched to the engine: src/a.ts's stored entry is rejected by
    // the path-set gate, so it is never excluded the way a genuine hit would be.
    runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

    const report = await performReview(baseRequest(store), createSilentDiagnostics());

    const [calledOptions] = runEngineMock.mock.calls[0] as [{ mechanicallyCleanPaths: string[] }];
    expect(calledOptions.mechanicallyCleanPaths).not.toContain("src/a.ts");

    expect(report.outcome).toBe("complete");
    expect(report.cacheHits).toBe(0);
    expect(report.cacheMisses).toBe(2);

    // The stale entry is refreshed, not duplicated: same key, new (current) path-set digest.
    expect(report.updatedCacheStore?.entries).toHaveLength(2);
    const refreshed = report.updatedCacheStore?.entries.find((e) => e.key === key);
    expect(refreshed?.prPathSetDigest).not.toBe(stalePathSet);
  });

  it("still settles incomplete when the missing file was never memoized", async () => {
    const engineDigest = currentPlatformDigest();
    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    // Only one of the two reviewable files was actually reviewed, and nothing was memoized.
    runEngineMock.mockResolvedValue({ stdout: engineStdout(1), ruleDigest: engineDigest });

    const report = await performReview(baseRequest(undefined), createSilentDiagnostics());

    expect(report.outcome).toBe("incomplete");
    expect(report.cacheHits).toBe(0);
    expect(report.cacheMisses).toBe(0);
  });

  /**
   * The all-zero commit id (git's own placeholder for "no such object" — see `brands.ts`'s
   * `blobId` doc comment for the same idiom on the blob side) is syntactically a valid `CommitSha`
   * but never resolves in this fixture repo, so `verifyCommit` fails exactly as it would against an
   * unfetched commit in production. Neither `acquireEngineMock` nor `runEngineMock` is given a
   * resolved value here: a base/head pair that never resolves must never reach the engine at all.
   */
  it("records review_pair.merge_base_unresolved and fails the run when the base commit cannot be resolved", async () => {
    // Earlier tests in this shared suite already called these mocks; clear that history so
    // "never reached the engine" below is unambiguously about this test's own invocation.
    acquireEngineMock.mockClear();
    runEngineMock.mockClear();
    const diagnostics = createSilentDiagnostics();
    const request = { ...baseRequest(undefined), base: commitSha("0".repeat(40)) };

    await expect(performReview(request, diagnostics)).rejects.toThrow();

    expect(diagnostics.drain().map((r) => r.code)).toEqual([
      "run.started",
      "review_pair.merge_base_unresolved",
    ]);
    expect(acquireEngineMock).not.toHaveBeenCalled();
  });

  /**
   * Keiko-for-Quality#63, run-level: production evidence was a run that settled incomplete with
   * reason `publish.finding_rejected_placement` alone — no breakdown of what was actually tried.
   * `publisher.test.ts` already pins the per-finding tally this same rejection carries one layer
   * down; this proves the run-level event `settleIncomplete` records also carries the publication
   * outcome's own breakdown, not just the bare reason code, so an operator reading *this* one event
   * does not have to go correlate it against the per-finding diagnostics stream by hand.
   */
  it("settles incomplete with the publication outcome's own breakdown when every placement is refused", async () => {
    const engineDigest = currentPlatformDigest();
    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    runEngineMock.mockResolvedValue({
      stdout: engineStdoutWithFinding(2),
      ruleDigest: engineDigest,
    });

    const request = baseRequest(undefined);
    vi.spyOn(request.client, "createReviewComment").mockRejectedValue(new GitHubApiError(422));

    const diagnostics = createSilentDiagnostics();
    const report = await performReview(request, diagnostics);

    expect(report.outcome).toBe("incomplete");
    // The settlement reason moved family for Keiko-for-Quality#57 — from the publication
    // diagnostic naming WHERE the failure was noticed to the settlement code saying what it means
    // for coverage, which is what the published incomplete notice has to answer for a reader with
    // no log access. The #63 invariant this test exists for is untouched: the run-level event
    // still carries the full breakdown rather than a bare code. The per-finding diagnostic keeps
    // its own name, and publisher.test.ts still pins it one layer down.
    expect(report.reason).toBe("settlement.incomplete.publication_degraded");
    expect(report.publish).toMatchObject({ published: 0, rejectedPlacement: 1 });

    // The run-level record carries the full outcome breakdown redactedly: counts and codes only,
    // never the finding's content or the rejection's own message.
    const runLevel = diagnostics
      .drain()
      .filter((record) => record.code === "settlement.incomplete.publication_degraded")
      .at(-1);
    expect(runLevel?.counts).toStrictEqual({
      published: 0,
      rejected_placement: 1,
      rejected_sanitization: 0,
      readback_failures: 0,
      api_failures: 0,
    });
  });

  /**
   * Keiko-for-Quality#38's secondary defect: two byte-identical incomplete-review notices were
   * published against the same head. `settleIncomplete` only checked whether the head was still
   * current on the path reached after a real settlement decision; a run that instead settled
   * incomplete via an unclassified path (found in seconds, before any engine work) or an engine
   * failure (found only after the engine ran) could still publish a notice for a head the pull
   * request had already moved past. These two prove that gap and that closing it makes the run
   * abandon instead of publish.
   */
  describe("staleness guard on every settleIncomplete path", () => {
    /** A client whose pull request has already moved to a different head than `request.head` uses. */
    function staleClient(): GitHubClient {
      const client = new GitHubClient("https://api.example.test", "unused");
      vi.spyOn(client, "getPullRequest").mockResolvedValue({
        headSha: commitSha("f".repeat(40)),
        draft: false,
        baseRef: "dev",
        headRepoFullName: undefined,
      });
      vi.spyOn(client, "listReviewComments").mockResolvedValue([]);
      return client;
    }

    it("abandons an unclassified-path settlement once the head has moved on", async () => {
      // `reviewRelevant` must be non-empty to pass profile validation, but "docs/**" matches
      // neither `src/a.ts` nor `src/b.ts`, so both fall through to `unclassified`.
      const profile = compileProfile({
        version: 1,
        reviewRelevant: ["docs/**"],
        deletionCritical: [],
        generated: [],
        excluded: [],
        benignWarnings: [],
        pathInstructions: [],
      } satisfies ReviewProfile);
      const client = staleClient();
      const createSpy = vi.spyOn(client, "createReviewComment").mockResolvedValue({
        id: 1,
        body: "",
        path: "src/a.ts",
        authorLogin: "keiko-for-quality[bot]",
        commitId: headSha,
        url: "https://example.test/c",
      });

      const request: ReviewRequest = {
        client,
        ref: { owner: "acme", repo: "widget" },
        pullNumber: 1,
        base: commitSha(baseSha),
        head: commitSha(headSha),
        repositoryPath: repo,
        config: CONFIG,
        profile,
        guidelines: { paths: [] },
        identity: "keiko-for-quality[bot]",
        env: {},
        pathValue: process.env.PATH ?? "/usr/bin:/bin",
      };

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("abandoned");
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("abandons an engine-failure settlement once the head has moved on", async () => {
      runEngineMock.mockClear();
      acquireEngineMock.mockClear();
      acquireEngineMock.mockResolvedValue({
        binaryPath: "/fake/engine",
        digest: currentPlatformDigest(),
      });
      runEngineMock.mockRejectedValue(new Error("engine spawn failed"));

      // Fresh on the FIRST call, stale from then on — the pre-flight check (`performReview`, right
      // after `prepareMemoization`) would otherwise find the head already stale and return before
      // the engine ever runs, the same way the new "pre-flight head check" tests exercise it. That
      // would leave this test unable to fail if the guard THIS block is named for — the one inside
      // `settleIncomplete`, reached only after a real engine failure — ever regressed: it would still
      // read "abandoned" for the wrong reason. Fresh-then-stale reproduces the actual race instead:
      // the head was current when the engine started and moved only while it ran.
      const client = new GitHubClient("https://api.example.test", "unused");
      vi.spyOn(client, "getPullRequest")
        .mockResolvedValueOnce({
          headSha: commitSha(headSha),
          draft: false,
          baseRef: "dev",
          headRepoFullName: undefined,
        })
        .mockResolvedValue({
          headSha: commitSha("f".repeat(40)),
          draft: false,
          baseRef: "dev",
          headRepoFullName: undefined,
        });
      vi.spyOn(client, "listReviewComments").mockResolvedValue([]);
      const createSpy = vi.spyOn(client, "createReviewComment").mockResolvedValue({
        id: 1,
        body: "",
        path: "src/a.ts",
        authorLogin: "keiko-for-quality[bot]",
        commitId: headSha,
        url: "https://example.test/c",
      });

      const request: ReviewRequest = {
        client,
        ref: { owner: "acme", repo: "widget" },
        pullNumber: 1,
        base: commitSha(baseSha),
        head: commitSha(headSha),
        repositoryPath: repo,
        config: CONFIG,
        profile: PROFILE,
        guidelines: { paths: [] },
        identity: "keiko-for-quality[bot]",
        env: {},
        pathValue: process.env.PATH ?? "/usr/bin:/bin",
      };

      const report = await performReview(request, createSilentDiagnostics());

      // The pre-flight check passed (fresh), so the engine genuinely ran and failed — proof this
      // run reached the post-run guard rather than being short-circuited before it.
      expect(runEngineMock).toHaveBeenCalledTimes(1);
      expect(report.outcome).toBe("abandoned");
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  /**
   * A pull request can move its head during the engine's own minutes-long run, so the post-run
   * checks above stay necessary — but they only fire AFTER that spend already happened. This is the
   * cheaper half: the same `headIsCurrent` check, run once more immediately after `prepareMemoization`
   * and before the engine is even acquired, so a head that is ALREADY stale never pays for a review
   * whose findings would be abandoned anyway. One extra `getPullRequest` call is the price.
   */
  describe("performReview: pre-flight head check", () => {
    it("abandons before the engine runs when the head is already stale, keeping the memo's cache counts", async () => {
      const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
      const engineDigest = currentPlatformDigest();
      expect(engineDigest).toBeDefined();
      if (engineDigest === undefined) return;

      const model = modelId(CONFIG.model);
      const proto = protocol(CONFIG.protocol);
      const base = blobId(baseBlobA);
      const head = blobId(headBlobA);
      const key = computeKey(base, head, ruleDigest, engineDigest, model, proto);
      const currentPathSet = computePathSetDigest(["src/a.ts", "src/b.ts"]);
      // One hit (src/a.ts), one miss (src/b.ts) — the same shape as the very first test in this
      // file, reused here so `report.cacheHits`/`cacheMisses` prove the abandoned report carries the
      // real `MemoContext` `prepareMemoization` computed, not an empty/inert placeholder.
      const store: CacheStore = {
        schemaVersion: SUPPORTED_STORE_SCHEMA,
        entries: [
          {
            key,
            baseBlob: base,
            headBlob: head,
            ruleDigest,
            engineDigest,
            prPathSetDigest: currentPathSet,
            modelId: model,
            protocol: proto,
            findings: [],
          },
        ],
      };

      const client = new GitHubClient("https://api.example.test", "unused");
      // Stale from the very first call — unlike the fresh-then-stale race reproduced above, the
      // pre-flight check is meant to catch exactly this: a head that never needed the engine's run
      // to already be superseded.
      vi.spyOn(client, "getPullRequest").mockResolvedValue({
        headSha: commitSha("f".repeat(40)),
        draft: false,
        baseRef: "dev",
        headRepoFullName: undefined,
      });
      vi.spyOn(client, "listReviewComments").mockResolvedValue([]);
      const createSpy = vi.spyOn(client, "createReviewComment").mockResolvedValue({
        id: 1,
        body: "",
        path: "src/a.ts",
        authorLogin: "keiko-for-quality[bot]",
        commitId: headSha,
        url: "https://example.test/c",
      });

      acquireEngineMock.mockClear();
      runEngineMock.mockClear();

      const request: ReviewRequest = {
        client,
        ref: { owner: "acme", repo: "widget" },
        pullNumber: 1,
        base: commitSha(baseSha),
        head: commitSha(headSha),
        repositoryPath: repo,
        config: CONFIG,
        profile: PROFILE,
        guidelines: { paths: [] },
        identity: "keiko-for-quality[bot]",
        env: {},
        pathValue: process.env.PATH ?? "/usr/bin:/bin",
        cacheStore: store,
      };

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(request, diagnostics);

      expect(report.outcome).toBe("abandoned");
      // The memo's own counts survive into the abandoned report exactly as `prepareMemoization`
      // computed them — proof this returns `abandonedReport(inventory, memo)` rather than discarding
      // the lookup it just paid for.
      expect(report.cacheHits).toBe(1);
      expect(report.cacheMisses).toBe(1);

      // The expensive half of the run never started: no binary acquired, no engine spawned.
      expect(acquireEngineMock).not.toHaveBeenCalled();
      expect(runEngineMock).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();

      const codes = diagnostics.drain().map((record) => record.code);
      expect(codes).toContain("publish.abandoned_stale_head");
      // SpendLedger (v0.12.0): the engine never ran and no classify call ever happened, so
      // `performReview`'s `finally` block must not write a zero-spend `run.spend` line — that would
      // misreport an abandoned run as one that reviewed the change for free.
      expect(codes).not.toContain("run.spend");
    });

    it("still runs the engine when the head is current at the pre-flight check", async () => {
      runEngineMock.mockClear();
      acquireEngineMock.mockClear();
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const report = await performReview(baseRequest(undefined), createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(runEngineMock).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The safety half of Keiko-for-Quality#75, and the reason that change is narrow.
   *
   * A budget-truncated run keeps the verdicts for files it reached, so a large pull request stops
   * re-pricing everything on every push. The danger in doing that is worse than the cost it fixes:
   * if the store also absorbed the files the engine never opened, they would be frozen as "clean"
   * and replayed with confidence nobody earned — a review that silently stops reviewing.
   *
   * So this drives a real budget overrun whose manifest covers `src/a.ts` and NOT `src/b.ts`, and
   * pins both halves: the reached file is persisted, the unreached one is not, at any price.
   */
  it("persists only what a budget-truncated run actually reviewed", async () => {
    // Placed last on purpose: an earlier engine call would shift `mock.calls[0]` under the test
    // that reads the first call to prove the exclude list reached the engine.
    runEngineMock.mockClear();
    const engineDigest = currentPlatformDigest();
    expect(engineDigest).toBeDefined();
    if (engineDigest === undefined) return;

    const truncated = JSON.stringify({
      status: "success",
      summary: { files_reviewed: 1, total_tokens: 9_000_000, budget_exceeded: true },
      comments: [],
      manifest: {
        schema_version: SUPPORTED_MANIFEST_SCHEMA,
        terminal_state: "complete",
        // The engine reached src/a.ts and stopped before src/b.ts.
        coverage: {
          selected: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
          completed: [{ path: "src/a.ts" }],
          reused: [],
          failed: [],
          waived: [],
        },
      },
    });

    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    runEngineMock.mockResolvedValue({ stdout: truncated, ruleDigest: engineDigest });

    const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
    const report = await performReview(baseRequest(empty), createSilentDiagnostics());

    expect(report.outcome).toBe("incomplete");
    // A budget truncation surfaces as a COVERAGE GAP, not as `budget_exceeded`: the files the
    // engine never reached are the gap, and `settleReconciled` asks that question before the
    // budget one. That ordering is why both reasons have to be in the survivor set — pinning only
    // `budget_exceeded` would have left the realistic case unmemoized and the fix inert.
    expect(report.reason).toBe("settlement.incomplete.coverage_gap");

    const persisted = report.updatedCacheStore;
    expect(persisted).toBeDefined();
    // Entries are keyed by blob, not by path, so identify them the way a replay would: by the head
    // blob of the file in question. Asserting on a `path` field the entry does not carry would
    // have compared undefined to undefined and passed over any behaviour at all.
    const headBlobB = git(["rev-parse", `${headSha}:src/b.ts`]).trim();
    const blobs = (persisted?.entries ?? []).map((e) => String(e.headBlob));
    // Safety first, literally: the file the engine never opened must never be replayable as
    // reviewed. This assertion leads so that a regression fails on the property that matters
    // rather than on a count that merely correlates with it.
    expect(blobs).not.toContain(headBlobB);
    // And the file it did reach earned its verdict, which is the whole point of persisting at all.
    expect(blobs).toContain(headBlobA);
    expect(report.cacheAppended).toBe(1);
  });

  describe("performReview: bounded single resume (#57)", () => {
    beforeEach(() => {
      // The harness mocks are shared across this whole file and deliberately never auto-reset;
      // these tests count invocations, so they start from a clean call history and a clean
      // implementation queue — otherwise a leftover default from an earlier test would answer
      // the call after the queued failures and turn "settles incomplete" into a false complete.
      runEngineMock.mockReset();
      acquireEngineMock.mockReset();
    });

    function nonSuccessStdout(): string {
      return JSON.stringify({
        status: "failed",
        summary: { files_reviewed: 0, total_tokens: 0, budget_exceeded: false },
        comments: [],
      });
    }

    it("re-invokes once when the first run reports a non-success status, and the second stands", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock
        .mockResolvedValueOnce({ stdout: nonSuccessStdout(), ruleDigest: engineDigest })
        .mockResolvedValueOnce({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(runEngineMock).toHaveBeenCalledTimes(2);
      const codes = diagnostics.drain().map((record) => record.code);
      expect(codes.filter((code) => code === "engine.resumed_once")).toHaveLength(1);
    });

    it("re-invokes once when the first run throws an EngineRunError", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock
        .mockRejectedValueOnce(new EngineRunError("engine.run.nonzero_exit"))
        .mockResolvedValueOnce({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const report = await performReview(baseRequest(undefined), createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(runEngineMock).toHaveBeenCalledTimes(2);
      // The retry must not replay the failure: pinned sampling makes a deterministic failure
      // reproduce itself, so the second attempt carries a different seed.
      const firstOptions = runEngineMock.mock.calls[0]?.[0] as { samplingSeed?: number };
      const secondOptions = runEngineMock.mock.calls[1]?.[0] as { samplingSeed?: number };
      expect(firstOptions.samplingSeed).toBeUndefined();
      expect(secondOptions.samplingSeed).toBe(43);
      // A thrown first attempt spends nothing measured, so `remaining` stays the untouched full
      // allotment (see `runEngineWithOneResume`'s own comment) rather than being reduced by
      // anything the resume-floor formula computes — the second call's budget equals the first's.
      const firstBudget = (runEngineMock.mock.calls[0]?.[0] as { allottedBudget: number })
        .allottedBudget;
      const secondBudget = (runEngineMock.mock.calls[1]?.[0] as { allottedBudget: number })
        .allottedBudget;
      expect(secondBudget).toBeLessThanOrEqual(firstBudget);
    });

    it("settles incomplete after the second failure — one resume, never two", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock
        .mockResolvedValueOnce({ stdout: nonSuccessStdout(), ruleDigest: engineDigest })
        .mockResolvedValueOnce({ stdout: nonSuccessStdout(), ruleDigest: engineDigest });

      const report = await performReview(baseRequest(undefined), createSilentDiagnostics());

      expect(report.outcome).toBe("incomplete");
      expect(runEngineMock).toHaveBeenCalledTimes(2);
    });

    /**
     * The leak this block closes: a first attempt that reports spending its whole allotment used
     * to still unlock a further flat `ALLOTMENT_FLOOR` (80,000) tokens on the resume, regardless of
     * how large the review's own allotment was. `RESUME_FLOOR_FRACTION` replaces that flat floor
     * with a quarter of THIS review's own allotment, so the resume's own budget is asserted here
     * directly against the value `computeAllottedBudget` actually gave the first call — never a
     * hard-coded 80,000 — which is what makes this test fail if the formula ever regresses back to
     * the constant floor.
     */
    it("floors the resume at a quarter of this review's own allotment, never the fixed 80,000 floor", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // Non-success, and reports spending far more than any plausible allotment for this tiny
      // fixture — `budget_exceeded` stays false, since a first attempt that itself flagged the
      // budget exceeded takes the OTHER new path (skips the resume entirely — see below).
      const overspent = JSON.stringify({
        status: "failed",
        summary: { files_reviewed: 0, total_tokens: 9_000_000, budget_exceeded: false },
        comments: [],
      });
      runEngineMock
        .mockResolvedValueOnce({ stdout: overspent, ruleDigest: engineDigest })
        .mockResolvedValueOnce({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const report = await performReview(baseRequest(undefined), createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(runEngineMock).toHaveBeenCalledTimes(2);
      const firstBudget = (runEngineMock.mock.calls[0]?.[0] as { allottedBudget: number })
        .allottedBudget;
      const secondBudget = (runEngineMock.mock.calls[1]?.[0] as { allottedBudget: number })
        .allottedBudget;
      expect(secondBudget).toBe(Math.round(firstBudget * 0.25));
      expect(secondBudget).not.toBe(80_000);
    });

    it("gives the resume the real remainder when the first attempt spent only part of its allotment", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // The mocked first response reads back `options.allottedBudget` so the fixture does not need
      // to hard-code a number this test itself does not control — 30% spent, however large the
      // real allotment `computeAllottedBudget` gave this run turns out to be.
      runEngineMock
        .mockImplementationOnce((options: { allottedBudget: number }) => ({
          stdout: JSON.stringify({
            status: "failed",
            summary: {
              files_reviewed: 0,
              total_tokens: Math.round(options.allottedBudget * 0.3),
              budget_exceeded: false,
            },
            comments: [],
          }),
          ruleDigest: engineDigest,
        }))
        .mockResolvedValueOnce({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const report = await performReview(baseRequest(undefined), createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      const firstBudget = (runEngineMock.mock.calls[0]?.[0] as { allottedBudget: number })
        .allottedBudget;
      const secondBudget = (runEngineMock.mock.calls[1]?.[0] as { allottedBudget: number })
        .allottedBudget;
      const spent = Math.round(firstBudget * 0.3);
      // The real 70% remainder, not the 25% floor — the floor only binds once the true remainder
      // would otherwise fall beneath it.
      expect(secondBudget).toBe(firstBudget - spent);
      expect(secondBudget).toBeGreaterThan(Math.round(firstBudget * 0.25));
    });

    it("skips the resume entirely when the first attempt already reports its budget exceeded", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const overBudget = JSON.stringify({
        status: "failed",
        summary: { files_reviewed: 1, total_tokens: 40_000, budget_exceeded: true },
        comments: [],
      });
      runEngineMock.mockResolvedValueOnce({ stdout: overBudget, ruleDigest: engineDigest });

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      // No second opinion: the resume's own budget can only be carved from what the first attempt
      // left, and the first attempt already reports nothing left.
      expect(runEngineMock).toHaveBeenCalledTimes(1);

      // `settleCounted` (settle.ts) decides on `status` before it ever looks at `budgetExceeded`,
      // so a non-success counted-mode result settles for the same reason whether or not a resume
      // was ever attempted — this is exactly today's behaviour for this engine output, not a new
      // outcome the skip introduces.
      expect(report.outcome).toBe("incomplete");
      expect(report.reason).toBe("settlement.incomplete.engine_status_not_success");

      // Skipped, not resumed: the resume-only diagnostic must not fire for a resume that never ran.
      const codes = diagnostics.drain().map((record) => record.code);
      expect(codes).not.toContain("engine.resumed_once");

      // Exactly the first (and only) attempt's own tokens — never a guess, and never inflated by a
      // second call that never happened.
      const spend = diagnostics.drain().find((record) => record.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 40_000, classify: 0, total: 40_000 });
    });
  });

  /**
   * Run-level spend accounting (v0.12.0). `executeEngine` records exactly one `run.spend` per run,
   * naming what the review actually cost — the defect this closes is `publish/summary.ts` reading
   * whichever `counts.tokens` record happened to fire last, which in practice was the
   * classification audit's own bill, an order of magnitude below the engine's real spend.
   */
  describe("performReview: run.spend accounting (v0.12.0)", () => {
    beforeEach(() => {
      // Same reasoning as the resume block above: a clean call history and implementation queue,
      // not a default left over from a previous test in this file.
      runEngineMock.mockReset();
      acquireEngineMock.mockReset();
    });

    /** `files_reviewed` fixed at 2 — this block asserts on token accounting, not coverage. */
    function statusStdout(status: "success" | "failed", totalTokens: number): string {
      return JSON.stringify({
        status,
        summary: { files_reviewed: 2, total_tokens: totalTokens, budget_exceeded: false },
        comments: [],
      });
    }

    it("records engine, classify, and total on the plain single-attempt path", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: statusStdout("success", 250),
        ruleDigest: engineDigest,
      });

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      expect(report.outcome).toBe("complete");
      // CONFIG.protocol is "anthropic" throughout this file, so classification repair never calls
      // out — the whole spend is exactly the engine's own reported total.
      const spend = diagnostics.drain().find((record) => record.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 250, classify: 0, total: 250 });
    });

    it("sums both attempts' engine tokens across a parsed non-success plus its resume", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock
        .mockResolvedValueOnce({ stdout: statusStdout("failed", 30), ruleDigest: engineDigest })
        .mockResolvedValueOnce({ stdout: statusStdout("success", 100), ruleDigest: engineDigest });

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      expect(report.outcome).toBe("complete");
      // 30 from the discarded first attempt plus 100 from the resume that actually stands — the
      // first attempt's spend was real and must not vanish just because its result was discarded.
      const spend = diagnostics.drain().find((record) => record.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 130, classify: 0, total: 130 });
    });

    it("contributes exactly zero for a thrown first attempt, never a guess", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock
        .mockRejectedValueOnce(new EngineRunError("engine.run.nonzero_exit"))
        .mockResolvedValueOnce({ stdout: statusStdout("success", 100), ruleDigest: engineDigest });

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      expect(report.outcome).toBe("complete");
      // Nothing measured says what the thrown attempt spent, so it contributes 0 — the total is
      // exactly the resume's own tokens, neither inflated nor reduced by the failure.
      const spend = diagnostics.drain().find((record) => record.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 0, total: 100 });
    });

    it("records classify: 0 on the anthropic protocol path even when findings are present", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: engineStdoutWithFinding(2),
        ruleDigest: engineDigest,
      });

      const request = baseRequest(undefined);
      // Rejected rather than left to hit the real (unreachable) example.test host: this test is
      // about the spend record `executeEngine` writes well before publication runs, not about
      // publication itself, so how that later step resolves is irrelevant here — 422 is the same
      // "no anchor on the diff" ladder-exhaustion path `publisher.test.ts` covers on its own terms.
      vi.spyOn(request.client, "createReviewComment").mockRejectedValue(new GitHubApiError(422));

      const diagnostics = createSilentDiagnostics();
      await performReview(request, diagnostics);

      // The finding arrives already validly classified, but that is not why classify is 0 here:
      // `repairFindingClassification`'s anthropic check returns before it ever looks at the
      // findings at all, so classify stays 0 regardless of how many arrived.
      const spend = diagnostics.drain().find((record) => record.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 0, total: 100 });
    });
  });

  /**
   * The classification cost bomb (order guard): `repairEngineFindings` runs BEFORE `settle`, and the
   * engine's own result parser accepts up to 1,000 findings while `config.maxFindings` (50 here) is
   * only enforced inside `settle`'s `commonDisqualifier`. Left unchecked, a runaway or
   * prompt-injected result with hundreds of findings would pay repair's model calls per finding for a
   * run `settle` disqualifies as implausible either way. These use the openai protocol (unlike this
   * file's shared `CONFIG`, which is anthropic and would skip classification for an unrelated reason)
   * so a fetch call would genuinely happen if the guard did not intervene.
   *
   * The classification AUDIT (v0.12.0, moved to the publication path — see the
   * "classification audit moves to the publication path" describe block below) needs no analogous
   * guard of its own here: `settle`'s `commonDisqualifier` discards a disqualified result's findings
   * outright (`findings: []`), so by the time publication could run the audit, there is nothing left
   * for it to see. The second test below still proves the END-TO-END spend stays bounded at exactly
   * `maxFindings`, repair and audit together — see its own updated comment.
   */
  describe("performReview: classification flood guard (order guard)", () => {
    const OPENAI_CONFIG: RuntimeConfig = { ...CONFIG, protocol: "openai", model: "gpt-oss-test" };
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      runEngineMock.mockReset();
      acquireEngineMock.mockReset();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** `count` synthetic findings, none pre-classified, split across both fixture files. */
    function manyFindingsStdout(count: number, filesReviewed: number): string {
      const comments = Array.from({ length: count }, (_unused, i) => ({
        path: i % 2 === 0 ? "src/a.ts" : "src/b.ts",
        content: `Synthetic finding ${String(i)} describing a distinct hypothetical defect for this test.`,
        start_line: 1,
        end_line: 1,
      }));
      return JSON.stringify({
        status: "success",
        summary: { files_reviewed: filesReviewed, total_tokens: 100, budget_exceeded: false },
        comments,
      });
    }

    /** A request that would genuinely reach the classify endpoint if the flood guard let it through. */
    function openaiRequest(): ReviewRequest {
      const request = baseRequest(undefined);
      // Rejected deterministically — same trick as `run.spend accounting`'s anthropic-path test
      // above: these tests are about whether the CLASSIFY call happens, not about publication.
      vi.spyOn(request.client, "createReviewComment").mockRejectedValue(new GitHubApiError(422));
      return { ...request, config: OPENAI_CONFIG, env: { MODEL_TOKEN: "fake-token" } };
    }

    it("never calls the classify endpoint over maxFindings, and settle still disqualifies the run", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // maxFindings + 1 — one past the threshold `settle.ts`'s own `commonDisqualifier` enforces.
      runEngineMock.mockResolvedValue({
        stdout: manyFindingsStdout(OPENAI_CONFIG.maxFindings + 1, 2),
        ruleDigest: engineDigest,
      });

      let classifyCalls = 0;
      globalThis.fetch = (() => {
        classifyCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(openaiRequest(), diagnostics);

      // `settle` disqualifies a >maxFindings result as implausible regardless of this guard — the
      // guard changes only WHETHER it is classified first, never whether `settle` accepts it.
      expect(report.outcome).toBe("incomplete");
      expect(report.reason).toBe("settlement.incomplete.engine_error");
      expect(classifyCalls).toBe(0);

      const spend = diagnostics.drain().find((record) => record.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 0, total: 100 });
    });

    it("still classifies at exactly maxFindings — the guard's threshold is '>', matching settle's own", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: manyFindingsStdout(OPENAI_CONFIG.maxFindings, 2),
        ruleDigest: engineDigest,
      });

      let classifyCalls = 0;
      globalThis.fetch = (() => {
        classifyCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"category":"bug","severity":"medium"}' } }],
              usage: { total_tokens: 10 },
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;

      const diagnostics = createSilentDiagnostics();
      await performReview(openaiRequest(), diagnostics);

      // Exact call/token counts belong to `classify.test.ts`, which already pins repair's and
      // audit's own retry and voting behaviour; what THIS guard controls is only whether any of it
      // runs at all, so a non-zero count is the whole claim being tested. Unchanged by the audit's
      // v0.12.0 move to the publication path: none of these findings collide with an existing
      // marker (a fresh pull request, `baseRequest`'s empty `listReviewComments`), so every one of
      // them survives planning and is still a candidate for the audit exactly as it was before the
      // move — the fetch count (and the fact `classify` end up non-zero on `run.spend`, which now
      // sums repair AND audit together, v0.12.0) is identical either way.
      expect(classifyCalls).toBeGreaterThan(0);
      const spend = diagnostics.drain().find((record) => record.code === "run.spend");
      expect(spend?.counts?.classify).toBeGreaterThan(0);
    });
  });

  /**
   * The change-level pass (issue #80, technique C) ships dark: `cross_artifact_pass` defaults to
   * false, and these tests pin the wiring — the flag gates everything, the budget guard records its
   * skip honestly, and an enabled pass runs exactly one extra model call. The module's own parsing
   * and bounds belong to `contracts/change-pass.test.ts`; this block proves `performReview` routes
   * it correctly.
   */
  describe("performReview: change-level pass wiring (v0.12.0, #80 technique C)", () => {
    const PASS_CONFIG: RuntimeConfig = {
      ...CONFIG,
      protocol: "openai",
      model: "gpt-oss-test",
      crossArtifactPass: true,
    };
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      runEngineMock.mockReset();
      acquireEngineMock.mockReset();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function cleanEngineStdout(): string {
      return JSON.stringify({
        status: "success",
        summary: { files_reviewed: 2, total_tokens: 100, budget_exceeded: false },
        comments: [],
      });
    }

    function passRequest(config: RuntimeConfig): ReviewRequest {
      const request = baseRequest(undefined);
      return { ...request, config, env: { MODEL_TOKEN: "fake-token" } };
    }

    it("does nothing at all when the flag is off — not even a diagnostic", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: cleanEngineStdout(), ruleDigest: engineDigest });
      let fetchCalls = 0;
      globalThis.fetch = (() => {
        fetchCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(
        passRequest({ ...PASS_CONFIG, crossArtifactPass: false }),
        diagnostics,
      );

      expect(report.outcome).toBe("complete");
      expect(fetchCalls).toBe(0);
      expect(diagnostics.drain().some((r) => r.code === "contracts.change_pass")).toBe(false);
    });

    it("runs the pass when enabled and records its outcome, without failing the run", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: cleanEngineStdout(), ruleDigest: engineDigest });
      let fetchCalls = 0;
      globalThis.fetch = (() => {
        fetchCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(passRequest(PASS_CONFIG), diagnostics);

      expect(report.outcome).toBe("complete");
      // This fixture's files carry no summarizable exported declarations (`export const a = 2;`
      // has no type annotation), so the module's own zero-summary short-circuit fires and no model
      // call happens — the case a real repo hits when a change touches nothing declaration-shaped.
      // What the WIRING owns, and what this pins, is that the pass ran its guards, recorded its
      // outcome honestly, and cost nothing; the fetch-reaching path is pinned by
      // `contracts/change-pass.test.ts` against summarizable fixtures.
      expect(fetchCalls).toBe(0);
      const record = diagnostics.drain().find((r) => r.code === "contracts.change_pass");
      expect(record?.counts).toStrictEqual({
        findings: 0,
        dropped_unanchorable: 0,
        tokens: 0,
        skipped_budget: 0,
      });
    });

    it("skips on an exhausted allotment and says so, instead of overdrawing", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: cleanEngineStdout(), ruleDigest: engineDigest });
      let fetchCalls = 0;
      globalThis.fetch = (() => {
        fetchCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;

      const diagnostics = createSilentDiagnostics();
      // A 1,000-token ceiling leaves well under CHANGE_PASS_RESERVE_TOKENS after the engine's own
      // 100 — the pass must decline rather than become the reason the run overdraws.
      const report = await performReview(
        passRequest({ ...PASS_CONFIG, tokenBudget: 1_000 }),
        diagnostics,
      );

      expect(report.outcome).toBe("complete");
      expect(fetchCalls).toBe(0);
      const record = diagnostics.drain().find((r) => r.code === "contracts.change_pass");
      expect(record?.counts?.skipped_budget).toBe(1);
      expect(record?.counts?.findings).toBe(0);
    });
  });

  /**
   * The deterministic contract gate (issue #80, technique D) end to end: a profile-declared pair
   * whose two same-named interfaces drifted produces a published, file-level finding on the changed
   * side — with ZERO model calls, because a gate finding is a fact about two declarations, not an
   * opinion the audit could second-guess. Runs last in this file: it adds one commit on top of the
   * shared fixture repo, which leaves every sha earlier tests captured untouched.
   */
  describe("performReview: deterministic contract gate (v0.12.0, #80 technique D)", () => {
    const GATE_CONFIG: RuntimeConfig = { ...CONFIG, protocol: "openai", model: "gpt-oss-test" };
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("publishes a drift finding for a declared pair, deterministically and unaudited", async () => {
      await writeFile(
        join(repo, "src/server-api.ts"),
        "export interface ApiShape {\n  a: string;\n  b: string;\n}\n",
      );
      await writeFile(
        join(repo, "src/client-api.ts"),
        "export interface ApiShape {\n  a: string;\n}\n",
      );
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "gate", "--no-gpg-sign"]);
      const gateHead = git(["rev-parse", "HEAD"]).trim();

      const gateProfile = compileProfile({
        version: 1,
        reviewRelevant: ["src/**"],
        deletionCritical: [],
        generated: [],
        excluded: [],
        benignWarnings: [],
        pathInstructions: [],
        contractPairs: [{ paths: ["src/server-api.ts"], counterparts: ["src/client-api.ts"] }],
      } satisfies ReviewProfile);

      const client = new GitHubClient("https://api.example.test", "unused");
      const created: ReviewCommentInput[] = [];
      const comments: ReviewComment[] = [];
      vi.spyOn(client, "getPullRequest").mockResolvedValue({
        headSha: commitSha(gateHead),
        draft: false,
        baseRef: "dev",
        headRepoFullName: undefined,
      });
      vi.spyOn(client, "listReviewComments").mockResolvedValue([]);
      vi.spyOn(client, "createReviewComment").mockImplementation((_ref, _num, input) => {
        created.push(input);
        const comment: ReviewComment = {
          id: comments.length + 1,
          body: input.body,
          path: input.path,
          authorLogin: "keiko-for-quality[bot]",
          commitId: input.commitId,
          url: "https://example.test/c",
        };
        comments.push(comment);
        return Promise.resolve(comment);
      });
      vi.spyOn(client, "getReviewComment").mockImplementation((_ref, id) =>
        Promise.resolve(comments[id - 1]!),
      );

      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: JSON.stringify({
          status: "success",
          summary: { files_reviewed: 2, total_tokens: 100, budget_exceeded: false },
          comments: [],
        }),
        ruleDigest: engineDigest,
      });

      let modelCalls = 0;
      globalThis.fetch = (() => {
        modelCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(
        {
          ...baseRequest(undefined),
          client,
          base: commitSha(headSha),
          head: commitSha(gateHead),
          config: GATE_CONFIG,
          profile: gateProfile,
          env: { MODEL_TOKEN: "fake-token" },
        },
        diagnostics,
      );

      expect(report.outcome).toBe("complete");
      expect(report.publish?.published).toBe(1);
      expect(created[0]?.path).toBe("src/server-api.ts");
      expect(created[0]?.body).toContain("ApiShape");
      expect(created[0]?.body).toContain("client-api.ts");
      // Deterministic means deterministic: no audit, no repair, no pass — zero model traffic.
      expect(modelCalls).toBe(0);
      const record = diagnostics.drain().find((r) => r.code === "contracts.gate");
      expect(record?.counts).toStrictEqual({
        pairs: 1,
        compared: 1,
        findings: 1,
        pin_desync: 0,
      });
    });

    /**
     * The production miss this check was built for, end to end: oscharko-dev/Keiko#2977 advanced a
     * pinned action's sha and left the variable declaring the same sha behind, silently disabling
     * the consumer's own review store. Two other reviewers caught it; this one published nothing.
     * The fixture is that exact shape — one file, the same 40-hex value at two sites, the head
     * moving only one of them — and it must now produce a published finding without a single model
     * call, because a value declared twice and changed once is a fact, not an opinion.
     */
    it("catches a same-file duplicate pin the change moved at only one site", async () => {
      const oldSha = "1".repeat(40);
      const newSha = "2".repeat(40);
      const workflow = (usesSha: string, pinSha: string): string =>
        [
          "jobs:",
          "  review:",
          "    steps:",
          `      - uses: acme/reviewer@${usesSha} # keep in sync with ACTION_PIN`,
          "        env:",
          `          ACTION_PIN: "${pinSha}"`,
          "",
        ].join("\n");

      await writeFile(join(repo, "src/pinned.yml"), workflow(oldSha, oldSha));
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "pin-base", "--no-gpg-sign"]);
      const pinBase = git(["rev-parse", "HEAD"]).trim();
      // Only the `uses:` site advances — exactly the change that looked correct in isolation.
      await writeFile(join(repo, "src/pinned.yml"), workflow(newSha, oldSha));
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "pin-head", "--no-gpg-sign"]);
      const pinHead = git(["rev-parse", "HEAD"]).trim();

      const client = new GitHubClient("https://api.example.test", "unused");
      const created: ReviewCommentInput[] = [];
      const comments: ReviewComment[] = [];
      vi.spyOn(client, "getPullRequest").mockResolvedValue({
        headSha: commitSha(pinHead),
        draft: false,
        baseRef: "dev",
        headRepoFullName: undefined,
      });
      vi.spyOn(client, "listReviewComments").mockResolvedValue([]);
      vi.spyOn(client, "createReviewComment").mockImplementation((_ref, _num, input) => {
        created.push(input);
        const comment: ReviewComment = {
          id: comments.length + 1,
          body: input.body,
          path: input.path,
          authorLogin: "keiko-for-quality[bot]",
          commitId: input.commitId,
          url: "https://example.test/c",
        };
        comments.push(comment);
        return Promise.resolve(comment);
      });
      vi.spyOn(client, "getReviewComment").mockImplementation((_ref, id) =>
        Promise.resolve(comments[id - 1]!),
      );

      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: JSON.stringify({
          status: "success",
          summary: { files_reviewed: 1, total_tokens: 100, budget_exceeded: false },
          comments: [],
        }),
        ruleDigest: engineDigest,
      });

      let modelCalls = 0;
      globalThis.fetch = (() => {
        modelCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(
        {
          ...baseRequest(undefined),
          client,
          base: commitSha(pinBase),
          head: commitSha(pinHead),
          config: GATE_CONFIG,
          env: { MODEL_TOKEN: "fake-token" },
        },
        diagnostics,
      );

      expect(report.outcome).toBe("complete");
      expect(report.publish?.published).toBe(1);
      expect(created[0]?.path).toBe("src/pinned.yml");
      expect(modelCalls).toBe(0);
      const record = diagnostics.drain().find((r) => r.code === "contracts.gate");
      expect(record?.counts?.pin_desync).toBe(1);
    });

    /**
     * The corpus case `status-union-widened-consumer-missed`, which a full qualification run
     * measured as a MISS in both arms: a status union gains `"rejected"`, and the consumer's
     * predicate — unchanged, so invisible in the diff — still excludes only `"needs-review"`, which
     * silently makes a rejected candidate deliverable. The model saw the widening and did not
     * follow it to the consumer. The declared pair plus a text fact — the counterpart never
     * mentions the new member at all — closes it deterministically.
     */
    it("catches a union member no declared counterpart mentions", async () => {
      await writeFile(
        join(repo, "src/status.ts"),
        'export type CandidateStatus = "ready" | "needs-review";\n',
      );
      await writeFile(
        join(repo, "src/deliverability.ts"),
        [
          'import type { CandidateStatus } from "./status.js";',
          "",
          "export function isDeliverable(status: CandidateStatus): boolean {",
          '  return status !== "needs-review";',
          "}",
          "",
        ].join("\n"),
      );
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "union-base", "--no-gpg-sign"]);
      const unionBase = git(["rev-parse", "HEAD"]).trim();
      // Only the union widens. The consumer is untouched and never appears in the diff.
      await writeFile(
        join(repo, "src/status.ts"),
        'export type CandidateStatus = "ready" | "needs-review" | "rejected";\n',
      );
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "union-head", "--no-gpg-sign"]);
      const unionHead = git(["rev-parse", "HEAD"]).trim();

      const unionProfile = compileProfile({
        version: 1,
        reviewRelevant: ["src/**"],
        deletionCritical: [],
        generated: [],
        excluded: [],
        benignWarnings: [],
        pathInstructions: [],
        contractPairs: [{ paths: ["src/status.ts"], counterparts: ["src/deliverability.ts"] }],
      } satisfies ReviewProfile);

      const client = new GitHubClient("https://api.example.test", "unused");
      const created: ReviewCommentInput[] = [];
      const comments: ReviewComment[] = [];
      vi.spyOn(client, "getPullRequest").mockResolvedValue({
        headSha: commitSha(unionHead),
        draft: false,
        baseRef: "dev",
        headRepoFullName: undefined,
      });
      vi.spyOn(client, "listReviewComments").mockResolvedValue([]);
      vi.spyOn(client, "createReviewComment").mockImplementation((_ref, _num, input) => {
        created.push(input);
        const comment: ReviewComment = {
          id: comments.length + 1,
          body: input.body,
          path: input.path,
          authorLogin: "keiko-for-quality[bot]",
          commitId: input.commitId,
          url: "https://example.test/c",
        };
        comments.push(comment);
        return Promise.resolve(comment);
      });
      vi.spyOn(client, "getReviewComment").mockImplementation((_ref, id) =>
        Promise.resolve(comments[id - 1]!),
      );

      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: JSON.stringify({
          status: "success",
          summary: { files_reviewed: 1, total_tokens: 100, budget_exceeded: false },
          comments: [],
        }),
        ruleDigest: engineDigest,
      });

      let modelCalls = 0;
      globalThis.fetch = (() => {
        modelCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(
        {
          ...baseRequest(undefined),
          client,
          base: commitSha(unionBase),
          head: commitSha(unionHead),
          config: GATE_CONFIG,
          profile: unionProfile,
          env: { MODEL_TOKEN: "fake-token" },
        },
        diagnostics,
      );

      expect(report.outcome).toBe("complete");
      expect(report.publish?.published).toBe(1);
      expect(created[0]?.path).toBe("src/status.ts");
      expect(created[0]?.body).toContain("rejected");
      expect(created[0]?.body).toContain("deliverability.ts");
      expect(modelCalls).toBe(0);
    });
  });

  /**
   * Classification audit economy (v0.12.0): `repairFindingClassification` used to run BOTH repair
   * AND the self-audit on every fresh engine finding, before `settle` and before deduplication. On a
   * repeat run every suppressed duplicate still paid 1-3 audit calls for an opinion nobody would ever
   * read. The audit now runs from `publishAudited` (`review.ts`), only on plan survivors that are
   * ALSO fresh engine output — repair stays where it was, pre-settle, because a finding without a
   * category or severity cannot be triaged anywhere downstream.
   *
   * Every test below drives `performReview` end to end against this file's real git fixture, with
   * only the engine process and `fetch` mocked away — proof of the WIRING, not just the pure
   * `classify.ts` functions `classify.test.ts` already covers in isolation.
   */
  describe("performReview: classification audit moves to the publication path (v0.12.0)", () => {
    const AUDIT_CONFIG: RuntimeConfig = { ...CONFIG, protocol: "openai", model: "gpt-oss-test" };
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      runEngineMock.mockReset();
      acquireEngineMock.mockReset();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /**
     * A `GitHubClient` whose create/read-back calls actually succeed, so a finding can be observed
     * reaching real publication instead of only being planned — none of the fixtures elsewhere in
     * this file exercise a successful `createReviewComment` round trip. `existing` seeds
     * `listReviewComments`; every seeded comment is authored as this reviewer's own identity, the
     * property `ownMarkers`/`toExistingConversation` (`publisher.ts`) require to treat a marker as
     * this reviewer's own.
     */
    function successfulClient(existing: readonly ReviewComment[] = []): {
      client: GitHubClient;
      created: ReviewCommentInput[];
    } {
      const client = new GitHubClient("https://api.example.test", "unused");
      const createdComments: ReviewComment[] = [];
      const createdInputs: ReviewCommentInput[] = [];
      vi.spyOn(client, "getPullRequest").mockResolvedValue({
        headSha: commitSha(headSha),
        draft: false,
        baseRef: "dev",
        headRepoFullName: undefined,
      });
      vi.spyOn(client, "listReviewComments").mockResolvedValue([...existing]);
      vi.spyOn(client, "createReviewComment").mockImplementation((_ref, _num, input) => {
        createdInputs.push(input);
        const comment: ReviewComment = {
          id: createdComments.length + 1,
          body: input.body,
          path: input.path,
          authorLogin: "keiko-for-quality[bot]",
          commitId: input.commitId,
          url: "https://example.test/c",
        };
        createdComments.push(comment);
        return Promise.resolve(comment);
      });
      vi.spyOn(client, "getReviewComment").mockImplementation((_ref, id) => {
        const found = createdComments.find((c) => c.id === id);
        return found === undefined
          ? Promise.reject(new GitHubApiError(404))
          : Promise.resolve(found);
      });
      return { client, created: createdInputs };
    }

    function auditRequest(client: GitHubClient, cacheStore?: CacheStore): ReviewRequest {
      return {
        client,
        ref: { owner: "acme", repo: "widget" },
        pullNumber: 1,
        base: commitSha(baseSha),
        head: commitSha(headSha),
        repositoryPath: repo,
        config: AUDIT_CONFIG,
        profile: PROFILE,
        guidelines: { paths: [] },
        identity: "keiko-for-quality[bot]",
        env: { MODEL_TOKEN: "fake-token" },
        pathValue: process.env.PATH ?? "/usr/bin:/bin",
        ...(cacheStore === undefined ? {} : { cacheStore }),
      };
    }

    /** One already-published, still-open comment carrying the exact-marker fingerprint for
     *  `(rule, body)` at `path` — the seed the plan-time exact-marker stage and the execute-time
     *  re-check (`publisher.ts`) both compare a fresh finding's own fingerprint against. */
    function seededMarker(rule: string, body: string, path = "src/a.ts"): ReviewComment {
      const marker = fingerprint({ repository: "acme/widget", pullNumber: 1, path, rule, body });
      return {
        id: 1,
        body: `Existing finding.\n\n<!-- ${markerComment(marker)} -->`,
        path,
        authorLogin: "keiko-for-quality[bot]",
        commitId: headSha,
        url: "https://example.test/existing",
      };
    }

    interface StubFinding {
      readonly path: string;
      readonly content: string;
      readonly category?: string;
      readonly severity?: string;
    }

    /** Counted-mode engine output carrying zero or more findings, each optionally pre-classified. */
    function findingsStdout(
      findings: readonly StubFinding[],
      filesReviewed: number,
      totalTokens = 100,
    ): string {
      return JSON.stringify({
        status: "success",
        summary: {
          files_reviewed: filesReviewed,
          total_tokens: totalTokens,
          budget_exceeded: false,
        },
        comments: findings.map((f) => ({
          path: f.path,
          content: f.content,
          start_line: 1,
          end_line: 1,
          ...(f.category !== undefined ? { category: f.category } : {}),
          ...(f.severity !== undefined ? { severity: f.severity } : {}),
        })),
      });
    }

    /**
     * A stand-in classify endpoint: answers `repairPair` to a repair prompt and `auditPair` to an
     * audit prompt. `classify.ts`'s `buildPrompt`/`buildAuditPrompt` preambles are disjoint text
     * ("Classify one code-review finding." / "Your previous reply..." vs "Audit the classification
     * of one code-review finding..."), so routing on a substring is exact, not a heuristic. Counts
     * every call regardless of kind, which is what every economy assertion below reads.
     */
    function classifyFetchMock(opts: {
      repairPair?: { category: string; severity: string };
      auditPair?: { category: string; severity: string };
      tokensPerCall?: number;
    }): { impl: typeof fetch; callCount: () => number } {
      let calls = 0;
      const tokens = opts.tokensPerCall ?? 10;
      const impl = ((_url: string, init?: { body?: string }) => {
        calls += 1;
        const parsedBody = JSON.parse(init?.body ?? "{}") as { messages?: { content?: string }[] };
        const prompt = parsedBody.messages?.[0]?.content ?? "";
        const pair = prompt.includes("Audit the classification") ? opts.auditPair : opts.repairPair;
        const content =
          pair === undefined ? "no pair configured for this call" : JSON.stringify(pair);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content } }],
              usage: { total_tokens: tokens },
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;
      return { impl, callCount: () => calls };
    }

    it("never calls the classify endpoint for a fresh finding suppressed at plan time by an exact marker", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY =
        "This handler swallows the write error and reports success to the caller regardless.";
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: BODY, category: "bug", severity: "medium" }],
          2,
          100,
        ),
        ruleDigest: engineDigest,
      });

      const { impl, callCount } = classifyFetchMock({});
      globalThis.fetch = impl;
      const { client, created } = successfulClient([seededMarker("bug", BODY)]);

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(auditRequest(client), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({
        published: 0,
        suppressed: 1,
        suppressedExactDuplicate: 1,
      });
      expect(created).toHaveLength(0);
      // Already classified (no repair needed) and plan-suppressed (never a `fresh` survivor for the
      // audit) — the classify endpoint is never called at all.
      expect(callCount()).toBe(0);

      const records = diagnostics.drain();
      expect(records.find((r) => r.code === "classify.audited")).toBeUndefined();
      const spend = records.find((r) => r.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 0, total: 100 });
    });

    it("audits a surviving fresh finding once via the fast path and publishes it with the audited classification", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY =
        "This retry loop never resets its attempt counter, so it spins forever after one failure.";
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: BODY, category: "bug", severity: "medium" }],
          2,
          100,
        ),
        ruleDigest: engineDigest,
      });

      // Vote 1 lands on the SAME pair the finding already carries — `classify.ts`'s fast path,
      // exactly one call, no escalation.
      const { impl, callCount } = classifyFetchMock({
        auditPair: { category: "bug", severity: "medium" },
        tokensPerCall: 37,
      });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(auditRequest(client), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({ published: 1, suppressed: 0 });
      expect(created).toHaveLength(1);
      expect(callCount()).toBe(1);

      const records = diagnostics.drain();
      const audited = records.find((r) => r.code === "classify.audited");
      expect(audited?.counts).toStrictEqual({ changed: 0, tokens: 37 });
      const spend = records.find((r) => r.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 37, total: 137 });
    });

    it("never audits a cache-replayed finding, even when it survives the plan and publishes", async () => {
      const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      const model = modelId(AUDIT_CONFIG.model);
      const proto = protocol(AUDIT_CONFIG.protocol);
      const base = blobId(baseBlobA);
      const head = blobId(headBlobA);
      const key = computeKey(base, head, ruleDigest, engineDigest, model, proto);
      const currentPathSet = computePathSetDigest(["src/a.ts", "src/b.ts"]);
      const BODY = "This cached finding replays without ever asking the classify endpoint again.";
      const store: CacheStore = {
        schemaVersion: SUPPORTED_STORE_SCHEMA,
        entries: [
          {
            key,
            baseBlob: base,
            headBlob: head,
            ruleDigest,
            engineDigest,
            prPathSetDigest: currentPathSet,
            modelId: model,
            protocol: proto,
            findings: [
              {
                path: repoPath("src/a.ts"),
                content: BODY,
                startLine: 1,
                endLine: 1,
                severity: "medium",
                category: "bug",
              },
            ],
          },
        ],
      };

      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // src/a.ts is a hit and excluded; only src/b.ts is dispatched, with nothing fresh to report.
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout([], 1, 50),
        ruleDigest: engineDigest,
      });

      const { impl, callCount } = classifyFetchMock({});
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(auditRequest(client, store), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(report.cacheHits).toBe(1);
      // The replayed finding still goes through sanitization and dedup and publishes normally...
      expect(report.publish).toMatchObject({ published: 1, suppressed: 0 });
      expect(created).toHaveLength(1);
      // ...but it was never a candidate for the audit — `freshEngineFindings` never contains it.
      expect(callCount()).toBe(0);
    });

    it("skips the audit under a near-exhausted allotment, still publishes with pre-audit classification, and records classify.skipped_budget", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY =
        "This handler discards the parsed configuration and falls back to defaults silently.";
      runEngineMock.mockResolvedValue({
        // Close to the tiny allotment below, so almost nothing remains for the audit.
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: BODY, category: "bug", severity: "medium" }],
          2,
          49_000,
        ),
        ruleDigest: engineDigest,
      });

      const { impl, callCount } = classifyFetchMock({
        auditPair: { category: "security", severity: "critical" },
      });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);
      // tokenBudget below the formula's own floor: `computeAllottedBudget` returns exactly this
      // value (`Math.min(tokenBudget, clamped)`), so the allotment is deterministic at 50_000.
      const request = { ...auditRequest(client), config: { ...AUDIT_CONFIG, tokenBudget: 50_000 } };

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(request, diagnostics);

      expect(report.outcome).toBe("complete");
      expect(created).toHaveLength(1);
      // Published under the classification the engine reported ("bug"), never the "security" the
      // (unreached) audit mock was configured to answer with — "Correctness" is "bug"'s rendered
      // label in `composeFindingBody`'s CATEGORIES table (`publish/presentation.ts`).
      expect(created[0]?.body).toContain("Correctness");
      expect(callCount()).toBe(0);

      const skip = diagnostics.drain().find((r) => r.code === "classify.skipped_budget");
      // tokenBudget(50_000) - engine(49_000) - classify(0) = 1_000, below the 2_000 reserve for
      // the one fresh survivor.
      expect(skip?.counts).toStrictEqual({ skipped: 1, remaining: 1_000 });
    });

    it("still audits when the engine overshoots its allotment but the consumer ceiling has room", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY =
        "This handler discards the parsed configuration and falls back to defaults silently.";
      runEngineMock.mockResolvedValue({
        // Far above this one-file fixture's 80_000-token allotment floor, far below the consumer's
        // 2M ceiling — the first live v0.12.0 run's exact shape (998k reported against an 80k
        // allotment, evidence in corpus/evidence/). Guarding on the allotment would skip here;
        // guarding on the consumer ceiling — the ceiling this guard actually protects — must not.
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: BODY, category: "bug", severity: "medium" }],
          2,
          500_000,
        ),
        ruleDigest: engineDigest,
      });

      const { impl, callCount } = classifyFetchMock({
        auditPair: { category: "security", severity: "critical" },
      });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(auditRequest(client), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(created).toHaveLength(1);
      // The audit RAN: the published body carries the audit's reclassification ("Security" is
      // "security"'s rendered label in `composeFindingBody`'s CATEGORIES table), not the engine's
      // original "bug".
      expect(callCount()).toBeGreaterThan(0);
      expect(created[0]?.body).toContain("Security");

      const records = diagnostics.drain();
      expect(records.find((r) => r.code === "classify.skipped_budget")).toBeUndefined();
      expect(records.find((r) => r.code === "classify.audited")).toBeDefined();
    });

    it("suppresses a reclassified survivor at the execute-time marker re-check, end to end through publishAudited", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY =
        "This SQL string concatenates the caller-supplied filter directly into the WHERE clause.";
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: BODY, category: "bug", severity: "medium" }],
          2,
          100,
        ),
        ruleDigest: engineDigest,
      });

      // Seeded under "security" — the category the audit mock below reclassifies the fresh finding
      // TO, simulating an earlier run that already published this exact defect correctly.
      const { client, created } = successfulClient([seededMarker("security", BODY)]);
      const { impl, callCount } = classifyFetchMock({
        auditPair: { category: "security", severity: "critical" },
      });
      globalThis.fetch = impl;

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(auditRequest(client), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({
        published: 0,
        suppressed: 1,
        suppressedExactDuplicate: 1,
      });
      expect(created).toHaveLength(0);
      // Vote 1 disagrees with the finding's own "bug" ("security" != "bug"), so the audit escalates
      // to a second vote before two agreeing votes reach majority — two calls, not one.
      expect(callCount()).toBe(2);
    });

    it("stores the audited category for a published finding and the raw category for a plan-suppressed one", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });

      const BODY_A =
        "This function never releases the lock it acquires on the early-return branch.";
      const BODY_B =
        "This workflow step checks out the pull request's own head inside a privileged job.";
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [
            // Unclassified — goes through repair first.
            { path: "src/a.ts", content: BODY_A },
            // Already classified, and matches an existing marker below: plan-suppressed, so it
            // never reaches repair (already classified) or the audit (never a plan survivor).
            { path: "src/b.ts", content: BODY_B, category: "security", severity: "high" },
          ],
          2,
          100,
        ),
        ruleDigest: engineDigest,
      });

      const { client, created } = successfulClient([seededMarker("security", BODY_B, "src/b.ts")]);
      const { impl, callCount } = classifyFetchMock({
        repairPair: { category: "bug", severity: "medium" },
        auditPair: { category: "maintainability", severity: "low" },
      });
      globalThis.fetch = impl;

      const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
      const diagnostics = createSilentDiagnostics();
      const report = await performReview(auditRequest(client, empty), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({
        published: 1,
        suppressed: 1,
        suppressedExactDuplicate: 1,
      });
      expect(created).toHaveLength(1);
      // 1 repair call (src/a.ts) + 2 audit calls (src/a.ts's vote 1 disagrees with the just-repaired
      // "bug", escalating to a vote 2 that agrees) — src/b.ts never calls out at all.
      expect(callCount()).toBe(3);

      const entries = report.updatedCacheStore?.entries ?? [];
      const headBlobB = git(["rev-parse", `${headSha}:src/b.ts`]).trim();
      const aEntry = entries.find((e) => String(e.headBlob) === headBlobA);
      const bEntry = entries.find((e) => String(e.headBlob) === headBlobB);
      // Published under its audited category — the reader saw "maintainability", so that is what
      // must be replayed on a future cache hit.
      expect(aEntry?.findings[0]?.category).toBe("maintainability");
      // Never audited (plan-suppressed before it could be): the store keeps its raw, as-emitted
      // category, matching what the ALREADY-published twin it was compared against actually carries.
      expect(bEntry?.findings[0]?.category).toBe("security");

      // run.spend: engine(100) + repair(1 call) + audit(2 calls), all at the mock's default 10
      // tokens/call — proof the total now covers audit spend incurred during publication, not just
      // the engine and repair halves `executeEngine` alone used to record.
      const spend = diagnostics.drain().find((r) => r.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 30, total: 130 });
    });

    it("keeps engine and classify spend correct across the bounded resume when the resumed run also triggers the audit", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });

      const BODY = "This cache key omits the tenant id, so two tenants can collide on one entry.";
      const nonSuccess = JSON.stringify({
        status: "failed",
        summary: { files_reviewed: 0, total_tokens: 30, budget_exceeded: false },
        comments: [],
      });
      runEngineMock
        .mockResolvedValueOnce({ stdout: nonSuccess, ruleDigest: engineDigest })
        .mockResolvedValueOnce({
          stdout: findingsStdout(
            [{ path: "src/a.ts", content: BODY, category: "bug", severity: "medium" }],
            2,
            100,
          ),
          ruleDigest: engineDigest,
        });

      const { impl, callCount } = classifyFetchMock({
        auditPair: { category: "bug", severity: "medium" },
      });
      globalThis.fetch = impl;
      const { client } = successfulClient([]);

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(auditRequest(client), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(runEngineMock).toHaveBeenCalledTimes(2);
      // Fast-path audit vote agrees with the finding's own classification — one call.
      expect(callCount()).toBe(1);

      const spend = diagnostics.drain().find((r) => r.code === "run.spend");
      // 30 (the discarded first attempt) + 100 (the resume that stands) = 130 engine tokens, plus
      // the audit's own 10 (default mock tokens) spent during publication — the ledger accumulates
      // across BOTH the resume and publication, not just whichever happened to run last.
      expect(spend?.counts).toStrictEqual({ engine: 130, classify: 10, total: 140 });
    });
  });

  /**
   * Allotment on dispatched work (v0.12.0): `computeAllottedBudget`'s call site now prices only what
   * the engine is actually dispatched for — reviewable paths minus cache hits and mechanically-clean
   * renames — rather than the inventory's raw reviewable shape. `computeAllottedBudget` itself is
   * unit-tested directly at the top of this file; these prove the CALL SITE wiring reaches the real
   * `runEngine` invocation, the same way the very first test in this file proves the exclude wiring
   * does.
   */
  describe("performReview: dispatched-only allotment (v0.12.0)", () => {
    beforeEach(() => {
      runEngineMock.mockReset();
      acquireEngineMock.mockReset();
    });

    it("prices a smaller allotment when a cache hit removes a file from dispatch", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      await performReview(baseRequest(undefined), createSilentDiagnostics());
      const noHits = (runEngineMock.mock.calls[0]?.[0] as { allottedBudget: number })
        .allottedBudget;

      runEngineMock.mockClear();
      acquireEngineMock.mockClear();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(1), ruleDigest: engineDigest });

      const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
      const model = modelId(CONFIG.model);
      const proto = protocol(CONFIG.protocol);
      const base = blobId(baseBlobA);
      const head = blobId(headBlobA);
      const key = computeKey(base, head, ruleDigest, engineDigest, model, proto);
      const currentPathSet = computePathSetDigest(["src/a.ts", "src/b.ts"]);
      const store: CacheStore = {
        schemaVersion: SUPPORTED_STORE_SCHEMA,
        entries: [
          {
            key,
            baseBlob: base,
            headBlob: head,
            ruleDigest,
            engineDigest,
            prPathSetDigest: currentPathSet,
            modelId: model,
            protocol: proto,
            findings: [],
          },
        ],
      };

      await performReview(baseRequest(store), createSilentDiagnostics());
      const oneHit = (runEngineMock.mock.calls[0]?.[0] as { allottedBudget: number })
        .allottedBudget;

      expect(oneHit).toBeLessThan(noHits);
    });

    it("does not change the allotment when a mechanically-clean rename sits alongside a reviewable file", async () => {
      const engineDigest = currentPlatformDigest();
      if (engineDigest === undefined) return;

      const renameRepo = await mkdtemp(join(tmpdir(), "kfq-review-rename-"));
      try {
        const renameGit = (args: readonly string[]): string =>
          execFileSync("git", args, {
            cwd: renameRepo,
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "t",
              GIT_AUTHOR_EMAIL: "t@example.test",
              GIT_COMMITTER_NAME: "t",
              GIT_COMMITTER_EMAIL: "t@example.test",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_SYSTEM: "/dev/null",
            },
          });
        renameGit(["init", "-q", "-b", "main"]);
        await mkdir(join(renameRepo, "src"), { recursive: true });
        await writeFile(join(renameRepo, "src/a.ts"), "export const a = 1;\n");
        await writeFile(join(renameRepo, "src/old.ts"), "export const c = 1;\n");
        renameGit(["add", "-A"]);
        renameGit(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
        const renameBase = renameGit(["rev-parse", "HEAD"]).trim();

        await writeFile(join(renameRepo, "src/a.ts"), "export const a = 2;\n");
        renameGit(["add", "-A"]);
        renameGit(["commit", "-q", "-m", "edit", "--no-gpg-sign"]);
        const editOnly = renameGit(["rev-parse", "HEAD"]).trim();

        renameGit(["mv", "src/old.ts", "src/new.ts"]);
        renameGit(["add", "-A"]);
        renameGit(["commit", "-q", "-m", "rename", "--no-gpg-sign"]);
        const withRename = renameGit(["rev-parse", "HEAD"]).trim();

        function renameRequest(head: string): ReviewRequest {
          const client = new GitHubClient("https://api.example.test", "unused");
          vi.spyOn(client, "getPullRequest").mockResolvedValue({
            headSha: commitSha(head),
            draft: false,
            baseRef: "dev",
            headRepoFullName: undefined,
          });
          vi.spyOn(client, "listReviewComments").mockResolvedValue([]);
          return {
            client,
            ref: { owner: "acme", repo: "widget" },
            pullNumber: 1,
            base: commitSha(renameBase),
            head: commitSha(head),
            repositoryPath: renameRepo,
            config: CONFIG,
            profile: PROFILE,
            guidelines: { paths: [] },
            identity: "keiko-for-quality[bot]",
            env: {},
            pathValue: process.env.PATH ?? "/usr/bin:/bin",
          };
        }

        const oneFileStdout = JSON.stringify({
          status: "success",
          summary: { files_reviewed: 1, total_tokens: 100, budget_exceeded: false },
          comments: [],
        });

        acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
        runEngineMock.mockResolvedValue({ stdout: oneFileStdout, ruleDigest: engineDigest });
        await performReview(renameRequest(editOnly), createSilentDiagnostics());
        const withoutRename = (runEngineMock.mock.calls[0]?.[0] as { allottedBudget: number })
          .allottedBudget;

        runEngineMock.mockClear();
        acquireEngineMock.mockClear();
        acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
        runEngineMock.mockResolvedValue({ stdout: oneFileStdout, ruleDigest: engineDigest });
        const report = await performReview(renameRequest(withRename), createSilentDiagnostics());
        const withRenameBudget = (runEngineMock.mock.calls[0]?.[0] as { allottedBudget: number })
          .allottedBudget;

        // The rename is real content in the diff (`inventorySize` grows) but contributes zero to
        // the allotment: `mechanically-clean` is not `reviewable` (`inventory/classify.ts`), so it
        // is absent from both the dispatched file count and the dispatched changed-line sum.
        expect(report.inventorySize).toBe(2);
        expect(report.mechanicallyClean).toBe(1);
        expect(withRenameBudget).toBe(withoutRename);
      } finally {
        await rm(renameRepo, { recursive: true, force: true });
      }
    });
  });
});
