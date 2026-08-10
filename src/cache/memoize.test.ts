import { describe, expect, it } from "vitest";

import { compileProfile, type CompiledProfile, type ReviewProfile } from "../config/profile.js";
import type { RuntimeConfig } from "../config/runtime.js";
import { blobId, commitSha, repoPath, sha256, type Sha256 } from "../core/brands.js";
import { singleShotContextDigest } from "../engine/companions.js";
import type { EngineFinding } from "../engine/result.js";
import { toItem } from "../inventory/classify.js";
import type { Inventory } from "../inventory/inventory.js";
import { MODE_ABSENT, MODE_REGULAR, MODE_SYMLINK, type RawChange } from "../git/plumbing.js";
import {
  SUPPORTED_STORE_SCHEMA,
  computeKey,
  computePathSetDigest,
  modelId,
  protocol,
  type CacheEntry,
  type CacheStore,
  PUBLICATION_SEMANTICS,
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
  contractPairs: [],
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

// Shared by every test below, and also by the `computePrPathSetDigest` tests that need a profile
// other than the module-level default `PROFILE` (an excluding or a generating one) — one inventory
// builder rather than a copy re-declared per profile variant.
function inventoryWithProfile(profile: CompiledProfile, changes: readonly RawChange[]): Inventory {
  const items = changes.map((change) => toItem(profile, change));
  return {
    pair: { base: SHA, head: SHA, mergeBase: SHA },
    items,
    reviewablePaths: new Set(items.filter((i) => i.reviewable).map((i) => i.path as string)),
    unclassified: [],
  };
}

function inventoryOf(changes: readonly RawChange[]): Inventory {
  return inventoryWithProfile(PROFILE, changes);
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
    semantics: PUBLICATION_SEMANTICS,
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

  /**
   * A rename is eligible only WITH real content edits (v0.13.0) — a pure rename never reaches this
   * function at all, downgraded to `mechanically-clean` by `classify()` before the inventory ever
   * calls here, so there is nothing to pin for that case in this file (`inventory/classify.test.ts`
   * already owns it). This is the positive case: `"R"` with a blob pair that actually differs.
   */
  it("treats a rename with real content edits as cache-eligible", () => {
    const rename = rawChange({
      path: "src/renamed.ts",
      status: "R",
      oldPath: repoPath("src/old.ts"),
      // Distinct from CHANGE's own default blob pair, so this test's result is never a fixture
      // collision — only ever the real eligibility decision under test.
      oldBlob: blobId("6".repeat(40)),
      newBlob: blobId("7".repeat(40)),
    });
    const result = lookupMemoized(
      storeWithEntry(entryFor(CHANGE)),
      inventoryOf([rename]),
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      PATH_SET_DIGEST,
    );
    expect(result.eligiblePaths).toEqual(new Set(["src/renamed.ts"]));
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

    // `a` and `b` are both untouched; an unrelated file is renamed in this push. A distinct blob
    // pair (v0.13.0: a rename with real edits is itself cache-eligible content, see
    // `isCacheEligible`) keeps this test about the path-set digest alone — without it, the
    // rename's default blobs would accidentally match `a`'s own stored key and this test would be
    // pinning a fixture collision, not the invalidation rule it names.
    const rename = rawChange({
      path: "src/e.ts",
      status: "R",
      oldPath: repoPath("src/d.ts"),
      oldBlob: blobId("8".repeat(40)),
      newBlob: blobId("9".repeat(40)),
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
  it("changes when the rendered pull-request purpose changes", () => {
    const inventory = inventoryOf([rawChange({ path: "src/a.ts" })]);
    const first = computePrPathSetDigest(inventory, "bounded purpose one");
    expect(computePrPathSetDigest(inventory, "bounded purpose one")).toBe(first);
    expect(computePrPathSetDigest(inventory, "bounded purpose two")).not.toBe(first);
    expect(computePrPathSetDigest(inventory)).not.toBe(first);
  });

  it("changes when configured merge-base guideline contents change", () => {
    const inventory = inventoryOf([rawChange({ path: "src/a.ts" })]);
    const first = computePrPathSetDigest(inventory, "", "guideline-content-v1");

    expect(computePrPathSetDigest(inventory, "", "guideline-content-v1")).toBe(first);
    expect(computePrPathSetDigest(inventory, "", "guideline-content-v2")).not.toBe(first);
    expect(computePrPathSetDigest(inventory)).not.toBe(first);
  });

  it("is stable for the same inventory regardless of the order its items were built in", () => {
    const a = rawChange({ path: "src/a.ts" });
    const b = rawChange({ path: "src/b.ts" });
    expect(computePrPathSetDigest(inventoryOf([a, b]))).toBe(
      computePrPathSetDigest(inventoryOf([b, a])),
    );
  });

  it("changes when a reviewable file is added to the inventory", () => {
    const a = rawChange({ path: "src/a.ts" });
    const b = rawChange({ path: "src/b.ts" });
    expect(computePrPathSetDigest(inventoryOf([a]))).not.toBe(
      computePrPathSetDigest(inventoryOf([a, b])),
    );
  });

  it("changes when a plain add is replaced by a rename to the same new path", () => {
    // Proves the rename token is not simply the bare new path: an ordinary add at "src/new.ts" and
    // a rename ending at "src/new.ts" must not be indistinguishable to this digest. Both sides stay
    // classified `reviewed` (their content differs from `rawChange`'s own default oldBlob/newBlob
    // pair), so neither is filtered out by the reviewable-only narrowing below.
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

  it("folds a reviewable rename into its old->new token exactly as before the reviewable-only narrowing", () => {
    // `renamed`'s newBlob ("b"-repeat, `rawChange`'s own default) differs from its oldBlob
    // ("a"-repeat, also the default) so it is a content-changing rename, not a pure one — it stays
    // classified `reviewed`, hence reviewable, hence not filtered. Pinned directly against the
    // lower-level `computePathSetDigest` primitive rather than only against another
    // `computePrPathSetDigest` call, so a regression that changed the fold format itself — not just
    // whether folding happens — would also be caught here.
    const renamed = rawChange({
      path: "src/renamed.ts",
      status: "R",
      oldPath: repoPath("src/old.ts"),
    });
    expect(computePrPathSetDigest(inventoryOf([renamed]))).toBe(
      computePathSetDigest(["src/old.ts->src/renamed.ts"]),
    );
  });

  it("excludes a pure rename (mechanically-clean, not reviewable) from the digest entirely", () => {
    // Identical blob and mode on both sides is exactly `isPureRename` (see `classify.ts`): the item
    // is downgraded to `mechanically-clean`, never `reviewable`. It is never dispatched to the engine
    // either — `mechanicallyCleanPaths` threads it into the exclude list instead — so it must not
    // move a digest that now bounds only the reviewed set's shape.
    const a = rawChange({ path: "src/a.ts" });
    const pureRename = rawChange({
      path: "src/renamed.ts",
      status: "R",
      oldPath: repoPath("src/old.ts"),
      newBlob: blobId("a".repeat(40)), // matches rawChange's own default oldBlob: same content
    });
    expect(computePrPathSetDigest(inventoryOf([a]))).toBe(
      computePrPathSetDigest(inventoryOf([a, pureRename])),
    );
  });

  it("does not widen the reviewed-set component when an excluded path is added", () => {
    const excludingProfile = compileProfile({
      version: 1,
      reviewRelevant: ["src/**"],
      deletionCritical: [],
      generated: [],
      excluded: [{ pattern: "docs/**", reason: "documentation" }],
      benignWarnings: [],
      pathInstructions: [],
      contractPairs: [],
    } satisfies ReviewProfile);

    const reviewed = rawChange({ path: "src/a.ts" });
    // The staged path-specific digest separately binds this file if its bounded diff is actually
    // selected as a companion; mere non-reviewable set membership must not reprice every entry.
    const excluded = rawChange({ path: "docs/notes.md" });
    expect(computePrPathSetDigest(inventoryWithProfile(excludingProfile, [reviewed]))).toBe(
      computePrPathSetDigest(inventoryWithProfile(excludingProfile, [reviewed, excluded])),
    );
  });

  it("does not widen the reviewed-set component when a generated path is added", () => {
    const generatingProfile = compileProfile({
      version: 1,
      reviewRelevant: ["src/**"],
      deletionCritical: [],
      generated: ["dist/**"],
      excluded: [],
      benignWarnings: [],
      pathInstructions: [],
      contractPairs: [],
    } satisfies ReviewProfile);

    const reviewed = rawChange({ path: "src/a.ts" });
    // As above, any actual staged prompt contribution belongs to that path's narrow context
    // identity; this digest names only the globally reviewable set.
    const generated = rawChange({ path: "dist/bundle.js" });
    expect(computePrPathSetDigest(inventoryWithProfile(generatingProfile, [reviewed]))).toBe(
      computePrPathSetDigest(inventoryWithProfile(generatingProfile, [reviewed, generated])),
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

  /**
   * The remap (v0.13.0): a replayed finding's path comes from the LOOKUP key `hits` is keyed by,
   * never trusted from the stored entry itself — the prerequisite for a rename with real content
   * edits (`isCacheEligible`) to replay soundly, since its stored entry carries its OLD path.
   */
  it("remaps a replayed finding's path onto the current lookup path, not whatever the stored entry says", () => {
    // The entry was written under a DIFFERENT path than the one it is looked up for here — exactly
    // the shape a renamed file's stored entry takes.
    const staleFinding: EngineFinding = { ...FINDING, path: repoPath("src/old-name.ts") };
    const hits = new Map([
      ["src/new-name.ts", entryFor(rawChange({ path: "src/old-name.ts" }), [staleFinding])],
    ]);

    const merged = mergeHitFindings([], hits);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.path).toBe("src/new-name.ts");
    // Nothing else about the finding is touched — only the path field is ever remapped.
    expect(merged[0]).toMatchObject({ content: FINDING.content, startLine: FINDING.startLine });
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

describe("per-path context digests (single-shot, v0.20.1)", () => {
  const EMPTY_CHANGE = rawChange({ path: "src/empty.ts" });
  const EMPTY_INVENTORY = inventoryOf([EMPTY_CHANGE]);

  function emptyEntry(contextDigest: Sha256, pathSetDigest = PATH_SET_DIGEST): CacheEntry {
    const entries = buildNewEntries({
      inventory: EMPTY_INVENTORY,
      eligiblePaths: new Set(["src/empty.ts"]),
      hitPaths: new Set(),
      findings: [],
      ruleDigest: RULE_DIGEST,
      engineDigest: ENGINE_DIGEST,
      pathSetDigest,
      contextDigests: new Map([["src/empty.ts", contextDigest]]),
      config: CONFIG,
    });
    const entry = entries[0];
    if (entry === undefined) throw new Error("expected empty cache entry fixture");
    return entry;
  }

  function lookupEmpty(
    entry: CacheEntry,
    pathSetDigest: Sha256,
    contextDigest: Sha256,
  ): ReturnType<typeof lookupMemoized> {
    return lookupMemoized(
      storeWithEntry(entry),
      EMPTY_INVENTORY,
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      pathSetDigest,
      new Map([["src/empty.ts", contextDigest]]),
    );
  }

  it("reuses positive hypotheses on matching per-path context and refuses a moved group", () => {
    const changeA = rawChange({ path: "src/a.ts" });
    const changeB = rawChange({
      path: "src/b.ts",
      oldBlob: blobId("3".repeat(40)),
      newBlob: blobId("4".repeat(40)),
    });
    const inventory = inventoryOf([changeA, changeB]);
    const digests = new Map<string, Sha256>([
      ["src/a.ts", sha256("c".repeat(64))],
      ["src/b.ts", sha256("d".repeat(64))],
    ]);
    const findingForA: EngineFinding = {
      path: repoPath("src/a.ts"),
      content: "The unchecked value reaches an unsafe sink.",
      startLine: 1,
      endLine: 1,
      severity: "high",
      category: "bug",
    };
    const findingForB: EngineFinding = { ...findingForA, path: repoPath("src/b.ts") };
    const written = buildNewEntries({
      inventory,
      eligiblePaths: new Set(["src/a.ts", "src/b.ts"]),
      hitPaths: new Set(),
      findings: [findingForA, findingForB],
      ruleDigest: RULE_DIGEST,
      engineDigest: ENGINE_DIGEST,
      pathSetDigest: PATH_SET_DIGEST,
      contextDigests: digests,
      config: CONFIG,
    });
    // Each entry is stamped with its OWN group digest, not the whole-set scalar.
    expect(written.map((entry) => entry.prPathSetDigest).sort()).toEqual(
      [...digests.values()].sort(),
    );
    const store: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: written };

    // A later run whose whole-set scalar moved (an unrelated file joined the PR) still replays
    // every file whose OWN companion group is unchanged...
    const unchanged = lookupMemoized(
      store,
      inventory,
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      sha256("8".repeat(64)),
      digests,
    );
    expect(unchanged.hits.size).toBe(2);
    expect(unchanged.contextInvalidated).toBe(0);

    // ...and refuses exactly the file whose companion group moved.
    const moved = new Map(digests);
    moved.set("src/b.ts", sha256("e".repeat(64)));
    const partial = lookupMemoized(
      store,
      inventory,
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      sha256("8".repeat(64)),
      moved,
    );
    expect([...partial.hits.keys()]).toEqual(["src/a.ts"]);
    expect(partial.contextInvalidated).toBe(1);
  });

  it("binds an empty staged verdict to the domain-separated path-set and per-path composite", () => {
    const contextDigest = sha256("c".repeat(64));
    const entry = emptyEntry(contextDigest);

    // Pins the framing and domain, not merely that the result differs from either scalar.
    expect(entry.prPathSetDigest).toBe(
      sha256("296b7ca345910536aafc227f201823a1f536d2da4a39e3f086d14898583ae803"),
    );
    expect(entry.prPathSetDigest).not.toBe(PATH_SET_DIGEST);
    expect(entry.prPathSetDigest).not.toBe(contextDigest);

    const sameContext = lookupEmpty(entry, PATH_SET_DIGEST, contextDigest);
    expect(sameContext.hits.has("src/empty.ts")).toBe(true);
    expect(sameContext.contextInvalidated).toBe(0);
  });

  it("invalidates an empty staged verdict when the whole reviewable path set changes", () => {
    const contextDigest = sha256("c".repeat(64));
    const moved = lookupEmpty(emptyEntry(contextDigest), sha256("8".repeat(64)), contextDigest);

    expect(moved.hits.size).toBe(0);
    expect(moved.contextInvalidated).toBe(1);
  });

  it("invalidates an empty staged verdict when its companion or prompt context changes", () => {
    const entry = emptyEntry(sha256("c".repeat(64)));
    const moved = lookupEmpty(entry, PATH_SET_DIGEST, sha256("d".repeat(64)));

    expect(moved.hits.size).toBe(0);
    expect(moved.contextInvalidated).toBe(1);
  });

  it("invalidates an empty staged-v7 verdict under the staged-v8 workflow identity", () => {
    const identity = {
      renderedChangeIntent: "same intent",
      contextPack: "same context pack",
      guidelineContextIdentity: "same guidelines",
    };
    const stagedV5 = singleShotContextDigest([], () => undefined, {
      ...identity,
      workflowIdentity: "staged-v7",
    });
    const stagedV6 = singleShotContextDigest([], () => undefined, {
      ...identity,
      workflowIdentity: "staged-v8",
    });

    expect(stagedV6).not.toBe(stagedV5);
    const moved = lookupEmpty(emptyEntry(stagedV5), PATH_SET_DIGEST, stagedV6);
    expect(moved.hits.size).toBe(0);
    expect(moved.contextInvalidated).toBe(1);
  });

  it("preserves the historical whole-path-set scalar for empty agentic entries", () => {
    const written = buildNewEntries({
      inventory: EMPTY_INVENTORY,
      eligiblePaths: new Set(["src/empty.ts"]),
      hitPaths: new Set(),
      findings: [],
      ruleDigest: RULE_DIGEST,
      engineDigest: ENGINE_DIGEST,
      pathSetDigest: PATH_SET_DIGEST,
      config: CONFIG,
    });

    expect(written[0]?.prPathSetDigest).toBe(PATH_SET_DIGEST);
    const replayed = lookupMemoized(
      { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: written },
      EMPTY_INVENTORY,
      RULE_DIGEST,
      ENGINE_DIGEST,
      CONFIG,
      PATH_SET_DIGEST,
    );
    expect(replayed.hits.has("src/empty.ts")).toBe(true);
  });
});
