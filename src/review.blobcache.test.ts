import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { compileProfile, type ReviewProfile } from "./config/profile.js";
import type { RuntimeConfig } from "./config/runtime.js";
import { commitSha, type CommitSha } from "./core/brands.js";
import { createSilentDiagnostics } from "./diagnostics/sink.js";
import { currentPlatformDigest } from "./engine/pinned-release.js";
import { GitHubClient } from "./github/client.js";
import type * as Plumbing from "./git/plumbing.js";
import type { GitContext } from "./git/plumbing.js";
import type { ReviewRequest } from "./review.js";

/**
 * Proves #33: a file that is both a declared contract-pair path (or counterpart) AND a reviewable
 * change-pass candidate must have its head-side git blob read at most once per run, not once per
 * collector. `review.test.ts` already exercises `contractPairs` and `crossArtifactPass` separately
 * — this is its own file, isolated with its own fresh git repo and its own mock of
 * `git/plumbing.js`'s `readTextAtCommit`, so instrumenting that one function cannot affect
 * `review.test.ts`'s much larger, real-git-throughout suite.
 */
const acquireEngineMock = vi.fn();
vi.mock("./engine/acquire.js", () => ({ acquireEngine: acquireEngineMock }));

const runEngineMock = vi.fn();
vi.mock("./engine/run.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runEngine: runEngineMock,
}));

/**
 * A passthrough spy, not a stub: every call still reaches the real implementation (real git,
 * against the real repo built below), so this only adds instrumentation — it must never change
 * what any test observes, only let this one test observe how many times git was actually asked.
 */
const readTextAtCommitCalls: string[] = [];
vi.mock("./git/plumbing.js", async (importOriginal) => {
  const actual: typeof Plumbing = await importOriginal();
  return {
    ...actual,
    readTextAtCommit: async (
      ctx: GitContext,
      commit: CommitSha,
      path: string,
    ): Promise<string | undefined> => {
      readTextAtCommitCalls.push(`${commit}:${path}`);
      return actual.readTextAtCommit(ctx, commit, path);
    },
  };
});

const { performReview } = await import("./review.js");

describe("performReview: the gate and the change-level pass share one blob-text cache (#33)", () => {
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
    repo = await mkdtemp(join(tmpdir(), "kfq-blobcache-"));
    git(["init", "-q", "-b", "main"]);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "README.md"), "placeholder\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
    baseSha = git(["rev-parse", "HEAD"]).trim();

    // Both new files at head: a declared contract pair (server/client), and both also reviewable
    // change-pass candidates through the same `src/**` profile. Identical shapes on purpose — the
    // gate finding nothing real to say keeps this test about the READ COUNT, not gate correctness,
    // which `review.test.ts`'s own gate suite already covers.
    await writeFile(
      join(repo, "src/dedup-server.ts"),
      "export interface Shape {\n  a: string;\n}\n",
    );
    await writeFile(
      join(repo, "src/dedup-client.ts"),
      "export interface Shape {\n  a: string;\n}\n",
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "head", "--no-gpg-sign"]);
    headSha = git(["rev-parse", "HEAD"]).trim();
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reads each file's head-side text exactly once, though the gate and the change-pass both need it", async () => {
    const profile = compileProfile({
      version: 1,
      reviewRelevant: ["src/**"],
      deletionCritical: [],
      generated: [],
      excluded: [],
      benignWarnings: [],
      pathInstructions: [],
      contractPairs: [{ paths: ["src/dedup-server.ts"], counterparts: ["src/dedup-client.ts"] }],
    } satisfies ReviewProfile);

    const config: RuntimeConfig = {
      protocol: "openai",
      endpoint: "https://model.example.test/v1",
      model: "gpt-oss-test",
      tokenEnvName: "MODEL_TOKEN",
      language: "English",
      concurrency: 4,
      fileTimeoutSeconds: 300,
      reviewTimeoutSeconds: 1800,
      tokenBudget: 2_000_000,
      maxFindings: 50,
      renameDetectionPercent: 50,
      crossArtifactPass: true,
    };

    const client = new GitHubClient("https://api.example.test", "unused");
    vi.spyOn(client, "getPullRequest").mockResolvedValue({
      headSha: commitSha(headSha),
      draft: false,
      baseRef: "dev",
      headRepoFullName: undefined,
    });
    vi.spyOn(client, "listReviewComments").mockResolvedValue([]);
    vi.spyOn(client, "resolveSupersededOwnNotices").mockResolvedValue({
      attempted: 0,
      resolved: 0,
    });

    const request: ReviewRequest = {
      client,
      ref: { owner: "acme", repo: "widget" },
      pullNumber: 1,
      base: commitSha(baseSha),
      head: commitSha(headSha),
      repositoryPath: repo,
      config,
      profile,
      guidelines: { paths: [] },
      identity: "keiko-for-quality[bot]",
      identityExclusive: true,
      env: { MODEL_TOKEN: "fake-token" },
      pathValue: process.env.PATH ?? "/usr/bin:/bin",
    };

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
    // No assertion needs a real response shape — only that no real network call happens. Both
    // fixture files carry no type-annotated exported declarations the change-pass would need to
    // reach the model over regardless, but this stays the safety net `review.test.ts`'s own
    // change-pass tests use rather than relying on that short-circuit.
    globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;

    const report = await performReview(request, createSilentDiagnostics());
    expect(report.outcome).toBe("complete");

    const serverKey = `${headSha}:src/dedup-server.ts`;
    const clientKey = `${headSha}:src/dedup-client.ts`;
    expect(readTextAtCommitCalls).toContain(serverKey);
    expect(readTextAtCommitCalls).toContain(clientKey);
    // The property #33 exists for: no (commit, path) key appears more than once. Before the fix,
    // `collectGateFindings` and `collectChangePassFindings` each held their own cache, and both of
    // these keys would appear twice — once per collector.
    const counts = new Map<string, number>();
    for (const key of readTextAtCommitCalls) counts.set(key, (counts.get(key) ?? 0) + 1);
    expect(counts.get(serverKey)).toBe(1);
    expect(counts.get(clientKey)).toBe(1);
  });
});
