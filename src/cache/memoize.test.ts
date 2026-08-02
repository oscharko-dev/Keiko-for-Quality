import { describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import type { RuntimeConfig } from "../config/runtime.js";
import { blobId, commitSha, repoPath, sha256, type Sha256 } from "../core/brands.js";
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
import {
  buildNewEntries,
  combinedExcludes,
  computePrPathSetDigest,
  lookupMemoized,
  mergeHitFindings,
} from "./memoize.js";

const PROFILE = compileProfile({
  version: 1,
  reviewRelevant: ["src/**"],
  deletionCritical: ["tests/**"],
  generated: [],
  excluded: [],
  benignWarnings: [],
  pathInstructions: [],
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
// An arbitrary but fixed changed-path-set digest (v0.10.0, issue #50), shared by default between a
// fixture entry and the lookup that targets it — every test below that is not specifically about
// path-set gating holds this constant on both sides, exactly as `RULE_DIGEST`/`ENGINE_DIGEST`
// already are. The dedicated `computePrPathSetDigest`/path-set describe block further down is the
// one place this varies deliberately.
const PATH_SET_DIGEST = sha256("5".repeat(64));

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

function entryFor(
  change: RawChange,
  findings: readonly EngineFinding[] = [],
  pathSetDigest: Sha256 = PATH_SET_DIGEST,
): CacheEntry {
  const model = modelId(CONFIG.model);
  const proto = protocol(CONFIG.protocol);
  return {
    key: computeKey(change.oldBlob, change.newBlob, RULE_DIGEST, ENGINE_DIGEST, model, proto),
    baseBlob: change.oldBlob,
    headBlob: change.newBlob,
    ruleDigest: RULE_DIGEST,
    engineDigest: ENGINE_DIGEST,
    prPathSetDigest: pathSetDigest,
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
      PATH_SET_DIGEST,
    );
    expect(result.hits.size).toBe(0);
    expect(result.eligiblePaths.size).toBe(0);
    expect(result.contextInvalidated).toBe(0);
  });

  it("returns no hits when the platform has no pinned engine digest", () => {
    const store = storeWithEntry(entryFor(CHANGE));
    const result = lookupMemoized(
      store,
      inventoryOf([CHANGE]),
      RULE_DIGEST,
      undefined,
      CONFIG,
      PATH_SET_DIGEST,
    );
    expect(result.hits.size).toBe(0);
  });

  it("finds a hit for an eligible modified file whose key matches a stored entry", () => {
    const store = storeWithEntry(entryFor(CHANGE));
    const result = lookupMemoized(
      store,
      inventoryOf([CHANGE]),
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      PATH_SET_DIGEST,
    );
    expect(result.eligiblePaths).toEqual(new Set(["src/a.ts"]));
    expect(result.hits.get("src/a.ts")).toEqual(entryFor(CHANGE));
    expect(result.contextInvalidated).toBe(0);
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
      PATH_SET_DIGEST,
    );
    expect(result.eligiblePaths).toEqual(new Set(["src/a.ts"]));
    expect(result.hits.size).toBe(0);
    // A plain content miss, not a path-set rejection: the key itself never matched, so this must
    // not be counted as a context invalidation.
    expect(result.contextInvalidated).toBe(0);
  });

  it("counts an added file as eligible too, keyed on its all-zero base blob", () => {
    const added = rawChange({
      path: "src/new.ts",
      status: "A",
      oldMode: MODE_ABSENT,
      oldBlob: blobId("0".repeat(40)),
    });
    const store = storeWithEntry(entryFor(added));
    const result = lookupMemoized(
      store,
      inventoryOf([added]),
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      PATH_SET_DIGEST,
    );
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
      PATH_SET_DIGEST,
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
      PATH_SET_DIGEST,
    );
    expect(result.hits.size).toBe(0);
    expect(result.eligiblePaths.size).toBe(0);
  });
});

