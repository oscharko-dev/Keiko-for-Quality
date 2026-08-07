import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256, type Sha256 } from "../core/brands.js";
import type { CompiledProfile } from "../config/profile.js";
import type { GuidelineIndex } from "../config/guidelines.js";
import { readModelToken, type RuntimeConfig } from "../config/runtime.js";
import { startModelProxy, type ModelProxy } from "./model-proxy.js";
import type { Diagnostics } from "../diagnostics/sink.js";
import { run, ExecFailure } from "../git/exec.js";
import type { ReviewPair } from "../inventory/inventory.js";
import { buildRuleFile, serializeRuleFile } from "./rule-file.js";

export class EngineRunError extends Error {
  public readonly reason:
    | "engine.run.timeout"
    | "engine.run.spawn_failed"
    | "engine.run.nonzero_exit";

  /**
   * What the failed invocation measurably cost on the wire — the loopback proxy's prompt plus
   * completion counts at the moment of failure (2026-08-06): a run that times out or exits
   * nonzero may still have made real, billable model calls, and a caller accounting spend has
   * nothing else to bill them from, because a failed engine never reports a token total of its
   * own. Absent — not zero — when no proxy counted (the anthropic path, or a spawn that failed
   * before the proxy existed): "unmeasured" and "free" must stay distinguishable.
   */
  public readonly wireTokens?: number;

  public constructor(reason: EngineRunError["reason"], wireTokens?: number) {
    super(reason);
    this.name = "EngineRunError";
    this.reason = reason;
    if (wireTokens !== undefined) this.wireTokens = wireTokens;
  }
}

export interface EngineRunOptions {
  readonly binaryPath: string;
  /** The trusted base checkout. Candidate content exists only as Git objects beneath it. */
  readonly repositoryPath: string;
  readonly pair: ReviewPair;
  readonly config: RuntimeConfig;
  readonly profile: CompiledProfile;
  readonly guidelines: GuidelineIndex;
  readonly env: NodeJS.ProcessEnv;
  readonly pathValue: string;
  /** The pull request's stated purpose, forwarded to the proxy — see `ModelProxyOptions`. */
  readonly changeIntent?: string;
  /**
   * The size-scaled per-run ceiling passed to the engine's own `--max-tokens-budget`.
   *
   * Never larger than `config.tokenBudget` — see `computeAllottedBudget` in `../review.js`, which
   * derives it from the inventory. Passing it is what makes the engine stop dispatching new files
   * once projected spend crosses it, instead of discovering the overrun only after paying for it.
   */
  readonly allottedBudget: number;
  /** Paths the inventory downgraded to `mechanically-clean`. Forwarded to `buildRuleFile`. */
  readonly mechanicallyCleanPaths: readonly string[];
  /**
   * Overrides the pinned sampling seed for this invocation. The single bounded resume passes a
   * different value: pinned sampling replays a deterministic failure byte-for-byte, and a resume
   * that cannot produce a different path is not a second opinion.
   */
  readonly samplingSeed?: number;
}

/**
 * Requests the provider refused outright because they did not fit its context window.
 *
 * Carried out of the proxy for the same reason `wireTokens` is: the settlement decision needs it
 * and the diagnostic stream is not a channel back into the product. `limit` and `requested` are the
 * provider's own figures from the most recent such refusal, or 0 when it named none — numbers only,
 * never any part of the body they came from.
 */
export interface ContextLengthRefusals {
  readonly count: number;
  readonly limit: number;
  readonly requested: number;
}

