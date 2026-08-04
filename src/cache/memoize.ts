import type { RuntimeConfig } from "../config/runtime.js";
import type { Sha256 } from "../core/brands.js";
import type { EngineFinding } from "../engine/result.js";
import type { InventoryItem } from "../inventory/classify.js";
import type { Inventory } from "../inventory/inventory.js";
import {
  computeKey,
  computePathSetDigest,
  lookup,
  modelId,
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
 * Restricted to `"M"`/`"A"` content actually classified `reviewed` — a rename or a deletion is
 * cache-ineligible by design (v0.9.0 scope boundary, not a defect: a rename's content did not
 * change and a deletion has no head blob to key on), and a symlink or submodule pointer is a
 * pointer move, not reviewed text, even when the inventory still requires coverage of it.
 */
function isCacheEligible(item: InventoryItem): boolean {
  return (
    item.classification.kind === "reviewed" &&
    (item.status === "M" || item.status === "A") &&
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
 * the store, even though none of those paths are ever shown to the model — not on the run that wrote
 * the cache entry, and not on the run that would replay it. A path the model never sees cannot be
 * the "unrelated file's import surface" this digest exists to catch (see `review-cache.ts`'s
 * top-of-file comment for that risk in full), so it is not review context and must not move the
 * bound.
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
 */
export function computePrPathSetDigest(inventory: Inventory): Sha256 {
  const reviewable = inventory.items.filter((item) => item.reviewable);
  return computePathSetDigest(reviewable.map(pathSetToken));
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
 * computed once by the caller via `computePrPathSetDigest` so every path in this loop is compared
 * against the exact same value. A stored entry only counts as a hit when its own `prPathSetDigest`
 * equals this one; otherwise it is a content match this run refuses to replay, counted in
 * `contextInvalidated` rather than `hits`.
 */
export function lookupMemoized(
  store: CacheStore | undefined,
  inventory: Inventory,
  ruleDigest: Sha256,
  engineDigest: Sha256 | undefined,
  config: RuntimeConfig,
  pathSetDigest: Sha256,
): MemoLookupResult {
  if (store === undefined || engineDigest === undefined) return EMPTY_LOOKUP;

  let model;
  try {
    model = modelId(config.model);
  } catch {
    return EMPTY_LOOKUP;
  }

  const hits = new Map<string, CacheEntry>();
  const eligiblePaths = new Set<string>();
  let contextInvalidated = 0;
  for (const item of inventory.items) {
    if (!isCacheEligible(item) || item.baseBlob === undefined || item.headBlob === undefined) {
      continue;
    }
    const path = item.path as string;
    eligiblePaths.add(path);
    const key = computeKey(
      item.baseBlob,
      item.headBlob,
      ruleDigest,
      engineDigest,
      model,
      config.protocol,
    );
    const entry = lookup(store, key);
    if (entry === undefined) continue;
    if (entry.prPathSetDigest === pathSetDigest) hits.set(path, entry);
    else contextInvalidated += 1;
  }
  return { hits, eligiblePaths, contextInvalidated };
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
 * produced: they still pass through the existing publisher path — sanitization and marker-based
 * deduplication run again — so nothing here treats a cached finding as pre-cleared for publication.
 */
export function mergeHitFindings(
  engineFindings: readonly EngineFinding[],
  hits: ReadonlyMap<string, CacheEntry>,
): readonly EngineFinding[] {
  if (hits.size === 0) return engineFindings;
  const cached = [...hits.values()].flatMap((entry) => entry.findings);
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
   * via `computePrPathSetDigest` — the same value `lookupMemoized` was given, so an entry this run
   * writes is stamped with exactly the digest a later run with an unchanged path set will match.
   */
  readonly pathSetDigest: Sha256;
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
export function buildNewEntries(inputs: NewEntryInputs): CacheEntry[] {
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
    entries.push({
      key,
      baseBlob: item.baseBlob,
      headBlob: item.headBlob,
      ruleDigest: inputs.ruleDigest,
      engineDigest: inputs.engineDigest,
      prPathSetDigest: inputs.pathSetDigest,
      modelId: model,
      protocol: proto,
      findings: byPath.get(path) ?? [],
    });
  }
  return entries;
}
