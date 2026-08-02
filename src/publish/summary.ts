import type { CommitSha, VersionTag } from "../core/brands.js";
import type { Diagnostics, DiagnosticRecord } from "../diagnostics/sink.js";
import type { IssueComment, IssueCommentApi, RepoRef } from "../github/client.js";
import type { ReviewReport } from "../review.js";
import { extractMarker, markerComment, summaryMarker } from "./marker.js";
import {
  composeSummaryBody,
  type SummaryBudget,
  type SummaryCounts,
  type SummaryReport,
} from "./presentation.js";

/**
 * Maintains the single, marker-identified run-summary comment a pull request carries in addition to
 * its finding conversations (Keiko-for-Quality#31).
 *
 * This module owns exactly the upsert orchestration — finding this reviewer's own prior summary by
 * marker, updating it in place, or creating one when none exists — the same split `publisher.ts`
 * already draws between orchestration and `presentation.ts`'s pure composition. It is a reporting
 * layer, never a completeness signal: nothing here may gate or alter the settlement outcome the rest
 * of a run already reached, the same posture `cache/review-cache.ts` documents for memoization.
 */

export interface SummaryPublishContext {
  readonly client: IssueCommentApi;
  readonly ref: RepoRef;
  readonly pullNumber: number;
  /** The login this reviewer authors as — the same identity findings publish under. */
  readonly identity: string;
}

/**
 * Context this run's `ReviewReport` alone cannot supply: the head this run reviewed (an issue
 * comment carries no `commit_id`, so nothing else binds the comment to a commit), the triggering
 * event's own timestamp, and the engine/action version identifiers already available to the run.
 */
export interface SummaryRunInput {
  readonly report: ReviewReport;
  readonly headSha: CommitSha;
  readonly eventTimestamp: string;
  readonly engineVersion: VersionTag;
  readonly actionVersion: string;
}

/**
 * Extracts the allotted per-run budget, and the engine-reported spend when the adapter exposes it,
 * from this run's own diagnostics stream.
 *
 * Reuses `engine.run.completed`'s existing `counts.budget` field rather than adding a second
 * plumbing path for a number the diagnostics sink already carries — see `engine/run.ts`. A
 * `counts.tokens` value is recorded on exactly one code today, `settlement.incomplete.budget_exceeded`
 * (`engine/settle.ts`); scanning for the field rather than the specific code means this keeps working
 * unchanged if a future code ever reports spend on a path that is not budget-exceeded.
 */
function extractBudget(records: readonly DiagnosticRecord[]): SummaryBudget {
  let allotted: number | undefined;
  let spent: number | undefined;
  for (const record of records) {
    if (record.code === "engine.run.completed" && record.counts?.budget !== undefined) {
      allotted = record.counts.budget;
    }
    if (record.counts?.tokens !== undefined) spent = record.counts.tokens;
  }
  return { allotted, spent };
}

/**
 * Projects the same `ReviewReport` the action's own outputs are built from into `SummaryReport`.
 *
 * Every count is read directly off `report` — extended for this feature with the inventory
 * accounting `performReview` already computes — or off `report.publish`, never recomputed from a
 * second, independent pass over the inventory or the GitHub API. `freshlyReviewed` is the one
 * arithmetic step, and it is a trivial partition of two fields the report already carries:
 * `reviewablePaths - cacheHits`.
 */
export function buildSummaryReport(
  input: SummaryRunInput,
  diagnostics: readonly DiagnosticRecord[],
): SummaryReport {
  const { report } = input;
  const publish = report.publish;
  const counts: SummaryCounts = {
    totalPaths: report.inventorySize,
    reviewablePaths: report.reviewablePaths,
    excludedPaths: report.excludedPaths,
    mechanicallyClean: report.mechanicallyClean,
    cacheHits: report.cacheHits,
    freshlyReviewed: Math.max(0, report.reviewablePaths - report.cacheHits),
    findingsPublished: publish?.published ?? 0,
    suppressedExactDuplicate: publish?.suppressedExactDuplicate ?? 0,
    suppressedSimilar: publish?.suppressedSimilar ?? 0,
  };
  return {
    outcome: report.outcome,
    reason: report.outcome === "incomplete" ? report.reason : undefined,
    headSha: input.headSha,
    eventTimestamp: input.eventTimestamp,
    engineVersion: input.engineVersion,
    actionVersion: input.actionVersion,
    counts,
    budget: extractBudget(diagnostics),
  };
}

/**
 * Among several own-authored marker matches — pathological; correct operation never produces more
 * than one — keeps the most recently created and leaves the rest exactly as they are.
 *
 * GitHub assigns issue-comment ids in increasing order at creation time, so the highest id is
 * unambiguously the newest regardless of listing order or how many pages were walked to find it.
 * This function never deletes or edits a comment it does not choose as the target: archiving or
 * removing an older stray is explicitly out of scope for Keiko-for-Quality#31.
 */
function newestOwnSummary(comments: readonly IssueComment[]): IssueComment | undefined {
  return comments.reduce<IssueComment | undefined>(
    (newest, comment) => (newest === undefined || comment.id > newest.id ? comment : newest),
    undefined,
  );
}

/** This reviewer's own comments already carrying the one fixed summary marker for this pull request. */
function ownSummaryComments(
  comments: readonly IssueComment[],
  identity: string,
  marker: string,
): IssueComment[] {
  return comments.filter(
    (comment) => comment.authorLogin === identity && extractMarker(comment.body) === marker,
  );
}

/**
 * Finds this reviewer's own prior run-summary comment, if any, and updates it in place; otherwise
 * creates one. Never both, never more than one summary comment surviving across repeated runs of the
 * same pull request. A comment carrying the marker but authored by anyone else is not a match — the
 * same authorship rule the marker and similarity dedup stages enforce for findings — so it is
 * ignored and a fresh comment is created alongside it.
 *
 * Every failure here — a listing error, a create or update error — is caught and recorded as a
 * diagnostic rather than rethrown. The run summary is a pure add-on reporting layer, the same
 * posture `cache/review-cache.ts` documents for memoization: nothing about it may fail the run or
 * change the settlement outcome the rest of this run already reached.
 *
 * Returns the published comment's URL on success, so the caller can surface it as an action output;
 * `undefined` when the upsert failed.
 */
export async function maintainRunSummary(
  context: SummaryPublishContext,
  input: SummaryRunInput,
  diagnostics: Diagnostics,
): Promise<string | undefined> {
  try {
    const summary = buildSummaryReport(input, diagnostics.drain());
    const marker = summaryMarker(`${context.ref.owner}/${context.ref.repo}`, context.pullNumber);
    const body = composeSummaryBody(summary, markerComment(marker));

    const existing = await context.client.listIssueComments(context.ref, context.pullNumber);
    const target = newestOwnSummary(ownSummaryComments(existing, context.identity, marker));

    if (target === undefined) {
      const created = await context.client.createIssueComment(
        context.ref,
        context.pullNumber,
        body,
      );
      diagnostics.record("publish.summary_published");
      return created.url;
    }

    const updated = await context.client.updateIssueComment(context.ref, target.id, body);
    diagnostics.record("publish.summary_updated");
    return updated.url;
  } catch {
    diagnostics.record("publish.summary_upsert_failed");
    return undefined;
  }
}
