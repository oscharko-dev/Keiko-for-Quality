#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { CASES } from "./cases.mjs";

/**
 * The operating-point sweep — corpus/run.mjs, once per `KFQ_SUBSTANTIATION_STRICTNESS` level.
 *
 * McAleese et al. 2024 (arXiv:2407.00215, CriticGPT) treat bug coverage and hallucination/nitpick
 * rate as a Pareto curve a deployer chooses a point on, not a fixed setting — Force Sampling Beam
 * Search exposes four operating points at deployment time. `src/publish/substantiate.ts`'s judge
 * drops vague/unsupported/nitpick findings; it IS an operating point on exactly that curve, chosen
 * once, implicitly, and never measured since. This script is the instrument that measures it: the
 * same qualification corpus, run once per strictness level, precision and recall read off each run
 * and set side by side.
 *
 * ## Read this before spending anything
 *
 * Staged qualification now enters through `performLocalReview`, the same production-local
 * pipeline as the CLI: generation, Truth/Challenge/Falsifier verification, classification audit,
 * deterministic gates, sanitization, and deduplication. `KFQ_SUBSTANTIATION_STRICTNESS` therefore
 * reaches the real verifier and each stage is a genuine operating-point sample. It is still only
 * one nondeterministic sample per stage; differences smaller than ordinary serving variance need
 * repeats before anyone treats them as a stable Pareto frontier.
 *
 * ## What this script does
 *
 * For each requested stage: spawn `node corpus/run.mjs` (optionally with `--only <id>`, forwarded
 * verbatim) with `KFQ_SUBSTANTIATION_STRICTNESS=<stage>` and a fresh `OCR_REPORT` path in the child
 * environment; read that report back; tally recall/precision/publishable/tokens exactly the way
 * `corpus/run.mjs`'s own closing scoreboard does, from the SAME `results[]` array it writes, never a
 * restatement of its grading rules. `run.mjs` itself is never edited, imported, or reimplemented —
 * only invoked, through its own documented `--only` flag and environment contract (see its header
 * comment). Every stage after the first re-generates the rule document and re-resolves the engine
 * binary independently (run.mjs does this on every invocation regardless of caller), so stages are
 * fully isolated child processes, never a shared warm state that could leak between them.
 *
 * ## Cost, and the guardrails around it
 *
 * The final generation-only staged attempts used roughly 620k–660k tokens in about twelve minutes.
 * Production quality verification adds bounded model calls for surviving findings, so until a
 * complete production-path wave establishes a tighter observation this planner uses a conservative
 * 1.5M–3.5M-token / 75-minute forecast. It is a forecast, not an aggregate hard cap. Four stages
 * are four times the money and four times the wait. `estimateStageCost`/`buildPlan` compute and
 * `renderDryRunPlan` prints an
 * explicit estimate before a single stage runs, `--dry-run` stops there and spends nothing, `--only`
 * narrows every stage to one case (the exact fraction is derived from `CASES.length`), and
 * `--stages` narrows which levels run at all. None of this is optional politeness: `npm run corpus`
 * alone is already excluded from `verify` and gated on a human's explicit go-ahead (AGENTS.md,
 * "Four commands and one manual workflow spend real money"), and this script can spend up to four
 * times that in one invocation.
 *
 * ## Shape, mirroring corpus/seed-gate-lib.mjs
 *
 * Planning, cost estimation, per-stage aggregation, and every rendered document are pure functions,
 * exported for `corpus/operating-point-sweep.test.mjs` to hold with zero model calls and zero child
 * processes — canned report JSON in, a plan or a document out. This file's `run`/`main` (bottom of
 * the file) are where the only side effects live: spawning `node corpus/run.mjs`, reading and
 * deleting temp files, and writing the evidence document. The entry-point guard at the very bottom
 * (mirroring corpus/arena.mjs) is what makes importing this module for its pure functions safe: the
 * test file imports this file directly, and none of `run`/`main`/`runStage` executes on that import
 * — only on `node corpus/operating-point-sweep.mjs` itself.
 *
 * Usage:
 *   node corpus/operating-point-sweep.mjs [--stages lenient,default,strict,paranoid] [--only <id>]
 *     [--dry-run] [--evidence <path>]
 *
 * Same endpoint/model/rule environment contract as `corpus/run.mjs` (OCR_LLM_URL, OCR_LLM_TOKEN,
 * OCR_LLM_MODEL, OCR_RULE, OCR_ALLOW_MODEL_DEVIATION). This sweep owns the runner selection too:
 * every child receives `KFQ_SINGLE_SHOT=1`, regardless of the caller's environment, because the
 * plan and cost envelope below bind the staged runner rather than the classic binary. It also sets
 * `KFQ_SUBSTANTIATION_STRICTNESS` and a fresh `OCR_REPORT` per child, inheriting everything else.
 */

