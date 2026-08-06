#!/usr/bin/env node
// Consumer-seed release gate — `npm run corpus:seed -- --repo <consumer-checkout>`.
//
// Plants each seed case (corpus/seed-gate-cases.mjs) as one local commit on top of the consumer
// repository's base ref, runs the SHIPPED local CLI (`src/cli.ts`, the same invocation
// `npm run review` performs) against that commit, and grades the report with
// corpus/seed-gate-lib.mjs. The question this answers before a release is the one the corpus
// cannot: does the reviewer that is about to ship find a known defect planted in the consumer's
// own production code, through the exact process surface a consumer runs?
//
// THIS SCRIPT SPENDS REAL MONEY — one model-backed review per attempt, up to `--attempts` per
// case (default 2: single runs demonstrably rotate under serving variance; any-attempt-found is
// the same policy the qualification's isolated-opinion re-runs apply). It is not part of
// `verify` and must never be: AGENTS.md's "commands spend real money" section governs it.
//
// Nothing is pushed anywhere. Seed commits are created unsigned (`-c commit.gpgsign=false`) in
// throwaway worktrees of the consumer checkout and removed afterwards (`--keep` preserves them
// for debugging a miss). The consumer repository's own checkout is never touched.
//
// Exit codes: 0 — gate green (every required case passed). 1 — gate red. 2 — the gate could not
// measure (usage error, missing model env, stale seed, git failure): fix the setup, then rerun.
//
// Environment: the CLI's own contract — KFQ_MODEL_ENDPOINT, KFQ_MODEL_ID, KFQ_MODEL_PROTOCOL,
// KFQ_MODEL_TOKEN_ENV (the NAME of the variable holding the credential). KFQ_MODEL_ID must be
// gpt-oss-120b (AGENTS.md: every measurement this repository records is pinned to it);
// OCR_ALLOW_MODEL_DEVIATION=1 is the deliberate-experiment escape hatch and is recorded in the
// gate's own binding line when used.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXED_PATH } from "./fixed-path.mjs";
import { SEED_CASES } from "./seed-gate-cases.mjs";
import {
  applySeed,
  assertSeedCaseShape,
  evaluateAttempt,
  renderEvidence,
  settleCase,
  summarizeGate,
} from "./seed-gate-lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PINNED_MODEL = "gpt-oss-120b";
const MAX_ATTEMPTS_CEILING = 5;
// The CLI's own default review ceiling is 1800s; the child gets that plus margin before the
// gate declares the measurement failed rather than waiting forever on a wedged process.
const CHILD_TIMEOUT_MS = 2_100_000;

function fail(message) {
  console.error(`seed-gate: ${message}`);
  process.exit(2);
}

function parseGateArgs(argv) {
  const args = {
    repo: undefined,
    cases: [],
    attempts: 2,
    base: "origin/dev",
    keep: false,
    fetch: true,
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
    else if (token === "--case") args.cases.push(next());
    else if (token === "--attempts") args.attempts = Number(next());
    else if (token === "--base") args.base = next();
    else if (token === "--evidence") args.evidence = next();
    else if (token === "--keep") args.keep = true;
    else if (token === "--no-fetch") args.fetch = false;
    else fail(`unknown option: ${token}`);
  }
  if (args.repo === undefined) fail("--repo <consumer-checkout> is required");
  if (
    !Number.isInteger(args.attempts) ||
    args.attempts < 1 ||
    args.attempts > MAX_ATTEMPTS_CEILING
  ) {
    fail(`--attempts must be an integer between 1 and ${String(MAX_ATTEMPTS_CEILING)}`);
  }
  return args;
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
  const tokenEnvName = env.KFQ_MODEL_TOKEN_ENV;
  if (env[tokenEnvName] === undefined || env[tokenEnvName] === "") {
    fail(`the credential variable named by KFQ_MODEL_TOKEN_ENV (${tokenEnvName}) is empty`);
  }
  if (env.KFQ_MODEL_ID !== PINNED_MODEL && env.OCR_ALLOW_MODEL_DEVIATION !== "1") {
    fail(
      `KFQ_MODEL_ID is ${env.KFQ_MODEL_ID}, but every measurement this repository records runs ` +
        `${PINNED_MODEL} (AGENTS.md). Set OCR_ALLOW_MODEL_DEVIATION=1 only for a deliberate experiment.`,
    );
  }
}

/** Every git subprocess runs under `FIXED_PATH` (corpus/fixed-path.mjs, Sonar S4036) — the same
 *  posture every other corpus harness holds, and load-bearing here too: this process carries the
 *  model credential in its environment. The consumer repository must be reachable anonymously
 *  (Keiko is public); a stripped environment deliberately loads no credential helper. */
function git(repoPath, gitArgs) {
  return execFileSync("git", ["-C", repoPath, ...gitArgs], {
    encoding: "utf8",
    env: { PATH: FIXED_PATH },
  }).trim();
}

/** `origin/dev` → fetch `dev` from `origin` so the base is current; anything without a
 *  remote/branch shape (a sha, a local branch) is used as-is. */
