import type { CommitSha } from "../core/brands.js";
import type { Diagnostics } from "../diagnostics/sink.js";
import type { EngineFinding } from "../engine/result.js";
import type { InventoryItem } from "../inventory/classify.js";
import {
  GitHubApiError,
  type RepoRef,
  type ReviewComment,
  type ReviewCommentApi,
  type ReviewCommentInput,
} from "../github/client.js";
import { isSubstantiveDisposition } from "./disposition.js";
import { extractMarker, fingerprint, markerComment } from "./marker.js";
import { composeFindingBody, composeIncompleteNotice } from "./presentation.js";
import { describePlacement, placementLadder, tallyPlacementAttempts } from "./placement.js";
import { sanitizeFindingBody } from "./sanitize.js";
import {
  findsDispositionedConversation,
  findsSimilarOpenConversation,
  type ExistingConversation,
} from "./similarity.js";

export interface PublishContext {
  readonly client: ReviewCommentApi;
  readonly ref: RepoRef;
  readonly pullNumber: number;
  readonly headSha: CommitSha;
  /** The login this reviewer authors as, resolved at run time. */
  readonly identity: string;
  readonly items: ReadonlyMap<string, InventoryItem>;
}

export interface PublishOutcome {
  readonly published: number;
  /** Total suppressed as an already-published duplicate — the sum of the three fields below. */
  readonly suppressed: number;
  /** Suppressed by the exact-marker stage (a byte-for-byte, cosmetically-normalized repeat). */
  readonly suppressedExactDuplicate: number;
  /** Suppressed by the phrasing-independent similarity stage (Keiko-for-Quality#38). */
  readonly suppressedSimilar: number;
  /** Suppressed against a resolved thread with a substantive disposition reply (Keiko-for-Quality#64) —
   *  never against a bare resolve, which must keep a genuinely recurred defect publishable. */
  readonly suppressedDispositioned: number;
  readonly rejectedSanitization: number;
  readonly rejectedPlacement: number;
  readonly readbackFailures: number;
  /**
   * A finding whose composition→ladder→read-back tail threw an error not already covered by one of
   * the counters above — a non-422 create failure that outlasted the client's own retries, a
   * transient network fault — and was contained there rather than left to abort the rest of the run.
   * Optional so a `PublishOutcome` literal written before this field existed still satisfies the
   * interface under `exactOptionalPropertyTypes`.
   */
  readonly apiFailures?: number;
}

/**
 * Markers already present on the pull request, restricted to this reviewer's own still-open
 * comments.
 *
 * The author check is the entire security property. A marker is a public string in a public
 * comment, so anyone who can comment can reproduce one; without verifying the author, a
 * contributor — or a compromised third-party action — could pre-post a comment carrying the
 * fingerprint of a finding they expect, and permanently suppress it.
 *
 * A resolved or outdated comment is excluded: once its conversation is no longer open, the finding
 * it described must be able to recur and be republished (Keiko-for-Quality#38) — the same rule the
 * similarity stage below applies to its own candidates, kept consistent by sourcing both from the
 * same filter.
 */
function ownMarkers(comments: readonly ReviewComment[], identity: string): ReadonlySet<string> {
  const markers = new Set<string>();
  for (const comment of comments) {
    if (comment.authorLogin !== identity || comment.resolved === true) continue;
    const marker = extractMarker(comment.body);
    if (marker !== undefined) markers.add(marker);
  }
  return markers;
}

/**
 * Projects a raw review comment into the shape the similarity stage compares against.
 *
 * GitHub reports a multi-line comment's end as `line` and its start as `start_line`; a single-line
 * comment carries only `line`. Absent either, there is no usable anchor and the similarity stage's
 * own range check will correctly never match it.
 *
 * `dispositioned` (Keiko-for-Quality#64) is computed here, at the one place a raw `ReviewComment`
 * becomes the shape dedup logic reasons about — `github/client.ts` reports only the raw last-reply
 * data it fetched, deliberately with no opinion on what counts as a considered disposition.
 */
