import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import {
  SUPPORTED_STORE_SCHEMA,
  GENERATION_CHECKPOINT_SEMANTICS,
  entriesUnderSupportedSemantics,
  readStore,
  serializeStore,
  type CacheStore,
} from "../cache/review-cache.js";
import { parseGuidelinePaths, type GuidelineIndex } from "../config/guidelines.js";
import { loadReviewProfile, type CompiledProfile } from "../config/profile.js";
import type { RuntimeConfig } from "../config/runtime.js";
import { createDiagnostics, type Diagnostics } from "../diagnostics/sink.js";
import { parseJson } from "../core/validate.js";
import { ENGINE_PIN } from "../engine/pinned-release.js";
import { verdictsSurviveIncompleteness } from "../engine/settle.js";
import { maintainRunSummary } from "../publish/summary.js";
import { performReview, type ReviewReport, type ReviewRequest } from "../review.js";
import { evaluateEligibility } from "./eligibility.js";
import { resolveIdentity, type ResolvedIdentity } from "./identity.js";
import {
  parseEventContext,
  readBooleanInput,
  readInput,
  readRequiredInput,
  runtimeConfigFromInputs,
  writeOutputs,
  type EventContext,
} from "./inputs.js";

const DEFAULT_API_BASE = "https://api.github.com";
const EMPTY_STORE: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };

function targetBranches(env: NodeJS.ProcessEnv): string[] {
  const raw = readInput(env, "target_branches");
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return parsed.length > 0 ? parsed : ["dev"];
}

async function loadEvent(env: NodeJS.ProcessEnv): Promise<EventContext> {
  const path = env.GITHUB_EVENT_PATH;
  if (path === undefined || path === "") throw new Error("missing event payload");
  const payload = parseJson(await readFile(path, "utf8"), "event");
  return parseEventContext(payload);
}

function reportOutputs(
  report: ReviewReport,
  summaryCommentUrl: string | undefined,
  storeWritten: boolean,
): Record<string, string> {
  return {
    outcome: report.outcome,
    reason: report.reason ?? "",
    inventory_size: String(report.inventorySize),
    findings_published: String(report.publish?.published ?? 0),
    findings_suppressed: String(report.publish?.suppressed ?? 0),
    cache_hits: String(report.cacheHits),
    checkpoint_hits: String(report.checkpointHits),
    cache_misses: String(report.cacheMisses),
    // Isolates the one cache miss reason that costs nothing to fix from the ordinary kind: a file
    // whose own bytes never changed, denied replay only because the pull request's reviewable-path
    // set moved since the entry was written (see `ReviewReport.contextInvalidated`, review.ts).
    cache_context_invalidated: String(report.contextInvalidated),
    // Whether this run left a store behind, decided by the same rule that governs the write
    // rather than restated by the caller. A consumer needs it because "did you persist" is not
    // "did you settle complete": since #75 a budget-truncated run persists the verdicts it
    // earned, and a consumer gating its hand-off on the outcome alone would strand exactly that
    // store on the runner — which is the whole cost the fix exists to remove.
    store_written: storeWritten ? "true" : "false",
    summary_comment_url: summaryCommentUrl ?? "",
  };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Reads the review-cache store the action layer owns, before the review runs.
 *
 * `review_store_path` names a file inside the workflow's own restored Actions cache, not a path in
 * the reviewed repository — the store never passes through `repoPath`, and nothing here reads it
 * from the candidate checkout. A missing file (an ordinary first run, before anything was ever
 * saved) and a present-but-rejected one are recorded differently on purpose: only the second is a
 * `cache.store_rejected` — an absence is not a rejection — but both proceed identically, as an
 * empty store. Memoization is a pure optimization layer, so its own failure to load never gates the
 * review that follows; it only costs this run whatever re-review the missing hits would have saved.
 */
async function loadCacheStore(path: string, diagnostics: Diagnostics): Promise<CacheStore> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      diagnostics.record("cache.store_loaded", { counts: { entries: 0 } });
      return EMPTY_STORE;
    }
    diagnostics.record("cache.store_rejected");
    return EMPTY_STORE;
  }

  const result = readStore(text);
  if (!result.ok) {
    // The rejection's own five-way reason, not the bare umbrella code (2026-08-06): an oversized
    // store, corrupt JSON, a schema bump, and an entry overflow each demand a different operator
    // response, and `readStore` already computed which one this is.
    diagnostics.record(result.reason);
    return EMPTY_STORE;
  }
  // A structurally valid store may still hold entries a different publication contract wrote; those
  // drop out here rather than at parse time, because they are not a corrupt store and must not be
  // reported as one. Both counts are recorded: `entries` is what this build may replay, `retired` is
  // what a release cost, which is the number that tells an operator whether a version bump — rather
  // than the pull request's own churn — explains a cold run.
  const usable = entriesUnderSupportedSemantics(result.store);
  const retired = result.store.entries.length - usable.entries.length;
  const checkpoints = usable.entries.filter(
    (entry) => entry.semantics === GENERATION_CHECKPOINT_SEMANTICS,
  ).length;
  diagnostics.record("cache.store_loaded", {
    counts: { entries: usable.entries.length, checkpoints, retired },
  });
  return usable;
}

