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
import { readModelToken, type RuntimeConfig } from "./config/runtime.js";
import type { Diagnostics } from "./diagnostics/sink.js";
import type { ReasonCode } from "./diagnostics/reason-codes.js";
import { acquireEngine } from "./engine/acquire.js";
import { currentPlatformDigest } from "./engine/pinned-release.js";
import {
  auditClassification,
  repairClassification,
  needsClassification,
  type ClassifyEndpoint,
} from "./engine/classify.js";
import { parseEngineResult, type EngineFinding, type EngineResult } from "./engine/result.js";
import { promptIdentityDigest } from "./engine/rule-identity.js";
import { EngineRunError, runEngine, type EngineRunOptions } from "./engine/run.js";
import { settle, verdictsSurviveIncompleteness, type Settlement } from "./engine/settle.js";
import { readTextAtCommit, type GitContext } from "./git/plumbing.js";
import { runChangePass, type ChangedFile } from "./contracts/change-pass.js";
import { compareContracts, describeMismatch } from "./contracts/shape-gate.js";
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
  executePublication,
  prefetchExistingConversations,
  planPublication,
  publishIncompleteNotice,
  type ExistingConversationsPrefetch,
  type PlannedFinding,
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

/**
 * Accumulates one run's real spend across the engine, classification repair, and the publish-time
 * classification audit (v0.12.0).
 *
 * Mutable and module-private by design: unlike everything else `performReviewInner` threads by
 * value, the three contributors here (`executeEngine`, and `auditFreshSurvivors` by way of
 * `publishAudited`) run at different, non-adjacent points in that function's control flow, and none
 * of them owns the single `run.spend` record `performReview`'s `finally` block writes once the whole
 * run — including publication — has settled. Threading a ledger by reference is what lets a spend
 * that happens *during publication* still land in the same total as the engine's own report, which a
 * value returned up through `settleIncomplete`/`publishSettledFindings`'s several call sites could
 * not do without widening every one of their return types just to carry a number nothing else needs.
 */
interface SpendLedger {
  /** Set once, by `executeEngine`, from `computeAllottedBudget`. Zero until the engine actually runs. */
  allotted: number;
  engine: number;
  classify: number;
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

/**
 * Margin over the raw estimate — covers ordinary estimate error, not the measured ~3x spend variance
 * on identical input. That tail is deliberately NOT provisioned here: the floor below, the
 * review-cache's truncation persistence (Keiko-for-Quality#75), and the bounded single resume (#57)
 * already own it, each for the failure it actually governs. Sizing this margin to the tail instead
 * would triple every ordinary run's stop-loss to cover a case those three already catch.
 */
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
 * Both size inputs price the run's DISPATCHED work, never the inventory's raw shape: a review-cache
 * hit and a mechanically-clean rename cost the engine nothing, and folding either into the estimate
 * would widen the stop-loss for work that was never going to spend a token. This function trusts
 * whatever count and line total it is handed — narrowing to dispatched work is the caller's job (see
 * `executeEngine`'s own exclude union, threaded through `dispatchedPathCount`/`reviewableChangedLines`
 * below).
 *
 * @param tokenBudget The consumer's hard ceiling for the whole review.
 * @param reviewableFileCount `N` — the number of paths the engine is actually dispatched for.
 * @param reviewableChangedLines `D` — added-plus-deleted lines across those same dispatched paths.
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

/** No path excluded — every call site that has no dispatch-time exclusions yet gets today's exact
 *  behaviour: every reviewable item counts. */
const EMPTY_EXCLUDE: ReadonlySet<string> = new Set();

/** `D` in `computeAllottedBudget`: added-plus-deleted lines, summed across reviewable items that are
 *  also DISPATCHED — `excluded` is the same exclude union `dispatchedPathCount` (below) narrows by,
 *  so a cache hit's changed lines do not inflate the estimate for a file the engine will never open. */
function reviewableChangedLines(
  inventory: Inventory,
  excluded: ReadonlySet<string> = EMPTY_EXCLUDE,
): number {
  let total = 0;
  for (const item of inventory.items) {
    if (item.reviewable && !excluded.has(item.path as string)) total += item.changedLines;
  }
  return total;
}

/**
 * `N` in `computeAllottedBudget`: reviewable paths the engine is actually dispatched for THIS run —
 * `reviewablePaths` narrowed by the same exclude union (`combinedExcludes`) threaded to the real
 * dispatch call, so a review-cache hit does not widen the allotment for work the engine will never
 * see. (A mechanically-clean rename is already absent from `reviewablePaths` itself — see
 * `isReviewable` in `inventory/classify.ts` — so excluding it again here is a no-op; it keeps this
 * function's contract "dispatched", not "reviewable minus hits specifically".)
 */
