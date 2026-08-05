import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import { commitSha, repoPath } from "../core/brands.js";
import { createSilentDiagnostics } from "../diagnostics/sink.js";
import { mergeBase, type GitContext } from "../git/plumbing.js";
import type { InventoryItem } from "./classify.js";
import {
  buildInventory,
  criticalPointerCount,
  excludedPathCount,
  mechanicallyCleanPaths,
  resolveReviewPair,
  type Inventory,
} from "./inventory.js";

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
  pathInstructions: [],
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

/**
 * A pure function over already-classified items, so — unlike the suite above — this needs no real
 * git repository: a hand-built inventory exercises it directly and faster.
 */
describe("excludedPathCount and criticalPointerCount", () => {
  function item(path: string, classification: InventoryItem["classification"]): InventoryItem {
    return {
      path: repoPath(path),
      status: "M",
      classification,
      modeChanged: false,
      reviewable: classification.kind === "reviewed",
      changedLines: 1,
    };
  }

  function inventoryOf(items: readonly InventoryItem[]): Inventory {
    return {
      pair: {
        base: commitSha("a".repeat(40)),
        head: commitSha("b".repeat(40)),
        mergeBase: commitSha("a".repeat(40)),
      },
      items,
      reviewablePaths: new Set(items.filter((i) => i.reviewable).map((i) => i.path as string)),
      unclassified: [],
    };
  }

  it("is zero for an inventory with no excluded path", () => {
    const inventory = inventoryOf([item("src/a.ts", { kind: "reviewed" })]);
    expect(excludedPathCount(inventory)).toBe(0);
  });

  it("counts only the excluded classification, not generated, binary, or mechanically-clean", () => {
    const inventory = inventoryOf([
      item("src/a.ts", { kind: "reviewed" }),
      item("docs/readme.md", { kind: "excluded", reason: "prose, reviewed by humans" }),
      item("docs/other.md", { kind: "excluded", reason: "prose, reviewed by humans" }),
      item("dist/bundle.js", { kind: "generated" }),
      item("assets/logo.png", { kind: "binary" }),
      item("src/renamed.ts", { kind: "mechanically-clean", reason: "pure-rename" }),
    ]);
    expect(excludedPathCount(inventory)).toBe(2);
  });

  /**
   * #37: the signal `classify.ts` already computes for a submodule bump (`critical`, mirroring
   * `symlink-pointer`'s own flag) used to be discarded at every later stage — `isReviewable` does
   * not honor it for this kind (a gitlink has no blob to review), and nothing else read it either.
   * `criticalPointerCount` is the one place that fact now surfaces.
   */
  describe("criticalPointerCount", () => {
    it("is zero for an inventory with no critical submodule pointer", () => {
      const inventory = inventoryOf([
        item("src/a.ts", { kind: "reviewed" }),
        item("vendor/lib", { kind: "submodule-pointer", critical: false }),
      ]);
      expect(criticalPointerCount(inventory)).toBe(0);
    });

    it("counts only a critical submodule pointer, not a critical symlink pointer", () => {
      const inventory = inventoryOf([
        item("tests/vendor", { kind: "submodule-pointer", critical: true }),
        item("vendor/inert", { kind: "submodule-pointer", critical: false }),
        // A critical SYMLINK is a distinct kind — `isReviewable` already requires engine coverage
        // for it, and it must not double-count here as though it were an unreviewable pointer too.
        item("src/link.ts", { kind: "symlink-pointer", critical: true }),
      ]);
      expect(criticalPointerCount(inventory)).toBe(1);
    });
  });
});

describe("bucketKey (via inventory.completed diagnostics, #37)", () => {
  it("distinguishes a critical submodule bump from a non-critical one in its own bucket", async () => {
    const repo = await mkdtemp(join(tmpdir(), "kfq-inventory-critical-pointer-"));
    try {
      git(["init", "-q", "-b", "main"], repo);
      git(["commit", "--allow-empty", "-q", "-m", "root", "--no-gpg-sign"], repo);
      // A real gitlink entry: `git update-index --add --cacheinfo` writes one without requiring an
      // actual initialized submodule, which is exactly the "structural change, no content to read"
      // shape `classifyStructural` reasons about.
      git(["update-index", "--add", "--cacheinfo", "160000", "a".repeat(40), "tests/vendor"], repo);
      git(["commit", "-q", "-m", "add critical pointer", "--no-gpg-sign"], repo);
      const base = git(["rev-parse", "HEAD"], repo).trim();

      git(["update-index", "--cacheinfo", "160000", "b".repeat(40), "tests/vendor"], repo);
      git(["commit", "-q", "-m", "bump critical pointer", "--no-gpg-sign"], repo);
      const head = git(["rev-parse", "HEAD"], repo).trim();

      // A profile of its own, distinct from the file-scoped `compiled` above: this one's
      // `deletionCritical` must actually match `tests/vendor` for `critical` to come out `true`,
      // which the file-scoped fixture's own `deletionCritical: []` never does.
      const criticalProfile = compileProfile({
        version: 1,
        reviewRelevant: ["src/**/*.ts"],
        deletionCritical: ["tests/**"],
        generated: [],
        excluded: [],
        benignWarnings: [],
        pathInstructions: [],
      } satisfies ReviewProfile);

      const ctx: GitContext = {
        cwd: repo,
        timeoutMs: 30_000,
        pathValue: process.env.PATH ?? "/usr/bin:/bin",
      };
      const pair = await resolveReviewPair(ctx, commitSha(base), commitSha(head));
      const diagnostics = createSilentDiagnostics();
      const inventory = await buildInventory(ctx, criticalProfile, pair, 50, diagnostics);

      expect(inventory.items).toHaveLength(1);
      expect(inventory.items[0]?.classification).toEqual({
        kind: "submodule-pointer",
        critical: true,
      });
      expect(criticalPointerCount(inventory)).toBe(1);
      const completed = diagnostics.drain().find((record) => record.code === "inventory.completed");
      expect(completed?.counts?.submodule_pointer_critical).toBe(1);
      // Never the plain bucket too — a critical bump lands in exactly one bucket, not both.
      expect(completed?.counts?.submodule_pointer).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
