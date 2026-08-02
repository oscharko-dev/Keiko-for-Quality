import { readFile, writeFile } from "node:fs/promises";

import {
  SUPPORTED_STORE_SCHEMA,
  readStore,
  serializeStore,
  type CacheStore,
} from "../cache/review-cache.js";
import { parseGuidelinePaths } from "../config/guidelines.js";
import { loadReviewProfile } from "../config/profile.js";
import { createDiagnostics, type Diagnostics } from "../diagnostics/sink.js";
import { parseJson } from "../core/validate.js";
import { ENGINE_PIN } from "../engine/pinned-release.js";
import { maintainRunSummary } from "../publish/summary.js";
import { performReview, type ReviewReport } from "../review.js";
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
): Record<string, string> {
  return {
    outcome: report.outcome,
    reason: report.reason ?? "",
    inventory_size: String(report.inventorySize),
    findings_published: String(report.publish?.published ?? 0),
    findings_suppressed: String(report.publish?.suppressed ?? 0),
    cache_hits: String(report.cacheHits),
    cache_misses: String(report.cacheMisses),
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
): Promise<void> {
  try {
    await writeFile(path, serializeStore(store), "utf8");
    diagnostics.record("cache.appended", { counts: { entries: appended } });
  } catch {
    diagnostics.record("cache.store_write_failed");
  }
}

/**
 * Only a `complete` settlement may write back — checked here too, independent of whatever
 * `performReview` itself guarantees, because a store write is irreversible in a way a diagnostic is
 * not: writing a cache entry for a run this repository does not consider fully reviewed would let a
 * later, unrelated run replay it with confidence it never earned.
 */
async function maybeSaveCacheStore(
  storePath: string,
  report: ReviewReport,
  diagnostics: Diagnostics,
): Promise<void> {
  if (storePath === "" || report.outcome !== "complete" || report.updatedCacheStore === undefined) {
    return;
  }
  await saveCacheStore(storePath, report.updatedCacheStore, report.cacheAppended, diagnostics);
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
    },
    diagnostics,
  );
}

/**
 * The action entrypoint.
 *
 * Ordering is deliberate: eligibility is decided before any credential is used, and the identity is
 * resolved before the engine runs, so a misconfigured installation fails in seconds rather than
 * after a full model spend.
 */
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

export async function runAction(
  env: NodeJS.ProcessEnv,
  diagnostics: Diagnostics,
): Promise<ReviewReport | undefined> {
  const event = await loadEvent(env);
  if (!admit(env, event, diagnostics)) return undefined;

  const apiBase = env.GITHUB_API_URL ?? DEFAULT_API_BASE;
  const identity = await resolveIdentity(
    apiBase,
    env,
    event.owner,
    event.repo,
    diagnostics,
    Math.floor(Date.now() / 1000),
  );
  if (identity === undefined) throw new Error("no posting identity configured");

  const config = runtimeConfigFromInputs(env);
  const profilePath = readRequiredInput(env, "profile");
  const profile = loadReviewProfile(await readFile(profilePath, "utf8"));
  const guidelines = parseGuidelinePaths(readInput(env, "guidelines"));
  diagnostics.record("config.loaded", { headSha: event.head });

  // Empty disables the feature entirely: no store is loaded, `cacheStore` stays `undefined`, and
  // `performReview` never computes a cache key. This is the one input this action reads with no
  // default fallback to a non-empty value, matching `guidelines`' existing empty-disables contract.
  const storePath = readInput(env, "review_store_path");
  const cacheStore = storePath === "" ? undefined : await loadCacheStore(storePath, diagnostics);

  const report = await performReview(
    {
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
    },
    diagnostics,
  );

  await maybeSaveCacheStore(storePath, report, diagnostics);
  const summaryCommentUrl = await maybeMaintainSummary(env, event, identity, report, diagnostics);

  writeOutputs(env, reportOutputs(report, summaryCommentUrl));
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
