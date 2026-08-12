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
  PUBLICATION_SEMANTICS,
} from "./cache/review-cache.js";
import { compileProfile, type ReviewProfile } from "./config/profile.js";
import type { RuntimeConfig } from "./config/runtime.js";
import { blobId, commitSha, repoPath, sha256, type Sha256 } from "./core/brands.js";
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
import {
  CLOSED_RUNTIME_FACT_CATALOG,
  CLOSED_RUNTIME_FACT_CATALOG_VERSION,
} from "./publish/runtime-fact-catalog.js";
import { MAX_SUBSTANTIATION_TOKENS_PER_FINDING } from "./publish/substantiate.js";
import type { ReviewRequest } from "./review.js";

const acquireEngineMock = vi.fn();
vi.mock("./engine/acquire.js", () => ({ acquireEngine: acquireEngineMock }));

const runEngineMock = vi.fn();
vi.mock("./engine/run.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runEngine: runEngineMock,
}));

// Repository-context and Git-grep stay real in this end-to-end suite. Only optional structural
// enrichment is deterministic: otherwise a clean runner tries to acquire ast-grep through the
// model endpoint's global fetch mock and makes the test depend on a pre-existing tool cache.
const { findAstAnchorOwnerAtHeadMock, findAstCallerOwnerAtHeadMock } = vi.hoisted(() => ({
  findAstAnchorOwnerAtHeadMock: vi.fn(),
  findAstCallerOwnerAtHeadMock: vi.fn(),
}));
vi.mock("./publish/ast-grep-search.js", async (importOriginal) => ({
  ...(await importOriginal()),
  findAstAnchorOwnerAtHead: findAstAnchorOwnerAtHeadMock,
  findAstCallerOwnerAtHead: findAstCallerOwnerAtHeadMock,
  searchAstGrepAtHead: (): Promise<readonly []> => Promise.resolve([]),
}));

const collectClosedRuntimeFactsAtCommitMock = vi.fn();
vi.mock("./publish/runtime-facts.js", async (importOriginal) => ({
  ...(await importOriginal()),
  collectClosedRuntimeFactsAtCommit: collectClosedRuntimeFactsAtCommitMock,
}));

const { computeAllottedBudget, performReview } = await import("./review.js");
const { EngineRunError } = await import("./engine/run.js");

/**
 * `performReview`'s `finally` block (v0.13.0, notice cleanup) now unconditionally calls
 * `client.resolveSupersededOwnNotices` after every run, on every `GitHubClient` instance this file
 * constructs — dozens of them, most via `baseRequest`, several inline in their own test. Spying on
 * the PROTOTYPE once here, rather than adding the same spy to every construction site, is what keeps
 * every one of those existing tests exercising a real, unmocked instance from making a real network
 * call the moment this method runs — the call would still resolve to `0` (the method is best-effort
 * and never throws), but only after paying a real DNS/connect attempt against a host
 * (`api.example.test`) that resolves nowhere, on every single test in this file. A test that wants to
 * assert on this call re-spies its own `client` instance, which shadows this prototype default for
 * that instance alone.
 */
beforeEach(() => {
  findAstAnchorOwnerAtHeadMock.mockReset();
  findAstAnchorOwnerAtHeadMock.mockResolvedValue(undefined);
  findAstCallerOwnerAtHeadMock.mockReset();
  findAstCallerOwnerAtHeadMock.mockResolvedValue(undefined);
  collectClosedRuntimeFactsAtCommitMock.mockReset();
  collectClosedRuntimeFactsAtCommitMock.mockResolvedValue([]);
  vi.spyOn(GitHubClient.prototype, "resolveSupersededOwnNotices").mockResolvedValue({
    attempted: 0,
    resolved: 0,
  });
});

/**
 * The pin covers this platform or this suite cannot run here — never a silent skip.
 *
 * `currentPlatformDigest()` returns `undefined` on any platform `ENGINE_PIN.platforms` does not
 * name (`pinned-release.ts`), and every test below that needs a digest used to answer that by
 * returning early. Vitest sets no `expect.hasAssertions`, so those returns were reported as
 * passes with zero assertions — the exact shape CONTRIBUTING.md's "a test must be able to fail"
 * rule forbids, and it was silently hiding the tests that cost the most to get wrong (the bounded
 * single resume, `run.spend` accounting, the classification audit, the dispatched-only allotment).
 * Throwing states the prerequisite instead of hiding the gap: on a pinned platform nothing changes,
 * and on an unpinned one the suite says why it cannot run rather than reporting green.
 */
function requireEngineDigest(): Sha256 {
  const digest = currentPlatformDigest();
  if (digest === undefined) {
    throw new Error("review.test.ts needs a pinned engine digest for this platform");
  }
  return digest;
}