/**
 * Mirrors `SUBSTANTIATION_STRICTNESS_LEVELS` (`src/publish/substantiate.ts`) by value, not by
 * import. Importing the real export would mean loading `registerTsExtensionHooks()` and the TS
 * resolve machinery just to read a four-string array — a side effect on import that would make this
 * file unsafe for its own test suite to load, the exact problem the entry-point guard at the bottom
 * exists to avoid elsewhere in this file. `operating-point-sweep.test.mjs` pins these two arrays
 * against each other so the two cannot silently drift.
 */
export const STRICTNESS_LEVELS = ["lenient", "default", "strict", "paranoid"];

/** The knob's name, duplicated for the same reason `src/publish/substantiate.test.ts` duplicates it
 *  rather than importing it: `substantiate.ts`'s own doc comment says this name is deliberately not
 *  part of that module's public surface. */
export const STRICTNESS_ENV_VAR = "KFQ_SUBSTANTIATION_STRICTNESS";
export const SWEEP_RUNNER_MODE = "staged-single-shot";
export const SWEEP_RUNNER_ENV_VAR = "KFQ_SINGLE_SHOT";
export const SWEEP_RUNNER_ENV_VALUE = "1";

// Planning bounds anchored to the complete staged attempt recorded above. They are deliberately
// wider than that one observation to allow serving variance and the longer examiner contract; they
// are a forecast, not an observed minimum/maximum and not a hard spending cap.
export const FULL_CORPUS_TOKENS_LOW = 1_500_000;
export const FULL_CORPUS_TOKENS_HIGH = 3_500_000;
export const FULL_CORPUS_MINUTES = 75;

// Derived from the only case registry rather than copied from a historical scoreboard. This count
// changed twice while the old literal remained at 39, making every `--only` estimate understate its
// fraction of the current corpus.
export const FULL_CORPUS_CASE_COUNT = CASES.length;

export const USAGE =
  "usage: node corpus/operating-point-sweep.mjs " +
  "[--stages lenient,default,strict,paranoid] [--only <caseId>] [--dry-run] [--evidence <path>]";

/**
 * Parses argv into the sweep's own options, raising a plain `Error` on anything invalid rather than
 * calling `process.exit` itself — the same split arena.mjs's `parseArgs` uses, and for the same
 * reason: it is what lets a test call this function directly without being able to terminate the
 * test process out from under itself.
 */
export function parseArgs(argv) {
  const options = {
    stages: [...STRICTNESS_LEVELS],
    only: undefined,
    dryRun: false,
    evidence: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--stages") {
      options.stages = parseStagesValue(next());
    } else if (arg === "--only") {
      options.only = next();
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--evidence") {
      options.evidence = next();
    } else {
      throw new Error(`unknown option: ${arg}\n${USAGE}`);
    }
  }
  return options;
}

/** The `--stages` value's own grammar: comma-separated, whitespace-tolerant, case-insensitive,
 *  validated against the closed vocabulary immediately rather than left to fail later inside a
 *  spawned child — a typo here must cost nothing, the same posture `run.mjs`'s own model pin takes. */
function parseStagesValue(raw) {
  const requested = raw
    .split(",")
    .map((level) => level.trim().toLowerCase())
    .filter((level) => level !== "");
  if (requested.length === 0) throw new Error("--stages requires at least one level");
  for (const level of requested) {
    if (!STRICTNESS_LEVELS.includes(level)) {
      throw new Error(
        `--stages: unknown level "${level}" — choose from ${STRICTNESS_LEVELS.join(", ")}`,
      );
    }
  }
  // Canonical ordinal order, regardless of how the caller typed them, so the table and the plan
  // always read lenient -> paranoid: a Pareto curve out of order is harder to read, not a different
  // measurement.
  return STRICTNESS_LEVELS.filter((level) => requested.includes(level));
}

