import { describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import type { RuntimeConfig } from "../config/runtime.js";
import { commitSha } from "../core/brands.js";
import type { ReviewPair } from "../inventory/inventory.js";
import { reviewArguments, type EngineRunOptions } from "./run.js";

const PROFILE = compileProfile({
  version: 1,
  reviewRelevant: ["src/**"],
  deletionCritical: [],
  generated: [],
  excluded: [],
  benignWarnings: [],
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
  tokenBudget: 2_000_000,
  maxFindings: 50,
  renameDetectionPercent: 50,
};

const PAIR: ReviewPair = {
  base: commitSha("a".repeat(40)),
  head: commitSha("b".repeat(40)),
  mergeBase: commitSha("c".repeat(40)),
};

function options(overrides: Partial<EngineRunOptions> = {}): EngineRunOptions {
  return {
    binaryPath: "/opt/engine/ocr",
    repositoryPath: "/workspace/repo",
    pair: PAIR,
    config: CONFIG,
    profile: PROFILE,
    guidelines: { paths: [] },
    env: {},
    pathValue: "/usr/bin:/bin",
    allottedBudget: 123_456,
    mechanicallyCleanPaths: [],
    ...overrides,
  };
}

describe("reviewArguments", () => {
  it("carries the allotted budget as --max-tokens-budget, not the consumer's raw ceiling", () => {
    const args = reviewArguments(options({ allottedBudget: 987_654 }), "/home/keiko-rules.json");
    const flagIndex = args.indexOf("--max-tokens-budget");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe("987654");
    // Proves this is the size-scaled allotment threaded through options, not `config.tokenBudget`
    // read directly — the two are deliberately different values in this fixture.
    expect(args).not.toContain(String(CONFIG.tokenBudget));
  });

  it("threads a different allotment on a second call rather than a value baked into the function", () => {
    const small = reviewArguments(options({ allottedBudget: 80_000 }), "/home/keiko-rules.json");
    const large = reviewArguments(options({ allottedBudget: 4_771_650 }), "/home/keiko-rules.json");
    expect(small[small.indexOf("--max-tokens-budget") + 1]).toBe("80000");
    expect(large[large.indexOf("--max-tokens-budget") + 1]).toBe("4771650");
  });

  it("still carries the merge base, head, rule path, and concurrency", () => {
    const args = reviewArguments(options(), "/home/keiko-rules.json");
    expect(args).toEqual([
      "review",
      "--from",
      PAIR.mergeBase,
      "--to",
      PAIR.head,
      "--format",
      "json",
      "--rule",
      "/home/keiko-rules.json",
      "--concurrency",
      "4",
      "--max-tokens-budget",
      "123456",
    ]);
  });

  it("never consults the engine's own discovery paths for the rule file", () => {
    const args = reviewArguments(options(), "/home/keiko-rules.json");
    expect(args[args.indexOf("--rule") + 1]).toBe("/home/keiko-rules.json");
  });
});
