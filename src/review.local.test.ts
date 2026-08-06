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
import { blobId, commitSha, type Sha256 } from "./core/brands.js";
import { createSilentDiagnostics } from "./diagnostics/sink.js";
import { currentPlatformDigest, ENGINE_PIN } from "./engine/pinned-release.js";
import { promptIdentityDigest } from "./engine/rule-identity.js";
import type { LocalReviewRequest } from "./review.js";

// Same mocking pattern `review.test.ts` uses: both modules make real network/process calls the
// rest of this suite must avoid, so only the engine binary acquisition and invocation are faked —
// everything else (buildInventory, the review-cache lookup, settle, planPublication, the audit) is
// the real production code, exercised end to end against a real git repository below.
const acquireEngineMock = vi.fn();
vi.mock("./engine/acquire.js", () => ({ acquireEngine: acquireEngineMock }));

const runEngineMock = vi.fn();
vi.mock("./engine/run.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runEngine: runEngineMock,
}));

const { performLocalReview } = await import("./review.js");
// Imported dynamically for the same hoisting reason as `performLocalReview` above: a static
// import of `./engine/run.js` would evaluate the `vi.mock` factory before `runEngineMock`
// exists. The class itself is the original — the factory spreads `importOriginal` and replaces
// only `runEngine` — so `instanceof` in production code matches what these tests construct.
const { EngineRunError } = await import("./engine/run.js");

/**
 * The pin covers this platform or the store-backed block below cannot run here — never a silent
 * skip, for the same reason `review.test.ts`'s own `requireEngineDigest` exists: a cache key is
 * built from `currentPlatformDigest()`, which is `undefined` on any platform `ENGINE_PIN.platforms`
 * does not name, and returning early there would report a test that asserted nothing as a pass.
 */
function requireEngineDigest(): Sha256 {
  const digest = currentPlatformDigest();
  if (digest === undefined) {
    throw new Error("review.local.test.ts needs a pinned engine digest for this platform");
  }
  return digest;
}

