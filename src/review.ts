import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommitSha, RepoPath, Sha256 } from "./core/brands.js";
import {
  ReviewDeadlineExceeded,
  requireReviewTime,
  reviewDeadlineExpired,
  startReviewDeadline,
  type ReviewDeadline,
} from "./core/review-deadline.js";
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
  removeEntriesByKey,
  type CacheEntry,
  type CacheStore,
} from "./cache/review-cache.js";
import type { CompiledProfile } from "./config/profile.js";
import type { GuidelineIndex } from "./config/guidelines.js";
import { readModelToken, type RuntimeConfig } from "./config/runtime.js";
import type { Diagnostics } from "./diagnostics/sink.js";
import type { ReasonCode } from "./diagnostics/reason-codes.js";
import { acquireEngine } from "./engine/acquire.js";
import { collectContextPacks } from "./engine/context-pack.js";
import { companionsByPath, isLockfilePath, singleShotContextDigest } from "./engine/companions.js";
import { currentPlatformDigest, ENGINE_PIN } from "./engine/pinned-release.js";
import {
  auditClassification,
  repairClassification,
  needsClassification,
  type ClassifyEndpoint,
} from "./engine/classify.js";
import {
  parseEngineResult,
  type EngineFinding,
  type EngineResult,
  type RunStatus,
} from "./engine/result.js";
import { promptIdentityDigest } from "./engine/rule-identity.js";
import { renderChangeIntent } from "./engine/model-proxy.js";
import { GENERATION_WORKFLOW_IDENTITY } from "./engine/generation-workflow.js";
import { loadGuidelineContext, type GuidelineContextResult } from "./engine/guideline-context.js";
import { runSingleShotEngine } from "./engine/single-shot.js";
import {
  EngineRunError,
  MAX_TOOL_ROUNDS_PER_FILE,
  runEngine,
  type EngineRunOptions,
  type EngineRunOutput,
} from "./engine/run.js";
import {
  engineFailurePaths,
  settle,
  verdictsSurviveIncompleteness,
  type Settlement,
} from "./engine/settle.js";
import { readTextAtCommit, type GitContext } from "./git/plumbing.js";
import { runChangePass, type ChangedFile } from "./contracts/change-pass.js";
import {
  compareDeclaredContracts,
  describeMismatch,
  describeUnionGap,
  findUncoveredUnionMembers,
} from "./contracts/shape-gate.js";
import { describePinDesync, detectPinDesync } from "./contracts/pin-desync.js";
import {
  describeParallelMappingCrossover,
  detectParallelMappingCrossovers,
  isParallelMappingCandidatePath,
} from "./contracts/parallel-mapping.js";
import { detectLocalRegressions } from "./contracts/local-regression.js";
import {
  detectCrossFileRegressions,
  type SourceTransition,
} from "./contracts/cross-file-regression.js";
import type { InventoryItem } from "./inventory/classify.js";
import {
  buildInventory,
  criticalPointerCount,
  excludedPathCount,
  mechanicallyCleanPaths,
  resolveReviewPair,
  type Inventory,
  type ReviewPair,
} from "./inventory/inventory.js";
import type { GitHubClient, RepoRef } from "./github/client.js";
import {
  executePublication,
  prefetchExistingConversations,
  planPublication,
  publishIncompleteNotice,
  type ExistingConversationsPrefetch,
  type PlanCounters,
  type PlannedFinding,
  type PublicationPlan,
  type PublishContext,
  type PublishOutcome,
} from "./publish/publisher.js";
import { isIncompleteNoticeBody } from "./publish/presentation.js";
import { readChangeUnifiedDiff } from "./publish/change-diff.js";
import {
  buildChangeEvidence,
  mappedBaseRangeFromUnifiedDiff,
  type RepositoryEvidenceContext,
} from "./publish/evidence.js";
import {
  MAX_FRESH_VERIFICATION_CANDIDATES_PER_PR,
  selectPrWideFindings,
  selectVerificationCandidates,
} from "./publish/pr-wide-selection.js";
import {
  collectInitialRepositoryContext,
  collectRepositoryContextFollowUp,
  type RepositoryFollowUpContext,
  type RepositoryContextRequest,
} from "./publish/repository-context.js";
import { requestsClosedRuntimeFacts, toRetrievedEvidence } from "./publish/retrieved-evidence.js";
import { decodeEvidenceSourcePath } from "./publish/evidence-path.js";
import type { ClosedRuntimeFact } from "./publish/runtime-fact-catalog.js";
import { collectClosedRuntimeFactsAtCommit } from "./publish/runtime-facts.js";
import {
  MAX_SUBSTANTIATION_TOKENS_PER_FINDING,
  resolveSubstantiationStrictness,
  substantiate,
  type ContractChallengeAxis,
  type EvidenceRetriever,
  type JudgeableFinding,
  type SubstantiationOutcome,
  type SubstantiationTerminalTrace,
  type SubstantiationTraceReasonCode,
  type SubstantiationTraceStage,
} from "./publish/substantiate.js";
import { bindTrustedHunkEvidence, type TrustedHunkEvidence } from "./publish/closed-claim-proof.js";
import type { ClosedRefutationRuleId } from "./publish/closed-claim-proof.js";

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
  /**
   * What the pull request says it is for — title and description, as the author wrote them.
   *
   * Absent for the local CLI, which reviews a commit pair with no pull request behind it. Reaches
   * the model through `model-proxy.ts` rather than the rule text, because the rule digest keys the
   * review cache and a per-pull-request rule would make every cache entry unique to one.
   */
  readonly changeIntent?: string;
  readonly identity: string;
  /**
   * Whether `identity` is provably exclusive to this reviewer (`action/identity.ts`'s own field of
   * the identical name — mirrored here rather than importing the action-layer type, the same
   * boundary `client`/every other GitHub-specific field on this request already crosses). Gates
   * `resolveSupersededOwnNotices` in `performReview`'s own `finally` block below: a WRITE against
   * another author's content is not a risk the read-only dedup/suppression paths take on a shared
   * identity, and must not start being one just because a cleanup feature reuses the same login.
   */
  readonly identityExclusive: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly pathValue: string;
  /**
   * The parsed review-cache store, already read by the action layer (v0.9.0). `undefined` — not an
   * empty store — is what disables the feature entirely: every code path below only branches on
   * this being present, so an absent store costs this run nothing beyond the check itself.
   */
  readonly cacheStore?: CacheStore;
}

/**
 * The GitHub-independent slice of a review request: everything the shared pipeline — inventory,
 * engine acquisition and execution, classification repair and audit, the review-cache lookup —
 * needs to run, and nothing that presupposes a pull request exists to publish findings to.
 *
 * `request.client` is referenced at exactly two points in this file: `headIsCurrent` (head
 * currency) and `publishContextFor` (publish context) — the epic's own framing (#94) — and
 * `ref`/`pullNumber`/`identity` never travel anywhere without `client` alongside them. This type is
 * `ReviewRequest` minus exactly those four fields.
 *
 * `ReviewRequest` is deliberately NOT declared with an explicit `extends` of this interface: every
 * field below already appears in `ReviewRequest` with an identical type, so TypeScript's structural
 * typing accepts a `ReviewRequest` value anywhere this narrower shape is expected without one. That
 * is what lets every pipeline-only helper below be retyped to this interface without moving or
 * duplicating a single line of `ReviewRequest`'s own declaration, and without touching its shape at
 * all — see `LocalReviewRequest`, further down, which is exactly this shape under its own exported
 * name.
 */
interface PipelineRequest {
  readonly base: CommitSha;
  readonly head: CommitSha;
  /** The trusted base checkout the engine runs against. */
  readonly repositoryPath: string;
  readonly config: RuntimeConfig;
  readonly profile: CompiledProfile;
  readonly guidelines: GuidelineIndex;
  readonly env: NodeJS.ProcessEnv;
  readonly pathValue: string;
  /**
   * What the pull request says it is for — title and description, as the author wrote them.
   *
   * Absent by default and absent for the local CLI, which has no pull request to read one from.
   * Threaded to `model-proxy.ts` rather than into the rule text, and that placement is the whole
   * design: `promptIdentityDigest` hashes the rule document into the review cache's key, so a
   * per-pull-request rule would make every cache entry unique to one pull request and destroy
   * memoization across the repository. The proxy rewrites the wire body without touching the digest.
   */
  readonly changeIntent?: string;
  /**
   * The parsed review-cache store, already read by the caller (v0.9.0). `undefined` — not an empty
   * store — is what disables the feature entirely: every code path below only branches on this
   * being present, so an absent store costs this run nothing beyond the check itself.
   */
  readonly cacheStore?: CacheStore;
}

/**
 * `performLocalReview`'s request (issue #95): everything `ReviewRequest` carries except the four
 * GitHub-only fields (`client`, `ref`, `pullNumber`, `identity`) — no client, no pull request, no
 * reviewer identity to author comments as, because a local run never publishes anything.
 *
 * A type alias of `PipelineRequest` rather than its own `interface … extends … {}` declaration: an
 * interface that adds no members over its supertype is flagged by this repository's
 * `@typescript-eslint/no-empty-object-type` lint rule (verified empirically — the equivalent
 * `interface LocalReviewRequest extends PipelineRequest {}` fails `npm run lint`), and the two forms
 * are consumption-identical for every caller. `PipelineRequest` stays unexported and is used
 * directly as the parameter type for the pipeline-only helpers below; `LocalReviewRequest` is the
 * one public name issue #95's contract establishes.
 */
export type LocalReviewRequest = PipelineRequest;

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
  /**
   * Submodule-pointer bumps on a path the profile's own `deletionCritical`/`reviewRelevant` rules
   * call out (#37) — content the engine structurally cannot review (a gitlink SHA is not a blob
   * this repository's object store holds) on a path the consumer told the profile mattered. Never
   * affects `outcome`: this is honest reporting of a fact the classifier already knows, not a new
   * completeness requirement.
   */
  readonly criticalPointers: number;
  readonly publish?: PublishOutcome;
  /** Cache-eligible paths a stored entry answered instead of the engine. Always 0 when inert. */
  readonly cacheHits: number;
  /** Cache-eligible paths that were sent to the engine anyway. Always 0 when inert. */
  readonly cacheMisses: number;
  /**
   * Of `cacheMisses`, how many were specifically a content match `prPathSetDigest` refused to
   * replay because the pull request's changed-path-set shape moved since the entry was written
   * (v0.10.0, issue #50) — distinct from a miss whose content was simply never reviewed before.
   * Computed and diagnosed (`cache.context_invalidated`) since that feature shipped, but never
   * surfaced anywhere an operator could see it without reading the raw diagnostics stream — this is
   * the exact cost of the path-set-shape invalidation rule, made visible on the one report built
   * for that purpose. Always 0 when inert.
   */
  readonly contextInvalidated: number;
  /** How many new-or-refreshed entries `updatedCacheStore` carries over what was read in. */
  readonly cacheAppended: number;
  /** Present only for a `complete` outcome with the feature enabled — the store to write back. */
  readonly updatedCacheStore?: CacheStore;
}

/**
 * One finding as `performLocalReview` reports it: the same anchor, classification, and sanitized
 * body a published review comment would carry, without any of the publication metadata (marker,
 * placement, thread) that only makes sense once a pull request exists to attach it to.
 */
export interface LocalReviewFinding {
  /** Repository-relative, matching the reviewed head — never an absolute or base-relative path. */
  readonly path: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  /** 1-based, inclusive; equal to `startLine` for a single-line finding. */
  readonly endLine: number;
  /**
   * Optional keys, not `string | undefined` (`EngineFinding`'s own convention): a finding that
   * stayed unclassified after repair is still reported — reject-rather-than-repair forbids
   * fabricating a category nobody assigned — and an absent key is what stays assignable to a
   * consumer's own narrower contract under `exactOptionalPropertyTypes`, the way `src/cli.ts`'s
   * (issue #96) own placeholder `LocalReviewFinding` already declares these two fields.
   */
  readonly category?: string;
  readonly severity?: string;
  /** Sanitized Markdown — `sanitizeFindingBody`'s output, the same body a published comment would carry. */
  readonly body: string;
}

/**
 * `performLocalReview`'s result (issue #95): the same settlement outcome, spend, and finding
 * quality (post-repair, post-audit) a pull request review would produce for the identical base/head
 * pair, as data rather than as GitHub side effects.
 *
 * Deliberately narrower than `ReviewReport`: there is no `publish` outcome (nothing was published),
 * no cache-hit/miss/appended counts or `updatedCacheStore` (the review-cache is read for cost
 * savings but never written back — epic #94's local-runs-never-feed-CI invariant), and no
 * `abandoned`-specific bookkeeping. `outcome` reuses `ReviewOutcome` verbatim per the binding
 * contract, though `performLocalReview` itself never produces `"abandoned"`: that outcome exists
 * only for a pull request head that moved during the run, and a local run has no pull request head
 * to move.
 */
export interface LocalReviewReport {
  readonly outcome: ReviewOutcome;
  readonly reason?: ReasonCode;
  readonly findings: readonly LocalReviewFinding[];
  /** What the independent evidence gate withheld before a finding could reach a reader. */
  readonly quality?: {
    readonly evidenceWithheld: number;
    readonly rankedOut: number;
    readonly verificationUndecided: number;
  };
  /** This run's real spend, mirroring the `run.spend` diagnostic the action path records. */
  readonly spend: {
    readonly engine: number;
    readonly classify: number;
    readonly total: number;
    readonly allotted: number;
  };
  readonly inventory: {
    /** Total changed paths classified, whatever the classification. */
    readonly total: number;
    /** Paths the engine must account for — `Inventory.reviewablePaths.size`. */
    readonly reviewable: number;
    /** Reviewable paths this run holds a trustworthy verdict for, fresh or replayed from the cache. */
    readonly reviewed: number;
  };
  /** `promptIdentityDigest` — identifies the guidance this run reviewed under. */
  readonly ruleDigest: string;
  /** The pinned engine's version tag (`ENGINE_PIN.version`) this run executed under. */
  readonly engineVersion: string;
  /** Cache-eligible paths a stored entry answered instead of the engine. 0 when no store was given. */
  readonly cacheHits: number;
  /** Cache-eligible paths that were sent to the engine anyway. 0 when no store was given. */
  readonly cacheMisses: number;
  /**
   * The store to write back — mirrors `ReviewReport.updatedCacheStore`, under the identical
   * admission rule (`finalizeCacheStore`): present only for a `complete` outcome with a store
   * supplied, and it carries the AUDITED form of every stored finding. A local store never crosses
   * into CI (epic #94's trust boundary); this field exists so a local caller can keep its own
   * repeat runs cheap.
   */
  readonly updatedCacheStore?: CacheStore;
}

/**
 * Reviewable paths an EARLIER engine attempt of this same run already covered, credited to the
 * settlement but invisible to the report without this (2026-08-06, found by the completion gate on
 * its first real run).
 *
 * `executeEngine` folds these into the set it hands `settle()`, so the settlement's own arithmetic
 * is right: after a targeted gap resume it compares the second dispatch against the gap alone. But
 * `dispatchedMinusFailed` deliberately EXCLUDES memoized paths from `coveredPaths` — they were not
 * covered by the dispatch it is describing — and the report adds back only `memo.hitPaths`, the
 * review-CACHE hits. A resume-credited path is neither, so it fell through both: a run that
 * reviewed eighteen of nineteen files reported `reviewed 1`, with a numerator in the resume's frame
 * and a denominator in the pull request's.
 *
 * A mutable set threaded through the run context for the same reason `SpendLedger` is: the fact is
 * produced deep inside the engine stage and consumed by the report, and passing it back up through
 * every intermediate signature would be a larger change than the fact deserves.
 */
type CreditedPaths = Set<string>;

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

/** Exact unspent portion of the consumer's whole-review ceiling, never a negative allowance. */
function remainingWholeReviewBudget(request: PipelineRequest, ledger: SpendLedger): number {
  return Math.max(0, request.config.tokenBudget - ledger.engine - ledger.classify);
}

/**
 * The values one run fixes before it starts and every settlement and publication step below threads
 * verbatim: what is being reviewed, where this run's spend accumulates, and where its diagnostics go.
 *
 * This is the GitHub-independent slice, standing to `ReviewRun` exactly as `PipelineRequest` stands
 * to `ReviewRequest` — and, like that pair, related to the two run shapes below by structural typing
 * alone rather than by an explicit `extends`: `ReviewRun` and `LocalRun` each declare `request` at a
 * type assignable to `PipelineRequest` and the same two other fields, so a value of either is
 * accepted wherever this narrower shape is expected. That is what lets the steps both pipelines share
 * (`planAndAudit`, `auditFreshSurvivors`) take this shape and be handed either pipeline's own run
 * unchanged.
 *
 * `ledger` is `readonly` in the sense the rest of this file means it — the binding never rebinds —
 * while `SpendLedger`'s own fields stay mutable on purpose. Threading the ledger by reference is what
 * lets a spend that happens during publication land in the same total as the engine's own report; see
 * `SpendLedger`'s doc comment above for why that indirection exists at all.
 */
interface PipelineRun {
  readonly request: PipelineRequest;
  readonly ledger: SpendLedger;
  readonly diagnostics: Diagnostics;
  readonly deadline: ReviewDeadline;
}

/**
 * `performReview`'s run: the action path's request — client, pull request, and reviewer identity
 * included — alongside the one ledger and the one sink every step of that run shares.
 */
interface ReviewRun {
  readonly request: ReviewRequest;
  readonly ledger: SpendLedger;
  readonly diagnostics: Diagnostics;
  readonly deadline: ReviewDeadline;
  /** See `CreditedPaths` — filled by `executeEngine`, read by the report. */
  readonly credited: CreditedPaths;
}

/**
 * `performLocalReview`'s run: the client-less request, the same ledger and sink, plus the two
 * identity strings every `LocalReviewReport` echoes back.
 *
 * Those two belong to the run rather than to any one report builder because they are computed once,
 * from the configuration rather than from the outcome, and every local builder below needs both —
 * they were previously threaded as a pair through six consecutive signatures for exactly that reason.
 */
interface LocalRun {
  readonly request: LocalReviewRequest;
  readonly ledger: SpendLedger;
  readonly diagnostics: Diagnostics;
  readonly deadline: ReviewDeadline;
  /** See `CreditedPaths` — filled by `executeEngine`, read by the report. */
  readonly credited: CreditedPaths;
  /** `promptIdentityDigest` — identifies the guidance this run reviewed under. */
  readonly ruleDigest: string;
  /** The pinned engine's version tag (`ENGINE_PIN.version`) this run executes under. */
  readonly engineVersion: string;
}

/**
 * Measured blended cost per reviewable file, rounded up. The formula's dominant term by design.
 *
 * Recalibrated 2026-08-05 to the live MEAN, from four v0.12.0/v0.13.0 data points: 32k for a
 * one-file config change, 65k/file across a 55-file feature PR, 200k/file across a five-file
 * dense-code PR, and 103.9k/file across the 37-file oscharko-dev/Keiko#2970 run (3,843,796 tokens,
 * wire-confirmed against `model.usage`). Mean of the four: 100.2k.
 *
 * The previous value was 64k, chosen as the live median with the argument that "the allotment is a
 * stop-loss, and provisioning every run for the dense-code worst case would neuter it". Two things
 * were wrong with that, and both showed up in production:
 *
 * **The median is the wrong statistic for a sum.** The allotment prices `N` files at once, and a
 * sum of `N` draws concentrates around `N x mean`, not `N x median`. On this measured spread the
 * mean sits well above the median, so a median-calibrated allotment is not "the typical run" — it
 * is a ceiling the typical multi-file run is expected to cross. #2970 crossed it by 11.8% and
 * #2981 truncated thirteen times running.
 *
 * **Widening the ceiling is nearly free; hitting it is not.** `--max-tokens-budget` is a ceiling,
 * not an allocation: a run that does not need the headroom never spends it, so raising this costs
 * zero tokens on every run that was going to fit. Hitting it costs the ENTIRE run — the engine
 * stops mid-dispatch, the settlement is incomplete, the pull request gets a blocking notice, and
 * (before this same change's `memoizablePaths`) the next push re-paid every file from zero. The
 * asymmetry is roughly "nothing" against "twice the full price", so the calibration target is the
 * aggregate a large change actually needs, not the middle of the per-file spread.
 *
 * Still bounded, and deliberately so: `ALLOTMENT_CEILING` and the consumer's own `tokenBudget` both
 * still cap the result, and the formula stays size-scaled, so a one-file typo fix cannot reach a
 * multi-million-token allotment however this constant moves. That is what keeps it a stop-loss
 * against a runaway run — which is the failure it can actually protect against — rather than a
 * budget for an ordinary large one.
 */
const PER_FILE_TOKENS = 100_000;

/**
 * The tool-round ceiling this per-file price was calibrated under — the engine's own embedded
 * default (`MAX_TOOL_REQUEST_TIMES: 30`, `task_template.json` at v1.8.4).
 *
 * Named here rather than left implicit because on 2026-08-06 the two drifted apart and the
 * measurement caught it. Raising the ceiling to 60 (`MAX_TOOL_ROUNDS_PER_FILE`, engine/run.ts)
 * without touching this price did not fix Keiko#3008 — it MOVED the failure: run 1 stopped
 * settling `coverage_gap` and started settling `budget_exceeded` instead, spending 3.2M against
 * an allotment of 1.59M that was still priced for half the conversation length it now permits.
 *
 * A per-file price and a per-file round ceiling are two statements about the same thing, so
 * `allottedPerFile` below derives one from the other instead of letting a future change to either
 * silently invalidate the calibration behind this constant.
 */
const CALIBRATED_TOOL_ROUNDS = 30;

/**
 * The per-file price at the round ceiling actually in force.
 *
 * Deliberately NOT a second hand-tuned constant: the 100k above was measured against 30 rounds,
 * and the only honest way to keep it meaningful when the ceiling moves is to scale it by the same
 * factor. This over-provisions slightly — a file rarely uses every round it is allowed — but the
 * asymmetry `PER_FILE_TOKENS`'s own comment records still holds: headroom a run does not need
 * costs nothing, and hitting the stop-loss costs the entire run.
 */
function allottedPerFile(): number {
  return (PER_FILE_TOKENS * MAX_TOOL_ROUNDS_PER_FILE) / CALIBRATED_TOOL_ROUNDS;
}

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

/**
 * Floor beneath which a 1-2-file pull request would otherwise get an unworkably small allotment.
 *
 * Raised 80k -> 150k alongside the 2026-08-04 PER_FILE_TOKENS recalibration above, because the
 * measured one-file spread (32k config change vs a five-file run at 200k/file) says small dense
 * changes need real headroom. Risk-free since the audit guard subtracts from the consumer ceiling,
 * not from this stop-loss (see auditFreshSurvivors).
 *
 * Left at 150k through the 2026-08-05 move to 100k/file, and now genuinely close to inert: one file
 * prices at 130k before the line term, so the floor still binds only for a change under ~330 changed
 * lines in a single file. Kept rather than removed — it is the guard for exactly that shape, and the
 * 32k/200k spread lives entirely inside the band it covers.
 *
 * Sized for a WHOLE review, not for a second attempt bounded inside one — see
 * `RESUME_FLOOR_FRACTION` (near `runEngineWithOneResume`) for the resume's own floor, and for why
 * reusing this constant there was the defect it now replaces.
 */
const ALLOTMENT_FLOOR = 150_000;

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
    (reviewableFileCount * allottedPerFile() + reviewableChangedLines * PER_LINE_TOKENS);
  const clamped = clamp(sizeScaled, ALLOTMENT_FLOOR, ALLOTMENT_CEILING);
  return Math.round(Math.min(tokenBudget, clamped));
}

/** `D` in `computeAllottedBudget`: added-plus-deleted lines, summed across reviewable items that are
 *  also DISPATCHED — `excluded` is the same exclude union `dispatchedPathCount` (below) narrows by,
 *  so a cache hit's changed lines do not inflate the estimate for a file the engine will never open.
 *  Required, like `dispatchedPathCount`'s: omitting it would price cache-hit and mechanically-clean
 *  paths into the allotment — the widening `computeAllottedBudget`'s contract above forbids — so a
 *  future call site that forgets it is a compile error, not a silent overestimate. */
