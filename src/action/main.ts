import { readFile, writeFile } from "node:fs/promises";

import {
  SUPPORTED_STORE_SCHEMA,
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
    cache_misses: String(report.cacheMisses),
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
    diagnostics.record("cache.store_rejected");
    return EMPTY_STORE;
  }
  diagnostics.record("cache.store_loaded", { counts: { entries: result.store.entries.length } });
  return result.store;
}

/**
 * Writes the review-cache store back out, reached only after `runAction` has already confirmed the
 * settlement was `complete` — see the call site. A write failure is fail-open in the same direction
 * as a read failure: it costs the *next* run's re-review budget, never this run's own completeness,
 * which already settled before this function was ever called.
 */
async function saveCacheStore(
  path: string,
  store: CacheStore,
  appended: number,
  diagnostics: Diagnostics,
): Promise<boolean> {
  try {
    await writeFile(path, serializeStore(store), "utf8");
    diagnostics.record("cache.appended", { counts: { entries: appended } });
    return true;
  } catch {
    // Swallowing the error is right — a store this run cannot write is a lost optimization, not a
    // reason to fail a review that already published. Swallowing the OUTCOME is not: the caller
    // reports `store_written`, and a consumer that believes it will try to hand off a file that
    // is not there.
    diagnostics.record("cache.store_write_failed");
    return false;
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
 * did not reach every file — and never for a rejected schema, a bad terminal state, or an
 * implausible finding count, where the manifest itself is not to be believed. `performReview`
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
  if (report.outcome === "incomplete") {
    // An incomplete report without a reason cannot be argued into the allowed set, so it is not.
    if (report.reason === undefined || !verdictsSurviveIncompleteness(report.reason)) return false;
  } else if (report.outcome !== "complete" && report.outcome !== "abandoned") {
    return false;
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
    env,
    pathValue: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(cacheStore === undefined ? {} : { cacheStore }),
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
    // Mirrors the config-loading block below: a `mintInstallationToken` failure (a malformed PEM, a
    // network blip, the App not installed on this repository) otherwise collapses into the same
    // generic `run.failed` every other cause does, with nothing in the diagnostics stream to tell
    // an operator this was an identity problem rather than, say, a config or an engine one.
    diagnostics.record("publish.identity_mint_failed", { headSha: event.head });
    throw error;
  }
  if (identity === undefined) throw new Error("no posting identity configured");

  let config: RuntimeConfig;
  let profile: CompiledProfile;
  let guidelines: GuidelineIndex;
  try {
    config = runtimeConfigFromInputs(env);
    const profilePath = readRequiredInput(env, "profile");
    profile = loadReviewProfile(await readFile(profilePath, "utf8"));
    guidelines = parseGuidelinePaths(readInput(env, "guidelines"));
  } catch (error) {
    // The supplied configuration — runtime inputs, the review profile, or the guidelines list —
    // failed to validate. Recorded before rethrowing so an operator can tell this apart from
    // every other cause `run.failed` alone would otherwise collapse it into.
    diagnostics.record("config.invalid", { headSha: event.head });
    throw error;
  }
  diagnostics.record("config.loaded", { headSha: event.head });

  // Empty disables the feature entirely: no store is loaded, `cacheStore` stays `undefined`, and
  // `performReview` never computes a cache key. This is the one input this action reads with no
  // default fallback to a non-empty value, matching `guidelines`' existing empty-disables contract.
  const storePath = readInput(env, "review_store_path");
  const cacheStore = storePath === "" ? undefined : await loadCacheStore(storePath, diagnostics);

  // Measured around the call itself, not the whole action: identity resolution, config/profile
  // loading, and the cache read above are this action's own overhead, not the review's cost.
  // Issue #59 is visibility only — nothing here reads the number back to gate or speed up anything.
  const request = buildReviewRequest(event, identity, config, profile, guidelines, env, cacheStore);
  const reviewStartedAt = Date.now();
  const report = await performReview(request, diagnostics);
  const durationMs = Date.now() - reviewStartedAt;

  const storeWritten = await maybeSaveCacheStore(storePath, report, diagnostics);
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
