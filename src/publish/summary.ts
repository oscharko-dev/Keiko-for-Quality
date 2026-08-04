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
import type { PublishOutcome } from "./publisher.js";

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
 * event's own timestamp, the engine/action version identifiers already available to the run, and
 * how long the run itself took (Issue #59) — `ReviewReport` describes what happened, never how
 * long it took to happen.
 */
export interface SummaryRunInput {
  readonly report: ReviewReport;
  readonly headSha: CommitSha;
  readonly eventTimestamp: string;
  readonly engineVersion: VersionTag;
  readonly actionVersion: string;
  /** Wall-clock milliseconds the caller measured around `performReview`. Visibility only (#59). */
  readonly durationMs: number;
}

/**
 * Extracts the allotted per-run budget, and this run's real token spend, from the diagnostics
 * stream.
 *
 * Reuses `engine.run.completed`'s existing `counts.budget` field rather than adding a second
 * plumbing path for a number the diagnostics sink already carries — see `engine/run.ts`. `spent`
 * reads `run.spend`'s own `counts.total` specifically. It used to scan for the last `counts.tokens`
 * value on ANY code, and that was wrong in practice, not just in principle: several unrelated
 * diagnostics carry a `tokens` count at their own scale (`classify.repaired`, `classify.audited`),
 * so whichever of those happened to fire last in the stream silently became "spend" — in the
 * ordinary case, `classify.audited`'s own bill, an order of magnitude below what the engine itself
 * spent on the review. `run.spend` (v0.12.0, recorded once by `executeEngine` in `review.ts`) exists
 * to be the one figure this function can trust: written only after both the engine's cumulative
 * tokens and the classification side-calls are known, so `total` is the review's actual cost rather
 * than a coincidence of which diagnostic happened to drain last.
 */
function extractBudget(records: readonly DiagnosticRecord[]): SummaryBudget {
  let allotted: number | undefined;
  let spent: number | undefined;
  for (const record of records) {
    if (record.code === "engine.run.completed" && record.counts?.budget !== undefined) {
      allotted = record.counts.budget;
    }
    if (record.code === "run.spend" && record.counts?.total !== undefined) {
      spent = record.counts.total;
    }
  }
  return { allotted, spent };
}

/**
 * Stands in for `report.publish` when a run never reached publication, so every count below can read
 * a plain property off a real object instead of chaining `publish?.x ?? 0` once per field — five
 * `?.`/`??` pairs inline here once pushed `buildSummaryReport` over this repository's cyclomatic
 * complexity ceiling. Every field is `0` — the same fallback each field already used individually.
 */
const EMPTY_PUBLISH_OUTCOME: PublishOutcome = {
  published: 0,
  suppressed: 0,
  suppressedIntraRun: 0,
  suppressedExactDuplicate: 0,
  suppressedSimilar: 0,
  suppressedDispositioned: 0,
  rejectedSanitization: 0,
  rejectedPlacement: 0,
  readbackFailures: 0,
};

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
  const publish = report.publish ?? EMPTY_PUBLISH_OUTCOME;
  const counts: SummaryCounts = {
    totalPaths: report.inventorySize,
    reviewablePaths: report.reviewablePaths,
    excludedPaths: report.excludedPaths,
    mechanicallyClean: report.mechanicallyClean,
    cacheHits: report.cacheHits,
    freshlyReviewed: Math.max(0, report.reviewablePaths - report.cacheHits),
    findingsPublished: publish.published,
    // Unlike the four counts below, this one stays optional on `PublishOutcome` even once `publish`
    // is known to exist — see its own doc comment in `publisher.ts` — so `EMPTY_PUBLISH_OUTCOME`'s
    // `0` alone cannot stand in for every absent case; a genuine, present-but-older `PublishOutcome`
    // still needs its own fallback here.
    suppressedIntraRun: publish.suppressedIntraRun ?? 0,
    suppressedExactDuplicate: publish.suppressedExactDuplicate,
    suppressedSimilar: publish.suppressedSimilar,
    suppressedDispositioned: publish.suppressedDispositioned,
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
    durationMs: input.durationMs,
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
