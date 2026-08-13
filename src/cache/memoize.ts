import { createHash } from "node:crypto";

import type { RuntimeConfig } from "../config/runtime.js";
import { repoPath, type Sha256 } from "../core/brands.js";
import type { EngineFinding } from "../engine/result.js";
import type { InventoryItem } from "../inventory/classify.js";
import type { Inventory } from "../inventory/inventory.js";
import {
  computeKey,
  computePathSetDigest,
  GENERATION_CHECKPOINT_SEMANTICS,
  lookupUnderSemantics,
  modelId,
  PUBLICATION_SEMANTICS,
  type CacheEntry,
  type CacheStore,
} from "./review-cache.js";

/**
 * Orchestrates `review-cache.ts`'s pure store primitives against one run's inventory.
 *
 * Everything here is a pure function of its arguments — no file I/O, no network, no clock. Store
 * I/O (reading the file before a run, writing it back after one) lives at the action layer
 * (`src/action/main.ts`), by design: this module never has to be trusted with a path, and it stays
 * testable without a filesystem.
 */

/**
 * Whether an inventory item can ever be looked up in, or written to, the review cache.
 *
 * Restricted to content actually classified `reviewed`, with a real head blob to key content on —
 * a deletion has no head blob at all, and a symlink or submodule pointer is a pointer move, not
 * reviewed text, even when the inventory still requires coverage of it. A PURE rename never reaches
 * this function to begin with: `classify()` (`inventory/classify.ts`) downgrades a rename with an
 * unchanged blob to `mechanically-clean`, which is never `reviewable` and therefore never iterated
 * here.
 *
 * `"R"` (v0.13.0) joins `"M"`/`"A"` for exactly that reason: every `"R"` status this function ever
 * sees is a rename WITH real content edits — its blob changed, so `classify()` already decided its
 * content needs review — and content-addressed lookup keys on the blob alone, never the path.
 * `mergeHitFindings`'s own path-remap (this module) is the prerequisite that makes replaying one
 * sound: a rename's stored entry carries its OLD path, and only that remap onto the current lookup
 * path stops a hit from replaying under a name the file no longer has.
 */
function isCacheEligible(item: InventoryItem): boolean {
  return (
    item.classification.kind === "reviewed" &&
    (item.status === "M" || item.status === "A" || item.status === "R") &&
    item.baseBlob !== undefined &&
    item.headBlob !== undefined
  );
}

/**
 * This item's own token in the reviewed changed-path-set digest (v0.10.0, issue #50).
 *
 * A rename folds the path it moved from into the token instead of contributing only its new name:
 * an old path silently disappearing from the diff is exactly the kind of context change an
 * unrelated file's cached verdict cannot see for itself. See `review-cache.ts`'s top-of-file
 * comment for the fuller "why names, not blobs" reasoning this token feeds. Only ever called on an
 * item `computePrPathSetDigest` has already confirmed is reviewable — see that function for why a
 * pure rename (downgraded to `mechanically-clean`, never reviewable) never reaches this function.
 */
function pathSetToken(item: InventoryItem): string {
  const path = item.path as string;
  return item.oldPath === undefined ? path : `${item.oldPath as string}->${path}`;
}

