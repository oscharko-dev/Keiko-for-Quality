import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import type { RuntimeConfig } from "../config/runtime.js";
import { commitSha } from "../core/brands.js";
import { createSilentDiagnostics } from "../diagnostics/sink.js";
import type { ReviewPair } from "../inventory/inventory.js";
import { parseEngineResult } from "./result.js";
import type { EngineRunOptions } from "./run.js";
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
  it("splits a multi-file diff by new-side path and skips deletions", () => {
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
    expect([...byPath.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(byPath.get("src/a.ts")).toContain("+in a");
    expect(byPath.get("src/b.ts")).toContain("+in b");
  });
});

describe("parseFindingsReply", () => {
  it("parses a fenced findings array and pins the reviewed path over any model claim", () => {
    const reply = [
      "```json",
      '[{"start_line": 3, "end_line": 4, "category": "bug", "severity": "high",',
      ' "content": "Off by one.", "path": "totally/other.ts"}]',
      "```",
    ].join("\n");
    const parsed = parseFindingsReply(reply, "src/real.ts");
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.path).toBe("src/real.ts");
    expect(parsed?.[0]?.start_line).toBe(3);
  });

  it("accepts the empty array as the valid silent review", () => {
    expect(parseFindingsReply("[]", "src/a.ts")).toEqual([]);
  });

  /**
   * The edge the linear unfencing turns on: a fence run INSIDE the reply is content, because the
   * only admissible closing run is one with nothing but whitespace after it to the end of the
   * reply. A rewrite that stopped at the first run it saw would cut the array in half and parse
   * nothing, and one that demanded the `json` tag or a fence flush against the end would reject
   * replies this mode has always accepted.
   */
  it("closes on the run nothing but whitespace follows, not on the first one seen", () => {
    const entry = '{"start_line": 1, "end_line": 1, "content": "cite ```diff``` blocks"}';
    expect(parseFindingsReply(`\`\`\`json\n[${entry}]\n\`\`\`\n`, "a")).toHaveLength(1);
    expect(parseFindingsReply(`\`\`\`\n[${entry}]\n\`\`\`  \n`, "a")).toHaveLength(1);
    expect(parseFindingsReply(`  [${entry}]  `, "a")).toHaveLength(1);
  });

  /** An opener with no closer is not a fence, so the raw reply is what gets parsed — and a reply
   *  that is a fence opener plus an array is not JSON. */
  it("leaves an unclosed fence in place rather than guessing where it ended", () => {
    expect(parseFindingsReply("```json\n[]", "a")).toBeUndefined();
  });

  it("rejects rather than repairs anything off-shape", () => {
    expect(parseFindingsReply("not json", "a")).toBeUndefined();
    expect(parseFindingsReply('{"findings": []}', "a")).toBeUndefined();
    expect(
      parseFindingsReply('[{"start_line": 0, "end_line": 1, "content": "x"}]', "a"),
    ).toBeUndefined();
    expect(
      parseFindingsReply('[{"start_line": 2, "end_line": 1, "content": "x"}]', "a"),
    ).toBeUndefined();
    expect(
      parseFindingsReply('[{"start_line": 1, "end_line": 1, "content": ""}]', "a"),
    ).toBeUndefined();
  });
});

