import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import { commitSha } from "../core/brands.js";
import { createSilentDiagnostics } from "../diagnostics/sink.js";
import { mergeBase, type GitContext } from "../git/plumbing.js";
import { buildInventory, mechanicallyCleanPaths, resolveReviewPair } from "./inventory.js";

/**
 * Exercised against a real repository, for the same reason `plumbing.test.ts` is: the pure-rename
 * downgrade rests on git's own object-id and rename-detection behaviour, not on an assumption this
 * file would otherwise only be testing against itself.
 */
let repo: string;
let ctx: GitContext;
let baseSha: string;
let headSha: string;

function git(args: readonly string[], cwd: string): string {
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

const PROFILE: ReviewProfile = {
  version: 1,
  reviewRelevant: ["src/**/*.ts"],
  deletionCritical: [],
  generated: [],
  excluded: [],
  benignWarnings: [],
};

const compiled = compileProfile(PROFILE);

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "kfq-inventory-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["commit", "--allow-empty", "-q", "-m", "root", "--no-gpg-sign"], repo);

  await mkdir(join(repo, "src"), { recursive: true });
  // 20 identical lines: substantial enough content for git's own rename detector to recognize the
  // move at any realistic similarity threshold once it is renamed without being touched.
  await writeFile(join(repo, "src/old-name.ts"), "export const shared = 1;\n".repeat(20));
  await writeFile(join(repo, "src/edited.ts"), "export const edited = 1;\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "base", "--no-gpg-sign"], repo);
  baseSha = git(["rev-parse", "HEAD"], repo).trim();

  git(["mv", "src/old-name.ts", "src/new-name.ts"], repo);
  await writeFile(join(repo, "src/edited.ts"), "export const edited = 2;\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "head", "--no-gpg-sign"], repo);
  headSha = git(["rev-parse", "HEAD"], repo).trim();

  ctx = { cwd: repo, timeoutMs: 30_000, pathValue: process.env.PATH ?? "/usr/bin:/bin" };
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("buildInventory: the pure-rename prefilter end to end", () => {
  it("downgrades the untouched rename and leaves the edited file reviewable", async () => {
    const pair = await resolveReviewPair(ctx, commitSha(baseSha), commitSha(headSha));
    const inventory = await buildInventory(ctx, compiled, pair, 50, createSilentDiagnostics());

    expect(inventory.items).toHaveLength(2);
    expect(inventory.reviewablePaths).toEqual(new Set(["src/edited.ts"]));
    expect(mechanicallyCleanPaths(inventory)).toEqual(["src/new-name.ts"]);
  });

  it("records the mechanically_clean_pure_rename bucket in the completed-inventory diagnostic", async () => {
    const pair = await resolveReviewPair(ctx, commitSha(baseSha), commitSha(headSha));
    const diagnostics = createSilentDiagnostics();
    await buildInventory(ctx, compiled, pair, 50, diagnostics);

    const completed = diagnostics.drain().find((record) => record.code === "inventory.completed");
    expect(completed?.counts?.mechanically_clean_pure_rename).toBe(1);
    expect(completed?.counts?.reviewable).toBe(1);
    expect(completed?.counts?.total).toBe(2);
  });

  it("computes the merge base the same way the review pair does", async () => {
    // Confirms this fixture's pair is the ordinary fast-forward case, not an artifact of history
    // shaped specially for this test.
    const base = await mergeBase(ctx, commitSha(baseSha), commitSha(headSha));
    expect(base).toBe(baseSha);
  });
});
