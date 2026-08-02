import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommitSha, Sha256 } from "./core/brands.js";
import {
  buildNewEntries,
  combinedExcludes,
  computePrPathSetDigest,
  lookupMemoized,
  mergeHitFindings,
} from "./cache/memoize.js";
import {
  PARSE_LIMITS,
  appendEntries,
  type CacheEntry,
  type CacheStore,
} from "./cache/review-cache.js";
import type { CompiledProfile } from "./config/profile.js";
import type { GuidelineIndex } from "./config/guidelines.js";
import type { RuntimeConfig } from "./config/runtime.js";
import type { Diagnostics } from "./diagnostics/sink.js";
import type { ReasonCode } from "./diagnostics/reason-codes.js";
import { acquireEngine } from "./engine/acquire.js";
import { currentPlatformDigest } from "./engine/pinned-release.js";
import { parseEngineResult, type EngineFinding } from "./engine/result.js";
import { promptIdentityDigest } from "./engine/rule-identity.js";
import { runEngine } from "./engine/run.js";
import { settle, type Settlement } from "./engine/settle.js";
import type { GitContext } from "./git/plumbing.js";
import type { InventoryItem } from "./inventory/classify.js";
import {
  buildInventory,
  excludedPathCount,
  mechanicallyCleanPaths,
  resolveReviewPair,
  type Inventory,
} from "./inventory/inventory.js";
import type { GitHubClient, RepoRef } from "./github/client.js";
import {
  publishFindings,
  publishIncompleteNotice,
  type PublishContext,
  type PublishOutcome,
} from "./publish/publisher.js";

export interface ReviewRequest {
  readonly client: GitHubClient;
  readonly ref: RepoRef;
  readonly pullNumber: number;
  readonly base: CommitSha;
  readonly head: CommitSha;
  /** The trusted base checkout the engine runs against. */
  readonly repositoryPath: string;
  readonly config: RuntimeConfig;
  readonly profile: CompiledProfile;
  readonly guidelines: GuidelineIndex;
  readonly identity: string;
  readonly env: NodeJS.ProcessEnv;
  readonly pathValue: string;
  /**
   * The parsed review-cache store, already read by the action layer (v0.9.0). `undefined` — not an
   * empty store — is what disables the feature entirely: every code path below only branches on
   * this being present, so an absent store costs this run nothing beyond the check itself.
   */
  readonly cacheStore?: CacheStore;
}

export type ReviewOutcome = "complete" | "incomplete" | "abandoned";

export interface ReviewReport {
  readonly outcome: ReviewOutcome;
  readonly reason?: ReasonCode;
  /** Total changed paths classified, whatever the classification. */
  readonly inventorySize: number;
  /** Paths the engine must account for — `inventory.reviewablePaths.size`. */
  readonly reviewablePaths: number;
  /** Paths the profile's own `excluded` rules matched. */
  readonly excludedPaths: number;
  /** Paths downgraded to mechanically-clean (a pure rename today) — never sent to the engine. */
  readonly mechanicallyClean: number;
  readonly publish?: PublishOutcome;
  /** Cache-eligible paths a stored entry answered instead of the engine. Always 0 when inert. */
  readonly cacheHits: number;
  /** Cache-eligible paths that were sent to the engine anyway. Always 0 when inert. */
  readonly cacheMisses: number;
  /** How many new-or-refreshed entries `updatedCacheStore` carries over what was read in. */
  readonly cacheAppended: number;
  /** Present only for a `complete` outcome with the feature enabled — the store to write back. */
  readonly updatedCacheStore?: CacheStore;
}

/** Measured blended cost per reviewable file, rounded up. The formula's dominant term by design. */
const PER_FILE_TOKENS = 40_000;

/**
 * A weak secondary term, in tokens per changed line.
 *
 * Deliberately small relative to `PER_FILE_TOKENS`: line count is a poor predictor of spend next to
 * tool-call depth (how much the model searches and reads beyond the diff itself), so this term
 * nudges the estimate for an unusually large file without letting line count dominate it.
 */
const PER_LINE_TOKENS = 60;

/** Margin over the raw estimate, sized to the measured ~3x spend variance on identical input. */
const ALLOTMENT_MARGIN = 1.3;

/** Floor beneath which a 1-2-file pull request would otherwise get an unworkably small allotment. */
const ALLOTMENT_FLOOR = 80_000;

/** Ceiling past which a run is expected to chunk or escalate rather than run as one unbounded spend. */
const ALLOTMENT_CEILING = 6_000_000;

