import { appendFileSync } from "node:fs";

import { ValidationError, commitSha, type CommitSha } from "../core/brands.js";
import {
  LARGE_REVIEW_DEFAULTS,
  parseRuntimeConfig,
  type RuntimeConfig,
} from "../config/runtime.js";

/**
 * GitHub Actions input and output handling.
 *
 * Implemented directly against the documented environment contract — `INPUT_*` for inputs,
 * `$GITHUB_OUTPUT` for outputs — because that contract is three lines of code and stable, and
 * because a toolkit dependency here would be a package running inside every consumer's CI next to
 * a private key.
 */

function inputKey(name: string): string {
  return `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
}

export function readInput(env: NodeJS.ProcessEnv, name: string): string {
  return (env[inputKey(name)] ?? "").trim();
}

function readInputWithDefault(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[inputKey(name)];
  return raw === undefined ? fallback : raw.trim();
}

export function readRequiredInput(env: NodeJS.ProcessEnv, name: string): string {
  const value = readInput(env, name);
  if (value === "") throw new ValidationError(`input.${name}`);
  return value;
}

export function readIntegerInput(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = readInput(env, name);
  if (raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new ValidationError(`input.${name}`);
  return parsed;
}

/**
 * Reads a `"true"`/`"false"` action input, matching the string-typed contract every Actions input
 * has. Empty (the input was not supplied) resolves to `fallback` rather than an error, the same
 * "absent means the default" contract `readIntegerInput` already applies.
 */
export function readBooleanInput(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = readInput(env, name);
  if (raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ValidationError(`input.${name}`);
}

export function writeOutputs(
  env: NodeJS.ProcessEnv,
  values: Readonly<Record<string, string>>,
): void {
  const target = env.GITHUB_OUTPUT;
  if (target === undefined || target === "") return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value.replace(/[\r\n]+/g, " ")}`)
    .join("\n");
  appendFileSync(target, `${lines}\n`, "utf8");
}

/**
 * Builds the runtime configuration from action inputs.
 *
 * The model credential is referenced by variable name, never passed as an input. An input value
 * appears in the workflow's `with:` block and in the step context that every other action in the
 * job can read; an environment variable set from a secret does not.
 */
export function runtimeConfigFromInputs(env: NodeJS.ProcessEnv): RuntimeConfig {
  return parseRuntimeConfig(
    {
      protocol: readRequiredInput(env, "model_protocol"),
      endpoint: readRequiredInput(env, "model_endpoint"),
      model: readRequiredInput(env, "model_id"),
      tokenEnvName: readRequiredInput(env, "model_token_env"),
      language: readInput(env, "language") || "English",
      concurrency: readIntegerInput(env, "concurrency", 4),
      fileTimeoutSeconds: readIntegerInput(env, "file_timeout_seconds", 300),
      reviewTimeoutSeconds: readIntegerInput(env, "review_timeout_seconds", 1800),
      tokenBudget: readIntegerInput(env, "token_budget", 2_000_000),
      maxFindings: readIntegerInput(env, "max_findings", 50),
      renameDetectionPercent: readIntegerInput(env, "rename_detection_percent", 50),
      // Dark-shipped prototype (issue #80 technique C, contracts/change-pass.ts): off by
      // default, same "absent means the default" contract every other input here follows.
      crossArtifactPass: readBooleanInput(env, "cross_artifact_pass", false),
      largeReviewMaxFiles: readIntegerInput(
        env,
        "large_review_max_files",
        LARGE_REVIEW_DEFAULTS.maxFiles,
      ),
      budgetFailureRetryLimit: readIntegerInput(
        env,
        "budget_failure_retry_limit",
        LARGE_REVIEW_DEFAULTS.budgetFailureRetryLimit,
      ),
      budgetFailureMinFiles: readIntegerInput(
        env,
        "budget_failure_min_files",
        LARGE_REVIEW_DEFAULTS.budgetFailureMinFiles,
      ),
      largeReviewOverrideLabel: readInputWithDefault(
        env,
        "large_review_override_label",
        LARGE_REVIEW_DEFAULTS.overrideLabel,
      ),
    },
    "input",
  );
}