describe("performLocalReview (issue #95)", () => {
  let repo: string;
  let baseSha: string;
  let headSha: string;

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
    repo = await mkdtemp(join(tmpdir(), "kfq-review-local-"));
    git(["init", "-q", "-b", "main"]);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/a.ts"), "export const a = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
    baseSha = git(["rev-parse", "HEAD"]).trim();

    await writeFile(join(repo, "src/a.ts"), "export const a = 2;\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "head", "--no-gpg-sign"]);
    headSha = git(["rev-parse", "HEAD"]).trim();
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  beforeEach(() => {
    acquireEngineMock.mockReset();
    runEngineMock.mockReset();
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

  /**
   * Deliberately builds a request with NO `cacheStore` key at all — not `cacheStore: undefined` —
   * matching how `exactOptionalPropertyTypes` distinguishes "absent" from "present but undefined".
   * Every test in THIS describe block uses it, which is itself the "works with cacheStore
   * undefined" proof the epic's acceptance criteria call for: nothing here special-cases the
   * field's absence. Its store-supplied counterpart is the sibling block at the bottom of this
   * file ("performLocalReview: review-cache memoization end to end"), which builds its own request
   * against its own fixture repository — the two together are what pin both sides of the field.
   */
  function baseRequest(overrides: Partial<LocalReviewRequest> = {}): LocalReviewRequest {
    return {
      base: commitSha(baseSha),
      head: commitSha(headSha),
      repositoryPath: repo,
      config: CONFIG,
      profile: PROFILE,
      guidelines: { paths: [] },
      env: {},
      pathValue: process.env.PATH ?? "/usr/bin:/bin",
      ...overrides,
    };
  }

  /** Counted-mode engine output: no `manifest` key, matching `review.test.ts`'s own fixtures. */
  function engineStdout(filesReviewed: number, totalTokens = 100): string {
    return JSON.stringify({
      status: "success",
      summary: { files_reviewed: filesReviewed, total_tokens: totalTokens, budget_exceeded: false },
      comments: [],
    });
  }

  it("completes on a fixture repository with spend, inventory, ruleDigest, and engineVersion populated", async () => {
    const engineDigest = "a".repeat(64);
    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    runEngineMock.mockResolvedValue({ stdout: engineStdout(1, 100), ruleDigest: engineDigest });

    const diagnostics = createSilentDiagnostics();
    const report = await performLocalReview(baseRequest(), diagnostics);

    expect(report.outcome).toBe("complete");
    expect(report.findings).toEqual([]);

    // Spend: the engine's own reported total, no classify spend on the anthropic protocol path,
    // and a real (non-zero) allotment computed the same way `performReview`'s does.
    expect(report.spend.engine).toBe(100);
    expect(report.spend.classify).toBe(0);
    expect(report.spend.total).toBe(100);
    expect(report.spend.allotted).toBeGreaterThanOrEqual(80_000);

    // Inventory: one reviewable file, fully reviewed.
    expect(report.inventory).toStrictEqual({ total: 1, reviewable: 1, reviewed: 1 });

    // Digests: computable without ever acquiring or running the engine — both identify what THIS
    // run reviewed under, not what it happened to execute.
    expect(report.ruleDigest).toBe(promptIdentityDigest(PROFILE, { paths: [] }));
    expect(report.engineVersion).toBe(ENGINE_PIN.version);

    // The run.spend diagnostic mirrors performReview's own, unconditional lifecycle diagnostics.
    const codes = diagnostics.drain().map((record) => record.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "run.started",
        "review_pair.resolved",
        "settlement.mode.counted",
        "settlement.complete",
        "run.spend",
      ]),
    );
  });

  describe("audit reclassification", () => {
    const AUDIT_CONFIG: RuntimeConfig = { ...CONFIG, protocol: "openai", model: "gpt-oss-test" };
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** Answers every classify call (repair or audit) with the same pair — sufficient here because
     *  the engine already emits a valid category/severity, so only the audit ever calls out. */
    function auditFetchMock(pair: { category: string; severity: string }): typeof fetch {
      return (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(pair) } }],
              usage: { total_tokens: 25 },
            }),
            { status: 200 },
          ),
        )) as typeof fetch;
    }

    it("reports a finding under the audit's reclassification, not the engine's original", async () => {
      const engineDigest = "b".repeat(64);
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const BODY =
        "This retry loop never resets its attempt counter, so it spins forever after one failure.";
      const withFinding = JSON.stringify({
        status: "success",
        summary: { files_reviewed: 1, total_tokens: 100, budget_exceeded: false },
        comments: [
          {
            path: "src/a.ts",
            content: BODY,
            start_line: 1,
            end_line: 1,
            category: "bug",
            severity: "medium",
          },
        ],
      });
      runEngineMock.mockResolvedValue({ stdout: withFinding, ruleDigest: engineDigest });

      // Vote 1 disagrees with the finding's own "bug"/"medium", escalating to a second vote that
      // agrees with it — majority reached at "security"/"critical", a genuine reclassification.
      globalThis.fetch = auditFetchMock({ category: "security", severity: "critical" });

      const diagnostics = createSilentDiagnostics();
      const report = await performLocalReview(
        baseRequest({ config: AUDIT_CONFIG, env: { MODEL_TOKEN: "fake-token" } }),
        diagnostics,
      );

      expect(report.outcome).toBe("complete");
      expect(report.findings).toHaveLength(1);
      const [finding] = report.findings;
      expect(finding).toMatchObject({
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        category: "security",
        severity: "critical",
      });
      expect(finding?.body).toContain("retry loop");

      expect(diagnostics.drain().some((r) => r.code === "classify.audited")).toBe(true);
      // Engine spend plus the audit's own two votes at 25 tokens each.
      expect(report.spend.classify).toBeGreaterThan(0);
      expect(report.spend.total).toBe(report.spend.engine + report.spend.classify);
    });
  });

  it("reports incomplete honestly when the engine cannot be acquired, with the action path's own reason code", async () => {
    acquireEngineMock.mockRejectedValue(new Error("engine acquisition failed"));

    const diagnostics = createSilentDiagnostics();
    const report = await performLocalReview(baseRequest(), diagnostics);

    expect(report.outcome).toBe("incomplete");
    // The same reason `settleOrReport`'s catch branch gives `performReview` for an engine that
    // never produced a result at all — see `review.ts`.
    expect(report.reason).toBe("settlement.incomplete.engine_error");
    expect(report.findings).toEqual([]);
    // Nothing was spent: acquisition failed before any token could be billed.
    expect(report.spend).toStrictEqual({ engine: 0, classify: 0, total: 0, allotted: 0 });
    expect(report.inventory).toStrictEqual({ total: 1, reviewable: 1, reviewed: 0 });
    // Digests are computed unconditionally, before the engine is ever touched — populated even on
    // total failure.
    expect(report.ruleDigest).toBe(promptIdentityDigest(PROFILE, { paths: [] }));
    expect(report.engineVersion).toBe(ENGINE_PIN.version);

    const codes = diagnostics.drain().map((record) => record.code);
    expect(codes).toContain("settlement.incomplete.engine_error");
    // A failed acquisition never spent anything, so the `run.spend` guard both `performReview` and
    // `performLocalReview` share must not fire a zero-spend line.
    expect(codes).not.toContain("run.spend");
  });

  it("carries the wire-counted spend of failed engine invocations in an incomplete report", async () => {
    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: "a".repeat(64) });
    // Both invocations fail: the first attempt's error is absorbed (the resume IS the recovery)
    // and books its wire count where it is caught; the resume's own error propagates and books in
    // `executeEngine`'s catch. Distinct amounts prove BOTH sites fire exactly once each — the
    // 2026-08-06 observation this pins was a report saying `spend 0` while `model.usage` had
    // counted thousands of real, billable tokens for the same run.
    runEngineMock
      .mockRejectedValueOnce(new EngineRunError("engine.run.nonzero_exit", 15_841))
      .mockRejectedValueOnce(new EngineRunError("engine.run.timeout", 4_023));

    const diagnostics = createSilentDiagnostics();
    const report = await performLocalReview(baseRequest(), diagnostics);

    expect(report.outcome).toBe("incomplete");
    expect(report.reason).toBe("settlement.incomplete.engine_error");
    expect(report.spend.engine).toBe(15_841 + 4_023);
    expect(report.spend.total).toBe(15_841 + 4_023);

    const codes = diagnostics.drain().map((record) => record.code);
    // A run that measurably spent must say so: the shared `run.spend` guard now fires for it.
    expect(codes).toContain("run.spend");
  });

  it("keeps an unmeasured engine failure at spend 0 — absent wire counts never fake a number", async () => {
    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: "a".repeat(64) });
    // No wireTokens on either error — the anthropic path, where no proxy counts. "Unmeasured"
    // must stay distinguishable from "measured at N": the ledger books nothing, and the
    // zero-spend guard keeps `run.spend` silent exactly as it does for a failed acquisition.
    runEngineMock.mockRejectedValue(new EngineRunError("engine.run.nonzero_exit"));

    const diagnostics = createSilentDiagnostics();
    const report = await performLocalReview(baseRequest(), diagnostics);

    expect(report.outcome).toBe("incomplete");
    expect(report.reason).toBe("settlement.incomplete.engine_error");
    expect(report.spend.engine).toBe(0);
    expect(diagnostics.drain().some((record) => record.code === "run.spend")).toBe(false);
  });

  describe("no GitHub API interaction", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("never calls any GitHub URL, even while genuinely reaching the classify endpoint", async () => {
      const calledUrls: string[] = [];
      globalThis.fetch = ((url: string | URL) => {
        calledUrls.push(String(url));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"category":"bug","severity":"medium"}' } }],
              usage: { total_tokens: 5 },
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch;

      const engineDigest = "c".repeat(64);
      acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
      const unclassified = JSON.stringify({
        status: "success",
        summary: { files_reviewed: 1, total_tokens: 100, budget_exceeded: false },
        comments: [
          {
            path: "src/a.ts",
            content: "This branch never checks the return value before dereferencing it.",
            start_line: 1,
            end_line: 1,
          },
        ],
      });
      runEngineMock.mockResolvedValue({ stdout: unclassified, ruleDigest: engineDigest });

      const diagnostics = createSilentDiagnostics();
      const report = await performLocalReview(
        baseRequest({
          config: { ...CONFIG, protocol: "openai", model: "gpt-oss-test" },
          env: { MODEL_TOKEN: "fake-token" },
        }),
        diagnostics,
      );

      expect(report.outcome).toBe("complete");
      // Proof the spy actually observed real traffic — a suite that never called `fetch` at all
      // would trivially "pass" the assertion below for the wrong reason.
      expect(calledUrls.length).toBeGreaterThan(0);
      for (const url of calledUrls) {
        expect(url).not.toContain("github.com");
      }
    });
  });

  it("works with cacheStore left undefined and a complete outcome carries no cache-store bookkeeping", async () => {
    const engineDigest = "d".repeat(64);
    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    runEngineMock.mockResolvedValue({ stdout: engineStdout(1, 42), ruleDigest: engineDigest });

    const request = baseRequest();
    expect("cacheStore" in request).toBe(false);

    const diagnostics = createSilentDiagnostics();
    const report = await performLocalReview(request, diagnostics);

    expect(report.outcome).toBe("complete");
    expect(report.spend.engine).toBe(42);
    // Cache counts are required facts (0/0 without a store); `updatedCacheStore` stays absent —
    // the write-back exists only when a store was supplied (`finalizeCacheStore`'s first check).
    expect(report.cacheHits).toBe(0);
    expect(report.cacheMisses).toBe(0);
    expect("updatedCacheStore" in report).toBe(false);
    expect(Object.keys(report).sort()).toStrictEqual(
      [
        "cacheHits",
        "cacheMisses",
        "engineVersion",
        "findings",
        "inventory",
        "outcome",
        "ruleDigest",
        "spend",
      ].sort(),
    );
  });
});

