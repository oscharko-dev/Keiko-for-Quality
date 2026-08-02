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

function countByKind(items: readonly InventoryItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item.classification.kind.replace(/-/g, "_");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
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
