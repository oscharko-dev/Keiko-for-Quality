#!/usr/bin/env node
// Completion gate — `npm run corpus:completion -- --repo <consumer-checkout> --pr <n> [--pr <n>]`.
//
// Runs the SHIPPED local CLI against real, full-size pull requests of a consumer repository and
// reports how often the review RUNS TO COMPLETION. See corpus/completion-gate-lib.mjs's header for
// why this gate exists at all, and why its answer is a rate rather than a verdict — the short
// version: on 2026-08-06 the recall gates were green while production could not finish a
// nineteen-file review, because no gate had ever run one.
//
// THIS SCRIPT SPENDS REAL MONEY, and more of it than any other harness here: a full-size pull
// request costs roughly 1.1M-1.7M tokens per run (measured on Keiko#3011), and the rate this gate
// produces is only as trustworthy as the number of runs behind it. `--dry-run` prints the plan and
// the forecast without contacting a model; use it first, every time. AGENTS.md's "commands spend
// real money" section governs this file.
//
// Nothing is pushed anywhere. Each target is materialised as a detached worktree of the consumer
// checkout at the pull request's head, reviewed against its merge-base, and removed afterwards.
//
// Exit codes: 0 — completion rate at or above the threshold. 1 — below it (or nothing gradeable).
// 2 — the gate could not measure (usage error, missing model env, git failure).
//
// Environment: the CLI's own contract — KFQ_MODEL_ENDPOINT, KFQ_MODEL_ID, KFQ_MODEL_PROTOCOL,
// KFQ_MODEL_TOKEN_ENV. KFQ_MODEL_ID must be gpt-oss-120b (AGENTS.md).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXED_PATH } from "./fixed-path.mjs";
import {
  estimateSpend,
  gradeAttempt,
  measurementFailure,
  renderEvidence,
  stratify,
  summarizeRuns,
} from "./completion-gate-lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PINNED_MODEL = "gpt-oss-120b";
const CHILD_TIMEOUT_MS = 2_400_000;
/**
 * The bar a release must clear. Deliberately NOT 100%: `incomplete-never-clean` is a correctness
 * property, and an engine that genuinely cannot finish a file should say so. But a reviewer nobody
 * can trust to finish is worth nothing regardless of how honest each label is, so the bar is high
 * and explicit rather than absent. Raise it as the rate improves; never lower it silently.
 */
const DEFAULT_THRESHOLD = 0.8;
/**
 * The consumer's own ceiling, not the CLI's.
 *
 * `src/cli.ts` defaults `--token-budget` to 2,000,000 because that is a sensible ceiling for a
 * developer reviewing their own working copy. Keiko's workflow passes 6,000,000. Measuring
 * completion under the smaller number manufactures `budget_exceeded` settlements production would
 * never have had — the gate's own first run produced exactly one, at 4.66M spent against a 2M
 * allotment, and it would have been read as a product failure rather than a harness artifact. A
 * completion rate is only meaningful under the budget the reviewed pull request actually gets.
 */
const CONSUMER_TOKEN_BUDGET = 6_000_000;

function fail(message) {
  console.error(`completion-gate: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    repo: undefined,
    prs: [],
    runs: 1,
    base: "origin/dev",
    threshold: DEFAULT_THRESHOLD,
    tokenBudget: CONSUMER_TOKEN_BUDGET,
    dryRun: false,
    evidence: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${token} requires a value`);
      i += 1;
      return value;
    };
    if (token === "--repo") args.repo = next();
    else if (token === "--pr") args.prs.push(Number(next()));
    else if (token === "--runs") args.runs = Number(next());
    else if (token === "--base") args.base = next();
    else if (token === "--threshold") args.threshold = Number(next());
    else if (token === "--token-budget") args.tokenBudget = Number(next());
    else if (token === "--evidence") args.evidence = next();
    else if (token === "--dry-run") args.dryRun = true;
    else fail(`unknown option: ${token}`);
  }
  assertArgs(args);
  return args;
}