/**
 * The cost one stage is expected to spend. `only` narrows every stage to one case, so its estimate
 * is FULL_CORPUS divided by FULL_CORPUS_CASE_COUNT — an explicitly PROPORTIONAL derivation, flagged
 * as such in the return value, never presented as a measured per-case figure: real cases vary in
 * file count and in whether they trigger a resume, and this harness has no per-case token history to
 * draw on (that history lives in a real report's `results[].tokens`, produced only by running it).
 */
export function estimateStageCost(only) {
  const cases = only !== undefined ? 1 : FULL_CORPUS_CASE_COUNT;
  const fraction = cases / FULL_CORPUS_CASE_COUNT;
  return {
    cases,
    isProportional: only !== undefined,
    tokensLow: Math.round(FULL_CORPUS_TOKENS_LOW * fraction),
    tokensHigh: Math.round(FULL_CORPUS_TOKENS_HIGH * fraction),
    minutes: Math.round(FULL_CORPUS_MINUTES * fraction * 10) / 10,
  };
}

/** The whole run's plan: which stages, in what order, at what estimated total cost. Pure — no clock,
 *  no environment read, so a test can assert its exact shape without stubbing either. */
export function buildPlan(options) {
  const perStage = estimateStageCost(options.only);
  const stageCount = options.stages.length;
  return {
    runnerMode: SWEEP_RUNNER_MODE,
    stages: options.stages,
    only: options.only,
    perStage,
    totalTokensLow: perStage.tokensLow * stageCount,
    totalTokensHigh: perStage.tokensHigh * stageCount,
    totalMinutes: Math.round(perStage.minutes * stageCount * 10) / 10,
  };
}

function formatTokenRange(low, high) {
  const fmt = (n) => n.toLocaleString("en-US");
  return `${fmt(low)}-${fmt(high)}`;
}

/**
 * The plan and cost estimate — printed unconditionally at the start of every invocation, `--dry-run`
 * or not, and the ONLY thing `--dry-run` prints. Leads with the production-path scope and the
 * serving-variance warning before the price.
 */
export function renderDryRunPlan(plan) {
  const lines = [
    "OPERATING-POINT SWEEP — PLAN ONLY, NOTHING SPENT YET",
    "",
    "READ THIS FIRST: staged corpus/run.mjs enters through performLocalReview, so every stage",
    "measures the shipped Truth/Challenge/Falsifier verification path at the selected",
    "KFQ_SUBSTANTIATION_STRICTNESS. Each stage is still one serving sample; repeat before reading",
    "a small difference as a stable operating-point effect.",
    "",
    `stages (${String(plan.stages.length)}): ${plan.stages.join(" -> ")}`,
    plan.only !== undefined ? `only: ${plan.only}` : "only: (unset — full corpus per stage)",
    `runner: ${plan.runnerMode} (${SWEEP_RUNNER_ENV_VAR}=${SWEEP_RUNNER_ENV_VALUE}, pinned by this sweep)`,
    "",
    `per-stage estimate:   ${formatTokenRange(plan.perStage.tokensLow, plan.perStage.tokensHigh)} tokens, ~${String(plan.perStage.minutes)} min` +
      (plan.perStage.isProportional
        ? ` (PROPORTIONAL estimate: 1/${String(FULL_CORPUS_CASE_COUNT)} of a full run — see estimateStageCost's own doc comment)`
        : ` (${String(FULL_CORPUS_CASE_COUNT)} cases)`),
    `total for this plan:  ${formatTokenRange(plan.totalTokensLow, plan.totalTokensHigh)} tokens, ~${String(plan.totalMinutes)} min` +
      ` across ${String(plan.stages.length)} stage(s)`,
    "",
    'This is real money against a real endpoint (AGENTS.md, "Four commands and one manual workflow spend real money") —',
    "narrow with --only <caseId> for a cheap smoke test, or --stages to drop levels, before running",
    "the full plan. --dry-run (this output) never contacts a model.",
  ];
  return lines.join("\n");
}