describe("lookupMemoized: changed-path-set digest (v0.10.0, issue #50)", () => {
  const A = rawChange({ path: "src/a.ts" }); // byte-identical across every PR state below.
  // A blob pair distinct from A's own default, so a's and b's computed keys never accidentally
  // collide — `computeKey` does not itself encode the path, only content and configuration.
  const B = rawChange({
    path: "src/b.ts",
    oldBlob: blobId("c".repeat(40)),
    newBlob: blobId("d".repeat(40)),
  });

  it("invalidates replay when the PR's changed-path set widens to include a new file — the exact gap issue #50 bounds", () => {
    // PR state A: {a, b} reviewed; `a`'s entry is written under state A's own path-set digest.
    const stateA = inventoryOf([A, B]);
    const store = storeWithEntry(entryFor(A, [], computePrPathSetDigest(stateA)));

    // PR state B: a further push adds a brand-new file `c` alongside `a` and `b`. `a` did not
    // change (same oldBlob/newBlob as in state A), but the changed-file set now has three members.
    const bLater = rawChange({
      path: "src/b.ts",
      oldBlob: blobId("c".repeat(40)),
      newBlob: blobId("e".repeat(40)),
    });
    const c = rawChange({
      path: "src/c.ts",
      status: "A",
      oldMode: MODE_ABSENT,
      oldBlob: blobId("0".repeat(40)),
    });
    const stateB = inventoryOf([A, bLater, c]);

    const result = lookupMemoized(
      store,
      stateB,
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      computePrPathSetDigest(stateB),
    );

    expect(result.hits.has("src/a.ts")).toBe(false);
    expect(result.contextInvalidated).toBe(1);
    // `c` counts as eligible too (an added file is cache-eligible content, see `isCacheEligible`),
    // even though nothing in the store could ever have answered for a path that did not exist yet.
    expect(result.eligiblePaths).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]));
  });

  it("keeps a hit when the changed-path set is unchanged, even though a sibling file's content changed", () => {
    const stateA = inventoryOf([A, B]);
    const store = storeWithEntry(entryFor(A, [], computePrPathSetDigest(stateA)));

    // Same two path *names* — {a, b} — but b's own content changed. a's replay must not care.
    const bChanged = rawChange({
      path: "src/b.ts",
      oldBlob: blobId("c".repeat(40)),
      newBlob: blobId("f".repeat(40)),
    });
    const stateB = inventoryOf([A, bChanged]);

    const result = lookupMemoized(
      store,
      stateB,
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      computePrPathSetDigest(stateB),
    );

    expect(result.hits.has("src/a.ts")).toBe(true);
    // b itself is a miss too, but on content (its blobs differ), never on path-set context.
    expect(result.contextInvalidated).toBe(0);
    expect(result.hits.has("src/b.ts")).toBe(false);
  });

  it("invalidates replay when a rename appears anywhere in the changed-path set", () => {
    const stateA = inventoryOf([A, B]);
    const store = storeWithEntry(entryFor(A, [], computePrPathSetDigest(stateA)));

    // `a` and `b` are both untouched; an unrelated file is renamed in this push.
    const rename = rawChange({
      path: "src/e.ts",
      status: "R",
      oldPath: repoPath("src/d.ts"),
    });
    const stateB = inventoryOf([A, B, rename]);

    const result = lookupMemoized(
      store,
      stateB,
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      computePrPathSetDigest(stateB),
    );

    expect(result.hits.has("src/a.ts")).toBe(false);
    expect(result.contextInvalidated).toBe(1);
  });

  it("counts a context invalidation separately from an ordinary content miss in the same run", () => {
    const stateA = inventoryOf([A, B]);
    // `a` is stored under state A's digest; `b` is never stored at all.
    const store = storeWithEntry(entryFor(A, [], computePrPathSetDigest(stateA)));

    const c = rawChange({
      path: "src/c.ts",
      status: "A",
      oldMode: MODE_ABSENT,
      oldBlob: blobId("0".repeat(40)),
    });
    const stateB = inventoryOf([A, B, c]); // widened set invalidates a's otherwise-matching entry.

    const result = lookupMemoized(
      store,
      stateB,
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      computePrPathSetDigest(stateB),
    );

    expect(result.hits.size).toBe(0);
    expect(result.eligiblePaths).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]));
    // Exactly one of the two stored-but-rejected misses (`a`) is a context invalidation; `b` was
    // simply never cached, and `c` never had a chance to be.
    expect(result.contextInvalidated).toBe(1);
  });
});