/** Review-cache retention, reusing the same bounds the store's own parser enforces on read. */
const RETENTION = {
  maxEntries: PARSE_LIMITS.maxEntries,
  maxFindingsPerEntry: PARSE_LIMITS.maxFindingsPerEntry,
};

/**
 * Clamps `value` to the inclusive range `[floor, ceiling]`.
 */
function clamp(value: number, floor: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(floor, value));
}

/**
 * The size-scaled per-run token allotment passed to the engine's own `--max-tokens-budget`.
 *
 * `tokenBudget` — the consumer's configured ceiling — is never widened by this formula, only ever
 * narrowed: the result is always `<= tokenBudget`. Everything else here estimates how much of that
 * ceiling *this* change plausibly needs, from its own shape rather than a fixed constant, so a
 * one-file typo fix and an 87-file rewrite are not held to the same allotment.
 *
 * @param tokenBudget The consumer's hard ceiling for the whole review.
 * @param reviewableFileCount `N` — the number of paths the engine must account for.
 * @param reviewableChangedLines `D` — added-plus-deleted lines across those same paths.
 */
export function computeAllottedBudget(
  tokenBudget: number,
  reviewableFileCount: number,
  reviewableChangedLines: number,
): number {
  const sizeScaled =
    ALLOTMENT_MARGIN *
    (reviewableFileCount * PER_FILE_TOKENS + reviewableChangedLines * PER_LINE_TOKENS);
  const clamped = clamp(sizeScaled, ALLOTMENT_FLOOR, ALLOTMENT_CEILING);
  return Math.round(Math.min(tokenBudget, clamped));
}

/** `D` in `computeAllottedBudget`: added-plus-deleted lines, summed across reviewable items only. */
function reviewableChangedLines(inventory: Inventory): number {
  let total = 0;
  for (const item of inventory.items) {
    if (item.reviewable) total += item.changedLines;
  }
  return total;
}

function gitContext(request: ReviewRequest): GitContext {
  return {
    cwd: request.repositoryPath,
    timeoutMs: 120_000,
    pathValue: request.pathValue,
  };
}

/** Something to anchor a file-level notice to. A notice with no anchor cannot be published. */
function noticeAnchor(inventory: Inventory): string | undefined {
  const reviewable = inventory.items.find((item) => item.reviewable);
  return (reviewable ?? inventory.items[0])?.path;
}

/**
 * Confirms the pull request still points at the head this run reviewed.
 *
 * Checked immediately before publication rather than at the start: a review takes minutes, and
 * findings attached to a superseded head are worse than no findings — they describe code the author
 * has already replaced, and they block a merge on a conversation about a commit that no longer
 * exists in the branch.
 */
async function headIsCurrent(request: ReviewRequest): Promise<boolean> {
  const state = await request.client.getPullRequest(request.ref, request.pullNumber);
  return state.headSha === request.head;
}

function itemIndex(inventory: Inventory): ReadonlyMap<string, InventoryItem> {
  return new Map(inventory.items.map((item) => [item.path as string, item]));
}

/**
 * The inventory-derived counts every report-construction site below needs, computed once from the
 * same `Inventory` each of them already has in scope — never a second, independent pass over the
 * changed paths. This is what lets the run-summary comment (Keiko-for-Quality#31) report path
 * accounting without `main.ts` ever seeing the `Inventory` type itself: it reads these fields off
 * the same `ReviewReport` its action outputs already come from.
 */
function inventoryCounts(
  inventory: Inventory,
): Pick<ReviewReport, "inventorySize" | "reviewablePaths" | "excludedPaths" | "mechanicallyClean"> {
  return {
    inventorySize: inventory.items.length,
    reviewablePaths: inventory.reviewablePaths.size,
    excludedPaths: excludedPathCount(inventory),
    mechanicallyClean: mechanicallyCleanPaths(inventory).length,
  };
}

/** The one `PublishContext` shape every publish call in this file needs, built from the same two inputs. */
function publishContextFor(request: ReviewRequest, inventory: Inventory): PublishContext {
  return {
    client: request.client,
    ref: request.ref,
    pullNumber: request.pullNumber,
    headSha: request.head,
    identity: request.identity,
    items: itemIndex(inventory),
  };
}

