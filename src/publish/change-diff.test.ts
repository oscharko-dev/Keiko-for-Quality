import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import { run } from "../git/exec.js";
import { readChangeUnifiedDiff } from "./change-diff.js";

const repositories: string[] = [];
const pathValue = process.env.PATH ?? "/usr/bin:/bin";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await run("git", args, {
    cwd,
    timeoutMs: 10_000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: pathValue,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
    },
  });
  return result.stdout.toString("utf8").trim();
}

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "kfq-change-diff-"));
  repositories.push(cwd);
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.name", "Keiko Test"]);
  await git(cwd, ["config", "user.email", "keiko@example.invalid"]);
  return cwd;
}

async function commit(cwd: string, message: string): Promise<ReturnType<typeof commitSha>> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", message]);
  return commitSha(await git(cwd, ["rev-parse", "HEAD"]));
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe("readChangeUnifiedDiff", () => {
  it("reads an exact bounded modification diff", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "review.ts"), "export const value = 1;\n", "utf8");
    const base = await commit(cwd, "base");
    await writeFile(join(cwd, "review.ts"), "export const value = 2;\n", "utf8");
    const head = await commit(cwd, "head");

    const diff = await readChangeUnifiedDiff({
      repositoryPath: cwd,
      pathValue,
      base,
      head,
      path: "review.ts",
      renameDetectionPercent: 50,
    });

    expect(diff).toContain("--- a/review.ts");
    expect(diff).toContain("+++ b/review.ts");
    expect(diff).toContain("-export const value = 1;");
    expect(diff).toContain("+export const value = 2;");
  });

  it("keeps both sides of a rename when both names are supplied", async () => {
    const cwd = await repository();
    const original = Array.from({ length: 20 }, (_value, index) => `line ${String(index + 1)}`);
    await writeFile(join(cwd, "before.ts"), `${original.join("\n")}\n`, "utf8");
    const base = await commit(cwd, "base");
    await git(cwd, ["mv", "before.ts", "after.ts"]);
    original[10] = "line changed";
    await writeFile(join(cwd, "after.ts"), `${original.join("\n")}\n`, "utf8");
    const head = await commit(cwd, "head");

    const diff = await readChangeUnifiedDiff({
      repositoryPath: cwd,
      pathValue,
      base,
      head,
      path: "after.ts",
      oldPath: "before.ts",
      renameDetectionPercent: 50,
    });

    expect(diff).toContain("rename from before.ts");
    expect(diff).toContain("rename to after.ts");
    expect(diff).toContain("+line changed");
  });

  it("rejects paths that could escape the repository scope", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "review.ts"), "ok\n", "utf8");
    const sha = await commit(cwd, "base");

    await expect(
      readChangeUnifiedDiff({
        repositoryPath: cwd,
        pathValue,
        base: sha,
        head: sha,
        path: "../outside.ts",
        renameDetectionPercent: 50,
      }),
    ).resolves.toBeUndefined();
  });

  it("uses the same configurable rename threshold as inventory", async () => {
    const cwd = await repository();
    const original = Array.from({ length: 100 }, (_value, index) => `original ${String(index)}`);
    await writeFile(join(cwd, "before.ts"), `${original.join("\n")}\n`, "utf8");
    const base = await commit(cwd, "base");
    await git(cwd, ["mv", "before.ts", "after.ts"]);
    const changed = original.map((line, index) =>
      index < 40 ? line : `replacement ${String(index)}`,
    );
    await writeFile(join(cwd, "after.ts"), `${changed.join("\n")}\n`, "utf8");
    const head = await commit(cwd, "head");

    const diff = await readChangeUnifiedDiff({
      repositoryPath: cwd,
      pathValue,
      base,
      head,
      path: "after.ts",
      oldPath: "before.ts",
      renameDetectionPercent: 30,
    });

    const similarity = /similarity index (\d+)%/u.exec(diff ?? "");
    expect(similarity).not.toBeNull();
    expect(Number(similarity?.[1])).toBeGreaterThanOrEqual(30);
    expect(Number(similarity?.[1])).toBeLessThan(50);
    expect(diff).toContain("rename from before.ts");
    expect(diff).toContain("rename to after.ts");
  });

  it("does not execute repository-configured diff or textconv drivers", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "review.ts"), "export const value = 1;\n", "utf8");
    const base = await commit(cwd, "base");
    await writeFile(join(cwd, "review.ts"), "export const value = 2;\n", "utf8");
    const head = await commit(cwd, "head");
    await writeFile(join(cwd, ".git", "info", "attributes"), "*.ts diff=hostile\n", "utf8");
    await git(cwd, ["config", "diff.external", "/usr/bin/false"]);
    await git(cwd, ["config", "diff.hostile.textconv", "/usr/bin/false"]);
    await git(cwd, ["config", "diff.submodule", "log"]);

    const request = {
      repositoryPath: cwd,
      pathValue,
      base,
      head,
      path: "review.ts",
      renameDetectionPercent: 50,
    } as const;
    const withExternal = await readChangeUnifiedDiff(request);
    await git(cwd, ["config", "--unset-all", "diff.external"]);
    const withTextconv = await readChangeUnifiedDiff(request);

    expect(withExternal).toContain("-export const value = 1;");
    expect(withExternal).toContain("+export const value = 2;");
    expect(withTextconv).toContain("-export const value = 1;");
    expect(withTextconv).toContain("+export const value = 2;");
  });
});