describe("computeAllottedBudget", () => {
  it("matches the worked example: the measured 37-file live run (Keiko#2970)", () => {
    // 1.3 * (37 * 200_000 + 4_594 * 60) = 1.3 * (7_400_000 + 275_640) = 9_978_332, past
    // ALLOTMENT_CEILING and then past the consumer's own 6M — so the clamp decides. The per-file
    // price doubled with the round ceiling (see `allottedPerFile`), which is exactly the coupling
    // this suite now pins: 37 files allowed sixty rounds each is a change the consumer's ceiling
    // governs, not the size term.
    expect(computeAllottedBudget(6_000_000, 37, 4_594)).toBe(6_000_000);
  });

  // The defect this coupling exists to prevent, stated as a test rather than a comment: on
  // 2026-08-06 the tool-round ceiling doubled and this price did not follow, so Keiko#3008 stopped
  // settling `coverage_gap` and started settling `budget_exceeded` — 3.2M spent against a 1.59M
  // allotment still priced for half the conversation length the engine now permits. A future
  // change to either number must move this expectation, which is the point.
  it("prices a file at the round ceiling actually in force, not the one it was calibrated under", () => {
    // 12 files, the Keiko#3008 shape: 1.3 * (12 * 200_000 + 400 * 60) = 3_151_200 — comfortably
    // above the 3.2M-class spend that blew the old 1.59M allotment.
    expect(computeAllottedBudget(6_000_000, 12, 400)).toBe(3_151_200);
  });

  it("hands a change past the ceiling the consumer's whole budget rather than a fraction of it", () => {
    // 1.3 * (55 * 200_000 + 1_374 * 60) = 14_407_172, past ALLOTMENT_CEILING — so the clamp, and
    // then the consumer's own 6M ceiling, decide. The size term stops discriminating earlier now
    // that a file is priced at sixty rounds, and every larger change is held to the configured
    // budget, which is the consumer's call to make.
    expect(computeAllottedBudget(6_000_000, 55, 1_374)).toBe(6_000_000);
  });

  it("never exceeds the consumer's configured ceiling, however large the change", () => {
    expect(computeAllottedBudget(1_000_000, 87, 3_175)).toBe(1_000_000);
  });

  it("floors a tiny change rather than starving it", () => {
    // 1.3 * (1 * 200_000 + 5 * 60) = 1.3 * 200_300 = 260_390 — now above the 150_000 floor, so
    // the floor no longer binds for a one-file change. Kept as the floor's own regression guard:
    // it must still bind for a change small enough to fall under it.
    expect(computeAllottedBudget(2_000_000, 1, 5)).toBe(260_390);
  });

  it("does not let the floor exceed a ceiling configured below it", () => {
    expect(computeAllottedBudget(50_000, 1, 5)).toBe(50_000);
  });

  it("caps a huge change at the ceiling rather than the raw estimate", () => {
    // 1.3 * (1000 * 100_000) = 130_000_000, far past the 6_000_000 ceiling.
    expect(computeAllottedBudget(100_000_000, 1000, 0)).toBe(6_000_000);
  });

  it("still applies the floor to a degenerate zero-file, zero-line input", () => {
    // `performReview` never calls this with an empty inventory — it short-circuits on
    // `reviewablePaths.size === 0` first — but the formula itself has no special case for it, and
    // the floor exists precisely so a small raw estimate never becomes a smaller allotment.
    expect(computeAllottedBudget(2_000_000, 0, 0)).toBe(150_000);
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
    // 60 tokens/line * 1000 lines * 1.3 margin = 78_000 — a small delta next to the 100_000/file term.
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

  /**
   * `cwd` defaults to this block's own shared fixture repo, which is what all but one call site
   * wants. The default is evaluated per call, so `repo` being assigned later in `beforeAll` is
   * fine — and the parameter is what lets the rename block further down drive its own throwaway
   * repository through this same helper instead of carrying a byte-identical copy of it. The
   * environment is deliberately the test-side one (inherited `process.env` plus a fixed author
   * identity, so a commit here never depends on the developer's own git config); it is NOT
   * `src/git/exec.ts`'s production `gitEnvironment()`, and must not become it — these fixtures
   * exist to hold the product to real git's behaviour, which they cannot do while sharing the
   * very environment construction they are meant to check.
   */
  function git(args: readonly string[], cwd: string = repo): string {
    return execFileSync("git", args, {
      cwd,
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
    // Independent, unchanged contract evidence for the mandatory post-Truth challenge. The
    // planner names this symbol and production retrieval renders it in the reserved R4 namespace.
    await writeFile(join(repo, "src/challenge.ts"), "export const challengeGuard = true;\n");
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
      identityExclusive: true,
      env: {},
      pathValue: process.env.PATH ?? "/usr/bin:/bin",
      ...(cacheStore === undefined ? {} : { cacheStore }),
    };
  }

  it("threads a cache hit into the engine's own exclude list and credits it in settlement", async () => {
    const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
    const engineDigest = requireEngineDigest();

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
          semantics: PUBLICATION_SEMANTICS,
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
    const [calledOptions] = runEngineMock.mock.calls[0] as [
      { mechanicallyCleanPaths: string[]; expectedReviewablePaths: string[] },
    ];
    expect(calledOptions.mechanicallyCleanPaths).toContain("src/a.ts");
    expect(calledOptions.expectedReviewablePaths).toEqual(["src/b.ts"]);

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

    if (report.updatedCacheStore === undefined) throw new Error("expected cache write-back");
    acquireEngineMock.mockClear();
    runEngineMock.mockClear();
    const secondDiagnostics = createSilentDiagnostics();
    const second = await performReview(baseRequest(report.updatedCacheStore), secondDiagnostics);

    expect(second.outcome).toBe("complete");
    expect(second.cacheHits).toBe(2);
    expect(second.cacheMisses).toBe(0);
    expect(acquireEngineMock).not.toHaveBeenCalled();
    expect(runEngineMock).not.toHaveBeenCalled();
    expect(
      secondDiagnostics.drain().some((record) => record.code === "settlement.mode.memoized"),
    ).toBe(true);
  });

  it("treats a hit rejected by the path-set digest as an ordinary miss: the file is reviewed and never memoized (v0.10.0, issue #50)", async () => {
    const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
    const engineDigest = requireEngineDigest();

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
          semantics: PUBLICATION_SEMANTICS,
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
        identityExclusive: true,
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
        identityExclusive: true,
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

    it("rechecks the head after quality planning and never publishes or caches a stale result", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: engineStdoutWithFinding(2),
        ruleDigest: engineDigest,
      });
      const request = baseRequest(undefined);
      const current = {
        headSha: commitSha(headSha),
        draft: false,
        baseRef: "dev",
        headRepoFullName: undefined,
      };
      const getPullRequestSpy = vi
        .spyOn(request.client, "getPullRequest")
        .mockResolvedValueOnce(current) // pre-engine
        .mockResolvedValueOnce(current) // immediately before quality planning
        .mockResolvedValue({ ...current, headSha: commitSha("f".repeat(40)) });
      const createSpy = vi.spyOn(request.client, "createReviewComment");

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("abandoned");
      expect(report.updatedCacheStore).toBeUndefined();
      expect(getPullRequestSpy).toHaveBeenCalledTimes(3);
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
      const engineDigest = requireEngineDigest();

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
            semantics: PUBLICATION_SEMANTICS,
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
        identityExclusive: true,
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
    // Placed after every test that reads `mock.calls[0]`, on purpose: an earlier engine call would
    // shift `mock.calls[0]` under the test that reads the first call to prove the exclude list
    // reached the engine. (The negative-admission test below inherits the same placement and reads
    // no call history of its own, so it cannot disturb them either.)
    runEngineMock.mockClear();
    const engineDigest = requireEngineDigest();

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
    // A budget truncation surfaces AS a budget stop. This result reports a complete terminal state
    // and no failed coverage entry, so the only thing that kept the engine away from `src/b.ts` is
    // the ceiling — and `settleReconciled` now asks that question before the terminal-state and
    // gap ones, precisely so the reason names the cause the consumer can act on instead of the
    // shortfall it produced. Both reasons still have to be in `verdictsSurviveIncompleteness`'
    // survivor set: `coverage_gap` remains the reason for a gap with no overrun behind it.
    expect(report.reason).toBe("settlement.incomplete.budget_exceeded");

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

  /**
   * The same rule on the engine this product actually pins — and the shape that made the rule above
   * inert in production for its whole life.
   *
   * No published engine release emits a run manifest (`settle.ts`'s own header says so), so a live
   * truncated run reaches settlement with `coverage.completed` empty, and the covered set the test
   * above pins is therefore always empty on the real binary: thirteen consecutive truncated runs on
   * oscharko-dev/Keiko#2981 stored nothing at all, and each following push re-priced all 37 files
   * from zero. `memoizablePaths` (`settle.ts`) supplies the one identity a manifest-less result
   * still proves — the engine cannot report a defect in a file it never opened — and this pins that
   * the identity survives all the way into the store.
   */
  it("persists a manifest-less truncated run's finding paths, the shape the released engine emits", async () => {
    runEngineMock.mockClear();
    const engineDigest = requireEngineDigest();

    // No `manifest` key at all — exactly what v1.8.4 answers — plus the two facts a budget stop
    // arrives with together: a non-success status and `budget_exceeded`.
    const truncated = JSON.stringify({
      status: "failed",
      summary: { files_reviewed: 1, total_tokens: 9_000_000, budget_exceeded: true },
      comments: [
        {
          path: "src/a.ts",
          start_line: 1,
          end_line: 1,
          category: "bug",
          severity: "high",
          content: "The retry loop never resets its attempt counter.",
        },
      ],
    });

    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    runEngineMock.mockResolvedValue({ stdout: truncated, ruleDigest: engineDigest });

    const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
    const report = await performReview(baseRequest(empty), createSilentDiagnostics());

    expect(report.outcome).toBe("incomplete");
    expect(report.reason).toBe("settlement.incomplete.budget_exceeded");

    const blobs = (report.updatedCacheStore?.entries ?? []).map((e) => String(e.headBlob));
    // The file the engine demonstrably opened is now replayable; the one it never reached is not.
    expect(blobs).toContain(headBlobA);
    expect(blobs).not.toContain(git(["rev-parse", `${headSha}:src/b.ts`]).trim());
    expect(report.cacheAppended).toBe(1);
  });

  /**
   * The other half of the same rule, and the half that was never pinned here.
   *
   * `verdictsSurviveIncompleteness` (`engine/settle.ts`) admits exactly two incomplete reasons; the
   * test above pins one of them in the direction that saves money. Nothing pinned the refusal at
   * this layer: deleting the `verdictsSurviveIncompleteness(...) ? … : undefined` conditional in
   * `performReviewInner` — so that every incomplete settlement handed its covered set to
   * `truncatedCacheFields` — left the whole suite green, because the two consumer layers that DO
   * pin the negative direction (`action/main.test.ts`, `cli.test.ts`) only ever see the store
   * `performReview` already decided to produce.
   *
   * So this drives a genuinely disqualified run that still had everything it would need to launder:
   * a live (empty) store, two cache-eligible paths, and a manifest whose coverage names BOTH files
   * as completed. Only the reason code stands between that and a permanent, confidently-replayed
   * "clean" verdict for a run whose output was just declared untrustworthy. A reason that reaches
   * `settleIncomplete` carrying `NO_COVERED_PATHS` would have passed for the wrong reason.
   */
  it("admits nothing to the store when the incompleteness is one whose verdicts do not survive", async () => {
    runEngineMock.mockClear();
    acquireEngineMock.mockClear();
    const engineDigest = requireEngineDigest();

    const disqualified = JSON.stringify({
      status: "success",
      summary: { files_reviewed: 2, total_tokens: 100, budget_exceeded: false },
      comments: [],
      // The profile's `benignWarnings` is empty, so this one is unlisted and `commonDisqualifier`
      // settles the run incomplete — a reason about whether the RUN can be believed at all, which
      // is why `verdictsSurviveIncompleteness` refuses it.
      warnings: [{ type: "engine.internal.retry_storm", file: "src/a.ts" }],
      manifest: {
        schema_version: SUPPORTED_MANIFEST_SCHEMA,
        terminal_state: "complete",
        // Full coverage: the engine says it reviewed both files. That is precisely what makes this
        // test bite — there are real verdicts here that a missing gate would happily persist.
        coverage: {
          selected: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
          completed: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
          reused: [],
          failed: [],
          waived: [],
        },
      },
    });

    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    runEngineMock.mockResolvedValue({ stdout: disqualified, ruleDigest: engineDigest });

    const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
    const request = baseRequest(empty);
    // The incomplete notice is published through the same `createReviewComment` call every other
    // publication uses; rejecting it deterministically keeps this test off the network without
    // changing the settlement, which `publishIncompleteNotice` decided before publication began.
    vi.spyOn(request.client, "createReviewComment").mockRejectedValue(new GitHubApiError(422));

    const report = await performReview(request, createSilentDiagnostics());

    expect(report.outcome).toBe("incomplete");
    expect(report.reason).toBe("settlement.incomplete.warning_not_allowlisted");
    // Memoization was live, not inert: both files were looked up and neither was answered from the
    // store. Without this the two assertions below would hold trivially for a run that never had a
    // store at all — `finalizeCacheStore`'s first check returns `undefined` in that case too.
    expect(report.cacheHits).toBe(0);
    expect(report.cacheMisses).toBe(2);
    // Nothing written back at all — not even the input store echoed with zero appended entries,
    // which is what a run that reached `finalizeCacheStore` with an empty covered set would return.
    expect(report.updatedCacheStore).toBeUndefined();
    expect(report.cacheAppended).toBe(0);
  });

  /**
   * The wiring half of the notice-cleanup feature — `GitHubClient.notice-cleanup.test.ts` pins the
   * client-level mechanics (which threads qualify, the mutation itself); these pin that
   * `performReview` actually reaches it, with the right arguments, on every outcome, and that its
   * result only ever adds a diagnostic — never changes what the run reports.
   */
  /**
   * Three more review-cache fixes from the same audit pass (v0.13.0), each closing a path where a
   * real, already-paid-for review verdict used to be silently discarded or left to age out on the
   * wrong clock.
   */
  describe("performReview: review-cache completeness (v0.13.0)", () => {
    it("promotes a cache hit to newest on write-back, not just freshly-admitted entries", async () => {
      const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
      const engineDigest = requireEngineDigest();
      const model = modelId(CONFIG.model);
      const proto = protocol(CONFIG.protocol);
      const base = blobId(baseBlobA);
      const head = blobId(headBlobA);
      const hitKey = computeKey(base, head, ruleDigest, engineDigest, model, proto);
      const currentPathSet = computePathSetDigest(["src/a.ts", "src/b.ts"]);
      // A decoy entry for a path outside this diff entirely — never touched by lookup or write-
      // back, so its position is a stable anchor: it must stay FIRST regardless of what happens to
      // the hit entry, and the hit entry moving to AFTER it (not staying before it) is exactly what
      // "promoted to newest" means.
      const decoyKey = computeKey(
        blobId("c".repeat(40)),
        blobId("d".repeat(40)),
        ruleDigest,
        engineDigest,
        model,
        proto,
      );
      const store: CacheStore = {
        schemaVersion: SUPPORTED_STORE_SCHEMA,
        entries: [
          {
            key: decoyKey,
            baseBlob: blobId("c".repeat(40)),
            headBlob: blobId("d".repeat(40)),
            ruleDigest,
            engineDigest,
            prPathSetDigest: currentPathSet,
            semantics: PUBLICATION_SEMANTICS,
            modelId: model,
            protocol: proto,
            findings: [],
          },
          {
            key: hitKey,
            baseBlob: base,
            headBlob: head,
            ruleDigest,
            engineDigest,
            prPathSetDigest: currentPathSet,
            semantics: PUBLICATION_SEMANTICS,
            modelId: model,
            protocol: proto,
            findings: [],
          },
        ],
      };

      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // src/b.ts is freshly reviewed (a miss); src/a.ts is answered from the store (a hit).
      runEngineMock.mockResolvedValue({ stdout: engineStdout(1), ruleDigest: engineDigest });

      const report = await performReview(baseRequest(store), createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(report.cacheHits).toBe(1);
      const entries = report.updatedCacheStore?.entries ?? [];
      expect(entries.map((e) => e.key)).toContain(hitKey);
      // The decoy (never touched) stays exactly where it was; the hit — freshly confirmed by this
      // run — moves to the newest position, after both the decoy AND the newly-admitted src/b.ts
      // entry. Before this fix, a hit's position never moved at all.
      const hitIndex = entries.findIndex((e) => e.key === hitKey);
      const decoyIndex = entries.findIndex((e) => e.key === decoyKey);
      expect(hitIndex).toBeGreaterThan(decoyIndex);
      expect(hitIndex).toBe(entries.length - 1);
    });

    it("still writes back the real findings of a complete review whose publication degraded on one finding", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: engineStdoutWithFinding(2),
        ruleDigest: engineDigest,
      });

      const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
      const request = baseRequest(empty);
      // Every placement rung — including the trailing file-level fallback — is rejected the same
      // way, so the one finding this run produced degrades publication without ever succeeding.
      vi.spyOn(request.client, "createReviewComment").mockRejectedValue(new GitHubApiError(422));

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("incomplete");
      expect(report.reason).toBe("settlement.incomplete.publication_degraded");
      // The engine's own verdict was complete — both files reached, both judged — so both earn a
      // replayable entry despite the one finding never reaching GitHub.
      expect(report.cacheAppended).toBe(2);
      const headBlobB = git(["rev-parse", `${headSha}:src/b.ts`]).trim();
      const blobs = (report.updatedCacheStore?.entries ?? []).map((e) => String(e.headBlob));
      expect(blobs).toContain(headBlobA);
      expect(blobs).toContain(headBlobB);
    });

    it("does not cache unverified findings when the head moves before the evidence gate", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
      const request = baseRequest(empty);
      // First call is the pre-flight check (before the engine runs) and must see the current head,
      // or the run would abandon before ever reaching the engine and this test would prove nothing.
      // The second call is the post-settlement check this fix targets, and reports a DIFFERENT head
      // — a push that landed while the engine was still running.
      vi.spyOn(request.client, "getPullRequest")
        .mockResolvedValueOnce({
          headSha: commitSha(headSha),
          draft: false,
          baseRef: "dev",
          headRepoFullName: undefined,
        })
        .mockResolvedValueOnce({
          headSha: commitSha("f".repeat(40)),
          draft: false,
          baseRef: "dev",
          headRepoFullName: undefined,
        });

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("abandoned");
      // The engine output is blob-stable, but it has not passed the current publication-quality
      // contract. Caching it under that semantics marker would bypass verification on replay.
      expect(report.cacheAppended).toBe(0);
      expect(report.updatedCacheStore).toBeUndefined();
    });
  });

  describe("performReview: superseded-notice cleanup (v0.13.0)", () => {
    /**
     * The identity-exclusivity gate: resolving a GitHub thread is a WRITE, and under a shared,
     * non-exclusive login (the plain-token fallback) this run cannot prove the matching comment was
     * actually authored by ITSELF rather than some other workflow sharing the same fallback
     * identity. Every other use of `identity` in this pipeline is a read-only suppression match,
     * where a shared identity is already an accepted, documented weakening — this is the one place
     * that is not true, and the mutation must not even be attempted.
     */
    it("never calls resolveSupersededOwnNotices when the identity is not exclusive", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const request = { ...baseRequest(undefined), identityExclusive: false };
      const cleanupSpy = vi
        .spyOn(request.client, "resolveSupersededOwnNotices")
        .mockResolvedValue({ attempted: 0, resolved: 0 });

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(cleanupSpy).not.toHaveBeenCalled();
    });

    it("calls resolveSupersededOwnNotices with this run's own ref/pull/identity on a complete run", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const request = baseRequest(undefined);
      const cleanupSpy = vi
        .spyOn(request.client, "resolveSupersededOwnNotices")
        .mockResolvedValue({ attempted: 0, resolved: 0 });

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith(
        request.ref,
        request.pullNumber,
        request.identity,
        expect.any(Function),
        // The reviewed head (2026-08-06): the supersession clause that resolves file-level
        // notices compares each notice's originalCommit against exactly this value.
        request.head,
        // This run completed, so its own past notices on the SAME head are superseded too — the
        // gap Keiko#3003 exposed, where a head that never moved left an answered notice open.
        true,
      );
      // The predicate handed across is the real detector, not a stand-in — a notice's own fixed
      // template, carrying a well-formed marker (#42 requires both), must be recognised, and
      // ordinary finding prose must not.
      const predicate = cleanupSpy.mock.calls[0]?.[3] as (body: string) => boolean;
      const notice =
        "Keiko for Quality could not complete its review. Reason code: `x`.\n" +
        `<!-- ${markerComment("a".repeat(32))} -->`;
      expect(predicate(notice)).toBe(true);
      expect(predicate("The retry loop never resets its attempt counter.")).toBe(false);
    });

    it("still calls it when this run itself settles incomplete", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: JSON.stringify({
          status: "failed",
          summary: { files_reviewed: 1, total_tokens: 1000, budget_exceeded: false },
          comments: [],
        }),
        ruleDigest: engineDigest,
      });

      const request = baseRequest(undefined);
      vi.spyOn(request.client, "createReviewComment").mockRejectedValue(new GitHubApiError(422));
      const cleanupSpy = vi
        .spyOn(request.client, "resolveSupersededOwnNotices")
        .mockResolvedValue({ attempted: 0, resolved: 0 });

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("incomplete");
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it("still calls it when the run is abandoned on a moved head", async () => {
      const request = baseRequest(undefined);
      vi.spyOn(request.client, "getPullRequest").mockResolvedValue({
        headSha: commitSha("f".repeat(40)),
        draft: false,
        baseRef: "dev",
        headRepoFullName: undefined,
      });
      const cleanupSpy = vi
        .spyOn(request.client, "resolveSupersededOwnNotices")
        .mockResolvedValue({ attempted: 0, resolved: 0 });

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("abandoned");
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      // An abandoned run answered nothing, so same-head notices stay open — the flag is what
      // keeps "incomplete never reads as clean" true for the cleanup path too.
      expect(cleanupSpy.mock.calls[0]?.[5]).toBe(false);
    });

    it("records a diagnostic with both counts when notices were resolved", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const request = baseRequest(undefined);
      vi.spyOn(request.client, "resolveSupersededOwnNotices").mockResolvedValue({
        attempted: 3,
        resolved: 3,
      });

      const diagnostics = createSilentDiagnostics();
      await performReview(request, diagnostics);

      const record = diagnostics
        .drain()
        .find((r) => r.code === "cleanup.superseded_notices_resolved");
      expect(record?.counts).toStrictEqual({ attempted: 3, resolved: 3 });
    });

    // The reason `attempted` gates the diagnostic instead of `resolved`: a token missing the
    // resolve-thread permission fails every mutation, and that must not read the same as "there
    // was nothing to resolve" — the two are operationally distinct (a persistent, fixable failure
    // versus a healthy no-op) and both produced `resolved === 0` before this count existed.
    it("records a diagnostic when every attempted resolution failed, distinguishing it from nothing to resolve", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const request = baseRequest(undefined);
      vi.spyOn(request.client, "resolveSupersededOwnNotices").mockResolvedValue({
        attempted: 2,
        resolved: 0,
      });

      const diagnostics = createSilentDiagnostics();
      await performReview(request, diagnostics);

      const record = diagnostics
        .drain()
        .find((r) => r.code === "cleanup.superseded_notices_resolved");
      expect(record?.counts).toStrictEqual({ attempted: 2, resolved: 0 });
    });

    it("records nothing when there was nothing to resolve", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const request = baseRequest(undefined);
      vi.spyOn(request.client, "resolveSupersededOwnNotices").mockResolvedValue({
        attempted: 0,
        resolved: 0,
      });

      const diagnostics = createSilentDiagnostics();
      await performReview(request, diagnostics);

      const codes = diagnostics.drain().map((r) => r.code);
      expect(codes).not.toContain("cleanup.superseded_notices_resolved");
    });

    /**
     * `GitHubClient`'s own implementation never throws, but `ReviewCommentApi` is an interface —
     * nothing structural stops some other implementer from rejecting, so `performReview` wraps the
     * call itself defensively too (`review.ts`). A cleanup pass that fails must cost the next push
     * one more stale thread, never the review this run actually produced.
     */
    it("does not fail the run when the cleanup call itself rejects", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const request = baseRequest(undefined);
      vi.spyOn(request.client, "resolveSupersededOwnNotices").mockRejectedValue(
        new Error("graphql unavailable"),
      );

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(request, diagnostics);

      expect(report.outcome).toBe("complete");
      const codes = diagnostics.drain().map((r) => r.code);
      expect(codes).not.toContain("cleanup.superseded_notices_resolved");
    });
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
      const engineDigest = requireEngineDigest();
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
      const engineDigest = requireEngineDigest();
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
      expect(
        (runEngineMock.mock.calls[0]?.[0] as { reviewDeadlineMs: number }).reviewDeadlineMs,
      ).toBe((runEngineMock.mock.calls[1]?.[0] as { reviewDeadlineMs: number }).reviewDeadlineMs);
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
      const engineDigest = requireEngineDigest();
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
      const engineDigest = requireEngineDigest();
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
      const engineDigest = requireEngineDigest();
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
      const engineDigest = requireEngineDigest();
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

      // The whole shape of the production failure in one fixture: `--max-tokens-budget` makes the
      // engine stop dispatching and exit non-`success`, so this result carries a failed status AND
      // `budget_exceeded` together. `settleCounted` asks about the budget first, so the pull
      // request is told the cause it can act on — and the reason it is told is the one
      // `verdictsSurviveIncompleteness` admits, so the verdicts this run already paid for survive
      // into the store instead of being discarded with it.
      expect(report.outcome).toBe("incomplete");
      expect(report.reason).toBe("settlement.incomplete.budget_exceeded");

      // Skipped, not resumed: the resume-only diagnostic must not fire for a resume that never ran.
      const codes = diagnostics.drain().map((record) => record.code);
      expect(codes).not.toContain("engine.resumed_once");

      // Exactly the first (and only) attempt's own tokens — never a guess, and never inflated by a
      // second call that never happened.
      const spend = diagnostics.drain().find((record) => record.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 40_000, classify: 0, total: 40_000 });
    });

    /**
     * The Keiko#3002 cost fix, corrected on 2026-08-06 by Keiko#3011.
     *
     * "A finished first attempt is settled on, never re-run" was measured against a FULL
     * re-dispatch (~all files, ~0.76M tokens, identical failures reproduced) and generalised one
     * step too far. When the engine NAMES its casualties, the gap has an identity, and
     * re-dispatching only those paths is a different trade entirely: on Keiko#3011 two files out
     * of nineteen sent a 1.6M-token review to `incomplete` because nothing retried them.
     *
     * The three tests below pin the corrected rule from both ends — the minority gap is retried,
     * the broad failure is still refused, and a successful retry actually closes the settlement.
     */
    function finishedWithFailures(failedPaths: readonly string[], filesReviewed: number): string {
      return JSON.stringify({
        status: "completed_with_errors",
        summary: { files_reviewed: filesReviewed, total_tokens: 60_000, budget_exceeded: false },
        comments: [
          {
            path: "src/a.ts",
            content: "Close the handle.",
            start_line: 1,
            end_line: 1,
            severity: "high",
            category: "bug",
          },
        ],
        warnings: failedPaths.map((file) => ({
          type: "subtask_error",
          file,
          message: "main_task did not complete",
        })),
      });
    }

    it("retries ONLY the paths a finished run named as failed, instead of settling the gap unreviewed", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // One of two reviewable paths failed: a minority gap with a known identity.
      runEngineMock.mockResolvedValueOnce({
        stdout: finishedWithFailures(["src/b.ts"], 2),
        ruleDigest: engineDigest,
      });
      // The retry still cannot finish it — the gap stands, but it was paid for once, not never.
      runEngineMock.mockResolvedValueOnce({
        stdout: finishedWithFailures(["src/b.ts"], 1),
        ruleDigest: engineDigest,
      });

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      expect(runEngineMock).toHaveBeenCalledTimes(2);
      // The second dispatch is aimed, not repeated: everything the first attempt did NOT lose is
      // excluded from it. Without this the retry would re-buy the whole review — the exact cost
      // the blanket skip was introduced to avoid.
      const second = runEngineMock.mock.calls[1]?.[0] as {
        mechanicallyCleanPaths: readonly string[];
        expectedReviewablePaths: readonly string[];
      };
      expect(second.mechanicallyCleanPaths).toContain("src/a.ts");
      expect(second.mechanicallyCleanPaths).not.toContain("src/b.ts");
      expect(second.expectedReviewablePaths).toEqual(["src/b.ts"]);

      const codes = diagnostics.drain().map((record) => record.code);
      expect(codes).toContain("engine.resumed_gap_targeted");
      expect(codes).not.toContain("engine.resume_skipped_run_completed");
      expect(report.outcome).toBe("incomplete");
      expect(report.reason).toBe("settlement.incomplete.coverage_gap");
    });

    it("settles complete when the targeted retry closes the gap", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // Deliberately finding-free on both attempts: this test is about the SETTLEMENT the retry
      // produces, and a published finding would drag the mocked publication layer's own outcome
      // (`settlement.incomplete.publication_degraded`) into an assertion that is not about it.
      runEngineMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          status: "completed_with_errors",
          summary: { files_reviewed: 2, total_tokens: 60_000, budget_exceeded: false },
          comments: [],
          warnings: [
            { type: "subtask_error", file: "src/b.ts", message: "main_task did not complete" },
          ],
        }),
        ruleDigest: engineDigest,
      });
      // The retry reviews the one path it was aimed at, and reports no casualties.
      runEngineMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          status: "success",
          summary: { files_reviewed: 1, total_tokens: 20_000, budget_exceeded: false },
          comments: [],
          warnings: [],
        }),
        ruleDigest: engineDigest,
      });

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      // This is the whole point of the change: a review that used to be permanently incomplete
      // over a minority of named files now finishes.
      expect(report.reason).toBeUndefined();
      expect(report.outcome).toBe("complete");
      expect(diagnostics.drain().map((r) => r.code)).toContain("engine.resumed_gap_targeted");
    });

    it("splits subtask failures by cause, so the tool-round ceiling can be evaluated", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // One file lost to the engine's tool-round ceiling, one to a failed model call. Both are
      // `subtask_error`; only the first is answered by raising the ceiling, and a diagnostic that
      // could not tell them apart would make that change unmeasurable.
      runEngineMock.mockResolvedValue({
        stdout: JSON.stringify({
          status: "completed_with_errors",
          summary: { files_reviewed: 2, total_tokens: 60_000, budget_exceeded: false },
          comments: [],
          warnings: [
            {
              type: "subtask_error",
              file: "src/a.ts",
              message: "main_task did not complete before stopping",
            },
            { type: "subtask_error", file: "src/b.ts", message: "LLM completion error: 503" },
          ],
        }),
        ruleDigest: engineDigest,
      });

      const diagnostics = createSilentDiagnostics();
      await performReview(baseRequest(undefined), diagnostics);

      const status = diagnostics
        .drain()
        .find((record) => record.code === "engine.status.completed_with_errors");
      expect(status?.counts).toMatchObject({
        warnings_subtask_error: 2,
        warnings_subtask_error_tool_budget: 1,
        warnings_subtask_error_other: 1,
      });
    });

    it("prices a targeted round from the gap it dispatches, not from the first attempt's leftovers", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // The Keiko#3008 shape (2026-08-06): the first attempt spends nearly the whole allotment,
      // so the old floor-fraction handed its retry a budget sized to what was LEFT rather than to
      // the work it had to do. One file to review must get one file's worth of headroom.
      runEngineMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          status: "completed_with_errors",
          // Most of the allotment gone, yet nowhere near the consumer's own 2M ceiling — exactly
          // the shape where the old floor-fraction shrank the retry as the review grew.
          summary: { files_reviewed: 2, total_tokens: 900_000, budget_exceeded: false },
          comments: [],
          warnings: [
            { type: "subtask_error", file: "src/b.ts", message: "main_task did not complete" },
          ],
        }),
        ruleDigest: engineDigest,
      });
      runEngineMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          status: "success",
          summary: { files_reviewed: 1, total_tokens: 50_000, budget_exceeded: false },
          comments: [],
          warnings: [],
        }),
        ruleDigest: engineDigest,
      });

      await performReview(baseRequest(undefined), createSilentDiagnostics());

      const second = runEngineMock.mock.calls[1]?.[0] as { allottedBudget: number };
      // One file at `allottedPerFile()` x ALLOTMENT_MARGIN — priced at the tool-round ceiling in
      // force, not at a fraction of a nearly-spent allotment, which is what produced the
      // 399k-for-four-files round that threw.
      expect(second.allottedBudget).toBe(260_000);
    });

    it("dispatches NO round once the ceiling is exhausted, because 0 means unlimited downstream", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // The Keiko#3008 shape (2026-08-06): the first attempt has already spent past the 2M
      // ceiling. A budget rendered as a number here would be 0, and the engine's own
      // `--max-tokens-budget` help reads `0 = unlimited` — so the one run that most needs a bound
      // would proceed without one. It spent 9.07M against a 6M ceiling before this test existed.
      runEngineMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          status: "completed_with_errors",
          summary: { files_reviewed: 2, total_tokens: 2_500_000, budget_exceeded: false },
          comments: [],
          warnings: [
            { type: "subtask_error", file: "src/b.ts", message: "main_task did not complete" },
          ],
        }),
        ruleDigest: engineDigest,
      });

      const diagnostics = createSilentDiagnostics();
      await performReview(baseRequest(undefined), diagnostics);

      // Exactly one dispatch: the first attempt. No round was funded, so none was sent.
      expect(runEngineMock).toHaveBeenCalledTimes(1);
      const codes = diagnostics.drain().map((record) => record.code);
      expect(codes).toContain("engine.resume_skipped_budget_exhausted");
      expect(codes).not.toContain("engine.resumed_gap_targeted");
    });

    it("never lets a targeted round outspend what the consumer's ceiling has left", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // 1.8M of the 2M ceiling already spent: the round is worth 260k and may have 200k. Pricing
      // by the gap must never turn a stop-loss into a blank cheque. (Headroom is deliberately
      // above ALLOTMENT_FLOOR — below it no round is dispatched at all, which its own test
      // covers.)
      runEngineMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          status: "completed_with_errors",
          summary: { files_reviewed: 2, total_tokens: 1_800_000, budget_exceeded: false },
          comments: [],
          warnings: [
            { type: "subtask_error", file: "src/b.ts", message: "main_task did not complete" },
          ],
        }),
        ruleDigest: engineDigest,
      });
      runEngineMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          status: "success",
          summary: { files_reviewed: 1, total_tokens: 10_000, budget_exceeded: false },
          comments: [],
          warnings: [],
        }),
        ruleDigest: engineDigest,
      });

      await performReview(baseRequest(undefined), createSilentDiagnostics());

      const second = runEngineMock.mock.calls[1]?.[0] as { allottedBudget: number };
      expect(second.allottedBudget).toBe(200_000);
    });

    it("keeps retrying while the gap shrinks, and stops the moment it does not", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // Round 0 loses one of two paths; round 1 returns the SAME casualty. That is the
      // deterministic per-file failure, recognised one round later — the loop must stop there
      // rather than buying two more rounds of the identical answer.
      runEngineMock.mockResolvedValue({
        stdout: finishedWithFailures(["src/b.ts"], 2),
        ruleDigest: engineDigest,
      });

      const diagnostics = createSilentDiagnostics();
      await performReview(baseRequest(undefined), diagnostics);

      // First dispatch plus exactly one targeted round — never the cap of three.
      expect(runEngineMock).toHaveBeenCalledTimes(2);
      const codes = diagnostics.drain().map((record) => record.code);
      expect(codes).toContain("engine.resume_gap_not_shrinking");
    });

    it("still refuses a wholesale retry when the failures are not a minority", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // Both reviewable paths failed. Retrying is the full re-dispatch the Keiko#3002 measurement
      // priced at ~0.76M tokens for the same answer — the blanket refusal still governs here.
      runEngineMock.mockResolvedValueOnce({
        stdout: finishedWithFailures(["src/a.ts", "src/b.ts"], 2),
        ruleDigest: engineDigest,
      });

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      expect(runEngineMock).toHaveBeenCalledTimes(1);
      expect(report.outcome).toBe("incomplete");
      expect(report.reason).toBe("settlement.incomplete.coverage_gap");

      const codes = diagnostics.drain().map((record) => record.code);
      expect(codes).toContain("engine.resume_skipped_run_completed");
      expect(codes).not.toContain("engine.resumed_gap_targeted");
      expect(codes).toContain("engine.status.completed_with_errors");
    });
  });

  /**
   * The resume's own carry-forward (v0.13.0): a first attempt's real findings are neither re-paid
   * for nor silently lost — the resumed dispatch excludes the paths they came from, and the
   * findings themselves are folded back into whatever the resume produces.
   */
  describe("performReview: resume carries the first attempt's own findings forward", () => {
    beforeEach(() => {
      runEngineMock.mockReset();
      acquireEngineMock.mockReset();
    });

    /** A non-success first attempt carrying one real finding against `src/a.ts`. */
    function firstAttemptWithFinding(): string {
      return JSON.stringify({
        status: "failed",
        summary: { files_reviewed: 1, total_tokens: 500, budget_exceeded: false },
        comments: [
          {
            path: "src/a.ts",
            content: "The retry loop never resets its attempt counter.",
            start_line: 1,
            end_line: 1,
            severity: "high",
            category: "bug",
          },
        ],
      });
    }

    it("excludes the first attempt's finding paths from the resumed dispatch", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock
        .mockResolvedValueOnce({ stdout: firstAttemptWithFinding(), ruleDigest: engineDigest })
        .mockResolvedValueOnce({ stdout: engineStdout(2), ruleDigest: engineDigest });

      await performReview(baseRequest(undefined), createSilentDiagnostics());

      const secondOptions = runEngineMock.mock.calls[1]?.[0] as {
        mechanicallyCleanPaths: readonly string[];
        expectedReviewablePaths: readonly string[];
      };
      expect(secondOptions.mechanicallyCleanPaths).toContain("src/a.ts");
      expect(secondOptions.expectedReviewablePaths).toEqual(["src/b.ts"]);
    });

    it("folds the first attempt's finding into the final result even though the resume never re-covers that path", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock
        .mockResolvedValueOnce({ stdout: firstAttemptWithFinding(), ruleDigest: engineDigest })
        // The resume's own dispatch reports success over the REST of the inventory (src/b.ts) and
        // says nothing about src/a.ts at all — exactly what excluding it from dispatch produces.
        .mockResolvedValueOnce({ stdout: engineStdout(1), ruleDigest: engineDigest });

      const request = baseRequest(undefined);
      // The standard create/read-back echo this file's publish tests use throughout: the created
      // comment's OWN body (carrying the real marker `publishComposedFinding` embeds) is what a
      // real GitHub read-back would return, which is what makes `verifyPublication` pass.
      const posted: ReviewComment[] = [];
      const createSpy = vi
        .spyOn(request.client, "createReviewComment")
        .mockImplementation((_ref, _num, input) => {
          const comment: ReviewComment = {
            id: posted.length + 1,
            body: input.body,
            path: input.path,
            authorLogin: "keiko-for-quality[bot]",
            commitId: input.commitId,
            url: "https://example.test/c",
          };
          posted.push(comment);
          return Promise.resolve(comment);
        });
      vi.spyOn(request.client, "getReviewComment").mockImplementation((_ref, id) =>
        Promise.resolve(posted[id - 1]!),
      );

      const report = await performReview(request, createSilentDiagnostics());

      // Complete, not incomplete: `files_reviewed: 1` in the resumed stdout plus the one memoized
      // path is exactly `unreviewedByEngine` minus what dispatch actually covered — the coverage
      // math still closes. The finding itself reached publication, proving it was not dropped.
      expect(report.outcome).toBe("complete");
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it("does not carry forward a finding on a path the manifest itself reports as failed", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const partialFailure = JSON.stringify({
        status: "failed",
        summary: { files_reviewed: 1, total_tokens: 500, budget_exceeded: false },
        comments: [
          {
            path: "src/a.ts",
            content: "A partial verdict from before the failure.",
            start_line: 1,
            end_line: 1,
            severity: "high",
            category: "bug",
          },
        ],
        manifest: {
          schema_version: SUPPORTED_MANIFEST_SCHEMA,
          terminal_state: "partial",
          coverage: {
            selected: [{ path: "src/a.ts" }],
            completed: [],
            reused: [],
            // The manifest itself says src/a.ts's own review failed — a finding filed alongside
            // that is not proof the file was safely, fully reviewed, so it must not be excluded
            // from the resumed dispatch on the strength of it alone.
            failed: [{ path: "src/a.ts" }],
            waived: [],
          },
        },
      });
      runEngineMock
        .mockResolvedValueOnce({ stdout: partialFailure, ruleDigest: engineDigest })
        .mockResolvedValueOnce({ stdout: engineStdout(2), ruleDigest: engineDigest });

      await performReview(baseRequest(undefined), createSilentDiagnostics());

      const secondOptions = runEngineMock.mock.calls[1]?.[0] as {
        mechanicallyCleanPaths: readonly string[];
      };
      expect(secondOptions.mechanicallyCleanPaths).not.toContain("src/a.ts");
    });
  });

  /**
   * The resume's own failure handling (v0.13.0): a second attempt that throws no longer takes the
   * whole run down with it when the first attempt left something real to fall back to.
   */
  describe("performReview: resume-failed fallback (v0.13.0)", () => {
    beforeEach(() => {
      runEngineMock.mockReset();
      acquireEngineMock.mockReset();
    });

    it("falls back to the first attempt's own result when the resumed attempt throws EngineRunError", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const nonSuccess = JSON.stringify({
        status: "failed",
        summary: { files_reviewed: 0, total_tokens: 500, budget_exceeded: false },
        comments: [],
      });
      runEngineMock
        .mockResolvedValueOnce({ stdout: nonSuccess, ruleDigest: engineDigest })
        .mockRejectedValueOnce(new EngineRunError("engine.run.timeout"));

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      // A worse outcome than a completed resume, but not a crashed run: the first attempt's own
      // non-success result stands, and settlement judges it exactly as it would with no resume.
      expect(report.outcome).toBe("incomplete");
      const codes = diagnostics.drain().map((r) => r.code);
      expect(codes).toContain("engine.resume_failed");
      const record = diagnostics.drain().find((r) => r.code === "engine.resume_failed");
      expect(record?.counts).toStrictEqual({ spent: 500 });
      // Both attempts' spend is real and must both land in run.spend, exactly as a completed
      // resume would report — the fallback changes which result stands, not what was paid.
      const spend = diagnostics.drain().find((r) => r.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 500, classify: 0, total: 500 });
    });

    /**
     * "Rethrows" inside `runEngineWithOneResume` does not mean "rejects `performReview`'s own
     * promise" — `settleOrReport` (review.ts) already wraps the whole engine step in a catch-all
     * that turns ANY exception into `settlement.incomplete.engine_error`, and that pre-existing
     * behavior is exactly what this resume-failed fallback preserves for the "nothing to fall back
     * to" case: unchanged from before the fallback existed, not a new rejection path.
     */
    it("still settles incomplete (never a fallback) when the FIRST attempt threw and the resume also throws", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock
        .mockRejectedValueOnce(new EngineRunError("engine.run.spawn_failed"))
        .mockRejectedValueOnce(new EngineRunError("engine.run.timeout"));

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      expect(report.outcome).toBe("incomplete");
      if (report.outcome === "incomplete") {
        expect(report.reason).toBe("settlement.incomplete.engine_error");
      }
      // No fallback: there was no first RESULT to fall back to, only a first attempt that threw.
      const codes = diagnostics.drain().map((r) => r.code);
      expect(codes).not.toContain("engine.resume_failed");
    });

    it("still settles incomplete on a malformed (non-EngineRunError) failure from the resumed attempt, never falling back", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const nonSuccess = JSON.stringify({
        status: "failed",
        summary: { files_reviewed: 0, total_tokens: 500, budget_exceeded: false },
        comments: [],
      });
      runEngineMock
        .mockResolvedValueOnce({ stdout: nonSuccess, ruleDigest: engineDigest })
        // Not valid engine-result JSON at all — parseEngineResult throws a ValidationError, which
        // reject-rather-than-repair says must propagate unresumed even though a `firstResult` DOES
        // exist here — the guard is `instanceof EngineRunError`, not "something to fall back to".
        .mockResolvedValueOnce({ stdout: "not json", ruleDigest: engineDigest });

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(baseRequest(undefined), diagnostics);

      expect(report.outcome).toBe("incomplete");
      if (report.outcome === "incomplete") {
        expect(report.reason).toBe("settlement.incomplete.engine_error");
      }
      // Not the resume-failed fallback: a ValidationError never reaches that rescue at all.
      const codes = diagnostics.drain().map((r) => r.code);
      expect(codes).not.toContain("engine.resume_failed");
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
      const engineDigest = requireEngineDigest();
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
      const engineDigest = requireEngineDigest();
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
      const engineDigest = requireEngineDigest();
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
      const engineDigest = requireEngineDigest();
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
   * The classification cost guard: `repairEngineFindings` runs before settlement and planning, while
   * the parser intentionally accepts up to 1,000 raw hypotheses. `maxFindings` is now solely the
   * FINAL publication ceiling, so a larger raw cohort must settle normally and continue through the
   * bounded publication pipeline. What it must not do is pay one early repair call for every raw,
   * candidate-shaped hypothesis. The verifier shortlist (sixteen model candidates maximum) and
   * later audit provide the bounded downstream work. These tests use the openai protocol so both the
   * skipped repair and the still-running verification are observable separately.
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

    function refutingEndpoint(counters: { repair: number; verification: number }): typeof fetch {
      return ((_url: string, init?: { body?: string }) => {
        const parsedBody = JSON.parse(init?.body ?? "{}") as {
          messages?: { content?: string }[];
        };
        const prompt = parsedBody.messages?.[0]?.content ?? "";
        let content: string;
        if (prompt.includes("Classify one code-review finding.")) {
          counters.repair += 1;
          content = JSON.stringify({ category: "bug", severity: "medium" });
        } else if (prompt.includes("Verify the truth of one AI-generated")) {
          counters.verification += 1;
          content = JSON.stringify({
            verdict: "refuted",
            reason_code: "contradicted",
            evidence_refs: ["H:1"],
            lookup_terms: [],
          });
        } else if (prompt.includes("Make the final truth decision")) {
          counters.verification += 1;
          content = JSON.stringify({
            verdict: "refuted",
            reason_code: "contradicted",
            evidence_refs: ["H:1"],
          });
        } else {
          content = JSON.stringify({ category: "bug", severity: "medium" });
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: "stop", message: { content } }],
              usage: { total_tokens: 10 },
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;
    }

    it("skips mass repair above maxFindings without invalidating the completed review", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: manyFindingsStdout(OPENAI_CONFIG.maxFindings + 1, 2),
        ruleDigest: engineDigest,
      });

      const counters = { repair: 0, verification: 0 };
      globalThis.fetch = refutingEndpoint(counters);

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(openaiRequest(), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(report.reason).toBeUndefined();
      // The 51 raw hypotheses collapse to two fingerprints before verification; each receives the
      // initial and terminal truth decisions. The separate selector tests pin the sixteen-candidate
      // ceiling when the cohort remains distinct.
      expect(counters).toStrictEqual({ repair: 0, verification: 4 });

      const records = diagnostics.drain();
      expect(records.find((record) => record.code === "engine.result.candidates")?.counts).toEqual({
        generated: 51,
      });
      expect(records.find((record) => record.code === "publish.candidates.ranked")?.counts).toEqual(
        {
          verified: 2,
          ranked: 0,
          publication: 0,
        },
      );
    });

    it("still runs early repair at exactly maxFindings", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: manyFindingsStdout(OPENAI_CONFIG.maxFindings, 2),
        ruleDigest: engineDigest,
      });

      const counters = { repair: 0, verification: 0 };
      globalThis.fetch = refutingEndpoint(counters);

      const diagnostics = createSilentDiagnostics();
      await performReview(openaiRequest(), diagnostics);

      expect(counters.repair).toBe(OPENAI_CONFIG.maxFindings);
      expect(counters.verification).toBe(4);
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

    it("abandons a head that moved during the engine run before the pass spends anything (2026-08-06)", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: cleanEngineStdout(), ruleDigest: engineDigest });
      let fetchCalls = 0;
      globalThis.fetch = (() => {
        fetchCalls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;

      // Fresh on the FIRST call, stale from then on — the same race the settleIncomplete staleness
      // tests reproduce: the head was current at the pre-flight check and moved while the engine
      // ran. The next `getPullRequest` after that is the early, flag-gated check this test pins.
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
        config: PASS_CONFIG,
        profile: PROFILE,
        guidelines: { paths: [] },
        identity: "keiko-for-quality[bot]",
        identityExclusive: true,
        env: { MODEL_TOKEN: "fake-token" },
        pathValue: process.env.PATH ?? "/usr/bin:/bin",
      };

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(request, diagnostics);

      // The pre-flight check passed (fresh), so the engine genuinely ran — proof the run reached
      // the new early check rather than being short-circuited before the spend it protects.
      expect(runEngineMock).toHaveBeenCalledTimes(1);
      expect(report.outcome).toBe("abandoned");

      // The discriminator against the pre-2026-08-06 order, where `collectChangePassFindings` ran
      // before ANY staleness check: the pass records `contracts.change_pass` whenever it gets past
      // its flag and endpoint guards — this fixture's own zero-summary short-circuit still does —
      // so its absence proves the collection never STARTED, not merely that no model call happened
      // to fire. The fetch count pins the model half of the same claim.
      const codes = diagnostics.drain().map((record) => record.code);
      expect(codes).toContain("publish.abandoned_stale_head");
      expect(codes).not.toContain("contracts.change_pass");
      expect(fetchCalls).toBe(0);
      expect(createSpy).not.toHaveBeenCalled();
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
        mapping_crossover: 0,
        local_regression: 0,
        cross_file_regression: 0,
      });
    });

    /**
     * The zero-cost gates depend on nothing the engine settlement decided (v0.13.0) — a coverage
     * gap says only that the ENGINE fell short, never that a declared contract pair agrees. Same
     * fixture as the test above, except the engine now reports fewer files reviewed than the
     * inventory expects, settling `coverage_gap` — and the drift finding must still reach the pull
     * request through the incomplete-notice publish path, not be silently dropped with the rest of
     * the (in this case, empty) engine output.
     */
    it("still runs the deterministic gate, and publishes its finding, when the engine settlement is incomplete", async () => {
      // Deliberately not byte-identical to the earlier gate test's own fixture (an extra member,
      // `c`) — this describe block reuses one shared repo across its tests, and a byte-identical
      // rewrite here would leave `git add -A` with nothing to stage and the commit below would fail.
      await writeFile(
        join(repo, "src/server-api.ts"),
        "export interface ApiShape {\n  a: string;\n  b: string;\n  c: string;\n}\n",
      );
      await writeFile(
        join(repo, "src/client-api.ts"),
        "export interface ApiShape {\n  a: string;\n  b: string;\n}\n",
      );
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "gate-incomplete", "--no-gpg-sign"]);
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
      // Three reviewable files changed (server-api, client-api, plus the shared fixture's own
      // src/a.ts and src/b.ts are NOT part of this diff — base is the gate commit's own parent), but
      // the engine reports covering only one — a genuine coverage gap, nothing to do with the gate.
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
          base: commitSha(headSha),
          head: commitSha(gateHead),
          config: GATE_CONFIG,
          profile: gateProfile,
          env: { MODEL_TOKEN: "fake-token" },
        },
        diagnostics,
      );

      expect(report.outcome).toBe("incomplete");
      expect(report.reason).toBe("settlement.incomplete.coverage_gap");
      // The gate's own finding still reached the pull request, through the incomplete-notice
      // publish path — not silently dropped alongside the engine's own (empty) output.
      expect(created[0]?.path).toBe("src/server-api.ts");
      expect(created[0]?.body).toContain("ApiShape");
      expect(modelCalls).toBe(0);
      const record = diagnostics.drain().find((r) => r.code === "contracts.gate");
      expect(record?.counts?.findings).toBe(1);
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
     * The same production shape as the test above, but the file was also renamed in the same push
     * (v0.13.0) — a rename with real content edits, which `git` detects as a rename by similarity,
     * not as a delete-plus-add. Before this fix the pin-desync scan's own `item.status !== "M"`
     * filter silently dropped every renamed file, so this exact case — the file that motivated the
     * check in the first place, PLUS a rename — published nothing.
     */
    it("catches a same-file duplicate pin desync on a file that was also renamed", async () => {
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
      // Renamed AND only the `uses:` site advances — git detects this as a rename by content
      // similarity (well above the fixture's 50% threshold), not a delete-plus-add.
      git(["mv", "src/pinned.yml", "src/pinned-renamed.yml"]);
      await writeFile(join(repo, "src/pinned-renamed.yml"), workflow(newSha, oldSha));
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "pin-head-renamed", "--no-gpg-sign"]);
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
      // Anchored on the file's CURRENT name — the only one a still-open diff can attach a comment
      // to — never the old one, even though the base-side read that proved the desync came from it.
      expect(created[0]?.path).toBe("src/pinned-renamed.yml");
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
      // The immutable fixture contains one unchanged contract symbol. Model challenge planning is
      // gone; the real deterministic follow-up reaches it through the bounded anchor-owner hop.
      findAstAnchorOwnerAtHeadMock.mockImplementation(
        ({
          reviewPath,
          findingAnchor,
        }: {
          reviewPath: string;
          findingAnchor: { startLine: number };
        }) =>
          Promise.resolve({
            name: "challengeGuard",
            definition: {
              path: reviewPath,
              line: findingAnchor.startLine,
              content: "export const challengeGuard = true;",
              kind: "definition" as const,
            },
          }),
      );
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
    function successfulClient(
      existing: readonly ReviewComment[] = [],
      currentHead = headSha,
    ): {
      client: GitHubClient;
      created: ReviewCommentInput[];
    } {
      const client = new GitHubClient("https://api.example.test", "unused");
      const createdComments: ReviewComment[] = [];
      const createdInputs: ReviewCommentInput[] = [];
      vi.spyOn(client, "getPullRequest").mockResolvedValue({
        headSha: commitSha(currentHead),
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
        identityExclusive: true,
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

    function withChallengeProbe(content: string): string {
      return `${content} The independent \`claimProbe\` branch must also hold.`;
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
      judgeVerdict?: "grounded" | "vague" | "unsupported";
      judgeEvidenceRef?: string;
      judgeChangeRef?: string;
      judgeAdditionalRefs?: readonly string[];
      judgeTransportFailure?: boolean;
      onJudgePrompt?: (prompt: string) => void;
      onChallengePrompt?: (prompt: string) => void;
      onFalsifierPrompt?: (prompt: string) => void;
      onRefereePrompt?: (prompt: string) => void;
      challengeAxis?:
        | "same_file_contract"
        | "caller"
        | "configuration"
        | "runtime"
        | "test"
        | "base";
      challengeEvidenceRef?: string;
      challengeLookupTerm?: string;
      falsifierEvidenceRef?: string;
      refereeEvidenceRef?: string;
      consequence?: "actionable" | "nitpick";
      tokensPerCall?: number;
    }): { impl: typeof fetch; callCount: () => number } {
      let calls = 0;
      const tokens = opts.tokensPerCall ?? 10;
      const truthReply = (terminal: boolean): string => {
        const verdict = opts.judgeVerdict ?? "grounded";
        const stateRef = opts.judgeEvidenceRef ?? "H:1";
        const line = /:([1-9]\d*)$/u.exec(stateRef)?.[1] ?? "1";
        const changeRef = opts.judgeChangeRef ?? `D:H:${line}`;
        if (verdict === "vague") {
          return JSON.stringify({
            verdict: terminal ? "insufficient_evidence" : "needs_context",
            reason_code: "missing_definition",
            evidence_refs: [stateRef],
            ...(terminal ? {} : { lookup_terms: ["missingDefinition"] }),
          });
        }
        if (verdict === "unsupported") {
          return JSON.stringify({
            verdict: "refuted",
            reason_code: "contradicted",
            evidence_refs: [stateRef],
            ...(terminal ? {} : { lookup_terms: [] }),
          });
        }
        return JSON.stringify({
          verdict: "confirmed",
          reason_code: "direct_proof",
          evidence_refs: [stateRef, changeRef, ...(opts.judgeAdditionalRefs ?? [])],
          ...(terminal ? {} : { lookup_terms: [] }),
        });
      };
      const impl = ((_url: string, init?: { body?: string }) => {
        calls += 1;
        const parsedBody = JSON.parse(init?.body ?? "{}") as { messages?: { content?: string }[] };
        const prompt = parsedBody.messages?.[0]?.content ?? "";
        // Substantiation shares this endpoint and runs BEFORE the audit. Truth confirmation must
        // pass through the strict planner envelope, real deterministic retrieval, and a falsifier
        // citation from the retrieved R4-R6 pack before these classification fixtures can publish.
        if (prompt.includes("Plan one independent contract trace")) {
          opts.onChallengePrompt?.(prompt);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      content: JSON.stringify({
                        axis: opts.challengeAxis ?? "caller",
                        evidence_refs: [opts.challengeEvidenceRef ?? "H:1"],
                        lookup_terms: [opts.challengeLookupTerm ?? "challengeGuard"],
                      }),
                    },
                  },
                ],
                usage: { total_tokens: tokens },
              }),
              { status: 200 },
            ),
          );
        }
        if (prompt.includes("Adversarially falsify")) {
          opts.onFalsifierPrompt?.(prompt);
          const defeated = opts.consequence === "nitpick";
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      content: JSON.stringify(
                        defeated
                          ? {
                              verdict: "defeated",
                              reason_code: "counterexample",
                              evidence_refs: [opts.falsifierEvidenceRef ?? "R4:H:1"],
                            }
                          : {
                              verdict: "survives",
                              reason_code: "no_defeater_found",
                              evidence_refs: [opts.falsifierEvidenceRef ?? "R4:H:1"],
                            },
                      ),
                    },
                  },
                ],
                usage: { total_tokens: tokens },
              }),
              { status: 200 },
            ),
          );
        }
        if (prompt.includes("final independent referee")) {
          opts.onRefereePrompt?.(prompt);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      content: JSON.stringify({
                        verdict: opts.consequence === "nitpick" ? "defeated" : "survives",
                        evidence_refs: [
                          opts.refereeEvidenceRef ?? opts.falsifierEvidenceRef ?? "R4:H:1",
                        ],
                      }),
                    },
                  },
                ],
                usage: { total_tokens: tokens },
              }),
              { status: 200 },
            ),
          );
        }
        if (prompt.includes("Make the final truth decision")) {
          opts.onJudgePrompt?.(prompt);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: truthReply(true) },
                  },
                ],
                usage: { total_tokens: tokens },
              }),
              { status: 200 },
            ),
          );
        }
        if (prompt.includes("Verify the truth of one AI-generated")) {
          opts.onJudgePrompt?.(prompt);
          if (opts.judgeTransportFailure === true) {
            return Promise.reject(new Error("judge transport failure"));
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: truthReply(false) },
                  },
                ],
                usage: { total_tokens: tokens },
              }),
              { status: 200 },
            ),
          );
        }
        const pair = prompt.includes("Audit the classification") ? opts.auditPair : opts.repairPair;
        const content =
          pair === undefined ? "no pair configured for this call" : JSON.stringify(pair);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: "stop", message: { content } }],
              usage: { total_tokens: tokens },
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;
      return { impl, callCount: () => calls };
    }

    it("does not let two low-ranked HTML hypotheses destroy a 136-candidate completed review", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const safe = Array.from({ length: 134 }, (_, index) => ({
        path: "src/a.ts",
        content: withChallengeProbe(
          `When alpha${String(index)} occurs, beta${String(index)} corrupts gamma${String(index)}, ` +
            `delta${String(index)}, epsilon${String(index)}, zeta${String(index)}, eta${String(index)}, ` +
            `theta${String(index)}, iota${String(index)}, kappa${String(index)}, lambda${String(index)}, ` +
            `mu${String(index)}, nu${String(index)}, xi${String(index)}, omicron${String(index)}, ` +
            `pi${String(index)}, rho${String(index)}, and sigma${String(index)}.`,
        ),
        category: "bug",
        severity: "high",
      }));
      const rejected = [
        {
          path: "src/a.ts",
          content: "When markup is copied, <script>one</script> remains in this candidate body.",
          category: "bug",
          severity: "low",
        },
        {
          path: "src/a.ts",
          content: "When markup is copied, <widget>two</widget> remains in this candidate body.",
          category: "bug",
          severity: "low",
        },
      ];
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout([...safe, ...rejected], 2),
        ruleDigest: engineDigest,
      });
      const { impl } = classifyFetchMock({ auditPair: { category: "bug", severity: "high" } });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);
      const diagnostics = createSilentDiagnostics();

      const report = await performReview(auditRequest(client), diagnostics);
      const records = diagnostics.drain();

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({
        published: 8,
        rejectedSanitization: 0,
        suppressedRanked: 128,
      });
      expect(created).toHaveLength(8);
      expect(created.some((comment) => comment.body.includes("<script>"))).toBe(false);
      expect(
        records.find((record) => record.code === "publish.candidates.planned")?.counts,
      ).toStrictEqual({ generated: 136, sanitized: 134, deduplicated: 134 });
    });

    it("still fails closed when a selected and verified finding remains unsafe to publish", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const body = withChallengeProbe(
        "When markup is copied, <script>alert(1)</script> remains in this selected candidate body.",
      );
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: body, category: "bug", severity: "high" }],
          2,
        ),
        ruleDigest: engineDigest,
      });
      const { impl } = classifyFetchMock({ auditPair: { category: "bug", severity: "high" } });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);

      const report = await performReview(auditRequest(client), createSilentDiagnostics());

      expect(report.outcome).toBe("incomplete");
      expect(report.reason).toBe("settlement.incomplete.publication_degraded");
      expect(report.publish).toMatchObject({ published: 0, rejectedSanitization: 1 });
      expect(created.some((comment) => comment.body.includes("<script>"))).toBe(false);
    });

    it("lets Truth refute a selected unsafe hypothesis without degrading publication", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const body =
        "When markup is copied, <script>alert(1)</script> allegedly changes runtime behavior here.";
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: body, category: "bug", severity: "high" }],
          2,
        ),
        ruleDigest: engineDigest,
      });
      const { impl } = classifyFetchMock({ judgeVerdict: "unsupported" });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);

      const report = await performReview(auditRequest(client), createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({ published: 0, rejectedSanitization: 0 });
      expect(created).toHaveLength(0);
    });

    it("binds a closed runtime fact to the exact reviewed commit and requires its T ref", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [
            {
              path: "src/a.ts",
              content:
                "When `maybe` is undefined, spreading it into this object throws before fallback.",
              category: "bug",
              severity: "medium",
            },
          ],
          2,
        ),
        ruleDigest: engineDigest,
      });
      collectClosedRuntimeFactsAtCommitMock.mockResolvedValue([
        {
          catalogVersion: CLOSED_RUNTIME_FACT_CATALOG_VERSION,
          id: "ecmascript.object_spread.nullish_source_is_noop",
          statement: CLOSED_RUNTIME_FACT_CATALOG["ecmascript.object_spread.nullish_source_is_noop"],
          source: { path: "src/a.ts", side: "H", line: 1 },
        },
      ]);
      let falsifierPrompt = "";
      const { impl, callCount } = classifyFetchMock({
        consequence: "nitpick",
        falsifierEvidenceRef: "R4:T:1",
        onFalsifierPrompt: (prompt) => {
          falsifierPrompt = prompt;
        },
      });
      globalThis.fetch = impl;
      const client = successfulClient([]);

      const report = await performReview(auditRequest(client.client), createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(report.publish?.published).toBe(0);
      expect(callCount()).toBe(3);
      expect(collectClosedRuntimeFactsAtCommitMock).toHaveBeenCalledTimes(1);
      expect(collectClosedRuntimeFactsAtCommitMock.mock.calls[0]?.[0]).toMatchObject({
        commit: headSha,
        path: "src/a.ts",
        side: "H",
        findingAnchor: { startLine: 1, endLine: 1 },
      });
      expect(falsifierPrompt).toContain('"evidence_refs":["R4:T:1"]');
      expect(falsifierPrompt).toContain(
        CLOSED_RUNTIME_FACT_CATALOG["ecmascript.object_spread.nullish_source_is_noop"],
      );
    });

    it("keeps BASE contract retrieval when an inserted finding has no BASE runtime anchor", async () => {
      const unmappedRepo = await mkdtemp(join(tmpdir(), "kfq-review-unmapped-base-anchor-"));
      try {
        const unmappedGit = (args: readonly string[]): string => git(args, unmappedRepo);
        unmappedGit(["init", "-q", "-b", "main"]);
        await mkdir(join(unmappedRepo, "src"), { recursive: true });
        await writeFile(join(unmappedRepo, "src/a.ts"), "export const challengeGuard = true;\n");
        await writeFile(
          join(unmappedRepo, "src/challenge.ts"),
          "export const challengeGuard = true;\n",
        );
        unmappedGit(["add", "-A"]);
        unmappedGit(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
        const unmappedBase = unmappedGit(["rev-parse", "HEAD"]).trim();

        await writeFile(
          join(unmappedRepo, "src/a.ts"),
          ["export const copied = { ...maybe };", "export const challengeGuard = true;", ""].join(
            "\n",
          ),
        );
        unmappedGit(["add", "-A"]);
        unmappedGit(["commit", "-q", "-m", "head", "--no-gpg-sign"]);
        const unmappedHead = unmappedGit(["rev-parse", "HEAD"]).trim();

        const engineDigest = requireEngineDigest();
        acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
        findAstAnchorOwnerAtHeadMock.mockResolvedValue(undefined);
        runEngineMock.mockResolvedValue({
          stdout: findingsStdout(
            [
              {
                path: "src/a.ts",
                content:
                  "When `maybe` is undefined, this object spread throws before fallback. " +
                  "The independent `challengeGuard` contract must still hold.",
                category: "bug",
                severity: "medium",
              },
            ],
            1,
          ),
          ruleDigest: engineDigest,
        });

        let falsifierPrompt = "";
        const endpoint = classifyFetchMock({
          auditPair: { category: "bug", severity: "medium" },
          judgeEvidenceRef: "H:1",
          judgeChangeRef: "D:H:1",
          judgeAdditionalRefs: ["B:1"],
          falsifierEvidenceRef: "R4:B:1",
          onFalsifierPrompt: (prompt) => {
            falsifierPrompt = prompt;
          },
        });
        globalThis.fetch = endpoint.impl;
        const client = successfulClient([], unmappedHead);
        const report = await performReview(
          {
            ...auditRequest(client.client),
            base: commitSha(unmappedBase),
            head: commitSha(unmappedHead),
            repositoryPath: unmappedRepo,
          },
          createSilentDiagnostics(),
        );

        expect(report.outcome).toBe("complete");
        expect(report.publish?.published).toBe(1);
        expect(collectClosedRuntimeFactsAtCommitMock).not.toHaveBeenCalled();
        expect(falsifierPrompt).toContain("R4 = BASE src/challenge.ts");
        expect(falsifierPrompt).toContain("R4:B:1| export const challengeGuard = true;");
      } finally {
        await rm(unmappedRepo, { recursive: true, force: true });
      }
    });

    it("routes a deleted-file same-file challenge through immutable BASE", async () => {
      const deletionRepo = await mkdtemp(join(tmpdir(), "kfq-review-deleted-challenge-"));
      try {
        const deletionGit = (args: readonly string[]): string => git(args, deletionRepo);
        deletionGit(["init", "-q", "-b", "main"]);
        await mkdir(join(deletionRepo, "src"), { recursive: true });
        const baseOnlyGuardLine = 1_502;
        await writeFile(
          join(deletionRepo, "src/deleted.ts"),
          [
            "removedContract();",
            ...Array.from(
              { length: baseOnlyGuardLine - 2 },
              (_value, index) => `const filler${String(index)} = ${String(index)};`,
            ),
            "export function baseOnlyGuard(): boolean { return true; }",
          ].join("\n"),
        );
        deletionGit(["add", "-A"]);
        deletionGit(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
        const deletionBase = deletionGit(["rev-parse", "HEAD"]).trim();
        await rm(join(deletionRepo, "src/deleted.ts"));
        deletionGit(["add", "-A"]);
        deletionGit(["commit", "-q", "-m", "delete", "--no-gpg-sign"]);
        const deletionHead = deletionGit(["rev-parse", "HEAD"]).trim();

        const engineDigest = requireEngineDigest();
        acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
        findAstAnchorOwnerAtHeadMock.mockResolvedValue({
          name: "baseOnlyGuard",
          definition: {
            path: "src/deleted.ts",
            line: 1,
            content: "removedContract();",
            kind: "definition" as const,
          },
        });
        runEngineMock.mockResolvedValue({
          stdout: findingsStdout(
            [
              {
                path: "src/deleted.ts",
                content: withChallengeProbe(
                  "When this startup call is removed, initialization no longer installs its required guard.",
                ),
                category: "bug",
                severity: "medium",
              },
            ],
            1,
          ),
          ruleDigest: engineDigest,
        });

        let falsifierPrompt = "";
        const endpoint = classifyFetchMock({
          auditPair: { category: "bug", severity: "medium" },
          judgeEvidenceRef: "B:1",
          judgeChangeRef: "D:B:1",
          challengeAxis: "same_file_contract",
          challengeEvidenceRef: "B:1",
          challengeLookupTerm: "baseOnlyGuard",
          falsifierEvidenceRef: `R4:B:${String(baseOnlyGuardLine)}`,
          onFalsifierPrompt: (prompt) => {
            falsifierPrompt = prompt;
          },
        });
        globalThis.fetch = endpoint.impl;
        const client = successfulClient([], deletionHead);
        const report = await performReview(
          {
            ...auditRequest(client.client),
            base: commitSha(deletionBase),
            head: commitSha(deletionHead),
            repositoryPath: deletionRepo,
          },
          createSilentDiagnostics(),
        );

        expect(report.outcome).toBe("complete");
        expect(report.publish?.published).toBe(1);
        expect(falsifierPrompt).toContain("R4 = BASE src/deleted.ts");
        expect(falsifierPrompt).toContain(`R4:B:${String(baseOnlyGuardLine)}|`);
      } finally {
        await rm(deletionRepo, { recursive: true, force: true });
      }
    });

    it("never caches an exact-suppressed fresh path, so a later run verifies it instead of replaying it", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY = withChallengeProbe(
        "This handler swallows the write error and reports success to the caller regardless.",
      );
      const finding = { path: "src/a.ts", content: BODY, category: "bug", severity: "medium" };
      runEngineMock
        .mockResolvedValueOnce({
          stdout: findingsStdout([finding], 2, 100),
          ruleDigest: engineDigest,
        })
        .mockResolvedValueOnce({
          // The first run may cache src/b.ts, but src/a.ts must be dispatched again.
          stdout: findingsStdout([finding], 1, 100),
          ruleDigest: engineDigest,
        });

      const { impl, callCount } = classifyFetchMock({
        auditPair: { category: "bug", severity: "medium" },
      });
      globalThis.fetch = impl;
      const firstClient = successfulClient([seededMarker("bug", BODY)]);
      const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };

      const diagnostics = createSilentDiagnostics();
      const first = await performReview(auditRequest(firstClient.client, empty), diagnostics);

      expect(first.outcome).toBe("complete");
      expect(first.publish).toMatchObject({
        published: 0,
        suppressed: 1,
        suppressedExactDuplicate: 1,
      });
      expect(firstClient.created).toHaveLength(0);
      // Already classified (no repair needed) and plan-suppressed (never a `fresh` survivor for the
      // audit) — the classify endpoint is never called at all.
      expect(callCount()).toBe(0);
      const firstEntries = first.updatedCacheStore?.entries ?? [];
      expect(firstEntries.some((entry) => String(entry.headBlob) === headBlobA)).toBe(false);

      // Remove the marker on the next run. If src/a.ts had been stored under evidence-gate semantics,
      // it would now replay as nonfresh and publish with zero verification calls. Instead only the
      // genuinely clean sibling is a hit and the engine must produce this finding fresh again.
      const secondClient = successfulClient([]);
      const second = await performReview(
        auditRequest(secondClient.client, first.updatedCacheStore),
        createSilentDiagnostics(),
      );

      expect(second.outcome).toBe("complete");
      expect(second.cacheHits).toBe(1);
      expect(second.cacheMisses).toBe(1);
      expect(second.publish).toMatchObject({ published: 1, suppressed: 0 });
      expect(secondClient.created).toHaveLength(1);
      expect(callCount()).toBeGreaterThan(0);
      const secondInvocation = runEngineMock.mock.calls[1]?.[0] as {
        mechanicallyCleanPaths: string[];
      };
      expect(secondInvocation.mechanicallyCleanPaths).toContain("src/b.ts");
      expect(secondInvocation.mechanicallyCleanPaths).not.toContain("src/a.ts");

      const records = diagnostics.drain();
      expect(records.find((r) => r.code === "classify.audited")).toBeUndefined();
      const spend = records.find((r) => r.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 0, total: 100 });
    });

    it("never caches an unclassified suppressed path when a raw flood skips early repair", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY = withChallengeProbe(
        "This handler swallows the write error and reports success to the caller regardless.",
      );
      const rawFlood = Array.from({ length: AUDIT_CONFIG.maxFindings + 1 }, () => ({
        path: "src/a.ts",
        content: BODY,
      }));
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(rawFlood, 2, 100),
        ruleDigest: engineDigest,
      });

      const { impl, callCount } = classifyFetchMock({
        auditPair: { category: "bug", severity: "medium" },
      });
      globalThis.fetch = impl;
      const client = successfulClient([seededMarker("general", BODY)]);
      const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };

      const report = await performReview(
        auditRequest(client.client, empty),
        createSilentDiagnostics(),
      );

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({
        published: 0,
        suppressed: AUDIT_CONFIG.maxFindings + 1,
        suppressedIntraRun: AUDIT_CONFIG.maxFindings,
        suppressedExactDuplicate: 1,
      });
      expect(callCount()).toBe(0);
      expect(client.created).toHaveLength(0);
      const entries = report.updatedCacheStore?.entries ?? [];
      expect(entries.some((entry) => String(entry.headBlob) === headBlobA)).toBe(false);
      expect(report.cacheAppended).toBe(1);
      expect(entries).toHaveLength(1);
    });

    it("audits a surviving fresh finding once via the fast path and publishes it with the audited classification", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY = withChallengeProbe(
        "This retry loop never resets its attempt counter, so it spins forever after one failure.",
      );
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
      let challengePrompt = "";
      let falsifierPrompt = "";
      const { impl, callCount } = classifyFetchMock({
        auditPair: { category: "bug", severity: "medium" },
        tokensPerCall: 37,
        onChallengePrompt: (prompt) => {
          challengePrompt = prompt;
        },
        onFalsifierPrompt: (prompt) => {
          falsifierPrompt = prompt;
        },
      });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(auditRequest(client), diagnostics);
      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({ published: 1, suppressed: 0 });
      expect(created).toHaveLength(1);
      // Truth cannot leak its verdict into the independent planner, while the later falsifier must
      // see and cite the real repository line returned for the planner's bounded lookup.
      expect(challengePrompt).not.toContain('"verdict":"confirmed"');
      expect(falsifierPrompt).toContain("R4:H:1| export const challengeGuard = true;");
      // Truth + falsifier + referee precede the one fast-path classification-audit vote.
      expect(callCount()).toBe(4);

      const records = diagnostics.drain();
      expect(records.find((r) => r.code === "publish.candidates.planned")?.counts).toEqual({
        generated: 1,
        sanitized: 1,
        deduplicated: 1,
      });
      expect(records.find((r) => r.code === "publish.candidates.ranked")?.counts).toEqual({
        verified: 1,
        ranked: 1,
        publication: 1,
      });
      expect(records.find((r) => r.code === "publish.pipeline.completed")?.counts).toEqual({
        published: 1,
      });
      const audited = records.find((r) => r.code === "classify.audited");
      expect(audited?.counts).toStrictEqual({ changed: 0, tokens: 37 });
      const substantiated = records.find((r) => r.code === "publish.substantiated");
      expect(substantiated?.counts).toMatchObject({
        challenge_planned: 1,
        challenge_retrieval_performed: 1,
        challenge_expanded: 1,
        challenge_no_matches: 0,
        challenge_failed: 0,
      });
      const spend = records.find((r) => r.code === "run.spend");
      // `classify` carries all three verifier roles alongside the audit: four metered calls total.
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 148, total: 248 });
    });

    it("never rewrites or audits a claim whose truth judge still needs missing context", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const ORIGINAL = "`a` can corrupt the downstream index.";
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: ORIGINAL, category: "bug", severity: "medium" }],
          2,
          100,
        ),
        ruleDigest: engineDigest,
      });

      let truthCalls = 0;
      let auditPrompt = "";
      globalThis.fetch = ((_url: string, init?: { body?: string }) => {
        const parsedBody = JSON.parse(init?.body ?? "{}") as {
          messages?: { content?: string }[];
        };
        const prompt = parsedBody.messages?.[0]?.content ?? "";
        let content: string;
        if (prompt.includes("Verify the truth of one AI-generated")) {
          truthCalls += 1;
          content = JSON.stringify({
            verdict: "needs_context",
            reason_code: "missing_definition",
            evidence_refs: ["H:1"],
            lookup_terms: ["missingDefinition"],
          });
        } else if (prompt.includes("Make the final truth decision")) {
          truthCalls += 1;
          content = JSON.stringify({
            verdict: "insufficient_evidence",
            reason_code: "missing_definition",
            evidence_refs: ["H:1"],
          });
        } else {
          if (prompt.includes("Audit the classification")) auditPrompt = prompt;
          content = JSON.stringify({ category: "bug", severity: "medium" });
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: "stop", message: { content } }],
              usage: { total_tokens: 10 },
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;
      const { client, created } = successfulClient([]);
      findAstAnchorOwnerAtHeadMock.mockResolvedValue(undefined);

      const report = await performReview(auditRequest(client), createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({ published: 0 });
      expect(truthCalls).toBe(2);
      expect(auditPrompt).toBe("");
      expect(created).toEqual([]);
    });

    it("re-verifies a cache-replayed finding without re-running its classification audit", async () => {
      const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
      const engineDigest = requireEngineDigest();
      const model = modelId(AUDIT_CONFIG.model);
      const proto = protocol(AUDIT_CONFIG.protocol);
      const base = blobId(baseBlobA);
      const head = blobId(headBlobA);
      const key = computeKey(base, head, ruleDigest, engineDigest, model, proto);
      const currentPathSet = computePathSetDigest(["src/a.ts", "src/b.ts"]);
      const BODY = withChallengeProbe(
        "This cached finding is regenerated never, but its truth is checked again.",
      );
      const baseB = blobId(git(["rev-parse", `${baseSha}:src/b.ts`]).trim());
      const headB = blobId(git(["rev-parse", `${headSha}:src/b.ts`]).trim());
      const keyB = computeKey(baseB, headB, ruleDigest, engineDigest, model, proto);
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
            semantics: PUBLICATION_SEMANTICS,
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
          {
            key: keyB,
            baseBlob: baseB,
            headBlob: headB,
            ruleDigest,
            engineDigest,
            prPathSetDigest: currentPathSet,
            semantics: PUBLICATION_SEMANTICS,
            modelId: model,
            protocol: proto,
            findings: [],
          },
        ],
      };

      acquireEngineMock.mockRejectedValue(new Error("a fully memoized run must not acquire"));

      const { impl, callCount } = classifyFetchMock({});
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(auditRequest(client, store), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(report.cacheHits).toBe(2);
      expect(acquireEngineMock).not.toHaveBeenCalled();
      expect(runEngineMock).not.toHaveBeenCalled();
      // The replayed finding still goes through sanitization and dedup and publishes normally...
      expect(report.publish).toMatchObject({ published: 1, suppressed: 0 });
      expect(created).toHaveLength(1);
      // Truth, contract planning, and falsification all run again. Classification does not: the
      // stored finding already carries the audited category/severity from the generation run.
      expect(callCount()).toBe(3);
      expect(
        diagnostics.drain().find((record) => record.code === "classify.audited"),
      ).toBeUndefined();
    });

    it("refutes and evicts a replayed finding, so the next run regenerates that path", async () => {
      const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
      const engineDigest = requireEngineDigest();
      const model = modelId(AUDIT_CONFIG.model);
      const proto = protocol(AUDIT_CONFIG.protocol);
      const base = blobId(baseBlobA);
      const head = blobId(headBlobA);
      const key = computeKey(base, head, ruleDigest, engineDigest, model, proto);
      const BODY = "This cached claim ignores an external guard that now rejects the input.";
      const baseB = blobId(git(["rev-parse", `${baseSha}:src/b.ts`]).trim());
      const headB = blobId(git(["rev-parse", `${headSha}:src/b.ts`]).trim());
      const keyB = computeKey(baseB, headB, ruleDigest, engineDigest, model, proto);
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
            semantics: PUBLICATION_SEMANTICS,
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
          {
            key: keyB,
            baseBlob: baseB,
            headBlob: headB,
            ruleDigest,
            engineDigest,
            prPathSetDigest: currentPathSet,
            semantics: PUBLICATION_SEMANTICS,
            modelId: model,
            protocol: proto,
            findings: [],
          },
        ],
      };

      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValueOnce({
        stdout: findingsStdout([], 1, 50),
        ruleDigest: engineDigest,
      });
      const { impl, callCount } = classifyFetchMock({ judgeVerdict: "unsupported" });
      globalThis.fetch = impl;

      const first = await performReview(
        auditRequest(successfulClient([]).client, store),
        createSilentDiagnostics(),
      );

      expect(first.outcome).toBe("complete");
      expect(first.cacheHits).toBe(2);
      expect(acquireEngineMock).not.toHaveBeenCalled();
      expect(runEngineMock).not.toHaveBeenCalled();
      expect(first.publish).toMatchObject({ published: 0 });
      expect(callCount()).toBe(2);
      expect(first.updatedCacheStore?.entries.some((entry) => entry.key === key)).toBe(false);
      if (first.updatedCacheStore === undefined)
        throw new Error("expected cache eviction write-back");

      const second = await performReview(
        auditRequest(successfulClient([]).client, first.updatedCacheStore),
        createSilentDiagnostics(),
      );

      expect(second.outcome).toBe("complete");
      expect(second.cacheHits).toBe(1);
      expect(second.cacheMisses).toBe(1);
      expect(runEngineMock).toHaveBeenCalledTimes(1);
      const secondInvocation = runEngineMock.mock.calls[0]?.[0] as {
        mechanicallyCleanPaths: string[];
      };
      expect(secondInvocation.mechanicallyCleanPaths).toContain("src/b.ts");
      expect(secondInvocation.mechanicallyCleanPaths).not.toContain("src/a.ts");
      // The stale prose never reappears from the store; the second run has no model claim to verify.
      expect(callCount()).toBe(2);
    });

    it("evicts a ranked-out cache hit and keeps a path with a ranked-out fresh finding uncached", async () => {
      const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
      const engineDigest = requireEngineDigest();
      const model = modelId(AUDIT_CONFIG.model);
      const proto = protocol(AUDIT_CONFIG.protocol);
      const base = blobId(baseBlobA);
      const head = blobId(headBlobA);
      const key = computeKey(base, head, ruleDigest, engineDigest, model, proto);
      const currentPathSet = computePathSetDigest(["src/a.ts", "src/b.ts"]);
      const CACHED_BODY = withChallengeProbe(
        "`cachedLease` skips its expiry check, so stale holders retain the resource.",
      );
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
            semantics: PUBLICATION_SEMANTICS,
            modelId: model,
            protocol: proto,
            findings: [
              {
                path: repoPath("src/a.ts"),
                content: CACHED_BODY,
                startLine: 1,
                endLine: 1,
                severity: "low",
                category: "bug",
              },
            ],
          },
        ],
      };
      const freshBodies = [
        "`alphaCursor` ignores its boundary, so pagination repeats the final invoice forever.",
        "`bravoNonce` reuses the seed, so encrypted sessions receive identical keystreams.",
        "`charlieQuota` omits tenant ownership, so one account consumes another account's limit.",
        "`deltaLatch` misses the release branch, so shutdown waits indefinitely for the worker.",
        "`echoLedger` rounds before aggregation, so monthly balances lose fractional payments.",
        "`foxtrotParser` accepts the empty header, so malformed packets reach the dispatcher.",
        "`golfSnapshot` stores the mutable reference, so later edits corrupt the saved revision.",
        "`hotelRouter` drops the locale prefix, so translated links resolve to missing pages.",
        "`indiaWriter` acknowledges before flushing, so a crash loses confirmed audit records.",
      ].map((content) => withChallengeProbe(content));

      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      // src/a.ts is the nonfresh cache hit. The engine reviews only src/b.ts and emits nine fresh,
      // independently worded findings so the intra-run deduplicator correctly leaves all nine for
      // the PR-wide selector.
      const rankedStdout = (filesReviewed: number): string =>
        findingsStdout(
          freshBodies.map((content) => ({
            path: "src/b.ts",
            content,
            category: "bug",
            severity: "medium",
          })),
          filesReviewed,
          100,
        );
      runEngineMock
        .mockResolvedValueOnce({ stdout: rankedStdout(1), ruleDigest: engineDigest })
        .mockResolvedValueOnce({ stdout: rankedStdout(2), ruleDigest: engineDigest });

      const { impl } = classifyFetchMock({
        auditPair: { category: "bug", severity: "medium" },
      });
      globalThis.fetch = impl;
      const firstClient = successfulClient([]);

      const first = await performReview(
        auditRequest(firstClient.client, store),
        createSilentDiagnostics(),
      );

      expect(first.outcome).toBe("complete");
      expect(first.publish).toMatchObject({
        published: 8,
        suppressed: 2,
        suppressedRanked: 2,
      });
      // Cached and fresh model claims share the same eight-slot cohort. The lower-severity cached
      // claim loses the rank decision and is removed from the store, not touched back into it.
      expect(firstClient.created.filter((comment) => comment.path === "src/a.ts")).toHaveLength(0);
      expect(firstClient.created.filter((comment) => comment.path === "src/b.ts")).toHaveLength(8);

      const headBlobB = git(["rev-parse", `${headSha}:src/b.ts`]).trim();
      const bEntry = first.updatedCacheStore?.entries.find(
        (entry) => String(entry.headBlob) === headBlobB,
      );
      // A partial eight-of-nine entry would turn a PR-global rank decision into a durable per-file
      // verdict. Both unsafe paths are absent: b is not admitted and a's stale hit is evicted.
      expect(bEntry).toBeUndefined();
      expect(first.updatedCacheStore?.entries).toHaveLength(0);

      const callsAfterFirst = runEngineMock.mock.calls.length;
      const secondClient = successfulClient([]);
      const second = await performReview(
        auditRequest(secondClient.client, first.updatedCacheStore),
        createSilentDiagnostics(),
      );

      expect(callsAfterFirst).toBe(1);
      expect(runEngineMock).toHaveBeenCalledTimes(2);
      expect(second.cacheHits).toBe(0);
      expect(second.cacheMisses).toBe(2);
      const secondInvocation = runEngineMock.mock.calls[1]?.[0] as {
        mechanicallyCleanPaths: string[];
      };
      expect(secondInvocation.mechanicallyCleanPaths).not.toContain("src/a.ts");
      expect(secondInvocation.mechanicallyCleanPaths).not.toContain("src/b.ts");
      expect(
        second.updatedCacheStore?.entries.some((entry) => String(entry.headBlob) === headBlobB),
      ).toBe(false);
    });

    it("withholds an unverified finding without making a fully covered review incomplete or caching its path", async () => {
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
      // The mocked engine overshoots into the quality reserve, leaving only 1k. That cannot fund
      // even the verifier's bounded first request, so the candidate must be withheld rather than
      // published under its unchecked engine classification.
      const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
      const request = {
        ...auditRequest(client, empty),
        config: { ...AUDIT_CONFIG, tokenBudget: 50_000 },
      };

      const diagnostics = createSilentDiagnostics();
      const report = await performReview(request, diagnostics);

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({
        published: 0,
        suppressedEvidence: 1,
        verificationUndecided: 1,
      });
      // The undecided hypothesis never reaches a reader and does not produce a false incomplete
      // notice for a review that covered both files.
      expect(created.some((comment) => comment.body.includes(BODY))).toBe(false);
      // src/a.ts remains retryable because its sole model verdict was undecided. The independently
      // reviewed clean path is still admitted, so the next run does not repay the entire review.
      expect(report.cacheAppended).toBe(1);
      const headBlobB = git(["rev-parse", `${headSha}:src/b.ts`]).trim();
      const cachedBlobs = (report.updatedCacheStore?.entries ?? []).map((entry) =>
        String(entry.headBlob),
      );
      expect(cachedBlobs).not.toContain(headBlobA);
      expect(cachedBlobs).toContain(headBlobB);
      expect(callCount()).toBe(0);

      const records = diagnostics.drain();
      expect(records.some((record) => record.code === "settlement.complete")).toBe(true);
      expect(
        records.some((record) => record.code === "settlement.incomplete.publication_degraded"),
      ).toBe(false);
      expect(records.find((r) => r.code === "classify.audited")).toBeUndefined();
      const substantiated = records.find((r) => r.code === "publish.substantiated");
      expect(substantiated?.counts).toMatchObject({
        challenge_planned: 0,
        challenge_retrieval_performed: 0,
        challenge_expanded: 0,
        challenge_no_matches: 0,
        challenge_failed: 0,
        undecided: 1,
        budget_blocked: 1,
      });
    });

    it("records a closed verifier stage and reason while the covered review stays complete", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY = withChallengeProbe(
        "When the compiler lookup fails, this call passes an invalid command to spawn.",
      );
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: BODY, category: "bug", severity: "high" }],
          2,
          100,
        ),
        ruleDigest: engineDigest,
      });
      const { impl, callCount } = classifyFetchMock({ refereeEvidenceRef: "R4:H:999" });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);
      const diagnostics = createSilentDiagnostics();

      const report = await performReview(auditRequest(client), diagnostics);

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({
        published: 0,
        suppressedEvidence: 1,
        verificationUndecided: 1,
      });
      expect(created.some((comment) => comment.body.includes(BODY))).toBe(false);
      expect(callCount()).toBe(3);
      const substantiated = diagnostics
        .drain()
        .find((record) => record.code === "publish.substantiated");
      expect(substantiated?.counts).toMatchObject({
        undecided: 1,
        undecided_stage_falsifier: 1,
        undecided_reason_shape: 1,
      });
    });

    it("releases unused atomic-admission headroom for the later classification audit", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY = withChallengeProbe(
        "When the cache is empty, this fallback returns stale state instead of loading a value.",
      );
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: BODY, category: "bug", severity: "medium" }],
          2,
          100,
        ),
        ruleDigest: engineDigest,
      });

      const { impl, callCount } = classifyFetchMock({
        auditPair: { category: "security", severity: "critical" },
        tokensPerCall: 10,
      });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);
      // Reserve exactly one maximum substantiation path after the engine. Admission is a check,
      // not spend: the three actual 10-token role calls leave their unused headroom to the audit.
      const request = {
        ...auditRequest(client),
        config: {
          ...AUDIT_CONFIG,
          tokenBudget: MAX_SUBSTANTIATION_TOKENS_PER_FINDING + 100,
        },
      };
      const diagnostics = createSilentDiagnostics();

      const report = await performReview(request, diagnostics);

      expect(report.outcome).toBe("complete");
      expect(created).toHaveLength(1);
      expect(created[0]?.body).toContain('/cat-security.svg" height="24" alt="Security">');
      expect(created[0]?.body).toContain('/sev-critical.svg" height="24" alt="Critical">');
      expect(callCount()).toBe(5);

      const records = diagnostics.drain();
      const audited = records.find((record) => record.code === "classify.audited");
      expect(audited?.counts).toStrictEqual({ changed: 1, tokens: 20 });
      const spend = records.find((record) => record.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 50, total: 150 });
      expect((spend?.counts?.total ?? 0) <= request.config.tokenBudget).toBe(true);
    });

    it("withholds a repair-budget-blocked finding when evidence cannot fit either", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY =
        "When the cache is empty, this fallback returns stale state instead of loading a value.";
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout([{ path: "src/a.ts", content: BODY }], 2, 3_000),
        ruleDigest: engineDigest,
      });

      const { impl, callCount } = classifyFetchMock({
        repairPair: { category: "security", severity: "critical" },
        tokensPerCall: 10,
      });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([]);
      const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
      const request = {
        ...auditRequest(client, empty),
        config: { ...AUDIT_CONFIG, tokenBudget: 8_000 },
      };
      const diagnostics = createSilentDiagnostics();

      const report = await performReview(request, diagnostics);

      // Neither classification repair nor the larger evidence request fits. The pipeline invents
      // no classification and publishes no unverified claim, while the fully covered review stays
      // complete and reports the withheld candidate in its quality telemetry.
      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({
        published: 0,
        suppressedEvidence: 1,
        verificationUndecided: 1,
      });
      expect(created.some((comment) => comment.body.includes(BODY))).toBe(false);
      expect(report.cacheAppended).toBe(1);
      const headBlobB = git(["rev-parse", `${headSha}:src/b.ts`]).trim();
      const cachedBlobs = (report.updatedCacheStore?.entries ?? []).map((entry) =>
        String(entry.headBlob),
      );
      expect(cachedBlobs).not.toContain(headBlobA);
      expect(cachedBlobs).toContain(headBlobB);
      expect(callCount()).toBe(0);

      const records = diagnostics.drain();
      const repaired = records.find((record) => record.code === "classify.repaired");
      expect(repaired?.counts).toStrictEqual({
        repaired: 0,
        failed: 1,
        budget_blocked: 1,
        tokens: 0,
      });
      const substantiated = records.find((record) => record.code === "publish.substantiated");
      expect(substantiated?.counts).toMatchObject({
        challenge_planned: 0,
        challenge_retrieval_performed: 0,
        challenge_expanded: 0,
        challenge_no_matches: 0,
        challenge_failed: 0,
        undecided: 1,
        budget_blocked: 1,
      });
      const spend = records.find((record) => record.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 3_000, classify: 0, total: 3_000 });
      expect((spend?.counts?.total ?? 0) <= request.config.tokenBudget).toBe(true);
    });

    it("still audits when the engine overshoots its allotment but the consumer ceiling has room", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY = withChallengeProbe(
        "This handler discards the parsed configuration and falls back to defaults silently.",
      );
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
      // The audit RAN: the published body carries the audit's reclassification ("SECURITY" is
      // "security"'s rendered design-system badge in `composeFindingBody`'s CATEGORIES table), not
      // the engine's original "bug".
      expect(callCount()).toBeGreaterThan(0);
      expect(created[0]?.body).toContain('/cat-security.svg" height="24" alt="Security">');
      expect(created[0]?.body).toContain('/sev-critical.svg" height="24" alt="Critical">');

      const records = diagnostics.drain();
      expect(records.find((r) => r.code === "classify.skipped_budget")).toBeUndefined();
      expect(records.find((r) => r.code === "classify.audited")).toBeDefined();
    });

    it("suppresses a reclassified survivor at the execute-time marker re-check, end to end through publishAudited", async () => {
      const engineDigest = currentPlatformDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY = withChallengeProbe(
        "This SQL string concatenates the caller-supplied filter directly into the WHERE clause.",
      );
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
      // Truth, planner, and falsifier precede the audit's two-vote majority.
      expect(callCount()).toBe(5);
    });

    it("stores the audited path but no entry for a plan-suppressed fresh path", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });

      const BODY_A = withChallengeProbe(
        "This function never releases the lock it acquires on the early-return branch.",
      );
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
      // 1 repair + Truth + planner + falsifier + 2 audit votes for src/a.ts. The marker-suppressed
      // src/b.ts never reaches any of those publication-time calls.
      expect(callCount()).toBe(6);

      const entries = report.updatedCacheStore?.entries ?? [];
      const headBlobB = git(["rev-parse", `${headSha}:src/b.ts`]).trim();
      const aEntry = entries.find((e) => String(e.headBlob) === headBlobA);
      const bEntry = entries.find((e) => String(e.headBlob) === headBlobB);
      // Published under its audited category — the reader saw "maintainability", so that is what
      // must be replayed on a future cache hit.
      expect(aEntry?.findings[0]?.category).toBe("maintainability");
      // Never audited because the existing marker suppressed it before the evidence gate. That is
      // not a publication-quality per-file verdict, so neither a raw finding nor an empty entry may
      // claim this path was verified under the current cache semantics.
      expect(bEntry).toBeUndefined();

      // run.spend: engine(100) + repair(1) + verifier(3) + audit(2), all at ten tokens/call.
      const spend = diagnostics.drain().find((r) => r.code === "run.spend");
      expect(spend?.counts).toStrictEqual({ engine: 100, classify: 60, total: 160 });
    });

    it("keeps engine and classify spend correct across the bounded resume when the resumed run also triggers the audit", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });

      const BODY = withChallengeProbe(
        "This cache key omits the tenant id, so two tenants can collide on one entry.",
      );
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
      // Truth + planner + falsifier + one agreeing fast-path audit vote.
      expect(callCount()).toBe(4);

      const spend = diagnostics.drain().find((r) => r.code === "run.spend");
      // 130 engine tokens plus three verifier roles and one audit vote at ten tokens each.
      expect(spend?.counts).toStrictEqual({ engine: 130, classify: 40, total: 170 });
    });

    it("publishes on gpt-oss when the judge cites visible full-file and symbol evidence", async () => {
      const contextBase = git(["rev-parse", "HEAD"]).trim();
      const contextLines = [
        "export const dispatchEnabled = true;",
        ...Array.from(
          { length: 78 },
          (_value, index) => `const filler${String(index + 2)} = ${String(index + 2)};`,
        ),
        "export function distantGuard(): boolean { return dispatchEnabled; }",
      ];
      await writeFile(join(repo, "src/context.ts"), `${contextLines.join("\n")}\n`);
      git(["add", "src/context.ts"]);
      git(["commit", "-q", "-m", "evidence-context", "--no-gpg-sign"]);
      const contextHead = git(["rev-parse", "HEAD"]).trim();

      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY = "When `dispatchEnabled` is false, `distantGuard` still lets the dispatcher run.";
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/context.ts", content: BODY, category: "bug", severity: "medium" }],
          1,
        ),
        ruleDigest: engineDigest,
      });

      let judgePrompt = "";
      const { impl } = classifyFetchMock({
        auditPair: { category: "bug", severity: "medium" },
        judgeEvidenceRef: "H:1",
        judgeChangeRef: "D:H:1",
        judgeAdditionalRefs: ["H:80"],
        onJudgePrompt: (prompt) => {
          judgePrompt = prompt;
        },
      });
      globalThis.fetch = impl;
      const { client, created } = successfulClient([], contextHead);
      const request = {
        ...auditRequest(client),
        base: commitSha(contextBase),
        head: commitSha(contextHead),
        config: { ...AUDIT_CONFIG, model: "gpt-oss-120b" },
      };

      const report = await performReview(request, createSilentDiagnostics());

      expect(report.outcome).toBe("complete");
      expect(report.publish).toMatchObject({ published: 1, suppressed: 0 });
      expect(created.some((comment) => comment.body.includes(BODY))).toBe(true);
      // This small file travels whole: the anchor, an unrelated middle line, and the distant cited
      // symbol are all visible. Line 80 is therefore a real evidence citation, not model metadata.
      expect(judgePrompt).toContain("1| export const dispatchEnabled = true;");
      expect(judgePrompt).toContain("40| const filler40 = 40;");
      expect(judgePrompt).toContain(
        "80| export function distantGuard(): boolean { return dispatchEnabled; }",
      );
    });

    it("withholds invented or transport-undecidable evidence and retries only the affected path", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY =
        "When `a` is negative, the assignment accepts it and corrupts the downstream index.";
      runEngineMock.mockResolvedValue({
        stdout: findingsStdout(
          [{ path: "src/a.ts", content: BODY, category: "bug", severity: "medium" }],
          2,
        ),
        ruleDigest: engineDigest,
      });

      for (const failure of ["invented-line", "transport"] as const) {
        const { impl } = classifyFetchMock({
          auditPair: { category: "bug", severity: "medium" },
          ...(failure === "invented-line"
            ? { judgeEvidenceRef: "H:999" }
            : { judgeTransportFailure: true }),
        });
        globalThis.fetch = impl;
        const { client, created } = successfulClient([]);
        const empty: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
        const diagnostics = createSilentDiagnostics();

        const report = await performReview(
          {
            ...auditRequest(client, empty),
            config: { ...AUDIT_CONFIG, model: "gpt-oss-120b" },
          },
          diagnostics,
        );

        expect(report.outcome, failure).toBe("complete");
        expect(report.publish, failure).toMatchObject({
          published: 0,
          suppressed: 1,
          suppressedEvidence: 1,
          verificationUndecided: 1,
        });
        // The verifier never admitted the hypothesis, so neither a finding nor an incomplete
        // notice is published for the otherwise fully covered review.
        expect(
          created.some((comment) => comment.body.includes(BODY)),
          failure,
        ).toBe(false);
        expect(report.cacheAppended, failure).toBe(1);
        const headBlobB = git(["rev-parse", `${headSha}:src/b.ts`]).trim();
        const cachedBlobs = (report.updatedCacheStore?.entries ?? []).map((entry) =>
          String(entry.headBlob),
        );
        expect(cachedBlobs, failure).not.toContain(headBlobA);
        expect(cachedBlobs, failure).toContain(headBlobB);
        const substantiated = diagnostics
          .drain()
          .find((record) => record.code === "publish.substantiated");
        expect(substantiated?.counts, failure).toMatchObject({
          challenge_planned: 0,
          challenge_retrieval_performed: 0,
          challenge_expanded: 0,
          challenge_no_matches: 0,
          challenge_failed: 0,
          undecided: 1,
        });
      }
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

    it("reserves proportional headroom for all four mandatory verification calls", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const request = baseRequest(undefined);
      const report = await performReview(
        {
          ...request,
          config: { ...request.config, tokenBudget: 1_500_000 },
        },
        createSilentDiagnostics(),
      );

      expect(report.outcome).toBe("complete");
      expect((runEngineMock.mock.calls[0]?.[0] as { allottedBudget: number }).allottedBudget).toBe(
        92_000,
      );
    });

    it("floors a single candidate at one atomic path without multiplying it by all slots", async () => {
      const engineDigest = requireEngineDigest();
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      runEngineMock.mockResolvedValue({ stdout: engineStdout(2), ruleDigest: engineDigest });

      const request = baseRequest(undefined);
      const report = await performReview(
        {
          ...request,
          config: {
            ...request.config,
            maxFindings: 1,
            tokenBudget: MAX_SUBSTANTIATION_TOKENS_PER_FINDING + 2_000 + 92_000,
          },
        },
        createSilentDiagnostics(),
      );

      expect(report.outcome).toBe("complete");
      expect((runEngineMock.mock.calls[0]?.[0] as { allottedBudget: number }).allottedBudget).toBe(
        92_000,
      );
    });

    it("prices a smaller allotment when a cache hit removes a file from dispatch", async () => {
      const engineDigest = requireEngineDigest();
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
            semantics: PUBLICATION_SEMANTICS,
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
      const engineDigest = requireEngineDigest();

      const renameRepo = await mkdtemp(join(tmpdir(), "kfq-review-rename-"));
      try {
        // The block-level `git` helper bound to this test's own throwaway repository — same
        // environment, same argument handling, one definition. Keeping the `renameGit` name means
        // every call below reads exactly as it did when this was a second copy of that helper.
        const renameGit = (args: readonly string[]): string => git(args, renameRepo);
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
            identityExclusive: true,
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
