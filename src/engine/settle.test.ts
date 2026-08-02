import { describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import { blobId, commitSha, repoPath } from "../core/brands.js";
import { toItem } from "../inventory/classify.js";
import type { Inventory } from "../inventory/inventory.js";
import type { RuntimeConfig } from "../config/runtime.js";
import { MODE_REGULAR, type RawChange } from "../git/plumbing.js";
import { SUPPORTED_MANIFEST_SCHEMA, type EngineResult } from "./result.js";
import { settle } from "./settle.js";

const PROFILE = compileProfile({
  version: 1,
  reviewRelevant: ["src/**"],
  deletionCritical: [],
  generated: [],
  excluded: [],
  benignWarnings: [{ type: "context_truncated", justification: "known on very large files" }],
} satisfies ReviewProfile);

const CONFIG: RuntimeConfig = {
  protocol: "anthropic",
  endpoint: "https://example.test/v1",
  model: "test-model",
  tokenEnvName: "MODEL_TOKEN",
  language: "English",
  concurrency: 4,
  fileTimeoutSeconds: 300,
  reviewTimeoutSeconds: 1800,
  tokenBudget: 100_000,
  maxFindings: 10,
  renameDetectionPercent: 50,
};

const SHA = commitSha("a".repeat(40));

function inventory(paths: readonly string[]): Inventory {
  return {
    pair: { base: SHA, head: SHA, mergeBase: SHA },
    items: paths.map((path) => ({
      path: repoPath(path),
      status: "M" as const,
      classification: { kind: "reviewed" as const },
      modeChanged: false,
      reviewable: true,
      changedLines: 0,
    })),
    reviewablePaths: new Set(paths),
    unclassified: [],
  };
}

function result(overrides: Partial<EngineResult> = {}): EngineResult {
  return {
    manifestPresent: true,
    status: "success",
    filesReviewed: 1,
    schemaVersion: SUPPORTED_MANIFEST_SCHEMA,
    terminalState: "complete",
    coverage: {
      selected: [{ path: "src/a.ts" }],
      completed: [{ path: "src/a.ts" }],
      reused: [],
      failed: [],
      waived: [],
    },
    findings: [],
    warnings: [],
    totalTokens: 1000,
    budgetExceeded: false,
    ...overrides,
  };
}

describe("settle", () => {
  it("settles a fully covered, clean run as complete", () => {
    expect(settle(inventory(["src/a.ts"]), result(), PROFILE, CONFIG).status).toBe("complete");
  });

  it("accepts a safely reused review as coverage", () => {
    const reused = result({
      coverage: {
        selected: [{ path: "src/a.ts" }],
        completed: [],
        reused: [{ path: "src/a.ts" }],
        failed: [],
        waived: [],
      },
    });
    expect(settle(inventory(["src/a.ts"]), reused, PROFILE, CONFIG).status).toBe("complete");
  });

  describe("nothing incomplete may look clean", () => {
    it.each(["partial", "failed", "skipped", "unknown"] as const)(
      "rejects terminal state %s",
      (terminalState) => {
        const outcome = settle(inventory(["src/a.ts"]), result({ terminalState }), PROFILE, CONFIG);
        expect(outcome).toMatchObject({
          status: "incomplete",
          reason: "settlement.incomplete.terminal_state",
        });
      },
    );

    it("rejects an unfamiliar manifest schema rather than guessing at its fields", () => {
      const outcome = settle(
        inventory(["src/a.ts"]),
        result({ schemaVersion: "ocr.run-manifest/v2" }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({ status: "incomplete", reason: "engine.run.schema_rejected" });
    });

    it("rejects a run with failed coverage", () => {
      const outcome = settle(
        inventory(["src/a.ts"]),
        result({
          coverage: {
            selected: [],
            completed: [{ path: "src/a.ts" }],
            reused: [],
            failed: [{ path: "src/b.ts" }],
            waived: [],
          },
        }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.coverage_failed",
      });
    });

    // The reconciliation the engine cannot do for itself: it reports what it selected, not whether
    // what it selected was everything that changed.
    it("detects a reviewable path the engine never covered", () => {
      const outcome = settle(inventory(["src/a.ts", "src/b.ts"]), result(), PROFILE, CONFIG);
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.coverage_gap",
      });
      if (outcome.status === "incomplete") expect(outcome.counts.gap).toBe(1);
    });

    it("does not accept a waived item as covered", () => {
      const outcome = settle(
        inventory(["src/a.ts"]),
        result({
          coverage: {
            selected: [],
            completed: [],
            reused: [],
            failed: [],
            waived: [{ path: "src/a.ts" }],
          },
        }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.coverage_gap",
      });
    });

    it("rejects a warning the consumer never justified", () => {
      const outcome = settle(
        inventory(["src/a.ts"]),
        result({ warnings: [{ type: "model_refused", file: "src/a.ts" }] }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.warning_not_allowlisted",
      });
    });

    it("accepts a warning the consumer justified in their profile", () => {
      const outcome = settle(
        inventory(["src/a.ts"]),
        result({ warnings: [{ type: "context_truncated", file: "src/a.ts" }] }),
        PROFILE,
        CONFIG,
      );
      expect(outcome.status).toBe("complete");
    });

    it("rejects a run that exhausted its token budget", () => {
      const outcome = settle(
        inventory(["src/a.ts"]),
        result({ budgetExceeded: true }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.budget_exceeded",
      });
    });

    it("rejects a run that overspent even without the engine's own flag", () => {
      const outcome = settle(
        inventory(["src/a.ts"]),
        result({ totalTokens: CONFIG.tokenBudget + 1 }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.budget_exceeded",
      });
    });

    it("treats a flood of findings as an engine failure rather than a terrible change", () => {
      const findings = Array.from({ length: CONFIG.maxFindings + 1 }, () => ({
        path: repoPath("src/a.ts"),
        content: "x",
        startLine: 1,
        endLine: 1,
        severity: undefined,
        category: undefined,
      }));
      const outcome = settle(inventory(["src/a.ts"]), result({ findings }), PROFILE, CONFIG);
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.engine_error",
      });
    });
  });
});