/**
 * This run's reviewed-path-set digest (v0.10.0, issue #50; narrowed to reviewable paths only).
 *
 * Originally hashed every changed path in the inventory, on the reasoning that a brand-new or
 * renamed-away neighbour can change an unrelated file's import surface regardless of whether that
 * neighbour was itself reviewed content. That reasoning proved too wide in practice: a lockfile
 * refresh, a generated-dist rebuild, or an excluded-docs edit invalidated every memoized verdict in
 * the store. Those paths are not members of the reviewable set and therefore must not widen this
 * global set bound merely by existing. Single-shot generation can still receive one as a bounded
 * companion: that exact prompt contribution is folded into the affected path's per-path context
 * digest, and an empty verdict binds that digest together with this whole reviewable-set digest.
 * Thus prompt context invalidates only entries that actually depended on it instead of repricing
 * the entire store.
 *
 * `item.reviewable` is the same predicate `buildInventory` (`inventory/inventory.ts`) folds into
 * `Inventory.reviewablePaths` and `engine/settle.ts` measures coverage against — not a new,
 * independently-maintained idea of "counts," but the one the rest of the codebase already treats as
 * "the engine must account for this." Filtering to it narrows the bound from "the pull request's
 * shape" to "the *reviewed* set's shape," which is the thing replay soundness actually depends on:
 * two runs that reviewed the same set of paths are comparable regardless of what unreviewed
 * housekeeping happened alongside them. A rename still folds as `"<old>-><new>"` (via
 * `pathSetToken`) exactly as before, but only when the renamed item itself is reviewable — a pure
 * rename (`mechanically-clean`) contributes no token at all now, matching it never reaching the
 * engine either (it is threaded into the engine's own exclude list — see `mechanicallyCleanPaths`).
 *
 * One-time cost, not a migration: every entry a store already holds was stamped under the old,
 * whole-inventory digest. None of those equal a freshly computed reviewable-only digest even when
 * the reviewed set itself has not moved, so the first run after this change re-prices every existing
 * entry once — an ordinary content miss, indistinguishable from a cold cache, never a crash or a
 * schema bump (`SUPPORTED_STORE_SCHEMA` is unchanged). The store self-heals forward from there:
 * every entry written from this run on carries the new digest, and replay against those is sound
 * again immediately.
 *
 * `renderedChangeIntent` is the exact bounded, framed PR-purpose block the model receives.
 * `guidelineContextIdentity` binds configured guideline contents read from the exact merge base.
 * Their digests join the path tokens so identical code reviewed for a materially different purpose
 * or repository rule cannot reuse the earlier generation verdict. Empty values keep the historical
 * path-only identity for local reviews with neither contribution.
 */
export function computePrPathSetDigest(
  inventory: Inventory,
  renderedChangeIntent = "",
  guidelineContextIdentity = "",
): Sha256 {
  const reviewable = inventory.items.filter((item) => item.reviewable);
  const tokens = reviewable.map(pathSetToken);
  if (renderedChangeIntent !== "") {
    const intentDigest = createHash("sha256").update(renderedChangeIntent, "utf8").digest("hex");
    tokens.push(`@change-intent:${intentDigest}`);
  }
  if (guidelineContextIdentity !== "") {
    const guidelineDigest = createHash("sha256")
      .update(guidelineContextIdentity, "utf8")
      .digest("hex");
    tokens.push(`@guideline-context:${guidelineDigest}`);
  }
  return computePathSetDigest(tokens);
}

export interface MemoLookupResult {
  /** Cache-eligible paths a stored entry answered this run. */
  readonly hits: ReadonlyMap<string, CacheEntry>;
  /** Every cache-eligible path considered, hit or not — the denominator `misses` is measured against. */
  readonly eligiblePaths: ReadonlySet<string>;
  /**
   * Eligible paths whose content-based key matched a stored entry, but whose stored
   * `prPathSetDigest` did not match this run's (v0.10.0, issue #50) — replay was refused because
   * the reviewed changed-file set moved since that entry was written. Already excluded from
   * `hits`, so already counted as an ordinary miss by any `eligiblePaths.size - hits.size`
   * arithmetic; this field exists only so a caller can log *why*, distinct from a plain content miss.
   */
  readonly contextInvalidated: number;
}

const EMPTY_LOOKUP: MemoLookupResult = {
  hits: new Map(),
  eligiblePaths: new Set(),
  contextInvalidated: 0,
};

/**
 * Looks up every cache-eligible path in `inventory` against `store`.
 *
 * Fails open, deliberately: an invalid `config.model` (control characters `parseRuntimeConfig`
 * does not itself reject) or an absent `engineDigest` (an unsupported platform) disables
 * memoization for this run — every path reports as a miss — rather than throwing and failing the
 * review itself. Memoization is a pure optimization layer; nothing about it may gate completeness.
 *
 * `pathSetDigest` (v0.10.0, issue #50) is this run's reviewed changed-path-set digest,
 * computed once by the caller via `computePrPathSetDigest`. It is the agentic replay stamp and one
 * component of a staged empty-verdict stamp; staged positive findings instead use their per-path
 * prompt-context digest. A stored entry only counts as a hit when `contextMatches` reconstructs
 * the same stamp under this run's inputs; otherwise it is a content match this run refuses to
 * replay, counted in `contextInvalidated` rather than `hits`.
 */