export interface EngineRunOutput {
  readonly stdout: string;
  readonly ruleDigest: Sha256;
  /** The invocation's wire-counted spend (proxy prompt + completion) — the billable truth even
   *  when `stdout` later fails validation and the engine's own `total_tokens` never gets read.
   *  Absent when no proxy counted (anthropic path); see `EngineRunError.wireTokens`. */
  readonly wireTokens?: number;
  /**
   * Present only when the provider refused at least one request as too large (2026-08-07).
   *
   * Measured across 27 full-size reviews of real pull requests: every one of the 21 that ran to
   * completion had zero persisted 400s, and every one of the 6 that did not had at least one — five
   * of them refusals of exactly this kind. It is the cleanest separator this project has found, and
   * until now it reached only the `model.usage` diagnostic, so a run settled `coverage_gap` while
   * the actual cause — one file that cannot fit in the model's context — went unnamed. A retry
   * cannot fix a file that is too big, which makes naming it the difference between an operator who
   * knows to split or exclude it and one who re-runs the review and pays again for the same gap.
   */
  readonly contextLengthRefusals?: ContextLengthRefusals;
}

/**
 * The environment the engine process receives.
 *
 * Built from nothing rather than filtered from `process.env`. A deny-list would have to be updated
 * every time the runner, the consumer, or a future action input introduces a new variable; an
 * allow-list is wrong only in the direction that fails the run. In particular the engine never sees
 * `GITHUB_TOKEN`, any `ACTIONS_*` variable, or the runner's real `HOME`.
 */
function engineEnvironment(
  options: EngineRunOptions,
  token: string,
  home: string,
): NodeJS.ProcessEnv {
  return {
    PATH: options.pathValue,
    HOME: home,
    LC_ALL: "C",
    TMPDIR: home,
    OCR_LLM_URL: options.config.endpoint,
    OCR_LLM_TOKEN: token,
    OCR_LLM_MODEL: options.config.model,
    OCR_USE_ANTHROPIC: options.config.protocol === "anthropic" ? "true" : "false",
    OCR_LLM_TIMEOUT: String(options.config.fileTimeoutSeconds),
    // Telemetry would send run metadata to a third party from inside the consumer's CI.
    OCR_ENABLE_TELEMETRY: "false",
    // Content logging would defeat the entire redaction contract in one flag.
    OCR_CONTENT_LOGGING: "false",
  };
}

async function configureEngine(
  options: EngineRunOptions,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // `config set` writes beneath HOME. Pointing HOME at a fresh directory is what stops the engine
  // from reading a `~/.opencodereview/rule.json` that the runner image or a previous job left
  // behind, and stops this run from leaving state behind for the next one.
  await run(options.binaryPath, ["config", "set", "language", options.config.language], {
    cwd: home,
    timeoutMs: 30_000,
    maxBuffer: 1024 * 1024,
    env,
  });
}

/**
 * Writes the product-owned rule file and returns its digest.
 *
 * The digest is recorded with the run because the rule text is part of the qualified configuration:
 * a review produced under different guidance is not comparable to the one the corpus measured.
 */
async function writeRuleFile(
  options: EngineRunOptions,
  home: string,
): Promise<{ rulePath: string; ruleDigest: Sha256 }> {
  const rule = buildRuleFile(options.profile, options.guidelines, options.mechanicallyCleanPaths);
  const ruleBody = serializeRuleFile(rule);
  const rulePath = join(home, "keiko-rules.json");
  await writeFile(rulePath, ruleBody, { mode: 0o600 });
  return { rulePath, ruleDigest: sha256(createHash("sha256").update(ruleBody).digest("hex")) };
}