/**
 * `--store` end to end on the LOCAL path (README's "Local runs": the mitigation for repeated runs
 * over unchanged content).
 *
 * The block above proves `performLocalReview` behaves when no store is supplied. Nothing proved it
 * behaves when one IS: `baseRequest` never sets `cacheStore`, so `prepareMemoization` short-circuits
 * to `INERT_MEMO` before computing a single digest, and every cache assertion in that block is taken
 * under that inert branch — they would all stay green if the local pipeline's memo wiring were
 * replaced by `INERT_MEMO` wholesale. The CLI half is no help either: `cli.test.ts` stubs
 * `runLocalReview` outright, and `corpus/real-diffs.mjs` says in its own comment that it has never
 * had a `--store` flag. So a shipped, documented surface was pinned by nothing that could fail.
 *
 * A deliberate sibling of `describe("performLocalReview (issue #95)")` rather than another test
 * inside it: this needs a two-file fixture, and adding a second file to that block's shared
 * repository would rewrite four passing assertions (`inventory.total === 1` twice, and the
 * `files_reviewed` counts) to add one — churn for tests that are already correct about the
 * single-file case they were written for. Its own `mkdtemp` repository costs one more `git init`
 * and changes nothing that already passes.
 *
 * What it pins is the thing a mock cannot fake: the hit reaches the REAL `runEngine` call as an
 * exclusion, not merely the settlement arithmetic `settle.test.ts` covers in isolation — the same
 * claim `review.test.ts`'s first memoization test makes for the action path, now made for the path
 * `npm run review -- --store` actually takes.
 */