function refreshBase(repoPath, baseRef, fetch) {
  const slash = baseRef.indexOf("/");
  if (fetch && slash > 0) {
    const remote = baseRef.slice(0, slash);
    const branch = baseRef.slice(slash + 1);
    try {
      git(repoPath, ["fetch", "--quiet", remote, branch]);
    } catch {
      fail(`could not fetch ${branch} from ${remote} in ${repoPath} (use --no-fetch to skip)`);
    }
  }
  try {
    return git(repoPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  } catch {
    fail(`base ref ${baseRef} does not resolve in ${repoPath}`);
  }
}

/** One seeded commit in a throwaway worktree; returns its absolute path. */
function plantSeed(repoPath, baseSha, seedCase, workDir) {
  const worktree = join(workDir, "worktree");
  git(repoPath, ["worktree", "add", "--detach", "--quiet", worktree, baseSha]);
  const filePath = join(worktree, seedCase.file);
  const applied = applySeed(readFileSync(filePath, "utf8"), seedCase);
  if (!applied.ok) {
    git(repoPath, ["worktree", "remove", "--force", worktree]);
    fail(`${seedCase.id}: ${applied.reason}`);
  }
  writeFileSync(filePath, applied.content, "utf8");
  git(worktree, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=kfq-seed-gate",
    "-c",
    "user.email=seed-gate@invalid",
    "commit",
    "--all",
    "--quiet",
    "-m",
    `seed(${seedCase.id}): plant tier-${String(seedCase.tier)} defect`,
  ]);
  return { worktree, seedRange: applied };
}

/**
 * One attempt = one child CLI run, mirroring package.json's `review` script invocation exactly
 * (node --import register-ts-hooks --experimental-strip-types src/cli.ts) — change one only with
 * the other. Returns the parsed report, or undefined when the child failed in a way a retry is
 * allowed to absorb (an incomplete settlement still yields its report and is graded normally).
 */
function runReviewAttempt(worktree, baseSha, reportPath) {
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
      baseSha,
      "--head",
      "HEAD",
      "--format",
      "json",
      "--out",
      reportPath,
    ],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], timeout: CHILD_TIMEOUT_MS },
  );
  if (child.error !== undefined) fail(`could not run the review CLI: ${child.error.message}`);
  // 0 complete-clean, 1 complete-with-findings, 2 incomplete: all three leave a report to grade.
  // 3+ (abandoned locally is impossible, usage, internal) means the measurement itself broke.
  if (child.status === null || child.status > 2) {
    fail(`review CLI exited with ${String(child.status)} — the gate cannot measure this setup`);
  }
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    fail(`review CLI exit ${String(child.status)} left no parseable report at ${reportPath}`);
  }
}

function runCase(repoPath, baseSha, seedCase, attempts, keep) {
  const workDir = mkdtempSync(join(tmpdir(), `kfq-seed-${seedCase.id}-`));
  const { worktree, seedRange } = plantSeed(repoPath, baseSha, seedCase, workDir);
  const graded = [];
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      console.error(`seed-gate: ${seedCase.id} attempt ${String(attempt)}/${String(attempts)}`);
      const report = runReviewAttempt(
        worktree,
        baseSha,
        join(workDir, `report-${String(attempt)}.json`),
      );
      const grade = evaluateAttempt(report, seedCase, seedRange);
      graded.push(grade);
      console.error(
        `seed-gate: ${seedCase.id} attempt ${String(attempt)} — outcome ${grade.outcome}, ` +
          `${String(grade.fileFindingCount)} finding(s) in seeded file, noise ${String(grade.noiseCount)}`,
      );
      if (grade.found) break;
    }
  } finally {
    if (keep) {
      console.error(`seed-gate: ${seedCase.id} — worktree kept at ${worktree}`);
    } else {
      git(repoPath, ["worktree", "remove", "--force", worktree]);
      rmSync(workDir, { recursive: true, force: true });
    }
  }
  return settleCase(seedCase, graded);
}

function main() {
  const args = parseGateArgs(process.argv.slice(2));
  assertModelEnv(process.env);
  const allCases = assertSeedCaseShape(SEED_CASES);
  const selected =
    args.cases.length === 0
      ? allCases
      : allCases.filter((seedCase) => args.cases.includes(seedCase.id));
  if (selected.length === 0)
    fail(`--case matched nothing; known: ${allCases.map((c) => c.id).join(", ")}`);

  const deviated = process.env.KFQ_MODEL_ID !== PINNED_MODEL;
  console.error(
    `seed-gate: binding — model ${process.env.KFQ_MODEL_ID} (${process.env.KFQ_MODEL_PROTOCOL})` +
      `${deviated ? " [MODEL DEVIATION — not a recordable measurement]" : ""}, ` +
      `cases ${selected.map((c) => c.id).join(", ")}, attempts ${String(args.attempts)}`,
  );

  const baseSha = refreshBase(args.repo, args.base, args.fetch);
  const caseResults = selected.map((seedCase) =>
    runCase(args.repo, baseSha, seedCase, args.attempts, args.keep),
  );
  const summary = summarizeGate(caseResults);

  const gateVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const evidence = renderEvidence({
    dateIso: new Date().toISOString().slice(0, 10),
    gateVersion,
    model: `${process.env.KFQ_MODEL_ID} (${process.env.KFQ_MODEL_PROTOCOL})`,
    base: `${args.base} @ ${baseSha.slice(0, 12)}`,
    caseResults,
    summary,
  });
  if (args.evidence !== undefined) {
    writeFileSync(args.evidence, `${evidence}\n`, "utf8");
    console.error(`seed-gate: evidence written to ${args.evidence}`);
  }
  console.log(evidence);
  process.exitCode = summary.green ? 0 : 1;
}

main();
