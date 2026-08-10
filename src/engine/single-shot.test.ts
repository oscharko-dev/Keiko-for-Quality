import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import type { RuntimeConfig } from "../config/runtime.js";
import { commitSha } from "../core/brands.js";
import { createSilentDiagnostics } from "../diagnostics/sink.js";
import { buildInventory, type ReviewPair } from "../inventory/inventory.js";
import { GENERATION_COMPLETION_LIMIT, generationRequestUpperBound } from "./generation-workflow.js";
import { parseEngineResult } from "./result.js";
import type { EngineRunOptions } from "./run.js";
import { sanitizeFindingBody } from "../publish/sanitize.js";
import {
  parseFindingsReply,
  renderNumberedHunks,
  runSingleShotEngine,
  splitFileDiffs,
} from "./single-shot.js";

describe("renderNumberedHunks", () => {
  it("numbers new-file lines absolutely and separates removed lines into the old hunk", () => {
    const fragment = [
      "a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -10,3 +12,4 @@ function f() {",
      " context one",
      "-removed line",
      "+added line",
      "+second added",
      " context two",
    ].join("\n");
    const rendered = renderNumberedHunks(fragment);
    expect(rendered).toContain("__new hunk__");
    expect(rendered).toContain("12  context one");
    expect(rendered).toContain("13 +added line");
    expect(rendered).toContain("14 +second added");
    expect(rendered).toContain("15  context two");
    expect(rendered).toContain("__old hunk__");
    expect(rendered).toContain("-removed line");
  });

  it("omits the old hunk entirely for a pure addition", () => {
    const fragment = ["+++ b/src/y.ts", "@@ -0,0 +1,2 @@", "+alpha", "+beta"].join("\n");
    const rendered = renderNumberedHunks(fragment);
    expect(rendered).toContain("1 +alpha");
    expect(rendered).toContain("2 +beta");
    expect(rendered).not.toContain("__old hunk__");
  });

  it("restarts numbering at every hunk header", () => {
    const fragment = [
      "+++ b/src/z.ts",
      "@@ -1,1 +1,1 @@",
      "+first",
      "@@ -40,1 +41,1 @@",
      "+second",
    ].join("\n");
    const rendered = renderNumberedHunks(fragment);
    expect(rendered).toContain("1 +first");
    expect(rendered).toContain("41 +second");
  });
});

describe("splitFileDiffs", () => {
  it("splits a multi-file diff and retains a deleted file under its old path", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "+in a",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -2 +2 @@",
      "+in b",
    ].join("\n");
    const byPath = splitFileDiffs(diff);
    expect([...byPath.keys()]).toEqual(["src/a.ts", "src/gone.ts", "src/b.ts"]);
    expect(byPath.get("src/a.ts")).toContain("+in a");
    expect(byPath.get("src/gone.ts")).toContain("-bye");
    expect(byPath.get("src/b.ts")).toContain("+in b");
  });

  it("retains mode-only and rename-plus-mode fragments without a +++ header", () => {
    const diff = [
      "diff --git a/scripts/run.sh b/scripts/run.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    const byPath = splitFileDiffs(diff);
    expect([...byPath.keys()]).toEqual(["scripts/run.sh", "src/new.ts"]);
    expect(renderNumberedHunks(byPath.get("scripts/run.sh") ?? "")).toContain("new mode 100755");
    expect(renderNumberedHunks(byPath.get("src/new.ts") ?? "")).toContain("rename from src/old.ts");
  });

  it("numbers a complete deletion on its old side instead of losing the +0 hunk", () => {
    const rendered = renderNumberedHunks(
      ["--- a/src/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-one", "-two"].join("\n"),
    );
    expect(rendered).toContain("1 -one");
    expect(rendered).toContain("2 -two");
  });
});

describe("parseFindingsReply compatibility", () => {
  it("pins the reviewed path and accepts a silent array", () => {
    const reply =
      '```json\n[{"start_line":3,"end_line":4,"content":"Off by one.","path":"other.ts"}]\n```';
    expect(parseFindingsReply(reply, "src/real.ts")?.[0]?.path).toBe("src/real.ts");
    expect(parseFindingsReply("[]", "src/a.ts")).toEqual([]);
  });

  it("rejects rather than repairs an invalid envelope", () => {
    expect(parseFindingsReply("not json", "a")).toBeUndefined();
    expect(parseFindingsReply('{"findings":[]}', "a")).toBeUndefined();
    expect(
      parseFindingsReply('[{"start_line":0,"end_line":1,"content":"x"}]', "a"),
    ).toBeUndefined();
  });
});