function toExistingConversation(comment: ReviewComment, identity: string): ExistingConversation {
  return {
    path: comment.path,
    authorLogin: comment.authorLogin,
    resolved: comment.resolved === true,
    dispositioned: isSubstantiveDisposition(comment.lastReply, identity),
    body: comment.body,
    startLine: comment.startLine ?? comment.line,
    endLine: comment.line,
  };
}

/** Everything a caller needs from the pull request's existing conversations before it can publish
 *  or suppress anything — see `prefetchExistingConversations`. */
export interface ExistingConversationsPrefetch {
  readonly markers: ReadonlySet<string>;
  readonly threads: readonly ExistingConversation[];
}

/**
 * Fetches and shapes everything the dedup stages need to know about conversations already on the
 * pull request: this reviewer's own open markers (`ownMarkers`) and every comment projected into
 * the shape the similarity/disposition stages compare against (`toExistingConversation`). Both come
 * from the one `listReviewComments` call — which itself folds in the GraphQL thread-resolution walk
 * — so they are fetched together rather than as two separate round trips.
 *
 * Exported so a caller that already ran this moments ago in the same settlement path can hand the
 * result to a second call instead of paying for the same list-and-walk twice — see
 * `publishIncompleteNotice`'s `prefetch` parameter, the case this exists for today.
 */
export async function prefetchExistingConversations(
  context: PublishContext,
): Promise<ExistingConversationsPrefetch> {
  const comments = await context.client.listReviewComments(context.ref, context.pullNumber);
  return {
    markers: ownMarkers(comments, context.identity),
    threads: comments.map((comment) => toExistingConversation(comment, context.identity)),
  };
}

async function publishWithLadder(
  context: PublishContext,
  ladder: readonly ReviewCommentInput[],
  body: string,
): Promise<{ comment: ReviewComment; placement: string } | undefined> {
  for (const attempt of ladder) {
    try {
      const created = await context.client.createReviewComment(context.ref, context.pullNumber, {
        ...attempt,
        body,
      });
      return { comment: created, placement: describePlacement(attempt) };
    } catch (error) {
      // 422 means this anchor is not on the diff. Any other status is a real failure and must not
      // be retried as a different placement, because it would misreport why publication failed.
      if (error instanceof GitHubApiError && error.status === 422) continue;
      throw error;
    }
  }
  return undefined;
}

/**
 * Confirms publication from the server's own view of the comment.
 *
 * A 201 says the request was accepted, not that a conversation now exists bound to the head this
 * run reviewed. Reading it back and checking the binding is what makes "published" mean the thing
 * the completeness decision assumes it means.
 */
async function verifyPublication(
  context: PublishContext,
  created: ReviewComment,
  expectedMarker: string,
): Promise<boolean> {
  const readBack = await context.client.getReviewComment(context.ref, created.id);
  return (
    readBack.id === created.id &&
    readBack.authorLogin === context.identity &&
    readBack.commitId === (context.headSha as string) &&
    extractMarker(readBack.body) === expectedMarker
  );
}

interface Counters {
  published: number;
  suppressed: number;
  suppressedExactDuplicate: number;
  suppressedSimilar: number;
  suppressedDispositioned: number;
  rejectedSanitization: number;
  rejectedPlacement: number;
  readbackFailures: number;
  apiFailures: number;
}

/**
 * Which dedup stage, if any, already covers this exact finding.
 *
 * The marker stage runs first: it is an exact, spoof-resistant match and cheaper to compute. The
 * similarity stage — phrasing-independent, Keiko-for-Quality#38 — runs next, against still-open
 * conversations only, since a genuinely recurred defect must stay publishable once a thread is
 * merely resolved with no reply. The dispositioned stage (Keiko-for-Quality#64) runs last and
 * narrows the opposite direction: it reconsiders exactly the resolved conversations the similarity
 * stage just excluded, but only those whose last reply was a substantive disposition rather than a
 * bare resolve — the case where someone actually decided the question, so a matching recurrence
 * should stop re-litigating it rather than republish.
 */