function reviewableChangedLines(inventory: Inventory, excluded: ReadonlySet<string>): number {
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

function gitContext(request: PipelineRequest): GitContext {
  return {
    cwd: request.repositoryPath,
    timeoutMs: 120_000,
    pathValue: request.pathValue,
  };
}

function recordPlannedCandidates(
  diagnostics: Diagnostics,
  batch: FindingBatch,
  plan: PublicationPlan,
): void {
  diagnostics.record("publish.candidates.planned", {
    counts: {
      generated: batch.findings.length,
      sanitized: batch.findings.length - plan.counters.rejectedSanitization,
      deduplicated: plan.survivors.length,
    },
  });
}

function recordRankedCandidates(
  diagnostics: Diagnostics,
  verification: ReturnType<typeof selectVerificationCandidates>,
  batch: FindingBatch,
  selected: ReturnType<typeof selectPrWideFindings>,
  plan: PublicationPlan,
): void {
  diagnostics.record("publish.candidates.ranked", {
    counts: {
      verified: verification.kept.filter((survivor) => batch.verify.has(survivor.finding)).length,
      ranked: selected.kept.length,
      publication: plan.survivors.length,
    },
  });
}

/**
 * Something to anchor a file-level notice to. A notice with no anchor cannot be published.
 *
 * Prefers the first reviewable item that is not a lockfile: the first live day anchored two
 * coverage notices to `package-lock.json:1` — the least readable spot on the whole pull request —
 * purely because the lockfile sorted first among reviewable items. A lockfile can still anchor as
 * the last resort; a notice nobody can place is worse than one oddly placed.
 */
function noticeAnchor(inventory: Inventory): string | undefined {
  const reviewable = inventory.items.filter((item) => item.reviewable);
  const readable = reviewable.find((item) => !isLockfilePath(item.path as string));
  return (readable ?? reviewable[0] ?? inventory.items[0])?.path;
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
): Pick<
  ReviewReport,
  "inventorySize" | "reviewablePaths" | "excludedPaths" | "mechanicallyClean" | "criticalPointers"
> {
  return {
    inventorySize: inventory.items.length,
    reviewablePaths: inventory.reviewablePaths.size,
    excludedPaths: excludedPathCount(inventory),
    mechanicallyClean: mechanicallyCleanPaths(inventory).length,
    criticalPointers: criticalPointerCount(inventory),
  };
}

/** The one `PublishContext` shape every publish call in this file needs, built from the same two inputs. */
function publishContextFor(request: ReviewRequest, inventory: Inventory): PublishContext {
  return {
    client: request.client,
    ref: request.ref,
    pullNumber: request.pullNumber,
    baseSha: inventory.pair.mergeBase,
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
  /** Per-path companion-context digests (single-shot mode, v0.20.1) — the SAME map lookup and
   *  entry-building must share; see `singleShotContextDigests` and `companions.ts`. */
  readonly contextDigests?: ReadonlyMap<string, Sha256>;
  /** Exact packs hashed into `contextDigests` and later reused by the engine invocation. */
  readonly contextPacks: ReadonlyMap<string, string>;
  /** Trusted merge-base instructions, loaded once before lookup and consumed only by the Scout. */
  readonly guidelineContext?: GuidelineContextResult;
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
  contextPacks: new Map(),
  contextInvalidated: 0,
};

/**
 * A settled finding list paired with which of its members are this run's OWN fresh engine output, as
 * opposed to a review-cache hit's replayed findings.
 *
 * The two are never meaningful apart, which is why they are one value rather than two adjacent
 * parameters: every step from `settleIncomplete` down to `planAndAudit` needs both, and deriving
 * `fresh` from `findings` alone is exactly the guess `settleIncomplete`'s doc comment forbids — a
 * caller with no engine output at all and a caller carrying a real settlement's findings look
 * identical once `findings` is flattened to one array.
 */
interface FindingBatch {
  readonly findings: readonly EngineFinding[];
  /** Every model-authored finding that must pass truth/falsifier in this run, including cache hits. */
  readonly verify: ReadonlySet<EngineFinding>;
  /** This run's newly generated findings; only these need a fresh classification audit. */
  readonly fresh: ReadonlySet<EngineFinding>;
}

/** Nothing found, and so no engine output that could be fresh — every settlement path that reaches
 *  publication with nothing of its own to carry gets this. */
const EMPTY_BATCH: FindingBatch = { findings: [], verify: new Set(), fresh: new Set() };

/** No fresh finding made its path unsafe for cache admission in this run. */
const NO_UNCACHEABLE_PATHS: ReadonlySet<string> = new Set();

/**
 * Why a run settled incomplete: the reason code both the published notice and the report carry, and —
 * only where a caller has something more specific than the code itself — the redacted, bounded counts
 * behind it.
 */
interface IncompleteCause {
  readonly reason: ReasonCode;
  /**
   * Redacted, bounded context for *why* this settlement fired — e.g. the publication outcome's own
   * rejection breakdown (Keiko-for-Quality#63) when the reason is a degraded publication. Omitted by
   * every caller that has nothing more specific than the reason code itself.
   */
  readonly counts?: Readonly<Record<string, number>>;
}

function cacheCounts(memo: MemoContext): {
  cacheHits: number;
  cacheMisses: number;
  contextInvalidated: number;
} {
  return {
    cacheHits: memo.hits.size,
    cacheMisses: memo.eligiblePaths.size - memo.hits.size,
    contextInvalidated: memo.contextInvalidated,
  };
}

/** `cacheCounts`, narrowed to the two fields `LocalReviewReport` actually declares — that type
 *  predates `contextInvalidated` and stays without it deliberately (issue #95's local-runs-never-
 *  feed-CI invariant scopes what a local report needs to know to its own consumer, the CLI, which
 *  has no run-summary comment for the field to inform). */
function localCacheCounts(memo: MemoContext): { cacheHits: number; cacheMisses: number } {
  const { cacheHits, cacheMisses } = cacheCounts(memo);
  return { cacheHits, cacheMisses };
}

/**
 * Looks up every cache-eligible path in `inventory`, after `buildInventory` and before the engine
 * runs — the same point v0.8.0's mechanically-clean computation sits.
 *
 * `request.cacheStore === undefined` short-circuits before computing either digest: no identity
 * digest, no platform digest, no diagnostic. That is what makes the feature genuinely inert rather
 * than merely unused when the consumer never configures `review_store_path`.
 */
async function prepareMemoization(
  request: PipelineRequest,
  inventory: Inventory,
  diagnostics: Diagnostics,
): Promise<MemoContext> {
  const [contextPacks, guidelineContext] = await Promise.all([
    prepareContextPacks(request, inventory),
    prepareGuidelineContext(request, inventory),
  ]);
  if (request.cacheStore === undefined) {
    return {
      ...INERT_MEMO,
      contextPacks,
      ...(guidelineContext === undefined ? {} : { guidelineContext }),
    };
  }
  return memoWithLookup(request, inventory, diagnostics, contextPacks, guidelineContext);
}

/**
 * The per-path cache-context expectation for single-shot runs, or `undefined` on the agentic path.
 *
 * In staged single-shot mode a file's verdict depends on every bounded prompt contribution: its
 * own diff (the six-field key), companions, context pack, trusted merge-base guidance, stated
 * purpose, and workflow version. The replay-context stamp therefore binds those exact inputs plus
 * the companion group's base→head identity (`companions.ts`), not the whole pull request's
 * path-set shape. Measured motivation (2026-08-08 live audit): whole-set invalidation re-reviewed
 * 113–116 files three times in twenty-five minutes and accounted for 89% of the window's spend,
 * while one added test file re-reviewed eleven. The agentic path returns `undefined` and keeps
 * the conservative scalar digest: it can search the repository, so its verdicts legitimately
 * depend on more than any fixed neighbour set.
 */
function singleShotContextDigests(
  request: PipelineRequest,
  inventory: Inventory,
  contextPacks: ReadonlyMap<string, string>,
  guidelineContext: GuidelineContextResult | undefined,
): ReadonlyMap<string, Sha256> | undefined {
  if (request.env.KFQ_SINGLE_SHOT !== "1") return undefined;
  const identity = new Map<string, string>();
  for (const item of inventory.items) {
    identity.set(
      item.path as string,
      `${(item.baseBlob as string | undefined) ?? "-"}>${(item.headBlob as string | undefined) ?? "-"}`,
    );
  }
  const companions = companionsByPath([...identity.keys()]);
  const renderedChangeIntent = renderedRequestChangeIntent(request);
  const guidelineIdentity = configuredGuidelineContextIdentity(request, guidelineContext);
  const digests = new Map<string, Sha256>();
  for (const [path, group] of companions) {
    digests.set(
      path,
      singleShotContextDigest(group, (companion) => identity.get(companion), {
        renderedChangeIntent,
        contextPack: contextPacks.get(path) ?? "",
        guidelineContextIdentity: guidelineIdentity,
        workflowIdentity: GENERATION_WORKFLOW_IDENTITY,
      }),
    );
  }
  return digests;
}

/** Exact prompt contribution of candidate-authored PR intent, shared by both cache contexts. */
function renderedRequestChangeIntent(request: PipelineRequest): string {
  return request.changeIntent === undefined || request.changeIntent === ""
    ? ""
    : renderChangeIntent(request.changeIntent);
}

/** Empty configurations stay path-only; configured files bind their exact merge-base result. */
function configuredGuidelineContextIdentity(
  request: PipelineRequest,
  guidelineContext: GuidelineContextResult | undefined,
): string {
  return request.guidelines.paths.length === 0 ? "" : (guidelineContext?.cacheIdentity ?? "");
}

/** Emits cache counters without making the cache-construction function carry reporting details. */
function recordCacheLookupDiagnostics(
  request: PipelineRequest,
  diagnostics: Diagnostics,
  hits: number,
  misses: number,
  contextInvalidated: number,
): void {
  diagnostics.record("cache.hits", { headSha: request.head, counts: { hits, misses } });
  // Distinct from `cache.hits`' own miss count (v0.10.0, issue #50): this tells an operator how
  // many misses were specifically invalidated by the changed-file context rather than new bytes.
  diagnostics.record("cache.context_invalidated", {
    headSha: request.head,
    counts: { invalidated: contextInvalidated },
  });
}

function memoWithLookup(
  request: PipelineRequest,
  inventory: Inventory,
  diagnostics: Diagnostics,
  contextPacks: ReadonlyMap<string, string>,
  guidelineContext: GuidelineContextResult | undefined,
): MemoContext {
  const ruleDigest = promptIdentityDigest(request.profile, request.guidelines);
  const engineDigest = currentPlatformDigest();
  const pathSetDigest = computePrPathSetDigest(
    inventory,
    renderedRequestChangeIntent(request),
    configuredGuidelineContextIdentity(request, guidelineContext),
  );
  const contextDigests = singleShotContextDigests(
    request,
    inventory,
    contextPacks,
    guidelineContext,
  );
  const { hits, eligiblePaths, contextInvalidated } = lookupMemoized(
    request.cacheStore,
    inventory,
    ruleDigest,
    engineDigest,
    request.config,
    pathSetDigest,
    contextDigests,
  );
  const memo: MemoContext = {
    hits,
    hitPaths: new Set(hits.keys()),
    eligiblePaths,
    ruleDigest,
    engineDigest,
    pathSetDigest,
    ...(contextDigests === undefined ? {} : { contextDigests }),
    contextPacks,
    ...(guidelineContext === undefined ? {} : { guidelineContext }),
    contextInvalidated,
  };
  recordCacheLookupDiagnostics(
    request,
    diagnostics,
    hits.size,
    eligiblePaths.size - hits.size,
    contextInvalidated,
  );
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
  uncacheablePaths: ReadonlySet<string> = NO_UNCACHEABLE_PATHS,
): { cacheAppended: number; updatedCacheStore?: CacheStore } {
  const finalized =
    covered === undefined
      ? undefined
      : finalizeCacheStore(request, inventory, memo, findings, covered, uncacheablePaths);
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
  run: ReviewRun,
  context: PublishContext,
  cause: IncompleteCause,
  anchor: string | undefined,
  batch: FindingBatch,
): Promise<AuditedPublication | undefined> {
  requireReviewTime(run.deadline);
  const prefetch =
    batch.findings.length > 0 || anchor !== undefined
      ? await prefetchExistingConversations(context)
      : undefined;
  requireReviewTime(run.deadline);
  const published =
    batch.findings.length === 0 ? undefined : await publishAudited(run, context, batch, prefetch);
  if (anchor !== undefined) {
    requireReviewTime(run.deadline);
    if (!(await headIsCurrent(run.request))) {
      run.diagnostics.record("publish.abandoned_stale_head", { headSha: run.request.head });
      throw new StaleHeadBeforePublication();
    }
    requireReviewTime(run.deadline);
    await publishIncompleteNotice(
      context,
      cause.reason,
      anchor,
      run.diagnostics,
      prefetch,
      cause.counts,
    );
  }
  return published;
}

/** Builds the common incomplete report after the optional publication-quality pass has finished. */
function incompleteSettlementReport(
  run: ReviewRun,
  inventory: Inventory,
  cause: IncompleteCause,
  memo: MemoContext,
  engineFindings: readonly EngineFinding[],
  covered: ReadonlySet<string> | undefined,
  published: AuditedPublication | undefined,
): ReviewReport {
  const storedFindings =
    published === undefined
      ? engineFindings
      : findingsForStorage(engineFindings, published.qualityByOriginal, published.droppedOriginals);
  const verifiedCovered =
    (published?.outcome.verificationUndecided ?? 0) === 0 ? covered : undefined;
  const uncacheablePaths = published?.uncacheablePaths ?? NO_UNCACHEABLE_PATHS;
  return {
    outcome: "incomplete",
    reason: cause.reason,
    ...inventoryCounts(inventory),
    ...truncatedCacheFields(
      run.request,
      inventory,
      memo,
      storedFindings,
      verifiedCovered,
      uncacheablePaths,
    ),
    ...cacheCounts(memo),
    ...(published === undefined ? {} : { publish: published.outcome }),
  };
}

/**
 * Fail-closed whole-review timeout. It deliberately performs no publication, head lookup, or cache
 * write: once the absolute boundary is reached, another call would turn the configured ceiling
 * into a suggestion. The action consumes the incomplete report itself as the blocking outcome.
 */
function reviewDeadlineReport(
  run: ReviewRun,
  inventory: Inventory,
  memo: MemoContext = INERT_MEMO,
): ReviewReport {
  run.diagnostics.record("engine.run.timeout", { headSha: run.request.head });
  run.diagnostics.record("settlement.incomplete.engine_error", {
    headSha: run.request.head,
    counts: { review_timeout: 1 },
  });
  return {
    outcome: "incomplete",
    reason: "settlement.incomplete.engine_error",
    ...inventoryCounts(inventory),
    ...cacheCounts(memo),
    cacheAppended: 0,
  };
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
 * @param cause The reason code this settlement reports, plus the optional redacted counts behind it —
 *   see `IncompleteCause`, whose `counts` field carries that parameter's own documentation.
 * @param batch What this settlement still carries: the findings to publish, paired with which of them
 *   are this run's OWN fresh engine output — `publishAudited`'s classification audit runs only on the
 *   latter. Every caller passes its own fresh set explicitly (v0.12.0) rather than this function
 *   inferring one from `findings` alone: a caller with no engine output at all (an unclassified path,
 *   an engine failure) and a caller carrying a real settlement's findings look identical once
 *   `findings` is flattened to one array, and guessing "fresh" from that array would silently
 *   re-audit a cache hit or silently skip a finding that deserved auditing.
 */
async function settleIncomplete(
  run: ReviewRun,
  inventory: Inventory,
  cause: IncompleteCause,
  memo: MemoContext = INERT_MEMO,
  batch: FindingBatch = EMPTY_BATCH,
  covered?: ReadonlySet<string>,
): Promise<ReviewReport> {
  if (reviewDeadlineExpired(run.deadline)) return reviewDeadlineReport(run, inventory, memo);
  run.diagnostics.record(cause.reason, {
    headSha: run.request.head,
    ...(cause.counts !== undefined ? { counts: cause.counts } : {}),
  });

  // Only the settlement's own engine findings may reach the store (2026-08-06). `batch.findings`
  // also carries replayed cache hits (already stored; `buildNewEntries` skips their paths anyway)
  // and gate findings — and a gate finding cached under one file's key is cross-file state frozen
  // into a per-file verdict: the next push that fixes the OTHER file of the pair replays a drift
  // report the freshly-run gate no longer makes. The complete path already refuses this
  // (`publishSettledFindings` stores `settlement.findings` only); this was the one path that did
  // not. `fresh` IS the engine list, by construction at every call site.
  const engineFindings = [...batch.fresh];

  if (!(await headIsCurrent(run.request))) {
    run.diagnostics.record("publish.abandoned_stale_head", { headSha: run.request.head });
    // No fresh verdict is cached before the evidence gate has run. A blob-addressed engine verdict
    // remains content-stable across a racing push, but it is not yet a publication-quality verdict:
    // storing it under the new semantics marker would let the next run bypass substantiation.
    return {
      ...abandonedReport(inventory, memo),
      ...truncatedCacheFields(run.request, inventory, memo, engineFindings, undefined),
    };
  }
  if (reviewDeadlineExpired(run.deadline)) return reviewDeadlineReport(run, inventory, memo);

  const context = publishContextFor(run.request, inventory);
  const anchor = noticeAnchor(inventory);
  let published: AuditedPublication | undefined;
  try {
    published = await publishIncompleteSettlement(run, context, cause, anchor, batch);
  } catch (error) {
    if (error instanceof StaleHeadBeforePublication) return abandonedReport(inventory, memo);
    if (error instanceof ReviewDeadlineExceeded) return reviewDeadlineReport(run, inventory, memo);
    throw error;
  }
  return incompleteSettlementReport(
    run,
    inventory,
    cause,
    memo,
    engineFindings,
    covered,
    published,
  );
}

interface EngineBudget {
  readonly excluded: readonly string[];
  readonly allottedBudget: number;
}

/**
 * Start-work reserves for the mandatory post-generation quality stages.
 *
 * The evidence stage may take an initial truth judgment, one retrieval-guided truth rerun, a
 * contract-challenge plan, and adversarial falsification, each with bounded source context. 86k is
 * proportional engine headroom for ordinary provider-reported spend (the former three-call path
 * reserved 64k). The shared one-path floor keeps one worst-case candidate's bound outside the
 * engine's start allotment without multiplying that defensive ceiling by all 16 possible
 * candidates; `substantiate` then atomically admits each sequential workflow against the exact
 * whole-review remainder. The smaller audit reserve is only a cheap start-work trigger;
 * `auditClassification` enforces the exact remaining allowance before every request as well.
 */
const SUBSTANTIATE_RESERVE_PER_FINDING = 86_000;
const AUDIT_RESERVE_PER_FINDING = 2_000;

function publicationQualityReserve(maxFindings: number): number {
  const candidates = Math.min(maxFindings, MAX_FRESH_VERIFICATION_CANDIDATES_PER_PR);
  if (candidates <= 0) return 0;
  const substantiateReserve = Math.max(
    candidates * SUBSTANTIATE_RESERVE_PER_FINDING,
    MAX_SUBSTANTIATION_TOKENS_PER_FINDING,
  );
  return substantiateReserve + candidates * AUDIT_RESERVE_PER_FINDING;
}

/**
 * The one unioned exclude list (mechanically-clean paths union cache hits) through the one
 * threading point v0.8.0 built — cache hits are never a second, parallel exclude channel alongside
 * the mechanically-clean one — plus the allotment computed from it. Split out of `executeEngine`
 * purely to keep that function's own line budget; the same `excluded` set feeds both the real
 * dispatch and this formula, so the estimate and the dispatch always agree on what "excluded"
 * means this run.
 */
function computeEngineBudget(
  request: PipelineRequest,
  inventory: Inventory,
  memo: MemoContext,
): EngineBudget {
  const excluded = combinedExcludes(mechanicallyCleanPaths(inventory), memo.hitPaths);
  const excludedSet = new Set(excluded);
  const engineCeiling = Math.max(
    1,
    request.config.tokenBudget - publicationQualityReserve(request.config.maxFindings),
  );
  const allottedBudget = computeAllottedBudget(
    engineCeiling,
    dispatchedPathCount(inventory, excludedSet),
    reviewableChangedLines(inventory, excludedSet),
  );
  return { excluded, allottedBudget };
}

/**
 * Books a propagating `EngineRunError`'s wire-counted spend (2026-08-06) — the ONE booking site
 * for a thrown-and-propagated attempt, which is what stops an incomplete run's report from
 * saying `spend 0` while `model.usage` counted thousands of real tokens. The absorbed-failure
 * paths inside `runEngineWithOneResume`/`attemptResume` book their own, so nothing is counted
 * twice; anything that is not an `EngineRunError` either already booked (`parseBooked`) or never
 * reached an invocation that could spend.
 */
function bookPropagatedEngineFailure(error: unknown, ledger: SpendLedger): void {
  if (error instanceof EngineRunError) ledger.engine += error.wireTokens ?? 0;
}

interface EngineInvocationPreparation {
  readonly binaryPath: string;
  readonly allottedBudget: number;
  readonly excluded: readonly string[];
  readonly preparedContextPacks: ReadonlyMap<string, string>;
  readonly guidelineContext: GuidelineContextResult | undefined;
}

/** The invocation options `executeEngine` hands `runEngineWithOneResume`. */
function engineInvocationOptions(
  request: PipelineRequest,
  deadline: ReviewDeadline,
  inventory: Inventory,
  preparation: EngineInvocationPreparation,
): EngineRunOptions {
  const { binaryPath, allottedBudget, excluded, preparedContextPacks, guidelineContext } =
    preparation;
  const excludedSet = new Set(excluded);
  const contextPacks = new Map(
    [...preparedContextPacks].filter(([path]) => !excludedSet.has(path)),
  );
  return {
    binaryPath,
    repositoryPath: request.repositoryPath,
    pair: inventory.pair,
    config: request.config,
    profile: request.profile,
    guidelines: request.guidelines,
    env: request.env,
    pathValue: request.pathValue,
    reviewDeadlineMs: deadline.expiresAtMs,
    ...(request.changeIntent === undefined ? {} : { changeIntent: request.changeIntent }),
    ...(request.env.KFQ_SINGLE_SHOT !== "1" || guidelineContext?.instruction === undefined
      ? {}
      : { trustedGuidance: guidelineContext.instruction }),
    ...(contextPacks.size === 0 ? {} : { contextPacks }),
    allottedBudget,
    expectedReviewablePaths: [...inventory.reviewablePaths].filter(
      (path) => !excludedSet.has(path),
    ),
    mechanicallyCleanPaths: excluded,
  };
}

/**
 * Loads trusted guideline identity for every runner before cache lookup. Only staged Scout receives
 * the rendered instruction; the agentic engine keeps its repository tools, but its generation
 * cache still moves when a configured merge-base guideline changes at the same path.
 */
async function prepareGuidelineContext(
  request: PipelineRequest,
  inventory: Inventory,
): Promise<GuidelineContextResult | undefined> {
  return loadGuidelineContext({
    repositoryPath: request.repositoryPath,
    pathValue: request.pathValue,
    mergeBase: inventory.pair.mergeBase,
    guidelines: request.guidelines,
  });
}

/**
 * Prepares context before cache lookup because its exact rendered bytes are part of a single-shot
 * verdict. A cache hit can therefore be trusted only after the same pack has been recomputed and
 * hashed. The engine later filters hits from this map without collecting it a second time.
 */
async function prepareContextPacks(
  request: PipelineRequest,
  inventory: Inventory,
): Promise<ReadonlyMap<string, string>> {
  // The 2026-08-07 A/B that defaulted packs OFF measured the agentic runner: the same context rode
  // roughly fifteen turns per file and cost +21.8% on an endpoint with no prompt caching. The
  // staged runner uses it only in its bounded Planner/Core/Integration prompts, rather than an
  // unbounded tool conversation. Agentic reviews therefore keep the explicit KFQ_CONTEXT_PACKS
  // experiment switch; production staged reviews always receive eligible packs so their examiners
  // do not have to guess what a repository search would say.
  if (request.env.KFQ_SINGLE_SHOT !== "1" && request.env.KFQ_CONTEXT_PACKS !== "1") {
    return new Map();
  }
  const mechanicallyClean = new Set(mechanicallyCleanPaths(inventory));
  const paths = [...inventory.reviewablePaths].filter((path) => !mechanicallyClean.has(path));
  return collectContextPacks({
    repositoryPath: request.repositoryPath,
    pair: inventory.pair,
    paths,
    pathValue: request.pathValue,
  });
}

/**
 * The one place both engine attempts (first dispatch and targeted resume) choose their runner.
 *
 * `KFQ_SINGLE_SHOT=1` selects the bounded staged runner (`single-shot.ts`) — Scout, mandatory Core,
 * and a deterministically-triggered Integration examiner, with engine-compatible output and no
 * open-ended tool loop. Everything downstream (parse, settle, resume, publish, store) is runner-
 * agnostic by construction: both produce the stdout shape `result.ts` parses. The targeted-gap
 * resume therefore works unchanged in single-shot mode, retrying exactly the files whose calls
 * failed.
 */
function invokeEngine(
  options: EngineRunOptions,
  diagnostics: Diagnostics,
): Promise<EngineRunOutput> {
  if (Date.now() >= options.reviewDeadlineMs) {
    return Promise.reject(new EngineRunError("engine.run.timeout"));
  }
  if (options.env.KFQ_SINGLE_SHOT === "1") return runSingleShotEngine(options, diagnostics);
  return runEngine(options, diagnostics);
}

/** The budget booking plus the fully assembled invocation — the two preparations that share one
 *  exclude union, folded together for `executeEngine`'s own line budget. */
function preparedInvocation(
  request: PipelineRequest,
  deadline: ReviewDeadline,
  inventory: Inventory,
  memo: MemoContext,
  ledger: SpendLedger,
  binaryPath: string,
): EngineRunOptions {
  const { excluded, allottedBudget } = computeEngineBudget(request, inventory, memo);
  ledger.allotted = allottedBudget;
  return engineInvocationOptions(request, deadline, inventory, {
    binaryPath,
    allottedBudget,
    excluded,
    preparedContextPacks: memo.contextPacks,
    guidelineContext: memo.guidelineContext,
  });
}

function recordRejectedEngineFindings(
  parsed: EngineResult,
  diagnostics: Diagnostics,
  headSha: CommitSha,
): void {
  if (parsed.rejectedFindings === 0) return;
  diagnostics.record("engine.result.findings_rejected", {
    headSha,
    counts: { rejected: parsed.rejectedFindings },
  });
}

function recordEngineCandidateCount(
  parsed: EngineResult,
  diagnostics: Diagnostics,
  headSha: CommitSha,
): void {
  diagnostics.record("engine.result.candidates", {
    headSha,
    counts: { generated: parsed.findings.length },
  });
}

async function reviewEngineBinaryPath(
  request: PipelineRequest,
  workspace: string,
  diagnostics: Diagnostics,
): Promise<string> {
  if (request.env.KFQ_SINGLE_SHOT === "1") return join(workspace, "unused-by-staged-runner");
  return (await acquireEngine(workspace, diagnostics)).binaryPath;
}

async function executeEngine(
  request: PipelineRequest,
  deadline: ReviewDeadline,
  inventory: Inventory,
  memo: MemoContext,
  ledger: SpendLedger,
  diagnostics: Diagnostics,
  credited: CreditedPaths,
): Promise<Settlement> {
  const workspace = await mkdtemp(join(tmpdir(), "kfq-engine-bin-"));
  try {
    requireReviewTime(deadline);
    // The staged runner is an HTTP-only workflow and never executes the pinned engine binary.
    // Keep the invocation shape shared, but do not make staged reviews depend on platform support,
    // archive download, extraction, or executable startup merely to supply an ignored path.
    const binaryPath = await reviewEngineBinaryPath(request, workspace, diagnostics);
    requireReviewTime(deadline);
    const {
      result: parsed,
      engineTokens,
      alreadyReviewedPaths,
    } = await runEngineWithOneResume(
      preparedInvocation(request, deadline, inventory, memo, ledger, binaryPath),
      diagnostics,
      ledger,
      inventory.reviewablePaths,
    );
    ledger.engine += engineTokens;
    requireReviewTime(deadline);
    // Findings this adapter refused while keeping the run (see `EngineResult.rejectedFindings`).
    // Recorded only when non-zero: a zero here is the ordinary case, and a line for it would
    // bury the one occurrence that matters under nineteen that do not.
    recordRejectedEngineFindings(parsed, diagnostics, inventory.pair.head);
    recordEngineCandidateCount(parsed, diagnostics, inventory.pair.head);
    const { result: classified, classifyTokens } = await repairEngineFindings(
      parsed,
      request,
      deadline,
      diagnostics,
      remainingWholeReviewBudget(request, ledger),
    );
    ledger.classify += classifyTokens;
    requireReviewTime(deadline);
    // Widened, never replaced: `alreadyReviewedPaths` (empty except after a resume that narrowed
    // its own dispatch — see `ResumeOutcome`'s doc comment) tells `settle()` those paths are
    // covered by the FIRST attempt, not by the returned result's own coverage, exactly the same
    // "covered by other means" contract `memo.hitPaths` already establishes for a cache hit.
    // Recorded for the report as well as handed to `settle()`: these paths are covered, and a
    // report that omitted them would understate its own coverage (see `CreditedPaths`).
    for (const path of alreadyReviewedPaths) credited.add(path);
    const memoizedForSettlement =
      alreadyReviewedPaths.length === 0
        ? memo.hitPaths
        : new Set([...memo.hitPaths, ...alreadyReviewedPaths]);
    return settle(inventory, classified, request.profile, request.config, memoizedForSettlement);
  } catch (error) {
    bookPropagatedEngineFailure(error, ledger);
    throw error;
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
function classifyDeps(
  request: PipelineRequest,
  deadline: ReviewDeadline,
): ClassifyEndpoint | undefined {
  if (request.config.protocol === "anthropic") return undefined;
  const token = readModelToken(request.config, request.env);
  if (token === undefined) return undefined;
  return {
    endpoint: request.config.endpoint,
    token,
    model: request.config.model,
    deadlineMs: deadline.expiresAtMs,
  };
}

/**
 * Bound on deterministic gate findings per run. The gate has no false positives by construction —
 * it only speaks about declarations it fully parsed — but a declared pair whose two sides have
 * drifted across many members would otherwise flood the pull request with one comment per member.
 * Past this bound the drift is a fact the first eight findings already establish.
 */
const MAX_GATE_FINDINGS = 8;

/**
 * A per-run cache of `readTextAtCommit` results, shared by every deterministic gate below AND by
 * `collectChangePassFindings` (#33) — its own model-facing pass reads the identical head-side text
 * for any reviewable file that also matches a declared contract pair or carries a duplicate pin, a
 * third independent git subprocess for content the gate collectors already fetched.
 *
 * The contract-pair comparison and the pin-desync scan both read the SAME (commit, path) text for
 * any item that happens to match a declared pair AND carry a duplicate pin — two independent git
 * subprocess spawns for identical content, on every run that has both. Keyed by `${commit}:${path}`
 * rather than blob id: a gate reads by commit+path (the identity these checks reason in), not by
 * blob, and the two happen to coincide here only because neither check's caller has a blob handy at
 * the point it decides what to read.
 */
type BlobTextCache = Map<string, string | undefined>;

async function readTextAtCommitCached(
  cache: BlobTextCache,
  ctx: GitContext,
  commit: CommitSha,
  path: string,
): Promise<string | undefined> {
  const key = `${commit}:${path}`;
  if (cache.has(key)) return cache.get(key);
  const text = await readTextAtCommit(ctx, commit, path);
  cache.set(key, text);
  return text;
}

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
 *
 * Pin-desync runs FIRST, ahead of the contract-pairs loop below: the two checks share one
 * `MAX_GATE_FINDINGS` budget, and pin-desync is the cheaper, unconfigured, historically-motivating
 * check (see its own doc comment) — a busy contract-pair loop must not be able to starve it
 * entirely just by matching first. Both checks share `blobCache`, so an item pin-desync already
 * read that also matches a declared pair costs the contract-pairs loop a cache lookup, not a
 * second git subprocess.
 */
/**
 * Items outer, matching pairs inner (#27): each item's own head/base text is read at most once
 * regardless of how many declared pairs match it — a matcher only decides WHICH counterparts to
 * compare against, never how many times this item's own content is fetched. Split out of
 * `collectGateFindings` purely for that function's own complexity/line budget; mutates `findings`
 * in place, matching `collectPinDesyncFindings`'s own calling convention. Returns how many (item,
 * pair) comparisons actually ran.
 */
async function compareMatchedPairs(
  blobCache: BlobTextCache,
  ctx: GitContext,
  request: PipelineRequest,
  inventory: Inventory,
  pairs: NonNullable<CompiledProfile["contractPairs"]>,
  findings: EngineFinding[],
): Promise<number> {
  let compared = 0;
  for (const item of inventory.items) {
    if (findings.length >= MAX_GATE_FINDINGS) break;
    if (!item.reviewable) continue;
    const matched = pairs.filter((pair) => pair.matcher.matches(item.path as string));
    if (matched.length === 0) continue;
    const path = item.path as string;
    const left = await readTextAtCommitCached(blobCache, ctx, request.head, path);
    if (left === undefined) continue;
    // Only needed by the union check, which asks what this change ADDED — a member present in both
    // versions was never widened by this pull request. Absent for an added file, which correctly
    // leaves the union check with nothing to compare. Reads from `oldPath` when this item is a
    // rename: the base version lived under the old name, and reading `path` there would ask git
    // for a blob that, at that commit, never existed under the new one.
    const leftBase = await readTextAtCommitCached(
      blobCache,
      ctx,
      inventory.pair.mergeBase,
      (item.oldPath ?? item.path) as string,
    );
    const side: ChangedSide = { item, text: left, baseText: leftBase };
    for (const pair of matched) {
      compared += await compareAgainstCounterparts(
        blobCache,
        ctx,
        request.head,
        side,
        pair,
        findings,
      );
      if (findings.length >= MAX_GATE_FINDINGS) break;
    }
  }
  return compared;
}

async function collectGateFindings(
  request: PipelineRequest,
  inventory: Inventory,
  diagnostics: Diagnostics,
  // Shared with `collectChangePassFindings` at the one caller (`publishSettledFindings`/
  // `completeLocalReport`) that runs both against the same head — see `BlobTextCache`'s own doc
  // comment (#33). Defaulted rather than required so the two incomplete-settlement call sites,
  // which never pair with a change-pass call, do not need to construct a Map they would never share.
  blobCache: BlobTextCache = new Map(),
): Promise<readonly EngineFinding[]> {
  const pairs = request.profile.contractPairs ?? [];
  const ctx = gitContext(request);
  const findings: EngineFinding[] = [];
  const pinDesyncs = await collectPinDesyncFindings(ctx, request, inventory, findings, blobCache);
  const mappingCrossovers = await collectParallelMappingFindings(
    ctx,
    request,
    inventory,
    findings,
    blobCache,
  );
  const localRegressions = await collectLocalRegressionFindings(
    ctx,
    request,
    inventory,
    findings,
    blobCache,
  );
  const crossFileRegressions = await collectCrossFileRegressionFindings(
    ctx,
    request,
    inventory,
    findings,
    blobCache,
  );
  const compared = await compareMatchedPairs(blobCache, ctx, request, inventory, pairs, findings);

  if (pairs.length === 0 && findings.length === 0 && pinDesyncs === 0) return [];
  diagnostics.record("contracts.gate", {
    headSha: request.head,
    counts: {
      pairs: pairs.length,
      compared,
      findings: findings.length,
      pin_desync: pinDesyncs,
      mapping_crossover: mappingCrossovers,
      local_regression: localRegressions,
      cross_file_regression: crossFileRegressions,
    },
  });
  return findings;
}

function pushLocalRegressionFindings(
  findings: EngineFinding[],
  item: InventoryItem,
  path: string,
  base: string,
  head: string,
): number {
  let found = 0;
  for (const regression of detectLocalRegressions(path, base, head)) {
    if (findings.length >= MAX_GATE_FINDINGS) break;
    findings.push({
      path: item.path,
      content: regression.content,
      startLine: regression.line,
      endLine: regression.line,
      category: regression.category,
      severity: regression.severity,
    });
    found += 1;
  }
  return found;
}

async function collectLocalRegressionFindings(
  ctx: GitContext,
  request: PipelineRequest,
  inventory: Inventory,
  findings: EngineFinding[],
  blobCache: BlobTextCache,
): Promise<number> {
  return collectModifiedBlobPairFindings(
    ctx,
    request,
    inventory,
    findings,
    blobCache,
    ({ item, path, base, head }) => pushLocalRegressionFindings(findings, item, path, base, head),
  );
}

/**
 * Exact two-way key/helper swaps need no model judgment: the base file establishes both matching
 * pairs, while the head crosses the same helpers without changing either call's arguments.
 */
function pushParallelMappingFindings(
  findings: EngineFinding[],
  item: InventoryItem,
  base: string,
  head: string,
): number {
  let found = 0;
  for (const crossover of detectParallelMappingCrossovers(base, head)) {
    if (findings.length >= MAX_GATE_FINDINGS) break;
    findings.push({
      path: item.path,
      content: describeParallelMappingCrossover(crossover),
      startLine: crossover.line,
      endLine: crossover.line,
      category: "bug",
      severity: "high",
    });
    found += 1;
  }
  return found;
}

async function collectParallelMappingFindings(
  ctx: GitContext,
  request: PipelineRequest,
  inventory: Inventory,
  findings: EngineFinding[],
  blobCache: BlobTextCache,
): Promise<number> {
  return collectModifiedBlobPairFindings(
    ctx,
    request,
    inventory,
    findings,
    blobCache,
    ({ item, path, base, head }) =>
      isParallelMappingCandidatePath(path)
        ? pushParallelMappingFindings(findings, item, base, head)
        : 0,
  );
}

interface ModifiedBlobPair {
  readonly item: InventoryItem;
  readonly path: string;
  readonly base: string;
  readonly head: string;
}

async function readModifiedBlobPair(
  ctx: GitContext,
  request: PipelineRequest,
  inventory: Inventory,
  item: InventoryItem,
  blobCache: BlobTextCache,
): Promise<ModifiedBlobPair | undefined> {
  if (!item.reviewable || (item.status !== "M" && item.status !== "R")) return undefined;
  const path = item.path as string;
  const base = await readTextAtCommitCached(
    blobCache,
    ctx,
    inventory.pair.mergeBase,
    (item.oldPath ?? item.path) as string,
  );
  const head = await readTextAtCommitCached(blobCache, ctx, request.head, path);
  return base === undefined || head === undefined ? undefined : { item, path, base, head };
}

async function collectModifiedBlobPairFindings(
  ctx: GitContext,
  request: PipelineRequest,
  inventory: Inventory,
  findings: EngineFinding[],
  blobCache: BlobTextCache,
  push: (pair: ModifiedBlobPair) => number,
): Promise<number> {
  let found = 0;
  for (const item of inventory.items) {
    if (findings.length >= MAX_GATE_FINDINGS) break;
    const pair = await readModifiedBlobPair(ctx, request, inventory, item, blobCache);
    if (pair !== undefined) found += push(pair);
  }
  return found;
}

async function collectCrossFileRegressionFindings(
  ctx: GitContext,
  request: PipelineRequest,
  inventory: Inventory,
  findings: EngineFinding[],
  blobCache: BlobTextCache,
): Promise<number> {
  const pairs: ModifiedBlobPair[] = [];
  for (const item of inventory.items) {
    if (item.reviewable && item.status === "A") {
      const path = item.path as string;
      const head = await readTextAtCommitCached(blobCache, ctx, request.head, path);
      if (head !== undefined) pairs.push({ item, path, base: "", head });
      continue;
    }
    const pair = await readModifiedBlobPair(ctx, request, inventory, item, blobCache);
    if (pair !== undefined) pairs.push(pair);
  }
  const itemsByPath = new Map(pairs.map((pair) => [pair.path, pair.item]));
  const sources: SourceTransition[] = pairs.map(({ path, base, head }) => ({ path, base, head }));
  let found = 0;
  for (const regression of detectCrossFileRegressions(sources)) {
    if (findings.length >= MAX_GATE_FINDINGS) break;
    const item = itemsByPath.get(regression.path);
    if (item === undefined) continue;
    findings.push({
      path: item.path,
      content: regression.content,
      startLine: regression.line,
      endLine: regression.line,
      category: regression.category,
      severity: regression.severity,
    });
    found += 1;
  }
  return found;
}

/**
 * The duplicate-pin desync check (v0.12.0): one file declaring the same 40-hex reference in two
 * places, where the change moved one and left the other behind.
 *
 * Unlike the shape gate above it needs no declared pair — both declarations live in the same file,
 * and the base version is what proves they were meant to agree. It runs over every modified OR
 * renamed-with-real-edits reviewable path for that reason, and its cost is two blob reads and a
 * text scan per file, no model involvement at all.
 *
 * It exists because this reviewer measurably missed exactly this on a production pull request that
 * advanced a pinned action's sha and left the variable declaring the same sha untouched — silently
 * disabling the consumer's own review store — while two other reviewers caught it. A per-file diff
 * review cannot see it: the changed line is correct in isolation, and the stale one did not change.
 *
 * `"R"` (v0.13.0) joins `"M"`: a rename with real content edits carries exactly the same "old
 * version proves what the two declarations were meant to agree on" evidence a modification does —
 * excluding it silently lost the check's own signal for any file whose rename this pull request
 * also touched. The base-side read follows `item.oldPath`, since the base version lived under the
 * old name; the head-side read and the published finding both stay on `item.path`, the file's
 * current name and the only one a review comment can anchor a still-open diff to.
 */
/**
 * Pushes one gate finding per pin-desync detected between `base` and `head` for this item,
 * stopping at `MAX_GATE_FINDINGS`. Split out of `collectPinDesyncFindings` purely for that
 * function's own complexity budget. Returns how many were actually pushed.
 */
function pushPinDesyncFindings(
  findings: EngineFinding[],
  item: InventoryItem,
  path: string,
  base: string,
  head: string,
): number {
  let found = 0;
  for (const desync of detectPinDesync(base, head)) {
    if (findings.length >= MAX_GATE_FINDINGS) break;
    findings.push({
      path: item.path,
      content: describePinDesync(desync, path),
      startLine: 0,
      endLine: 0,
      category: "bug",
      severity: "high",
    });
    found += 1;
  }
  return found;
}

async function collectPinDesyncFindings(
  ctx: GitContext,
  request: PipelineRequest,
  inventory: Inventory,
  findings: EngineFinding[],
  blobCache: BlobTextCache,
): Promise<number> {
  return collectModifiedBlobPairFindings(
    ctx,
    request,
    inventory,
    findings,
    blobCache,
    ({ item, path, base, head }) => pushPinDesyncFindings(findings, item, path, base, head),
  );
}

/**
 * Appends one file-level gate finding per item in `items`, stopping the moment `findings` has reached
 * `MAX_GATE_FINDINGS`, and reporting whether the cap is what stopped it.
 *
 * Extracted from `compareAgainstCounterparts` below, which ran this identical loop twice — once for
 * shape mismatches, once for union gaps — and paid for it in nesting depth. Each call reproduces its
 * loop exactly, laziness included: `describe` is invoked per PUSHED item, never per candidate,
 * because the cap is checked before it is called, so the item that would have exceeded the cap still
 * never pays for its own rendering. That is why this takes a callback over the raw items rather than
 * a pre-rendered array of strings — mapping first would call `describeMismatch`/`describeUnionGap`
 * for items the cap was always going to discard.
 *
 * `true` means the cap stopped the loop, which is the caller's signal to stop comparing counterparts
 * altogether: no later finding could be published anyway.
 *
 * `collectPinDesyncFindings` above deliberately keeps its own loop: it needs the NUMBER it pushed
 * (its `contracts.gate` count), not merely whether the cap fired, and it continues scanning its outer
 * file loop rather than returning.
 */
function pushGateFindings<T>(
  findings: EngineFinding[],
  path: RepoPath,
  items: readonly T[],
  describe: (item: T) => string,
): boolean {
  for (const item of items) {
    if (findings.length >= MAX_GATE_FINDINGS) return true;
    findings.push({
      path,
      content: describe(item),
      startLine: 0,
      endLine: 0,
      category: "bug",
      severity: "high",
    });
  }
  return false;
}

/**
 * The changed file's own side of a comparison: the item, and its head and base text.
 *
 * One value rather than three adjacent parameters because the three are only ever true together —
 * `text` and `baseText` are THIS item's content at head and base, and a caller that paired one
 * item with another's text would produce a finding about a file that never said it. Grouping them
 * is also what keeps the comparison inside this project's parameter budget (Sonar S107).
 */
interface ChangedSide {
  readonly item: InventoryItem;
  readonly text: string;
  /** Absent for an added file, which correctly leaves the union check with nothing to compare. */
  readonly baseText: string | undefined;
}

/**
 * One changed file against one pair's counterparts; returns how many comparisons actually ran.
 *
 * `side` is read once by the caller (`collectGateFindings`) and passed in rather than re-read here
 * — an item matching more than one declared pair used to pay for its own head/base content once
 * per matching pair, all identical reads. `right` (a counterpart, not this item) is still read
 * here, through the shared cache, since which counterparts get read depends on which pair is being
 * compared right now.
 */
async function compareAgainstCounterparts(
  blobCache: BlobTextCache,
  ctx: GitContext,
  head: CommitSha,
  side: ChangedSide,
  pair: { readonly counterparts: readonly string[] },
  findings: EngineFinding[],
): Promise<number> {
  const { item, text: left, baseText: leftBase } = side;
  const path = item.path as string;
  let compared = 0;
  for (const counterpart of pair.counterparts) {
    const right = await readTextAtCommitCached(blobCache, ctx, head, counterpart);
    if (right === undefined) continue;
    compared += 1;
    // `compareDeclaredContracts`, not `compareContracts`: the profile named these two files as
    // counterparts, so when neither side offers a same-named interface but each offers exactly
    // one, comparing those two is the declaration's own meaning rather than this gate guessing.
    const mismatches = compareDeclaredContracts(left, right);
    const capped = pushGateFindings(findings, item.path, mismatches, (mismatch) =>
      describeMismatch(mismatch, path, counterpart),
    );
    if (capped) return compared;
    if (leftBase === undefined) continue;
    const gaps = findUncoveredUnionMembers(leftBase, left, right);
    const cappedByGaps = pushGateFindings(findings, item.path, gaps, (gap) =>
      describeUnionGap(gap, path, counterpart),
    );
    if (cappedByGaps) return compared;
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
  request: PipelineRequest,
  deadline: ReviewDeadline,
  inventory: Inventory,
  ledger: SpendLedger,
  diagnostics: Diagnostics,
  // See `BlobTextCache`'s own doc comment (#33) for why this is shared with `collectGateFindings`
  // at their one common caller rather than each spawning its own git subprocess for the same text.
  blobCache: BlobTextCache = new Map(),
): Promise<readonly EngineFinding[]> {
  if (request.config.crossArtifactPass !== true) return [];
  requireReviewTime(deadline);
  const deps = classifyDeps(request, deadline);
  if (deps === undefined) return [];
  // Same ceiling and same reasoning as `auditFreshSurvivors`' guard below: the consumer's declared
  // budget, never the engine's size-scaled allotment, which live runs legally overshoot.
  const remaining = remainingWholeReviewBudget(request, ledger);
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
    requireReviewTime(deadline);
    const source = await readTextAtCommitCached(blobCache, ctx, request.head, item.path as string);
    if (source !== undefined) files.push({ path: item.path as string, source });
  }
  const { findings, tokens, budgetBlocked } = await runChangePass(files, deps, remaining);
  ledger.classify += tokens;
  requireReviewTime(deadline);
  const anchorable = findings.filter((finding) =>
    inventory.reviewablePaths.has(finding.path as string),
  );
  diagnostics.record("contracts.change_pass", {
    headSha: request.head,
    counts: {
      findings: anchorable.length,
      dropped_unanchorable: findings.length - anchorable.length,
      tokens,
      skipped_budget: budgetBlocked ? 1 : 0,
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
 * Moving repair to that same post-plan point — into `planAndAudit`, beside substantiation and the
 * audit, so a plan-suppressed finding never pays for it — was evaluated and REJECTED (2026-08-06).
 * Not for settlement's sake: `settle()` reads statuses, warnings, counts, coverage, and finding
 * PATHS (`memoizablePaths`), never `category`/`severity`, so the move is legal there. It fails on
 * the two consumers the audit's placement argument does not have:
 *
 * - Dedup itself. The exact-marker fingerprint hashes the category (`findingMarker`,
 *   `publisher.ts`), so when the engine re-reports an already-published defect WITHOUT its fields —
 *   the serving-stack coin flip this repair exists for — repair-before-plan is what makes the
 *   plan-stage marker check match the thread that already carries the finding. Repair-after-plan
 *   demotes that suppression to `executeOne`'s execute-time re-check, and the finding pays
 *   substantiation plus the audit on its way to being suppressed anyway: for the recurring-duplicate
 *   cohort — measured as the dominant duplicate source — the "saving" is a net increase.
 * - The store. `findingsForStorage` persists EVERY settlement finding, not the survivor subset, and
 *   a replayed hit is never in `fresh`, so nothing ever repairs it later (`mergeHitFindings` →
 *   `planPublication` is its whole pipeline). A plan-suppressed finding stored unrepaired would
 *   replay under `category ?? "general"` — a fingerprint that no longer matches the thread it is
 *   supposed to keep suppressing, the same desync `findingsForStorage`'s own comment engineers
 *   against for the audited category — and, wherever it publishes, render under the fallback
 *   labels regardless of what the defect actually is. Repairing at store time instead would re-ask
 *   for the same full fresh set the move claimed to save, netting zero whenever a store is
 *   configured, which is the production configuration. And the stale-abandon paths store
 *   `settlement.findings` without ever reaching `planAndAudit`, in exactly the rapid-push races
 *   where replays earn the most.
 *
 * The asymmetry with the audit is therefore the point, not an accident: the audit's only consumer
 * is the reader, so it belongs after the plan decides who reads; repair's classification also
 * feeds the dedup fingerprint and the store, so it belongs before both. The spend this placement
 * accepts is bounded by `needsClassification` below — a finding that arrives with both fields
 * valid never places a call at all — and the corpus harness (`corpus/run.mjs`, `repairFindings`)
 * mirrors this repair-before-plan order, so it keeps measuring the pipeline that ships.
 *
 * Returns the repair spend alongside the (possibly reclassified) result, so the caller can fold it
 * into this run's `SpendLedger`. Zero on every skip path below — a raw cohort above the publication
 * ceiling, the anthropic protocol, no findings to classify, no token to call with, or nothing that
 * actually needs it — because none of them ever placed a call.
 */
async function repairEngineFindings(
  parsed: EngineResult,
  request: PipelineRequest,
  deadline: ReviewDeadline,
  diagnostics: Diagnostics,
  maxTokens: number,
): Promise<{ result: EngineResult; classifyTokens: number }> {
  // `maxFindings` limits the FINAL publication set; it must never invalidate a complete engine
  // result merely because generation produced more hypotheses. It is still the right free guard for
  // this early, per-finding repair pass. The publication plan keeps at most the configured total and
  // sends at most sixteen model-authored candidates to verification, where the surviving bounded
  // cohort receives the ordinary classification audit. Repairing hundreds of raw, candidate-shaped
  // hypotheses before that plan could amplify attacker-controlled cost without changing which
  // candidates are ultimately eligible to publish. Skip only that mass repair here; settlement,
  // sanitization, deduplication, bounded verification, ranking, and publication all still run.
  //
  // Deliberately NOT extended to `parsed.budgetExceeded`: a budget-truncated run's findings are
  // still published and its covered files still memoized (`verdictsSurviveIncompleteness` in
  // `settle.ts`), so their classification quality matters exactly as much as an ordinary run's.
  // A budget-truncated cohort within the publication ceiling therefore still receives the ordinary
  // repair. The count guard is solely an early cost bound, never a trust or settlement verdict.
  if (parsed.findings.length > request.config.maxFindings) {
    return { result: parsed, classifyTokens: 0 };
  }
  if (parsed.findings.length === 0) return { result: parsed, classifyTokens: 0 };
  requireReviewTime(deadline);
  const deps = classifyDeps(request, deadline);
  if (deps === undefined) return { result: parsed, classifyTokens: 0 };
  if (!parsed.findings.some(needsClassification)) return { result: parsed, classifyTokens: 0 };

  const outcome = await repairClassification(parsed.findings, deps, maxTokens);
  diagnostics.record("classify.repaired", {
    counts: {
      repaired: outcome.repaired,
      failed: outcome.failed,
      ...nonzeroPublicationCount("budget_blocked", outcome.budgetBlocked),
      tokens: outcome.tokens,
    },
  });
  return { result: { ...parsed, findings: outcome.findings }, classifyTokens: outcome.tokens };
}

/** The resume's seed — any value other than the primary pin does the job. */
const RESUME_SEED = 43;

/**
 * The resume's own floor: a FRACTION of THIS review's allotment, not the constant `ALLOTMENT_FLOOR`
 * above.
 *
 * `ALLOTMENT_FLOOR` is sized for a whole 1-2-file review, not for a second attempt bounded inside
 * one. Using it as the resume's floor too meant the overrun got WORSE the smaller the review's own
 * allotment was: at the smallest possible allotment (a review already pinned to `ALLOTMENT_FLOOR`
 * itself), a first attempt that spent its whole allotment and then resumed could reach a full 2x
 * the configured ceiling. Measured this session on a representative 107,120-token allotment: a
 * first attempt overspent it, the resume's flat 80,000-token floor stacked on top regardless, and
 * the run landed at 201,881 tokens — 1.9x its own allotment. A quarter of the review's OWN ceiling
 * instead bounds the worst case across both attempts at 1.25x the allotment — constant however
 * large or small the allotment is, versus the ~1.75x that same 107,120-token example implies for
 * the old formula (1 + 80,000/107,120). The bound now scales with the review instead of being a
 * constant sized for a different one.
 */
const RESUME_FLOOR_FRACTION = 0.25;

/**
 * Exactly one bounded resume (#57). A run that ends without a usable success — the process threw,
 * or the result reports a non-success status — is re-invoked once. One, not N: an unbounded retry
 * converts a provider outage into a doubled bill, and the measured failure mode this closes is a
 * per-file subtask spiral that stops the whole run after finding nothing (production Keiko#2963
 * paid its 44 files twice for exactly this; the corpus reproduced the same signature four times
 * before the session log named it).
 *
 * The second attempt's status, coverage, and tokens stand — that part of "the second outcome
 * stands" is unchanged. What is no longer discarded is the first attempt's own paid-for work: the
 * resumed invocation excludes every path the first attempt already produced a finding for (the
 * same evidentiary bar `settle.ts`'s `memoizablePaths` uses — a finding proves the file was
 * opened), so the resume spends its budget only on ground genuinely still unreviewed, and those
 * carried-forward findings are folded into the returned result rather than silently re-paid for or
 * lost (see `mergeResumedResult`). A first attempt whose process THREW rather than returning a
 * parseable result has nothing to carry forward or exclude — `firstResult` stays `undefined` for
 * that case, and the resume dispatches everything, exactly as before.
 *
 * A second attempt that itself throws no longer takes the whole run down with it: when a
 * `firstResult` exists to fall back to, `engine.resume_failed` is recorded and that result stands
 * on its own, non-success status and all — a genuinely worse outcome than a completed resume, but
 * a strictly better one than losing every fact the first attempt established. A second failure
 * with no `firstResult` (the first attempt itself threw) still propagates exactly as before: there
 * is nothing to fall back to, so `settleOrReport`'s own catch is the correct place for it to land.
 *
 * A first attempt that already reports ITS OWN budget exceeded gets no resume at all: the
 * resume's budget can only be carved from what the first attempt left (see
 * `RESUME_FLOOR_FRACTION`), and an attempt that already spent past its own ceiling left nothing to
 * fund a second opinion with. Resuming anyway would only re-pay for ground the first attempt
 * already covered and settle incomplete regardless — cost with no chance of a different outcome.
 *
 * `engineTokens` (v0.12.0) is the cumulative SELF-REPORTED spend across every attempt whose
 * parsed result stands behind the returned outcome: a resumed run paid for both attempts, and
 * `run.spend` has to say so rather than under-report by the size of the discarded first one. A
 * skipped resume is one attempt, so it is exactly that attempt's own total — never a guess at
 * what a second would have cost.
 *
 * Attempts that FAIL never appear in `engineTokens` — a thrown invocation reports no total and a
 * malformed one's total cannot be trusted — but their cost is real, so it enters the ledger
 * directly at the failure site instead (2026-08-06), wire-counted by the proxy
 * (`EngineRunError.wireTokens` / `EngineRunOutput.wireTokens`): the absorbed-first-attempt catch
 * below, `attemptResume`'s own catch, `parseBooked`, and — for errors that propagate out of this
 * function entirely — `executeEngine`'s catch. One site per failure shape, so no attempt is ever
 * counted twice, and an incomplete run's report now carries what it measurably burned instead of
 * a zero.
 */
/**
 * `alreadyReviewedPaths` is the fact `executeEngine` needs and this function alone can produce: the
 * paths a resumed dispatch was deliberately NOT asked to cover, because the first attempt already
 * proved it opened them. `mergeResumedResult` restores their FINDINGS to the returned result, but
 * the returned `EngineResult`'s own `coverage`/`filesReviewed` still comes from whichever attempt's
 * dispatch produced it — narrower than the full inventory by exactly this set. Without surfacing it,
 * `settle()` (which never sees `runEngineWithOneResume`'s internals) would expect the returned
 * result to account for paths it was told to skip, and report a coverage gap that is not real. Empty
 * on every path where no resume narrowed anything: a same-first-attempt success, a skipped resume,
 * and the resume-failed fallback (which returns the FIRST attempt's own, self-consistent result,
 * whose own coverage already accounts for everything IT dispatched).
 */
interface ResumeOutcome {
  readonly result: EngineResult;
  readonly engineTokens: number;
  readonly alreadyReviewedPaths: readonly string[];
}

/** One diagnostic code per engine status — diagnostics carry no strings, so the code IS the value. */
const ENGINE_STATUS_DIAGNOSTIC: Readonly<Record<RunStatus, ReasonCode>> = {
  success: "engine.status.success",
  skipped: "engine.status.skipped",
  failed: "engine.status.failed",
  completed_with_warnings: "engine.status.completed_with_warnings",
  completed_with_errors: "engine.status.completed_with_errors",
  budget_exceeded: "engine.status.budget_exceeded",
  unknown: "engine.status.unknown",
};

/**
 * Records what the engine actually said about its run — once per engine execution, resumes
 * included.
 *
 * This line is the one the Keiko#3002 incident was missing: eight runs settled
 * `engine_status_not_success` and the log never named the status, the warning types, or how many
 * files the engine itself claimed. Warning types become `warnings_<type>` count entries; a type
 * that fails the sink's key grammar is dropped by `sanitizeCounts` rather than quoted, which keeps
 * the no-content contract intact.
 */
function recordEngineStatus(
  diagnostics: Diagnostics,
  result: EngineResult,
  headSha: CommitSha,
): void {
  const counts: Record<string, number> = {
    files_reviewed: result.filesReviewed,
    findings: result.findings.length,
    warnings: result.warnings.length,
  };
  // Rounds are spent on tool calls, so this is the only line that can answer why a file exhausted
  // its ceiling: not "it needed sixty rounds" but "it called this tool sixty times". Recorded only
  // when the engine reported a tally, so a release that stops emitting one goes quiet rather than
  // reporting a fabricated zero.
  if (result.toolCalls.total > 0) {
    counts.tool_calls = result.toolCalls.total;
    for (const [name, calls] of Object.entries(result.toolCalls.byTool)) {
      counts[`tool_${name}`] = calls;
    }
  }
  for (const warning of result.warnings) {
    const key = `warnings_${warning.type}`;
    counts[key] = (counts[key] ?? 0) + 1;
    // The split that makes the round ceiling evaluable (2026-08-06): `subtask_error` covers both
    // a file that exhausted its tool rounds and one whose model call simply failed, and only the
    // first is answered by giving files more rounds. Without this second key, raising the ceiling
    // would be a change nobody could measure. See `EngineWarning.cause`.
    if (warning.cause !== undefined) {
      const causeKey = `${key}_${warning.cause}`;
      counts[causeKey] = (counts[causeKey] ?? 0) + 1;
    }
  }
  diagnostics.record(ENGINE_STATUS_DIAGNOSTIC[result.status], { headSha, counts });
}

/**
 * Whether a first attempt's status makes a second dispatch worth paying for.
 *
 * `failed` and `unknown` mean the run itself is not to be believed — a resume is the designed
 * recovery. The completed statuses mean the run FINISHED and its reservations are deterministic
 * facts about this change (a per-file loop that hit its tool ceiling, a prompt over the per-file
 * threshold), not sampling noise: measured on Keiko#3002, every production resume re-dispatched
 * ~all files for ~0.76M tokens and reproduced the identical failure set. `skipped` has nothing to
 * resume by definition. Budget stops are handled a branch earlier and never reach this question.
 */
function resumeWorthwhile(status: RunStatus): boolean {
  return status === "failed" || status === "unknown";
}

/**
 * Parses an invocation's stdout, booking its wire-counted spend into the ledger when — and only
 * when — validation refuses the result (2026-08-06). A malformed result is rejected, never
 * repaired, but the invocation that produced it made real, billable model calls, and its own
 * `total_tokens` field is exactly what cannot be trusted at that point: the proxy's wire count
 * (`EngineRunOutput.wireTokens`) is the one measured number left. On the success path the parsed
 * total flows through `ResumeOutcome.engineTokens` unchanged — this helper books nothing there,
 * so the qualified success-path accounting keeps its measurement basis.
 */
function parseBooked(output: EngineRunOutput, ledger: SpendLedger): EngineResult {
  try {
    return parseEngineResult(output.stdout);
  } catch (error) {
    ledger.engine += output.wireTokens ?? 0;
    throw error;
  }
}

/**
 * How much of a finished run may be missing before a targeted resume stops being worth it.
 *
 * `resumeWorthwhile`'s blanket refusal was measured on a FULL re-dispatch (Keiko#3002: ~all files
 * re-reviewed for ~0.76M tokens, identical failures reproduced), and for a broad failure that
 * measurement still holds — if most of the review fell over, re-dispatching most of it is the
 * same bad trade under a new name. The trade only inverts when the casualties are a minority the
 * engine itself named: two files out of nineteen (Keiko#3011) cost a proportional share to retry
 * and decide whether a 1.6M-token review settles complete or incomplete.
 */
const TARGETED_GAP_MAX_FRACTION = 0.5;

/**
 * How many targeted rounds a finished run may buy before the gap it still reports is accepted.
 *
 * Three, and the number comes from a measurement rather than a preference: the completion gate's
 * first real run showed a nineteen-file review losing two files, one round recovering one, and the
 * run settling incomplete over the single file that remained. A cap of one leaves exactly that
 * kind of run permanently unfinishable; an uncapped loop would re-buy a deterministic per-file
 * failure forever. Each round is bounded twice over anyway — by the shrinking gap it dispatches
 * and by the shrink check in `settleFinishedRun`, which stops the moment a round stops helping.
 */
const TARGETED_GAP_MAX_ROUNDS = 3;

/**
 * The paths a targeted gap resume should re-dispatch, or `undefined` when this run is not a
 * candidate for one.
 *
 * Three conditions, each a refusal for its own reason: the engine must have NAMED its casualties
 * (an unnamed gap has nothing to aim at), at least one path must have survived (nothing to credit
 * otherwise, and a total failure is the broad case `TARGETED_GAP_MAX_FRACTION` defers to), and the
 * casualties must be a minority of the reviewable set.
 */
function targetedGapPaths(
  result: EngineResult,
  reviewablePaths: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (reviewablePaths.size === 0) return undefined;
  const failed = new Set<string>();
  for (const path of engineFailurePaths(result)) {
    // Only paths this run was actually asked to review: a warning naming a file outside the
    // reviewable set cannot be closed by re-dispatching it, and crediting the rest against a
    // phantom would misstate what the first attempt covered.
    if (reviewablePaths.has(path)) failed.add(path);
  }
  if (failed.size === 0 || failed.size >= reviewablePaths.size) return undefined;
  if (failed.size > reviewablePaths.size * TARGETED_GAP_MAX_FRACTION) return undefined;
  return failed;
}

/**
 * What a GENERAL resume (the `failed`/`unknown` path, not the targeted one) may skip and spend.
 *
 * `alreadyReviewedPaths` applies the same bar `memoizablePaths` (engine/settle.ts) uses: a finding
 * proves the engine opened the file, unless the manifest says that same file's review itself
 * failed, in which case the finding might be a partial verdict from before the failure and the
 * path is not safe to skip.
 */
function planGeneralResume(
  parsed: EngineResult,
  options: EngineRunOptions,
): { alreadyReviewedPaths: readonly string[]; remaining: number } {
  return {
    alreadyReviewedPaths: parsed.findings
      .filter((f) => !parsed.coverage.failed.some((c) => c.path === f.path))
      .map((f) => f.path as string),
    remaining: clamp(
      options.allottedBudget - parsed.totalTokens,
      Math.round(options.allottedBudget * RESUME_FLOOR_FRACTION),
      options.allottedBudget,
    ),
  };
}

/**
 * What one targeted round may spend — priced from the GAP it dispatches, not from what the first
 * attempt happened to leave.
 *
 * `RESUME_FLOOR_FRACTION` was sized for a resume that re-dispatches the WHOLE review, where "a
 * fraction of the original allotment" is the right shape. A targeted round dispatches k files, and
 * pricing it off the first attempt's leftovers gets the arithmetic exactly backwards: the more the
 * first attempt spent — which is to say, the larger the review — the less its retry gets. Measured
 * on Keiko#3008 (2026-08-06): twelve files, four lost, the first attempt spent 2.58M, and the round
 * that had to review four files was handed 399k. It threw, the gap did not shrink, and the review
 * settled incomplete over a budget that never matched its work.
 *
 * Priced instead like any other dispatch of k files — `PER_FILE_TOKENS` with the same
 * `ALLOTMENT_MARGIN` the whole-review estimate uses — and bounded twice: never below the old floor
 * (a one-file round still gets real headroom), and never past what the consumer's own ceiling has
 * left unspent. The second bound is what keeps rounds from turning a stop-loss into a blank cheque.
 *
 * `undefined` — no round at all — when the ceiling has nothing left to give, and this return is
 * load-bearing rather than tidy. `--max-tokens-budget 0` does not mean "spend nothing" to the
 * engine; its own flag help reads `0 = unlimited`. So an exhausted headroom rendered as a number
 * hands the very run that already overspent an UNBOUNDED dispatch — the exact inversion of the
 * bound this function exists to apply. Measured on Keiko#3008 (2026-08-06): a run 8.79M into a
 * 6M ceiling dispatched round 2 with `remaining: 0` and finished having spent 9.07M.
 */
function targetedRoundBudget(
  gapSize: number,
  spent: number,
  options: EngineRunOptions,
): number | undefined {
  // `allottedPerFile()`, not the raw `PER_FILE_TOKENS`: a retried file runs under the SAME
  // tool-round ceiling as every other, so pricing it at the pre-2026-08-06 calibration would
  // reintroduce, one function over, exactly the drift that constant now exists to prevent.
  const priced = Math.round(gapSize * allottedPerFile() * ALLOTMENT_MARGIN);
  const floor = Math.round(options.allottedBudget * RESUME_FLOOR_FRACTION);
  const headroom = Math.max(0, options.config.tokenBudget - spent);
  // `ALLOTMENT_FLOOR` is this repository's own answer to "the least a review can be given and
  // still be a review", so it is also the least a ROUND can be given. Below it the round would
  // either be dispatched with a budget that cannot finish one file, or — at exactly zero — with
  // no budget at all, which the engine reads as unlimited.
  if (headroom < ALLOTMENT_FLOOR) return undefined;
  return clamp(Math.min(priced, headroom), Math.min(floor, headroom), options.config.tokenBudget);
}

/** What a finished-run decision needs beyond the parsed result itself. */
interface FinishedRunContext {
  readonly options: EngineRunOptions;
  readonly diagnostics: Diagnostics;
  readonly ledger: SpendLedger;
  readonly reviewablePaths: ReadonlySet<string>;
  readonly firstAttemptTokens: number;
}

/**
 * Every outcome a non-success first attempt can reach WITHOUT a general resume, or `undefined`
 * when the caller should fall through to one.
 *
 * Two cases, each with its own recorded reason. A budget-exhausted attempt gets no second opinion
 * at all: a resume cannot review more of a change than the budget allows, it can only re-pay for
 * what the first one did and settle incomplete anyway. A FINISHED attempt is not resumed
 * WHOLESALE either (`resumeWorthwhile`, and the Keiko#3002 measurement behind it) — but when it
 * named its own casualties, those paths alone are worth a second dispatch (`settleFinishedRun`).
 */
async function decideAfterFirstAttempt(
  parsed: EngineResult,
  context: FinishedRunContext,
): Promise<ResumeOutcome | undefined> {
  const { options, diagnostics, firstAttemptTokens } = context;
  // Its own code rather than a borrowed one: `resumed_once` means a resume ran, and an absent
  // line would leave an operator unable to tell a run that never needed one from a run that was
  // denied one — exactly the question a budget-truncated review raises.
  if (parsed.budgetExceeded) {
    diagnostics.record("engine.resume_skipped_budget_exceeded", {
      counts: { spent: firstAttemptTokens, allotted: options.allottedBudget },
    });
    return { result: parsed, engineTokens: firstAttemptTokens, alreadyReviewedPaths: [] };
  }
  if (!resumeWorthwhile(parsed.status)) return await settleFinishedRun(parsed, context);
  return undefined;
}

/**
 * The two ways a FINISHED first attempt can end: settled as-is, or retried at exactly the paths it
 * disowned. Everything the first attempt did NOT lose is credited as already reviewed, which is
 * what keeps the settlement's arithmetic honest — `executeEngine` folds that set into
 * `memoizedForSettlement`, so `settle()` compares the second dispatch against the gap alone
 * rather than against the whole inventory. The decision itself lives in `targetedGapPaths`.
 */
/**
 * Whether another round is justified: the gap must have SHRUNK.
 *
 * A round that returns the same casualties — or more — is the deterministic per-file failure
 * `resumeWorthwhile` already refuses to re-buy, recognised one round later. Paying for it twice
 * more would reproduce the Keiko#3002 waste at a smaller scale, so the loop stops and says why.
 * A gap of zero also stops it, and silently: nothing was left unreviewed, which is the outcome
 * rounds exist to reach rather than a condition worth a diagnostic.
 */
function gapShrank(
  before: number,
  result: EngineResult,
  reviewablePaths: ReadonlySet<string>,
  diagnostics: Diagnostics,
  round: number,
): boolean {
  const after = targetedGapPaths(result, reviewablePaths)?.size ?? 0;
  if (after === 0) return false;
  if (after >= before) {
    diagnostics.record("engine.resume_gap_not_shrinking", { counts: { round, before, after } });
    return false;
  }
  return true;
}

async function settleFinishedRun(
  parsed: EngineResult,
  context: FinishedRunContext,
): Promise<ResumeOutcome> {
  const { options, diagnostics, ledger, reviewablePaths, firstAttemptTokens } = context;
  let standing = parsed;
  let spent = firstAttemptTokens;
  let outcome: ResumeOutcome | undefined;

  // Rounds, not a single retry, because one round measurably does not finish the job: on the
  // completion gate's first real measurement a nineteen-file review lost two files, the targeted
  // retry recovered ONE, and the run settled incomplete over the single file still missing. Each
  // round costs only its own shrinking gap, so the second round on one file is a rounding error
  // against the 1.6M-token review it decides.
  for (let round = 1; round <= TARGETED_GAP_MAX_ROUNDS; round += 1) {
    const targeted = targetedGapPaths(standing, reviewablePaths);
    if (targeted === undefined) break;
    const covered = [...reviewablePaths].filter((path) => !targeted.has(path));
    const remaining = targetedRoundBudget(targeted.size, spent, options);
    // The consumer's ceiling has nothing left to fund a round with. Stopping here is the whole
    // point: a run that already overspent must not be handed an unbounded dispatch (see
    // `targetedRoundBudget`), and the gap it still reports is the next push's work, not this
    // run's to buy at any price.
    if (remaining === undefined) {
      diagnostics.record("engine.resume_skipped_budget_exhausted", {
        counts: { round, targeted: targeted.size, spent },
      });
      break;
    }
    diagnostics.record("engine.resumed_gap_targeted", {
      counts: { round, targeted: targeted.size, covered: covered.length, remaining },
    });
    const attempt = await attemptResume(
      options,
      diagnostics,
      remaining,
      spent,
      standing,
      covered,
      ledger,
    );
    outcome = attempt;
    spent = attempt.engineTokens;
    standing = attempt.result;
    if (!gapShrank(targeted.size, attempt.result, reviewablePaths, diagnostics, round)) break;
  }

  if (outcome === undefined) return finishedRunOutcome(diagnostics, parsed, options);
  return outcome;
}

/** The denied-resume outcome for a finished first attempt — recorded, then settled on as-is. */
function finishedRunOutcome(
  diagnostics: Diagnostics,
  parsed: EngineResult,
  options: EngineRunOptions,
): ResumeOutcome {
  diagnostics.record("engine.resume_skipped_run_completed", {
    headSha: options.pair.head,
    counts: { files_reviewed: parsed.filesReviewed, warnings: parsed.warnings.length },
  });
  return { result: parsed, engineTokens: parsed.totalTokens, alreadyReviewedPaths: [] };
}

/**
 * The resumed dispatch itself, plus its own failure fallback — split out of
 * `runEngineWithOneResume` purely for that function's own line budget; the two try blocks share no
 * mutable state beyond what is passed in here. See `runEngineWithOneResume`'s own doc comment for
 * why a second failure with a `firstResult` to fall back to no longer takes the whole run down.
 */
async function attemptResume(
  options: EngineRunOptions,
  diagnostics: Diagnostics,
  remaining: number,
  firstAttemptTokens: number,
  firstResult: EngineResult | undefined,
  alreadyReviewedPaths: readonly string[],
  ledger: SpendLedger,
): Promise<ResumeOutcome> {
  try {
    // A different seed, deliberately: sampling is pinned for reproducibility, so a failing path
    // would replay itself byte-for-byte — measured, not hypothesized (the seeded verification
    // spiral failed 2/2 where the unseeded one failed ~1/4). Varying exactly one bit of entropy on
    // the one bounded retry is what turns it into a second opinion. `mechanicallyCleanPaths` is
    // widened, never replaced: the resume must still skip everything the first dispatch already
    // excluded (renames, cache hits) on top of what the first ATTEMPT now proves was reviewed.
    const second = await invokeEngine(
      {
        ...options,
        samplingSeed: RESUME_SEED,
        allottedBudget: remaining,
        expectedReviewablePaths: options.expectedReviewablePaths.filter(
          (path) => !alreadyReviewedPaths.includes(path),
        ),
        mechanicallyCleanPaths: [...options.mechanicallyCleanPaths, ...alreadyReviewedPaths],
      },
      diagnostics,
    );
    const parsedSecond = parseBooked(second, ledger);
    recordEngineStatus(diagnostics, parsedSecond, options.pair.head);
    const merged =
      firstResult === undefined
        ? parsedSecond
        : mergeResumedResult(firstResult, parsedSecond, alreadyReviewedPaths);
    return {
      result: merged,
      engineTokens: firstAttemptTokens + parsedSecond.totalTokens,
      alreadyReviewedPaths,
    };
  } catch (error) {
    // Mirrors the first attempt's own rescue above: only a genuine `EngineRunError` (spawn/timeout/
    // nonzero-exit) is ever caught here, never a `ValidationError` from a malformed-but-successfully
    // -spawned second result — reject-rather-than-repair applies to the second attempt exactly as
    // much as the first, and a malformed result is not evidence the first attempt's own findings
    // are still trustworthy. Rethrown, too, when there is nothing to fall back to: a first attempt
    // that itself threw leaves `firstResult` undefined, and the caller's own handling of that case
    // is unchanged from before this fallback existed.
    if (!(error instanceof EngineRunError) || firstResult === undefined) {
      // This throw ends the whole run, and `engineTokens` will never be returned — so the first
      // attempt's own measured total must be booked HERE or vanish from the ledger entirely. A
      // propagating `EngineRunError`'s own wire count is deliberately NOT booked here:
      // `executeEngine`'s catch is that error's one booking site (see there), and a
      // `ValidationError` already booked its invocation's wire count in `parseBooked`.
      ledger.engine += firstAttemptTokens;
      throw error;
    }
    // The absorbed failure's wire-counted spend (2026-08-06): this second invocation made real
    // model calls before failing, its error never propagates (the fallback below stands), so this
    // is the one place its cost can enter the ledger. `firstAttemptTokens` stays in the returned
    // `engineTokens`, exactly as before.
    ledger.engine += error.wireTokens ?? 0;
    diagnostics.record("engine.resume_failed", { counts: { spent: firstAttemptTokens } });
    // The returned result is `firstResult` UNCHANGED — its own coverage already accounts for
    // everything IT dispatched, so there is nothing narrower than usual for `settle()` to be told
    // about here (unlike the merged-success path above, whose returned coverage comes from the
    // SECOND attempt's narrower dispatch).
    return { result: firstResult, engineTokens: firstAttemptTokens, alreadyReviewedPaths: [] };
  }
}

/**
 * The four values this function carries across the first attempt, and why each starts where it
 * does — all four encode the same rule: before an attempt has reported something, this function
 * claims nothing.
 *
 * - `remaining` — what a resume may spend, floored at `RESUME_FLOOR_FRACTION` of THIS review's own
 *   allotment (see that constant) rather than a whole-review ceiling held across attempts. A
 *   thrown run reports no token total, so the full allotment stands: nothing measured says it was
 *   spent.
 * - `firstAttemptTokens` — the same honesty about spend. A thrown first attempt leaves no parsed
 *   result behind, so it contributes zero rather than a guess.
 * - `firstResult` — the first attempt's parsed result, kept so a second-attempt failure or a
 *   resumed dispatch has something real to fall back to or exclude from. `undefined` means there
 *   is nothing to fall back to: either no resume was needed (a success returns directly) or the
 *   first attempt itself threw.
 * - `alreadyReviewedPaths` — paths a resumed dispatch must skip because the first attempt proved
 *   it opened them, computed alongside `firstResult` from the same evidence.
 */
async function runEngineWithOneResume(
  options: EngineRunOptions,
  diagnostics: Diagnostics,
  ledger: SpendLedger,
  reviewablePaths: ReadonlySet<string>,
): Promise<ResumeOutcome> {
  // See this function's doc comment for what each of these four means before the first attempt
  // has run, and why every one of them starts at the honest "nothing measured yet" value.
  let remaining = options.allottedBudget;
  let firstAttemptTokens = 0;
  let firstResult: EngineResult | undefined;
  let alreadyReviewedPaths: readonly string[] = [];
  try {
    const first = await invokeEngine(options, diagnostics);
    const parsed = parseBooked(first, ledger);
    recordEngineStatus(diagnostics, parsed, options.pair.head);
    if (parsed.status === "success") {
      return { result: parsed, engineTokens: parsed.totalTokens, alreadyReviewedPaths: [] };
    }
    firstAttemptTokens = parsed.totalTokens;
    firstResult = parsed;
    const decided = await decideAfterFirstAttempt(parsed, {
      options,
      diagnostics,
      ledger,
      reviewablePaths,
      firstAttemptTokens,
    });
    if (decided !== undefined) return decided;
    ({ alreadyReviewedPaths, remaining } = planGeneralResume(parsed, options));
    diagnostics.record("engine.resumed_once", { counts: { remaining } });
  } catch (error) {
    if (!(error instanceof EngineRunError)) throw error;
    // The timeout belongs to the enclosing review, not to this attempt. Once exhausted, a resume
    // cannot manufacture another full `reviewTimeoutSeconds` window.
    if (Date.now() >= options.reviewDeadlineMs) throw error;
    // The absorbed first attempt's wire-counted spend (2026-08-06): this error never propagates —
    // the resume below IS the recovery — so `executeEngine`'s propagated-error booking never sees
    // it, and this catch is its one chance to reach the ledger. Nothing self-reported exists to
    // conflict with: a thrown attempt has no parsed `total_tokens` at all.
    ledger.engine += error.wireTokens ?? 0;
    diagnostics.record("engine.resumed_once", { counts: { remaining } });
  }
  return attemptResume(
    options,
    diagnostics,
    remaining,
    firstAttemptTokens,
    firstResult,
    alreadyReviewedPaths,
    ledger,
  );
}

/**
 * Folds a resumed dispatch's own outcome together with the findings the first attempt already
 * earned for the paths it excluded — `status`, `terminalState`, `coverage`, `budgetExceeded`, and
 * `totalTokens` all come from `second` alone, since that is what actually governs whether the run
 * as a whole is complete or incomplete; only the finding LIST gains back what the first attempt
 * already paid to produce and the resume was deliberately told not to re-open.
 *
 * Without this, excluding `excludedPaths` from the resumed dispatch (the cost fix this pairs with)
 * would silently convert real, already-paid-for findings into an invisible false-clean the moment
 * the resumed dispatch's own coverage no longer mentions those paths at all — worse than the
 * double-spend it replaces, because a double-spend at least kept the findings.
 */
function mergeResumedResult(
  first: EngineResult,
  second: EngineResult,
  excludedPaths: readonly string[],
): EngineResult {
  if (excludedPaths.length === 0) return second;
  const carried = new Set(excludedPaths);
  const carriedFindings = first.findings.filter((f) => carried.has(f.path as string));
  if (carriedFindings.length === 0) return second;
  return { ...second, findings: [...carriedFindings, ...second.findings] };
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
    (outcome.apiFailures ?? 0) > 0 ||
    // A verifier outage withheld fresh claims instead of publishing them. The withholding is the
    // safe publication decision; this flag is what stops that outage from masquerading as clean.
    (outcome.verificationUndecided ?? 0) > 0
  );
}

/** Emits optional diagnostic counts only when the measured value is non-zero. */
function nonzeroPublicationCount(
  key: string,
  value: number | undefined,
): Readonly<Record<string, number>> {
  if (value === undefined || value === 0) return {};
  return { [key]: value };
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
    ...nonzeroPublicationCount("verification_undecided", outcome.verificationUndecided),
    ...nonzeroPublicationCount("suppressed_evidence", outcome.suppressedEvidence),
    ...nonzeroPublicationCount("suppressed_ranked", outcome.suppressedRanked),
  };
}

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
  run: PipelineRun,
  fresh: readonly PlannedFinding[],
): Promise<ReadonlyMap<EngineFinding, EngineFinding>> {
  if (fresh.length === 0) return NO_AUDITED;
  requireReviewTime(run.deadline);
  const deps = classifyDeps(run.request, run.deadline);
  if (deps === undefined) return NO_AUDITED;

  // The consumer's declared whole-run ceiling, minus whatever the engine and repair — both already
  // final by the time publication runs — already spent. The audit is an add-on opinion, not a
  // publication requirement: under a nearly spent budget the honest move is to publish with the
  // classification the engine and the repair already produced and skip the audit, not to borrow
  // against a ceiling the consumer set for the whole run.
  //
  // `config.tokenBudget`, deliberately NOT `ledger.allotted`: the allotment is the engine's
  // size-scaled stop-loss, and the engine only consults it between dispatches — a run whose files
  // are all dispatched up front can legally finish far above it (measured 12.5x on the first live
  // v0.12.0 run, 2026-08-04, evidence in corpus/evidence/). Guarding the audit on that number
  // disabled it in exactly the expensive runs where a second opinion matters most, while the
  // ceiling this guard exists to protect — the consumer's — still had millions of tokens of room.
  const remaining = remainingWholeReviewBudget(run.request, run.ledger);
  if (remaining < AUDIT_RESERVE_PER_FINDING * fresh.length) {
    run.diagnostics.record("classify.skipped_budget", {
      headSha: run.request.head,
      counts: { skipped: fresh.length, remaining },
    });
    return NO_AUDITED;
  }

  const audit = await auditClassification(
    fresh.map((survivor) => survivor.finding),
    deps,
    remaining,
  );
  run.ledger.classify += audit.tokens;
  run.diagnostics.record("classify.audited", {
    counts: {
      changed: audit.changed,
      ...nonzeroPublicationCount("budget_blocked", audit.budgetBlocked),
      tokens: audit.tokens,
    },
  });
  requireReviewTime(run.deadline);

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

/** Audits verified prose and maps the classification verdict back to the engine original. */
async function auditEffectiveFreshSurvivors(
  run: PipelineRun,
  fresh: readonly PlannedFinding[],
  repaired: ReadonlyMap<EngineFinding, EngineFinding>,
): Promise<ReadonlyMap<EngineFinding, EngineFinding>> {
  const effective = fresh.map((survivor) => {
    const replacement = repaired.get(survivor.finding);
    return replacement === undefined ? survivor : { ...survivor, finding: replacement };
  });
  const audited = await auditFreshSurvivors(run, effective);
  return new Map(
    fresh.flatMap((survivor, index) => {
      const effectiveFinding = effective[index]?.finding;
      const classified = effectiveFinding === undefined ? undefined : audited.get(effectiveFinding);
      return classified === undefined ? [] : [[survivor.finding, classified] as const];
    }),
  );
}

/** What truth verification decided. It may drop prose, never rewrite it. */
interface SubstantiationResult {
  readonly dropped: ReadonlySet<EngineFinding>;
  /** Permanently empty compatibility channel: verification is keep/drop only. */
  readonly repaired: ReadonlyMap<EngineFinding, EngineFinding>;
  /** Content decisions: refuted or insufficiently evidenced. Safe to withhold. */
  readonly withheld: number;
  /** Infrastructure/evidence gaps. Withheld, but the review must not read as complete. */
  readonly undecided: number;
}

interface JudgeableOriginal extends JudgeableFinding {
  readonly original: EngineFinding;
  readonly basePath: string;
}

/** Empty input is the only no-op path. */
const NO_SUBSTANTIATION: SubstantiationResult = {
  dropped: new Set(),
  repaired: new Map(),
  withheld: 0,
  undecided: 0,
};

interface EvidenceSources {
  readonly headText: string | undefined;
  readonly baseText: string | undefined;
}

interface PreparedFindingEvidence extends EvidenceSources {
  readonly text: string;
  readonly unifiedDiff: string;
  readonly headRepositorySources: ReadonlyMap<string, string>;
  readonly repositoryRequest: RepositoryContextRequest;
  readonly repositoryContext: RepositoryEvidenceContext;
}

interface EvidenceRead {
  readonly path: string;
  readonly item: InventoryItem;
  readonly sources: EvidenceSources;
  readonly unifiedDiff: string;
}

/** Missing source is legitimate only on the side the inventory proves does not exist. */
function trustworthyEvidenceSources(
  item: InventoryItem | undefined,
  headText: string | undefined,
  baseText: string | undefined,
): EvidenceSources | undefined {
  if (item === undefined) return undefined;
  if (item.status === "A") {
    return headText === undefined ? undefined : { headText, baseText: undefined };
  }
  if (item.status === "D") {
    return baseText === undefined ? undefined : { headText: undefined, baseText };
  }
  return headText === undefined || baseText === undefined ? undefined : { headText, baseText };
}

async function readFindingEvidence(
  run: PipelineRun,
  context: PublishContext,
  cache: BlobTextCache,
  ctx: GitContext,
  finding: EngineFinding,
): Promise<EvidenceRead | undefined> {
  const path = finding.path as string;
  const item = context.items.get(path);
  if (item === undefined) return undefined;
  const basePath = (item.oldPath ?? item.path) as string;
  const [headText, baseText, unifiedDiff] = await Promise.all([
    readTextAtCommitCached(cache, ctx, run.request.head, path),
    readTextAtCommitCached(cache, ctx, context.baseSha, basePath),
    readChangeUnifiedDiff({
      repositoryPath: run.request.repositoryPath,
      pathValue: run.request.pathValue,
      base: context.baseSha,
      head: run.request.head,
      path,
      renameDetectionPercent: run.request.config.renameDetectionPercent,
      ...(item.oldPath === undefined ? {} : { oldPath: item.oldPath as string }),
    }),
  ]);
  const sources = trustworthyEvidenceSources(item, headText, baseText);
  return sources === undefined || unifiedDiff === undefined
    ? undefined
    : { path, item, sources, unifiedDiff };
}

function baseAnchorForFinding(
  read: EvidenceRead,
  finding: EngineFinding,
): { readonly startLine: number; readonly endLine: number } | undefined {
  const anchor = { startLine: finding.startLine, endLine: finding.endLine };
  return read.item.status === "D"
    ? anchor
    : mappedBaseRangeFromUnifiedDiff(read.unifiedDiff, anchor);
}

function repositoryRequestForFinding(
  run: PipelineRun,
  context: PublishContext,
  read: EvidenceRead,
  finding: EngineFinding,
  anchorText: string,
): RepositoryContextRequest {
  const baseFindingAnchor = baseAnchorForFinding(read, finding);
  return {
    repositoryPath: run.request.repositoryPath,
    pathValue: run.request.pathValue,
    head: run.request.head,
    base: context.baseSha,
    reviewPath: read.path,
    baseReviewPath: (read.item.oldPath ?? read.item.path) as string,
    findingAnchor: { startLine: finding.startLine, endLine: finding.endLine },
    ...(baseFindingAnchor === undefined ? {} : { baseFindingAnchor }),
    findingContent: finding.content,
    anchorText,
    unifiedDiff: read.unifiedDiff,
    deadlineMs: run.deadline.expiresAtMs,
  };
}

async function prepareFindingEvidence(
  run: PipelineRun,
  context: PublishContext,
  cache: BlobTextCache,
  ctx: GitContext,
  finding: EngineFinding,
): Promise<PreparedFindingEvidence | undefined> {
  const read = await readFindingEvidence(run, context, cache, ctx, finding);
  if (read === undefined) return undefined;
  const anchorSource = read.item.status === "D" ? read.sources.baseText : read.sources.headText;
  const anchorText = sourceLines(anchorSource, finding.startLine, finding.endLine);
  if (anchorText === undefined) return undefined;
  const repositoryRequest = repositoryRequestForFinding(run, context, read, finding, anchorText);
  const repositoryContext = await collectInitialRepositoryContext(repositoryRequest);
  const dossier = buildChangeEvidence(
    read.sources.headText,
    read.sources.baseText,
    {
      path: read.path,
      content: finding.content,
      startLine: finding.startLine,
      endLine: finding.endLine,
    },
    { unifiedDiff: read.unifiedDiff, repositoryContext },
  );
  const headRepositorySources = await readRenderedRepositorySources(run, cache, ctx, dossier.text);
  return dossier.text === ""
    ? undefined
    : {
        ...read.sources,
        text: dossier.text,
        unifiedDiff: read.unifiedDiff,
        headRepositorySources,
        repositoryRequest,
        repositoryContext,
      };
}

function renderedRepositoryPaths(text: string): readonly string[] | undefined {
  const paths: string[] = [];
  for (const row of text.split("\n")) {
    const match = /^H[1-8] = (.+)$/u.exec(row);
    if (match?.[1] === undefined) continue;
    const path = decodeEvidenceSourcePath(match[1]);
    if (path === undefined) return undefined;
    paths.push(path);
  }
  return [...new Set(paths)];
}

async function readRenderedRepositorySources(
  run: PipelineRun,
  cache: BlobTextCache,
  ctx: GitContext,
  dossier: string,
): Promise<ReadonlyMap<string, string>> {
  const paths = renderedRepositoryPaths(dossier);
  if (paths === undefined || paths.length === 0) return new Map();
  const sources = new Map<string, string>();
  for (const path of paths) {
    requireReviewTime(run.deadline);
    const source = await readTextAtCommitCached(cache, ctx, run.request.head, path);
    if (source === undefined) return new Map();
    sources.set(path, source);
  }
  return sources;
}

/**
 * Reads each model survivor's full head-side file once, then deterministically retrieves the exact
 * anchor and every occurrence of the symbols its prose cites. This replaces the old ±12-line view,
 * which could not show an existing guard six hundred lines away — the measured dominant source of
 * false positives.
 *
 * Pre-fetched into a map rather than read lazily inside `substantiate`, which keeps that module
 * free of git and of async I/O: it takes a plain synchronous reader, so every one of its branches
 * is exercised by a test with no filesystem at all.
 */
async function evidenceForSurvivors(
  run: PipelineRun,
  context: PublishContext,
  modelFindings: readonly PlannedFinding[],
): Promise<ReadonlyMap<EngineFinding, PreparedFindingEvidence>> {
  const cache: BlobTextCache = new Map();
  const ctx = gitContext(run.request);
  const evidence = new Map<EngineFinding, PreparedFindingEvidence>();
  for (const survivor of modelFindings) {
    requireReviewTime(run.deadline);
    const finding = survivor.finding;
    const prepared = await prepareFindingEvidence(run, context, cache, ctx, finding);
    if (prepared !== undefined) evidence.set(finding, prepared);
  }
  return evidence;
}

/** Exact anchor text for deterministic retrieval planning; no clamping or partial ranges. */
function sourceLines(
  source: string | undefined,
  startLine: number,
  endLine: number,
): string | undefined {
  if (
    source === undefined ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return undefined;
  }
  const text = source.endsWith("\n") ? source.slice(0, -1) : source;
  const lines = text.split("\n");
  if (endLine > lines.length) return undefined;
  return lines.slice(startLine - 1, endLine).join("\n");
}

function evidenceRetriever(
  evidence: ReadonlyMap<EngineFinding, PreparedFindingEvidence>,
  run: PipelineRun,
): EvidenceRetriever<JudgeableOriginal> {
  return async ({ finding, terms, stage, challengeAxis, knownProvenance }) => {
    requireReviewTime(run.deadline);
    const prepared = evidence.get(finding.original);
    if (prepared === undefined) throw new Error("finding evidence is unavailable");
    const sourceSide =
      challengeAxis === "base" ||
      (challengeAxis === "same_file_contract" && prepared.headText === undefined)
        ? "B"
        : "H";
    const runtimeFacts = await closedRuntimeFactsForChallenge(
      run,
      prepared,
      finding,
      stage,
      challengeAxis,
      sourceSide,
    );
    const followUp = await challengeFollowUpOrFactOnly(
      run,
      prepared,
      terms,
      challengeAxis,
      sourceSide,
      runtimeFacts,
    );
    return toRetrievedEvidence(followUp, knownProvenance, runtimeFacts);
  };
}

async function challengeFollowUpOrFactOnly(
  run: PipelineRun,
  prepared: PreparedFindingEvidence,
  terms: readonly string[],
  challengeAxis: ContractChallengeAxis | undefined,
  sourceSide: "H" | "B",
  runtimeFacts: readonly ClosedRuntimeFact[],
): Promise<RepositoryFollowUpContext> {
  try {
    const followUp = await collectRepositoryContextFollowUp(prepared.repositoryRequest, terms, {
      sourceSide,
      ...(challengeAxis === "configuration" ? { preferManifests: true } : {}),
    });
    requireReviewTime(run.deadline);
    return followUp;
  } catch (error) {
    requireReviewTime(run.deadline);
    if (runtimeFacts.length === 0) throw error;
    return {
      sourceCommit:
        sourceSide === "H" ? prepared.repositoryRequest.head : prepared.repositoryRequest.base,
      side: sourceSide,
      entries: [],
    };
  }
}

function selectedRuntimeFactAnchor(
  prepared: PreparedFindingEvidence,
  sourceSide: "H" | "B",
): RepositoryContextRequest["findingAnchor"] | undefined {
  if (sourceSide === "H") return prepared.repositoryRequest.findingAnchor;
  return prepared.repositoryRequest.baseFindingAnchor;
}

async function closedRuntimeFactsForChallenge(
  run: PipelineRun,
  prepared: PreparedFindingEvidence,
  finding: JudgeableOriginal,
  stage: "truth" | "contract_challenge",
  challengeAxis: ContractChallengeAxis | undefined,
  sourceSide: "H" | "B",
): Promise<readonly ClosedRuntimeFact[]> {
  if (stage !== "contract_challenge") return [];
  if (!requestsClosedRuntimeFacts(finding.content, challengeAxis)) return [];
  const findingAnchor = selectedRuntimeFactAnchor(prepared, sourceSide);
  // A pure insertion can expose useful cross-file BASE contracts without mapping the finding's
  // exact syntax to BASE. Keep that repository follow-up, but never substitute a HEAD coordinate
  // to license a BASE runtime fact.
  if (findingAnchor === undefined) return [];
  return await collectClosedRuntimeFactsAtCommit({
    context: gitContext(run.request),
    commit: sourceSide === "H" ? prepared.repositoryRequest.head : prepared.repositoryRequest.base,
    path:
      sourceSide === "H"
        ? prepared.repositoryRequest.reviewPath
        : prepared.repositoryRequest.baseReviewPath,
    side: sourceSide,
    findingAnchor,
    deadlineMs: run.deadline.expiresAtMs,
  });
}

const UNDECIDED_STAGE_COUNT: Readonly<Record<SubstantiationTraceStage, string>> = {
  preflight: "undecided_stage_preflight",
  truth_initial: "undecided_stage_truth_initial",
  truth_retrieval: "undecided_stage_truth_retrieval",
  truth_followup: "undecided_stage_truth_followup",
  challenge_planner: "undecided_stage_challenge_planner",
  challenge_retrieval: "undecided_stage_challenge_retrieval",
  falsifier: "undecided_stage_falsifier",
};

const UNDECIDED_REASON_COUNT: Readonly<Partial<Record<SubstantiationTraceReasonCode, string>>> = {
  budget: "undecided_reason_budget",
  request_transport_or_status: "undecided_reason_request",
  usage_invalid: "undecided_reason_usage",
  finish_reason_nonstop: "undecided_reason_finish",
  json_or_envelope_invalid: "undecided_reason_json",
  semantic_shape_invalid: "undecided_reason_shape",
  retrieval_error: "undecided_reason_retrieval",
};

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Closed stage/reason counters diagnose incomplete verification without logging reviewed text. */
function captureUndecidedTrace(
  counts: Record<string, number>,
  trace: SubstantiationTerminalTrace,
): void {
  if (trace.disposition !== "undecided") return;
  incrementCount(counts, UNDECIDED_STAGE_COUNT[trace.stage]);
  incrementCount(counts, UNDECIDED_REASON_COUNT[trace.reasonCode] ?? "undecided_reason_other");
}

function recordSubstantiation(
  run: PipelineRun,
  outcome: SubstantiationOutcome<JudgeableOriginal>,
  undecidedTraceCounts: Readonly<Record<string, number>>,
): void {
  run.ledger.classify += outcome.tokens;
  run.diagnostics.record("publish.substantiated", {
    counts: {
      kept: outcome.findings.length,
      direct_proved: outcome.directProved,
      truth_refuted: outcome.truthRefuted,
      falsifier_defeated: outcome.falsifierDefeated,
      insufficient_evidence: outcome.droppedInsufficientEvidence,
      retrieval_requested: outcome.retrievalRequested,
      retrieval_performed: outcome.retrievalPerformed,
      retrieval_expanded: outcome.retrievalExpanded,
      retrieval_no_matches: outcome.retrievalNoMatches,
      retrieval_failed: outcome.retrievalFailed,
      challenge_planned: outcome.challengePlanned,
      challenge_retrieval_performed: outcome.challengeRetrievalPerformed,
      challenge_expanded: outcome.challengeExpanded,
      challenge_no_matches: outcome.challengeNoMatches,
      challenge_failed: outcome.challengeFailed,
      undecided: outcome.undecided,
      budget_blocked: outcome.budgetBlocked,
      tokens: outcome.tokens,
      ...undecidedTraceCounts,
    },
  });
}

function trustedFindingEvidence(
  prepared: PreparedFindingEvidence | undefined,
): string | TrustedHunkEvidence {
  if (prepared === undefined) return "";
  return (
    bindTrustedHunkEvidence({
      text: prepared.text,
      headSource: prepared.headText,
      baseSource: prepared.baseText,
      headCommit: prepared.repositoryRequest.head,
      headRepositorySources: prepared.headRepositorySources,
    }) ?? ""
  );
}

type RefutationCounts = Partial<Record<ClosedRefutationRuleId, number>>;

function incrementRefutationCount(counts: RefutationCounts, ruleId: ClosedRefutationRuleId): void {
  counts[ruleId] = (counts[ruleId] ?? 0) + 1;
}

function recordDeterministicRefutations(diagnostics: Diagnostics, counts: RefutationCounts): void {
  if (Object.keys(counts).length === 0) return;
  diagnostics.record("publish.deterministic_refutation", { counts });
}

function judgeableFindings(
  modelFindings: readonly PlannedFinding[],
  evidence: ReadonlyMap<EngineFinding, PreparedFindingEvidence>,
): readonly JudgeableOriginal[] {
  return modelFindings.map((survivor) => {
    const prepared = evidence.get(survivor.finding);
    const path = survivor.finding.path as string;
    return {
      path,
      basePath: prepared?.repositoryRequest.baseReviewPath ?? path,
      content: survivor.finding.content,
      startLine: survivor.finding.startLine,
      endLine: survivor.finding.endLine,
      original: survivor.finding,
    };
  });
}

/**
 * Verifies every current publication candidate authored by a model — fresh generation, change-pass
 * output, and replayed cache findings — through a truth judge and an independent adversarial
 * falsifier. Deterministic contract gates are deliberately absent from this cohort.
 *
 * Placed beside `auditFreshSurvivors` and on the same cohort for the same reason: after
 * `planPublication` has decided what a reader will actually see, so a suppressed duplicate never
 * costs a judge call. Replayed generation-cache findings do run through this stage again.
 *
 * The initial dossier includes exact HEAD/BASE state, exact merge-base-to-HEAD changed lines, and
 * bounded repository sightings. A cache hit saves generation only: repository state, structural
 * retrieval, and verifier behavior can change independently of the per-file generation digest, so
 * replay never saves this stage. Truth may request one deterministic lookup and then must make a
 * terminal decision. Every confirmed claim receives a separate contract challenge whose terms are
 * retrieved before the terminal adversarial Falsifier. A challenge search with no novel evidence
 * is the closed no-defeater result for an already direct-proven claim; an expanded challenge reaches
 * the Falsifier. Both bounded paths reserve their final call so every closed Falsifier proposal —
 * and an eligible malformed response — reaches the independent Referee within the four-call cap.
 * Wording is never repaired here: an unproven hypothesis leaves the cohort unchanged only in the
 * sense that no replacement is invented — under production's paranoid policy it is withheld.
 *
 * This call is deliberately fail-closed for the OpenAI-compatible production path. A missing file,
 * unreachable judge, malformed verdict, or fabricated evidence line withholds the fresh candidate
 * and increments `undecided`; the caller turns that count into an incomplete review instead of a
 * false clean result. Anthropic retains the pre-existing no-audit path until this independent judge
 * has a native protocol adapter; Keiko's measured/deployed `gpt-oss-120b` path is OpenAI-compatible.
 */
async function substantiateModelSurvivors(
  run: PipelineRun,
  context: PublishContext,
  modelFindings: readonly PlannedFinding[],
): Promise<SubstantiationResult> {
  if (modelFindings.length === 0) return NO_SUBSTANTIATION;
  requireReviewTime(run.deadline);
  const deps = classifyDeps(run.request, run.deadline);
  // This verifier speaks the same OpenAI-compatible protocol Keiko deploys with gpt-oss-120b.
  // Anthropic keeps its existing strictly-parsed engine path until a native adapter exists.
  if (deps === undefined) return NO_SUBSTANTIATION;

  // Passing the exact whole-review remainder keeps the limit hard even when one
  // finding takes either full truth -> retrieval -> terminal truth -> challenge -> falsifier or
  // truth -> challenge -> falsifier -> referee. Both paths remain atomically admitted at four calls.
  const remaining = Math.max(
    0,
    run.request.config.tokenBudget - run.ledger.engine - run.ledger.classify,
  );

  const evidence = await evidenceForSurvivors(run, context, modelFindings);
  requireReviewTime(run.deadline);
  const judgeable = judgeableFindings(modelFindings, evidence);
  const evidenceByJudgeable = new Map<JudgeableFinding, string | TrustedHunkEvidence>(
    judgeable.map((finding) => [finding, trustedFindingEvidence(evidence.get(finding.original))]),
  );
  const undecidedTraceCounts: Record<string, number> = {};
  const deterministicRefutations: RefutationCounts = {};

  const outcome = await substantiate(
    judgeable,
    (finding) => evidenceByJudgeable.get(finding) ?? "",
    deps,
    // The same closed operating point is bound into qualification evidence. Production defaults
    // fail-closed (`paranoid`); explicit sweep stages may vary it without creating a second path.
    resolveSubstantiationStrictness(run.request.env),
    remaining,
    evidenceRetriever(evidence, run),
    (trace) => {
      captureUndecidedTrace(undecidedTraceCounts, trace);
    },
    (ruleId) => {
      incrementRefutationCount(deterministicRefutations, ruleId);
    },
  );
  recordDeterministicRefutations(run.diagnostics, deterministicRefutations);
  recordSubstantiation(run, outcome, undecidedTraceCounts);
  requireReviewTime(run.deadline);

  return partitionSubstantiated(judgeable, outcome);
}

/**
 * Two explicit sets, not one map that means "kept" by presence.
 *
 * A finding this stage left untouched must NOT enter a substitution map: `substituteAudited` looks
 * survivors up by object identity, so replacing every survivor with an identical copy would make
 * the audit's own lookup — which keys on the ORIGINAL object — miss all of them. Measured as the
 * audit silently failing to apply to anything at all.
 */
function partitionSubstantiated(
  judged: readonly JudgeableOriginal[],
  outcome: SubstantiationOutcome<JudgeableOriginal>,
): SubstantiationResult {
  // Accept only exact input objects. A clone with edited prose would silently restore the rewrite
  // path this workflow removed; treating it as unverified keeps publication fail-closed.
  const judgedObjects = new Set(judged);
  const kept = outcome.findings.filter((entry) => judgedObjects.has(entry));
  const unexpectedReplacements = outcome.findings.length - kept.length;
  const survived = new Set(kept.map((entry) => entry.original));
  const dropped = new Set(
    judged.filter((entry) => !survived.has(entry.original)).map((entry) => entry.original),
  );
  return {
    dropped,
    repaired: new Map(),
    withheld: outcome.droppedVague + outcome.droppedUnsupported + outcome.droppedNitpick,
    undecided: outcome.undecided + unexpectedReplacements,
  };
}

/** `publishAudited`'s result: the outcome `executePublication` produced, plus which fresh survivors
 *  were actually audited, so a caller can decide what the review cache should remember for each. */
interface AuditedPublication {
  readonly outcome: PublishOutcome;
  /** Final classification-audited form for fresh findings that survived the quality gates. */
  readonly qualityByOriginal: ReadonlyMap<EngineFinding, EngineFinding>;
  /** Model findings intentionally withheld or unverified; they must not reappear from the cache. */
  readonly droppedOriginals: ReadonlySet<EngineFinding>;
  /** Paths whose model verdict was suppressed, refuted, or removed by PR-wide ranking. */
  readonly uncacheablePaths: ReadonlySet<string>;
}

/**
 * Paths whose current model result cannot be represented by a complete per-file cache entry.
 *
 * A fresh original absent from `planned` was suppressed before the evidence gate (sanitization,
 * intra-run clustering, or an existing conversation). A ranked-out original was verified but lost
 * a PR-global decision. Neither outcome says the file is clean, so one such original makes the
 * entire path ineligible rather than storing an empty or partial finding list. Replayed cache hits
 * participate too: an unsafe replay is evicted so it cannot recur next run.
 */
function uncacheableModelPaths(
  modelOriginals: ReadonlySet<EngineFinding>,
  initiallyPlanned: readonly PlannedFinding[],
  dropped: ReadonlySet<EngineFinding>,
  rankedOut: readonly EngineFinding[],
  selectedOriginals: ReadonlySet<EngineFinding>,
  finallyPlannedOriginals: ReadonlySet<EngineFinding>,
): ReadonlySet<string> {
  const plannedOriginals = new Set(initiallyPlanned.map((survivor) => survivor.finding));
  const paths = new Set<string>();
  for (const original of modelOriginals) {
    if (!plannedOriginals.has(original)) paths.add(original.path as string);
  }
  for (const original of dropped) paths.add(original.path as string);
  for (const original of rankedOut) paths.add(original.path as string);
  for (const original of selectedOriginals) {
    if (modelOriginals.has(original) && !finallyPlannedOriginals.has(original)) {
      paths.add(original.path as string);
    }
  }
  return paths;
}

function qualityReplacements(
  substantiated: SubstantiationResult,
  audited: ReadonlyMap<EngineFinding, EngineFinding>,
): ReadonlyMap<EngineFinding, EngineFinding> {
  const combined = new Map<EngineFinding, EngineFinding>(substantiated.repaired);
  for (const [original, classified] of audited) {
    const base = combined.get(original) ?? original;
    combined.set(original, {
      ...base,
      category: classified.category,
      severity: classified.severity,
    });
  }
  return combined;
}

function originalByEffectiveFinding(
  survivors: readonly PlannedFinding[],
  replacements: ReadonlyMap<EngineFinding, EngineFinding>,
): ReadonlyMap<EngineFinding, EngineFinding> {
  return new Map(
    survivors.map((survivor) => [
      replacements.get(survivor.finding) ?? survivor.finding,
      survivor.finding,
    ]),
  );
}

function originalsInPlan(
  survivors: readonly PlannedFinding[],
  originals: ReadonlyMap<EngineFinding, EngineFinding>,
): ReadonlySet<EngineFinding> {
  return new Set(survivors.map((survivor) => originals.get(survivor.finding) ?? survivor.finding));
}

function addPlanCounters(
  initial: PlanCounters,
  final: PlanCounters,
  evidenceSuppressed: number,
  rankedSuppressed: number,
  verificationUndecided: number,
): PlanCounters {
  return {
    suppressed: initial.suppressed + final.suppressed + evidenceSuppressed + rankedSuppressed,
    suppressedIntraRun: (initial.suppressedIntraRun ?? 0) + (final.suppressedIntraRun ?? 0),
    suppressedExactDuplicate: initial.suppressedExactDuplicate + final.suppressedExactDuplicate,
    suppressedSimilar: initial.suppressedSimilar + final.suppressedSimilar,
    suppressedDispositioned: initial.suppressedDispositioned + final.suppressedDispositioned,
    suppressedEvidence: evidenceSuppressed,
    suppressedRanked: rankedSuppressed,
    verificationUndecided,
    suppressedRecurrence: (initial.suppressedRecurrence ?? 0) + (final.suppressedRecurrence ?? 0),
    rejectedSanitization: initial.rejectedSanitization + final.rejectedSanitization,
    // Only the final cohort reaches a reader. Counting the initial pass too would double-count
    // every unchanged survivor merely because quality replacements require a second full plan.
    neutralized: final.neutralized ?? 0,
  };
}

function droppedQualityOriginals(
  substantiated: SubstantiationResult,
  rankedOut: readonly EngineFinding[],
): ReadonlySet<EngineFinding> {
  return new Set([...substantiated.dropped, ...rankedOut]);
}

interface AuditedPlan {
  readonly plan: PublicationPlan;
  readonly survivors: readonly PlannedFinding[];
  readonly qualityByOriginal: ReadonlyMap<EngineFinding, EngineFinding>;
  readonly droppedOriginals: ReadonlySet<EngineFinding>;
  readonly uncacheablePaths: ReadonlySet<string>;
}

/** Internal signal used only to stop publication after the final post-quality head recheck. */
class StaleHeadBeforePublication extends Error {}

function qualityPublicationPlan(
  initialPlan: PublicationPlan,
  finalPlan: PublicationPlan,
  evidenceSuppressed: number,
  rankedSuppressed: number,
  verificationUndecided: number,
): PublicationPlan {
  return {
    ...finalPlan,
    counters: addPlanCounters(
      initialPlan.counters,
      finalPlan.counters,
      evidenceSuppressed,
      rankedSuppressed,
      verificationUndecided,
    ),
  };
}

async function auditSubstantiatedFresh(
  run: PipelineRun,
  fresh: readonly PlannedFinding[],
  substantiated: SubstantiationResult,
): Promise<ReadonlyMap<EngineFinding, EngineFinding>> {
  const survivors = fresh.filter((survivor) => !substantiated.dropped.has(survivor.finding));
  return await auditEffectiveFreshSurvivors(run, survivors, substantiated.repaired);
}

/** The model-bearing middle of `planAndAudit`, split out without changing its cohort or order. */
async function runPublicationQualityStages(
  run: PipelineRun,
  context: PublishContext,
  batch: FindingBatch,
  initialPlan: PublicationPlan,
): Promise<{
  readonly verification: ReturnType<typeof selectVerificationCandidates>;
  readonly substantiated: SubstantiationResult;
  readonly auditedByOriginal: ReadonlyMap<EngineFinding, EngineFinding>;
}> {
  requireReviewTime(run.deadline);
  const verification = selectVerificationCandidates(
    initialPlan.survivors,
    batch.verify,
    run.request.config.maxFindings,
  );
  const modelFindings = verification.kept.filter((survivor) => batch.verify.has(survivor.finding));
  const substantiated = await substantiateModelSurvivors(run, context, modelFindings);
  requireReviewTime(run.deadline);
  const fresh = modelFindings.filter((survivor) => batch.fresh.has(survivor.finding));
  const auditedByOriginal = await auditSubstantiatedFresh(run, fresh, substantiated);
  requireReviewTime(run.deadline);
  return { verification, substantiated, auditedByOriginal };
}

function replanSelectedFindings(
  context: PublishContext,
  selected: readonly PlannedFinding[],
  diagnostics: Diagnostics,
  prefetch: ExistingConversationsPrefetch,
): Promise<PublicationPlan> {
  return planPublication(
    context,
    selected.map((survivor) => survivor.finding),
    diagnostics,
    prefetch,
  );
}

interface FinalizeAuditedPlanInputs {
  readonly batch: FindingBatch;
  readonly initialPlan: PublicationPlan;
  readonly finalPlan: PublicationPlan;
  readonly verification: ReturnType<typeof selectVerificationCandidates>;
  readonly selected: ReturnType<typeof selectPrWideFindings>;
  readonly substantiated: SubstantiationResult;
  readonly combined: ReadonlyMap<EngineFinding, EngineFinding>;
  readonly originals: ReadonlyMap<EngineFinding, EngineFinding>;
}

function finalizeAuditedPlan(inputs: FinalizeAuditedPlanInputs): AuditedPlan {
  const {
    batch,
    initialPlan,
    finalPlan,
    verification,
    selected,
    substantiated,
    combined,
    originals,
  } = inputs;
  const rankedOut = [...verification.rankedOutOriginals, ...selected.rankedOutOriginals];
  const uncacheablePaths = uncacheableModelPaths(
    batch.verify,
    initialPlan.survivors,
    substantiated.dropped,
    rankedOut,
    originalsInPlan(selected.kept, originals),
    originalsInPlan(finalPlan.survivors, originals),
  );
  return {
    plan: qualityPublicationPlan(
      initialPlan,
      finalPlan,
      substantiated.withheld + substantiated.undecided,
      rankedOut.length,
      substantiated.undecided,
    ),
    survivors: finalPlan.survivors,
    qualityByOriginal: combined,
    droppedOriginals: droppedQualityOriginals(substantiated, rankedOut),
    uncacheablePaths,
  };
}

/**
 * Plans publication and runs the classification audit on the plan's fresh survivors — everything
 * both consumers of a settled finding list need before they diverge. `publishAudited` (below) goes
 * on to execute the result against a real pull request; `performLocalReview`'s own local
 * counterpart (further down) stops here and reports the audited survivors directly as data. Extracted
 * so the two cannot drift on what "the audited plan" means — this is the one place a plan's
 * survivors are ever combined with the audit's verdict.
 *
 * Takes the `PipelineRun` slice `auditFreshSurvivors` actually needs, not the full `ReviewRun`:
 * `publishAudited`'s own `ReviewRun` argument satisfies it structurally, and a client-less `LocalRun`
 * satisfies it exactly as well.
 */
async function planAndAudit(
  run: PipelineRun,
  context: PublishContext,
  batch: FindingBatch,
  prefetch?: ExistingConversationsPrefetch,
): Promise<AuditedPlan> {
  requireReviewTime(run.deadline);
  const initialPlan = await planPublication(context, batch.findings, run.diagnostics, prefetch);
  recordPlannedCandidates(run.diagnostics, batch, initialPlan);
  // Substantiation runs FIRST and the order is load-bearing: it can drop a survivor, and auditing a
  // finding this stage is about to remove spends 1-3 model calls on an opinion nobody will read.
  const { verification, substantiated, auditedByOriginal } = await runPublicationQualityStages(
    run,
    context,
    batch,
    initialPlan,
  );
  const combined = qualityReplacements(substantiated, auditedByOriginal);
  const substantiatedSurvivors = verification.kept.filter(
    (survivor) => !substantiated.dropped.has(survivor.finding),
  );
  const selected = selectPrWideFindings(
    substantiatedSurvivors,
    batch.verify,
    run.request.config.maxFindings,
    combined,
  );
  const originals = originalByEffectiveFinding(substantiatedSurvivors, combined);
  const finalPlan = await replanSelectedFindings(
    context,
    selected.kept,
    run.diagnostics,
    initialPlan.prefetch,
  );
  recordRankedCandidates(run.diagnostics, verification, batch, selected, finalPlan);
  requireReviewTime(run.deadline);
  return finalizeAuditedPlan({
    batch,
    initialPlan,
    finalPlan,
    verification,
    selected,
    substantiated,
    combined,
    originals,
  });
}

/**
 * Plans, audits, and executes publication for `findings` in one pass (v0.12.0): `planPublication`
 * decides which findings survive sanitization and dedup, `auditFreshSurvivors` (above) reclassifies
 * whichever of those survivors are fresh engine output, and `executePublication` composes, places,
 * and posts the result — substituted with its audited classification wherever one exists.
 *
 * `batch.fresh` is reference identity against the SAME `EngineFinding` objects this run's
 * settlement produced. That is sound because `mergeHitFindings` (`cache/memoize.ts`) and
 * `planPublication`/`planOne` (`publish/publisher.ts`) never clone a finding — only ever copy the
 * array that holds it — so the objects a plan survivor carries are exactly the ones a caller-built
 * `Set` can be tested against.
 */
async function publishAudited(
  run: ReviewRun,
  context: PublishContext,
  batch: FindingBatch,
  prefetch?: ExistingConversationsPrefetch,
): Promise<AuditedPublication> {
  const { plan, survivors, qualityByOriginal, droppedOriginals, uncacheablePaths } =
    await planAndAudit(run, context, batch, prefetch);
  // Truth, retrieval, falsification, and audit can take long enough for a push to land after the
  // earlier staleness check. This check is intentionally AFTER all of them and immediately before
  // the first write; stale quality work is discarded and never admitted to the cache.
  requireReviewTime(run.deadline);
  if (!(await headIsCurrent(run.request))) {
    run.diagnostics.record("publish.abandoned_stale_head", { headSha: run.request.head });
    throw new StaleHeadBeforePublication();
  }
  requireReviewTime(run.deadline);
  const outcome = await executePublication(context, { ...plan, survivors }, run.diagnostics);
  run.diagnostics.record("publish.pipeline.completed", {
    counts: { published: outcome.published },
  });
  return { outcome, qualityByOriginal, droppedOriginals, uncacheablePaths };
}

/**
 * The list `finalizeCacheStore` should persist for this run's fresh findings (v0.12.0): the final
 * quality-gated form for each survivor, excluding originals the quality stages withheld or ranked
 * out. A separate path-level admission set prevents those omissions from becoming empty or partial
 * per-file verdicts. Findings that require no replacement (the anthropic protocol, no token, or a
 * skipped classification audit) retain their original form.
 *
 * A finding the execute-time marker re-check suppresses AFTER being audited (`publisher.ts`'s
 * `executeOne`, exercised end to end through `publishAudited`) still gets its AUDITED form stored,
 * not its pre-audit one: the suppression fired because the audited category's fingerprint matched an
 * existing, already-published thread, which is only possible if that thread was created under the
 * SAME category value — the fingerprint hashes the category, so a match proves equality, not mere
 * collision. Storing the pre-audit value instead would desync a future replay from that same thread
 * before the current-run verifier sees the cache hit: its first fingerprint check could stop
 * matching the thread it is supposed to suppress and publish a duplicate.
 */
function findingsForStorage(
  findings: readonly EngineFinding[],
  qualityByOriginal: ReadonlyMap<EngineFinding, EngineFinding>,
  droppedOriginals: ReadonlySet<EngineFinding>,
): readonly EngineFinding[] {
  return findings
    .filter((original) => !droppedOriginals.has(original))
    .map((original) => qualityByOriginal.get(original) ?? original);
}

/** Removes cache entries whose replayed path failed this run's publication-quality decision. */
function evictUncacheableHits(
  store: CacheStore,
  memo: MemoContext,
  uncacheablePaths: ReadonlySet<string>,
): CacheStore {
  const keys = new Set<CacheEntry["key"]>();
  for (const path of uncacheablePaths) {
    const hit = memo.hits.get(path);
    if (hit !== undefined) keys.add(hit.key);
  }
  return removeEntriesByKey(store, keys);
}

/**
 * Folds this run's newly-clean-or-found paths into the store to write back. `uncacheablePaths`
 * removes a whole path when this run cannot represent its verdict completely. A replayed hit in
 * that set is physically evicted, never merely left old and untouched; otherwise the same refuted
 * or ranked-out claim would recur on the next run. Surviving hits are promoted only after current-
 * run verification. Admission is
 * caller-controlled: a complete run, or a truncated run restricted to the exact paths whose
 * verdicts survived incompleteness. See `review-cache.ts`'s own doc comment for why any broader
 * admission would silently launder a transient failure into a permanent, confidently-replayed
 * answer.
 */
function finalizeCacheStore(
  request: PipelineRequest,
  inventory: Inventory,
  memo: MemoContext,
  engineFindings: readonly EngineFinding[],
  restrictTo: ReadonlySet<string> | undefined = undefined,
  uncacheablePaths: ReadonlySet<string> = NO_UNCACHEABLE_PATHS,
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
  const eligible = new Set(
    [...memo.eligiblePaths].filter(
      (path) => !uncacheablePaths.has(path) && (restrictTo === undefined || restrictTo.has(path)),
    ),
  );

  const prunedStore = evictUncacheableHits(request.cacheStore, memo, uncacheablePaths);
  const newEntries = buildNewEntries({
    inventory,
    eligiblePaths: eligible,
    hitPaths: memo.hitPaths,
    findings: engineFindings,
    ruleDigest: memo.ruleDigest,
    engineDigest: memo.engineDigest,
    pathSetDigest: memo.pathSetDigest,
    // The SAME map the lookup used (see `NewEntryInputs.contextDigests`): an entry stamped under
    // one context definition and read under another would never match itself.
    ...(memo.contextDigests === undefined ? {} : { contextDigests: memo.contextDigests }),
    config: request.config,
  });
  // This run's own surviving, freshly reverified hits, carried alongside the freshly-built entries
  // so `appendEntries`' existing
  // key-match-and-promote logic (`review-cache.ts`) covers them too — a same-key entry is treated as
  // "freshly confirmed, move to newest" whether it arrived here as newly-reviewed or as a replay.
  // Without this, retention (`RETENTION.maxEntries`, oldest-evicted-first) is ordered by WRITE
  // recency alone: a file reviewed once and replayed from cache on every push since ages out and is
  // evicted exactly as if it had never been touched again, while a file that happens to get a fresh
  // WRITE (any change, anywhere, invalidating its content key) keeps resetting its own clock. Genuine
  // USE recency is what retention is supposed to approximate.
  const touched = [...memo.hits.entries()]
    .filter(([path]) => !uncacheablePaths.has(path))
    .map(([, entry]) => entry);
  if (newEntries.length === 0 && touched.length === 0) {
    return { store: prunedStore, appended: 0 };
  }
  return {
    store: appendEntries(prunedStore, [...newEntries, ...touched], RETENTION),
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
/**
 * The one narrow gap the incomplete-never-clean rule left open: the ENGINE's own verdict was
 * `complete` — every reviewable path really was covered, and `settlement.findings` is real, fully
 * earned model output — degraded publication is a delivery failure on top of a genuinely complete
 * review, not evidence the review itself fell short. Discarding the cache write here meant a single
 * placement rejection or read-back failure on ONE finding cost the ENTIRE review's worth of
 * memoization, and every retry re-paid the full engine spend for ground that was never actually in
 * question — the same "real, already-paid-for work must not be silently lost" principle the
 * `review-cache.ts` module doc states for a truncated run, applied to the one settlement path that
 * had been quietly exempt from it.
 *
 * Reuses the identical happy-path call (`publishSettledFindings`'s own `finalizeCacheStore(...,
 * findingsForStorage(settlement.findings, qualityByOriginal, droppedOriginals))`) rather than
 * threading anything
 * through `settleIncomplete`'s own `covered`/`batch` machinery, which exists for the DIFFERENT
 * truncated-engine-run shape and would re-publish findings this function's caller already attempted.
 */
interface DegradedPublicationInputs {
  readonly run: ReviewRun;
  readonly inventory: Inventory;
  readonly memo: MemoContext;
  readonly publish: PublishOutcome;
  readonly settlement: Extract<Settlement, { status: "complete" }>;
  readonly qualityByOriginal: ReadonlyMap<EngineFinding, EngineFinding>;
  readonly droppedOriginals: ReadonlySet<EngineFinding>;
  readonly uncacheablePaths: ReadonlySet<string>;
}

async function reportDegradedPublication(inputs: DegradedPublicationInputs): Promise<ReviewReport> {
  const {
    run,
    inventory,
    memo,
    publish,
    settlement,
    qualityByOriginal,
    droppedOriginals,
    uncacheablePaths,
  } = inputs;
  const report = await settleIncomplete(
    run,
    inventory,
    {
      reason: "settlement.incomplete.publication_degraded",
      counts: publicationDegradedCounts(publish),
    },
    memo,
  );
  // An undecided verifier did not earn a durable clean/found verdict for the affected files, and
  // the outcome does not identify them narrowly enough to cache the remainder safely. Delivery-only
  // degradation may still retain the independently verified work.
  const finalized =
    (publish.verificationUndecided ?? 0) > 0
      ? undefined
      : finalizeCacheStore(
          run.request,
          inventory,
          memo,
          findingsForStorage(settlement.findings, qualityByOriginal, droppedOriginals),
          undefined,
          uncacheablePaths,
        );
  return {
    ...report,
    publish,
    cacheAppended: finalized?.appended ?? report.cacheAppended,
    ...(finalized === undefined ? {} : { updatedCacheStore: finalized.store }),
  };
}

/**
 * The v0.13.0 staleness recheck's own abandon branch, now called from two points in
 * `publishSettledFindings` (2026-08-06). The original call sits immediately before
 * `publishAudited`, after gate collection (free) and the change-level pass have already run —
 * checking any earlier alone would leave a push that lands DURING those collections free to sail
 * through to publication unchecked. The second, earlier call sits immediately before the
 * change-level pass, and only when that pass is enabled: it is the one collection between
 * settlement and publication that spends real model tokens, and until this check existed a head
 * that moved during the engine's own minutes-long run still paid for a cross-file opinion nobody
 * could ever publish. Every check like this needs its own copy rather than one shared guard: the
 * pull request's head can move at any point across a review that takes minutes end to end. Split
 * out purely for `publishSettledFindings`'s own line budget. `undefined` means the head was still
 * current and the caller should proceed.
 */
async function abandonStalePublish(
  run: ReviewRun,
  inventory: Inventory,
  memo: MemoContext,
  _settlement: Extract<Settlement, { status: "complete" }>,
): Promise<ReviewReport | undefined> {
  const stale = await abandonIfStale(run, inventory, memo);
  if (stale === undefined) return undefined;
  // The engine's own verdict here was already `complete` — every reviewable path was covered, and
  // `settlement.findings` is real, fully earned model output. The head moving between the engine
  // finishing and this check is a fact about the PULL REQUEST, not about the blobs this run
  // actually reviewed: a review-cache entry is keyed by blob content, not by head sha, so what was
  // just paid for stays exactly as replayable as if this run had reached publication. Unaudited
  // (`settlement.findings` directly, not `findingsForStorage`'s audited form) because this path
  // never reaches `publishAudited` at all — there is nothing audited to prefer. Never `merged`,
  // deliberately: gate and change-pass findings derive from more than one file's content and must
  // never enter a store keyed for one, the same rule `publishSettledFindings`'s own caching later
  // in that function already follows for the happy path.
  // The engine findings have not passed the publication-quality gate yet. Persisting them under
  // the current semantics marker would make a later cache hit bypass evidence verification.
  return stale;
}

/**
 * The earlier of `abandonStalePublish`'s two call sites (2026-08-06) — see its doc comment for the
 * pair. Gated on the flag rather than unconditional because the check itself is not free (one
 * `getPullRequest` call per completed settlement), and with the pass dark — its default — there is
 * no spend between this point and the existing pre-`publishAudited` check for it to protect: gate
 * collection costs no model tokens, and a disabled change-level pass costs one boolean. The flag
 * is the same first guard `collectChangePassFindings` applies, so "enabled here" and "willing to
 * spend there" cannot drift apart; the rarer zero-spend configurations behind it (no token, an
 * exhausted budget) cost this check one API call rather than this call site re-deriving their
 * guards. Split out of `publishSettledFindings` for that function's own line budget, exactly like
 * the sibling it wraps.
 */
async function abandonStaleBeforeChangePass(
  run: ReviewRun,
  inventory: Inventory,
  memo: MemoContext,
  settlement: Extract<Settlement, { status: "complete" }>,
): Promise<ReviewReport | undefined> {
  if (run.request.config.crossArtifactPass !== true) return undefined;
  return abandonStalePublish(run, inventory, memo, settlement);
}

/**
 * Only THIS run's model output is eligible for the audit — the engine's own findings plus the
 * change-level pass's, never a cache hit's replayed findings, which `mergeHitFindings` appended
 * without cloning them (see `publishAudited`'s doc comment for why that makes reference identity
 * sound here). Change-pass findings are fresh model output like any other and audit the same way.
 * Shared by `publishSettledFindings` and `completeLocalReport`, which assemble this identically.
 */
function combineSettledFindings(
  settlement: Extract<Settlement, { status: "complete" }>,
  memo: MemoContext,
  gate: readonly EngineFinding[],
  changePass: readonly EngineFinding[],
): {
  readonly merged: readonly EngineFinding[];
  readonly verify: ReadonlySet<EngineFinding>;
  readonly fresh: ReadonlySet<EngineFinding>;
} {
  const modelFindings = mergeHitFindings(settlement.findings, memo.hits);
  const merged = [...modelFindings, ...gate, ...changePass];
  const verify: ReadonlySet<EngineFinding> = new Set([...modelFindings, ...changePass]);
  const fresh: ReadonlySet<EngineFinding> = new Set([...settlement.findings, ...changePass]);
  return { merged, verify, fresh };
}

/** Incomplete counterpart: cache and partial-engine findings are model claims; gates are not. */
function combineIncompleteFindings(
  settlement: Extract<Settlement, { status: "incomplete" }>,
  memo: MemoContext,
  gate: readonly EngineFinding[],
): FindingBatch {
  const modelFindings = mergeHitFindings(settlement.findings, memo.hits);
  return {
    findings: [...modelFindings, ...gate],
    verify: new Set(modelFindings),
    fresh: new Set(settlement.findings),
  };
}

/** Finalizes the cache and report after publication itself completed without degradation. */
function completedPublicationReport(
  run: ReviewRun,
  inventory: Inventory,
  settlement: Extract<Settlement, { status: "complete" }>,
  memo: MemoContext,
  startedAt: number,
  audited: AuditedPublication,
): ReviewReport {
  const { outcome: publish, qualityByOriginal, droppedOriginals, uncacheablePaths } = audited;
  run.diagnostics.record("settlement.complete", {
    headSha: run.request.head,
    durationMs: Date.now() - startedAt,
    counts: { published: publish.published, suppressed: publish.suppressed },
  });
  const finalized = finalizeCacheStore(
    run.request,
    inventory,
    memo,
    findingsForStorage(settlement.findings, qualityByOriginal, droppedOriginals),
    undefined,
    uncacheablePaths,
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

type PublicationStage<T> = { readonly value: T } | { readonly report: ReviewReport };

async function changePassBeforePublication(
  run: ReviewRun,
  inventory: Inventory,
  memo: MemoContext,
  blobCache: BlobTextCache,
): Promise<PublicationStage<readonly EngineFinding[]>> {
  try {
    const value = await collectChangePassFindings(
      run.request,
      run.deadline,
      inventory,
      run.ledger,
      run.diagnostics,
      blobCache,
    );
    return { value };
  } catch (error) {
    if (error instanceof ReviewDeadlineExceeded) {
      return { report: reviewDeadlineReport(run, inventory, memo) };
    }
    throw error;
  }
}

async function auditedPublicationOrReport(
  run: ReviewRun,
  inventory: Inventory,
  memo: MemoContext,
  batch: FindingBatch,
): Promise<PublicationStage<AuditedPublication>> {
  try {
    return {
      value: await publishAudited(run, publishContextFor(run.request, inventory), batch),
    };
  } catch (error) {
    if (error instanceof StaleHeadBeforePublication) {
      return { report: abandonedReport(inventory, memo) };
    }
    if (error instanceof ReviewDeadlineExceeded) {
      return { report: reviewDeadlineReport(run, inventory, memo) };
    }
    throw error;
  }
}

async function publishSettledFindings(
  run: ReviewRun,
  inventory: Inventory,
  settlement: Extract<Settlement, { status: "complete" }>,
  memo: MemoContext,
  startedAt: number,
): Promise<ReviewReport> {
  if (reviewDeadlineExpired(run.deadline)) return reviewDeadlineReport(run, inventory, memo);
  // Shared across both collectors (#33) — see `BlobTextCache`'s own doc comment.
  const blobCache: BlobTextCache = new Map();
  const gate = await collectGateFindings(run.request, inventory, run.diagnostics, blobCache);
  if (reviewDeadlineExpired(run.deadline)) return reviewDeadlineReport(run, inventory, memo);

  const staleBeforeSpend = await abandonStaleBeforeChangePass(run, inventory, memo, settlement);
  if (staleBeforeSpend !== undefined) return staleBeforeSpend;

  const changePass = await changePassBeforePublication(run, inventory, memo, blobCache);
  if ("report" in changePass) return changePass.report;
  const combined = combineSettledFindings(settlement, memo, gate, changePass.value);

  const stale = await abandonStalePublish(run, inventory, memo, settlement);
  if (stale !== undefined) return stale;

  const publication = await auditedPublicationOrReport(run, inventory, memo, {
    findings: combined.merged,
    verify: combined.verify,
    fresh: combined.fresh,
  });
  if ("report" in publication) return publication.report;
  const audited = publication.value;
  const { outcome: publish, qualityByOriginal, droppedOriginals, uncacheablePaths } = audited;

  // A finding the reviewer found but could not publish is a finding the consumer never saw. The
  // engine's own verdict was "complete", so this is the only place that fact can be recorded.
  //
  // The reason names the SETTLEMENT outcome (Keiko-for-Quality#57). It used to carry
  // `publish.finding_rejected_placement`, a publication diagnostic: accurate about where the
  // failure happened, but published in the incomplete notice, where the reader needs to know what
  // it means for their coverage rather than which internal step noticed. The diagnostic keeps its
  // name and its per-attempt breakdown; only the settlement reason moved family.
  if (publicationDegraded(publish)) {
    return reportDegradedPublication({
      run,
      inventory,
      memo,
      publish,
      settlement,
      qualityByOriginal,
      droppedOriginals,
      uncacheablePaths,
    });
  }

  return completedPublicationReport(run, inventory, settlement, memo, startedAt, audited);
}

/** The zero-reviewable-paths shortcut: nothing was ever eligible, so nothing was hit or missed. */
function emptyReviewReport(inventory: Inventory): ReviewReport {
  return {
    outcome: "complete",
    ...inventoryCounts(inventory),
    cacheHits: 0,
    cacheMisses: 0,
    contextInvalidated: 0,
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
  run: ReviewRun,
  inventory: Inventory,
  memo: MemoContext,
): Promise<ReviewReport | undefined> {
  if (await headIsCurrent(run.request)) return undefined;
  run.diagnostics.record("publish.abandoned_stale_head", { headSha: run.request.head });
  return abandonedReport(inventory, memo);
}

/**
 * A generation-free settlement when exact cache entries answer every reviewable path.
 *
 * The empty finding list is deliberate: cached findings are merged later from `memo.hits`, where
 * they enter `FindingBatch.verify` and therefore still pay current Truth/Falsifier. This shortcut
 * skips only engine acquisition/generation; it does not skip any publication-quality stage.
 */
function fullyMemoizedSettlement(
  inventory: Inventory,
  memo: MemoContext,
): Extract<Settlement, { status: "complete" }> | undefined {
  if (
    inventory.reviewablePaths.size === 0 ||
    [...inventory.reviewablePaths].some((path) => !memo.hitPaths.has(path))
  ) {
    return undefined;
  }
  return { status: "complete", mode: "memoized", findings: [] };
}

/**
 * Runs the engine and records the settlement mode, or reports the failure.
 *
 * Returns a `ReviewReport` when the engine itself could not be run — a spawn failure, a timeout, a
 * non-zero exit. There is nothing to publish in that case: no result reached the parser, so there
 * are no findings to carry forward, only the fact that the review did not happen.
 */
async function settleOrReport(
  run: ReviewRun,
  inventory: Inventory,
  memo: MemoContext,
): Promise<Settlement | ReviewReport> {
  const memoized = fullyMemoizedSettlement(inventory, memo);
  if (memoized !== undefined) {
    run.diagnostics.record("settlement.mode.memoized", { headSha: run.request.head });
    return memoized;
  }
  try {
    const settlement = await executeEngine(
      run.request,
      run.deadline,
      inventory,
      memo,
      run.ledger,
      run.diagnostics,
      run.credited,
    );
    run.diagnostics.record(
      settlement.mode === "reconciled" ? "settlement.mode.reconciled" : "settlement.mode.counted",
      { headSha: run.request.head },
    );
    return settlement;
  } catch {
    return settleIncomplete(run, inventory, { reason: "settlement.incomplete.engine_error" }, memo);
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
  const deadline = startReviewDeadline(request.config.reviewTimeoutSeconds);
  // Captured so the cleanup below can ask what this run settled as. A `finally` that only sees
  // the request cannot tell a completed run from an incomplete one, and the notice cleanup's
  // same-head rule turns on exactly that distinction.
  let report: ReviewReport | undefined;
  try {
    report = await performReviewInner(request, diagnostics, ledger, deadline);
    return report;
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
    // Cleanup, not review: resolves this reviewer's own past incomplete-review notices whose target
    // commit is no longer HEAD, so the "every conversation resolved" branch protection AGENTS.md
    // documents (see its "Landing changes here" section) does not force a human to hand-resolve a
    // notice that a later run — this one or an earlier one — already superseded. Deliberately
    // unconditional on the outcome above: whether this run completed, settled incomplete, or was
    // abandoned because a newer head already exists, a THREAD about an OLDER head being outdated is
    // a fact about that thread alone, established by GitHub, not by anything this run decided.
    //
    // Gated on `identityExclusive` (v0.13.0): every OTHER use of `request.identity` in this pipeline
    // is a read-only match against `identity` for suppression/deduplication, where the worst case of
    // a shared, non-exclusive login (the plain-token fallback, `github-actions[bot]`) is a missed
    // suppression — already documented in `action/identity.ts` as "a real weakening," accepted
    // there. Resolving a GitHub thread is a WRITE, and under a shared login this run cannot prove
    // the matching comment was actually authored by ITSELF rather than some other workflow sharing
    // the same fallback identity. Skipping the mutation entirely under a non-exclusive identity
    // costs exactly what every other failure mode of this feature already costs — one more stale
    // thread for the next push, or a human, to resolve by hand — never a wrong resolution.
    if (request.identityExclusive && !reviewDeadlineExpired(deadline)) {
      // `GitHubClient`'s own implementation never throws — every failure inside it, at either the
      // lookup or the mutation, is already caught and folded into a lower resolved count. This
      // `try` is defense in depth, not a hedge against a known gap: `ReviewCommentApi` is an
      // interface, so nothing STRUCTURALLY stops a different implementer (a test double, a future
      // alternative client) from rejecting, and cleanup must not be the thing that turns a
      // genuinely successful review into a failed one just because it ran last, in the same
      // `finally` that reports `run.spend`.
      try {
        const { attempted, resolved } = await request.client.resolveSupersededOwnNotices(
          request.ref,
          request.pullNumber,
          request.identity,
          isIncompleteNoticeBody,
          request.head,
          report?.outcome === "complete",
        );
        // Gated on `attempted`, not `resolved`: a run where every attempt failed (a token missing
        // the mutation permission, say) must still leave a trace distinguishable from a run with
        // nothing to resolve at all — both produced `resolved === 0` before this counted `attempted`.
        if (attempted > 0) {
          diagnostics.record("cleanup.superseded_notices_resolved", {
            headSha: request.head,
            counts: { attempted, resolved },
          });
        }
      } catch {
        // Nothing to report: a failed cleanup pass costs the next push one more stale thread to
        // resolve by hand, never a failed review.
      }
    }
  }
}

/**
 * `resolveReviewPair` wrapped with its own diagnostic: an unfetched commit, or two histories `git
 * merge-base` cannot bridge, is recorded before rethrowing, so an operator can tell this apart
 * from every other cause `run.failed` alone would otherwise collapse it into.
 */
async function resolvePairOrReport(
  ctx: GitContext,
  request: PipelineRequest,
  diagnostics: Diagnostics,
): Promise<ReviewPair> {
  try {
    return await resolveReviewPair(ctx, request.base, request.head);
  } catch (error) {
    diagnostics.record("review_pair.merge_base_unresolved", { headSha: request.head });
    throw error;
  }
}

async function performReviewInner(
  request: ReviewRequest,
  diagnostics: Diagnostics,
  ledger: SpendLedger,
  deadline: ReviewDeadline,
): Promise<ReviewReport> {
  const started = Date.now();
  const run: ReviewRun = { request, ledger, diagnostics, deadline, credited: new Set() };
  diagnostics.record("run.started", { headSha: request.head });

  const ctx = gitContext(request);
  const pair = await resolvePairOrReport(ctx, request, diagnostics);
  diagnostics.record("review_pair.resolved", { headSha: request.head });

  const inventory = await buildInventory(
    ctx,
    request.profile,
    pair,
    request.config.renameDetectionPercent,
    diagnostics,
  );
  if (reviewDeadlineExpired(deadline)) return reviewDeadlineReport(run, inventory);

  // A path the consumer's profile does not describe is a gap in their coverage statement. Reviewing
  // the rest and reporting success would hide it behind an apparently clean run.
  if (inventory.unclassified.length > 0) {
    return settleIncomplete(run, inventory, { reason: "inventory.unclassified_path" });
  }
  if (inventory.reviewablePaths.size === 0) {
    diagnostics.record("settlement.complete", {
      headSha: request.head,
      durationMs: Date.now() - started,
    });
    return emptyReviewReport(inventory);
  }

  const memo = await prepareMemoization(request, inventory, diagnostics);
  if (reviewDeadlineExpired(deadline)) return reviewDeadlineReport(run, inventory, memo);

  // Cheap insurance ahead of the expensive step: the engine run below is minutes long, and the head
  // can move before that spend even starts. This does not replace the post-run check further down,
  // or `settleIncomplete`'s own copy — the head can still move DURING the engine's own run — it only
  // shrinks that race from "the whole engine run" down to the gap between here and publication.
  const preflight = await abandonIfStale(run, inventory, memo);
  if (preflight !== undefined) return preflight;

  const settlement = await settleOrReport(run, inventory, memo);
  if ("outcome" in settlement) return settlement;

  // `settleIncomplete` applies its own staleness guard (see its doc comment), so the incomplete
  // branch does not repeat one here. The complete branch below still needs its own: it publishes
  // real findings directly through `publishSettledFindings`, which never calls `settleIncomplete` on
  // its happy path.
  if (settlement.status === "incomplete") {
    // The deterministic gates cost no model tokens and depend on nothing the engine settlement
    // decided — a coverage gap or a budget overrun says nothing about whether a declared contract
    // pair drifted or a pin desynced, so there is no reason an incomplete run should forgo the one
    // check class that costs it nothing to run. Merged into `findings` only, exactly like the
    // complete path (`publishSettledFindings` below) — never into `fresh`, since a gate finding is
    // deterministic prose this reviewer generated, not model output the classification audit has
    // anything to adjudicate about.
    const gate = await collectGateFindings(run.request, inventory, run.diagnostics);
    return settleIncomplete(
      run,
      inventory,
      // The settlement's own counts, not just its code (2026-08-06): `settle()` measures
      // reviewed/expected/gap precisely so an operator can tell one failed file from a dead run,
      // and this call site was where those numbers silently fell out of the log line.
      { reason: settlement.reason, counts: settlement.counts },
      memo,
      combineIncompleteFindings(settlement, memo, gate),
      verdictsSurviveIncompleteness(settlement.reason) ? settlement.coveredPaths : undefined,
    );
  }
  // The staleness recheck for THIS branch lives inside `publishSettledFindings` itself now (v0.13.0)
  // — immediately before the one call it actually protects, `publishAudited`, rather than here. Gate
  // and change-pass collection sit between this point and that call, and neither is free: the
  // change-level pass spends real model tokens. Checking here caught the head moving before this
  // function was ENTERED, but a push landing during gate/change-pass collection itself sailed
  // through unchecked all the way to publication — a real, if narrow, gap the move closes without
  // changing what the check itself does.
  return publishSettledFindings(run, inventory, settlement, memo, started);
}

/* ---------------------------------------------------------------------------------------------
 * performLocalReview (issue #95): the publication-free decomposition of the pipeline above.
 *
 * Every stage through the classification audit is a call into a function this file already uses
 * for `performReview` — inventory, the review-cache lookup, the engine (allotment, proxy, resume),
 * classification repair, `settle`, the deterministic contract gate, the change-level pass, and
 * `planPublication`/`auditFreshSurvivors` (by way of `planAndAudit`, above) for dedup, sanitization,
 * and the classification audit. What stops here, and only here, is the publish EXECUTE step: no
 * `executePublication`, no `publishIncompleteNotice`, no review-cache write-back, and no
 * `headIsCurrent` call — none of which a local run can make, because none of it holds a pull
 * request to check, publish to, or memoize against. There is no second pipeline: every difference
 * from `performReview` below is the absence of a GitHub-specific step, never a reimplementation of
 * one this file already has.
 * ------------------------------------------------------------------------------------------- */

/**
 * Inert placeholders for the three `PublishContext` fields a local run has no real value for
 * (`client` itself is simply omitted — see `publisher.ts`'s now-optional field). All three ever do
 * downstream is feed the exact-marker fingerprint `planCrossRun` (`publisher.ts`) computes per
 * candidate and checks against `EMPTY_PREFETCH` below — an always-empty existing-conversation set no
 * fingerprint can ever match — so their exact values never surface in a `LocalReviewReport`.
 */
const LOCAL_REF: RepoRef = { owner: "local", repo: "local" };
const LOCAL_PULL_NUMBER = 0;
const LOCAL_IDENTITY = "local-review";

/**
 * The existing-thread-based dedup input a real pull request would supply, made an explicit empty
 * value instead of a stubbed client (per issue #95's own framing): no thread exists to fetch,
 * because no pull request exists. Passed to `planPublication` on every local call so its own
 * default-fetch fallback (`prefetch ?? prefetchExistingConversations(context)`) never runs, and
 * `context.client` is therefore never dereferenced at all.
 */
const EMPTY_PREFETCH: ExistingConversationsPrefetch = { markers: new Set(), threads: [] };

/** The one `PublishContext` shape a local run needs for `planAndAudit` — client-less, built from
 *  the same `items` derivation `publishContextFor` (above) uses for the action path. */
function localPublishContext(request: PipelineRequest, inventory: Inventory): PublishContext {
  return {
    ref: LOCAL_REF,
    pullNumber: LOCAL_PULL_NUMBER,
    baseSha: inventory.pair.mergeBase,
    headSha: request.head,
    identity: LOCAL_IDENTITY,
    items: itemIndex(inventory),
  };
}

/** One post-audit `PlannedFinding` as `LocalReviewReport.findings` reports it. `category`/`severity`
 *  are omitted, never set to `undefined`, when the finding stayed unclassified — see
 *  `LocalReviewFinding`'s own doc comment for why the key's presence, not just its value, matters
 *  under `exactOptionalPropertyTypes`. */
function toLocalFinding(survivor: PlannedFinding): LocalReviewFinding {
  const { category, severity } = survivor.finding;
  return {
    path: survivor.finding.path as string,
    startLine: survivor.finding.startLine,
    endLine: survivor.finding.endLine,
    ...(category === undefined ? {} : { category }),
    ...(severity === undefined ? {} : { severity }),
    body: survivor.sanitizedBody,
  };
}

function localSpend(ledger: SpendLedger): LocalReviewReport["spend"] {
  return {
    engine: ledger.engine,
    classify: ledger.classify,
    total: ledger.engine + ledger.classify,
    allotted: ledger.allotted,
  };
}

/**
 * Plans and audits `findings` exactly like the action path's `publishAudited`, but stops before a
 * single comment is composed, placed, or posted. A no-op when there is nothing to plan, so an
 * incomplete settlement with no findings costs nothing beyond its own bookkeeping.
 */
async function localFindings(
  run: LocalRun,
  inventory: Inventory,
  batch: FindingBatch,
): Promise<{
  readonly findings: readonly LocalReviewFinding[];
  readonly qualityByOriginal: ReadonlyMap<EngineFinding, EngineFinding>;
  readonly droppedOriginals: ReadonlySet<EngineFinding>;
  readonly uncacheablePaths: ReadonlySet<string>;
  readonly evidenceWithheld: number;
  readonly rankedOut: number;
  readonly verificationUndecided: number;
}> {
  if (batch.findings.length === 0) {
    return {
      findings: [],
      qualityByOriginal: NO_AUDITED,
      droppedOriginals: new Set(),
      uncacheablePaths: NO_UNCACHEABLE_PATHS,
      evidenceWithheld: 0,
      rankedOut: 0,
      verificationUndecided: 0,
    };
  }
  const context = localPublishContext(run.request, inventory);
  const { plan, survivors, qualityByOriginal, droppedOriginals, uncacheablePaths } =
    await planAndAudit(run, context, batch, EMPTY_PREFETCH);
  return {
    findings: survivors.map(toLocalFinding),
    qualityByOriginal,
    droppedOriginals,
    uncacheablePaths,
    evidenceWithheld: plan.counters.suppressedEvidence ?? 0,
    rankedOut: plan.counters.suppressedRanked ?? 0,
    verificationUndecided: plan.counters.verificationUndecided ?? 0,
  };
}

type ReportedLocalFindings = Awaited<ReturnType<typeof localFindings>>;

function localQuality(reported: ReportedLocalFindings): NonNullable<LocalReviewReport["quality"]> {
  return {
    evidenceWithheld: reported.evidenceWithheld,
    rankedOut: reported.rankedOut,
    verificationUndecided: reported.verificationUndecided,
  };
}

/** The zero-reviewable-paths shortcut, mirroring `emptyReviewReport` above. */
function emptyLocalReport(
  inventory: Inventory,
  ruleDigest: string,
  engineVersion: string,
): LocalReviewReport {
  return {
    outcome: "complete",
    findings: [],
    spend: { engine: 0, classify: 0, total: 0, allotted: 0 },
    inventory: { total: inventory.items.length, reviewable: 0, reviewed: 0 },
    ruleDigest,
    engineVersion,
    cacheHits: 0,
    cacheMisses: 0,
  };
}

/** Local fail-closed counterpart to `reviewDeadlineReport`, with no post-deadline planning calls. */
function localReviewDeadlineReport(
  run: LocalRun,
  inventory: Inventory,
  memo?: MemoContext,
): LocalReviewReport {
  run.diagnostics.record("engine.run.timeout", { headSha: run.request.head });
  run.diagnostics.record("settlement.incomplete.engine_error", {
    headSha: run.request.head,
    counts: { review_timeout: 1 },
  });
  return {
    outcome: "incomplete",
    reason: "settlement.incomplete.engine_error",
    findings: [],
    spend: localSpend(run.ledger),
    inventory: {
      total: inventory.items.length,
      reviewable: inventory.reviewablePaths.size,
      reviewed: (memo?.hitPaths.size ?? 0) + run.credited.size,
    },
    ruleDigest: run.ruleDigest,
    engineVersion: run.engineVersion,
    ...(memo === undefined ? { cacheHits: 0, cacheMisses: 0 } : localCacheCounts(memo)),
  };
}

/**
 * Local counterpart to `settleIncomplete`: reports an incomplete outcome as data, with none of that
 * function's publish-side effects — no staleness check (there is no pull request to go stale), no
 * incomplete-notice comment, no findings comment. What a pull request review would have published is
 * still planned and audited through `localFindings`, so a caller sees the same finding quality a
 * reader would have, never a raw, unaudited engine dump.
 *
 * @param reviewed Reviewable paths this run holds a trustworthy verdict for. Every call site
 *   computes it from the same facts `verdictsSurviveIncompleteness` and the review-cache hits
 *   already carry — never guessed here.
 */
async function localIncompleteReport(
  run: LocalRun,
  inventory: Inventory,
  reason: ReasonCode,
  batch: FindingBatch,
  reviewed: number,
  memo?: MemoContext,
  counts?: Readonly<Record<string, number>>,
): Promise<LocalReviewReport> {
  if (reviewDeadlineExpired(run.deadline)) {
    return localReviewDeadlineReport(run, inventory, memo);
  }
  // The settlement's measured counts, same as the action path (2026-08-06): the CLI diagnostic
  // stream is the only log a local run has, and a bare reason there answered nothing.
  run.diagnostics.record(reason, {
    headSha: run.request.head,
    ...(counts !== undefined ? { counts } : {}),
  });
  const reported = await localFindings(run, inventory, batch);
  return {
    outcome: "incomplete",
    reason,
    findings: reported.findings,
    quality: localQuality(reported),
    spend: localSpend(run.ledger),
    inventory: {
      total: inventory.items.length,
      reviewable: inventory.reviewablePaths.size,
      reviewed,
    },
    ruleDigest: run.ruleDigest,
    engineVersion: run.engineVersion,
    // An incomplete outcome never writes a store back (`finalizeCacheStore`'s admission rule), but
    // the hit/miss counts are facts about what was attempted, memo or not.
    ...(memo === undefined ? { cacheHits: 0, cacheMisses: 0 } : localCacheCounts(memo)),
  };
}

/**
 * Local counterpart to `settleOrReport`: runs the engine and returns the settlement, or reports the
 * failure as an incomplete `LocalReviewReport` directly — never through `settleIncomplete`, which
 * publishes. Same reason code as the action path for the identical failure: `executeEngine` itself
 * is untouched, so a spawn failure, a timeout, or an exhausted resume all fail the same way here as
 * they do there.
 */
async function localSettleOrReport(
  run: LocalRun,
  inventory: Inventory,
  memo: MemoContext,
): Promise<Settlement | LocalReviewReport> {
  const memoized = fullyMemoizedSettlement(inventory, memo);
  if (memoized !== undefined) {
    run.diagnostics.record("settlement.mode.memoized", { headSha: run.request.head });
    return memoized;
  }
  try {
    const settlement = await executeEngine(
      run.request,
      run.deadline,
      inventory,
      memo,
      run.ledger,
      run.diagnostics,
      run.credited,
    );
    run.diagnostics.record(
      settlement.mode === "reconciled" ? "settlement.mode.reconciled" : "settlement.mode.counted",
      { headSha: run.request.head },
    );
    return settlement;
  } catch (error) {
    if (error instanceof ReviewDeadlineExceeded || reviewDeadlineExpired(run.deadline)) {
      return localReviewDeadlineReport(run, inventory, memo);
    }
    return localIncompleteReport(
      run,
      inventory,
      "settlement.incomplete.engine_error",
      EMPTY_BATCH,
      memo.hitPaths.size,
      memo,
    );
  }
}

function verificationIncompleteLocalReport(
  run: LocalRun,
  inventory: Inventory,
  memo: MemoContext,
  reported: ReportedLocalFindings,
): LocalReviewReport {
  const reason = "settlement.incomplete.publication_degraded";
  run.diagnostics.record(reason, {
    headSha: run.request.head,
    counts: {
      verification_undecided: reported.verificationUndecided,
      suppressed_evidence: reported.evidenceWithheld,
      suppressed_ranked: reported.rankedOut,
    },
  });
  return {
    outcome: "incomplete",
    reason,
    findings: reported.findings,
    quality: localQuality(reported),
    spend: localSpend(run.ledger),
    inventory: {
      total: inventory.items.length,
      reviewable: inventory.reviewablePaths.size,
      reviewed: inventory.reviewablePaths.size,
    },
    ruleDigest: run.ruleDigest,
    engineVersion: run.engineVersion,
    ...localCacheCounts(memo),
  };
}

function verifiedCompleteLocalReport(
  run: LocalRun,
  inventory: Inventory,
  settlement: Extract<Settlement, { status: "complete" }>,
  memo: MemoContext,
  reported: ReportedLocalFindings,
): LocalReviewReport {
  const finalized = finalizeCacheStore(
    run.request,
    inventory,
    memo,
    findingsForStorage(settlement.findings, reported.qualityByOriginal, reported.droppedOriginals),
    undefined,
    reported.uncacheablePaths,
  );
  return {
    outcome: "complete",
    findings: reported.findings,
    quality: localQuality(reported),
    spend: localSpend(run.ledger),
    inventory: {
      total: inventory.items.length,
      reviewable: inventory.reviewablePaths.size,
      reviewed: inventory.reviewablePaths.size,
    },
    ruleDigest: run.ruleDigest,
    engineVersion: run.engineVersion,
    ...localCacheCounts(memo),
    ...(finalized === undefined ? {} : { updatedCacheStore: finalized.store }),
  };
}

/**
 * Local counterpart to `publishSettledFindings`: assembles the identical merged finding list —
 * engine settlement plus cache hits, the deterministic contract gate, and the change-level pass —
 * and plans and audits it exactly like the action path, but returns the result as data instead of
 * publishing it.
 */
async function completeLocalReport(
  run: LocalRun,
  inventory: Inventory,
  settlement: Extract<Settlement, { status: "complete" }>,
  memo: MemoContext,
): Promise<LocalReviewReport> {
  if (reviewDeadlineExpired(run.deadline)) return localReviewDeadlineReport(run, inventory, memo);
  // Shared across both collectors (#33) — same reasoning as `publishSettledFindings`'s identical
  // pairing.
  const blobCache: BlobTextCache = new Map();
  const gate = await collectGateFindings(run.request, inventory, run.diagnostics, blobCache);
  let changePass: readonly EngineFinding[];
  try {
    changePass = await collectChangePassFindings(
      run.request,
      run.deadline,
      inventory,
      run.ledger,
      run.diagnostics,
      blobCache,
    );
  } catch (error) {
    if (error instanceof ReviewDeadlineExceeded) {
      return localReviewDeadlineReport(run, inventory, memo);
    }
    throw error;
  }
  const combined = combineSettledFindings(settlement, memo, gate, changePass);

  let reported: ReportedLocalFindings;
  try {
    reported = await localFindings(run, inventory, {
      findings: combined.merged,
      verify: combined.verify,
      fresh: combined.fresh,
    });
  } catch (error) {
    if (error instanceof ReviewDeadlineExceeded) {
      return localReviewDeadlineReport(run, inventory, memo);
    }
    throw error;
  }
  if (reported.verificationUndecided > 0) {
    return verificationIncompleteLocalReport(run, inventory, memo, reported);
  }
  // Identical admission call to the action path's: only a complete outcome reaches this function,
  // and what is stored is the AUDITED form of the engine's own findings (never a gate or
  // change-pass finding — `finalizeCacheStore` receives the settlement's findings only, exactly as
  // `publishSettledFindings` passes them).
  return verifiedCompleteLocalReport(run, inventory, settlement, memo, reported);
}

/** The pre-engine short-circuits `performLocalReviewInner` shares with `performReviewInner`: an
 *  undescribed path fails the run, an empty reviewable set needs no engine at all. `undefined` means
 *  neither fired and the caller should proceed to memoization and the engine. */
async function localPreEngineReport(
  run: LocalRun,
  inventory: Inventory,
  started: number,
): Promise<LocalReviewReport | undefined> {
  if (reviewDeadlineExpired(run.deadline)) return localReviewDeadlineReport(run, inventory);
  if (inventory.unclassified.length > 0) {
    return localIncompleteReport(run, inventory, "inventory.unclassified_path", EMPTY_BATCH, 0);
  }
  if (inventory.reviewablePaths.size === 0) {
    run.diagnostics.record("settlement.complete", {
      headSha: run.request.head,
      durationMs: Date.now() - started,
    });
    return emptyLocalReport(inventory, run.ruleDigest, run.engineVersion);
  }
  return undefined;
}

/** `run.started` through `buildInventory` — identical to `performReviewInner`'s own opening, split
 *  out so `performLocalReviewInner` stays within this file's per-function line budget. */
async function localResolveInventory(run: LocalRun): Promise<Inventory> {
  run.diagnostics.record("run.started", { headSha: run.request.head });
  const ctx = gitContext(run.request);
  const pair = await resolvePairOrReport(ctx, run.request, run.diagnostics);
  run.diagnostics.record("review_pair.resolved", { headSha: run.request.head });
  return buildInventory(
    ctx,
    run.request.profile,
    pair,
    run.request.config.renameDetectionPercent,
    run.diagnostics,
  );
}

/**
 * Everything after a settlement is in hand: routes an incomplete settlement to
 * `localIncompleteReport` with the right `reviewed` count, or a complete one to
 * `completeLocalReport` followed by the same `settlement.complete` diagnostic the empty-inventory
 * shortcut records. Split out of `performLocalReviewInner` for the same line-budget reason as
 * `localResolveInventory` above.
 */
async function localSettleReport(
  run: LocalRun,
  inventory: Inventory,
  settlement: Settlement,
  memo: MemoContext,
  started: number,
): Promise<LocalReviewReport> {
  if (reviewDeadlineExpired(run.deadline)) return localReviewDeadlineReport(run, inventory, memo);
  if (settlement.status === "incomplete") {
    const reviewed = verdictsSurviveIncompleteness(settlement.reason)
      ? settlement.coveredPaths.size + memo.hitPaths.size + run.credited.size
      : memo.hitPaths.size + run.credited.size;
    // Same reasoning as `performReviewInner`'s identical branch: the deterministic gates cost no
    // model tokens and depend on nothing the engine settlement decided, so an incomplete run still
    // gets their coverage. Merged into `findings` only, never `fresh`.
    const gate = await collectGateFindings(run.request, inventory, run.diagnostics);
    return localIncompleteReport(
      run,
      inventory,
      settlement.reason,
      combineIncompleteFindings(settlement, memo, gate),
      reviewed,
      memo,
      settlement.counts,
    );
  }

  const report = await completeLocalReport(run, inventory, settlement, memo);
  run.diagnostics.record("settlement.complete", {
    headSha: run.request.head,
    durationMs: Date.now() - started,
  });
  return report;
}

async function performLocalReviewInner(run: LocalRun): Promise<LocalReviewReport> {
  const started = Date.now();
  const inventory = await localResolveInventory(run);

  const preEngine = await localPreEngineReport(run, inventory, started);
  if (preEngine !== undefined) return preEngine;

  const memo = await prepareMemoization(run.request, inventory, run.diagnostics);
  if (reviewDeadlineExpired(run.deadline)) return localReviewDeadlineReport(run, inventory, memo);
  const settlement = await localSettleOrReport(run, inventory, memo);
  if ("outcome" in settlement) return settlement;

  return localSettleReport(run, inventory, settlement, memo, started);
}

/**
 * Runs the qualified review pipeline against a local repository — no `GitHubClient`, no pull
 * request, no reviewer identity to author comments as — and returns findings as data instead of
 * publishing them.
 *
 * Mirrors `performReview`'s own shape (issue #95's acceptance criteria; both share the same
 * `diagnostics`-argument style and the same per-run `SpendLedger`, created once here and recorded to
 * `run.spend` in `finally` under the identical "only if something was actually spent" guard
 * `performReview` uses — see its own doc comment for why). What differs is scope, never pipeline
 * behaviour: this function stops after the classification audit and reports the result, so it and
 * `performReview` cannot drift on inventory, engine execution, classification, or dedup and
 * sanitization — only on what happens with the answer once it is ready.
 */
export async function performLocalReview(
  request: LocalReviewRequest,
  diagnostics: Diagnostics,
): Promise<LocalReviewReport> {
  const ledger: SpendLedger = { allotted: 0, engine: 0, classify: 0 };
  const deadline = startReviewDeadline(request.config.reviewTimeoutSeconds);
  const ruleDigest: string = promptIdentityDigest(request.profile, request.guidelines);
  const engineVersion: string = ENGINE_PIN.version;
  try {
    return await performLocalReviewInner({
      request,
      ledger,
      diagnostics,
      deadline,
      ruleDigest,
      engineVersion,
      credited: new Set(),
    });
  } finally {
    // Identical guard to `performReview`'s own `finally` block: a pre-engine incomplete report or an
    // empty-inventory run never dispatched the engine at all, and a zero-spend `run.spend` line
    // would misreport a run that never tried to review anything as one that reviewed it for free.
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
