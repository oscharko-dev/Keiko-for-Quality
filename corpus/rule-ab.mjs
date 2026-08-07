#!/usr/bin/env node
// Rule A/B — `node corpus/rule-ab.mjs --arm-a <checkout> --arm-b <checkout> [--case <id>]... [--reps 3]`
//
// Answers one question the full qualification cannot: did a rule-text change move a case, or did
// the deployment roam? A single full wave costs ~1.7M tokens and answers it badly — the difference
// between two waves is routinely one case, and this corpus has two documented rotators
// (`workflow-head-checkout`, `unevidenced-claim`) that flip under a byte-identical rule. A wave
// therefore cannot distinguish a real regression from a coin landing the other way, which makes
// every "optimization" judged by wave-to-wave deltas a guess wearing a number.
//
// Three things make this instrument answer it instead:
//
//   PAIRED — the same case runs under both arms, so case difficulty cancels out. Waves compare
//   aggregates over different roulette spins; this compares a case against itself.
//
//   REPEATED — each pairing runs `--reps` times per arm. One observation per arm cannot tell a
//   rotator from an effect, and this file refuses to pretend otherwise: a case is only reported as
//   MOVED when one arm is unanimous across every repetition and the other is unanimously the
//   opposite. Everything between is ROTATOR — named, never averaged into a headline.
//
//   INTERLEAVED — A and B alternate within each repetition rather than running as two blocks. The
//   serving variance documented across this project drifts over a session; two blocks would hand
//   the whole drift to one arm, and the drift is the same size as the effect being measured.
//
// THIS SCRIPT SPENDS REAL MONEY, though far less than a wave: roughly 20k-140k tokens per case per
// arm per repetition. `--dry-run` prints the plan and the forecast without contacting a model; use
// it first. AGENTS.md's "commands spend real money" section governs this file.
//
// Both arms are ordinary checkouts of this repository. They differ in whatever you are testing —
// usually `src/engine/rule-file.ts`. Nothing here edits either one; a checkout that is dirty is
// measured as it stands, and its rule digest is recorded so the evidence says what actually ran.
//
// Exit codes: 0 — ran and reported. 2 — could not measure (usage error, missing env, no arm).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CASES } from "./cases.mjs";
import { FIXED_PATH } from "./fixed-path.mjs";
import { MEASURED_BAND, renderAbEvidence, settlePairing, summarizeAb } from "./rule-ab-lib.mjs";

const PINNED_MODEL = "gpt-oss-120b";
/** One case, one arm, one repetition. Generous: a multi-file case has run to 140k. */
const CASE_TIMEOUT_MS = 900_000;

function fail(message) {
  console.error(`rule-ab: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    armA: undefined,
    armB: undefined,
    cases: [],
    reps: 3,
    evidence: undefined,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${token} requires a value`);
      i += 1;
      return value;
    };
    if (token === "--arm-a") args.armA = next();
    else if (token === "--arm-b") args.armB = next();
    else if (token === "--case") args.cases.push(next());
    else if (token === "--reps") args.reps = Number(next());
    else if (token === "--evidence") args.evidence = next();
    else if (token === "--dry-run") args.dryRun = true;
    else fail(`unknown option: ${token}`);
  }
  assertArgs(args);
  return args;
}

/** Bounds, split from the token loop so each half stays readable on its own. */
function assertArgs(args) {
  if (args.armA === undefined || args.armB === undefined) {
    fail("--arm-a <checkout> and --arm-b <checkout> are both required");
  }
  if (args.armA === args.armB)
    fail("--arm-a and --arm-b are the same checkout; nothing to compare");
  // Two is the smallest number that can show a case flipping at all, and a flip is the finding
  // this instrument exists to report rather than hide. One repetition would make every rotator
  // look like an effect — the exact failure that motivated this file.
  if (!Number.isInteger(args.reps) || args.reps < 2 || args.reps > 10) {
    fail("--reps must be an integer between 2 and 10");
  }
  const known = new Set(CASES.map((c) => c.id));
  for (const id of args.cases) if (!known.has(id)) fail(`unknown case: ${id}`);
}

function assertModelEnv(env) {
  for (const name of ["OCR_BINARY", "OCR_LLM_URL", "OCR_LLM_TOKEN", "OCR_LLM_MODEL"]) {
    if (env[name] === undefined || env[name] === "") fail(`${name} is not set`);
  }
  if (env.OCR_LLM_MODEL !== PINNED_MODEL && env.OCR_ALLOW_MODEL_DEVIATION !== "1") {
    fail(`OCR_LLM_MODEL is ${env.OCR_LLM_MODEL}, but every measurement here runs ${PINNED_MODEL}`);
  }
}