/** Domain tag for the empty-verdict composite; prevents either scalar from sharing its namespace. */
const EMPTY_VERDICT_CONTEXT_DOMAIN = "keiko-for-quality.cache.empty-verdict-context/v1";

/**
 * The replay stamp for one cache entry.
 *
 * A positive entry is a reusable hypothesis, so single-shot mode may bind it narrowly to the
 * per-path prompt context that generated it: the current verifier can still overturn the finding.
 * An empty entry has no hypothesis to verify. When single-shot supplies a per-path context, bind
 * that negative verdict to BOTH the whole reviewable path set and the exact prompt context. The
 * domain tag keeps this composite disjoint from either scalar even though all three values share
 * the same `Sha256` shape. Agentic runs supply no per-path context and deliberately retain the
 * historical whole-set scalar.
 *
 * Lookup and entry construction both call this function. Keeping the composition in one place is
 * load-bearing: a write-only or lookup-only change would turn every affected entry into a silent
 * permanent miss.
 */
function cacheContextDigest(
  pathSetDigest: Sha256,
  contextDigest: Sha256 | undefined,
  findings: readonly EngineFinding[],
): Sha256 {
  if (findings.length > 0) return contextDigest ?? pathSetDigest;
  if (contextDigest === undefined) return pathSetDigest;
  const material = [EMPTY_VERDICT_CONTEXT_DOMAIN, pathSetDigest, contextDigest].join("\0");
  return createHash("sha256").update(material, "utf8").digest("hex") as Sha256;
}

/** Whether a stored entry's context stamp matches this run's expectation for `path`. */
function contextMatches(
  entry: CacheEntry,
  path: string,
  pathSetDigest: Sha256,
  contextDigests: ReadonlyMap<string, Sha256> | undefined,
): boolean {
  const expected = cacheContextDigest(pathSetDigest, contextDigests?.get(path), entry.findings);
  return entry.prPathSetDigest === expected;
}

function configuredCacheModel(config: RuntimeConfig): ReturnType<typeof modelId> | undefined {
  try {
    return modelId(config.model);
  } catch {
    return undefined;
  }
}

interface ItemLookup {
  readonly path?: string;
  readonly entry?: CacheEntry;
  readonly contextInvalidated: boolean;
}

function lookupInventoryItem(
  item: Inventory["items"][number],
  store: CacheStore,
  ruleDigest: Sha256,
  engineDigest: Sha256,
  config: RuntimeConfig,
  model: ReturnType<typeof modelId>,
  pathSetDigest: Sha256,
  contextDigests: ReadonlyMap<string, Sha256> | undefined,
  semantics: CacheEntry["semantics"],
): ItemLookup {
  if (!isCacheEligible(item) || item.baseBlob === undefined || item.headBlob === undefined) {
    return { contextInvalidated: false };
  }
  const path = item.path as string;
  const key = computeKey(
    item.baseBlob,
    item.headBlob,
    ruleDigest,
    engineDigest,
    model,
    config.protocol,
  );
  const entry = lookupUnderSemantics(store, key, semantics);
  if (entry === undefined) return { path, contextInvalidated: false };
  if (contextMatches(entry, path, pathSetDigest, contextDigests)) {
    return { path, entry, contextInvalidated: false };
  }
  return { path, contextInvalidated: true };
}

