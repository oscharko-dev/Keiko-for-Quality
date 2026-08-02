import type { RuntimeConfig } from "../config/runtime.js";
import type { Sha256 } from "../core/brands.js";
import type { EngineFinding } from "../engine/result.js";
import type { InventoryItem } from "../inventory/classify.js";
import type { Inventory } from "../inventory/inventory.js";
import { computeKey, lookup, modelId, type CacheEntry, type CacheStore } from "./review-cache.js";

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

export interface MemoLookupResult {
  /** Cache-eligible paths a stored entry answered this run. */
  readonly hits: ReadonlyMap<string, CacheEntry>;
  /** Every cache-eligible path considered, hit or not — the denominator `misses` is measured against. */
  readonly eligiblePaths: ReadonlySet<string>;
}

const EMPTY_LOOKUP: MemoLookupResult = { hits: new Map(), eligiblePaths: new Set() };

/**
 * Looks up every cache-eligible path in `inventory` against `store`.
 *
 * Fails open, deliberately: an invalid `config.model` (control characters `parseRuntimeConfig`
 * does not itself reject) or an absent `engineDigest` (an unsupported platform) disables
 * memoization for this run — every path reports as a miss — rather than throwing and failing the
 * review itself. Memoization is a pure optimization layer; nothing about it may gate completeness.
 */
export function lookupMemoized(
  store: CacheStore | undefined,
  inventory: Inventory,
  ruleDigest: Sha256,
  engineDigest: Sha256 | undefined,
  config: RuntimeConfig,
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
    if (entry !== undefined) hits.set(path, entry);
  }
  return { hits, eligiblePaths };
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
      modelId: model,
      protocol: proto,
      findings: byPath.get(path) ?? [],
    });
  }
  return entries;
}
