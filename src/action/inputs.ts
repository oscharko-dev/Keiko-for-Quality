import { appendFileSync } from "node:fs";

import { ValidationError, commitSha, type CommitSha } from "../core/brands.js";
import { parseRuntimeConfig, type RuntimeConfig } from "../config/runtime.js";

/**
 * GitHub Actions input and output handling.
 *
 * Implemented directly against the documented environment contract — `INPUT_*` for inputs,
 * `$GITHUB_OUTPUT` for outputs — because that contract is three lines of code and stable, and
 * because a toolkit dependency here would be a package running inside every consumer's CI next to
 * a private key.
 */

function inputKey(name: string): string {
  return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}

export function readInput(env: NodeJS.ProcessEnv, name: string): string {
  return (env[inputKey(name)] ?? "").trim();
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
  readonly headRepoFullName: string | undefined;
  readonly action: string | undefined;
  readonly previousBaseRef: string | undefined;
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
    headRepoFullName: typeof headRepo.full_name === "string" ? headRepo.full_name : undefined,
    action: eventAction,
    previousBaseRef: typeof baseChange.from === "string" ? baseChange.from : undefined,
    eventTimestamp: text(pull.updated_at),
  };
}
