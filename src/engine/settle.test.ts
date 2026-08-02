import { describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import { commitSha, repoPath } from "../core/brands.js";
import type { Inventory } from "../inventory/inventory.js";
import type { RuntimeConfig } from "../config/runtime.js";
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