/**
 * Tool-call rounds the engine may spend on ONE file before it gives up on it.
 *
 * This is the root cause of the failure class every other fix this week has been catching
 * downstream. Read from the pinned engine's own source (v1.8.4), the chain is exact:
 * `Template.MaxToolRequestTimes` defaults to 30 in the embedded `task_template.json`;
 * `llmloop.RunPerFile` counts down from it and, on exhaustion, prints "Max tool requests reached"
 * and returns `false, nil`; `agent.executeSubtask` turns that into
 * `errors.New("main_task did not complete before stopping")`; and the agent records it as a
 * `subtask_error` warning naming the file. That warning is what `settle.ts` reads as a coverage
 * gap, which is what settles the review incomplete. Thirty rounds is where reviews were dying.
 *
 * `--max-tools` only ever RAISES the template value (`loadCommonContext`: `if maxTools >
 * tpl.MaxToolRequestTimes`), so this cannot accidentally lower the engine's own floor, and the
 * engine clamps anything under 10 upward.
 *
 * Sixty rather than a larger number, and the reasoning is about cost asymmetry rather than
 * ambition. A file that finishes in 25 rounds is completely unaffected — the ceiling is not a
 * budget, only a stopping point. The extra spend falls exclusively on files that WOULD have died
 * at 30, and those files already paid for their 30 rounds and returned nothing usable: raising the
 * ceiling converts spend that bought a coverage gap into spend that may buy a verdict. Total cost
 * stays bounded regardless, because `--max-tokens-budget` above is a separate, unchanged
 * stop-loss on the whole run — this ceiling can extend one file's conversation, never the run's
 * total spend.
 *
 * Doubling is deliberate over a bigger jump: a file that cannot finish in sixty rounds is very
 * likely stuck rather than slow, and `engine.status.*`'s `warnings_subtask_error_tool_budget`
 * count (see `result.ts`) is what will say whether that guess held.
 */
export const MAX_TOOL_ROUNDS_PER_FILE = 60;

export function reviewArguments(options: EngineRunOptions, rulePath: string): string[] {
  return [
    "review",
    "--from",
    options.pair.mergeBase,
    "--to",
    options.pair.head,
    "--format",
    "json",
    // Explicit, so the engine never consults its discovery paths — including a `rule.json` inside
    // the repository being reviewed.
    "--rule",
    rulePath,
    "--concurrency",
    String(options.config.concurrency),
    // Makes the engine's own dispatch loop stop selecting new files once projected spend crosses
    // this ceiling, instead of the overrun only being detected in `settle.ts` after every file
    // already selected has been paid for.
    "--max-tokens-budget",
    String(options.allottedBudget),
    "--max-tools",
    String(MAX_TOOL_ROUNDS_PER_FILE),
  ];
}

/**
 * Review sampling is pinned, not defaulted (v0.11.0). Measured across eight corpus runs on
 * gpt-oss-120b with a byte-identical prompt, per-case outcomes flipped run to run — sampling
 * variance no rule text reduces. Zero is a deliberate product choice for a reviewer: the same
 * change should get the same review twice, and the qualification bar ("everything, twice in a
 * row") is only meaningful under it. The engine offers no sampling control of its own, so the
 * loopback proxy (`model-proxy.ts`) pins it on the wire; the anthropic protocol path is exempt
 * because the proxy speaks OpenAI chat completions.
 */
const REVIEW_TEMPERATURE = 0;

/**
 * Arbitrary but fixed. Temperature zero alone measured non-deterministic on Azure's gpt-oss
 * serving (identical requests diverged); with an explicit seed, three identical requests returned
 * byte-identical completions. The value carries no meaning — its constancy does.
 */
const REVIEW_SEED = 42;

/**
 * Derives the proxy's `prompt_cache_key` (v0.13.0) from the rule digest `writeRuleFile` already
 * computed for `keiko-rules.json`, rather than hashing anything independently — reusing that exact
 * digest is what makes the key identical for every file in this run (all ~30 turns/file resend the
 * same rule prefix, and OpenAI-compatible providers only discount a cache hit when the routing key
 * matches too) and identical again on a future run over the same rule, without carrying anything
 * about *this* run's candidate content: a 16-hex-char prefix of a content digest is not the content
 * — it is a short fingerprint, no more revealing than the full digest this run already records in
 * `engine.run.completed`, and it cannot be inverted back to rule or diff text. `kfq-` just namespaces
 * the key against whatever else may share the provider account's cache key space.
 */
function promptCacheKeyForRule(ruleDigest: Sha256): string {
  return `kfq-${ruleDigest.slice(0, 16)}`;
}

