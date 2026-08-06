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
  pathInstructions: [],
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

/** One well-formed finding anchored at `path` — the shape `parseFindings` produces. */
function finding(path: string): EngineResult["findings"][number] {
  return {
    path: repoPath(path),
    content: "Close the handle.",
    startLine: 1,
    endLine: 1,
    severity: "high",
    category: "bug",
  };
}

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
      // The invariant this pins — an unfamiliar schema settles incomplete rather than being read
      // as if its fields still meant what they used to — is unchanged. Only the reason moved
      // family: a settlement reason is published in the incomplete notice, so it names what the
      // outcome means for coverage rather than which internal step noticed the trouble. The
      // `engine.run.schema_rejected` diagnostic it used to borrow has since been retired from the
      // vocabulary (2026-08-04): this branch was its only real source, and this branch had already
      // moved to the settlement code above.
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.schema_rejected",
      });
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
      // The flood itself must never reach publication: the settlement just declared it implausible,
      // and publishing it anyway would spam the pull request with the very output it distrusts —
      // at two API calls per finding.
      expect(outcome.findings).toStrictEqual([]);
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

  /**
   * Counted mode has no manifest, so there is no terminal state to reject — what fails here is the
   * engine's own top-level `status`. The reason used to say `terminal_state`, which named
   * something the run never reported, and carried no counts at all: a published notice then told
   * a reader their change was not fully reviewed and nothing whatever about how much was missing.
   * Observed on oscharko-dev/Keiko#2963, where forty-four files were reviewed and the notice could
   * not distinguish that from none. The invariant is unchanged — a non-success status still
   * settles incomplete — and the assertion is now stricter, covering the counts as well.
   */
  /**
   * The memoization success case, which used to be punished.
   *
   * Production evidence, oscharko-dev/Keiko#2962: two reviewable files, two cache hits, zero
   * misses. The engine was handed nothing to dispatch and reported `skipped` — correctly — and the
   * status check read that as a failed run, so a fully answered pull request received a blocking
   * "this change was not fully reviewed" notice. The better the store worked, the more often the
   * reviewer declared itself broken.
   *
   * With nothing dispatched, the engine's status says nothing about coverage: every reviewable
   * path carries a replayed verdict by construction.
   */
  it("settles complete when every reviewable path was answered from the store", () => {
    const memoized = new Set(["src/a.ts", "src/b.ts"]);
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts"]),
      released({ status: "skipped", filesReviewed: 0 }),
      PROFILE,
      CONFIG,
      memoized,
    );
    expect(outcome.status).toBe("complete");
  });

  it("still refuses when the store answered only some of the paths", () => {
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts"]),
      released({ status: "skipped", filesReviewed: 0 }),
      PROFILE,
      CONFIG,
      new Set(["src/a.ts"]),
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      reason: "settlement.incomplete.engine_status_not_success",
    });
  });

  it("still applies the disqualifiers to an all-hits run", () => {
    // Nothing dispatched does not mean nothing to object to: an unlisted warning is about the run.
    const outcome = settle(
      inventory(["src/a.ts"]),
      released({ status: "skipped", warnings: [{ type: "unknown-warning", file: "src/a.ts" }] }),
      PROFILE,
      CONFIG,
      new Set(["src/a.ts"]),
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      reason: "settlement.incomplete.warning_not_allowlisted",
    });
  });

  it.each(["skipped", "failed", "unknown"] as const)("rejects run status %s", (status) => {
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts"]),
      released({ status, filesReviewed: 1 }),
      PROFILE,
      CONFIG,
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      mode: "counted",
      reason: "settlement.incomplete.engine_status_not_success",
    });
    if (outcome.status === "incomplete") {
      expect(outcome.counts.reviewed).toBe(1);
      expect(outcome.counts.expected).toBe(2);
    }
  });

  /**
   * The production case, pinned. `--max-tokens-budget` makes the engine stop dispatching and exit
   * non-`success`, so a budget stop arrives carrying BOTH facts — and the status check used to run
   * first and claim it. Every incomplete run on oscharko-dev/Keiko#2970 and #2981 was this shape:
   * `budget_exceeded` true in the same result that reported a failed status, published as
   * `engine_status_not_success`, which named the symptom and hid the one cause the consumer could
   * have acted on.
   */
  it.each(["skipped", "failed", "unknown"] as const)(
    "reports the budget stop, not status %s, when the result carries both",
    (status) => {
      const outcome = settle(
        inventory(["src/a.ts", "src/b.ts"]),
        released({ status, filesReviewed: 1, budgetExceeded: true, totalTokens: 3_843_796 }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        mode: "counted",
        reason: "settlement.incomplete.budget_exceeded",
      });
      if (outcome.status === "incomplete") expect(outcome.counts.tokens).toBe(3_843_796);
    },
  );

  /**
   * And the half that makes the next push cheaper: the reason code above is the one
   * `verdictsSurviveIncompleteness` admits, and the covered set it carries is what the review
   * cache may write. Without a manifest the engine names no covered path at all, so a finding's
   * own path is the only identity available — see `memoizablePaths`.
   */
  it("carries a truncated run's finding paths as memoizable coverage", () => {
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts"]),
      released({ status: "failed", budgetExceeded: true, findings: [finding("src/a.ts")] }),
      PROFILE,
      CONFIG,
    );
    expect(outcome.status).toBe("incomplete");
    if (outcome.status !== "incomplete") return;
    expect([...outcome.coveredPaths]).toEqual(["src/a.ts"]);
  });

  /**
   * The Keiko#3002 shape, pinned from a verified re-run of the same diff (2026-08-06): the run
   * FINISHED (`completed_with_errors`), reviewed everything it dispatched, filed real findings —
   * and named the files whose per-file loop died in typed warnings. Eight production runs settled
   * `engine_status_not_success` on this shape, each discarding a finished review.
   */
  describe("finished statuses (v1.8.4 completed_with_*)", () => {
    it("settles completed_with_errors as a coverage gap that names its size", () => {
      const outcome = settle(
        inventory(["src/a.ts", "src/b.ts", "src/c.ts"]),
        released({
          status: "completed_with_errors",
          filesReviewed: 3,
          warnings: [{ type: "subtask_error", file: "src/b.ts" }],
          findings: [finding("src/a.ts"), finding("src/b.ts")],
        }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        mode: "counted",
        reason: "settlement.incomplete.coverage_gap",
      });
      if (outcome.status !== "incomplete") return;
      expect(outcome.counts).toEqual({ gap: 1, reviewable: 3, reviewed: 2 });
      // The verdicts survive, the failed file's own finding is NOT frozen as its verdict — and
      // the clean completion WITHOUT a finding is covered too (2026-08-06): the dispatch count
      // corroborates a full dispatch, the warnings name every failure, so `src/c.ts`'s silence is
      // the engine's own account of a clean review, not an absence of evidence. Keiko#3008
      // memoized zero of twelve files for want of exactly this.
      expect(outcome.findings).toHaveLength(2);
      expect([...outcome.coveredPaths].sort()).toEqual(["src/a.ts", "src/c.ts"]);
    });

    it("falls back to finding-proven coverage when the dispatch count does not corroborate", () => {
      // filesReviewed 2 < expected 3: the engine's own filters dropped something unnamed, so the
      // complement identity is void and only the finding-proven path may be memoized.
      const outcome = settle(
        inventory(["src/a.ts", "src/b.ts", "src/c.ts"]),
        released({
          status: "completed_with_errors",
          filesReviewed: 2,
          warnings: [{ type: "subtask_error", file: "src/b.ts" }],
          findings: [finding("src/a.ts")],
        }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.coverage_gap",
      });
      if (outcome.status !== "incomplete") return;
      expect([...outcome.coveredPaths]).toEqual(["src/a.ts"]);
    });

    it("treats a token_threshold_exceeded file as owed, not as reviewed", () => {
      const outcome = settle(
        inventory(["src/a.ts", "src/b.ts"]),
        released({
          status: "completed_with_warnings",
          filesReviewed: 2,
          warnings: [{ type: "token_threshold_exceeded", file: "src/b.ts" }],
        }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.coverage_gap",
      });
      if (outcome.status !== "incomplete") return;
      expect(outcome.counts).toEqual({ gap: 1, reviewable: 2, reviewed: 1 });
    });

    it("settles completed_with_warnings as complete when every warning is allowlisted", () => {
      const outcome = settle(
        inventory(["src/a.ts"]),
        released({
          status: "completed_with_warnings",
          warnings: [{ type: "context_truncated", file: "src/a.ts" }],
        }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({ status: "complete", mode: "counted" });
    });

    it("still fails closed on an unlisted warning that names no failed file", () => {
      const outcome = settle(
        inventory(["src/a.ts"]),
        released({
          status: "completed_with_warnings",
          warnings: [{ type: "provider_hiccup", file: "" }],
        }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.warning_not_allowlisted",
      });
    });

    it("fails closed via the allowlist on a subtask_error that names no file", () => {
      // No file, no identity, no gap arithmetic — but the warning still says a review fell over
      // somewhere, so it must not pass. The allowlist branch is the fail-closed catch-all.
      const outcome = settle(
        inventory(["src/a.ts"]),
        released({
          status: "completed_with_errors",
          warnings: [{ type: "subtask_error", file: "" }],
        }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.warning_not_allowlisted",
      });
    });

    it("memoizes finding-proven paths on a plain count shortfall too", () => {
      const outcome = settle(
        inventory(["src/a.ts", "src/b.ts"]),
        released({ status: "success", filesReviewed: 1, findings: [finding("src/a.ts")] }),
        PROFILE,
        CONFIG,
      );
      expect(outcome).toMatchObject({
        status: "incomplete",
        reason: "settlement.incomplete.coverage_gap",
      });
      if (outcome.status !== "incomplete") return;
      expect([...outcome.coveredPaths]).toEqual(["src/a.ts"]);
    });
  });

  /**
   * The one path a finding does NOT prove: a file whose review fell over partway may have filed one
   * finding and missed three, so freezing that as its verdict is the laundering `review-cache.ts`
   * warns about. Reconciled mode, because only a manifest can report a failed coverage entry.
   */
  it("refuses to memoize a finding's path when the manifest failed that path", () => {
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts"]),
      result({
        terminalState: "partial",
        budgetExceeded: true,
        findings: [finding("src/a.ts")],
        coverage: {
          selected: [{ path: "src/a.ts" }],
          completed: [],
          reused: [],
          failed: [{ path: "src/a.ts" }],
          waived: [],
        },
      }),
      PROFILE,
      CONFIG,
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      mode: "reconciled",
      reason: "settlement.incomplete.budget_exceeded",
    });
    if (outcome.status !== "incomplete") return;
    expect([...outcome.coveredPaths]).toEqual([]);
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
 * v0.9.0: a review-cache hit answers a reviewable path instead of the engine. Unlike a
 * mechanically-clean rename, the path stays `reviewable: true` in the inventory — the content is
 * real review content, just answered from a prior run — so `settle` has to be told about it
 * explicitly through `memoizedPaths` rather than the denominator shrinking on its own.
 */
describe("memoized coverage credit", () => {
  function reconciledResult(completed: readonly string[]): EngineResult {
    return result({
      coverage: {
        selected: completed.map((path) => ({ path })),
        completed: completed.map((path) => ({ path })),
        reused: [],
        failed: [],
        waived: [],
      },
    });
  }

  it("settles complete (reconciled) when the only path missing from engine coverage was memoized", () => {
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts"]),
      reconciledResult(["src/a.ts"]),
      PROFILE,
      CONFIG,
      new Set(["src/b.ts"]),
    );
    expect(outcome.status).toBe("complete");
  });

  it("still settles incomplete (reconciled) when a non-memoized path is missing from coverage", () => {
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts"]),
      reconciledResult(["src/a.ts"]),
      PROFILE,
      CONFIG,
      new Set(), // nothing memoized this run
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      reason: "settlement.incomplete.coverage_gap",
    });
    if (outcome.status === "incomplete") expect(outcome.counts.gap).toBe(1);
  });

  it("settles complete (counted) when the shortfall equals exactly the memoized count", () => {
    const released = result({ manifestPresent: false, status: "success", filesReviewed: 2 });
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts", "src/c.ts"]),
      released,
      PROFILE,
      CONFIG,
      new Set(["src/c.ts"]),
    );
    expect(outcome).toMatchObject({ status: "complete", mode: "counted" });
  });

  it("still settles incomplete (counted) when the shortfall exceeds the memoized count", () => {
    const released = result({ manifestPresent: false, status: "success", filesReviewed: 1 });
    const outcome = settle(
      inventory(["src/a.ts", "src/b.ts", "src/c.ts"]),
      released,
      PROFILE,
      CONFIG,
      new Set(["src/c.ts"]), // one file memoized, but two are still unaccounted for
    );
    expect(outcome).toMatchObject({
      status: "incomplete",
      mode: "counted",
      reason: "settlement.incomplete.coverage_gap",
    });
    if (outcome.status === "incomplete") expect(outcome.counts.gap).toBe(1);
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
