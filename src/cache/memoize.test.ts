import { describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import type { RuntimeConfig } from "../config/runtime.js";
import { blobId, commitSha, repoPath, sha256 } from "../core/brands.js";
import type { EngineFinding } from "../engine/result.js";
import { toItem } from "../inventory/classify.js";
import type { Inventory } from "../inventory/inventory.js";
import { MODE_ABSENT, MODE_REGULAR, MODE_SYMLINK, type RawChange } from "../git/plumbing.js";
import {
  SUPPORTED_STORE_SCHEMA,
  computeKey,
  modelId,
  protocol,
  type CacheEntry,
  type CacheStore,
} from "./review-cache.js";
import { buildNewEntries, combinedExcludes, lookupMemoized, mergeHitFindings } from "./memoize.js";

const PROFILE = compileProfile({
  version: 1,
  reviewRelevant: ["src/**"],
  deletionCritical: ["tests/**"],
  generated: [],
  excluded: [],
  benignWarnings: [],
} satisfies ReviewProfile);

const CONFIG: RuntimeConfig = {
  protocol: "anthropic",
  endpoint: "https://example.test/v1",
  model: "claude-sonnet-4-5",
  tokenEnvName: "MODEL_TOKEN",
  language: "English",
  concurrency: 4,
  fileTimeoutSeconds: 300,
  reviewTimeoutSeconds: 1800,
  tokenBudget: 2_000_000,
  maxFindings: 50,
  renameDetectionPercent: 50,
};

const RULE_DIGEST = sha256("1".repeat(64));
const ENGINE_DIGEST = sha256("2".repeat(64));

function rawChange(overrides: Omit<Partial<RawChange>, "path"> & { path: string }): RawChange {
  return {
    status: "M",
    oldMode: MODE_REGULAR,
    newMode: MODE_REGULAR,
    oldBlob: blobId("a".repeat(40)),
    newBlob: blobId("b".repeat(40)),
    binary: false,
    changedLines: 3,
    ...overrides,
    path: repoPath(overrides.path),
  };
}

const SHA = commitSha("a".repeat(40));

function inventoryOf(changes: readonly RawChange[]): Inventory {
  const items = changes.map((change) => toItem(PROFILE, change));
  return {
    pair: { base: SHA, head: SHA, mergeBase: SHA },
    items,
    reviewablePaths: new Set(items.filter((i) => i.reviewable).map((i) => i.path as string)),
    unclassified: [],
  };
}

function storeWithEntry(entry: CacheEntry): CacheStore {
  return { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [entry] };
}

function entryFor(change: RawChange, findings: readonly EngineFinding[] = []): CacheEntry {
  const model = modelId(CONFIG.model);
  const proto = protocol(CONFIG.protocol);
  return {
    key: computeKey(change.oldBlob, change.newBlob, RULE_DIGEST, ENGINE_DIGEST, model, proto),
    baseBlob: change.oldBlob,
    headBlob: change.newBlob,
    ruleDigest: RULE_DIGEST,
    engineDigest: ENGINE_DIGEST,
    modelId: model,
    protocol: proto,
    findings,
  };
}

describe("lookupMemoized", () => {
  const CHANGE = rawChange({ path: "src/a.ts" });

  it("returns no hits and no eligible paths when the store is not configured", () => {
    const result = lookupMemoized(
      undefined,
      inventoryOf([CHANGE]),
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
    );
    expect(result.hits.size).toBe(0);
    expect(result.eligiblePaths.size).toBe(0);
  });

  it("returns no hits when the platform has no pinned engine digest", () => {
    const store = storeWithEntry(entryFor(CHANGE));
    const result = lookupMemoized(store, inventoryOf([CHANGE]), RULE_DIGEST, undefined, CONFIG);
    expect(result.hits.size).toBe(0);
  });

  it("finds a hit for an eligible modified file whose key matches a stored entry", () => {
    const store = storeWithEntry(entryFor(CHANGE));
    const result = lookupMemoized(store, inventoryOf([CHANGE]), RULE_DIGEST, ENGINE_DIGEST, CONFIG);
    expect(result.eligiblePaths).toEqual(new Set(["src/a.ts"]));
    expect(result.hits.get("src/a.ts")).toEqual(entryFor(CHANGE));
  });

  it("reports a miss (eligible, but no matching entry) rather than a hit for a changed head blob", () => {
    const store = storeWithEntry(entryFor(CHANGE));
    const changedHead = rawChange({ path: "src/a.ts", newBlob: blobId("c".repeat(40)) });
    const result = lookupMemoized(
      store,
      inventoryOf([changedHead]),
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
    );
    expect(result.eligiblePaths).toEqual(new Set(["src/a.ts"]));
    expect(result.hits.size).toBe(0);
  });

  it("counts an added file as eligible too, keyed on its all-zero base blob", () => {
    const added = rawChange({
      path: "src/new.ts",
      status: "A",
      oldMode: MODE_ABSENT,
      oldBlob: blobId("0".repeat(40)),
    });
    const store = storeWithEntry(entryFor(added));
    const result = lookupMemoized(store, inventoryOf([added]), RULE_DIGEST, ENGINE_DIGEST, CONFIG);
    expect(result.hits.get("src/new.ts")).toBeDefined();
  });

  it.each([
    [
      "a rename",
      rawChange({ path: "src/renamed.ts", status: "R", oldPath: repoPath("src/old.ts") }),
    ],
    ["a deletion", rawChange({ path: "src/gone.ts", status: "D", newMode: MODE_ABSENT })],
    ["a critical symlink pointer", rawChange({ path: "src/link", newMode: MODE_SYMLINK })],
  ])("never treats %s as cache-eligible", (_name, change) => {
    const result = lookupMemoized(
      storeWithEntry(entryFor(CHANGE)),
      inventoryOf([change]),
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
    );
    expect(result.eligiblePaths.size).toBe(0);
  });

  it("fails open — no hits, no crash — when the configured model id is malformed", () => {
    const store = storeWithEntry(entryFor(CHANGE));
    const badConfig: RuntimeConfig = { ...CONFIG, model: `bad${String.fromCodePoint(0)}model` };
    const result = lookupMemoized(
      store,
      inventoryOf([CHANGE]),
      RULE_DIGEST,
      ENGINE_DIGEST,
      badConfig,
    );
    expect(result.hits.size).toBe(0);
    expect(result.eligiblePaths.size).toBe(0);
  });
});

describe("combinedExcludes", () => {
  it("unions the mechanically-clean list and the cache-hit paths", () => {
    const combined = combinedExcludes(["src/renamed.ts"], new Set(["src/cached.ts"]));
    expect(new Set(combined)).toEqual(new Set(["src/renamed.ts", "src/cached.ts"]));
  });

  it("is a union, not a replacement: neither input is dropped when both are non-empty", () => {
    const combined = combinedExcludes(["a"], new Set(["b", "c"]));
    expect(combined).toHaveLength(3);
  });

  it("dedupes an overlap between the two inputs", () => {
    expect(combinedExcludes(["shared.ts"], new Set(["shared.ts"]))).toEqual(["shared.ts"]);
  });

  it("returns the mechanically-clean list unchanged when there are no cache hits", () => {
    expect(combinedExcludes(["src/renamed.ts"], new Set())).toEqual(["src/renamed.ts"]);
  });
});

describe("mergeHitFindings", () => {
  const FINDING: EngineFinding = {
    path: repoPath("src/cached.ts"),
    content: "Close the handle.",
    startLine: 1,
    endLine: 1,
    severity: "high",
    category: "bug",
  };

  it("returns the engine findings unchanged when nothing was memoized", () => {
    expect(mergeHitFindings([FINDING], new Map())).toEqual([FINDING]);
  });

  it("appends a cache hit's findings alongside the engine's own", () => {
    const hits = new Map([
      ["src/cached.ts", entryFor(rawChange({ path: "src/cached.ts" }), [FINDING])],
    ]);
    expect(mergeHitFindings([], hits)).toEqual([FINDING]);
  });

  it("contributes nothing from a hit that cached a clean (empty findings) result", () => {
    const hits = new Map([["src/clean.ts", entryFor(rawChange({ path: "src/clean.ts" }), [])]]);
    expect(mergeHitFindings([FINDING], hits)).toEqual([FINDING]);
  });
});

describe("buildNewEntries", () => {
  const CHANGE = rawChange({ path: "src/a.ts" });
  const OTHER = rawChange({
    path: "src/b.ts",
    oldBlob: blobId("c".repeat(40)),
    newBlob: blobId("d".repeat(40)),
  });

  it("builds an entry for an eligible path the engine reviewed this run", () => {
    const entries = buildNewEntries({
      inventory: inventoryOf([CHANGE]),
      eligiblePaths: new Set(["src/a.ts"]),
      hitPaths: new Set(),
      findings: [],
      ruleDigest: RULE_DIGEST,
      engineDigest: ENGINE_DIGEST,
      config: CONFIG,
    });
    expect(entries).toEqual([entryFor(CHANGE, [])]);
  });

  it("attaches only the findings for that path, not findings from another path", () => {
    const findingForA: EngineFinding = {
      path: repoPath("src/a.ts"),
      content: "x",
      startLine: 1,
      endLine: 1,
      severity: undefined,
      category: undefined,
    };
    const findingForB: EngineFinding = { ...findingForA, path: repoPath("src/b.ts") };
    const entries = buildNewEntries({
      inventory: inventoryOf([CHANGE, OTHER]),
      eligiblePaths: new Set(["src/a.ts", "src/b.ts"]),
      hitPaths: new Set(),
      findings: [findingForA, findingForB],
      ruleDigest: RULE_DIGEST,
      engineDigest: ENGINE_DIGEST,
      config: CONFIG,
    });
    const forA = entries.find((e) => e.baseBlob === CHANGE.oldBlob);
    expect(forA?.findings).toEqual([findingForA]);
  });

  it("never rebuilds an entry for a path that was already a hit this run", () => {
    const entries = buildNewEntries({
      inventory: inventoryOf([CHANGE]),
      eligiblePaths: new Set(["src/a.ts"]),
      hitPaths: new Set(["src/a.ts"]),
      findings: [],
      ruleDigest: RULE_DIGEST,
      engineDigest: ENGINE_DIGEST,
      config: CONFIG,
    });
    expect(entries).toEqual([]);
  });

  it("ignores a path that was never cache-eligible in the first place", () => {
    const entries = buildNewEntries({
      inventory: inventoryOf([CHANGE]),
      eligiblePaths: new Set(), // src/a.ts never counted as eligible
      hitPaths: new Set(),
      findings: [],
      ruleDigest: RULE_DIGEST,
      engineDigest: ENGINE_DIGEST,
      config: CONFIG,
    });
    expect(entries).toEqual([]);
  });

  it("fails open to an empty list when the configured model id is malformed", () => {
    const badConfig: RuntimeConfig = { ...CONFIG, model: `bad${String.fromCodePoint(0)}model` };
    const entries = buildNewEntries({
      inventory: inventoryOf([CHANGE]),
      eligiblePaths: new Set(["src/a.ts"]),
      hitPaths: new Set(),
      findings: [],
      ruleDigest: RULE_DIGEST,
      engineDigest: ENGINE_DIGEST,
      config: badConfig,
    });
    expect(entries).toEqual([]);
  });
});