/**
 * One stage's `corpus/run.mjs` report, read down to exactly what `corpus/run.mjs`'s own closing
 * scoreboard computes from the SAME `results[]` array — never a restatement of its grading rules,
 * just the same arithmetic applied to the same field. `kept`/`dropped_vague`/`dropped_unsupported`/
 * `dropped_nitpick` are deliberately absent from the return value: `corpus/run.mjs`'s report has no
 * such fields: the public qualification report exposes post-verification survivors and aggregate
 * suppression counters, not private per-finding judge dispositions. `buildSweepRows` renders their
 * absence as "n/a", never as a fabricated zero.
 */
/** Named apart from the template that uses it, so no template nests inside another (S4624). */
function describeScope(only) {
  return only === undefined ? "full corpus" : `--only ${only}`;
}

export function summarizeStageReport(report) {
  if (report?.measured !== true) {
    return {
      measured: false,
      reason: report?.reason ?? "report_unreadable",
      tokens: report?.tokens ?? 0,
    };
  }
  const results = report.results ?? [];
  const recallResults = results.filter((r) => r.kind === "recall");
  const precisionResults = results.filter((r) => r.kind === "precision");
  const found = recallResults.filter((r) => r.pass === true).length;
  const silent = precisionResults.filter((r) => r.pass === true).length;
  const publishableTotal = results.length;
  const publishableOk = results.filter((r) => (r.rejected?.length ?? 0) === 0).length;
  return {
    measured: true,
    seeded: recallResults.length,
    found,
    clean: precisionResults.length,
    silent,
    publishableOk,
    publishableTotal,
    recall: recallResults.length > 0 ? found / recallResults.length : null,
    precision: precisionResults.length > 0 ? silent / precisionResults.length : null,
    tokens: report.tokens ?? 0,
    binding: report.binding,
  };
}

function formatPercent(fraction) {
  return fraction === null || fraction === undefined ? "n/a" : `${(fraction * 100).toFixed(1)}%`;
}

const NOT_MEASURED_BY_THIS_HARNESS = "n/a*";

/** One row per stage, ready for `renderSweepTable`/`renderEvidenceMarkdown` — the shape a test can
 *  assert against canned `summarizeStageReport` output, with no report-shape knowledge of its own. */
export function buildSweepRows(stageSummaries) {
  return stageSummaries.map(({ stage, summary }) => ({
    stage,
    measured: summary.measured,
    found: summary.measured ? `${String(summary.found)}/${String(summary.seeded)}` : "n/a",
    silent: summary.measured ? `${String(summary.silent)}/${String(summary.clean)}` : "n/a",
    recall: summary.measured ? formatPercent(summary.recall) : "n/a",
    precision: summary.measured ? formatPercent(summary.precision) : "n/a",
    kept: NOT_MEASURED_BY_THIS_HARNESS,
    droppedVague: NOT_MEASURED_BY_THIS_HARNESS,
    droppedUnsupported: NOT_MEASURED_BY_THIS_HARNESS,
    droppedNitpick: NOT_MEASURED_BY_THIS_HARNESS,
    tokens: summary.tokens,
  }));
}

function renderMarkdownTable(headers, rows) {
  const headerLine = `| ${headers.join(" | ")} |`;
  const dividerLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, dividerLine, ...bodyLines].join("\n");
}

/** The table itself: stage x (found/seeded, silent/clean, recall%, precision%, the four
 *  substantiation buckets — always "n/a*" here, see the module doc comment — and spend). */
export function renderSweepTable(rows) {
  const headers = [
    "stage",
    "found/seeded",
    "silent/clean",
    "recall",
    "precision",
    "kept",
    "dropped_vague",
    "dropped_unsupported",
    "dropped_nitpick",
    "tokens",
  ];
  const body = rows.map((row) => [
    row.stage,
    row.found,
    row.silent,
    row.recall,
    row.precision,
    row.kept,
    row.droppedVague,
    row.droppedUnsupported,
    row.droppedNitpick,
    row.tokens.toLocaleString("en-US"),
  ]);
  return (
    renderMarkdownTable(headers, body) +
    "\n\n* the production verifier runs, but the redacted qualification report does not expose " +
    "private per-finding judge buckets; these cells are intentionally n/a rather than fabricated."
  );
}