describe("runSingleShotEngine staged generation", () => {
  const PROFILE = compileProfile({
    version: 1,
    reviewRelevant: ["src/**"],
    deletionCritical: [],
    generated: ["src/generated/**"],
    excluded: [],
    benignWarnings: [],
    pathInstructions: [],
  } satisfies ReviewProfile);

  const CONFIG: RuntimeConfig = {
    protocol: "openai",
    endpoint: "https://model.example.test/v1",
    model: "gpt-oss-120b",
    tokenEnvName: "MODEL_TOKEN",
    language: "English",
    concurrency: 2,
    fileTimeoutSeconds: 300,
    reviewTimeoutSeconds: 1800,
    tokenBudget: 2_000_000,
    maxFindings: 50,
    renameDetectionPercent: 50,
  };

  interface CapturedBody {
    readonly temperature?: number;
    readonly seed?: number;
    readonly model?: string;
    readonly max_completion_tokens?: number;
    readonly messages?: { role: string; content: string }[];
  }

  interface ScriptedReply {
    readonly status: number;
    readonly reply?: string;
    readonly omitUsage?: boolean;
    readonly finishReason?: string;
  }

  function options(pair: ReviewPair, overrides: Partial<EngineRunOptions>): EngineRunOptions {
    return {
      binaryPath: "/unused-in-single-shot",
      repositoryPath: "/unused-repo",
      pair,
      config: CONFIG,
      profile: PROFILE,
      guidelines: { paths: [] },
      env: { MODEL_TOKEN: "secret-token" },
      pathValue: "/usr/bin:/bin",
      reviewDeadlineMs: Date.now() + 1_800_000,
      allottedBudget: 1_000_000,
      expectedReviewablePaths: ["src/a.ts"],
      mechanicallyCleanPaths: [],
      ...overrides,
    };
  }

  async function makeRepo(
    prefix: string,
    headFiles: Readonly<Record<string, string | null>>,
  ): Promise<{ repo: string; pair: ReviewPair }> {
    const repo = await mkdtemp(join(tmpdir(), prefix));
    const git = (args: readonly string[]): string =>
      execFileSync("git", [...args], {
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
    git(["init", "-q", "-b", "main"]);
    await mkdir(join(repo, "src/generated"), { recursive: true });
    await writeFile(join(repo, "src/a.ts"), "keep\n");
    await writeFile(join(repo, "src/b.ts"), "old b\n");
    await writeFile(join(repo, "src/generated/bundle.ts"), "old bundle\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    for (const [path, content] of Object.entries(headFiles)) {
      if (content === null) await unlink(join(repo, path));
      else await writeFile(join(repo, path), content);
    }
    git(["add", "."]);
    git(["commit", "-q", "-m", "head", "--no-gpg-sign"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    return {
      repo,
      pair: { base: commitSha(base), head: commitSha(head), mergeBase: commitSha(base) },
    };
  }

  /**
   * One real Git diff carrying all three classification boundaries the staged dispatcher used to
   * get wrong when it repeated the profile's globs: a deletion-critical path outside
   * `reviewRelevant`, plus a matching binary and matching gitlink that have no reviewable blob.
   */
  async function makeStructuralRepo(): Promise<{ repo: string; pair: ReviewPair }> {
    const repo = await mkdtemp(join(tmpdir(), "kfq-staged-structural-"));
    const git = (args: readonly string[]): string =>
      execFileSync("git", [...args], {
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
    git(["init", "-q", "-b", "main"]);
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "src/a.ts"), "export const value = 1;\n");
    await writeFile(join(repo, "src/logo.bin"), "\0old-binary");
    await writeFile(join(repo, "tests/guard.txt"), "must remain\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "seed", "--no-gpg-sign"]);
    const seed = git(["rev-parse", "HEAD"]).trim();
    git(["update-index", "--add", "--cacheinfo", `160000,${seed},src/vendor`]);
    git(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    await writeFile(join(repo, "src/a.ts"), "export const value = 2;\n");
    await writeFile(join(repo, "src/logo.bin"), "\0new-binary");
    await unlink(join(repo, "tests/guard.txt"));
    git(["add", "-A"]);
    git(["update-index", "--add", "--cacheinfo", `160000,${base},src/vendor`]);
    git(["commit", "-q", "-m", "head", "--no-gpg-sign"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    return {
      repo,
      pair: { base: commitSha(base), head: commitSha(head), mergeBase: commitSha(base) },
    };
  }

  function claim(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify([
      {
        start: 2,
        end: 2,
        action: "Reject truncated tokens before comparison",
        condition: "the supplied token shares only the first eight characters",
        defect: "the changed prefix comparison accepts the forged token",
        consequence: "an unauthenticated caller is treated as authenticated",
        categoryHint: "security",
        severityHint: "critical",
        ...overrides,
      },
    ]);
  }

  function fetchStub(
    respond: (system: string, user: string, seed: number) => ScriptedReply,
    seen: CapturedBody[],
  ): typeof fetch {
    return ((url: string | URL, init?: RequestInit): Promise<Response> => {
      expect(String(url)).toBe("https://model.example.test/v1/chat/completions");
      if (typeof init?.body !== "string") throw new TypeError("expected JSON request body");
      const body = JSON.parse(init.body) as CapturedBody;
      seen.push(body);
      const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
      const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
      const scripted = respond(system, user, body.seed ?? -1);
      if (scripted.status !== 200) {
        return Promise.resolve(
          new Response('{"error":{"message":"boom"}}', { status: scripted.status }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: scripted.finishReason ?? "stop",
                message: { content: scripted.reply ?? "[]" },
              },
            ],
            ...(scripted.omitUsage
              ? {}
              : { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;
  }

  function stage(system: string): "planner" | "core" | "integration" {
    if (system.includes("risk planner")) return "planner";
    if (system.includes("focused correctness examiner")) return "core";
    if (system.includes("focused integration examiner")) return "integration";
    throw new TypeError("unexpected generation role");
  }

  it("runs planner, core and deterministic integration roles while excluding generated files", async () => {
    const { repo, pair } = await makeRepo("kfq-staged-", {
      "src/a.ts": "keep\nconst risky = input.slice(0, 8) === expected;\n",
      "src/b.ts": "const fine = 1;\n",
      "src/generated/bundle.ts": "generated noise\n",
    });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub((system, user) => {
      const kind = stage(system);
      if (kind === "planner") {
        return {
          status: 200,
          reply:
            '[{"start":2,"end":2,"lens":"security","hypothesis":"Check full-token equality."}]',
        };
      }
      if (kind === "core" && user.includes("<current_file_path>src/a.ts</current_file_path>")) {
        return { status: 200, reply: claim() };
      }
      return { status: 200, reply: "[]" };
    }, seen);

    const diagnostics = createSilentDiagnostics();
    const output = await runSingleShotEngine(
      options(pair, {
        repositoryPath: repo,
        expectedReviewablePaths: ["src/a.ts", "src/b.ts"],
        changeIntent: "Keep the gateway parser backward compatible.",
        contextPacks: new Map([["src/a.ts", "<repository_context>\nctx\n</repository_context>"]]),
      }),
      diagnostics,
      fetchImpl,
    );

    expect(seen).toHaveLength(6); // three roles for each of the two companion files
    expect(seen.every((body) => body.max_completion_tokens === GENERATION_COMPLETION_LIMIT)).toBe(
      true,
    );
    const planner = seen.find((body) => stage(body.messages?.[0]?.content ?? "") === "planner");
    expect(planner?.messages?.[0]?.content).toContain("## What to report");
    expect(planner?.messages?.[0]?.content).toContain('"include"');
    expect(planner?.messages?.[0]?.content).toContain('"merge_system_rule": false');
    expect(planner?.messages?.[1]?.content).toContain("<current_file_diff>");
    expect(planner?.messages?.[1]?.content).not.toContain("<current_file>");
    expect(planner?.messages?.[1]?.content).toContain("--- stated purpose begins ---");
    const core = seen.find(
      (body) =>
        stage(body.messages?.[0]?.content ?? "") === "core" &&
        (body.messages?.[1]?.content ?? "").includes("src/a.ts"),
    );
    expect(core?.messages?.[0]?.content).not.toContain("## What to report");
    expect(core?.messages?.[1]?.content).toContain("<untrusted_risk_map_json>");
    expect(core?.messages?.[1]?.content).toContain("<current_file>");

    const parsed = parseEngineResult(output.stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.filesReviewed).toBe(2);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.content).toContain("unauthenticated caller");
    expect(output.wireTokens).toBe(660);
    expect(
      diagnostics.drain().find((record) => record.code === "model.usage")?.counts
        ?.context_pack_injected,
    ).toBe(1);
  });

  it("dispatches the inventory's exact set: deletion-critical included, binary and submodule excluded", async () => {
    const { repo, pair } = await makeStructuralRepo();
    const profile = compileProfile({
      version: 1,
      reviewRelevant: ["src/**"],
      deletionCritical: ["tests/**"],
      generated: [],
      excluded: [],
      benignWarnings: [],
      pathInstructions: [],
    } satisfies ReviewProfile);
    const diagnostics = createSilentDiagnostics();
    const inventory = await buildInventory(
      { cwd: repo, timeoutMs: 30_000, pathValue: "/usr/bin:/bin" },
      profile,
      pair,
      CONFIG.renameDetectionPercent,
      diagnostics,
    );
    expect(inventory.reviewablePaths).toEqual(new Set(["src/a.ts", "tests/guard.txt"]));

    const seen: CapturedBody[] = [];
    const output = await runSingleShotEngine(
      options(pair, {
        repositoryPath: repo,
        profile,
        expectedReviewablePaths: [...inventory.reviewablePaths],
      }),
      diagnostics,
      fetchStub(() => ({ status: 200, reply: "[]" }), seen),
    );

    const promptText = seen
      .flatMap((body) => body.messages ?? [])
      .map((message) => message.content)
      .join("\n");
    expect(promptText).toContain("<current_file_path>src/a.ts</current_file_path>");
    expect(promptText).toContain("<current_file_path>tests/guard.txt</current_file_path>");
    expect(promptText).not.toContain("<current_file_path>src/logo.bin</current_file_path>");
    expect(promptText).not.toContain("<current_file_path>src/vendor</current_file_path>");

    const parsed = parseEngineResult(output.stdout);
    expect(parsed.manifestPresent).toBe(true);
    expect(parsed.terminalState).toBe("complete");
    expect(parsed.coverage.selected.map((entry) => entry.path)).toEqual([
      "src/a.ts",
      "tests/guard.txt",
    ]);
    expect(parsed.coverage.completed.map((entry) => entry.path)).toEqual([
      "src/a.ts",
      "tests/guard.txt",
    ]);
  });

  it("does not let an extra changed path mask an expected path with no diff fragment", async () => {
    const { repo, pair } = await makeRepo("kfq-exact-missing-", {
      "src/a.ts": "changed a\n",
      "src/b.ts": "changed but not expected\n",
    });
    const seen: CapturedBody[] = [];
    const output = await runSingleShotEngine(
      options(pair, {
        repositoryPath: repo,
        expectedReviewablePaths: ["src/a.ts", "src/missing.ts"],
      }),
      createSilentDiagnostics(),
      fetchStub(() => ({ status: 200, reply: "[]" }), seen),
    );
    const parsed = parseEngineResult(output.stdout);

    expect(parsed.filesReviewed).toBe(1);
    expect(parsed.terminalState).toBe("partial");
    expect(parsed.coverage.selected.map((entry) => entry.path)).toEqual([
      "src/a.ts",
      "src/missing.ts",
    ]);
    expect(parsed.coverage.completed.map((entry) => entry.path)).toEqual(["src/a.ts"]);
    expect(parsed.coverage.failed.map((entry) => entry.path)).toEqual(["src/missing.ts"]);
    expect(
      seen.some((body) =>
        body.messages?.some((message) =>
          message.content.includes("<current_file_path>src/b.ts</current_file_path>"),
        ),
      ),
    ).toBe(false);
  });

  it("shows trusted merge-base guidance to the planner only", async () => {
    const { repo, pair } = await makeRepo("kfq-trusted-guidance-", {
      "src/a.ts": "keep\nexport const changedContract = 1;\n",
    });
    const trustedGuidance = [
      "<<<KQ_TRUSTED_BASE_GUIDELINES_BEGIN>>>",
      "UNIQUE_GUIDELINE_SENTINEL: reject empty tenant ids",
      "<<<KQ_TRUSTED_BASE_GUIDELINES_END>>>",
    ].join("\n");
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub(() => ({ status: 200, reply: "[]" }), seen);

    await runSingleShotEngine(
      options(pair, { repositoryPath: repo, trustedGuidance }),
      createSilentDiagnostics(),
      fetchImpl,
    );

    expect(seen.map((body) => stage(body.messages?.[0]?.content ?? ""))).toEqual([
      "planner",
      "core",
      "integration",
    ]);
    const planner = seen.find((body) => stage(body.messages?.[0]?.content ?? "") === "planner");
    expect(planner?.messages?.[0]?.content).toContain("UNIQUE_GUIDELINE_SENTINEL");
    for (const body of seen.filter(
      (candidate) => stage(candidate.messages?.[0]?.content ?? "") !== "planner",
    )) {
      expect(body.messages?.map((message) => message.content).join("\n")).not.toContain(
        "UNIQUE_GUIDELINE_SENTINEL",
      );
    }
  });

  it.each([
    ["an empty risk map", "[]"],
    ["a malformed planner reply", "not-json"],
  ])("shows matching path rules to core and integration after %s", async (_case, plannerReply) => {
    const { repo, pair } = await makeRepo("kfq-path-policy-", {
      "src/a.ts": "keep\nexport const changedContract = 1;\n",
    });
    const profile = compileProfile({
      version: 1,
      reviewRelevant: ["src/**"],
      deletionCritical: [],
      generated: [],
      excluded: [],
      benignWarnings: [],
      pathInstructions: [
        {
          paths: ["src/**"],
          instructions: "MATCHED_PATH_POLICY: reject empty tenant identifiers.",
        },
        {
          paths: ["docs/**"],
          instructions: "UNMATCHED_PATH_POLICY: require a migration note.",
        },
      ],
    } satisfies ReviewProfile);
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub(
      (system) =>
        stage(system) === "planner"
          ? { status: 200, reply: plannerReply }
          : { status: 200, reply: "[]" },
      seen,
    );

    await runSingleShotEngine(
      options(pair, { repositoryPath: repo, profile }),
      createSilentDiagnostics(),
      fetchImpl,
    );

    expect(seen.map((body) => stage(body.messages?.[0]?.content ?? ""))).toEqual([
      "planner",
      "core",
      "integration",
    ]);
    const examiners = seen.filter((body) => stage(body.messages?.[0]?.content ?? "") !== "planner");
    for (const body of examiners) {
      const system = body.messages?.[0]?.content ?? "";
      expect(system).toContain("MATCHED_PATH_POLICY: reject empty tenant identifiers.");
      expect(system).not.toContain("UNMATCHED_PATH_POLICY");
    }
  });

  it("uses fixed risk lenses when the planner is invalid and still requires the core examiner", async () => {
    const { repo, pair } = await makeRepo("kfq-fallback-", {
      "src/a.ts": "keep\nconst local = value + 1;\n",
    });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub((system, user) => {
      if (stage(system) === "planner") return { status: 200, reply: "not-json" };
      expect(user).toContain('"lens":"correctness"');
      expect(user).toContain('"lens":"boundary"');
      return { status: 200, reply: "[]" };
    }, seen);
    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );
    expect(seen.map((body) => stage(body.messages?.[0]?.content ?? ""))).toEqual([
      "planner",
      "core",
    ]);
    expect(parseEngineResult(output.stdout).status).toBe("success");
  });

  it("dispatches a complete file deletion and accepts only its numbered old-side anchor", async () => {
    const { repo, pair } = await makeRepo("kfq-deletion-", { "src/a.ts": null });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub((system, user) => {
      const kind = stage(system);
      if (kind === "planner") return { status: 200, reply: "[]" };
      if (kind === "core") {
        expect(user).toContain("1 -keep");
        expect(user).toContain("<allowed_end_anchors>1</allowed_end_anchors>");
        return { status: 200, reply: claim({ start: 1, end: 1 }) };
      }
      return { status: 200, reply: "[]" };
    }, seen);
    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );
    const parsed = parseEngineResult(output.stdout);
    expect(parsed.filesReviewed).toBe(1);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.path).toBe("src/a.ts");
    expect(seen.map((body) => stage(body.messages?.[0]?.content ?? ""))).toEqual([
      "planner",
      "core",
      "integration",
    ]);
  });

  it("turns a failed core examiner into an honest subtask_error after one transport retry", async () => {
    const { repo, pair } = await makeRepo("kfq-core-fail-", { "src/a.ts": "new local\n" });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub(
      (system) => (stage(system) === "planner" ? { status: 200, reply: "[]" } : { status: 503 }),
      seen,
    );
    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );
    const parsed = parseEngineResult(output.stdout);
    expect(parsed.status).toBe("completed_with_errors");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]?.file).toBe("src/a.ts");
    expect(seen).toHaveLength(3); // planner + two core attempts
    expect(output.wireTokens).toBeGreaterThan(110); // unknown retry spend is conservatively charged
  });

  it("reports an atomically blocked generation budget through the engine result contract", async () => {
    const { repo, pair } = await makeRepo("kfq-budget-blocked-", {
      "src/a.ts": "keep\nconst local = 1;\n",
    });
    let calls = 0;
    const diagnostics = createSilentDiagnostics();
    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo, allottedBudget: 0 }),
      diagnostics,
      (() => {
        calls += 1;
        return Promise.reject(new Error("a blocked request must not reach the endpoint"));
      }) as typeof fetch,
    );

    const wire = JSON.parse(output.stdout) as {
      status?: unknown;
      summary?: { budget_exceeded?: unknown };
    };
    expect(wire.status).toBe("budget_exceeded");
    expect(wire.summary?.budget_exceeded).toBe(true);
    expect(calls).toBe(0);
    expect(output.wireTokens).toBe(0);

    const parsed = parseEngineResult(output.stdout);
    expect(parsed.status).toBe("budget_exceeded");
    expect(parsed.budgetExceeded).toBe(true);
    expect(parsed.terminalState).toBe("partial");
    expect(
      diagnostics.drain().find((record) => record.code === "model.usage")?.counts?.budget_blocked,
    ).toBeGreaterThan(0);
  });

  it("keeps a planner-only budget fallback complete when the mandatory examiner still runs", async () => {
    const { repo, pair } = await makeRepo("kfq-planner-budget-fallback-", {
      "src/a.ts": "keep\nconst local = 1;\n",
    });
    const probeSeen: CapturedBody[] = [];
    await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchStub(
        (system) =>
          stage(system) === "planner"
            ? { status: 200, reply: "not-json" }
            : { status: 200, reply: "[]" },
        probeSeen,
      ),
    );
    expect(probeSeen).toHaveLength(2);
    const requestBound = (body: CapturedBody): number => {
      const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
      const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
      return generationRequestUpperBound(system, user);
    };
    const plannerBound = requestBound(probeSeen[0] ?? {});
    const coreBound = requestBound(probeSeen[1] ?? {});
    expect(plannerBound).toBeGreaterThan(coreBound);

    const seen: CapturedBody[] = [];
    const diagnostics = createSilentDiagnostics();
    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo, allottedBudget: coreBound }),
      diagnostics,
      fetchStub(() => ({ status: 200, reply: "[]" }), seen),
    );

    expect(seen).toHaveLength(1);
    expect(stage(seen[0]?.messages?.[0]?.content ?? "")).toBe("core");
    const parsed = parseEngineResult(output.stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.budgetExceeded).toBe(false);
    expect(parsed.terminalState).toBe("complete");
    expect(
      diagnostics.drain().find((record) => record.code === "model.usage")?.counts?.budget_blocked,
    ).toBe(1);
  });

  it("honors the configured review deadline before starting any model request", async () => {
    const { repo, pair } = await makeRepo("kfq-review-deadline-", {
      "src/a.ts": "keep\nconst local = 1;\n",
    });
    let calls = 0;
    await expect(
      runSingleShotEngine(
        options(pair, { repositoryPath: repo, reviewDeadlineMs: Date.now() - 1 }),
        createSilentDiagnostics(),
        (() => {
          calls += 1;
          return Promise.reject(new Error("deadline should stop before fetch"));
        }) as typeof fetch,
      ),
    ).rejects.toMatchObject({ reason: "engine.run.timeout" });
    expect(calls).toBe(0);
  });

  it("shows the whole file to the examiner but never to the risk planner", async () => {
    const guarded = [
      "export function parse(raw: string): string | undefined {",
      "  if (raw === '') return undefined;",
      "  return raw;",
      "}",
      "const local = parse('x');",
    ].join("\n");
    const { repo, pair } = await makeRepo("kfq-whole-staged-", { "src/a.ts": `${guarded}\n` });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub(() => ({ status: 200, reply: "[]" }), seen);
    await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );
    const planner = seen.find((body) => stage(body.messages?.[0]?.content ?? "") === "planner");
    const core = seen.find((body) => stage(body.messages?.[0]?.content ?? "") === "core");
    expect(planner?.messages?.[1]?.content).not.toContain("<current_file>");
    expect(core?.messages?.[1]?.content).toContain("<current_file>");
    expect(core?.messages?.[1]?.content).toContain("2+  if (raw === '') return undefined;");
  });

  it("does not run the old fail-open whole-file verifier on hunk fallback", async () => {
    const oversized = `const local = 1;\n// ${"pad ".repeat(25_000)}\n`;
    const { repo, pair } = await makeRepo("kfq-no-old-verify-", { "src/a.ts": oversized });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub((system) => {
      if (stage(system) === "planner") return { status: 200, reply: "[]" };
      if (stage(system) === "core") {
        return {
          status: 200,
          reply: claim({
            start: 1,
            end: 1,
            condition: "the local value is consumed",
            defect: "the changed value is wrong",
            consequence: "the consumer receives the wrong result",
            categoryHint: "bug",
            severityHint: "medium",
          }),
        };
      }
      return { status: 200, reply: "[]" };
    }, seen);
    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );
    expect(seen.every((body) => !(body.messages?.[1]?.content ?? "").includes("<claims>"))).toBe(
      true,
    );
    expect(parseEngineResult(output.stdout).findings).toHaveLength(1);
  });

  it("runs one integration examiner for a heavy change and unions its distinct claim", async () => {
    const bigBody = Array.from(
      { length: 160 },
      (_, index) => `const line${String(index)} = ${String(index)};`,
    ).join("\n");
    const { repo, pair } = await makeRepo("kfq-integration-", { "src/a.ts": `${bigBody}\n` });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub((system) => {
      const kind = stage(system);
      if (kind === "planner") return { status: 200, reply: "[]" };
      if (kind === "core") {
        return {
          status: 200,
          reply: claim({ start: 3, end: 3, categoryHint: "bug", severityHint: "high" }),
        };
      }
      return {
        status: 200,
        reply: claim({
          start: 9,
          end: 9,
          condition: "the new API is called from the existing consumer",
          defect: "the changed contract omits the required field",
          consequence: "the consumer rejects every response",
          categoryHint: "bug",
          severityHint: "medium",
        }),
      };
    }, seen);
    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );
    expect(seen.map((body) => body.seed)).toEqual([42, 1042, 2042]);
    expect(parseEngineResult(output.stdout).findings).toHaveLength(2);
  });

  it("never rewrites a sanitizer-rejected deterministic body with a fourth model role", async () => {
    const { repo, pair } = await makeRepo("kfq-no-repair-", {
      "src/a.ts": "const local = 1;\n",
    });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub((system) => {
      const kind = stage(system);
      if (kind === "planner") return { status: 200, reply: "[]" };
      if (kind === "core") {
        return {
          status: 200,
          reply: claim({
            start: 1,
            end: 1,
            condition: "the command receives <path>",
            defect: "the changed argument is interpreted as markup",
            consequence: "the review body is rejected",
            categoryHint: "bug",
            severityHint: "medium",
          }),
        };
      }
      return { status: 200, reply: "[]" };
    }, seen);
    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );
    expect(seen.map((body) => stage(body.messages?.[0]?.content ?? ""))).toEqual([
      "planner",
      "core",
      "integration",
    ]);
    const body = parseEngineResult(output.stdout).findings[0]?.content ?? "";
    expect(body).toContain("<path>");
    expect(sanitizeFindingBody(body).ok).toBe(false);
    expect(output.wireTokens).toBe(330);
  });
});