/**
 * Writes a complete store to a sibling file and atomically replaces the visible path. Checkpoints
 * happen while model work is still running, so an OS-level cancellation must leave either the old
 * valid store or the new valid store — never half JSON. A write failure is fail-open in the same
 * direction as a read failure: it costs re-review budget, never changes settlement semantics.
 */
async function saveCacheStore(
  path: string,
  store: CacheStore,
  appended: number,
  diagnostics: Diagnostics,
  checkpoint = false,
): Promise<boolean> {
  const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  try {
    await writeFile(temporary, serializeStore(store), "utf8");
    await rename(temporary, path);
    diagnostics.record(checkpoint ? "cache.checkpoint_saved" : "cache.appended", {
      counts: { entries: appended },
    });
    return true;
  } catch {
    // Swallowing the error is right — a store this run cannot write is a lost optimization, not a
    // reason to fail a review that already published. Swallowing the OUTCOME is not: the caller
    // reports `store_written`, and a consumer that believes it will try to hand off a file that
    // is not there.
    diagnostics.record("cache.store_write_failed");
    return false;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Which runs may write back — checked here too, independent of whatever `performReview` itself
 * guarantees, because a store write is irreversible in a way a diagnostic is not: a cache entry
 * for a file this repository never actually reviewed would be replayed later with confidence it
 * never earned.
 *
 * A complete settlement always may. An incomplete one may only when its reason leaves the
 * reviewed files' verdicts intact — a budget overrun or a coverage gap, where the engine simply
 * did not reach every file — and never for a rejected schema, a bad terminal state, or an engine
 * execution failure, where the manifest itself is not to be believed. `performReview`
 * enforces the same rule one layer up by supplying a store only in those cases, and restricts its
 * entries to the paths the engine reports it reached; this check is the independent second one.
 *
 * Without it a large pull request could never converge: every push exceeded the budget, settled
 * incomplete, persisted nothing, and re-priced every file from scratch (Keiko-for-Quality#75).
 *
 * `abandoned` (v0.13.0) joins the allowed set for the identical reason: `performReview`'s own
 * post-publish staleness check now populates `updatedCacheStore` on that outcome too, and only for
 * the one case where doing so is sound — the ENGINE's verdict was already `complete` before the
 * pull request's head moved out from under it, and a review-cache entry is keyed by blob content,
 * not by head sha, so what was reviewed stays exactly as replayable as it would from a `complete`
 * report. The check above this one is what makes trusting the outcome here safe: the PRE-flight
 * abandon (before the engine ever runs) never attaches `updatedCacheStore` at all, so an `abandoned`
 * report reaches this branch only in the one case `performReview` deliberately allowed.
 */
async function maybeSaveCacheStore(
  storePath: string,
  report: ReviewReport,
  diagnostics: Diagnostics,
): Promise<boolean> {
  if (storePath === "" || report.updatedCacheStore === undefined) return false;
  // `ReviewOutcome` is exactly `"complete" | "incomplete" | "abandoned"` — once "incomplete" is
  // excluded below, both remaining outcomes are already in the allowed set the doc comment above
  // describes, so there is nothing further to reject here.
  if (report.outcome === "incomplete") {
    // An incomplete report without a reason cannot be argued into the allowed set, so it is not.
    if (report.reason === undefined || !verdictsSurviveIncompleteness(report.reason)) return false;
  }
  return await saveCacheStore(
    storePath,
    report.updatedCacheStore,
    report.cacheAppended,
    diagnostics,
  );
}

/**
 * Maintains the run-summary comment (Keiko-for-Quality#31), gated by the `run_summary` input
 * documented in `action.yml` (default on). Disabled means exactly that: no issue-comment API call is
 * made at all — not even a listing call — so the only trace of the switch being off is the
 * diagnostic recorded here.
 *
 * Reached for every settlement outcome (`complete`, `incomplete`, `abandoned`) alike, because it
 * runs after `performReview` has already returned — the same eligibility gate in `admit` that
 * decides whether findings can be published at all also decides, for free, whether this is ever
 * reached: an ineligible event returns from `runAction` before `performReview` runs.
 */
async function maybeMaintainSummary(
  env: NodeJS.ProcessEnv,
  event: EventContext,
  identity: ResolvedIdentity,
  report: ReviewReport,
  durationMs: number,
  diagnostics: Diagnostics,
): Promise<string | undefined> {
  if (!readBooleanInput(env, "run_summary", true)) {
    diagnostics.record("publish.summary_disabled");
    return undefined;
  }
  return maintainRunSummary(
    {
      client: identity.client,
      ref: { owner: event.owner, repo: event.repo },
      pullNumber: event.pullNumber,
      identity: identity.login,
    },
    {
      report,
      headSha: event.head,
      eventTimestamp: event.eventTimestamp,
      engineVersion: ENGINE_PIN.version,
      // Set by Actions for a step that `uses:` a JS action — the exact ref/SHA the consumer's own
      // workflow pinned this run to. Empty outside Actions (a local invocation, a test).
      actionVersion: env.GITHUB_ACTION_REF ?? "",
      durationMs,
    },
    diagnostics,
  );
}

/**
 * Assembles the one `ReviewRequest` `performReview` needs, from everything `runAction` has already
 * resolved. Pulled out on its own so `runAction` stays a readable sequence of steps rather than one
 * function carrying both that assembly and the orchestration around it — the object itself is
 * unchanged by the split.
 */
function buildReviewRequest(
  event: EventContext,
  identity: ResolvedIdentity,
  config: RuntimeConfig,
  profile: CompiledProfile,
  guidelines: GuidelineIndex,
  env: NodeJS.ProcessEnv,
  cacheStore: CacheStore | undefined,
  persistGenerationCheckpoint?: (store: CacheStore, appended: number) => Promise<void>,
): ReviewRequest {
  return {
    client: identity.client,
    ref: { owner: event.owner, repo: event.repo },
    pullNumber: event.pullNumber,
    base: event.base,
    head: event.head,
    repositoryPath: env.GITHUB_WORKSPACE ?? process.cwd(),
    config,
    profile,
    guidelines,
    identity: identity.login,
    identityExclusive: identity.exclusive,
    env,
    pathValue: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    // Omitted rather than passed empty when the payload stated no purpose: under
    // `exactOptionalPropertyTypes` the key is absent or a string, and an absent one leaves every
    // model request byte-identical to what the previous release sent.
    ...(event.changeIntent === "" ? {} : { changeIntent: event.changeIntent }),
    ...(cacheStore === undefined ? {} : { cacheStore }),
    ...(persistGenerationCheckpoint === undefined ? {} : { persistGenerationCheckpoint }),
  };
}

/** Decides eligibility and records the outcome. Returns false when the run should stop here. */
function admit(env: NodeJS.ProcessEnv, event: EventContext, diagnostics: Diagnostics): boolean {
  const eligibility = evaluateEligibility(
    {
      eventName: env.GITHUB_EVENT_NAME ?? "",
      action: event.action,
      draft: event.draft,
      headRepoFullName: event.headRepoFullName,
      baseRepoFullName: `${event.owner}/${event.repo}`,
      baseRef: event.baseRef,
      previousBaseRef: event.previousBaseRef,
    },
    targetBranches(env),
  );
  if (!eligibility.eligible) {
    // Recorded rather than silently filtered: "said nothing" and "chose not to look" are very
    // different facts for anyone deciding whether this pull request has been reviewed.
    diagnostics.record(eligibility.reason, { headSha: event.head });
    writeOutputs(env, { outcome: "skipped", reason: eligibility.reason });
    return false;
  }
  diagnostics.record("eligibility.accepted", { headSha: event.head });
  return true;
}

/**
 * Resolves this run's posting identity, recording a distinguishing diagnostic on failure — mirrors
 * `loadConfiguration` below so an operator can tell an identity failure apart from every other
 * cause `run.failed` alone would otherwise collapse it into.
 */
async function resolveIdentityOrThrow(
  apiBase: string,
  env: NodeJS.ProcessEnv,
  event: EventContext,
  diagnostics: Diagnostics,
): Promise<ResolvedIdentity> {
  let identity: ResolvedIdentity | undefined;
  try {
    identity = await resolveIdentity(
      apiBase,
      env,
      event.owner,
      event.repo,
      diagnostics,
      Math.floor(Date.now() / 1000),
    );
  } catch (error) {
    // A `mintInstallationToken` failure (a malformed PEM, a network blip, the App not installed on
    // this repository) otherwise collapses into the same generic `run.failed` every other cause
    // does, with nothing in the diagnostics stream to tell an operator this was an identity problem
    // rather than, say, a config or an engine one.
    diagnostics.record("publish.identity_mint_failed", { headSha: event.head });
    throw error;
  }
  if (identity === undefined) throw new Error("no posting identity configured");
  return identity;
}

interface LoadedConfiguration {
  readonly config: RuntimeConfig;
  readonly profile: CompiledProfile;
  readonly guidelines: GuidelineIndex;
}

interface CheckpointPersistence {
  readonly persist?: (store: CacheStore, appended: number) => Promise<void>;
  readonly wasWritten: () => boolean;
}

function checkpointPersistence(
  storePath: string,
  diagnostics: Diagnostics,
  env: NodeJS.ProcessEnv,
): CheckpointPersistence {
  let written = false;
  if (storePath === "") return { wasWritten: () => false };
  return {
    persist: async (store, appended): Promise<void> => {
      const saved = await saveCacheStore(storePath, store, appended, diagnostics, true);
      if (!saved) throw new Error("checkpoint write failed");
      written = true;
      // Publish the hand-off signal immediately. If a later chunk throws, `runAction` never reaches
      // its final output block, but the consumer still needs to upload the already-paid checkpoint.
      // GitHub output files accept repeated keys; the final report writes the same true value again.
      try {
        writeOutputs(env, { store_written: "true" });
      } catch {
        diagnostics.record("outputs.write_failed");
      }
    },
    wasWritten: () => written,
  };
}

/**
 * Loads runtime inputs, the review profile, and the guidelines list, recording a distinguishing
 * diagnostic on failure — mirrors `resolveIdentityOrThrow` above for the same reason.
 */
async function loadConfiguration(
  env: NodeJS.ProcessEnv,
  event: EventContext,
  diagnostics: Diagnostics,
): Promise<LoadedConfiguration> {
  try {
    const config = runtimeConfigFromInputs(env);
    const profilePath = readRequiredInput(env, "profile");
    const profile = loadReviewProfile(await readFile(profilePath, "utf8"));
    const guidelines = parseGuidelinePaths(readInput(env, "guidelines"));
    return { config, profile, guidelines };
  } catch (error) {
    // The supplied configuration — runtime inputs, the review profile, or the guidelines list —
    // failed to validate. Recorded before rethrowing so an operator can tell this apart from
    // every other cause `run.failed` alone would otherwise collapse it into.
    diagnostics.record("config.invalid", { headSha: event.head });
    throw error;
  }
}

/**
 * The action entrypoint.
 *
 * Ordering is deliberate: eligibility is decided before any credential is used, and the identity is
 * resolved before the engine runs, so a misconfigured installation fails in seconds rather than
 * after a full model spend.
 */
export async function runAction(
  env: NodeJS.ProcessEnv,
  diagnostics: Diagnostics,
): Promise<ReviewReport | undefined> {
  const event = await loadEvent(env);
  if (!admit(env, event, diagnostics)) return undefined;

  const apiBase = env.GITHUB_API_URL ?? DEFAULT_API_BASE;
  const identity = await resolveIdentityOrThrow(apiBase, env, event, diagnostics);

  const { config, profile, guidelines } = await loadConfiguration(env, event, diagnostics);
  diagnostics.record("config.loaded", { headSha: event.head });

  // Empty disables the feature entirely: no store is loaded, `cacheStore` stays `undefined`, and
  // `performReview` never computes a cache key. This is the one input this action reads with no
  // default fallback to a non-empty value, matching `guidelines`' existing empty-disables contract.
  const storePath = readInput(env, "review_store_path");
  const cacheStore = storePath === "" ? undefined : await loadCacheStore(storePath, diagnostics);
  const checkpoint = checkpointPersistence(storePath, diagnostics, env);

  // Measured around the call itself, not the whole action: identity resolution, config/profile
  // loading, and the cache read above are this action's own overhead, not the review's cost.
  // Issue #59 is visibility only — nothing here reads the number back to gate or speed up anything.
  const request = buildReviewRequest(
    event,
    identity,
    config,
    profile,
    guidelines,
    env,
    cacheStore,
    checkpoint.persist,
  );
  const reviewStartedAt = Date.now();
  const report = await performReview(request, diagnostics);
  const durationMs = Date.now() - reviewStartedAt;

  const storeWritten =
    (await maybeSaveCacheStore(storePath, report, diagnostics)) || checkpoint.wasWritten();
  const summaryCommentUrl = await maybeMaintainSummary(
    env,
    event,
    identity,
    report,
    durationMs,
    diagnostics,
  );

  try {
    writeOutputs(env, reportOutputs(report, summaryCommentUrl, storeWritten));
  } catch {
    // Mirrors `saveCacheStore`'s own reasoning: a delivery-mechanism failure at the very last step
    // — `$GITHUB_OUTPUT` unwritable, a disk full — must not retroactively turn a completed,
    // already-published review into an undiagnosable total failure. The review already happened;
    // only the action's own output plumbing failed to report it.
    diagnostics.record("outputs.write_failed");
  }
  return report;
}

/** Process wrapper. Writes diagnostics to stdout and exits non-zero only on a genuine failure. */
export async function main(): Promise<void> {
  const diagnostics = createDiagnostics((line) => process.stdout.write(`${line}\n`));
  try {
    const report = await runAction(process.env, diagnostics);
    diagnostics.record("run.finished", {
      counts: { incomplete: report?.outcome === "incomplete" ? 1 : 0 },
    });
  } catch {
    // The error itself is never printed: it can carry a path, an endpoint, or engine output.
    diagnostics.record("run.failed");
    process.exitCode = 1;
  }
}