function bindingLine(binding) {
  if (binding === undefined) return "binding: unavailable (report carried no binding)";
  return (
    `engine ${String(binding.engine?.sha256).slice(0, 12)} · rule ${String(binding.rule?.sha256).slice(0, 12)} · ` +
    `cases ${String(binding.corpus?.cases).slice(0, 12)} · scorer ${String(binding.corpus?.scorer).slice(0, 12)} · ` +
    `model ${String(binding.model?.id)} · strictness ${String(binding.strictness)}`
  );
}

/**
 * The full evidence document — deliberately NOT shaped like corpus/evidence/qualification-*.md.
 * Qualification evidence has its own shape contract (mirrored from corpus/seed-gate-lib.mjs's own
 * `renderEvidence`, which states the identical principle for the consumer-seed gate: "this gate must
 * never masquerade as a corpus qualification"). This is a sweep: different title, different section
 * names, and a disclaimer before a single number, so nobody who finds this file later mistakes a
 * plumbing check for a release qualification.
 */
export function renderEvidenceMarkdown({ generatedAtIso, plan, stageOutcomes }) {
  const rows = buildSweepRows(
    stageOutcomes.map((o) => ({ stage: o.stage, summary: summarizeStageReport(o.report) })),
  );
  const totalTokens = stageOutcomes.reduce(
    (sum, o) => sum + summarizeStageReport(o.report).tokens,
    0,
  );
  const anyUnmeasured = stageOutcomes.some((o) => !summarizeStageReport(o.report).measured);
  const lines = [
    `# Substantiation strictness sweep — NOT a qualification (${generatedAtIso})`,
    "",
    "**This file is diagnostic output from corpus/operating-point-sweep.mjs, not release evidence.**",
    "It does not satisfy AGENTS.md's release-qualification requirement and must never be cited as",
    "one; see corpus/evidence/qualification-*.md for that record.",
    "",
    "## What this sweep can and cannot show",
    "",
    "Staged corpus/run.mjs enters `performLocalReview`, which runs the same `planAndAudit` quality",
    "verification path as the CLI and GitHub Action. Each row therefore measures its named",
    "KFQ_SUBSTANTIATION_STRICTNESS setting. The table remains one serving sample per stage, so a",
    "small spread is not a stable strictness effect without independent repeats.",
    "",
    "## Serving variance",
    "",
    "This repository's own qualification evidence documents that a single run of this corpus",
    "regularly trips at least one gate that a same-binding re-run then passes (see, for one dated",
    "example, corpus/evidence/qualification-2026-08-06-v0.19.1.md's `workflow-head-checkout` —",
    "MISS twice today, PASS a few hours earlier under an identical engine/rule/cases/scorer/model",
    "binding). Each stage below is ONE run. Any spread across the rows is consistent with that",
    "already-documented variance and must not be read as a strictness effect without a repeat count",
    "per stage this script does not attempt.",
    "",
    "## Method",
    "",
    `- Stages: ${plan.stages.join(", ")}`,
    `- Scope: ${describeScope(plan.only)}`,
    `- Runner: ${plan.runnerMode} (${SWEEP_RUNNER_ENV_VAR}=${SWEEP_RUNNER_ENV_VALUE}, pinned by this sweep)`,
    "- Each stage: one `node corpus/run.mjs` child process, KFQ_SUBSTANTIATION_STRICTNESS set in",
    "  its environment only, a fresh OCR_REPORT path read back afterward. corpus/run.mjs itself is",
    "  unmodified and was not imported — only invoked, through its own documented CLI.",
    "",
    "## Results",
    "",
    renderSweepTable(rows),
    "",
    "## Binding per stage",
    "",
    ...stageOutcomes.map(
      (o) => `- ${o.stage}: ${bindingLine(summarizeStageReport(o.report).binding)}`,
    ),
    "",
    "## Spend",
    "",
    `Total across ${String(stageOutcomes.length)} stage(s): ${totalTokens.toLocaleString("en-US")} tokens.` +
      (anyUnmeasured ? " AT LEAST ONE STAGE DID NOT MEASURE — see its row above." : ""),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Everything below this line has side effects: spawning corpus/run.mjs, touching the filesystem,
// and (per the entry-point guard at the very bottom) running only when this file is executed
// directly. corpus/operating-point-sweep.test.mjs imports this module for the pure functions above
// and never triggers any of it.
// ---------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_MJS = join(HERE, "run.mjs");

/** Spawns `node corpus/run.mjs <args>` with `env` as its complete environment, `stdio: "inherit"` so
 *  a human watching a long run sees run.mjs's own PASS/FAIL lines live, and resolves to its exit
 *  code (`null` on a spawn error, e.g. the binary itself missing — read back from the report's own
 *  `measured` field rather than trusted to this number, the same posture `corpus/run.mjs` takes
 *  toward its OWN engine child in `runEngineWithOneResume`). */
function spawnRunMjs(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN_MJS, ...args], { env, stdio: "inherit" });
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
}

