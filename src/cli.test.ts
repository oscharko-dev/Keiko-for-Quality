import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitSha } from "./core/brands.js";
import { serializeStore, type CacheStore, SUPPORTED_STORE_SCHEMA } from "./cache/review-cache.js";
import type { GitContext } from "./git/plumbing.js";
import type { CliArgs, LocalReviewReport, MainDeps } from "./cli.js";

/**
 * Every `runCli` test here mocks two things and two things only: the git plumbing module (real
 * git is `src/git/plumbing.test.ts`'s job — see `resolveRef`/`resolveTargetBranchTip`'s own
 * tests there) and `runLocalReview` itself, injected directly per `MainDeps` rather than module-
 * mocked, since the real `performLocalReview` this stands in for does not exist yet (issue #95).
 * Argument parsing, runtime config validation, profile loading, guideline parsing, and the
 * review-cache store are all exercised for real, against real temporary files — mocking them too
 * would leave this CLI's own logic untested.
 */
const resolveRefMock =
  vi.fn<(ctx: GitContext, ref: string, field?: string) => Promise<CommitSha>>();
const mergeBaseMock =
  vi.fn<(ctx: GitContext, base: CommitSha, head: CommitSha) => Promise<CommitSha>>();
const resolveTargetBranchTipMock = vi.fn<(ctx: GitContext, name: string) => Promise<CommitSha>>();

vi.mock("./git/plumbing.js", () => ({
  resolveRef: resolveRefMock,
  mergeBase: mergeBaseMock,
  resolveTargetBranchTip: resolveTargetBranchTipMock,
}));

const {
  checkNodeVersion,
  parseArgs,
  resolveCliArgs,
  buildRuntimeConfig,
  exitCodeForReport,
  renderHuman,
  runCli,
  EXIT_CODE,
  HELP_TEXT,
  STRING_FLAGS,
} = await import("./cli.js");
type RawArgs = Parameters<typeof resolveCliArgs>[0];

const HEAD_SHA = "1".repeat(40) as CommitSha;
const BASE_SHA = "2".repeat(40) as CommitSha;
const TARGET_TIP_SHA = "3".repeat(40) as CommitSha;
const EXPLICIT_BASE_SHA = "4".repeat(40) as CommitSha;

const VALID_PROFILE = {
  version: 1,
  reviewRelevant: ["src/**"],
  deletionCritical: [],
  generated: [],
  excluded: [],
  benignWarnings: [],
};

const VALID_ENV: NodeJS.ProcessEnv = {
  KFQ_MODEL_PROTOCOL: "anthropic",
  KFQ_MODEL_ENDPOINT: "https://api.example.test/v1",
  KFQ_MODEL_ID: "test-model",
  KFQ_MODEL_TOKEN_ENV: "KFQ_MODEL_TOKEN",
  PATH: "/usr/bin:/bin",
};

function baseReport(overrides: Partial<LocalReviewReport> = {}): LocalReviewReport {
  return {
    outcome: "complete",
    findings: [],
    spend: { engine: 0, classify: 0, total: 0, allotted: 0 },
    inventory: { total: 0, reviewable: 0, reviewed: 0 },
    ruleDigest: "a".repeat(64),
    engineVersion: "v1.8.4",
    cacheHits: 0,
    cacheMisses: 0,
    ...overrides,
  };
}

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "kfq-cli-"));
  await mkdir(join(repo, ".github"), { recursive: true });
  await writeFile(join(repo, ".github/keiko-for-quality.json"), JSON.stringify(VALID_PROFILE));

  resolveRefMock.mockReset();
  mergeBaseMock.mockReset();
  resolveTargetBranchTipMock.mockReset();
  resolveRefMock.mockImplementation((_ctx, ref) => {
    if (ref === "HEAD") return Promise.resolve(HEAD_SHA);
    return Promise.resolve(EXPLICIT_BASE_SHA);
  });
  resolveTargetBranchTipMock.mockResolvedValue(TARGET_TIP_SHA);
  mergeBaseMock.mockResolvedValue(BASE_SHA);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<MainDeps> = {}): {
  deps: MainDeps;
  stdoutLines: string[];
  stderrLines: string[];
  runLocalReview: ReturnType<typeof vi.fn>;
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const runLocalReview = vi.fn().mockResolvedValue(baseReport());
  const deps: MainDeps = {
    argv: [],
    env: { ...VALID_ENV },
    cwd: repo,
    nodeVersion: "v24.18.0",
    stdout: (text: string) => stdoutLines.push(text),
    stderr: (text: string) => stderrLines.push(text),
    runLocalReview,
    ...overrides,
  };
  return { deps, stdoutLines, stderrLines, runLocalReview };
}