/** The rule digest a checkout would actually send, so evidence names what ran, not what was meant. */
function ruleDigestOf(checkout, workDir, env) {
  const probe = join(workDir, "probe.json");
  try {
    runCase(checkout, CASES[0].id, probe, env, true);
    return JSON.parse(readFileSync(probe, "utf8")).binding?.rule ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * One case, one arm. Returns the scored entry, or `undefined` when the run did not reach the model.
 *
 * A throw is NOT an observation: `corpus/run.mjs` distinguishes "the reviewer missed it" from "the
 * connection did", and collapsing the two here would let a flaky endpoint read as a rule effect.
 */
function runCase(checkout, caseId, reportPath, env, probeOnly = false) {
  const result = execFileSync(
    "node",
    [join(checkout, "corpus", "run.mjs"), "--only", caseId, ...(probeOnly ? ["--dry-run"] : [])],
    {
      cwd: checkout,
      encoding: "utf8",
      timeout: CASE_TIMEOUT_MS,
      env: { ...env, PATH: FIXED_PATH, OCR_REPORT: reportPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return result;
}

function observe(checkout, caseId, workDir, env, label) {
  const reportPath = join(workDir, `${label}.json`);
  try {
    runCase(checkout, caseId, reportPath, env);
  } catch {
    // `run.mjs` exits non-zero on a failed case, which is a legitimate observation, so the report
    // is the authority rather than the exit code. Only an unreadable report means "no observation".
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (report.measured !== true) return undefined;
    const scored = report.results?.[0];
    if (scored === undefined) return undefined;
    return {
      pass: scored.pass === true,
      classified: scored.classified === true,
      tokens: scored.tokens ?? 0,
    };
  } catch {
    return undefined;
  }
}

const args = parseArgs(process.argv.slice(2));
const selected = args.cases.length > 0 ? args.cases : CASES.map((c) => c.id);

if (args.dryRun) {
  const runs = selected.length * 2 * args.reps;
  console.log(`  arm A: ${args.armA}`);
  console.log(`  arm B: ${args.armB}`);
  console.log(
    `  cases: ${String(selected.length)}   reps: ${String(args.reps)}   runs: ${String(runs)}`,
  );
  console.log(
    `  estimated spend: ${(runs * MEASURED_BAND.low).toLocaleString("en-US")}-` +
      `${(runs * MEASURED_BAND.high).toLocaleString("en-US")} tokens`,
  );
  console.log("\nrule-ab: --dry-run, nothing spent.");
  process.exit(0);
}

assertModelEnv(process.env);
const workDir = mkdtempSync(join(tmpdir(), "kfq-rule-ab-"));
const observations = new Map(selected.map((id) => [id, { a: [], b: [] }]));

try {
  // Interleaved: rep-major, and within a rep the arms alternate per case. A block design would
  // hand a session's serving drift to whichever arm ran second.
  for (let rep = 0; rep < args.reps; rep += 1) {
    for (const caseId of selected) {
      const slot = observations.get(caseId);
      slot.a.push(observe(args.armA, caseId, workDir, process.env, `a-${caseId}-${String(rep)}`));
      slot.b.push(observe(args.armB, caseId, workDir, process.env, `b-${caseId}-${String(rep)}`));
      const settled = settlePairing(caseId, slot.a, slot.b);
      console.log(
        `${settled.verdict.padEnd(10)} ${caseId.padEnd(38)} ` +
          `A ${String(settled.aPassed)}/${String(settled.aObserved)}  ` +
          `B ${String(settled.bPassed)}/${String(settled.bObserved)}  ` +
          `(rep ${String(rep + 1)}/${String(args.reps)})`,
      );
    }
  }

  const pairings = selected.map((id) =>
    settlePairing(id, observations.get(id).a, observations.get(id).b),
  );
  const summary = summarizeAb(pairings);
  const evidence = renderAbEvidence({
    armA: { path: args.armA, ruleDigest: ruleDigestOf(args.armA, workDir, process.env) },
    armB: { path: args.armB, ruleDigest: ruleDigestOf(args.armB, workDir, process.env) },
    reps: args.reps,
    pairings,
    summary,
  });
  console.log(`\n${evidence}`);
  if (args.evidence !== undefined) {
    writeFileSync(args.evidence, evidence);
    console.log(`evidence       ${args.evidence}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