/**
 * The path a digest-pinned engine release actually takes.
 *
 * No published release emits a run manifest — `internal/session/manifest.go` exists only on the
 * upstream default branch — so this is not an edge case, it is the normal path today. It was found
 * by running the pinned binary against a live model, not by reading source: the source was read
 * from `main` while the binary was pinned to a release, and they did not agree.
 */
describe("counted settlement (no manifest)", () => {
  function released(overrides: Partial<EngineResult> = {}): EngineResult {
    return result({
      manifestPresent: false,
      schemaVersion: "",
      terminalState: "unknown",
      coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
      status: "success",
      filesReviewed: 1,
      ...overrides,
    });
  }

  it("settles a successful run whose file count matches the inventory", () => {
    const outcome = settle(inventory(["src/a.ts"]), released(), PROFILE, CONFIG);
    expect(outcome).toMatchObject({ status: "complete", mode: "counted" });
  });

  it("reports the weaker mode rather than claiming a reconciled result", () => {
    const outcome = settle(inventory(["src/a.ts"]), released(), PROFILE, CONFIG);
    expect(outcome.mode).toBe("counted");
  });

  // The check that still catches the engine's path filters disagreeing with the review profile.
  it("detects that fewer files were reviewed than the inventory requires", () => {
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts", "src/c.ts"]),
      released({ filesReviewed: 2 }),
      PROFILE,
      CONFIG,
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      mode: "counted",
      reason: "settlement.incomplete.coverage_gap",
    });
    if (outcome.status === "incomplete") {
      expect(outcome.counts.gap).toBe(1);
      expect(outcome.counts.reviewed).toBe(2);
    }
  });

  it.each(["skipped", "failed", "unknown"] as const)("rejects run status %s", (status) => {
    const outcome = settle(inventory(["src/a.ts"]), released({ status }), PROFILE, CONFIG);
    expect(outcome).toMatchObject({
      status: "incomplete",
      mode: "counted",
      reason: "settlement.incomplete.terminal_state",
    });
  });

  it("still enforces the warning allowlist", () => {
    const outcome = settle(
      inventory(["src/a.ts"]),
      released({ warnings: [{ type: "model_refused", file: "src/a.ts" }] }),
      PROFILE,
      CONFIG,
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      reason: "settlement.incomplete.warning_not_allowlisted",
    });
  });

  it("still enforces the token budget", () => {
    const outcome = settle(
      inventory(["src/a.ts"]),
      released({ budgetExceeded: true }),
      PROFILE,
      CONFIG,
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      reason: "settlement.incomplete.budget_exceeded",
    });
  });

  it("prefers the reconciled path whenever a manifest is present", () => {
    const outcome = settle(inventory(["src/a.ts"]), result(), PROFILE, CONFIG);
    expect(outcome.mode).toBe("reconciled");
  });
});