describe("checkNodeVersion", () => {
  it("accepts the minimum supported major", () => {
    expect(checkNodeVersion("v24.0.0")).toBeUndefined();
  });

  it("accepts a newer major", () => {
    expect(checkNodeVersion("v25.2.1")).toBeUndefined();
  });

  it("rejects Node 22 with a one-line actionable message", () => {
    const message = checkNodeVersion("v22.9.0");
    expect(message).toBeDefined();
    expect(message).toContain("24");
    expect(message).toContain("v22.9.0");
    expect(message?.includes("\n")).toBe(false);
  });

  it("rejects an unparseable version string rather than crash", () => {
    expect(checkNodeVersion("not-a-version")).toBeDefined();
  });
});

describe("parseArgs", () => {
  it("parses every documented flag", () => {
    const result = parseArgs([
      "--repo",
      "/repo",
      "--profile",
      "profile.json",
      "--target-branch",
      "trunk",
      "--head",
      "feature",
      "--guidelines",
      "AGENTS.md",
      "--store",
      "store.json",
      "--out",
      "out.txt",
      "--format",
      "json",
      "--file-timeout-seconds",
      "60",
      "--review-timeout-seconds",
      "900",
      "--token-budget",
      "1000",
      "--max-findings",
      "10",
      "--concurrency",
      "2",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toMatchObject({
      repo: "/repo",
      profile: "profile.json",
      targetBranch: "trunk",
      head: "feature",
      guidelines: "AGENTS.md",
      store: "store.json",
      out: "out.txt",
      format: "json",
      fileTimeoutSeconds: "60",
      reviewTimeoutSeconds: "900",
      tokenBudget: "1000",
      maxFindings: "10",
      concurrency: "2",
      help: false,
    });
  });

  it.each(["--help", "-h"])("recognises %s as a boolean flag needing no value", (flag) => {
    const result = parseArgs([flag]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.help).toBe(true);
  });

  it("defaults every optional field to undefined when no flags are given", () => {
    const result = parseArgs([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.repo).toBeUndefined();
      expect(result.values.base).toBeUndefined();
      expect(result.values.help).toBe(false);
    }
  });

  it("rejects an unrecognised flag", () => {
    const result = parseArgs(["--nope"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("--nope");
  });

  it("rejects a flag with no following value", () => {
    const result = parseArgs(["--base"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("--base");
  });

  it("rejects a flag whose next token looks like another flag", () => {
    const result = parseArgs(["--base", "--head"]);
    expect(result.ok).toBe(false);
  });

  it("rejects --base and --target-branch together", () => {
    const result = parseArgs(["--base", "main", "--target-branch", "dev"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("mutually exclusive");
  });

  it("accepts --base alone", () => {
    expect(parseArgs(["--base", "main"]).ok).toBe(true);
  });

  it("accepts --target-branch alone", () => {
    expect(parseArgs(["--target-branch", "trunk"]).ok).toBe(true);
  });

  it.each(["human", "json", "sarif"])("accepts --format %s", (format) => {
    const result = parseArgs(["--format", format]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.format).toBe(format);
  });

  it("rejects a --format outside the vocabulary, naming the accepted values", () => {
    const result = parseArgs(["--format", "nope"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("human");
      expect(result.message).toContain("sarif");
    }
  });
});

/**
 * AGENTS.md makes `npm run review -- --help` the authoritative flag reference and forbids restating
 * the list elsewhere, so a flag registered in `STRING_FLAGS` but absent from `HELP_TEXT` has no
 * listing a user can reach — which is exactly what happened to `--format` for a whole release.
 * This walks the registry rather than a hand-written copy of it, so the guard covers flags that do
 * not exist yet; remove any Options row and exactly this test goes red.
 */
describe("HELP_TEXT", () => {
  it.each(Object.keys(STRING_FLAGS))("documents %s as its own Options row", (flag) => {
    // Row-anchored, not a bare substring: a flag named only inside some other row's prose is not
    // a listing, and this is the failure the pin exists to catch.
    expect(HELP_TEXT).toContain(`\n  ${flag} `);
  });
});

describe("resolveCliArgs", () => {
  const empty: RawArgs = { help: false };

  it("defaults repo to cwd and profile to <repo>/.github/keiko-for-quality.json", () => {
    const args = resolveCliArgs(empty, "/work/repo");
    expect(args.repositoryPath).toBe("/work/repo");
    expect(args.profilePath).toBe("/work/repo/.github/keiko-for-quality.json");
  });

  it("resolves a relative --repo against cwd", () => {
    const args = resolveCliArgs({ ...empty, repo: "nested" }, "/work");
    expect(args.repositoryPath).toBe("/work/nested");
  });

  it("resolves a relative --profile against the repository, not cwd", () => {
    const args = resolveCliArgs({ ...empty, profile: "custom.json" }, "/work/repo");
    expect(args.profilePath).toBe("/work/repo/custom.json");
  });

  it("defaults to the target-branch policy with name dev when neither --base nor --target-branch is given", () => {
    const args = resolveCliArgs(empty, "/work");
    expect(args.baseSelection).toEqual({ kind: "targetBranch", name: "dev" });
  });

  it("carries an explicit --base as an explicit selection", () => {
    const args = resolveCliArgs({ ...empty, base: "main" }, "/work");
    expect(args.baseSelection).toEqual({ kind: "explicit", ref: "main" });
  });

  it("carries an explicit --target-branch name", () => {
    const args = resolveCliArgs({ ...empty, targetBranch: "trunk" }, "/work");
    expect(args.baseSelection).toEqual({ kind: "targetBranch", name: "trunk" });
  });

  it("defaults head to HEAD", () => {
    expect(resolveCliArgs(empty, "/work").head).toBe("HEAD");
  });

  it("defaults guidelines to an empty string", () => {
    expect(resolveCliArgs(empty, "/work").guidelines).toBe("");
  });

  it("leaves store and out undefined by default", () => {
    const args = resolveCliArgs(empty, "/work");
    expect(args.store).toBeUndefined();
    expect(args.out).toBeUndefined();
  });

  it("applies action.yml's own numeric defaults", () => {
    const args = resolveCliArgs(empty, "/work");
    expect(args.fileTimeoutSeconds).toBe(300);
    expect(args.reviewTimeoutSeconds).toBe(1800);
    expect(args.tokenBudget).toBe(2_000_000);
    expect(args.maxFindings).toBe(50);
    expect(args.concurrency).toBe(4);
  });

  it("converts a supplied numeric flag to a number", () => {
    const args = resolveCliArgs({ ...empty, concurrency: "8" }, "/work");
    expect(args.concurrency).toBe(8);
  });

  it("leaves a malformed numeric flag as NaN rather than substituting the default", () => {
    // `parseRuntimeConfig` is the single place that rejects this — see `buildRuntimeConfig`.
    const args = resolveCliArgs({ ...empty, concurrency: "not-a-number" }, "/work");
    expect(Number.isNaN(args.concurrency)).toBe(true);
  });
});

describe("buildRuntimeConfig", () => {
  const args: CliArgs = resolveCliArgs({ help: false }, "/work");

  it("builds a valid RuntimeConfig from KFQ_* environment variables", () => {
    const config = buildRuntimeConfig(VALID_ENV, args);
    expect(config.protocol).toBe("anthropic");
    expect(config.endpoint).toBe("https://api.example.test/v1");
    expect(config.model).toBe("test-model");
    expect(config.tokenEnvName).toBe("KFQ_MODEL_TOKEN");
    expect(config.concurrency).toBe(4);
  });

  it("rejects a missing model endpoint with a clean, one-line message", () => {
    const { KFQ_MODEL_ENDPOINT: _omit, ...rest } = VALID_ENV;
    expect(() => buildRuntimeConfig(rest, args)).toThrow(/invalid value for config\.endpoint/);
  });

  it("rejects a non-https endpoint", () => {
    const env = { ...VALID_ENV, KFQ_MODEL_ENDPOINT: "http://api.example.test" };
    expect(() => buildRuntimeConfig(env, args)).toThrow();
  });

  it("rejects an unsupported protocol", () => {
    const env = { ...VALID_ENV, KFQ_MODEL_PROTOCOL: "carrier-pigeon" };
    expect(() => buildRuntimeConfig(env, args)).toThrow();
  });

  it("rejects GITHUB_TOKEN named as the model token variable", () => {
    const env = { ...VALID_ENV, KFQ_MODEL_TOKEN_ENV: "GITHUB_TOKEN" };
    expect(() => buildRuntimeConfig(env, args)).toThrow();
  });
});

describe("exitCodeForReport", () => {
  it("maps complete with zero findings to 0", () => {
    expect(exitCodeForReport(baseReport({ outcome: "complete", findings: [] }))).toBe(
      EXIT_CODE.completeClean,
    );
  });

  it("maps complete with findings to 1", () => {
    const findings = [{ path: "src/a.ts", startLine: 1, endLine: 2, body: "x".repeat(20) }];
    expect(exitCodeForReport(baseReport({ outcome: "complete", findings }))).toBe(
      EXIT_CODE.completeWithFindings,
    );
  });

  it("maps incomplete to 2, distinct from findings count", () => {
    expect(exitCodeForReport(baseReport({ outcome: "incomplete" }))).toBe(EXIT_CODE.incomplete);
  });

  it("maps abandoned to 3", () => {
    expect(exitCodeForReport(baseReport({ outcome: "abandoned" }))).toBe(EXIT_CODE.abandoned);
  });

  // CONTRIBUTING.md: "incomplete may never read as clean… a state the settlement logic does not
  // know must fail closed by default." This is the test that can fail: change the fallback in
  // `exitCodeForReport` to `EXIT_CODE.completeClean` and this goes red.
  it("fails closed to internalError for an outcome outside the known vocabulary", () => {
    const bogus = baseReport({ outcome: "complete" });
    const withBogusOutcome = {
      ...bogus,
      outcome: "mystery-outcome",
    } as unknown as LocalReviewReport;
    expect(exitCodeForReport(withBogusOutcome)).toBe(EXIT_CODE.internalError);
  });
});

describe("renderHuman", () => {
  const context = { repositoryPath: "/work/repo", base: BASE_SHA, head: HEAD_SHA };

  it("includes the repository path and short base/head shas", () => {
    const text = renderHuman(baseReport(), context);
    expect(text).toContain("/work/repo");
    expect(text).toContain(BASE_SHA.slice(0, 7));
    expect(text).toContain(HEAD_SHA.slice(0, 7));
  });

  it("reports no findings plainly", () => {
    expect(renderHuman(baseReport({ findings: [] }), context)).toContain("Findings: none.");
  });

  it("renders a finding's sanitized body", () => {
    const text = renderHuman(
      baseReport({
        findings: [
          {
            path: "src/a.ts",
            startLine: 3,
            endLine: 5,
            category: "bug",
            severity: "high",
            body: "Fix the null check.\n\nThis branch never validates the pointer before use.",
          },
        ],
      }),
      context,
    );
    expect(text).toContain("src/a.ts:3-5");
    expect(text).toContain("bug/high");
    expect(text).toContain("null check");
  });

  // Issue #96: "a body the sanitizer rejects is a dropped finding and must surface as such in
  // the summary, not vanish." An HTML tag is one of `sanitizeFindingBody`'s own rejections.
  it("surfaces a finding whose body fails sanitization instead of dropping it silently", () => {
    const text = renderHuman(
      baseReport({
        findings: [
          {
            path: "src/a.ts",
            startLine: 1,
            endLine: 1,
            body: "<script>alert(1)</script> and then some more filler text past the minimum.",
          },
        ],
      }),
      context,
    );
    expect(text).toContain("src/a.ts:1-1");
    expect(text).toContain("omitted");
    expect(text).not.toContain("<script>");
  });

  it("shows the settlement reason when incomplete", () => {
    const text = renderHuman(
      baseReport({ outcome: "incomplete", reason: "settlement.incomplete.budget_exceeded" }),
      context,
    );
    expect(text).toContain("incomplete");
    expect(text).toContain("settlement.incomplete.budget_exceeded");
  });

  it("shows spend and inventory", () => {
    const text = renderHuman(
      baseReport({
        spend: { engine: 100, classify: 20, total: 120, allotted: 500 },
        inventory: { total: 9, reviewable: 7, reviewed: 7 },
      }),
      context,
    );
    expect(text).toContain("120");
    expect(text).toContain("500");
    expect(text).toContain("9 total");
    expect(text).toContain("7 reviewable");
  });

  it("shows zero cache counts as a fact, not an absence", () => {
    expect(renderHuman(baseReport(), context)).toContain("Cache: 0 hits, 0 misses");
  });

  it("shows cache hits and misses when present", () => {
    const text = renderHuman(baseReport({ cacheHits: 3, cacheMisses: 2 }), context);
    expect(text).toContain("Cache: 3 hits, 2 misses");
  });
});

/** Issue #96: every documented usage error exits `4` with a one-line message, no stack trace. */
function expectSingleLineUsageError(stderrLines: readonly string[]): void {
  const message = stderrLines.join("");
  expect(message.startsWith("error: ")).toBe(true);
  expect(message.trim().split("\n")).toHaveLength(1);
  expect(message).not.toContain("    at ");
}

describe("runCli", () => {
  describe("Node version gate", () => {
    it("exits 4 on Node 22 without calling runLocalReview", async () => {
      const { deps, stderrLines, runLocalReview } = makeDeps({ nodeVersion: "v22.9.0" });
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.usageError);
      expect(stderrLines.join("")).toContain("24");
      expect(runLocalReview).not.toHaveBeenCalled();
    });

    it("proceeds past the gate on Node 24", async () => {
      const { deps, runLocalReview } = makeDeps({ nodeVersion: "v24.1.0", argv: [] });
      await runCli(deps);
      expect(runLocalReview).toHaveBeenCalledTimes(1);
    });
  });

  describe("--help", () => {
    it("prints help and exits 0 without calling runLocalReview", async () => {
      const { deps, stdoutLines, runLocalReview } = makeDeps({ argv: ["--help"] });
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.completeClean);
      expect(stdoutLines.join("")).toBe(HELP_TEXT);
      expect(runLocalReview).not.toHaveBeenCalled();
    });
  });

  describe("usage errors", () => {
    it("exits 4 with a one-line message and no stack trace for an unknown flag", async () => {
      const { deps, stderrLines } = makeDeps({ argv: ["--nope"] });
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.usageError);
      expect(stderrLines.join("")).toContain("--nope");
      expectSingleLineUsageError(stderrLines);
    });

    it("exits 4 for --base and --target-branch together", async () => {
      const { deps, stderrLines } = makeDeps({
        argv: ["--base", "main", "--target-branch", "dev"],
      });
      expect(await runCli(deps)).toBe(EXIT_CODE.usageError);
      expectSingleLineUsageError(stderrLines);
    });

    it("exits 4 for a --format outside the vocabulary, without calling runLocalReview", async () => {
      const { deps, stderrLines, runLocalReview } = makeDeps({ argv: ["--format", "nope"] });
      expect(await runCli(deps)).toBe(EXIT_CODE.usageError);
      expect(stderrLines.join("")).toContain("--format");
      expectSingleLineUsageError(stderrLines);
      expect(runLocalReview).not.toHaveBeenCalled();
    });
  });

  describe("configuration errors", () => {
    it("exits 4 when required model environment variables are missing", async () => {
      const { deps, stderrLines, runLocalReview } = makeDeps({ env: { PATH: "/usr/bin" } });
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.usageError);
      expectSingleLineUsageError(stderrLines);
      expect(runLocalReview).not.toHaveBeenCalled();
    });

    it("exits 4 when the profile file does not exist", async () => {
      const { deps, stderrLines } = makeDeps({ argv: ["--profile", join(repo, "missing.json")] });
      expect(await runCli(deps)).toBe(EXIT_CODE.usageError);
      expectSingleLineUsageError(stderrLines);
    });

    it("exits 4 when the profile fails schema validation", async () => {
      const badProfilePath = join(repo, "bad-profile.json");
      await writeFile(badProfilePath, JSON.stringify({ version: 1 }));
      const { deps, stderrLines } = makeDeps({ argv: ["--profile", badProfilePath] });
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.usageError);
      expect(stderrLines.join("")).toContain("profile");
      expectSingleLineUsageError(stderrLines);
    });

    it("exits 4 when the guidelines list is malformed", async () => {
      const { deps, stderrLines } = makeDeps({ argv: ["--guidelines", "../outside-the-repo.md"] });
      expect(await runCli(deps)).toBe(EXIT_CODE.usageError);
      expectSingleLineUsageError(stderrLines);
    });

    it("exits 4 when the target branch cannot be resolved, without calling runLocalReview", async () => {
      resolveTargetBranchTipMock.mockRejectedValue(new Error("git exited with 128"));
      const { deps, stderrLines, runLocalReview } = makeDeps({ argv: ["--target-branch", "nope"] });
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.usageError);
      expectSingleLineUsageError(stderrLines);
      expect(runLocalReview).not.toHaveBeenCalled();
    });
  });

  describe("base/head resolution (plumbing mocked)", () => {
    it("resolves the default target branch dev via merge-base when no flag is given", async () => {
      const { deps } = makeDeps({ argv: [] });
      await runCli(deps);
      expect(resolveTargetBranchTipMock).toHaveBeenCalledWith(expect.anything(), "dev");
      expect(mergeBaseMock).toHaveBeenCalledWith(expect.anything(), TARGET_TIP_SHA, HEAD_SHA);
    });

    it("resolves a named --target-branch", async () => {
      const { deps } = makeDeps({ argv: ["--target-branch", "trunk"] });
      await runCli(deps);
      expect(resolveTargetBranchTipMock).toHaveBeenCalledWith(expect.anything(), "trunk");
    });

    it("uses an explicit --base as-is, never consulting the target-branch policy", async () => {
      const { deps, runLocalReview } = makeDeps({ argv: ["--base", "release"] });
      await runCli(deps);
      expect(resolveTargetBranchTipMock).not.toHaveBeenCalled();
      expect(mergeBaseMock).not.toHaveBeenCalled();
      const request = runLocalReview.mock.calls[0]?.[0] as { base: string };
      expect(request.base).toBe(EXPLICIT_BASE_SHA);
    });

    it("resolves a non-default --head", async () => {
      resolveRefMock.mockImplementation((_ctx, ref) => {
        if (ref === "feature") return Promise.resolve(HEAD_SHA);
        return Promise.resolve(EXPLICIT_BASE_SHA);
      });
      const { deps } = makeDeps({ argv: ["--head", "feature"] });
      await runCli(deps);
      expect(resolveRefMock).toHaveBeenCalledWith(expect.anything(), "feature", "head");
    });
  });

  describe("request assembly", () => {
    it("never carries a client, ref, pullNumber, or identity field (no GitHubClient can be built)", async () => {
      const { deps, runLocalReview } = makeDeps({
        env: { ...VALID_ENV, GITHUB_TOKEN: "ghp_should_never_be_forwarded_specially" },
      });
      await runCli(deps);
      const request = runLocalReview.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(request).toBeDefined();
      expect("client" in request).toBe(false);
      expect("ref" in request).toBe(false);
      expect("pullNumber" in request).toBe(false);
      expect("identity" in request).toBe(false);
    });

    it("omits cacheStore entirely when --store is not given", async () => {
      const { deps, runLocalReview } = makeDeps({ argv: [] });
      await runCli(deps);
      const request = runLocalReview.mock.calls[0]?.[0] as Record<string, unknown>;
      expect("cacheStore" in request).toBe(false);
    });
  });

  describe("exit codes end to end", () => {
    it("exits 0 for complete with no findings", async () => {
      const { deps } = makeDeps({ argv: [] });
      expect(await runCli(deps)).toBe(EXIT_CODE.completeClean);
    });

    it("exits 1 for complete with findings and prints them", async () => {
      const { deps, stdoutLines, runLocalReview } = makeDeps({ argv: [] });
      runLocalReview.mockResolvedValue(
        baseReport({
          findings: [{ path: "src/a.ts", startLine: 1, endLine: 1, body: "x".repeat(20) }],
        }),
      );
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.completeWithFindings);
      expect(stdoutLines.join("")).toContain("src/a.ts:1-1");
    });

    it("exits 2 for incomplete", async () => {
      const { deps, runLocalReview } = makeDeps({ argv: [] });
      runLocalReview.mockResolvedValue(
        baseReport({ outcome: "incomplete", reason: "settlement.incomplete.engine_error" }),
      );
      expect(await runCli(deps)).toBe(EXIT_CODE.incomplete);
    });

    it("exits 3 for abandoned", async () => {
      const { deps, runLocalReview } = makeDeps({ argv: [] });
      runLocalReview.mockResolvedValue(baseReport({ outcome: "abandoned" }));
      expect(await runCli(deps)).toBe(EXIT_CODE.abandoned);
    });

    it("exits 5 when runLocalReview itself throws, distinct from a settled incomplete", async () => {
      const { deps, stderrLines, runLocalReview } = makeDeps({ argv: [] });
      runLocalReview.mockRejectedValue(new Error("boom — should never be echoed"));
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.internalError);
      expect(stderrLines.join("")).not.toContain("boom");
    });
  });

  describe("--out file writing", () => {
    it("writes the rendered report to the given path instead of stdout", async () => {
      const outPath = join(repo, "report.txt");
      const { deps, stdoutLines } = makeDeps({ argv: ["--out", outPath] });
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.completeClean);
      expect(stdoutLines).toEqual([]);
      const written = await readFile(outPath, "utf8");
      expect(written).toContain("Keiko for Quality — local review");
    });

    it("falls back to stdout with a warning if the path cannot be written, without changing the exit code", async () => {
      const unwritablePath = join(repo, "does-not-exist", "report.txt");
      const { deps, stdoutLines, stderrLines } = makeDeps({
        argv: ["--out", unwritablePath],
      });
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.completeClean);
      expect(stdoutLines.join("")).toContain("Keiko for Quality — local review");
      expect(stderrLines.join("")).toContain("warning");
    });
  });

  /**
   * The seam, not the schema. `src/report/json.test.ts` and `src/report/sarif.test.ts` already pin
   * both wire formats field by field; what nothing covered until now is `src/cli.ts`'s own adapter
   * between the orchestrator's report and those renderers — `--format` reaching `renderReport` at
   * all, and `toReportFinding`'s narrowing onto the closed classification vocabulary.
   */
  describe("--format", () => {
    it("emits the versioned JSON wire contract on stdout under --format json", async () => {
      const { deps, stdoutLines, runLocalReview } = makeDeps({ argv: ["--format", "json"] });
      runLocalReview.mockResolvedValue(
        baseReport({
          findings: [
            {
              path: "src/a.ts",
              startLine: 3,
              endLine: 5,
              category: "bug",
              severity: "high",
              body: "x".repeat(20),
            },
          ],
        }),
      );
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.completeWithFindings);
      // Spelled out rather than imported: this identifier is the contract the IDE extensions pin
      // to (docs/local-report-schema.md), so a test that imported it could never notice it moving.
      const report = JSON.parse(stdoutLines.join(""));
      expect(report.schema).toBe("keiko-for-quality.local-report/v1");
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].path).toBe("src/a.ts");
      expect(report.findings[0].category).toBe("bug");
    });

    // Reject rather than repair, in miniature (CONTRIBUTING.md). The orchestrator types
    // `category`/`severity` as plain strings; the renderers guarantee a fixed SARIF rule set and
    // schema-stable JSON values only over the closed vocabulary. So `toReportFinding` drops a value
    // it does not recognise — it never passes it through, and it never substitutes a nearest match.
    // `null` below is how the JSON renderer spells "absent" under its fixed-key-set rule.
    it("drops an out-of-vocabulary category and severity rather than passing them through", async () => {
      const { deps, stdoutLines, runLocalReview } = makeDeps({ argv: ["--format", "json"] });
      runLocalReview.mockResolvedValue(
        baseReport({
          findings: [
            {
              path: "src/a.ts",
              startLine: 1,
              endLine: 1,
              category: "nonsense",
              severity: "catastrophic",
              body: "x".repeat(20),
            },
          ],
        }),
      );
      expect(await runCli(deps)).toBe(EXIT_CODE.completeWithFindings);
      const rendered = stdoutLines.join("");
      expect(rendered).not.toContain("nonsense");
      expect(rendered).not.toContain("catastrophic");
      const report = JSON.parse(rendered);
      expect(report.findings[0].category).toBeNull();
      expect(report.findings[0].severity).toBeNull();
    });

    // Dispatch only — `src/report/sarif.test.ts` owns the format itself.
    it("dispatches --format sarif to the SARIF renderer", async () => {
      const { deps, stdoutLines } = makeDeps({ argv: ["--format", "sarif"] });
      await runCli(deps);
      const log = JSON.parse(stdoutLines.join(""));
      expect(log.runs[0].tool.driver.name).toBe("keiko-for-quality");
    });

    it("defaults to the human format when --format is not given", async () => {
      const { deps, stdoutLines } = makeDeps({ argv: [] });
      await runCli(deps);
      expect(stdoutLines.join("")).toContain("Keiko for Quality — local review");
    });
  });

  describe("review-cache store", () => {
    it("passes an empty store when --store points at a file that does not exist", async () => {
      const storePath = join(repo, "store.json");
      const { deps, runLocalReview } = makeDeps({ argv: ["--store", storePath] });
      await runCli(deps);
      const request = runLocalReview.mock.calls[0]?.[0] as { cacheStore?: CacheStore };
      expect(request.cacheStore?.entries).toEqual([]);
    });

    it("passes an empty store when the store file is malformed, rather than failing the run", async () => {
      const storePath = join(repo, "store.json");
      await writeFile(storePath, "{ not valid json");
      const { deps, runLocalReview } = makeDeps({ argv: ["--store", storePath] });
      const code = await runCli(deps);
      expect(code).toBe(EXIT_CODE.completeClean);
      const request = runLocalReview.mock.calls[0]?.[0] as { cacheStore?: CacheStore };
      expect(request.cacheStore?.entries).toEqual([]);
    });

    it("loads an existing valid store", async () => {
      const store: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };
      const storePath = join(repo, "store.json");
      await writeFile(storePath, serializeStore(store));
      const { deps, runLocalReview } = makeDeps({ argv: ["--store", storePath] });
      await runCli(deps);
      const request = runLocalReview.mock.calls[0]?.[0] as { cacheStore?: CacheStore };
      expect(request.cacheStore).toEqual(store);
    });

    it("drops entries written under retired publication semantics", async () => {
      const storePath = join(repo, "store.json");
      await writeFile(
        storePath,
        JSON.stringify({
          schemaVersion: SUPPORTED_STORE_SCHEMA,
          entries: [
            {
              key: "1".repeat(64),
              baseBlob: "2".repeat(40),
              headBlob: "3".repeat(40),
              ruleDigest: "4".repeat(64),
              engineDigest: "5".repeat(64),
              prPathSetDigest: "6".repeat(64),
              semantics: "retired-publication-contract",
              modelId: "gpt-oss-120b",
              protocol: "openai",
              findings: [],
            },
          ],
        }),
      );

      const { deps, runLocalReview } = makeDeps({ argv: ["--store", storePath] });
      await runCli(deps);

      const request = runLocalReview.mock.calls[0]?.[0] as { cacheStore?: CacheStore };
      expect(request.cacheStore?.entries).toEqual([]);
    });

    it("writes the store back on a complete settlement", async () => {
      const storePath = join(repo, "store.json");
      const updated: CacheStore = {
        schemaVersion: SUPPORTED_STORE_SCHEMA,
        entries: [],
      };
      const { deps, runLocalReview } = makeDeps({ argv: ["--store", storePath] });
      runLocalReview.mockResolvedValue(baseReport({ updatedCacheStore: updated }));
      await runCli(deps);
      expect(JSON.parse(await readFile(storePath, "utf8"))).toEqual(updated);
    });

    it("writes the store back on an incomplete settlement whose verdicts survive it", async () => {
      const storePath = join(repo, "store.json");
      const updated: CacheStore = {
        schemaVersion: SUPPORTED_STORE_SCHEMA,
        entries: [],
      };
      const { deps, runLocalReview } = makeDeps({ argv: ["--store", storePath] });
      runLocalReview.mockResolvedValue(
        baseReport({
          outcome: "incomplete",
          reason: "settlement.incomplete.budget_exceeded",
          updatedCacheStore: updated,
        }),
      );
      await runCli(deps);
      expect(JSON.parse(await readFile(storePath, "utf8"))).toEqual(updated);
    });

    it("does not write the store back on an incomplete settlement whose reason does not survive it", async () => {
      const storePath = join(repo, "store.json");
      const updated: CacheStore = {
        schemaVersion: SUPPORTED_STORE_SCHEMA,
        entries: [],
      };
      const { deps, runLocalReview } = makeDeps({ argv: ["--store", storePath] });
      runLocalReview.mockResolvedValue(
        baseReport({
          outcome: "incomplete",
          reason: "settlement.incomplete.schema_rejected",
          updatedCacheStore: updated,
        }),
      );
      await runCli(deps);
      await expect(readFile(storePath, "utf8")).rejects.toThrow();
    });

    it("does not write the store back on abandoned", async () => {
      const storePath = join(repo, "store.json");
      const updated: CacheStore = {
        schemaVersion: SUPPORTED_STORE_SCHEMA,
        entries: [],
      };
      const { deps, runLocalReview } = makeDeps({ argv: ["--store", storePath] });
      runLocalReview.mockResolvedValue(
        baseReport({ outcome: "abandoned", updatedCacheStore: updated }),
      );
      await runCli(deps);
      await expect(readFile(storePath, "utf8")).rejects.toThrow();
    });
  });
});