function classifySuppression(
  finding: EngineFinding,
  sanitizedBody: string,
  marker: string,
  existingMarkers: ReadonlySet<string>,
  existingThreads: readonly ExistingConversation[],
  identity: string,
): "exact" | "similar" | "dispositioned" | undefined {
  if (existingMarkers.has(marker)) return "exact";
  const candidate = {
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    body: sanitizedBody,
  };
  if (findsSimilarOpenConversation(candidate, existingThreads, identity)) return "similar";
  if (findsDispositionedConversation(candidate, existingThreads, identity)) return "dispositioned";
  return undefined;
}

/** The placement ladder, composition, publication, and read-back for a finding past both dedup stages. */
async function publishComposedFinding(
  context: PublishContext,
  finding: EngineFinding,
  marker: string,
  sanitizedBody: string,
  counters: Counters,
  diagnostics: Diagnostics,
): Promise<void> {
  const ladder = placementLadder(finding, context.items.get(finding.path), context.headSha);
  const document = composeFindingBody(sanitizedBody, markerComment(marker), {
    path: finding.path,
    line: finding.endLine > 0 ? finding.endLine : finding.startLine,
    severity: finding.severity,
    category: finding.category,
  });
  const result = await publishWithLadder(context, ladder, document);
  if (result === undefined) {
    counters.rejectedPlacement += 1;
    // Keiko-for-Quality#63: the ladder above already retried at file level before reaching here, so
    // every rung — line-anchored and file-level alike — was attempted and rejected. Recording the
    // tally is what lets an operator tell "only a line anchor was tried" apart from "the file-level
    // retry ran too, and GitHub refused that as well" instead of collapsing both into one flat code.
    diagnostics.record("publish.finding_rejected_placement", {
      headSha: context.headSha,
      counts: tallyPlacementAttempts(ladder),
    });
    return;
  }

  let verified: boolean;
  try {
    verified = await verifyPublication(context, result.comment, marker);
  } catch {
    // The POST above already succeeded — the comment may exist on GitHub even though confirming it
    // does not. That is exactly what a returned mismatch already means below, so a GET that throws
    // instead (a transient network fault, a 403 secondary rate limit that exhausted its own retries)
    // settles the same way: unconfirmed, not fatal. `publishOne`'s own wrap around this whole
    // function exists to contain the kind of error that has no more specific home than "the API
    // failed" — this one already has a home, and must not be bumped up to that coarser counter.
    verified = false;
  }
  if (!verified) {
    counters.readbackFailures += 1;
    diagnostics.record("publish.readback_failed", { headSha: context.headSha });
    return;
  }

  counters.published += 1;
  diagnostics.record("publish.finding_published", {
    headSha: context.headSha,
    counts: { [result.placement]: 1 },
  });
}

async function publishOne(
  context: PublishContext,
  finding: EngineFinding,
  existing: ReadonlySet<string>,
  existingThreads: readonly ExistingConversation[],
  counters: Counters,
  diagnostics: Diagnostics,
): Promise<void> {
  const sanitized = sanitizeFindingBody(finding.content);
  if (!sanitized.ok) {
    counters.rejectedSanitization += 1;
    diagnostics.record("publish.finding_rejected_sanitization", { headSha: context.headSha });
    return;
  }

  const marker = fingerprint({
    repository: `${context.ref.owner}/${context.ref.repo}`,
    pullNumber: context.pullNumber,
    path: finding.path,
    rule: finding.category ?? "general",
    body: sanitized.body,
  });

  const suppression = classifySuppression(
    finding,
    sanitized.body,
    marker,
    existing,
    existingThreads,
    context.identity,
  );
  if (suppression !== undefined) {
    counters.suppressed += 1;
    if (suppression === "exact") counters.suppressedExactDuplicate += 1;
    else if (suppression === "similar") counters.suppressedSimilar += 1;
    else counters.suppressedDispositioned += 1;
    const code =
      suppression === "exact"
        ? "publish.finding_suppressed_duplicate"
        : suppression === "similar"
          ? "publish.finding_suppressed_similar"
          : "dedup.dispositioned";
    diagnostics.record(code, { headSha: context.headSha });
    return;
  }

  try {
    await publishComposedFinding(context, finding, marker, sanitized.body, counters, diagnostics);
  } catch {
    // A non-422 failure anywhere left in this tail — composition cannot throw, but the ladder's own
    // CREATE call can (a 403 secondary rate limit that outlasted the client's own retries, a
    // transient fault) — must not propagate. `publishFindings` calls this once per finding in a
    // loop; letting one finding's API trouble escape as a rejected promise would abandon every
    // finding still waiting behind it, and the whole run with them, over a cause that has nothing to
    // do with those findings' own content. Contained here, the loop moves on and the operator still
    // sees the failure as a count instead of losing the rest of the run to it.
    counters.apiFailures += 1;
    diagnostics.record("publish.api_failed", { headSha: context.headSha });
  }
}

