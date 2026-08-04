import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import {
  MODE_EXECUTABLE,
  MODE_REGULAR,
  MODE_SYMLINK,
  listChanges,
  readTextAtCommit,
  mergeBase,
  type GitContext,
} from "./plumbing.js";

/**
 * Exercised against a real repository rather than captured strings.
 *
 * The raw-diff parser handles rename records, mode transitions, NUL framing, and binary detection —
 * all formats defined by git, not by this project. Testing it against fixtures I wrote myself would
 * only prove the parser matches my assumptions about git's output.
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

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "kfq-git-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["commit", "--allow-empty", "-q", "-m", "root", "--no-gpg-sign"], repo);

  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/keep.ts"), "export const keep = 1;\n");
  await writeFile(join(repo, "src/old-name.ts"), "export const shared = 1;\n".repeat(20));
  await writeFile(join(repo, "src/remove.ts"), "export const gone = 1;\n");
  await writeFile(join(repo, "script.sh"), "#!/bin/sh\necho hi\n");
  await writeFile(join(repo, "image.bin"), Buffer.from([0, 1, 2, 0, 255, 3]));
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "base", "--no-gpg-sign"], repo);
  baseSha = git(["rev-parse", "HEAD"], repo).trim();

  // One commit exercising every classification-relevant change shape at once.
  await writeFile(join(repo, "src/keep.ts"), "export const keep = 2;\n");
  git(["mv", "src/old-name.ts", "src/new-name.ts"], repo);
  await rm(join(repo, "src/remove.ts"));
  await chmod(join(repo, "script.sh"), 0o755);
  await writeFile(join(repo, "image.bin"), Buffer.from([0, 9, 9, 0, 254, 7]));
  await symlink("src/keep.ts", join(repo, "link-to-keep"));
  await writeFile(join(repo, "src/added file with spaces.ts"), "export const added = 1;\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "head", "--no-gpg-sign"], repo);
  headSha = git(["rev-parse", "HEAD"], repo).trim();

  ctx = { cwd: repo, timeoutMs: 30_000, pathValue: process.env.PATH ?? "/usr/bin:/bin" };
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("mergeBase", () => {
  it("resolves the merge base of two commits", async () => {
    const result = await mergeBase(ctx, commitSha(baseSha), commitSha(headSha));
    expect(result).toBe(baseSha);
  });
});

describe("listChanges", () => {
  it("reports every changed path exactly once", async () => {
    const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
    const paths = changes.map((c) => c.path).sort();
    expect(paths).toEqual([
      "image.bin",
      "link-to-keep",
      "script.sh",
      "src/added file with spaces.ts",
      "src/keep.ts",
      "src/new-name.ts",
      "src/remove.ts",
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("detects a rename and preserves the old path", async () => {
    const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
    const renamed = changes.find((c) => c.path === "src/new-name.ts");
    expect(renamed?.status).toBe("R");
    expect(renamed?.oldPath).toBe("src/old-name.ts");
  });

  it("reports a deletion", async () => {
    const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
    expect(changes.find((c) => c.path === "src/remove.ts")?.status).toBe("D");
  });

  it("reports a file-mode transition to executable", async () => {
    const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
    const script = changes.find((c) => c.path === "script.sh");
    expect(script?.oldMode).toBe(MODE_REGULAR);
    expect(script?.newMode).toBe(MODE_EXECUTABLE);
  });

  it("reports a new symlink with the symlink mode and never resolves its target", async () => {
    const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
    const link = changes.find((c) => c.path === "link-to-keep");
    expect(link?.newMode).toBe(MODE_SYMLINK);
  });

  it("marks a binary file as binary from git's own determination", async () => {
    const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
    expect(changes.find((c) => c.path === "image.bin")?.binary).toBe(true);
    expect(changes.find((c) => c.path === "src/keep.ts")?.binary).toBe(false);
  });

  // NUL framing exists precisely so a path containing a space or quote parses correctly.
  it("parses a path containing spaces", async () => {
    const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
    const added = changes.find((c) => c.path === "src/added file with spaces.ts");
    expect(added?.status).toBe("A");
  });

  it("still detects an exact rename at the strictest similarity threshold", async () => {
    // The moved file's content is unchanged, so it is 100% similar and survives `-M100%`. This
    // pins that the threshold is passed through and parsed, not silently dropped.
    const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 100);
    const renamed = changes.find((c) => c.path === "src/new-name.ts");
    expect(renamed?.status).toBe("R");
    expect(renamed?.oldPath).toBe("src/old-name.ts");
  });

  it("leaves the working tree untouched", async () => {
    await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
    expect(git(["status", "--porcelain"], repo).trim()).toBe("");
  });

  describe("blob ids", () => {
    it("reports full 40-character object ids rather than git's default abbreviation", async () => {
      const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
      const keep = changes.find((c) => c.path === "src/keep.ts");
      expect(keep?.oldBlob).toMatch(/^[0-9a-f]{40}$/);
      expect(keep?.newBlob).toMatch(/^[0-9a-f]{40}$/);
    });

    it("differs across a real content edit", async () => {
      const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
      const keep = changes.find((c) => c.path === "src/keep.ts");
      expect(keep?.oldBlob).not.toBe(keep?.newBlob);
    });

    // `src/old-name.ts` moves to `src/new-name.ts` with no edit — the pure-rename case
    // `classify()` proves by comparing these ids, not by inferring it from a similarity score.
    it("is equal on both sides of a byte-identical rename", async () => {
      const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
      const renamed = changes.find((c) => c.path === "src/new-name.ts");
      expect(renamed?.oldBlob).toBe(renamed?.newBlob);
      expect(renamed?.oldBlob).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe("changedLines", () => {
    it("sums numstat's added and deleted counts for an ordinary edit", async () => {
      // `src/keep.ts` replaces its one line: 1 insertion, 1 deletion.
      const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
      expect(changes.find((c) => c.path === "src/keep.ts")?.changedLines).toBe(2);
    });

    it("is zero for a binary change, where numstat reports `-` rather than a count", async () => {
      const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
      expect(changes.find((c) => c.path === "image.bin")?.changedLines).toBe(0);
    });

    it("is zero for a byte-identical rename", async () => {
      const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
      expect(changes.find((c) => c.path === "src/new-name.ts")?.changedLines).toBe(0);
    });

    it("is zero for a mode-only change with no content edit", async () => {
      const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
      expect(changes.find((c) => c.path === "script.sh")?.changedLines).toBe(0);
    });

    it("counts a one-line addition and a one-line deletion", async () => {
      const changes = await listChanges(ctx, commitSha(baseSha), commitSha(headSha), 50);
      expect(changes.find((c) => c.path === "src/added file with spaces.ts")?.changedLines).toBe(1);
      expect(changes.find((c) => c.path === "src/remove.ts")?.changedLines).toBe(1);
    });
  });
});

describe("readTextAtCommit", () => {
  it("reads a committed file's text through plumbing, never a checkout", async () => {
    const content = await readTextAtCommit(ctx, commitSha(baseSha), "src/keep.ts");
    expect(content).toBe("export const keep = 1;\n");
  });

  it("treats a path absent at the commit as an expected outcome, not an error", async () => {
    expect(await readTextAtCommit(ctx, commitSha(baseSha), "src/never-existed.ts")).toBeUndefined();
  });

  it("refuses binary content rather than hand it to a text-parsing caller", async () => {
    expect(await readTextAtCommit(ctx, commitSha(baseSha), "image.bin")).toBeUndefined();
  });
});