/**
 * A mechanically-clean rename is `reviewable: false`, so it never joins `reviewablePaths` — the
 * denominator both settlement paths reconcile against. This is what actually stops the engine's
 * spend on a path with nothing to review: the accounting shrinks, not just a label on the item.
 *
 * The inventory below is built through `classify`/`toItem`, the same production entry point
 * `buildInventory` uses — not hand-authored to already say `reviewable: false` — so a regression
 * in the downgrade itself (`isPureRename`/`downgradeToMechanicallyClean`) would show up here too,
 * not only in `classify.test.ts`.
 */
describe("a mechanically-clean item shrinks the settlement denominator", () => {
  const rawChange = (
    overrides: Omit<Partial<RawChange>, "path"> & { path: string },
  ): RawChange => ({
    status: "M",
    oldMode: MODE_REGULAR,
    newMode: MODE_REGULAR,
    oldBlob: blobId("a".repeat(40)),
    newBlob: blobId("b".repeat(40)),
    binary: false,
    changedLines: 0,
    ...overrides,
    path: repoPath(overrides.path),
  });

  function mixedInventory(): Inventory {
    const cleanBlob = blobId("c".repeat(40));
    const items = [
      rawChange({ path: "src/a.ts" }),
      rawChange({ path: "src/b.ts" }),
      // A byte-identical rename: same blob and mode on both sides.
      rawChange({
        path: "src/renamed.ts",
        oldPath: repoPath("src/old.ts"),
        status: "R",
        oldBlob: cleanBlob,
        newBlob: cleanBlob,
      }),
    ].map((change) => toItem(PROFILE, change));

    return {
      pair: { base: SHA, head: SHA, mergeBase: SHA },
      items,
      reviewablePaths: new Set(items.filter((i) => i.reviewable).map((i) => i.path as string)),
      unclassified: [],
    };
  }

  it("classifies the third item as mechanically-clean, not reviewed", () => {
    const built = mixedInventory();
    expect(built.items).toHaveLength(3);
    expect(built.items[2]?.classification).toEqual({
      kind: "mechanically-clean",
      reason: "pure-rename",
    });
  });

  it("excludes the prefiltered rename from the reviewable count, not just from the item list", () => {
    const built = mixedInventory();
    // Shrunk by exactly one — the mechanically-clean item — not by the whole prefiltered set.
    expect(built.reviewablePaths.size).toBe(2);
  });

  it("settles complete on engine coverage of only the two reviewable paths", () => {
    // Without the shrink this would need `filesReviewed: 3` to avoid a coverage gap.
    const released = result({ manifestPresent: false, status: "success", filesReviewed: 2 });
    expect(settle(mixedInventory(), released, PROFILE, CONFIG).status).toBe("complete");
  });
});

/**
 * Found on the reviewer's first large production pull request: Keiko #2926, 89 files, 87 reviewed,
 * 19 KB of engine output — and because a partial run discarded its findings, the pull request
 * received a blocking notice and not a single finding. On a change that size one failed file is
 * the ordinary case, so the reviewer went silent exactly where it had the most to say.
 */
describe("a partial run keeps what it found", () => {
  const FOUND = [
    {
      path: repoPath("src/a.ts"),
      content: "Close the handle.",
      startLine: 1,
      endLine: 1,
      severity: "high",
      category: "bug",
    },
  ];

  it.each([
    ["a non-success terminal state", { manifestPresent: false, status: "failed" as const }],
    ["a coverage shortfall", { manifestPresent: false, filesReviewed: 0 }],
    ["an exhausted budget", { budgetExceeded: true }],
  ])("carries the findings through %s", (_name, overrides) => {
    const settlement = settle(
      inventory(["src/a.ts"]),
      result({ ...overrides, findings: FOUND }),
      PROFILE,
      CONFIG,
    );
    expect(settlement.status).toBe("incomplete");
    if (settlement.status !== "incomplete") return;
    expect(settlement.findings).toEqual(FOUND);
  });

  /**
   * The one case with nothing to carry. A result that failed to parse cannot be trusted in part
   * either — "some of this malformed output is fine" is not a judgement anything here can make.
   */
  it("carries nothing when the result did not parse", () => {
    const settlement = settle(
      inventory(["src/a.ts"]),
      result({ schemaVersion: "ocr.run-manifest/v99", findings: FOUND }),
      PROFILE,
      CONFIG,
    );
    expect(settlement.status).toBe("incomplete");
    if (settlement.status !== "incomplete") return;
    expect(settlement.findings).toEqual([]);
  });

  it("still refuses to call the run complete", () => {
    const settlement = settle(
      inventory(["src/a.ts"]),
      result({ manifestPresent: false, status: "failed", findings: FOUND }),
      PROFILE,
      CONFIG,
    );
    expect(settlement.status).not.toBe("complete");
  });
});