describe("computePrPathSetDigest", () => {
  it("is stable for the same inventory regardless of the order its items were built in", () => {
    const a = rawChange({ path: "src/a.ts" });
    const b = rawChange({ path: "src/b.ts" });
    expect(computePrPathSetDigest(inventoryOf([a, b]))).toBe(
      computePrPathSetDigest(inventoryOf([b, a])),
    );
  });

  it("changes when a file is added to the inventory", () => {
    const a = rawChange({ path: "src/a.ts" });
    const b = rawChange({ path: "src/b.ts" });
    expect(computePrPathSetDigest(inventoryOf([a]))).not.toBe(
      computePrPathSetDigest(inventoryOf([a, b])),
    );
  });

  it("changes when a plain add is replaced by a rename to the same new path", () => {
    // Proves the rename token is not simply the bare new path: an ordinary add at "src/new.ts" and
    // a rename ending at "src/new.ts" must not be indistinguishable to this digest.
    const added = rawChange({
      path: "src/new.ts",
      status: "A",
      oldMode: MODE_ABSENT,
      oldBlob: blobId("0".repeat(40)),
    });
    const renamed = rawChange({
      path: "src/new.ts",
      status: "R",
      oldPath: repoPath("src/old.ts"),
    });
    expect(computePrPathSetDigest(inventoryOf([added]))).not.toBe(
      computePrPathSetDigest(inventoryOf([renamed])),
    );
  });

  it("counts every changed path, including one the review profile excludes from review", () => {
    const excludingProfile = compileProfile({
      version: 1,
      reviewRelevant: ["src/**"],
      deletionCritical: [],
      generated: [],
      excluded: [{ pattern: "docs/**", reason: "documentation" }],
      benignWarnings: [],
      pathInstructions: [],
    } satisfies ReviewProfile);
    function withExcludingProfile(changes: readonly RawChange[]): Inventory {
      const items = changes.map((change) => toItem(excludingProfile, change));
      return {
        pair: { base: SHA, head: SHA, mergeBase: SHA },
        items,
        reviewablePaths: new Set(items.filter((i) => i.reviewable).map((i) => i.path as string)),
        unclassified: [],
      };
    }

    const reviewed = rawChange({ path: "src/a.ts" });
    const excluded = rawChange({ path: "docs/notes.md" }); // matches the exclusion above verbatim
    expect(computePrPathSetDigest(withExcludingProfile([reviewed]))).not.toBe(
      computePrPathSetDigest(withExcludingProfile([reviewed, excluded])),
    );
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
      pathSetDigest: PATH_SET_DIGEST,
      config: CONFIG,
    });
    expect(entries).toEqual([entryFor(CHANGE, [])]);
  });

  it("stamps every produced entry with the pathSetDigest it was given (v0.10.0, issue #50)", () => {
    const distinctDigest = sha256("6".repeat(64));
    const entries = buildNewEntries({
      inventory: inventoryOf([CHANGE]),
      eligiblePaths: new Set(["src/a.ts"]),
      hitPaths: new Set(),
      findings: [],
      ruleDigest: RULE_DIGEST,
      engineDigest: ENGINE_DIGEST,
      pathSetDigest: distinctDigest,
      config: CONFIG,
    });
    expect(entries).toEqual([entryFor(CHANGE, [], distinctDigest)]);
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
      pathSetDigest: PATH_SET_DIGEST,
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
      pathSetDigest: PATH_SET_DIGEST,
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
      pathSetDigest: PATH_SET_DIGEST,
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
      pathSetDigest: PATH_SET_DIGEST,
      config: badConfig,
    });
    expect(entries).toEqual([]);
  });
});
