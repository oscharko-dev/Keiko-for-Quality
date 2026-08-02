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
import { extractMarker, fingerprint, markerComment } from "./marker.js";
import { composeFindingBody, composeIncompleteNotice } from "./presentation.js";
import { describePlacement, placementLadder, tallyPlacementAttempts } from "./placement.js";
import { sanitizeFindingBody } from "./sanitize.js";
import { findsSimilarOpenConversation, type ExistingConversation } from "./similarity.js";

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
  /** Total suppressed as an already-published duplicate — the sum of the two fields below. */
  readonly suppressed: number;
  /** Suppressed by the exact-marker stage (a byte-for-byte, cosmetically-normalized repeat). */
  readonly suppressedExactDuplicate: number;
  /** Suppressed by the phrasing-independent similarity stage (Keiko-for-Quality#38). */
  readonly suppressedSimilar: number;
  readonly rejectedSanitization: number;
  readonly rejectedPlacement: number;
  readonly readbackFailures: number;
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
 */
function toExistingConversation(comment: ReviewComment): ExistingConversation {
  return {
    path: comment.path,
    authorLogin: comment.authorLogin,
    resolved: comment.resolved === true,
    body: comment.body,
    startLine: comment.startLine ?? comment.line,
    endLine: comment.line,
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
  rejectedSanitization: number;
  rejectedPlacement: number;
  readbackFailures: number;
}

/**
 * Which of the two dedup stages, if either, already covers this exact finding.
 *
 * The marker stage runs first: it is an exact, spoof-resistant match and cheaper to compute. The
 * similarity stage — phrasing-independent, Keiko-for-Quality#38 — runs only when the marker missed,
 * since a marker hit already proves the same finding exists and there is nothing left to gain by
 * also asking whether it merely *resembles* one.
 */
function classifySuppression(
  finding: EngineFinding,
  sanitizedBody: string,
  marker: string,
  existingMarkers: ReadonlySet<string>,
  existingThreads: readonly ExistingConversation[],
  identity: string,
): "exact" | "similar" | undefined {
  if (existingMarkers.has(marker)) return "exact";
  const candidate = {
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    body: sanitizedBody,
  };
  return findsSimilarOpenConversation(candidate, existingThreads, identity) ? "similar" : undefined;
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

  if (!(await verifyPublication(context, result.comment, marker))) {
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
    else counters.suppressedSimilar += 1;
    const code =
      suppression === "exact"
        ? "publish.finding_suppressed_duplicate"
        : "publish.finding_suppressed_similar";
    diagnostics.record(code, { headSha: context.headSha });
    return;
  }

  await publishComposedFinding(context, finding, marker, sanitized.body, counters, diagnostics);
}

export async function publishFindings(
  context: PublishContext,
  findings: readonly EngineFinding[],
  diagnostics: Diagnostics,
): Promise<PublishOutcome> {
  const comments = await context.client.listReviewComments(context.ref, context.pullNumber);
  const existing = ownMarkers(comments, context.identity);
  const existingThreads = comments.map(toExistingConversation);
  const counters: Counters = {
    published: 0,
    suppressed: 0,
    suppressedExactDuplicate: 0,
    suppressedSimilar: 0,
    rejectedSanitization: 0,
    rejectedPlacement: 0,
    readbackFailures: 0,
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
  const comments = await context.client.listReviewComments(context.ref, context.pullNumber);
  if (ownMarkers(comments, context.identity).has(marker)) return true;

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