function dispatchedPathCount(inventory: Inventory, excluded: ReadonlySet<string>): number {
  let count = 0;
  for (const path of inventory.reviewablePaths) {
    if (!excluded.has(path)) count += 1;
  }
  return count;
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

/** No engine output is fresh — every `settleIncomplete` caller with nothing of its own gets this. */
const EMPTY_FRESH: ReadonlySet<EngineFinding> = new Set();

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
 * What an incomplete report carries about the cache.
 *
 * A truncated run still earned verdicts for the files it reached, and persisting exactly those —
 * nothing else — is what lets the next push spend its budget on the tail rather than paying for
 * the same files again (Keiko-for-Quality#75). `covered` is supplied only for reasons whose
 * incompleteness leaves those verdicts intact, so every other incomplete path lands here with
 * `undefined`, writes nothing, and behaves exactly as it did before.
 */
function truncatedCacheFields(
  request: ReviewRequest,
  inventory: Inventory,
  memo: MemoContext,
  findings: readonly EngineFinding[],
  covered: ReadonlySet<string> | undefined,
): { cacheAppended: number; updatedCacheStore?: CacheStore } {
  const finalized =
    covered === undefined
      ? undefined
      : finalizeCacheStore(request, inventory, memo, findings, covered);
  return {
    cacheAppended: finalized?.appended ?? 0,
    ...(finalized === undefined ? {} : { updatedCacheStore: finalized.store }),
  };
}

/**
 * `settleIncomplete`'s own publish step, split out so the function that decides what to report stays
 * within this file's size gate: fetches (or, on the fast pre-flight-abandon path, never even fetches)
 * existing conversations once, publishes any carried findings through the audit path, and publishes
 * the incomplete notice — sharing that one prefetch across both publication calls. Without sharing it
 * the notice would re-list every comment and re-walk every thread `publishAudited` fetched moments
 * earlier in this same settlement — the same data, twice, on every incomplete run.
 *
 * Findings first. If publication is interrupted, a reader is better served by findings without the
 * caveat than by a caveat with no findings — the first is incomplete information, the second is none.
 */
async function publishIncompleteSettlement(
  request: ReviewRequest,
  context: PublishContext,
  reason: ReasonCode,
  anchor: string | undefined,
  findings: readonly EngineFinding[],
  freshEngineFindings: ReadonlySet<EngineFinding>,
  ledger: SpendLedger,
  diagnostics: Diagnostics,
): Promise<AuditedPublication | undefined> {
  const prefetch =
    findings.length > 0 || anchor !== undefined
      ? await prefetchExistingConversations(context)
      : undefined;
  const published =
    findings.length === 0
      ? undefined
      : await publishAudited(
          request,
          context,
          findings,
          freshEngineFindings,
          ledger,
          diagnostics,
          prefetch,
        );
  if (anchor !== undefined) {
    await publishIncompleteNotice(context, reason, anchor, diagnostics, prefetch);
  }
  return published;
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
 *
 * @param freshEngineFindings Which of `findings` are this run's OWN fresh engine output, as opposed
 *   to a review-cache hit's replayed findings — `publishAudited`'s classification audit runs only on
 *   these. Every caller passes its own fresh set explicitly (v0.12.0) rather than this function
 *   inferring one from `findings` alone: a caller with no engine output at all (an unclassified path,
 *   an engine failure) and a caller carrying a real settlement's findings look identical once
 *   `findings` is flattened to one array, and guessing "fresh" from that array would silently
 *   re-audit a cache hit or silently skip a finding that deserved auditing.
 * @param counts Redacted, bounded context for *why* this settlement fired — e.g. the publication
 *   outcome's own rejection breakdown (Keiko-for-Quality#63) when the reason is a degraded
 *   publication. Omitted by every caller that has nothing more specific than the reason code itself.
 */
async function settleIncomplete(
  request: ReviewRequest,
  inventory: Inventory,
  reason: ReasonCode,
  ledger: SpendLedger,
  diagnostics: Diagnostics,
  findings: readonly EngineFinding[] = [],
  freshEngineFindings: ReadonlySet<EngineFinding> = EMPTY_FRESH,
  memo: MemoContext = INERT_MEMO,
  counts?: Readonly<Record<string, number>>,
  covered?: ReadonlySet<string>,
): Promise<ReviewReport> {
  diagnostics.record(reason, {
    headSha: request.head,
    ...(counts !== undefined ? { counts } : {}),
  });

  if (!(await headIsCurrent(request))) {
    diagnostics.record("publish.abandoned_stale_head", { headSha: request.head });
    return abandonedReport(inventory, memo);
  }

  const context = publishContextFor(request, inventory);
  const anchor = noticeAnchor(inventory);
  const published = await publishIncompleteSettlement(
    request,
    context,
    reason,
    anchor,
    findings,
    freshEngineFindings,
    ledger,
    diagnostics,
  );

  // What the store should remember for a finding this settlement carried — see `findingsForStorage`.
  const storedFindings =
    published === undefined ? findings : findingsForStorage(findings, published.auditedByOriginal);
  return {
    outcome: "incomplete",
    reason,
    ...inventoryCounts(inventory),
    ...truncatedCacheFields(request, inventory, memo, storedFindings, covered),
    ...cacheCounts(memo),
    ...(published === undefined ? {} : { publish: published.outcome }),
  };
}

async function executeEngine(
  request: ReviewRequest,
  inventory: Inventory,
  memo: MemoContext,
  ledger: SpendLedger,
  diagnostics: Diagnostics,
): Promise<Settlement> {
  const workspace = await mkdtemp(join(tmpdir(), "kfq-engine-bin-"));
  try {
    const engine = await acquireEngine(workspace, diagnostics);
    // One unioned exclude list through the one threading point v0.8.0 built — cache hits are never
    // a second, parallel exclude channel alongside the mechanically-clean one. Reused for the
    // allotment formula too (below), so the estimate and the real dispatch always agree on what
    // "excluded" means this run.
    const excluded = combinedExcludes(mechanicallyCleanPaths(inventory), memo.hitPaths);
    const excludedSet = new Set(excluded);
    const allottedBudget = computeAllottedBudget(
      request.config.tokenBudget,
      dispatchedPathCount(inventory, excludedSet),
      reviewableChangedLines(inventory, excludedSet),
    );
    ledger.allotted = allottedBudget;
    const { result: parsed, engineTokens } = await runEngineWithOneResume(
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
    ledger.engine += engineTokens;
    const { result: classified, classifyTokens } = await repairEngineFindings(
      parsed,
      request,
      diagnostics,
    );
    ledger.classify += classifyTokens;
    return settle(inventory, classified, request.profile, request.config, memo.hitPaths);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * The OpenAI-compatible classify endpoint shared by classification repair (below) and the
 * publish-time audit (`publishAudited`, further down) — or `undefined` when this run cannot speak
 * to one. Two reasons collapse into the same `undefined`: the anthropic protocol has no
 * classify-repair endpoint of its own (that path already parses structured output strictly inside
 * the engine), and a configured-but-unset token means a dry run. Neither caller treats the two
 * reasons differently, so extracting the check once is what keeps them from drifting apart.
 */
function classifyDeps(request: ReviewRequest): ClassifyEndpoint | undefined {
  if (request.config.protocol === "anthropic") return undefined;
  const token = readModelToken(request.config, request.env);
  if (token === undefined) return undefined;
  return { endpoint: request.config.endpoint, token, model: request.config.model };
}

/**
 * Bound on deterministic gate findings per run. The gate has no false positives by construction —
 * it only speaks about declarations it fully parsed — but a declared pair whose two sides have
 * drifted across many members would otherwise flood the pull request with one comment per member.
 * Past this bound the drift is a fact the first eight findings already establish.
 */
const MAX_GATE_FINDINGS = 8;

/**
 * The deterministic contract gate (issue #80, technique D): for every profile-declared contract
 * pair whose `paths` side changed in this pull request, read both sides at the reviewed head and
 * compare same-named flat interfaces member by member. No model, no tokens, no opinion — a firing
 * gate is a fact about two declarations the profile itself says must agree.
 *
 * Findings anchor on the CHANGED file, never the counterpart: only the changed file is guaranteed
 * to be part of the diff a review comment can attach to, and it is also where the author who broke
 * the contract is currently looking. Like the change-level pass, gate findings never enter the
 * review-cache store — they derive from two files, and a store entry must re-derive from one.
 */
async function collectGateFindings(
  request: ReviewRequest,
  inventory: Inventory,
  diagnostics: Diagnostics,
): Promise<readonly EngineFinding[]> {
  const pairs = request.profile.contractPairs ?? [];
  if (pairs.length === 0) return [];
  const ctx = gitContext(request);
  const findings: EngineFinding[] = [];
  let compared = 0;
  for (const pair of pairs) {
    for (const item of inventory.items) {
      if (!item.reviewable || !pair.matcher.matches(item.path as string)) continue;
      compared += await compareAgainstCounterparts(ctx, request.head, item, pair, findings);
    }
  }
  diagnostics.record("contracts.gate", {
    headSha: request.head,
    counts: { pairs: pairs.length, compared, findings: findings.length },
  });
  return findings;
}

/** One changed file against one pair's counterparts; returns how many comparisons actually ran. */
async function compareAgainstCounterparts(
  ctx: GitContext,
  head: CommitSha,
  item: InventoryItem,
  pair: { readonly counterparts: readonly string[] },
  findings: EngineFinding[],
): Promise<number> {
  const left = await readTextAtCommit(ctx, head, item.path as string);
  if (left === undefined) return 0;
  let compared = 0;
  for (const counterpart of pair.counterparts) {
    const right = await readTextAtCommit(ctx, head, counterpart);
    if (right === undefined) continue;
    compared += 1;
    for (const mismatch of compareContracts(left, right)) {
      if (findings.length >= MAX_GATE_FINDINGS) return compared;
      findings.push({
        path: item.path,
        content: describeMismatch(mismatch, item.path as string, counterpart),
        startLine: 0,
        endLine: 0,
        category: "bug",
        severity: "high",
      });
    }
  }
  return compared;
}

/**
 * Floor beneath which the change-level pass is skipped: one pass costs a bounded prompt plus a
 * bounded completion, and running it into an almost-exhausted allotment would convert an add-on
 * question into the reason the run overdraws the consumer's own ceiling.
 */
const CHANGE_PASS_RESERVE_TOKENS = 10_000;

/**
 * The flag-gated change-level pass (issue #80, technique C): one bounded model call over the
 * declaration summaries of every dispatched reviewable file, asking only cross-file questions no
 * per-file review can answer. Dark by default — `cross_artifact_pass` is the consumer's opt-in and
 * the corpus is the promotion gate, so this function's whole cost when the flag is off is one
 * boolean check.
 *
 * Its findings are filtered to paths this run's inventory calls reviewable: the model may name any
 * consumer file it likes, but a review comment can only anchor on the pull request's own diff, and
 * an unanchorable finding would degrade the whole publication rather than inform anyone. They are
 * also deliberately NEVER admitted to the review-cache store (the caller keeps them out of the
 * storage list): a store entry must hold only what re-derives from that one path's content, and a
 * change-level finding derives from the whole changed set.
 */
async function collectChangePassFindings(
  request: ReviewRequest,
  inventory: Inventory,
  ledger: SpendLedger,
  diagnostics: Diagnostics,
): Promise<readonly EngineFinding[]> {
  if (request.config.crossArtifactPass !== true) return [];
  const deps = classifyDeps(request);
  if (deps === undefined) return [];
  const remaining = ledger.allotted - ledger.engine - ledger.classify;
  if (remaining < CHANGE_PASS_RESERVE_TOKENS) {
    diagnostics.record("contracts.change_pass", {
      headSha: request.head,
      counts: { findings: 0, tokens: 0, skipped_budget: 1, remaining },
    });
    return [];
  }
  const ctx = gitContext(request);
  const files: ChangedFile[] = [];
  for (const item of inventory.items) {
    if (!item.reviewable) continue;
    const source = await readTextAtCommit(ctx, request.head, item.path as string);
    if (source !== undefined) files.push({ path: item.path as string, source });
  }
  const { findings, tokens } = await runChangePass(files, deps);
  ledger.classify += tokens;
  const anchorable = findings.filter((finding) =>
    inventory.reviewablePaths.has(finding.path as string),
  );
  diagnostics.record("contracts.change_pass", {
    headSha: request.head,
    counts: {
      findings: anchorable.length,
      dropped_unanchorable: findings.length - anchorable.length,
      tokens,
      skipped_budget: 0,
    },
  });
  return anchorable;
}

/**
 * Deterministic classification repair (v0.11.0) — `src/engine/classify.ts` carries the full why.
 * In one sentence: not every serving stack enforces the engine's JSON schema, and a finding
 * without `category`/`severity` cannot be triaged, so the two fields are re-asked through the
 * smallest prompt that can carry them rather than left to prompt-compliance luck.
 *
 * Runs before `settle` and before dedup, unconditionally for every fresh finding — a finding
 * without a category or severity cannot be triaged anywhere downstream, so repair is not optional
 * the way the classification AUDIT is (`publishAudited`, below): the audit only ever runs on
 * findings that survive all the way to publication, because reclassifying a finding nobody will
 * ever read is a pure loss.
 *
 * Returns the repair spend alongside the (possibly reclassified) result, so the caller can fold it
 * into this run's `SpendLedger`. Zero on every skip path below — an implausible finding count, the
 * anthropic protocol, no findings to classify, no token to call with, or nothing that actually needs
 * it — because none of them ever placed a call.
 */
async function repairEngineFindings(
  parsed: EngineResult,
  request: ReviewRequest,
  diagnostics: Diagnostics,
): Promise<{ result: EngineResult; classifyTokens: number }> {
  // `settle` (`settle.ts`'s `commonDisqualifier`) disqualifies any result over `config.maxFindings`
  // as implausible — a misconfigured model, a runaway run, or a successful prompt injection, not a
  // genuinely terrible change — and it does so unconditionally, after this function returns. That
  // verdict does not depend on classification, so classifying first only spends repair's own model
  // calls on a result `settle` was always going to throw away: a flood of a few hundred findings
  // turns a run `settle` disqualifies for free into one that burns tokens getting there first — and
  // because the flood can originate from candidate-controlled diff or comment content the model
  // reads, this is a cost-amplification vector, not just a waste. Checking the identical threshold
  // here, before the first call, is what actually avoids that spend rather than merely explaining it
  // afterward. The publish-time audit needs no analogous guard of its own: a disqualified result
  // never carries findings past `settle` (`commonDisqualifier` discards them outright), so there is
  // nothing left for the audit to see by the time it could run.
  //
  // Deliberately NOT extended to `parsed.budgetExceeded`: a budget-truncated run's findings are
  // still published and its covered files still memoized (`verdictsSurviveIncompleteness` in
  // `settle.ts`), so their classification quality matters exactly as much as an ordinary run's.
  // Only an implausible finding COUNT says "do not trust this enough to spend on it" — running out
  // of budget says nothing of the kind, and skipping on it too would ship worse-classified findings
  // to every reader of a large, merely expensive change.
  if (parsed.findings.length > request.config.maxFindings) {
    return { result: parsed, classifyTokens: 0 };
  }
  if (parsed.findings.length === 0) return { result: parsed, classifyTokens: 0 };
  const deps = classifyDeps(request);
  if (deps === undefined) return { result: parsed, classifyTokens: 0 };
  if (!parsed.findings.some(needsClassification)) return { result: parsed, classifyTokens: 0 };

  const outcome = await repairClassification(parsed.findings, deps);
  diagnostics.record("classify.repaired", {
    counts: { repaired: outcome.repaired, failed: outcome.failed, tokens: outcome.tokens },
  });
  return { result: { ...parsed, findings: outcome.findings }, classifyTokens: outcome.tokens };
}

/** The resume's seed — any value other than the primary pin does the job. */
const RESUME_SEED = 43;

/**
 * Exactly one bounded resume (#57). A run that ends without a usable success — the process threw,
 * or the result reports a non-success status — is re-invoked once, and the second outcome stands
 * whatever it is. One, not N: an unbounded retry converts a provider outage into a doubled bill,
 * and the measured failure mode this closes is a per-file subtask spiral that stops the whole
 * run after finding nothing (production Keiko#2963 paid its 44 files twice for exactly this; the
 * corpus reproduced the same signature four times before the session log named it). A second
 * failure settles incomplete precisely as it did before the resume existed.
 *
 * `engineTokens` (v0.12.0) is the cumulative spend across every attempt that actually ran, not
 * just the one whose result stands: a resumed run paid for both attempts, and `run.spend` has to
 * say so rather than under-report by the size of the discarded first one.
 */
async function runEngineWithOneResume(
  options: EngineRunOptions,
  diagnostics: Diagnostics,
): Promise<{ result: EngineResult; engineTokens: number }> {
  // The allotment is a whole-review ceiling and must hold ACROSS attempts: the resume runs on
  // what the first attempt left, floored so a near-exhausted budget still allows a minimal
  // second opinion. A thrown run reports no token total, so the full allotment stands there —
  // nothing measured says it was spent.
  let remaining = options.allottedBudget;
  // Same honesty as the allotment above: a thrown first attempt leaves no parsed result behind,
  // so it contributes nothing measured to the total rather than a guess.
  let firstAttemptTokens = 0;
  try {
    const first = await runEngine(options, diagnostics);
    const parsed = parseEngineResult(first.stdout);
    if (parsed.status === "success") return { result: parsed, engineTokens: parsed.totalTokens };
    firstAttemptTokens = parsed.totalTokens;
    remaining = Math.max(ALLOTMENT_FLOOR, options.allottedBudget - parsed.totalTokens);
    diagnostics.record("engine.resumed_once", { counts: { remaining } });
  } catch (error) {
    if (!(error instanceof EngineRunError)) throw error;
    diagnostics.record("engine.resumed_once", { counts: { remaining } });
  }
  // A different seed, deliberately: sampling is pinned for reproducibility, so a failing path
  // would replay itself byte-for-byte — measured, not hypothesized (the seeded verification
  // spiral failed 2/2 where the unseeded one failed ~1/4). Varying exactly one bit of entropy on
  // the one bounded retry is what turns it into a second opinion.
  const second = await runEngine(
    { ...options, samplingSeed: RESUME_SEED, allottedBudget: remaining },
    diagnostics,
  );
  const parsedSecond = parseEngineResult(second.stdout);
  return { result: parsedSecond, engineTokens: firstAttemptTokens + parsedSecond.totalTokens };
}

/** True when publication itself failed in a way that means the change was not fully reviewed. */
function publicationDegraded(outcome: PublishOutcome): boolean {
  return (
    outcome.rejectedSanitization > 0 ||
    outcome.rejectedPlacement > 0 ||
    outcome.readbackFailures > 0 ||
    // A finding whose publish call itself failed was contained per finding rather than allowed to
    // abort the loop (publisher.ts), but containment does not make it published: the consumer
    // never saw it, so the run cannot read as fully reviewed.
    (outcome.apiFailures ?? 0) > 0
  );
}

/**
 * The redacted breakdown behind a degraded-publication settlement (Keiko-for-Quality#63): what
 * published cleanly alongside what did not, and along which of the four failure modes. Every
 * per-finding placement rejection folded into `outcome.rejectedPlacement` already carries its own
 * finer attempt tally (`publisher.ts`'s `publish.finding_rejected_placement` record); this is the
 * run-level rollup an operator sees on the single event that decided the run as a whole.
 */
function publicationDegradedCounts(outcome: PublishOutcome): Readonly<Record<string, number>> {
  return {
    published: outcome.published,
    rejected_placement: outcome.rejectedPlacement,
    rejected_sanitization: outcome.rejectedSanitization,
    readback_failures: outcome.readbackFailures,
    api_failures: outcome.apiFailures ?? 0,
  };
}

/** Reserved budget per fresh survivor the audit MIGHT still classify, in tokens (v0.12.0). One vote
 *  is roughly 1k prompt tokens plus a bounded completion; this is not a worst-case bound on the
 *  escalated path (up to three votes), but a deliberately cheap trigger that keeps the audit's
 *  typical (one-vote, fast-path — see `classify.ts`'s `collectAuditVotes`) cost inside the
 *  consumer's own ceiling, rather than only reacting after an overdraw already happened. */
const AUDIT_RESERVE_PER_FINDING = 2_000;

/** No fresh survivor was substituted. Every skip path in `auditFreshSurvivors` returns this. */
const NO_AUDITED: ReadonlyMap<EngineFinding, EngineFinding> = new Map();

/**
 * Runs the classification self-audit (v0.12.0) on plan survivors that are fresh engine output —
 * never on a replayed review-cache hit, which was already audited on the run that first published
 * and stored it, so auditing it again on every replay would spend model calls for zero new
 * information.
 *
 * This is why the audit lives here, after `planPublication` has already decided which findings will
 * actually reach a reader, rather than inside `executeEngine` on every fresh finding before
 * settlement and before dedup: a suppressed duplicate on a repeat run used to pay 1-3 audit calls
 * for an opinion nobody would ever see. Only `fresh` — survivors that are ALSO fresh engine output —
 * can possibly benefit from it.
 */
async function auditFreshSurvivors(
  request: ReviewRequest,
  fresh: readonly PlannedFinding[],
  ledger: SpendLedger,
  diagnostics: Diagnostics,
): Promise<ReadonlyMap<EngineFinding, EngineFinding>> {
  if (fresh.length === 0) return NO_AUDITED;
  const deps = classifyDeps(request);
  if (deps === undefined) return NO_AUDITED;

  // The whole-review ceiling this run was allotted, minus whatever the engine and repair — both
  // already final by the time publication runs — already spent. The audit is an add-on opinion, not
  // a publication requirement: under a nearly spent budget the honest move is to publish with the
  // classification the engine and the repair already produced and skip the audit, not to borrow
  // against a ceiling the consumer set for the whole run.
  const remaining = ledger.allotted - ledger.engine - ledger.classify;
  if (remaining < AUDIT_RESERVE_PER_FINDING * fresh.length) {
    diagnostics.record("classify.skipped_budget", {
      headSha: request.head,
      counts: { skipped: fresh.length, remaining },
    });
    return NO_AUDITED;
  }

  const audit = await auditClassification(
    fresh.map((survivor) => survivor.finding),
    deps,
  );
  ledger.classify += audit.tokens;
  diagnostics.record("classify.audited", {
    counts: { changed: audit.changed, tokens: audit.tokens },
  });

  // `auditClassification` (`classify.ts`) returns findings in input order, so index-pairing with
  // `fresh` — built from that same call's input a line above — is sound; this is the one place that
  // ordering guarantee is load-bearing.
  const byOriginal = new Map<EngineFinding, EngineFinding>();
  fresh.forEach((survivor, index) => {
    const audited = audit.findings[index];
    if (audited !== undefined) byOriginal.set(survivor.finding, audited);
  });
  return byOriginal;
}

/** `publishAudited`'s result: the outcome `executePublication` produced, plus which fresh survivors
 *  were actually audited, so a caller can decide what the review cache should remember for each. */
interface AuditedPublication {
  readonly outcome: PublishOutcome;
  readonly auditedByOriginal: ReadonlyMap<EngineFinding, EngineFinding>;
}

/**
 * Plans, audits, and executes publication for `findings` in one pass (v0.12.0): `planPublication`
 * decides which findings survive sanitization and dedup, `auditFreshSurvivors` (above) reclassifies
 * whichever of those survivors are fresh engine output, and `executePublication` composes, places,
 * and posts the result — substituted with its audited classification wherever one exists.
 *
 * `freshEngineFindings` is reference identity against the SAME `EngineFinding` objects this run's
 * settlement produced. That is sound because `mergeHitFindings` (`cache/memoize.ts`) and
 * `planPublication`/`planOne` (`publish/publisher.ts`) never clone a finding — only ever copy the
 * array that holds it — so the objects a plan survivor carries are exactly the ones a caller-built
 * `Set` can be tested against.
 */
async function publishAudited(
  request: ReviewRequest,
  context: PublishContext,
  findings: readonly EngineFinding[],
  freshEngineFindings: ReadonlySet<EngineFinding>,
  ledger: SpendLedger,
  diagnostics: Diagnostics,
  prefetch?: ExistingConversationsPrefetch,
): Promise<AuditedPublication> {
  const plan = await planPublication(context, findings, diagnostics, prefetch);
  const fresh = plan.survivors.filter((survivor) => freshEngineFindings.has(survivor.finding));

  const auditedByOriginal = await auditFreshSurvivors(request, fresh, ledger, diagnostics);
  if (auditedByOriginal.size === 0) {
    const outcome = await executePublication(context, plan, diagnostics);
    return { outcome, auditedByOriginal };
  }

  const survivors: PlannedFinding[] = plan.survivors.map((survivor) => {
    const audited = auditedByOriginal.get(survivor.finding);
    return audited === undefined ? survivor : { ...survivor, finding: audited };
  });
  const outcome = await executePublication(context, { ...plan, survivors }, diagnostics);
  return { outcome, auditedByOriginal };
}

/**
 * The list `finalizeCacheStore` should persist for this run's fresh findings (v0.12.0): the audited
 * form for anything `publishAudited` actually ran through the audit, the original form for anything
 * it did not — suppressed during planning before ever reaching the audit, or never audited at all
 * (the anthropic protocol, no token, or the budget guard in `auditFreshSurvivors`).
 *
 * A finding the execute-time marker re-check suppresses AFTER being audited (`publisher.ts`'s
 * `executeOne`, exercised end to end through `publishAudited`) still gets its AUDITED form stored,
 * not its pre-audit one: the suppression fired because the audited category's fingerprint matched an
 * existing, already-published thread, which is only possible if that thread was created under the
 * SAME category value — the fingerprint hashes the category, so a match proves equality, not mere
 * collision. Storing the pre-audit value instead would desync a future replay from that same thread:
 * a cache hit is never re-audited (see `auditFreshSurvivors`'s own doc comment), so whatever category
 * is stored here is what every later replay's own fingerprint check uses — a replay carrying the
 * pre-audit category would stop matching the thread it is supposed to keep suppressing, and publish
 * a duplicate instead of continuing to suppress it.
 */
function findingsForStorage(
  findings: readonly EngineFinding[],
  auditedByOriginal: ReadonlyMap<EngineFinding, EngineFinding>,
): readonly EngineFinding[] {
  if (auditedByOriginal.size === 0) return findings;
  return findings.map((original) => auditedByOriginal.get(original) ?? original);
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
  restrictTo?: ReadonlySet<string>,
): { store: CacheStore; appended: number } | undefined {
  if (request.cacheStore === undefined) return undefined;
  if (
    memo.ruleDigest === undefined ||
    memo.engineDigest === undefined ||
    memo.pathSetDigest === undefined
  ) {
    return undefined;
  }

  // On a complete run every eligible path was reviewed, so the eligible set IS the reviewed set.
  // On a truncated one it is not: the engine stopped dispatching partway, and folding the paths it
  // never opened into the store would freeze them as "clean" forever — the precise laundering
  // review-cache.ts warns about, and worse than not memoizing at all. `restrictTo` is the engine's
  // own account of what it reached, so only those paths can be admitted.
  const eligible =
    restrictTo === undefined
      ? memo.eligiblePaths
      : new Set([...memo.eligiblePaths].filter((path) => restrictTo.has(path)));

  const newEntries = buildNewEntries({
    inventory,
    eligiblePaths: eligible,
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

/**
 * `publishSettledFindings`'s one recovery branch, extracted so the happy path below stays readable:
 * a degraded publish redirects into the same `settleIncomplete` path every other settlement failure
 * uses, and the returned report still carries the real `PublishOutcome` — the engine's verdict was
 * "complete", so this is the only place that a finding was found but could not be published gets
 * recorded (see `settleIncomplete`'s own doc comment for the general "every caller funnels through
 * here" contract this keeps).
 */
async function reportDegradedPublication(
  request: ReviewRequest,
  inventory: Inventory,
  memo: MemoContext,
  ledger: SpendLedger,
  publish: PublishOutcome,
  diagnostics: Diagnostics,
): Promise<ReviewReport> {
  const report = await settleIncomplete(
    request,
    inventory,
    "settlement.incomplete.publication_degraded",
    ledger,
    diagnostics,
    [],
    EMPTY_FRESH,
    memo,
    publicationDegradedCounts(publish),
  );
  return { ...report, publish };
}

async function publishSettledFindings(
  request: ReviewRequest,
  inventory: Inventory,
  settlement: Extract<Settlement, { status: "complete" }>,
  memo: MemoContext,
  ledger: SpendLedger,
  startedAt: number,
  diagnostics: Diagnostics,
): Promise<ReviewReport> {
  const gate = await collectGateFindings(request, inventory, diagnostics);
  const changePass = await collectChangePassFindings(request, inventory, ledger, diagnostics);
  const merged = [...mergeHitFindings(settlement.findings, memo.hits), ...gate, ...changePass];
  // Only THIS run's model output is eligible for the audit — the engine's own findings plus the
  // change-level pass's, never a cache hit's replayed findings, which `mergeHitFindings` appended
  // without cloning them (see `publishAudited`'s doc comment for why that makes reference identity
  // sound here). Change-pass findings are fresh model output like any other and audit the same way.
  const freshEngineFindings: ReadonlySet<EngineFinding> = new Set([
    ...settlement.findings,
    ...changePass,
  ]);
  const { outcome: publish, auditedByOriginal } = await publishAudited(
    request,
    publishContextFor(request, inventory),
    merged,
    freshEngineFindings,
    ledger,
    diagnostics,
  );

  // A finding the reviewer found but could not publish is a finding the consumer never saw. The
  // engine's own verdict was "complete", so this is the only place that fact can be recorded.
  //
  // The reason names the SETTLEMENT outcome (Keiko-for-Quality#57). It used to carry
  // `publish.finding_rejected_placement`, a publication diagnostic: accurate about where the
  // failure happened, but published in the incomplete notice, where the reader needs to know what
  // it means for their coverage rather than which internal step noticed. The diagnostic keeps its
  // name and its per-attempt breakdown; only the settlement reason moved family.
  if (publicationDegraded(publish)) {
    return reportDegradedPublication(request, inventory, memo, ledger, publish, diagnostics);
  }

  diagnostics.record("settlement.complete", {
    headSha: request.head,
    durationMs: Date.now() - startedAt,
    counts: { published: publish.published, suppressed: publish.suppressed },
  });
  const finalized = finalizeCacheStore(
    request,
    inventory,
    memo,
    findingsForStorage(settlement.findings, auditedByOriginal),
  );
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

/**
 * Checks the pull request against the head this run is reviewing, and reports the abandonment when
 * it has already moved on. `undefined` means still current — the ordinary case, and the only one
 * that lets the caller proceed.
 *
 * Shared by every direct staleness check in `performReview` (`settleIncomplete` applies its own
 * copy for the paths that run through it — see its doc comment for why). A pull request's head can
 * move at essentially any point during a review that takes minutes end to end, so this is checked
 * repeatedly and cheaply — one `getPullRequest` call each time — rather than once at the start: each
 * call only narrows its own slice of the race, and narrowing every slice is what keeps the whole
 * review from ever publishing against a commit the branch has already left behind.
 */
async function abandonIfStale(
  request: ReviewRequest,
  inventory: Inventory,
  memo: MemoContext,
  diagnostics: Diagnostics,
): Promise<ReviewReport | undefined> {
  if (await headIsCurrent(request)) return undefined;
  diagnostics.record("publish.abandoned_stale_head", { headSha: request.head });
  return abandonedReport(inventory, memo);
}

async function settleOrReport(
  request: ReviewRequest,
  inventory: Inventory,
  memo: MemoContext,
  ledger: SpendLedger,
  diagnostics: Diagnostics,
): Promise<Settlement | ReviewReport> {
  try {
    const settlement = await executeEngine(request, inventory, memo, ledger, diagnostics);
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
      ledger,
      diagnostics,
      [],
      EMPTY_FRESH,
      memo,
    );
  }
}

/**
 * The public entry point (unchanged shape): creates this run's `SpendLedger` and records the one
 * authoritative `run.spend` line once the whole run — including publication, where the
 * classification audit now spends (v0.12.0) — has settled, success or not.
 *
 * The `finally` block, not the happy path, is what makes this unconditional: `performReviewInner`
 * returns from many different points (an abandoned pre-flight, an incomplete settlement, a
 * completed publish), and every one of them must still report real spend if the engine or a classify
 * call actually ran. The `ledger.engine > 0 || ledger.classify > 0` guard is the one exception —
 * see its own comment below.
 */
export async function performReview(
  request: ReviewRequest,
  diagnostics: Diagnostics,
): Promise<ReviewReport> {
  const ledger: SpendLedger = { allotted: 0, engine: 0, classify: 0 };
  try {
    return await performReviewInner(request, diagnostics, ledger);
  } finally {
    // Only when the engine (or a classify call reached during publication) actually spent
    // something: a pre-flight abandon or an empty-inventory run never dispatched the engine at all,
    // and a zero-spend `run.spend` line would misreport a run that never tried to review anything
    // as one that reviewed it for free — indistinguishable, on the summary comment, from a run that
    // genuinely spent nothing because memoization answered every path.
    if (ledger.engine > 0 || ledger.classify > 0) {
      diagnostics.record("run.spend", {
        headSha: request.head,
        counts: {
          engine: ledger.engine,
          classify: ledger.classify,
          total: ledger.engine + ledger.classify,
        },
      });
    }
  }
}

async function performReviewInner(
  request: ReviewRequest,
  diagnostics: Diagnostics,
  ledger: SpendLedger,
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
    return settleIncomplete(request, inventory, "inventory.unclassified_path", ledger, diagnostics);
  }
  if (inventory.reviewablePaths.size === 0) {
    diagnostics.record("settlement.complete", {
      headSha: request.head,
      durationMs: Date.now() - started,
    });
    return emptyReviewReport(inventory);
  }

  const memo = prepareMemoization(request, inventory, diagnostics);

  // Cheap insurance ahead of the expensive step: the engine run below is minutes long, and the head
  // can move before that spend even starts. This does not replace the post-run check further down,
  // or `settleIncomplete`'s own copy — the head can still move DURING the engine's own run — it only
  // shrinks that race from "the whole engine run" down to the gap between here and publication.
  const preflight = await abandonIfStale(request, inventory, memo, diagnostics);
  if (preflight !== undefined) return preflight;

  const settlement = await settleOrReport(request, inventory, memo, ledger, diagnostics);
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
      ledger,
      diagnostics,
      mergeHitFindings(settlement.findings, memo.hits),
      new Set(settlement.findings),
      memo,
      undefined,
      verdictsSurviveIncompleteness(settlement.reason) ? settlement.coveredPaths : undefined,
    );
  }
  const postRun = await abandonIfStale(request, inventory, memo, diagnostics);
  if (postRun !== undefined) return postRun;
  return publishSettledFindings(request, inventory, settlement, memo, ledger, started, diagnostics);
}
