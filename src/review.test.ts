import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  computeKey,
  modelId,
  protocol,
  SUPPORTED_STORE_SCHEMA,
  type CacheStore,
} from "./cache/review-cache.js";
import { compileProfile, type ReviewProfile } from "./config/profile.js";
import type { RuntimeConfig } from "./config/runtime.js";
import { blobId, commitSha } from "./core/brands.js";
import { createSilentDiagnostics } from "./diagnostics/sink.js";
import { currentPlatformDigest } from "./engine/pinned-release.js";
import { promptIdentityDigest } from "./engine/rule-identity.js";
import { GitHubClient } from "./github/client.js";
import type { ReviewRequest } from "./review.js";

const acquireEngineMock = vi.fn();
vi.mock("./engine/acquire.js", () => ({ acquireEngine: acquireEngineMock }));

const runEngineMock = vi.fn();
vi.mock("./engine/run.js", () => ({ runEngine: runEngineMock }));

const { computeAllottedBudget, performReview } = await import("./review.js");

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
    const store: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [
        {
          key,
          baseBlob: base,
          headBlob: head,
          ruleDigest,
          engineDigest,
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
      acquireEngineMock.mockResolvedValue({
        binaryPath: "/fake/engine",
        digest: currentPlatformDigest(),
      });
      runEngineMock.mockRejectedValue(new Error("engine spawn failed"));
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
        profile: PROFILE,
        guidelines: { paths: [] },
        identity: "keiko-for-quality[bot]",
        env: {},
        pathValue: process.env.PATH ?? "/usr/bin:/bin",
      };

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("abandoned");
      expect(createSpy).not.toHaveBeenCalled();
    });
  });
});
