import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommitSha } from "./core/brands.js";
import type { CompiledProfile } from "./config/profile.js";
import type { RuntimeConfig } from "./config/runtime.js";
import type { Diagnostics } from "./diagnostics/sink.js";
import type { ReasonCode } from "./diagnostics/reason-codes.js";
import { acquireEngine } from "./engine/acquire.js";
import { parseEngineResult } from "./engine/result.js";
import { runEngine } from "./engine/run.js";
import { settle, type Settlement } from "./engine/settle.js";
import type { GitContext } from "./git/plumbing.js";
import type { InventoryItem } from "./inventory/classify.js";
import { buildInventory, resolveReviewPair, type Inventory } from "./inventory/inventory.js";
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

async function settleIncomplete(
  request: ReviewRequest,
  inventory: Inventory,
  reason: ReasonCode,
  diagnostics: Diagnostics,
): Promise<ReviewReport> {
  diagnostics.record(reason, { headSha: request.head });
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
  return { outcome: "incomplete", reason, inventorySize: inventory.items.length };
}

async function executeEngine(
  request: ReviewRequest,
  inventory: Inventory,
  diagnostics: Diagnostics,
): Promise<Settlement> {
  const workspace = await mkdtemp(join(tmpdir(), "kfq-engine-bin-"));
  try {
    const engine = await acquireEngine(workspace, diagnostics);
    const output = await runEngine(
      {
        binaryPath: engine.binaryPath,
        repositoryPath: request.repositoryPath,
        pair: inventory.pair,
        config: request.config,
        profile: request.profile,
        env: request.env,
        pathValue: request.pathValue,
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

  let settlement: Settlement;
  try {
    settlement = await executeEngine(request, inventory, diagnostics);
    diagnostics.record(
      settlement.mode === "reconciled" ? "settlement.mode.reconciled" : "settlement.mode.counted",
      { headSha: request.head },
    );
  } catch {
    return settleIncomplete(request, inventory, "settlement.incomplete.engine_error", diagnostics);
  }

  if (!(await headIsCurrent(request))) {
    diagnostics.record("publish.abandoned_stale_head", { headSha: request.head });
    return { outcome: "abandoned", inventorySize: inventory.items.length };
  }
  if (settlement.status === "incomplete") {
    return settleIncomplete(request, inventory, settlement.reason, diagnostics);
  }
  return publishSettledFindings(request, inventory, settlement, started, diagnostics);
}