function lookupBySemantics(
  store: CacheStore | undefined,
  inventory: Inventory,
  ruleDigest: Sha256,
  engineDigest: Sha256 | undefined,
  config: RuntimeConfig,
  pathSetDigest: Sha256,
  // Per-path context expectation (v0.20.1): in single-shot mode a file's verdict depends on its
  // companion group's diff identity, not on the whole pull request's path-set shape — see
  // `companions.ts` for the measurement (89% of a live window's spend went into whole-set
  // invalidations) and for why the agentic path keeps the conservative scalar. A staged empty
  // verdict composes the per-path value with `pathSetDigest`; an absent map or path keeps the
  // scalar, so the agentic path is byte-identical to before.
  contextDigests?: ReadonlyMap<string, Sha256>,
  semantics: CacheEntry["semantics"] = PUBLICATION_SEMANTICS,
): MemoLookupResult {
  if (store === undefined || engineDigest === undefined) return EMPTY_LOOKUP;
  const model = configuredCacheModel(config);
  if (model === undefined) return EMPTY_LOOKUP;

  const hits = new Map<string, CacheEntry>();
  const eligiblePaths = new Set<string>();
  let contextInvalidated = 0;
  for (const item of inventory.items) {
    const result = lookupInventoryItem(
      item,
      store,
      ruleDigest,
      engineDigest,
      config,
      model,
      pathSetDigest,
      contextDigests,
      semantics,
    );
    if (result.path === undefined) continue;
    eligiblePaths.add(result.path);
    if (result.entry !== undefined) hits.set(result.path, result.entry);
    else if (result.contextInvalidated) contextInvalidated += 1;
  }
  return { hits, eligiblePaths, contextInvalidated };
}

export function lookupMemoized(
  store: CacheStore | undefined,
  inventory: Inventory,
  ruleDigest: Sha256,
  engineDigest: Sha256 | undefined,
  config: RuntimeConfig,
  pathSetDigest: Sha256,
  contextDigests?: ReadonlyMap<string, Sha256>,
): MemoLookupResult {
  return lookupBySemantics(
    store,
    inventory,
    ruleDigest,
    engineDigest,
    config,
    pathSetDigest,
    contextDigests,
    PUBLICATION_SEMANTICS,
  );
}

/**
 * Raw generation checkpoints use the identical content/context identity as publication entries,
 * but are returned separately so callers must treat their findings as fresh, unaudited model
 * output. This is the trust boundary that makes resumability a generation optimization rather than
 * a publication bypass.
 */
export function lookupGenerationCheckpoints(
  store: CacheStore | undefined,
  inventory: Inventory,
  ruleDigest: Sha256,
  engineDigest: Sha256 | undefined,
  config: RuntimeConfig,
  pathSetDigest: Sha256,
  contextDigests?: ReadonlyMap<string, Sha256>,
): MemoLookupResult {
  return lookupBySemantics(
    store,
    inventory,
    ruleDigest,
    engineDigest,
    config,
    pathSetDigest,
    contextDigests,
    GENERATION_CHECKPOINT_SEMANTICS,
  );
}

/**
 * Unions this run's cache hits into the same exclude channel v0.8.0 built for mechanically-clean
 * paths — one threading point, one unioned list, per `buildRuleFile`'s own exclude contract. A
 * `Set` dedupes the (expected-empty) overlap: a path is never both a pure rename and cache-eligible
 * content, but nothing here depends on that being true.
 */
export function combinedExcludes(
  mechanicallyClean: readonly string[],
  hitPaths: ReadonlySet<string>,
): string[] {
  return [...new Set([...mechanicallyClean, ...hitPaths])];
}

/**
 * Merges cache-hit findings into the findings the engine itself produced this run.
 *
 * A hit's findings are exactly as untrusted on replay as they were the run they were first
 * produced: they still pass through the current truth/falsifier, sanitization, PR-wide ranking,
 * and marker-based deduplication, so nothing here treats a cached finding as pre-cleared for
 * publication. The cache saves generation only.
 *
 * Every replayed finding's `path` is remapped to the LOOKUP key — the current path `hits` is keyed
 * by (see `lookupMemoized`) — rather than trusted from the stored entry itself. This is required,
 * not defensive, now that `isCacheEligible` admits `"R"`: a rename's stored entry carries the path
 * it was written under, which is the file's OLD name, and only this remap makes replaying it under
 * the CURRENT name sound. It also protects an `"M"`/`"A"` entry against a rarer failure mode a
 * rename does not raise at all — a hash collision across two different paths whose blob/rule/
 * engine/model/protocol tuples happen to produce the identical content key — by trusting the
 * lookup path (a property of THIS run's own inventory) over whatever an old, possibly-colliding
 * stored entry happens to say.
 */
export function mergeHitFindings(
  engineFindings: readonly EngineFinding[],
  hits: ReadonlyMap<string, CacheEntry>,
): readonly EngineFinding[] {
  if (hits.size === 0) return engineFindings;
  const cached = [...hits.entries()].flatMap(([path, entry]) =>
    entry.findings.map((finding) => ({ ...finding, path: repoPath(path) })),
  );
  return [...engineFindings, ...cached];
}