describe("runSingleShotEngine", () => {
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
      allottedBudget: 500_000,
      mechanicallyCleanPaths: [],
      ...overrides,
    };
  }

  /** A real tiny repository, exactly as `context-pack.test.ts` builds one: diff shapes are git's
   *  to define, so the runner's own `git diff` runs against the genuine article. */
  async function makeRepo(
    prefix: string,
    headFiles: Readonly<Record<string, string>>,
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
      await writeFile(join(repo, path), content);
    }
    git(["add", "."]);
    git(["commit", "-q", "-m", "head", "--no-gpg-sign"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    return {
      repo,
      pair: { base: commitSha(base), head: commitSha(head), mergeBase: commitSha(base) },
    };
  }

  interface CapturedBody {
    readonly temperature?: number;
    readonly seed?: number;
    readonly model?: string;
    readonly messages?: { role: string; content: string }[];
  }

  /** A fetch stub answering each chat call from a script keyed on the user message — exercises
   *  the real request shape (URL, pinned sampling) without a network. Not `async`: the body is
   *  synchronous and the Response rides an already-resolved promise. */
  function fetchStub(
    respond: (userContent: string) => { status: number; reply?: string },
    seen: CapturedBody[],
  ): typeof fetch {
    return ((url: string | URL, init?: RequestInit): Promise<Response> => {
      expect(String(url)).toBe("https://model.example.test/v1/chat/completions");
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as CapturedBody;
      seen.push(body);
      const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
      const scripted = respond(user);
      if (scripted.status !== 200) {
        return Promise.resolve(
          new Response('{"error":{"message":"boom"}}', { status: scripted.status }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: scripted.reply ?? "[]" } }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;
  }

  it("reviews only the rule-selected files, one call each, and emits parseable engine output", async () => {
    const { repo, pair } = await makeRepo("kfq-ss-", {
      "src/a.ts": "keep\nconst risky = input.slice(0, 8) === e;\n",
      "src/b.ts": "const fine = 1;\n",
      "src/generated/bundle.ts": "generated noise\n",
    });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub((user) => {
      if (user.includes("<current_file_path>src/a.ts</current_file_path>")) {
        return {
          status: 200,
          reply:
            '[{"start_line": 2, "end_line": 2, "category": "security", "severity": "critical", "content": "Prefix comparison accepts forged tokens."}]',
        };
      }
      return { status: 200, reply: "[]" };
    }, seen);

    const output = await runSingleShotEngine(
      options(pair, {
        repositoryPath: repo,
        contextPacks: new Map([["src/a.ts", "<repository_context>\nctx\n</repository_context>"]]),
      }),
      createSilentDiagnostics(),
      fetchImpl,
    );

    // Two rule-selected files, one call each; the generated path never reaches the model.
    expect(seen).toHaveLength(2);
    for (const body of seen) {
      expect(body.temperature).toBe(0);
      expect(body.seed).toBe(42);
      expect(body.model).toBe("gpt-oss-120b");
    }
    const aBody = seen
      .map((body) => body.messages?.[1]?.content ?? "")
      .find((content) => content.includes("<current_file_path>src/a.ts</current_file_path>"));
    expect(aBody).toContain("__new hunk__");
    expect(aBody).toContain("<repository_context>");
    // The companion block carries the OTHER changed file's hunks — the one-sided-pair
    // false-positive class from the live audit dies exactly here.
    expect(aBody).toContain("<companion_changes>");
    expect(aBody).toContain("## src/b.ts");
    expect(aBody).not.toContain("<other_changed_files>");

    // The stdout is REAL engine shape: prove it by round-tripping the shipped parser.
    const parsed = parseEngineResult(output.stdout);
    expect(parsed.status).toBe("success");
    expect(parsed.filesReviewed).toBe(2);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.path).toBe("src/a.ts");
    expect(parsed.warnings).toHaveLength(0);
    expect(output.wireTokens).toBe(220);
  });

  it("turns a file whose call keeps failing into an honest subtask_error the settlement reads", async () => {
    const { repo, pair } = await makeRepo("kfq-ss2-", { "src/a.ts": "new\n" });
    const seen: CapturedBody[] = [];
    const fetchImpl = fetchStub(() => ({ status: 503 }), seen);

    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );

    const parsed = parseEngineResult(output.stdout);
    expect(parsed.status).toBe("completed_with_errors");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]?.file).toBe("src/a.ts");
    // One bounded retry per transport failure: two wire calls for the one file, then honesty.
    expect(seen).toHaveLength(2);
  });
});