/** Bounds, split from the token loop above so each half stays readable on its own. */
function assertArgs(args) {
  if (args.repo === undefined) fail("--repo <consumer-checkout> is required");
  if (args.prs.length === 0) fail("at least one --pr <number> is required");
  if (args.prs.some((pr) => !Number.isInteger(pr) || pr < 1)) {
    fail("--pr must be a positive integer");
  }
  // The old ceiling of 5 made a conclusive result unreachable by construction: against an 80%
  // threshold the interval's lower bound only clears the bar at about twenty flawless runs, so a
  // gate capped at five could report nothing but INCONCLUSIVE forever. Twenty-five is a real
  // bound against a typo, not a policy about how much evidence is enough.
  if (!Number.isInteger(args.runs) || args.runs < 1 || args.runs > 25) {
    fail("--runs must be an integer between 1 and 25");
  }
  if (args.threshold <= 0 || args.threshold > 1) fail("--threshold must be in (0, 1]");
  if (!Number.isInteger(args.tokenBudget) || args.tokenBudget < 1) {
    fail("--token-budget must be a positive integer");
  }
}

function assertModelEnv(env) {
  for (const name of [
    "KFQ_MODEL_ENDPOINT",
    "KFQ_MODEL_ID",
    "KFQ_MODEL_PROTOCOL",
    "KFQ_MODEL_TOKEN_ENV",
  ]) {
    if (env[name] === undefined || env[name] === "") fail(`${name} is not set`);
  }
  if (env[env.KFQ_MODEL_TOKEN_ENV] === undefined || env[env.KFQ_MODEL_TOKEN_ENV] === "") {
    fail(`the credential variable named by KFQ_MODEL_TOKEN_ENV is empty`);
  }
  if (env.KFQ_MODEL_ID !== PINNED_MODEL && env.OCR_ALLOW_MODEL_DEVIATION !== "1") {
    fail(`KFQ_MODEL_ID is ${env.KFQ_MODEL_ID}, but every measurement here runs ${PINNED_MODEL}`);
  }
}

/** Same posture as every other corpus harness: fixed PATH, consumer hooks neutralised. The
 *  consumer checkout is untrusted input and this process carries the model credential. */
function git(repoPath, gitArgs) {
  return execFileSync("git", ["-C", repoPath, "-c", "core.hooksPath=/dev/null", ...gitArgs], {
    encoding: "utf8",
    env: { PATH: FIXED_PATH },
  }).trim();
}

/** Resolves one pull request into the pair the CLI reviews, plus its size. */
function resolveTarget(repoPath, prNumber, baseRef) {
  const ref = `pr-completion-${String(prNumber)}`;
  try {
    git(repoPath, [
      "fetch",
      "--quiet",
      "--force",
      "origin",
      `pull/${String(prNumber)}/head:${ref}`,
    ]);
  } catch {
    fail(`could not fetch pull/${String(prNumber)}/head from origin in ${repoPath}`);
  }
  const head = git(repoPath, ["rev-parse", ref]);
  const base = git(repoPath, ["merge-base", baseRef, ref]);
  const files = git(repoPath, ["diff", "--name-only", `${base}..${head}`])
    .split("\n")
    .filter((line) => line !== "").length;
  // Changed lines, not just file count: size classes are keyed on lines because that is the
  // dimension the literature measures detection against, and because two twelve-file changes can
  // differ by an order of magnitude in what the reviewer actually has to read.
  const numstat = git(repoPath, ["diff", "--numstat", `${base}..${head}`]);
  // `undefined`, not a number, when any file in the range is binary. `--numstat` writes `-` for
  // both counts there, and `Number("-") || 0` would quietly call that file zero lines — putting a
  // change that may be enormous into the smallest size class and reporting its completion under a
  // heading it does not belong to. An unmeasurable size is unmeasurable; the one thing this gate
  // must never do is answer a question it cannot compute. Raised by CodeRabbit on KfQ#164.
  let changedLines = 0;
  for (const line of numstat.split("\n")) {
    if (line === "") continue;
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") {
      changedLines = undefined;
      break;
    }
    changedLines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  return { label: `PR #${String(prNumber)}`, prNumber, head, base, files, changedLines };
}