describe("performLocalReview: review-cache memoization end to end", () => {
  let repo: string;
  let baseSha: string;
  let headSha: string;
  let baseBlobA: string;
  let headBlobA: string;

  /** Same test-side git environment the block above uses, bound to this block's own repository. */
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
    repo = await mkdtemp(join(tmpdir(), "kfq-review-local-store-"));
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

  beforeEach(() => {
    // This test reads `mock.calls[0]`, so it starts from a clean call history rather than inheriting
    // whatever the block above left on these module-level mocks.
    acquireEngineMock.mockReset();
    runEngineMock.mockReset();
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

  it("threads a cache hit into the engine's own exclude list and writes the miss back to the store", async () => {
    // Unlike the block above, which uses an arbitrary fake digest as an opaque mock value, this key
    // has to match what `prepareMemoization` computes for itself — and it computes the ENGINE
    // digest from the pin, not from the acquisition mock.
    const engineDigest = requireEngineDigest();
    const ruleDigest = promptIdentityDigest(PROFILE, { paths: [] });
    const model = modelId(CONFIG.model);
    const proto = protocol(CONFIG.protocol);
    const base = blobId(baseBlobA);
    const head = blobId(headBlobA);
    const key = computeKey(base, head, ruleDigest, engineDigest, model, proto);
    // Both files are ordinary edits in this fixture's base..head diff and neither is a rename, so
    // the token list is exactly their bare paths — what `computePrPathSetDigest` derives internally
    // from the real inventory this run builds.
    const store: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [
        {
          key,
          baseBlob: base,
          headBlob: head,
          ruleDigest,
          engineDigest,
          prPathSetDigest: computePathSetDigest(["src/a.ts", "src/b.ts"]),
          semantics: PUBLICATION_SEMANTICS,
          modelId: model,
          protocol: proto,
          findings: [],
        },
      ],
    };

    acquireEngineMock.mockResolvedValue({ binaryPath: "/fake/engine", digest: engineDigest });
    // Counted mode, one file reviewed: two reviewable paths minus the one the store answered.
    runEngineMock.mockResolvedValue({
      stdout: JSON.stringify({
        status: "success",
        summary: { files_reviewed: 1, total_tokens: 100, budget_exceeded: false },
        comments: [],
      }),
      ruleDigest: engineDigest,
    });

    const report = await performLocalReview(
      {
        base: commitSha(baseSha),
        head: commitSha(headSha),
        repositoryPath: repo,
        config: CONFIG,
        profile: PROFILE,
        guidelines: { paths: [] },
        env: {},
        pathValue: process.env.PATH ?? "/usr/bin:/bin",
        cacheStore: store,
      },
      createSilentDiagnostics(),
    );

    // The engine was asked to skip exactly the hit path. This is the assertion the whole block
    // exists for: it can only pass if the local pipeline built a real `MemoContext` and threaded it
    // all the way into the engine invocation.
    const [calledOptions] = runEngineMock.mock.calls[0] as [{ mechanicallyCleanPaths: string[] }];
    expect(calledOptions.mechanicallyCleanPaths).toContain("src/a.ts");

    expect(report.outcome).toBe("complete");
    expect(report.cacheHits).toBe(1);
    expect(report.cacheMisses).toBe(1);
    // Length, not mere presence: with nothing new to admit, `finalizeCacheStore` hands back the
    // input store with `appended: 0`, which is a populated `updatedCacheStore` that would prove
    // nothing about admission. Two entries means src/a.ts's own entry survived untouched AND
    // src/b.ts was newly admitted by this run.
    expect(report.updatedCacheStore?.entries).toHaveLength(2);
  });
});