export async function publishFindings(
  context: PublishContext,
  findings: readonly EngineFinding[],
  diagnostics: Diagnostics,
  prefetch?: ExistingConversationsPrefetch,
): Promise<PublishOutcome> {
  // Optional for the same reason `publishIncompleteNotice` accepts one: `settleIncomplete` calls
  // both functions back to back, and without a shared prefetch the second call re-lists every
  // comment and re-walks every thread the first one fetched moments earlier.
  const { markers: existing, threads: existingThreads } =
    prefetch ?? (await prefetchExistingConversations(context));
  const counters: Counters = {
    published: 0,
    suppressed: 0,
    suppressedExactDuplicate: 0,
    suppressedSimilar: 0,
    suppressedDispositioned: 0,
    rejectedSanitization: 0,
    rejectedPlacement: 0,
    readbackFailures: 0,
    apiFailures: 0,
  };
  for (const finding of findings) {
    await publishOne(context, finding, existing, existingThreads, counters, diagnostics);
  }
  return { ...counters };
}

/**
 * Publishes the one conversation that says "this review did not cover your change".
 *
 * It carries a reason code and nothing else. An incomplete review is exactly the situation in which
 * a detailed explanation would be most tempting and most dangerous: the failure may have been
 * caused by the candidate, and the diagnostic would be the leak.
 */
export async function publishIncompleteNotice(
  context: PublishContext,
  reasonCode: string,
  anchorPath: string,
  diagnostics: Diagnostics,
  // A caller that already ran `prefetchExistingConversations` moments ago in the same settlement
  // path (`publishFindings`, immediately before this, is the case that motivated it) can hand the
  // result here instead of paying for the same list-and-walk twice. Absent, this fetches its own —
  // every caller that passes nothing keeps behaving exactly as it did before this parameter existed.
  prefetch?: ExistingConversationsPrefetch,
): Promise<boolean> {
  const marker = fingerprint({
    repository: `${context.ref.owner}/${context.ref.repo}`,
    pullNumber: context.pullNumber,
    path: anchorPath,
    rule: "incomplete-review",
    body: reasonCode,
    // Unlike a finding, a notice's meaning is head-specific: "this exact commit was not covered".
    // Excluding it would let a notice about a since-superseded head suppress the one a fresh run for
    // the current head still needs to publish.
    head: context.headSha,
  });
  const { markers: existing } = prefetch ?? (await prefetchExistingConversations(context));
  if (existing.has(marker)) return true;

  try {
    const created = await context.client.createReviewComment(context.ref, context.pullNumber, {
      body: composeIncompleteNotice(reasonCode, markerComment(marker)),
      commitId: context.headSha,
      path: anchorPath,
    });
    const verified = await verifyPublication(context, created, marker);
    diagnostics.record("publish.incomplete_notice_published", { headSha: context.headSha });
    return verified;
  } catch {
    diagnostics.record("publish.api_failed", { headSha: context.headSha });
    return false;
  }
}