/**
 * Complete child environment for one paid stage.
 *
 * Runner selection is owned here rather than inherited: the planner's cost and measurement target
 * are staged-single-shot, so even a caller carrying a stale `KFQ_SINGLE_SHOT=0` cannot silently
 * spend against the classic engine. Returning a fresh object also keeps the parent environment
 * unchanged across stages and gives the hermetic suite a pure boundary to pin.
 */
export function buildStageEnvironment(parentEnvironment, stage, reportPath) {
  return {
    ...parentEnvironment,
    [SWEEP_RUNNER_ENV_VAR]: SWEEP_RUNNER_ENV_VALUE,
    [STRICTNESS_ENV_VAR]: stage,
    OCR_REPORT: reportPath,
  };
}

/** One stage: a fresh OCR_REPORT path, a child `corpus/run.mjs` invocation carrying this stage's
 *  strictness and (optionally) `--only`, and the parsed-back report. */
async function runStage(stage, only) {
  const reportPath = join(
    tmpdir(),
    `kfq-sweep-${stage}-${String(process.pid)}-${String(Date.now())}.json`,
  );
  const env = buildStageEnvironment(process.env, stage, reportPath);
  const args = only !== undefined ? ["--only", only] : [];
  const startedAt = Date.now();
  const exitCode = await spawnRunMjs(args, env);
  const durationMs = Date.now() - startedAt;
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    report = { measured: false, reason: "report_unreadable" };
  } finally {
    rmSync(reportPath, { force: true });
  }
  return { stage, exitCode, durationMs, report };
}

function defaultEvidencePath() {
  const date = new Date().toISOString().slice(0, 10);
  return join(HERE, "evidence", `substantiation-sweep-${date}.md`);
}

async function run(argv) {
  const options = parseArgs(argv);
  const plan = buildPlan(options);
  console.log(renderDryRunPlan(plan));
  if (options.dryRun) return;

  console.log("");
  const stageOutcomes = [];
  for (const stage of plan.stages) {
    console.log(`=== stage "${stage}" ===`);
    // Sequential, deliberately: corpus/run.mjs's own header explains why a concurrent engine burst
    // tripped a freshly provisioned deployment, and running stages one at a time avoids stacking
    // that same risk N-deep instead of once.
    const outcome = await runStage(stage, options.only);
    stageOutcomes.push(outcome);
  }

  const generatedAtIso = new Date().toISOString();
  const evidence = renderEvidenceMarkdown({ generatedAtIso, plan, stageOutcomes });
  console.log(`\n${evidence}\n`);

  const evidencePath = options.evidence ?? defaultEvidencePath();
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${evidence}\n`);
  console.log(`wrote ${evidencePath}`);

  const anyUnmeasured = stageOutcomes.some((o) => !summarizeStageReport(o.report).measured);
  if (anyUnmeasured) {
    console.error("");
    console.error("NOT FULLY MEASURED — at least one stage's corpus/run.mjs did not measure. See");
    console.error("that stage's own console output above and its row in the evidence table.");
    process.exitCode = 2;
  }
}

function main() {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}

// Only run when executed directly (`node corpus/operating-point-sweep.mjs`), not when imported by
// a test — mirrors corpus/arena.mjs's identical guard, for the identical reason.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
