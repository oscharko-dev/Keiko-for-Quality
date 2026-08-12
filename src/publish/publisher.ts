import type { CommitSha } from "../core/brands.js";
import type { ReasonCode } from "../diagnostics/reason-codes.js";
import type { Diagnostics } from "../diagnostics/sink.js";
import { FINDING_SEVERITIES } from "../engine/classify.js";
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
  areIntraRunDuplicates,
  findsDispositionedConversation,
  findsOutdatedRecurrence,
  findsSimilarOpenConversation,
  type CandidateForDedup,
  type ExistingConversation,
} from "./similarity.js";

export interface PublishContext {
  /**
   * Absent for a publication-free local run (`performLocalReview`, `review.ts`, issue #95): it
   * plans and audits findings the same way the action does, but never posts anything, so it never
   * needs a real GitHub client. Every function below that actually calls GitHub still requires one
   * — see `requireClient` — this field is optional only so a client-less context stays type-safe
   * without a stub `ReviewCommentApi` standing in for a client that genuinely is not there.
   */
  readonly client?: ReviewCommentApi;
  readonly ref: RepoRef;
  readonly pullNumber: number;
  /** The merge base that defines the reviewed change and the verifier's before-change evidence. */
  readonly baseSha: CommitSha;
  readonly headSha: CommitSha;
  /** The login this reviewer authors as, resolved at run time. */
  readonly identity: string;
  readonly items: ReadonlyMap<string, InventoryItem>;
}

/**
 * Unwraps `context.client`, failing closed if it is absent.
 *
 * Every caller of this function is reachable only from a real pull request's publish step —
 * `executePublication`, `publishIncompleteNotice`, and `planPublication`'s own default-fetch
 * fallback when no `prefetch` was supplied — and the action path always reaches every one of them
 * with a real `GitHubClient` behind `context.client`. A publication-free local run never reaches any
 * of them: it always supplies its own `prefetch` to `planPublication` and never calls the other two,
 * so this throw is unreachable in practice today. It exists so the four call sites below stay
 * type-safe against the now-optional `client` field without weakening them to a silent `undefined`
 * dereference, and without a stub implementation pretending to be a client that is not there.
 */
function requireClient(context: PublishContext): ReviewCommentApi {
  if (context.client === undefined) {
    throw new Error("PublishContext.client is required for this operation");
  }
  return context.client;
}