export interface EventContext {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly base: CommitSha;
  readonly head: CommitSha;
  readonly baseRef: string;
  readonly draft: boolean;
  /**
   * The pull request's title and description, joined — what the author says this change is for.
   *
   * Empty when the payload carries neither, which is the ordinary case for a bot-opened pull
   * request with a title and no body, and which callers must treat as "no intent stated" rather
   * than as an error. Candidate-controlled text; see `renderChangeIntent` (`engine/model-proxy.ts`)
   * for the framing and bound it is given before any model sees it.
   */
  readonly changeIntent: string;
  readonly headRepoFullName: string | undefined;
  readonly action: string | undefined;
  readonly previousBaseRef: string | undefined;
  readonly labels: readonly string[];
  /**
   * `pull_request.updated_at` from the webhook payload — GitHub's own server-assigned timestamp for
   * this activity, never this process's wall clock. Empty when the payload carried none (an
   * unexpected shape, or a synthetic event), which callers must treat as "unknown" rather than
   * substituting `Date.now()`: a queued job's wall clock reflects when it happened to run, not when
   * the event this run is reviewing actually occurred.
   */
  readonly eventTimestamp: string;
}

/** Reads a field as text only when it genuinely is text, so an object never becomes a value. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Reads the immutable commit pair from the event payload.
 *
 * Both SHAs come from the webhook snapshot rather than from the checked-out repository, so the
 * review is bound to the state that triggered it even if the branch has moved since.
 */
/**
 * Joins the pull request's title and body into one block, or returns empty.
 *
 * Both fields are optional in the payload and `body` is explicitly nullable on GitHub's own schema,
 * so a missing one is normal rather than a malformed event — this returns what it has instead of
 * throwing, because a review with no stated intent is a review, and a failed parse would not be.
 */
function joinIntent(title: unknown, body: unknown): string {
  const parts = [
    typeof title === "string" ? title.trim() : "",
    typeof body === "string" ? body.trim() : "",
  ];
  return parts.filter((part) => part !== "").join("\n\n");
}

function labelNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => text(asRecord(entry).name))
    .filter((name) => name !== "" && name.length <= 100);
}

export function parseEventContext(payload: unknown): EventContext {
  const root = asRecord(payload);
  // The activity type lives in the payload, not the environment: `GITHUB_EVENT_NAME` is
  // `pull_request_target` for every one of them.
  const eventAction = typeof root.action === "string" ? root.action : undefined;
  const pull = asRecord(root.pull_request);
  const head = asRecord(pull.head);
  const base = asRecord(pull.base);
  const baseRepo = asRecord(base.repo);
  const headRepo = asRecord(head.repo);
  const changes = asRecord(root.changes);
  const baseChange = asRecord(asRecord(changes.base).ref);
  const fullName = text(baseRepo.full_name);
  const [owner, repo] = fullName.split("/");
  if (owner === undefined || repo === undefined || owner === "" || repo === "") {
    throw new ValidationError("event.repository");
  }
  const number = pull.number;
  if (typeof number !== "number" || !Number.isInteger(number)) {
    throw new ValidationError("event.pull_request.number");
  }
  return {
    owner,
    repo,
    pullNumber: number,
    base: commitSha(text(base.sha), "event.base.sha"),
    head: commitSha(text(head.sha), "event.head.sha"),
    baseRef: text(base.ref),
    draft: pull.draft === true,
    changeIntent: joinIntent(pull.title, pull.body),
    headRepoFullName: typeof headRepo.full_name === "string" ? headRepo.full_name : undefined,
    action: eventAction,
    previousBaseRef: typeof baseChange.from === "string" ? baseChange.from : undefined,
    labels: labelNames(pull.labels),
    eventTimestamp: text(pull.updated_at),
  };
}
