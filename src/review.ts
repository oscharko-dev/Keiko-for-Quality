import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommitSha } from "./core/brands.js";
import type { CompiledProfile } from "./config/profile.js";
import type { GuidelineIndex } from "./config/guidelines.js";
import type { RuntimeConfig } from "./config/runtime.js";
import type { Diagnostics } from "./diagnostics/sink.js";
import type { ReasonCode } from "./diagnostics/reason-codes.js";
import { acquireEngine } from "./engine/acquire.js";
import { parseEngineResult, type EngineFinding } from "./engine/result.js";
import { runEngine } from "./engine/run.js";
import { settle, type Settlement } from "./engine/settle.js";
import type { GitContext } from "./git/plumbing.js";
import type { InventoryItem } from "./inventory/classify.js";
import {
  buildInventory,
  mechanicallyCleanPaths,
  resolveReviewPair,
  type Inventory,
} from "./inventory/inventory.js";
import type { GitHubClient, RepoRef } from "./github/client.js";
import {
  publishFindings,
  publishIncompleteNotice,
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
}

export type ReviewOutcome = "complete" | "incomplete" | "abandoned";

export interface ReviewReport {
  readonly outcome: ReviewOutcome;
  readonly reason?: ReasonCode;
  readonly inventorySize: number;
  readonly publish?: PublishOutcome;
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
 */
async function settleIncomplete(
  request: ReviewRequest,
  inventory: Inventory,
  reason: ReasonCode,
  diagnostics: Diagnostics,
  findings: readonly EngineFinding[] = [],
): Promise<ReviewReport> {
  diagnostics.record(reason, { headSha: request.head });

  // Findings first. If publication is interrupted, a reader is better served by findings without
  // the caveat than by a caveat with no findings — the first is incomplete information, the second
  // is none.
  const publish =
    findings.length === 0
      ? undefined
      : await publishFindings(
          {
            client: request.client,
            ref: request.ref,
            pullNumber: request.pullNumber,
            headSha: request.head,
            identity: request.identity,
            items: itemIndex(inventory),
          },
          findings,
          diagnostics,
        );

  const anchor = noticeAnchor(inventory);
  if (anchor !== undefined) {
    await publishIncompleteNotice(
      {
        client: request.client,
        ref: request.ref,
        pullNumber: request.pullNumber,
        headSha: request.head,
        identity: request.identity,
        items: itemIndex(inventory),
      },
      reason,
      anchor,
      diagnostics,
    );
  }
  return {
    outcome: "incomplete",
    reason,
    inventorySize: inventory.items.length,
    ...(publish === undefined ? {} : { publish }),
  };
}

async function executeEngine(
  request: ReviewRequest,
  inventory: Inventory,
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
        mechanicallyCleanPaths: mechanicallyCleanPaths(inventory),
      },
      diagnostics,
    );
    const parsed = parseEngineResult(output.stdout);
    return settle(inventory, parsed, request.profile, request.config);
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

async function publishSettledFindings(
  request: ReviewRequest,
  inventory: Inventory,
  settlement: Extract<Settlement, { status: "complete" }>,
  startedAt: number,
  diagnostics: Diagnostics,
): Promise<ReviewReport> {
  const publish = await publishFindings(
    {
      client: request.client,
      ref: request.ref,
      pullNumber: request.pullNumber,
      headSha: request.head,
      identity: request.identity,
      items: itemIndex(inventory),
    },
    settlement.findings,
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
    );
    return { ...report, publish };
  }

  diagnostics.record("settlement.complete", {
    headSha: request.head,
    durationMs: Date.now() - startedAt,
    counts: { published: publish.published, suppressed: publish.suppressed },
  });
  return { outcome: "complete", inventorySize: inventory.items.length, publish };
}

/**
 * Runs the engine and records the settlement mode, or reports the failure.
 *
 * Returns a `ReviewReport` when the engine itself could not be run — a spawn failure, a timeout, a
 * non-zero exit. There is nothing to publish in that case: no result reached the parser, so there
 * are no findings to carry forward, only the fact that the review did not happen.
 */
async function settleOrReport(
  request: ReviewRequest,
  inventory: Inventory,
  diagnostics: Diagnostics,
): Promise<Settlement | ReviewReport> {
  try {
    const settlement = await executeEngine(request, inventory, diagnostics);
    diagnostics.record(
      settlement.mode === "reconciled" ? "settlement.mode.reconciled" : "settlement.mode.counted",
      { headSha: request.head },
    );
    return settlement;
  } catch {
    return settleIncomplete(request, inventory, "settlement.incomplete.engine_error", diagnostics);
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
    return { outcome: "complete", inventorySize: inventory.items.length };
  }

  const settlement = await settleOrReport(request, inventory, diagnostics);
  if ("outcome" in settlement) return settlement;

  if (!(await headIsCurrent(request))) {
    diagnostics.record("publish.abandoned_stale_head", { headSha: request.head });
    return { outcome: "abandoned", inventorySize: inventory.items.length };
  }
  if (settlement.status === "incomplete") {
    return settleIncomplete(
      request,
      inventory,
      settlement.reason,
      diagnostics,
      settlement.findings,
    );
  }
  return publishSettledFindings(request, inventory, settlement, started, diagnostics);
}
