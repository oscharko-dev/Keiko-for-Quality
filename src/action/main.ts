import { readFile } from "node:fs/promises";

import { parseGuidelinePaths } from "../config/guidelines.js";
import { loadReviewProfile } from "../config/profile.js";
import { createDiagnostics, type Diagnostics } from "../diagnostics/sink.js";
import { parseJson } from "../core/validate.js";
import { performReview, type ReviewReport } from "../review.js";
import { evaluateEligibility } from "./eligibility.js";
import { resolveIdentity } from "./identity.js";
import {
  parseEventContext,
  readInput,
  readRequiredInput,
  runtimeConfigFromInputs,
  writeOutputs,
  type EventContext,
} from "./inputs.js";

const DEFAULT_API_BASE = "https://api.github.com";

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

function reportOutputs(report: ReviewReport): Record<string, string> {
  return {
    outcome: report.outcome,
    reason: report.reason ?? "",
    inventory_size: String(report.inventorySize),
    findings_published: String(report.publish?.published ?? 0),
    findings_suppressed: String(report.publish?.suppressed ?? 0),
  };
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
    },
    diagnostics,
  );

  writeOutputs(env, reportOutputs(report));
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