/**
 * The review profile, taken from the BASE and written beside the worktree.
 *
 * The gate used to let the CLI find the profile inside the checked-out candidate, which was wrong
 * twice over. Practically: two pull requests in the first full-spectrum run predate the profile
 * existing in that repository at all, so both failed with "cannot read profile" and were scored as
 * measurement failures rather than as the completions they would have been. Structurally, and
 * worse: production reads the profile from the protected base — that is the whole point of
 * `pull_request_target` — so a harness reading it from the candidate is not measuring the product,
 * it is measuring a configuration the candidate controls.
 *
 * `undefined` when the base has no profile either; the caller then lets the CLI use its default,
 * because a base without a profile is a real configuration rather than a harness failure.
 */
function baseProfilePath(repoPath, base, workDir) {
  const target = join(workDir, "base-profile.json");
  try {
    writeFileSync(target, git(repoPath, ["show", `${base}:${PROFILE_IN_REPO}`]), "utf8");
    return target;
  } catch {
    return undefined;
  }
}

/** Where a consumer's review profile lives, by the convention the action's own default names. */
const PROFILE_IN_REPO = ".github/keiko-for-quality.json";

/** One CLI run against one target; never throws — an unusable run becomes a measurement failure
 *  rather than an incomplete, so a broken harness cannot masquerade as a broken product. */
function runOnce(target, repoPath, workDir, index, tokenBudget, profilePath, diagnosticsDir) {
  const worktree = join(workDir, `wt-${String(index)}`);
  const reportPath = join(workDir, `report-${String(index)}.json`);
  try {
    git(repoPath, ["worktree", "add", "--detach", "--quiet", worktree, target.head]);
  } catch (error) {
    return measurementFailure(`worktree add failed: ${String(error)}`);
  }
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        join(ROOT, "scripts/register-ts-hooks.mjs"),
        "--experimental-strip-types",
        join(ROOT, "src/cli.ts"),
        "--repo",
        worktree,
        "--base",
        target.base,
        "--head",
        target.head,
        "--format",
        "json",
        "--out",
        reportPath,
        // Production parity — see CONSUMER_TOKEN_BUDGET.
        "--token-budget",
        String(tokenBudget),
        // From the BASE, never the candidate — see `baseProfilePath`. Omitted when the base has
        // none, so the CLI falls back to its own default rather than being handed a path to
        // nothing.
        ...(profilePath === undefined ? [] : ["--profile", profilePath]),
      ],
      // stderr is CAPTURED, not inherited: `src/cli.ts` writes every diagnostic line there
      // (`boundRunLocalReview`), and three separate multi-million-token measurements were reduced
      // to a headline number because that stream went to a terminal which kept only its tail. The
      // counts inside it — searches per file, tool calls, subtask errors — are the only evidence
      // that says WHY a review did not finish. A run this expensive should leave evidence, not a
      // verdict.
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "inherit", "pipe"],
        timeout: CHILD_TIMEOUT_MS,
      },
    );
    if (typeof child.stderr === "string") {
      if (diagnosticsDir !== undefined) {
        writeFileSync(
          join(diagnosticsDir, `pr${String(target.prNumber)}-run${String(index)}.jsonl`),
          child.stderr,
        );
      }
      // Capturing must not silence a failure. Diagnostics are JSON objects, one per line; anything
      // else the CLI said is a message meant for a person and is passed through, whether or not a
      // diagnostics directory exists to keep the rest.
      const spoken = child.stderr
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("{"));
      if (spoken.length > 0) process.stderr.write(`${spoken.join("\n")}\n`);
    }
    if (child.status === null) return measurementFailure("review CLI was killed or timed out");
    try {
      return gradeAttempt(JSON.parse(readFileSync(reportPath, "utf8")));
    } catch (error) {
      return measurementFailure(
        `no gradeable report (exit ${String(child.status)}): ${String(error)}`,
      );
    }
  } finally {
    git(repoPath, ["worktree", "remove", "--force", worktree]);
  }
}