/**
 * Starts the loopback proxy unless the protocol is anthropic, which speaks the model's native API
 * directly and never sends an OpenAI chat-completions body for the proxy to rewrite. Split out of
 * `runEngine` purely to keep that function under this file's line-count ceiling — the branch itself
 * is unchanged from before this existed.
 */
async function startProxyIfNeeded(
  options: EngineRunOptions,
  ruleDigest: Sha256,
): Promise<ModelProxy | undefined> {
  if (options.config.protocol === "anthropic") return undefined;
  return startModelProxy({
    upstreamUrl: options.config.endpoint,
    temperature: REVIEW_TEMPERATURE,
    seed: options.samplingSeed ?? REVIEW_SEED,
    promptCacheKey: promptCacheKeyForRule(ruleDigest),
    // Conditional, not `changeIntent: options.changeIntent`: under `exactOptionalPropertyTypes` an
    // optional field may be absent or a string, never an explicit `undefined`. Absent is also what
    // keeps every body byte-identical for a caller that has no pull request to read an intent from.
    ...(options.changeIntent === undefined ? {} : { changeIntent: options.changeIntent }),
  });
}

/**
 * Wire-level usage telemetry (v0.12.0), recorded once per invocation regardless of outcome — a run
 * that ultimately throws or times out may still have made real, billable requests through the
 * proxy, and that spend is real even though the run did not succeed. `proxy` is `undefined` on the
 * anthropic path, which never speaks OpenAI chat completions, so nothing is recorded there.
 */
function recordModelUsage(
  diagnostics: Diagnostics,
  proxy: ModelProxy | undefined,
  options: EngineRunOptions,
): void {
  if (proxy === undefined) return;
  const usage = proxy.usage();
  diagnostics.record("model.usage", {
    headSha: options.pair.head,
    counts: {
      requests: usage.requests,
      prompt: usage.prompt,
      completion: usage.completion,
      cached: usage.cached,
      cache_key_rejected: usage.cacheKeyRejected,
      // Always present, even at 0: "no model call was refused" is a fact worth one word, and its
      // absence is what let Keiko#3002's persisted 400s masquerade as cache-key noise.
      bad_request_persisted: usage.badRequestPersisted,
      // Calls the second healing stage saved by re-sending the engine's original body — each one
      // ran without the sampling pin, which this ledger must show (2026-08-06, Keiko#3008).
      ...(usage.rewriteRejected > 0 ? { rewrite_rejected: usage.rewriteRejected } : {}),
      // Only when a persisted 400's body named them — see `recordBadRequestNumbers`.
      ...(usage.badRequestContentFilter > 0
        ? { bad_request_content_filter: usage.badRequestContentFilter }
        : {}),
      ...(usage.badRequestUnknownParameter > 0
        ? { bad_request_unknown_parameter: usage.badRequestUnknownParameter }
        : {}),
      ...(usage.badRequestContextLength > 0
        ? { bad_request_context_length: usage.badRequestContextLength }
        : {}),
      ...(usage.badRequestContextLimit > 0
        ? { bad_request_context_limit: usage.badRequestContextLimit }
        : {}),
      ...(usage.badRequestRequestedTokens > 0
        ? { bad_request_requested_tokens: usage.badRequestRequestedTokens }
        : {}),
    },
  });
}

/**
 * Classifies a failure thrown out of the invocation into the reason recorded for it.
 *
 * A named function rather than the nested ternary it replaces (Sonar S3358) — the same three
 * outcomes, only flatter. `ExecFailure` carries `timedOut` (`git/exec.ts`) precisely so this
 * classification never has to infer a timeout from an exit code, and anything that is not an
 * `ExecFailure` never reached a process that could exit at all: that is the spawn-failure path.
 */