export interface PublishOutcome {
  readonly published: number;
  /** Total suppressed — the sum of the five fields below: an intra-run duplicate, plus the four
   *  ways a candidate can duplicate an already-published conversation. */
  readonly suppressed: number;
  /**
   * Suppressed as a near-duplicate of another finding in the SAME run (v0.12.0) — the model
   * described one defect twice in one pass, at the same location, in this run's OWN candidates,
   * which none of the three fields below can see: they only ever compare a candidate against an
   * ALREADY-PUBLISHED conversation. See `similarity.ts`'s `areIntraRunDuplicates`. Optional for the
   * same reason `apiFailures` below is: a `PublishOutcome` literal written before this field existed
   * still satisfies the interface under `exactOptionalPropertyTypes`.
   */
  readonly suppressedIntraRun?: number;
  /** Suppressed by the exact-marker stage (a byte-for-byte, cosmetically-normalized repeat). */
  readonly suppressedExactDuplicate: number;
  /** Suppressed by the phrasing-independent similarity stage (Keiko-for-Quality#38). */
  readonly suppressedSimilar: number;
  /** Suppressed against a resolved thread with a substantive disposition reply (Keiko-for-Quality#64) —
   *  never against a bare resolve, which must keep a genuinely recurred defect publishable. */
  readonly suppressedDispositioned: number;
  /** Withheld by the independent evidence/consequence gate after generation. */
  readonly suppressedEvidence?: number;
  /** Verified fresh findings outside the PR-wide publication set. */
  readonly suppressedRanked?: number;
  /**
   * Fresh candidates withheld because evidence or the independent judge was unavailable. Unlike a
   * content rejection, any non-zero value degrades settlement so an outage cannot look clean.
   */
  readonly verificationUndecided?: number;
  /**
   * Suppressed as a restatement of a still-open conversation the anchored stages cannot reach:
   * one a push marked OUTDATED (its line anchor is stale), or — since 2026-08-06 — one that never
   * had a line anchor at all (a FILE-level comment; GitHub reports no `line`/`start_line` and no
   * `original_*` fallback for it, and it can never become outdated because there is no hunk to go
   * stale). See `similarity.ts`'s `findsOutdatedRecurrence`. Optional for the same
   * `exactOptionalPropertyTypes` reason as `suppressedIntraRun`.
   */
  readonly suppressedRecurrence?: number;
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
 * Markers already present on the pull request, restricted to this reviewer's own comments whose
 * thread is not GENUINELY RESOLVED.
 *
 * The author check is the entire security property. A marker is a public string in a public
 * comment, so anyone who can comment can reproduce one; without verifying the author, a
 * contributor — or a compromised third-party action — could pre-post a comment carrying the
 * fingerprint of a finding they expect, and permanently suppress it.
 *
 * Only `comment.resolved === true` excludes a marker — an outdated-but-unresolved thread's marker
 * stays active, and that is deliberate, not a gap left over from before `github/client.ts` reported
 * `resolved` and `outdated` as separate facts. A marker fingerprints CONTENT (repository, pull
 * request, path, category, finding body), never a coordinate, so a push that moves the hunk a
 * thread anchors changes nothing the marker depends on: "the hunk is now outdated" says nothing
 * about whether the finding it described was ever answered. Suppressing the repost in that case is
 * exactly this stage's job — THIS IS THE ONE BEHAVIOUR CHANGE from before the split, and it is what
 * stops every push that merely touches a file from republishing every still-open finding in it as a
 * brand-new conversation (measured as the dominant source of this reviewer's duplicate findings). A
 * GENUINELY resolved thread (`resolved === true`, regardless of `outdated`) is still excluded, so
 * the finding it described can recur and be republished (Keiko-for-Quality#38) — that half of the
 * rule is unchanged, and "resolved" wins over "outdated" when a thread is somehow both.
 *
 * The similarity stage below reads `outdated` differently, for an independently-justified reason —
 * see `toExistingConversation`. The two stages are deliberately no longer sourced from one shared
 * filter, and must not be made to agree again by accident.
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
 * own range check will correctly never match it — since 2026-08-06 such a thread is instead
 * admitted by the anchor-less clauses in `findsOutdatedRecurrence` (open threads) and
 * `findsDispositionedConversation` (substantively answered ones), on the same path at the raised
 * coordinate-free bar, because a FILE-level comment can never become outdated and would otherwise
 * be invisible to every phrasing-independent stage.
 *
 * `ExistingConversation.resolved` deliberately folds `github/client.ts`'s two independent facts,
 * `resolved` and `outdated`, back into one — and only here. The similarity stage's own eligibility
 * has stayed "open AND NOT outdated" since Keiko-for-Quality#38: an outdated thread's line anchor is
 * a stale coordinate (GitHub nulls `line`/`start_line` once a push moves the hunk, and this client
 * falls back to `original_line`/`original_start_line` — see `client.ts`'s `toReviewComment`), and a
 * same-location match against a stale coordinate would be noise, not signal. That is a PRECISION
 * CHOICE for a stage whose whole job is judging line-overlap-plus-similarity, not an oversight that
 * failed to notice the two facts split apart — the exact-marker stage (`ownMarkers`, above) reads
 * the same underlying facts differently, on purpose, because its own eligibility does not depend on
 * a coordinate at all. The two stages disagreeing about `outdated` is intentional and must not be
 * "fixed" into agreement.
 *
 * `dispositioned` (Keiko-for-Quality#64) is computed here, at the one place a raw `ReviewComment`
 * becomes the shape dedup logic reasons about — `github/client.ts` reports only the raw last-reply
 * data it fetched, deliberately with no opinion on what counts as a considered disposition. It is
 * unaffected by the fold above: `comment.lastReply` is populated only for a genuinely resolved
 * thread, never an outdated-only one, so folding `outdated` into `resolved` here can never
 * manufacture a disposition that did not happen.
 */
function toExistingConversation(comment: ReviewComment, identity: string): ExistingConversation {
  return {
    path: comment.path,
    authorLogin: comment.authorLogin,
    resolved: comment.resolved === true || comment.outdated === true,
    // The fold above is kept, and this is the fact it destroys, carried alongside rather than
    // recovered from it: a thread a push moved but nobody answered. `findsOutdatedRecurrence` is
    // its only reader — see that function for why an outdated-only thread must suppress a repeat
    // while a genuinely resolved one still must not.
    outdatedOnly: comment.outdated === true && comment.resolved !== true,
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
  const comments = await requireClient(context).listReviewComments(context.ref, context.pullNumber);
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
      const created = await requireClient(context).createReviewComment(
        context.ref,
        context.pullNumber,
        {
          ...attempt,
          body,
        },
      );
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
  const readBack = await requireClient(context).getReviewComment(context.ref, created.id);
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
  suppressedIntraRun: number;
  suppressedExactDuplicate: number;
  suppressedSimilar: number;
  suppressedDispositioned: number;
  suppressedRecurrence: number;
  rejectedSanitization: number;
  neutralized: number;
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
 *
 * The recurrence stage runs last, and covers the still-open threads no location-matching stage
 * can see: the ones a push marked outdated, whose stale line anchors are untrustworthy, and —
 * since 2026-08-06 — the ones that never had an anchor at all, findings published as FILE-level
 * comments, which GitHub reports with no `line`/`start_line` and no `original_*` fallback and can
 * never mark outdated. It is ordered last because it decides without a location at all, so
 * anything an anchored stage can settle should be settled there first. (The dispositioned stage
 * carries its own anchor-less clause for its resolved-and-answered threads, at the same raised
 * coordinate-free bar — see `findsDispositionedConversation`.)
 */
function classifySuppression(
  finding: EngineFinding,
  sanitizedBody: string,
  marker: string,
  existingMarkers: ReadonlySet<string>,
  existingThreads: readonly ExistingConversation[],
  identity: string,
): "exact" | "similar" | "dispositioned" | "recurrence" | undefined {
  if (existingMarkers.has(marker)) return "exact";
  const candidate = {
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    body: sanitizedBody,
  };
  if (findsSimilarOpenConversation(candidate, existingThreads, identity)) return "similar";
  if (findsDispositionedConversation(candidate, existingThreads, identity)) return "dispositioned";
  if (findsOutdatedRecurrence(candidate, existingThreads, identity)) return "recurrence";
  return undefined;
}

/**
 * The reason code each cross-run suppression stage reports under.
 *
 * `dedup.dispositioned` deliberately breaks the `publish.finding_suppressed_*` naming its two
 * siblings share — see the code's own comment in `reason-codes.ts`: it answers "did someone already
 * settle this" rather than "is this the same finding", a different question that earns its own
 * top-level prefix.
 *
 * A `switch` over `classifySuppression`'s own closed union, not a chain of conditionals: every stage
 * now names its code explicitly, and a fourth stage added to that union is a compile error here —
 * where the nested ternary this replaces would have quietly reported it as `dedup.dispositioned`,
 * which was merely the last branch's fallthrough rather than a decision about it.
 */
function suppressionCode(
  suppression: "exact" | "similar" | "dispositioned" | "recurrence",
): ReasonCode {
  switch (suppression) {
    case "exact":
      return "publish.finding_suppressed_duplicate";
    case "similar":
      return "publish.finding_suppressed_similar";
    case "dispositioned":
      return "dedup.dispositioned";
    case "recurrence":
      return "publish.finding_suppressed_outdated_recurrence";
  }
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
    // settles the same way: unconfirmed, not fatal. `executeOne`'s own wrap around this whole
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

/**
 * The exact-marker fingerprint for one finding, keyed on its CURRENT category.
 *
 * Recomputed at both plan and execute time rather than computed once in `planCrossRun` and carried on
 * `PlannedFinding` — `executeOne`'s re-check depends on seeing the category as it stands when
 * execution runs, not as it stood when the finding was planned. A category change between the two
 * (the classification audit a follow-up change adds between `planPublication` and
 * `executePublication`) must change this fingerprint, not silently reuse a stale one.
 */
function findingMarker(
  context: PublishContext,
  finding: EngineFinding,
  sanitizedBody: string,
): string {
  return fingerprint({
    repository: `${context.ref.owner}/${context.ref.repo}`,
    pullNumber: context.pullNumber,
    path: finding.path,
    rule: finding.category ?? "general",
    body: sanitizedBody,
  });
}

/**
 * A finding that survived sanitization and every dedup stage during planning.
 *
 * Carries forward the one derived value composition needs later — the sanitized body
 * `sanitizeFindingBody` accepted — rather than the raw `finding.content`, so execution never
 * re-derives (or could disagree with) what planning already decided was publishable.
 */
export interface PlannedFinding {
  readonly finding: EngineFinding;
  readonly sanitizedBody: string;
}

/**
 * The suppression and rejection tallies `planPublication` alone produces — everything decided
 * before a single placement is attempted or a single API call is made.
 *
 * Deliberately narrower than `PublishOutcome`: `published`, `rejectedPlacement`, `readbackFailures`,
 * and `apiFailures` are all facts about what happened to a survivor during execution, which the plan
 * phase never touches. (The execute phase's own exact-marker re-check can also add to `suppressed`/
 * `suppressedExactDuplicate` — see `executeOne` — which is why this type is not simply reused
 * unchanged as `PublishOutcome`'s value for those two fields.)
 */
export interface PlanCounters {
  readonly suppressed: number;
  /** See `PublishOutcome.suppressedIntraRun` — optional for the identical reason. */
  readonly suppressedIntraRun?: number;
  readonly suppressedExactDuplicate: number;
  readonly suppressedSimilar: number;
  readonly suppressedDispositioned: number;
  /** See `PublishOutcome.suppressedEvidence`. */
  readonly suppressedEvidence?: number;
  /** See `PublishOutcome.suppressedRanked`. */
  readonly suppressedRanked?: number;
  /** See `PublishOutcome.verificationUndecided`. */
  readonly verificationUndecided?: number;
  /** See `PublishOutcome.suppressedRecurrence` — optional for the identical reason. */
  readonly suppressedRecurrence?: number;
  readonly rejectedSanitization: number;
  /** Markup rewrites the sanitizer applied instead of rejecting the body. Optional for the same
   *  backward-compatibility reason as the fields above. */
  readonly neutralized?: number;
}

/** The output of the plan phase: which findings will publish, what the pull request already carries
 *  (so execution can re-check against it), and the tallies for everything that will not publish. */
export interface PublicationPlan {
  readonly survivors: readonly PlannedFinding[];
  /** Raw candidates the publication sanitizer refused. They stay internal and are never composed,
   *  fingerprinted, or posted. `review.ts` carries them only through bounded truth/ranking so a
   *  malformed low-ranked hypothesis cannot degrade a completed review, while a verified finding
   *  that still cannot be made publishable remains fail-closed. */
  readonly rejectedSanitizationCandidates: readonly EngineFinding[];
  readonly prefetch: ExistingConversationsPrefetch;
  readonly counters: PlanCounters;
}

function emptyCounters(): Counters {
  return {
    published: 0,
    suppressed: 0,
    suppressedIntraRun: 0,
    suppressedExactDuplicate: 0,
    suppressedSimilar: 0,
    suppressedDispositioned: 0,
    suppressedRecurrence: 0,
    rejectedSanitization: 0,
    neutralized: 0,
    rejectedPlacement: 0,
    readbackFailures: 0,
    apiFailures: 0,
  };
}

/** A finding that has passed sanitization but not yet run the intra-run or cross-run dedup stages —
 *  the common carrier `planPublication`'s pipeline passes from one stage to the next. Distinct from
 *  the exported `PlannedFinding`: that type means "survived EVERY plan-phase stage", which is not
 *  true yet at this point in the pipeline. */
interface SanitizedCandidate {
  readonly finding: EngineFinding;
  readonly sanitizedBody: string;
}

/** Sanitizes one finding. Returns the candidate to carry into clustering, or `undefined` once the
 *  rejection counter/diagnostic below already records why it stops here. */
function sanitizeOne(
  context: PublishContext,
  finding: EngineFinding,
  counters: Counters,
  diagnostics: Diagnostics,
): SanitizedCandidate | undefined {
  const sanitized = sanitizeFindingBody(finding.content);
  if (!sanitized.ok) {
    counters.rejectedSanitization += 1;
    // `sanitized.reason` is a closed, product-defined enum (`RejectionReason`, sanitize.ts) — never
    // candidate/model content — so recording it costs nothing under the diagnostics sink's
    // redaction posture, and gives an operator the one fact the bare count above could not: WHICH
    // of the sanitizer's checks is actually firing. Mirrors `tallyPlacementAttempts`'s identical
    // count-by-key shape a few dozen lines below.
    diagnostics.record("publish.finding_rejected_sanitization", {
      headSha: context.headSha,
      counts: { [sanitized.reason]: 1 },
    });
    return undefined;
  }
  // A neutralized body is a finding the reviewer would have DISCARDED before v0.12.0, and
  // discarding it also degraded the whole run. Counting the rewrites is what makes that saving
  // visible instead of merely believed — without it, "the sanitizer stopped throwing findings
  // away" is a claim no measurement can check.
  counters.neutralized += sanitized.neutralized ?? 0;
  return { finding, sanitizedBody: sanitized.body };
}

function toCandidateForDedup(candidate: SanitizedCandidate): CandidateForDedup {
  return {
    path: candidate.finding.path,
    startLine: candidate.finding.startLine,
    endLine: candidate.finding.endLine,
    body: candidate.sanitizedBody,
  };
}

/**
 * Rank used to pick a cluster's representative (`clusterIntraRunDuplicates`, below): earlier in
 * `FINDING_SEVERITIES` (`engine/classify.ts` — "critical", "high", "medium", "low", in that order)
 * outranks later, and anything outside that closed vocabulary — including `undefined` — ranks
 * lowest, "unclassified" in the design's own words. Reuses the engine's own severity vocabulary and
 * order rather than restating it as a second list that could silently drift from the first.
 */
function severityRank(severity: string | undefined): number {
  const index = (FINDING_SEVERITIES as readonly string[]).indexOf(severity?.toLowerCase() ?? "");
  return index === -1 ? 0 : FINDING_SEVERITIES.length - index;
}

/**
 * Whether `candidate` should replace `current` as its cluster's representative: strictly higher
 * severity, or — at equal severity — a strictly longer sanitized body. An exact tie on both changes
 * nothing, which is what implements the design's third tie-break ("earliest input position") without
 * a separate comparison term: candidates join a cluster in input order, so the incumbent
 * representative is always already the earliest-input-position candidate among everything tied with
 * it so far, and never displacing on a tie is enough to keep it that way.
 */
function isBetterRepresentative(
  candidate: SanitizedCandidate,
  current: SanitizedCandidate,
): boolean {
  const candidateRank = severityRank(candidate.finding.severity);
  const currentRank = severityRank(current.finding.severity);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  return candidate.sanitizedBody.length > current.sanitizedBody.length;
}

interface Cluster {
  representative: SanitizedCandidate;
  readonly members: SanitizedCandidate[];
}

interface IntraRunClusterResult {
  /** One survivor per cluster, in cluster-creation order — carried into the cross-run stages. */
  readonly representatives: readonly SanitizedCandidate[];
  /** Every non-representative member of every cluster, in input order — never composed, placed, or
   *  compared against anything downstream. */
  readonly suppressed: readonly SanitizedCandidate[];
}

/**
 * Greedy, deterministic clustering of this run's own sanitized findings (v0.12.0) — the fix for the
 * gap Arena v0.11.0 measured: 29 duplicate VARIANTS across 95 published findings (31%, versus 0 for
 * both competitor bots), one production location carrying one finding plus THREE variants. Every
 * dedup stage up to this one only ever compares a candidate against an ALREADY-PUBLISHED
 * conversation, so a model that describes one defect several times in a single pass had nothing here
 * to catch it.
 *
 * `candidates` is walked exactly once, in input order. Each one is compared — via
 * `areIntraRunDuplicates` (`similarity.ts`), on both sides' SANITIZED bodies — against the CURRENT
 * representative of every cluster founded so far, in the order those clusters were founded, and
 * joins the first match (`Array.prototype.find`'s own left-to-right semantics); finding no match, it
 * founds a new cluster of its own. Joining a cluster can change its representative — see
 * `isBetterRepresentative` — so a later candidate compares against whichever member already won that
 * tie-break, not necessarily the cluster's founding member.
 *
 * Determinism follows from three things holding together: candidates are visited in a fixed order
 * (their input order), clusters are compared in a fixed order (their creation order, itself a
 * function of input order), and a cluster's representative is decided by a strict, total tie-break
 * chain (severity, then sanitized body length, then — by construction, since an exact tie never
 * displaces the incumbent — earliest input position). Nothing here depends on object identity,
 * hashing, or `Map`/`Set` iteration order, so the same input always produces the same clustering.
 *
 * Representatives proceed into the cross-run stages exactly as they did before this stage existed;
 * every other member of every cluster is suppressed (see `planPublication`). The cluster's
 * best-articulated instance carries the defect for the whole cluster — the run loses redundancy,
 * never coverage. And because this runs BEFORE the cross-run checks, not after, a suppressed variant
 * never reaches them either: never fingerprinted against the marker set, never compared for
 * similarity or disposition, never composed, placed, or posted, and never handed to any downstream
 * step — present or future — that only ever sees this stage's own survivors, such as a classification
 * audit running between `planPublication` and `executePublication` (see `PlannedFinding`).
 *
 * O(n^2) in the number of sanitized findings: a candidate is compared against at most one
 * representative per existing cluster. The engine parser's own 1,000-finding ceiling bounds this
 * stage; `maxFindings` now limits the selected publication result rather than invalidating raw
 * hypotheses. The scan stays deliberately simple because even that defensive maximum is bounded.
 */
function clusterIntraRunDuplicates(
  candidates: readonly SanitizedCandidate[],
): IntraRunClusterResult {
  const clusters: Cluster[] = [];
  for (const candidate of candidates) {
    // Every member, not just the current representative: the representative can change as a
    // cluster grows (`isBetterRepresentative` below), and comparing only against whichever member
    // happens to hold that role right now lets a real duplicate of an EARLIER, since-demoted
    // member dodge suppression the moment a later member takes over as representative.
    // `areIntraRunDuplicates` is symmetric, so this only widens what a cluster can absorb, never
    // narrows it. The parser's defensive maximum keeps the worst case finite.
    // Every member, not just the current representative: the representative can change as a
    // cluster grows (`isBetterRepresentative` below), and comparing only against whichever member
    // happens to hold that role right now lets a real duplicate of an EARLIER, since-demoted
    // member dodge suppression the moment a later member takes over as representative.
    // `areIntraRunDuplicates` is symmetric, so this only widens what a cluster can absorb, never
    // narrows it. Bounded by the same finding-count ceiling `settle.ts` already enforces before
    // any of this runs, so the worst case (candidates × members-so-far, up from candidates ×
    // clusters) stays a small constant multiple of it, not an unbounded blowup.
    const cluster = clusters.find((existing) =>
      existing.members.some((member) =>
        areIntraRunDuplicates(toCandidateForDedup(candidate), toCandidateForDedup(member)),
      ),
    );
    if (cluster === undefined) {
      clusters.push({ representative: candidate, members: [candidate] });
      continue;
    }
    cluster.members.push(candidate);
    if (isBetterRepresentative(candidate, cluster.representative)) {
      cluster.representative = candidate;
    }
  }

  const representatives: SanitizedCandidate[] = [];
  const suppressed: SanitizedCandidate[] = [];
  for (const cluster of clusters) {
    representatives.push(cluster.representative);
    for (const member of cluster.members) {
      if (member !== cluster.representative) suppressed.push(member);
    }
  }
  return { representatives, suppressed };
}

/** Runs the cross-run dedup stages (marker, similarity, dispositioned) for one already-sanitized,
 *  already-declustered candidate. Returns the survivor to carry into execution, or `undefined` once
 *  a counter above already records why it stops here. */
function planCrossRun(
  context: PublishContext,
  candidate: SanitizedCandidate,
  prefetch: ExistingConversationsPrefetch,
  counters: Counters,
  diagnostics: Diagnostics,
): PlannedFinding | undefined {
  const { finding, sanitizedBody } = candidate;
  const marker = findingMarker(context, finding, sanitizedBody);
  const suppression = classifySuppression(
    finding,
    sanitizedBody,
    marker,
    prefetch.markers,
    prefetch.threads,
    context.identity,
  );
  if (suppression !== undefined) {
    counters.suppressed += 1;
    // A switch over the same closed union `suppressionCode` walks, for the same reason: the
    // `else` this replaces silently counted anything that was not "exact" or "similar" as a
    // disposition, so a fourth stage would have been tallied under a third stage's name.
    switch (suppression) {
      case "exact":
        counters.suppressedExactDuplicate += 1;
        break;
      case "similar":
        counters.suppressedSimilar += 1;
        break;
      case "dispositioned":
        counters.suppressedDispositioned += 1;
        break;
      case "recurrence":
        counters.suppressedRecurrence += 1;
        break;
    }
    diagnostics.record(suppressionCode(suppression), { headSha: context.headSha });
    return undefined;
  }

  return { finding, sanitizedBody };
}

/**
 * Runs sanitization, intra-run clustering, and all three cross-run dedup stages for every finding,
 * without composing, placing, or posting anything — so a caller can act on a survivor (the
 * follow-up's classification audit) before any API call is made for it.
 *
 * Three stages, strictly in order, each over the SAME input order the last one produced:
 *
 * 1. Sanitize every finding (`sanitizeOne`) — independent per finding.
 * 2. Cluster the sanitized survivors against EACH OTHER (`clusterIntraRunDuplicates`, v0.12.0) and
 *    keep only one representative per cluster. This is new: everything below it is the pipeline that
 *    existed before this stage, unchanged, now fed one representative per cluster instead of every
 *    raw finding.
 * 3. Run the cross-run dedup stages (`planCrossRun`) on each representative, against the SAME
 *    snapshot of existing conversations every one of them sees — `prefetchExistingConversations` (or
 *    a supplied `prefetch`) fetches once, before stage 3 starts, and nothing below ever adds to it.
 *
 * A later finding's plan decision therefore cannot depend on an earlier finding's publication
 * outcome (stage 3), nor on anything except candidates that arrived no later than it did in the
 * original input order (stage 2) — which is what makes it sound to plan every finding before
 * executing any of them.
 */
export async function planPublication(
  context: PublishContext,
  findings: readonly EngineFinding[],
  diagnostics: Diagnostics,
  prefetch?: ExistingConversationsPrefetch,
): Promise<PublicationPlan> {
  // Optional for the same reason `publishIncompleteNotice` accepts one: `settleIncomplete` calls
  // both functions back to back, and without a shared prefetch the second call re-lists every
  // comment and re-walks every thread the first one fetched moments earlier.
  const resolvedPrefetch = prefetch ?? (await prefetchExistingConversations(context));
  const counters = emptyCounters();

  // Stage 1: sanitize every finding, in input order — independent of every other finding.
  const sanitized: SanitizedCandidate[] = [];
  const rejectedSanitizationCandidates: EngineFinding[] = [];
  for (const finding of findings) {
    const candidate = sanitizeOne(context, finding, counters, diagnostics);
    if (candidate === undefined) rejectedSanitizationCandidates.push(finding);
    else sanitized.push(candidate);
  }

  // Stage 2: intra-run clustering, BETWEEN sanitization and the cross-run checks — see
  // `clusterIntraRunDuplicates` for the full rationale and the determinism argument. A suppressed
  // member is counted and diagnosed right here, once, and never touched again: it does not proceed
  // to stage 3 below, so it never reaches the marker/similarity/dispositioned checks either.
  const { representatives, suppressed: intraRunDuplicates } = clusterIntraRunDuplicates(sanitized);
  counters.suppressed += intraRunDuplicates.length;
  counters.suppressedIntraRun += intraRunDuplicates.length;
  intraRunDuplicates.forEach(() => {
    diagnostics.record("publish.finding_suppressed_intra_run", { headSha: context.headSha });
  });

  // Stage 3: the cross-run dedup stages, exactly as they ran before this feature existed, now over
  // one representative per intra-run cluster rather than over every raw finding.
  const survivors: PlannedFinding[] = [];
  for (const candidate of representatives) {
    const survivor = planCrossRun(context, candidate, resolvedPrefetch, counters, diagnostics);
    if (survivor !== undefined) survivors.push(survivor);
  }

  return {
    survivors,
    rejectedSanitizationCandidates,
    prefetch: resolvedPrefetch,
    counters: {
      suppressed: counters.suppressed,
      suppressedIntraRun: counters.suppressedIntraRun,
      suppressedExactDuplicate: counters.suppressedExactDuplicate,
      suppressedSimilar: counters.suppressedSimilar,
      suppressedDispositioned: counters.suppressedDispositioned,
      suppressedRecurrence: counters.suppressedRecurrence,
      rejectedSanitization: counters.rejectedSanitization,
      neutralized: counters.neutralized,
    },
  };
}

/** Composes, places, and posts one survivor — after re-checking its exact-marker fingerprint. */
async function executeOne(
  context: PublishContext,
  survivor: PlannedFinding,
  markers: ReadonlySet<string>,
  counters: Counters,
  diagnostics: Diagnostics,
): Promise<void> {
  const marker = findingMarker(context, survivor.finding, survivor.sanitizedBody);

  // Today this can never fire: `planCrossRun` already ran this identical check, against this same
  // `markers` snapshot, with this same fingerprint (nothing between planning and here changes a
  // finding's category or body). It exists for a follow-up that runs the classification audit on
  // survivors between planning and execution: a reclassified finding's fingerprint depends on its
  // (now different) category, and can newly collide with a marker this reviewer already published
  // under the old category. Without this re-check, that finding would be posted a second time
  // instead of being recognised as a duplicate of what is already on the pull request — so it is
  // counted and diagnosed exactly like the plan-stage exact-marker suppression, because that is
  // what it is.
  if (markers.has(marker)) {
    counters.suppressed += 1;
    counters.suppressedExactDuplicate += 1;
    diagnostics.record("publish.finding_suppressed_duplicate", { headSha: context.headSha });
    return;
  }

  try {
    await publishComposedFinding(
      context,
      survivor.finding,
      marker,
      survivor.sanitizedBody,
      counters,
      diagnostics,
    );
  } catch {
    // See the identical containment `publishOne` used before this split: a non-422 failure anywhere
    // in the composition→ladder→read-back tail must not abandon the survivors still queued behind
    // this one, or the whole run with them, over a cause that has nothing to do with their content.
    counters.apiFailures += 1;
    diagnostics.record("publish.api_failed", { headSha: context.headSha });
  }
}

/**
 * Composes, places, and posts every survivor from `planPublication`, merging its counters with the
 * ones execution itself produces into the same `PublishOutcome` shape a direct `publishFindings`
 * call has always returned. The merge is a plain per-field sum: the two counter sets are disjoint
 * except `suppressed`/`suppressedExactDuplicate`, which only ONE phase ever increments for a given
 * finding — a plan-stage suppression never reaches `executePublication` as a survivor, and the
 * execute-stage re-check above only fires for a survivor the plan stage did not already suppress.
 */
export async function executePublication(
  context: PublishContext,
  plan: PublicationPlan,
  diagnostics: Diagnostics,
): Promise<PublishOutcome> {
  const counters = emptyCounters();
  for (const survivor of plan.survivors) {
    await executeOne(context, survivor, plan.prefetch.markers, counters, diagnostics);
  }
  const suppressedEvidence = plan.counters.suppressedEvidence ?? 0;
  const suppressedRanked = plan.counters.suppressedRanked ?? 0;
  const verificationUndecided = plan.counters.verificationUndecided ?? 0;
  return {
    published: counters.published,
    suppressed: plan.counters.suppressed + counters.suppressed,
    // Intra-run clustering is entirely a plan-phase stage — `executeOne` above never clusters
    // anything, so `counters.suppressedIntraRun` (this phase's own, freshly-zeroed counter) never
    // moves. Summed anyway, for the identical reason every other field below is: one uniform
    // per-field merge, rather than a special case for the one field execution never touches.
    suppressedIntraRun: (plan.counters.suppressedIntraRun ?? 0) + counters.suppressedIntraRun,
    suppressedExactDuplicate:
      plan.counters.suppressedExactDuplicate + counters.suppressedExactDuplicate,
    suppressedSimilar: plan.counters.suppressedSimilar + counters.suppressedSimilar,
    suppressedDispositioned:
      plan.counters.suppressedDispositioned + counters.suppressedDispositioned,
    ...(suppressedEvidence === 0 ? {} : { suppressedEvidence }),
    ...(suppressedRanked === 0 ? {} : { suppressedRanked }),
    ...(verificationUndecided === 0 ? {} : { verificationUndecided }),
    suppressedRecurrence: (plan.counters.suppressedRecurrence ?? 0) + counters.suppressedRecurrence,
    rejectedSanitization: plan.counters.rejectedSanitization + counters.rejectedSanitization,
    rejectedPlacement: counters.rejectedPlacement,
    readbackFailures: counters.readbackFailures,
    apiFailures: counters.apiFailures,
  };
}

/**
 * Publishes every finding that survives sanitization and deduplication: `planPublication` decides
 * what may publish, `executePublication` composes, places, and posts it.
 *
 * The split exists so a future caller (the classification audit) can act on `planPublication`'s
 * survivors before any API call is made for them. This function itself still runs both phases back
 * to back, so nothing about it is observable from before the split — same API calls, same order,
 * same counters, same diagnostics; every existing caller keeps working unchanged.
 */
export async function publishFindings(
  context: PublishContext,
  findings: readonly EngineFinding[],
  diagnostics: Diagnostics,
  prefetch?: ExistingConversationsPrefetch,
): Promise<PublishOutcome> {
  const plan = await planPublication(context, findings, diagnostics, prefetch);
  return executePublication(context, plan, diagnostics);
}

/**
 * Publishes the one conversation that says "this review did not cover your change".
 *
 * It carries a reason code and the settlement's own bounded counts, nothing else. An incomplete
 * review is exactly the situation in which a detailed explanation would be most tempting and most
 * dangerous: the failure may have been caused by the candidate, and the diagnostic would be the
 * leak. The counts stay inside that rule — they are numbers `settle.ts` computed from its own
 * arithmetic, never engine or candidate prose.
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
  // The settlement's own measured counts, rendered into the notice body (`gapLine`) but kept out
  // of the marker fingerprint: the notice's identity is reason+head, and a shifting number must
  // not mint a duplicate conversation.
  counts?: Readonly<Record<string, number>>,
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
    const created = await requireClient(context).createReviewComment(
      context.ref,
      context.pullNumber,
      {
        body: composeIncompleteNotice(reasonCode, markerComment(marker), counts),
        commitId: context.headSha,
        path: anchorPath,
      },
    );
    const verified = await verifyPublication(context, created, marker);
    // Recorded as what actually happened (2026-08-06): this used to claim `published` even when
    // the read-back failed, so a run could report itself blocked on a notice that does not exist.
    if (verified) {
      diagnostics.record("publish.incomplete_notice_published", { headSha: context.headSha });
    } else {
      diagnostics.record("publish.readback_failed", { headSha: context.headSha });
    }
    return verified;
  } catch {
    diagnostics.record("publish.api_failed", { headSha: context.headSha });
    return false;
  }
}
