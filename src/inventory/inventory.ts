import type { CommitSha, RepoPath } from "../core/brands.js";
import type { CompiledProfile } from "../config/profile.js";
import type { Diagnostics } from "../diagnostics/sink.js";
import { listChanges, mergeBase, verifyCommit, type GitContext } from "../git/plumbing.js";
import { toItem, type InventoryItem } from "./classify.js";

/**
 * The immutable pair one review is computed over.
 *
 * Deriving the merge base here — rather than trusting whatever the event happened to name — is what
 * makes two runs of the same head comparable even after the target branch has moved on. Both this
 * inventory and the engine receive exactly this pair, so their change sets are the same set by
 * construction and any difference between them is a real finding, not a race.
 */
export interface ReviewPair {
  readonly base: CommitSha;
  readonly head: CommitSha;
  readonly mergeBase: CommitSha;
}

export interface Inventory {
  readonly pair: ReviewPair;
  readonly items: readonly InventoryItem[];
  /** Paths the engine must account for. */
  readonly reviewablePaths: ReadonlySet<string>;
  /** Paths the profile failed to describe. A non-empty set fails the run. */
  readonly unclassified: readonly RepoPath[];
}

export async function resolveReviewPair(
  ctx: GitContext,
  base: CommitSha,
  head: CommitSha,
): Promise<ReviewPair> {
  await verifyCommit(ctx, base);
  await verifyCommit(ctx, head);
  return { base, head, mergeBase: await mergeBase(ctx, base, head) };
}

/**
 * The diagnostic bucket name for one item's classification.
 *
 * Ordinarily the classification's `kind` is the whole story. `mechanically-clean` is the one kind
 * with more than one reason today, so its bucket carries the reason too — an operator reading
 * `mechanically_clean_pure_rename` learns what was skipped without opening the run. The diagnostics
 * sink's own key format (`^[a-z][a-z0-9_]{0,39}$`, no dots) is why the separator is `_` rather than
 * the `.` a nested name might suggest.
 */
function bucketKey(item: InventoryItem): string {
  const kind = item.classification.kind.replace(/-/g, "_");
  return item.classification.kind === "mechanically-clean"
    ? `${kind}_${item.classification.reason.replace(/-/g, "_")}`
    : kind;
}

function countByKind(items: readonly InventoryItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = bucketKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Paths downgraded to `mechanically-clean` — a pure rename today.
 *
 * Classification alone stops the inventory from requiring engine coverage of them, but the engine
 * would still spend tokens dispatching a path it was never asked to skip. Handing this list to the
 * engine as an exclude (see `buildRuleFile`) is what actually stops the spend, not just the
 * accounting.
 */
export function mechanicallyCleanPaths(inventory: Inventory): readonly string[] {
  return inventory.items
    .filter((item) => item.classification.kind === "mechanically-clean")
    .map((item) => item.path as string);
}

/**
 * Count of paths the profile's own `excluded` rules matched.
 *
 * Unlike `mechanicallyCleanPaths`, this is never threaded to the engine as an exclude: an excluded
 * path never matched `reviewRelevant` in the first place, so the engine's own rule-file dispatch
 * already skips it without help. This exists only for reporting — the run summary's own accounting
 * of what a pull request touched and why each path did or did not reach the model.
 */
export function excludedPathCount(inventory: Inventory): number {
  return inventory.items.filter((item) => item.classification.kind === "excluded").length;
}

export async function buildInventory(
  ctx: GitContext,
  profile: CompiledProfile,
  pair: ReviewPair,
  renamePercent: number,
  diagnostics: Diagnostics,
): Promise<Inventory> {
  const changes = await listChanges(ctx, pair.mergeBase, pair.head, renamePercent);
  const items = changes.map((change) => toItem(profile, change));
  const unclassified = items
    .filter((item) => item.classification.kind === "unclassified")
    .map((item) => item.path);
  const reviewablePaths = new Set(items.filter((i) => i.reviewable).map((i) => i.path as string));

  diagnostics.record(items.length === 0 ? "inventory.empty" : "inventory.completed", {
    headSha: pair.head,
    counts: { total: items.length, reviewable: reviewablePaths.size, ...countByKind(items) },
  });

  if (unclassified.length > 0) {
    diagnostics.record("inventory.unclassified_path", {
      headSha: pair.head,
      counts: { unclassified: unclassified.length },
    });
  }

  return { pair, items, reviewablePaths, unclassified };
}