function failureReason(error: unknown): EngineRunError["reason"] {
  if (!(error instanceof ExecFailure)) return "engine.run.spawn_failed";
  return error.timedOut ? "engine.run.timeout" : "engine.run.nonzero_exit";
}

/** This invocation's wire-counted spend so far, or `undefined` when no proxy counted — read for
 *  the success output and the failure error alike, while the proxy is still open (the `finally`
 *  below closes it). */
function proxyWireTokens(proxy: ModelProxy | undefined): number | undefined {
  if (proxy === undefined) return undefined;
  const usage = proxy.usage();
  return usage.prompt + usage.completion;
}

/** `undefined` when nothing was refused for size — the settlement should say nothing rather than
 *  report a zero, the same discipline `parseToolCalls` applies to an absent tally. */
function proxyContextRefusals(proxy: ModelProxy | undefined): ContextLengthRefusals | undefined {
  if (proxy === undefined) return undefined;
  const usage = proxy.usage();
  if (usage.badRequestContextLength === 0) return undefined;
  return {
    count: usage.badRequestContextLength,
    limit: usage.badRequestContextLimit,
    requested: usage.badRequestRequestedTokens,
  };
}

/**
 * Runs one review and returns its raw stdout.
 *
 * The output is returned to the caller as a value and never written to a log, an artifact, or a
 * diagnostic. Its only consumers are the strict parser and, after validation, the publisher.
 */
export async function runEngine(
  options: EngineRunOptions,
  diagnostics: Diagnostics,
): Promise<EngineRunOutput> {
  const token = readModelToken(options.config, options.env);
  if (token === undefined) throw new EngineRunError("engine.run.spawn_failed");

  const home = await mkdtemp(join(tmpdir(), "kfq-engine-"));
  const started = Date.now();
  let proxy: ModelProxy | undefined;
  try {
    await mkdir(join(home, "state"), { recursive: true, mode: 0o700 });
    const { rulePath, ruleDigest } = await writeRuleFile(options, home);
    proxy = await startProxyIfNeeded(options, ruleDigest);
    const env = engineEnvironment(options, token, home);
    if (proxy !== undefined) env.OCR_LLM_URL = proxy.url;
    await configureEngine(options, home, env);

    const result = await run(options.binaryPath, reviewArguments(options, rulePath), {
      cwd: options.repositoryPath,
      timeoutMs: options.config.reviewTimeoutSeconds * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });

    diagnostics.record("engine.run.completed", {
      headSha: options.pair.head,
      digest: ruleDigest,
      durationMs: Date.now() - started,
      counts: { bytes: result.stdout.byteLength, budget: options.allottedBudget },
    });

    const wireTokens = proxyWireTokens(proxy);
    const contextLengthRefusals = proxyContextRefusals(proxy);
    return {
      stdout: result.stdout.toString("utf8"),
      ruleDigest,
      ...(wireTokens === undefined ? {} : { wireTokens }),
      ...(contextLengthRefusals === undefined ? {} : { contextLengthRefusals }),
    };
  } catch (error) {
    const reason = failureReason(error);
    diagnostics.record(reason, {
      headSha: options.pair.head,
      durationMs: Date.now() - started,
    });
    // The wire count rides the error (2026-08-06): a failed invocation's real, billable spend
    // was previously visible only in the `model.usage` diagnostic below, so an incomplete run's
    // report said `spend 0` while the proxy had counted thousands of real tokens.
    throw new EngineRunError(reason, proxyWireTokens(proxy));
  } finally {
    // Ordered before the close below on purpose, so the count is read while the proxy is still
    // the authority on its own totals rather than relying on `close()` leaving them readable.
    recordModelUsage(diagnostics, proxy, options);
    // The proxy dies with the invocation on every path — an orphaned listener would outlive the
    // credentials' purpose even though it never holds them.
    await proxy?.close();
    // Transient review state — the rule file, engine session data, and any temporary artifacts —
    // is removed whether or not the run succeeded.
    await rm(home, { recursive: true, force: true });
  }
}