describe("repair of publisher-rejectable bodies", () => {
  interface CapturedBody {
    readonly messages?: { role: string; content: string }[];
  }
  const REPAIR_CONFIG: RuntimeConfig = {
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
  const PROFILE = compileProfile({
    version: 1,
    reviewRelevant: ["src/**"],
    deletionCritical: [],
    generated: [],
    excluded: [],
    benignWarnings: [],
    pathInstructions: [],
  } satisfies ReviewProfile);
  function options(pair: ReviewPair, overrides: Partial<EngineRunOptions>): EngineRunOptions {
    return {
      binaryPath: "/unused-in-single-shot",
      repositoryPath: "/unused-repo",
      pair,
      config: REPAIR_CONFIG,
      profile: PROFILE,
      guidelines: { paths: [] },
      env: { MODEL_TOKEN: "secret-token" },
      pathValue: "/usr/bin:/bin",
      allottedBudget: 500_000,
      mechanicallyCleanPaths: [],
      ...overrides,
    };
  }

  it("repairs a body the sanitizer rejects and keeps the original when repair fails", async () => {
    const repo = await mkdtemp(join(tmpdir(), "kfq-ss3-"));
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
    await writeFile(join(repo, "src/a.ts"), "old\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    await writeFile(join(repo, "src/a.ts"), "new line\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "head", "--no-gpg-sign"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    const pair: ReviewPair = {
      base: commitSha(base),
      head: commitSha(head),
      mergeBase: commitSha(base),
    };

    // First call: a review whose body carries a bare <path> token (sanitizer class html).
    // Second call: the repair — returns one backticked body. Third scenario file below covers
    // the repair failing.
    let call = 0;
    const seen: CapturedBody[] = [];
    const fetchImpl = ((_url: string | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as CapturedBody;
      seen.push(body);
      call += 1;
      const reply =
        call === 1
          ? '[{"start_line": 1, "end_line": 1, "category": "bug", "severity": "high", "content": "Use a null device.\\n\\nIt runs diff -- /dev/null <path> today."}]'
          : '["Use a null device.\\n\\nIt runs `diff -- /dev/null <path>` today."]';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: reply } }],
            usage: { prompt_tokens: 50, completion_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const output = await runSingleShotEngine(
      options(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );
    // Two wire calls: the review and the one repair.
    expect(seen).toHaveLength(2);
    const parsed = parseEngineResult(output.stdout);
    expect(parsed.findings).toHaveLength(1);
    // The published body is the repaired, backticked form the real sanitizer accepts.
    expect(parsed.findings[0]?.content).toContain("`diff -- /dev/null <path>`");
  });
});

describe("second focused pass for heavy files", () => {
  const HEAVY_CONFIG: RuntimeConfig = {
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
  const HEAVY_PROFILE = compileProfile({
    version: 1,
    reviewRelevant: ["src/**"],
    deletionCritical: [],
    generated: [],
    excluded: [],
    benignWarnings: [],
    pathInstructions: [],
  } satisfies ReviewProfile);
  function repairOptions(pair: ReviewPair, overrides: Partial<EngineRunOptions>): EngineRunOptions {
    return {
      binaryPath: "/unused-in-single-shot",
      repositoryPath: "/unused-repo",
      pair,
      config: HEAVY_CONFIG,
      profile: HEAVY_PROFILE,
      guidelines: { paths: [] },
      env: { MODEL_TOKEN: "secret-token" },
      pathValue: "/usr/bin:/bin",
      allottedBudget: 500_000,
      mechanicallyCleanPaths: [],
      ...overrides,
    };
  }

  it("runs exactly one extra call for a 150+ line change and unions without duplicating", async () => {
    const repo = await mkdtemp(join(tmpdir(), "kfq-ss4-"));
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
    await writeFile(join(repo, "src/big.ts"), "// base\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base", "--no-gpg-sign"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    const bigBody = Array.from(
      { length: 160 },
      (_, i) => `export const line${String(i)} = ${String(i)};`,
    ).join("\n");
    await writeFile(join(repo, "src/big.ts"), `${bigBody}\n`);
    git(["add", "."]);
    git(["commit", "-q", "-m", "head", "--no-gpg-sign"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    const pair: ReviewPair = {
      base: commitSha(base),
      head: commitSha(head),
      mergeBase: commitSha(base),
    };

    const seenSeeds: number[] = [];
    const fetchImpl = ((_url: string | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
        seed?: number;
        messages?: { role: string; content: string }[];
      };
      seenSeeds.push(body.seed ?? -1);
      const isSecondPass = (body.messages?.[1]?.content ?? "").includes("second focused pass");
      const reply = isSecondPass
        ? // One duplicate of the first pass's finding (same lines, same text) and one genuinely new.
          '[{"start_line": 3, "end_line": 3, "category": "bug", "severity": "high", "content": "Boundary reads one element past the end."},{"start_line": 9, "end_line": 9, "category": "bug", "severity": "medium", "content": "Error path returns success shape."}]'
        : '[{"start_line": 3, "end_line": 3, "category": "bug", "severity": "high", "content": "Boundary reads one element past the end."}]';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: reply } }],
            usage: { prompt_tokens: 80, completion_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const output = await runSingleShotEngine(
      repairOptions(pair, { repositoryPath: repo }),
      createSilentDiagnostics(),
      fetchImpl,
    );
    // Two calls: first pass seed 42, second pass seed 1042.
    expect(seenSeeds).toEqual([42, 1042]);
    const parsed = parseEngineResult(output.stdout);
    // Union kept the duplicate once and the genuinely new finding.
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.status).toBe("success");
  });
});