function runTarget(target, repoPath, runs, tokenBudget, diagnosticsDir) {
  const workDir = mkdtempSync(join(tmpdir(), `kfq-completion-${String(target.prNumber)}-`));
  const profilePath = baseProfilePath(repoPath, target.base, workDir);
  const attempts = [];
  try {
    for (let index = 1; index <= runs; index += 1) {
      console.error(`completion-gate: ${target.label} run ${String(index)}/${String(runs)}`);
      const attempt = runOnce(
        target,
        repoPath,
        workDir,
        index,
        tokenBudget,
        profilePath,
        diagnosticsDir,
      );
      attempts.push(attempt);
      const why = attempt.reason === undefined ? "" : ` (${attempt.reason})`;
      console.error(
        `completion-gate: ${target.label} run ${String(index)} — ${attempt.outcome}${why}, ` +
          `reviewed ${String(attempt.reviewed)}/${String(attempt.reviewable)}`,
      );
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return { label: target.label, attempts };
}

/** The gate's own checkout — a dirty tree measures a state no release can reproduce. */
function reviewerTreeIdentity() {
  try {
    const head = git(ROOT, ["rev-parse", "HEAD"]);
    const dirty = git(ROOT, ["status", "--porcelain"]) !== "";
    return `${head.slice(0, 12)}${dirty ? " (DIRTY — not release evidence)" : " (clean)"}`;
  } catch {
    return "unknown (not a git checkout — not release evidence)";
  }
}

function printPlan(targets, args, estimate) {
  console.error("");
  console.error("COMPLETION GATE — PLAN");
  console.error("");
  for (const target of targets) {
    console.error(
      `  ${target.label}: ${String(target.files)} files, ` +
        `${String(target.changedLines)} changed lines, ` +
        `${target.base.slice(0, 12)}..${target.head.slice(0, 12)}`,
    );
  }
  console.error("");
  console.error(
    `  runs per target: ${String(args.runs)}   threshold: ${String(args.threshold)}   ` +
      `token budget: ${args.tokenBudget.toLocaleString("en-US")}`,
  );
  console.error(
    `  estimated spend: ${estimate.low.toLocaleString("en-US")}-` +
      `${estimate.high.toLocaleString("en-US")} tokens ` +
      `(${String(estimate.files)} files x ${String(estimate.runs)} run(s), measured band from Keiko#3011)`,
  );
  console.error("");
  console.error("  This is real money against a real endpoint. A rate is only as trustworthy as");
  console.error("  the number of runs behind it — but every run is a full-size review.");
  console.error("");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun) assertModelEnv(process.env);

  const targets = args.prs.map((pr) => resolveTarget(args.repo, pr, args.base));
  const estimate = estimateSpend(targets, args.runs);
  printPlan(targets, args, estimate);
  if (args.dryRun) {
    console.error("completion-gate: --dry-run, nothing spent.");
    return;
  }

  // Raw diagnostics land beside the evidence, because the evidence is a summary and a summary is
  // not re-analysable. Three measurements costing 21.7M, 12.5M and 2.2M tokens were each reduced to
  // a rate before anyone could ask WHY — the per-file search counts that answer it had gone to a
  // terminal and been truncated. Written only when `--evidence` names a home for them; without one
  // there is nowhere durable to put them and the run keeps its old behaviour.
  const diagnosticsDir = args.evidence === undefined ? undefined : `${args.evidence}.diagnostics`;
  if (diagnosticsDir !== undefined) mkdirSync(diagnosticsDir, { recursive: true });

  // `changedLines` is carried onto the result, not left on the target, because `stratify` groups
  // results and a class it cannot read collapses every run into one bucket — which is exactly what
  // happened on the first full-spectrum run: the table was suppressed and the measurement lost the
  // dimension it was taken to answer.
  const results = targets.map((target) => ({
    ...runTarget(target, args.repo, args.runs, args.tokenBudget, diagnosticsDir),
    changedLines: target.changedLines,
  }));
  const summary = summarizeRuns(
    results.flatMap((result) => result.attempts),
    args.threshold,
  );

  const evidence = renderEvidence({
    dateIso: new Date().toISOString().slice(0, 10),
    gateVersion: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
    reviewerTree: reviewerTreeIdentity(),
    model: `${process.env.KFQ_MODEL_ID} (${process.env.KFQ_MODEL_PROTOCOL})`,
    targets,
    results,
    summary,
    strata: stratify(results, args.threshold),
  });
  if (args.evidence !== undefined) {
    writeFileSync(args.evidence, `${evidence}\n`, "utf8");
    console.error(`completion-gate: evidence written to ${args.evidence}`);
  }
  console.log(evidence);
  process.exitCode = summary.green ? 0 : 1;
}

main();