export interface NewEntryInputs {
  readonly inventory: Inventory;
  readonly eligiblePaths: ReadonlySet<string>;
  readonly hitPaths: ReadonlySet<string>;
  /** The engine's own findings this run — never a cache hit's findings, which are already stored. */
  readonly findings: readonly EngineFinding[];
  readonly ruleDigest: Sha256;
  readonly engineDigest: Sha256;
  /**
   * This run's reviewed path-set digest (v0.10.0, issue #50), computed once by the caller
   * via `computePrPathSetDigest` — the same value `lookupMemoized` was given, so write and lookup
   * derive the same scalar or staged-empty composite under identical context.
   */
  readonly pathSetDigest: Sha256;
  /** Same per-path override as `lookupMemoized`'s parameter of this name, and it must be the SAME
   *  map the lookup used. Positive hypotheses use the narrow per-path value. Negative single-shot
   *  entries bind its composite with the whole path set; negative agentic entries retain the
   *  historical whole-set scalar. */
  readonly contextDigests?: ReadonlyMap<string, Sha256>;
  readonly config: RuntimeConfig;
}

function findingsByPath(findings: readonly EngineFinding[]): ReadonlyMap<string, EngineFinding[]> {
  const byPath = new Map<string, EngineFinding[]>();
  for (const finding of findings) {
    const path = finding.path as string;
    const existing = byPath.get(path);
    if (existing === undefined) byPath.set(path, [finding]);
    else existing.push(finding);
  }
  return byPath;
}

/**
 * Builds one cache entry per cache-eligible path the engine reviewed this run (i.e. every eligible
 * path that was *not* already a hit) — never for a path this run merely replayed, since that
 * path's entry already exists in the store unchanged.
 *
 * Findings included here are the engine's own output for a `complete` settlement: this is the only
 * caller-enforced condition for cache admission, matching the module's own "why an incomplete run
 * must never write an entry" reasoning in `review-cache.ts`.
 */
function buildEntries(inputs: NewEntryInputs, semantics: CacheEntry["semantics"]): CacheEntry[] {
  let model;
  try {
    model = modelId(inputs.config.model);
  } catch {
    return [];
  }
  const proto = inputs.config.protocol;
  const byPath = findingsByPath(inputs.findings);

  const entries: CacheEntry[] = [];
  for (const item of inputs.inventory.items) {
    const path = item.path as string;
    if (!inputs.eligiblePaths.has(path) || inputs.hitPaths.has(path)) continue;
    if (item.baseBlob === undefined || item.headBlob === undefined) continue;
    const key = computeKey(
      item.baseBlob,
      item.headBlob,
      inputs.ruleDigest,
      inputs.engineDigest,
      model,
      proto,
    );
    const pathFindings = byPath.get(path) ?? [];
    entries.push({
      key,
      baseBlob: item.baseBlob,
      headBlob: item.headBlob,
      ruleDigest: inputs.ruleDigest,
      engineDigest: inputs.engineDigest,
      // Positive hypotheses use their narrow prompt-context identity. Empty single-shot results
      // cannot be reverified, so they bind that identity together with the whole reviewed path set;
      // agentic results have no per-path identity and retain the historical scalar.
      prPathSetDigest: cacheContextDigest(
        inputs.pathSetDigest,
        inputs.contextDigests?.get(path),
        pathFindings,
      ),
      // Stamped from the constant rather than passed in: only this build knows which publication
      // contract produced these findings, and an entry that lied about it would be replayed by a
      // build whose sanitizer disagrees with the body it stored.
      semantics,
      modelId: model,
      protocol: proto,
      findings: pathFindings,
    });
  }
  return entries;
}

export function buildNewEntries(inputs: NewEntryInputs): CacheEntry[] {
  return buildEntries(inputs, PUBLICATION_SEMANTICS);
}

/** Builds raw-generation entries that must be reverified before any later publication. */
export function buildGenerationCheckpointEntries(inputs: NewEntryInputs): CacheEntry[] {
  return buildEntries(inputs, GENERATION_CHECKPOINT_SEMANTICS);
}
