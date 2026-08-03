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

  public constructor(reason: EngineRunError["reason"]) {
    super(reason);
    this.name = "EngineRunError";
    this.reason = reason;
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
}

export interface EngineRunOutput {
  readonly stdout: string;
  readonly ruleDigest: Sha256;
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
  ];
}

/**
 * Runs one review and returns its raw stdout.
 *
 * The output is returned to the caller as a value and never written to a log, an artifact, or a
 * diagnostic. Its only consumers are the strict parser and, after validation, the publisher.
 */
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
    proxy =
      options.config.protocol === "anthropic"
        ? undefined
        : await startModelProxy({
            upstreamUrl: options.config.endpoint,
            temperature: REVIEW_TEMPERATURE,
          });
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

    return { stdout: result.stdout.toString("utf8"), ruleDigest };
  } catch (error) {
    const reason =
      error instanceof ExecFailure ? "engine.run.nonzero_exit" : "engine.run.spawn_failed";
    diagnostics.record(reason, {
      headSha: options.pair.head,
      durationMs: Date.now() - started,
    });
    throw new EngineRunError(reason);
  } finally {
    // The proxy dies with the invocation on every path — an orphaned listener would outlive the
    // credentials' purpose even though it never holds them.
    await proxy?.close();
    // Transient review state — the rule file, engine session data, and any temporary artifacts —
    // is removed whether or not the run succeeded.
    await rm(home, { recursive: true, force: true });
  }
}