/** What one run's review-cache lookup decided, threaded through the rest of `performReview`. */
interface MemoContext {
  readonly hits: ReadonlyMap<string, CacheEntry>;
  readonly hitPaths: ReadonlySet<string>;
  readonly eligiblePaths: ReadonlySet<string>;
  /** Set together with `engineDigest` and `pathSetDigest`; all three `undefined` when inert this run. */
  readonly ruleDigest: Sha256 | undefined;
  readonly engineDigest: Sha256 | undefined;
  /** This run's changed-path-set digest (v0.10.0, issue #50) — see `computePrPathSetDigest`. */
  readonly pathSetDigest: Sha256 | undefined;
  /** Eligible paths a stored entry answered on content alone, but whose path-set context had moved. */
  readonly contextInvalidated: number;
}

const INERT_MEMO: MemoContext = {
  hits: new Map(),
  hitPaths: new Set(),
  eligiblePaths: new Set(),
  ruleDigest: undefined,
  engineDigest: undefined,
  pathSetDigest: undefined,
  contextInvalidated: 0,
};

function cacheCounts(memo: MemoContext): { cacheHits: number; cacheMisses: number } {
  return { cacheHits: memo.hits.size, cacheMisses: memo.eligiblePaths.size - memo.hits.size };
}

/**
 * Looks up every cache-eligible path in `inventory`, after `buildInventory` and before the engine
 * runs — the same point v0.8.0's mechanically-clean computation sits.
 *
 * `request.cacheStore === undefined` short-circuits before computing either digest: no identity
 * digest, no platform digest, no diagnostic. That is what makes the feature genuinely inert rather
 * than merely unused when the consumer never configures `review_store_path`.
 */
function prepareMemoization(
  request: ReviewRequest,
  inventory: Inventory,
  diagnostics: Diagnostics,
): MemoContext {
  if (request.cacheStore === undefined) return INERT_MEMO;

  const ruleDigest = promptIdentityDigest(request.profile, request.guidelines);
  const engineDigest = currentPlatformDigest();
  const pathSetDigest = computePrPathSetDigest(inventory);
  const { hits, eligiblePaths, contextInvalidated } = lookupMemoized(
    request.cacheStore,
    inventory,
    ruleDigest,
    engineDigest,
    request.config,
    pathSetDigest,
  );
  const memo: MemoContext = {
    hits,
    hitPaths: new Set(hits.keys()),
    eligiblePaths,
    ruleDigest,
    engineDigest,
    pathSetDigest,
    contextInvalidated,
  };
  diagnostics.record("cache.hits", {
    headSha: request.head,
    counts: { hits: hits.size, misses: eligiblePaths.size - hits.size },
  });
  // Distinct from `cache.hits`' own miss count (v0.10.0, issue #50): this tells an operator how
  // many of those misses were specifically a content match the pull request's changed-file set
  // invalidated, rather than the file's own bytes never having been reviewed before.
  diagnostics.record("cache.context_invalidated", {
    headSha: request.head,
    counts: { invalidated: contextInvalidated },
  });
  return memo;
}

/**
 * Reports a run that fell short — and publishes whatever it managed to find.
 *
 * The notice is what blocks, and it still does. What changed is that the findings alongside it are
 * no longer thrown away. A partial run used to publish the blocking notice and nothing else, so a
 * pull request whose review covered 86 files out of 87 received the same message as one the
 * reviewer never looked at. That is not caution, it is discarding work: on a large change a single
 * failed file is the ordinary case, not the exception, so the reviewer went quiet exactly where it
 * had the most to say.
 *
 * Publishing them softens nothing. The outcome stays `incomplete`, the conversation stays open, and
 * the notice says in its own words that resolving it does not make the review complete.
 *
 * Every caller funnels through here before publishing anything, which is what makes the staleness
 * check below a single guard rather than four ad hoc ones. Before this guard existed, only the
 * `settlement.status === "incomplete"` caller checked it; a run that instead settled incomplete via
 * an unclassified path (found in seconds) or an engine failure (found only after the minutes-long
 * engine call `headIsCurrent`'s own doc comment describes) could still publish a notice bound to a
 * commit the pull request had already moved past — one contributor to the duplicate-notice defect in
 * Keiko-for-Quality#38, alongside the notice marker now also keying on `head` (see `publisher.ts`).
 * `publishSettledFindings`, the sibling "complete" path, applies the identical check itself
 * immediately before publishing real findings, for the same reason.
 */
