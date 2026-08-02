import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256, type Sha256 } from "../core/brands.js";
import type { CompiledProfile } from "../config/profile.js";
import type { GuidelineIndex } from "../config/guidelines.js";
import { readModelToken, type RuntimeConfig } from "../config/runtime.js";
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
  const ruleBody = serializeRuleFile(buildRuleFile(options.profile, options.guidelines));
  const rulePath = join(home, "keiko-rules.json");
  await writeFile(rulePath, ruleBody, { mode: 0o600 });
  return { rulePath, ruleDigest: sha256(createHash("sha256").update(ruleBody).digest("hex")) };
}

function reviewArguments(options: EngineRunOptions, rulePath: string): string[] {
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
  ];
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
  try {
    await mkdir(join(home, "state"), { recursive: true, mode: 0o700 });
    const { rulePath, ruleDigest } = await writeRuleFile(options, home);
    const env = engineEnvironment(options, token, home);
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
      counts: { bytes: result.stdout.byteLength },
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
    // Transient review state — the rule file, engine session data, and any temporary artifacts —
    // is removed whether or not the run succeeded.
    await rm(home, { recursive: true, force: true });
  }
}