async function settleIncomplete(
  request: ReviewRequest,
  inventory: Inventory,
  reason: ReasonCode,
  diagnostics: Diagnostics,
  findings: readonly EngineFinding[] = [],
  memo: MemoContext = INERT_MEMO,
): Promise<ReviewReport> {
  diagnostics.record(reason, { headSha: request.head });

  if (!(await headIsCurrent(request))) {
    diagnostics.record("publish.abandoned_stale_head", { headSha: request.head });
    return abandonedReport(inventory, memo);
  }

  const context = publishContextFor(request, inventory);
  // Findings first. If publication is interrupted, a reader is better served by findings without
  // the caveat than by a caveat with no findings — the first is incomplete information, the second
  // is none.
  const publish =
    findings.length === 0 ? undefined : await publishFindings(context, findings, diagnostics);

  const anchor = noticeAnchor(inventory);
  if (anchor !== undefined) {
    await publishIncompleteNotice(context, reason, anchor, diagnostics);
  }
  return {
    outcome: "incomplete",
    reason,
    ...inventoryCounts(inventory),
    cacheAppended: 0,
    ...cacheCounts(memo),
    ...(publish === undefined ? {} : { publish }),
  };
}

async function executeEngine(
  request: ReviewRequest,
  inventory: Inventory,
  memo: MemoContext,
  diagnostics: Diagnostics,
): Promise<Settlement> {
  const workspace = await mkdtemp(join(tmpdir(), "kfq-engine-bin-"));
  try {
    const engine = await acquireEngine(workspace, diagnostics);
    const allottedBudget = computeAllottedBudget(
      request.config.tokenBudget,
      inventory.reviewablePaths.size,
      reviewableChangedLines(inventory),
    );
    // One unioned exclude list through the one threading point v0.8.0 built — cache hits are never
    // a second, parallel exclude channel alongside the mechanically-clean one.
    const excluded = combinedExcludes(mechanicallyCleanPaths(inventory), memo.hitPaths);
    const output = await runEngine(
      {
        binaryPath: engine.binaryPath,
        repositoryPath: request.repositoryPath,
        pair: inventory.pair,
        config: request.config,
        profile: request.profile,
        guidelines: request.guidelines,
        env: request.env,
        pathValue: request.pathValue,
        allottedBudget,
        mechanicallyCleanPaths: excluded,
      },
      diagnostics,
    );
    const parsed = parseEngineResult(output.stdout);
    return settle(inventory, parsed, request.profile, request.config, memo.hitPaths);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** True when publication itself failed in a way that means the change was not fully reviewed. */
function publicationDegraded(outcome: PublishOutcome): boolean {
  return (
    outcome.rejectedSanitization > 0 ||
    outcome.rejectedPlacement > 0 ||
    outcome.readbackFailures > 0
  );
}

/**
 * Folds this run's newly-clean-or-found paths into the store to write back — never a hit's own
 * entry, which is already in the store unchanged, and never anything from an outcome other than
 * `complete`: this function is only reachable from `publishSettledFindings`, and that is the one
 * caller-enforced condition for cache admission. See `review-cache.ts`'s own doc comment for why an
 * incomplete run's findings would otherwise silently launder a transient failure into a permanent,
 * confidently-replayed answer.
 */
function finalizeCacheStore(
  request: ReviewRequest,
  inventory: Inventory,
  memo: MemoContext,
  engineFindings: readonly EngineFinding[],
): { store: CacheStore; appended: number } | undefined {
  if (request.cacheStore === undefined) return undefined;
  if (
    memo.ruleDigest === undefined ||
    memo.engineDigest === undefined ||
    memo.pathSetDigest === undefined
  ) {
    return undefined;
  }

  const newEntries = buildNewEntries({
    inventory,
    eligiblePaths: memo.eligiblePaths,
    hitPaths: memo.hitPaths,
    findings: engineFindings,
    ruleDigest: memo.ruleDigest,
    engineDigest: memo.engineDigest,
    pathSetDigest: memo.pathSetDigest,
    config: request.config,
  });
  if (newEntries.length === 0) return { store: request.cacheStore, appended: 0 };
  return {
    store: appendEntries(request.cacheStore, newEntries, RETENTION),
    appended: newEntries.length,
  };
}

async function publishSettledFindings(
  request: ReviewRequest,
  inventory: Inventory,
  settlement: Extract<Settlement, { status: "complete" }>,
  memo: MemoContext,
  startedAt: number,
  diagnostics: Diagnostics,
): Promise<ReviewReport> {
  const findings = mergeHitFindings(settlement.findings, memo.hits);
  const publish = await publishFindings(
    publishContextFor(request, inventory),
    findings,
    diagnostics,
  );

  // A finding the reviewer found but could not publish is a finding the consumer never saw. The
  // engine's own verdict was "complete", so this is the only place that fact can be recorded.
  if (publicationDegraded(publish)) {
    const report = await settleIncomplete(
      request,
      inventory,
      "publish.finding_rejected_placement",
      diagnostics,
      [],
      memo,
    );
    return { ...report, publish };
  }

  diagnostics.record("settlement.complete", {
    headSha: request.head,
    durationMs: Date.now() - startedAt,
    counts: { published: publish.published, suppressed: publish.suppressed },
  });
  const finalized = finalizeCacheStore(request, inventory, memo, settlement.findings);
  return {
    outcome: "complete",
    ...inventoryCounts(inventory),
    publish,
    cacheAppended: finalized?.appended ?? 0,
    ...cacheCounts(memo),
    ...(finalized === undefined ? {} : { updatedCacheStore: finalized.store }),
  };
}

/**
 * Runs the engine and records the settlement mode, or reports the failure.
 *
 * Returns a `ReviewReport` when the engine itself could not be run — a spawn failure, a timeout, a
 * non-zero exit. There is nothing to publish in that case: no result reached the parser, so there
 * are no findings to carry forward, only the fact that the review did not happen.
 */
/** The zero-reviewable-paths shortcut: nothing was ever eligible, so nothing was hit or missed. */
function emptyReviewReport(inventory: Inventory): ReviewReport {
  return {
    outcome: "complete",
    ...inventoryCounts(inventory),
    cacheHits: 0,
    cacheMisses: 0,
    cacheAppended: 0,
  };
}

/** A stale head never writes back to the cache — there is nothing settled to admit. */
function abandonedReport(inventory: Inventory, memo: MemoContext): ReviewReport {
  return {
    outcome: "abandoned",
    ...inventoryCounts(inventory),
    ...cacheCounts(memo),
    cacheAppended: 0,
  };
}

async function settleOrReport(
  request: ReviewRequest,
  inventory: Inventory,
  memo: MemoContext,
  diagnostics: Diagnostics,
): Promise<Settlement | ReviewReport> {
  try {
    const settlement = await executeEngine(request, inventory, memo, diagnostics);
    diagnostics.record(
      settlement.mode === "reconciled" ? "settlement.mode.reconciled" : "settlement.mode.counted",
      { headSha: request.head },
    );
    return settlement;
  } catch {
    return settleIncomplete(
      request,
      inventory,
      "settlement.incomplete.engine_error",
      diagnostics,
      [],
      memo,
    );
  }
}

export async function performReview(
  request: ReviewRequest,
  diagnostics: Diagnostics,
): Promise<ReviewReport> {
  const started = Date.now();
  diagnostics.record("run.started", { headSha: request.head });

  const ctx = gitContext(request);
  const pair = await resolveReviewPair(ctx, request.base, request.head);
  diagnostics.record("review_pair.resolved", { headSha: request.head });

  const inventory = await buildInventory(
    ctx,
    request.profile,
    pair,
    request.config.renameDetectionPercent,
    diagnostics,
  );

  // A path the consumer's profile does not describe is a gap in their coverage statement. Reviewing
  // the rest and reporting success would hide it behind an apparently clean run.
  if (inventory.unclassified.length > 0) {
    return settleIncomplete(request, inventory, "inventory.unclassified_path", diagnostics);
  }
  if (inventory.reviewablePaths.size === 0) {
    diagnostics.record("settlement.complete", {
      headSha: request.head,
      durationMs: Date.now() - started,
    });
    return emptyReviewReport(inventory);
  }

  const memo = prepareMemoization(request, inventory, diagnostics);
  const settlement = await settleOrReport(request, inventory, memo, diagnostics);
  if ("outcome" in settlement) return settlement;

  // `settleIncomplete` applies its own staleness guard (see its doc comment), so the incomplete
  // branch does not repeat one here. The complete branch below still needs its own: it publishes
  // real findings directly through `publishSettledFindings`, which never calls `settleIncomplete` on
  // its happy path.
  if (settlement.status === "incomplete") {
    return settleIncomplete(
      request,
      inventory,
      settlement.reason,
      diagnostics,
      mergeHitFindings(settlement.findings, memo.hits),
      memo,
    );
  }
  if (!(await headIsCurrent(request))) {
    diagnostics.record("publish.abandoned_stale_head", { headSha: request.head });
    return abandonedReport(inventory, memo);
  }
  return publishSettledFindings(request, inventory, settlement, memo, started, diagnostics);
}
