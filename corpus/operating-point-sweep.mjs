#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

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
 * ## Read this before spending anything: what this harness can and cannot show
 *
 * `corpus/run.mjs` builds its findings through `planCaseFindings`, which calls `planPublication`
 * (`src/publish/publisher.ts`) DIRECTLY — never `planAndAudit` (`src/review.ts`), which is the only
 * function in this repository that calls `substantiateFreshSurvivors` and therefore the only path
 * that ever reaches `substantiate()`. `performReview` (the live action) and `performLocalReview`
 * (the CLI, and `corpus/real-diffs.mjs`) both go through `planAndAudit`; the seeded qualification
 * corpus this script drives does not, and that is documented as deliberate, not an oversight —
 * AGENTS.md's "`npm run review`" section calls `corpus/run.mjs`'s exclusion from that migration "a
 * deliberately separate, not-yet-scoped decision, left alone so the qualification that shipped each
 * release keeps the same measurement basis it was recorded under."
 *
 * The consequence, stated plainly because a cost warning that omitted it would be worse than no
 * warning at all: setting `KFQ_SUBSTANTIATION_STRICTNESS` around a `corpus/run.mjs` invocation
 * changes NOTHING about what that invocation measures. `judgeOne`/`weighConsequence`/`repairVague`
 * are simply never called on this path, at any strictness level. A sweep run through this script
 * against the DEFAULT `--stages` will, correctly, show near-identical recall/precision/publishable
 * numbers at every stage, bounded only by the serving variance the qualification evidence already
 * documents elsewhere (see "Serving variance" in `renderEvidenceMarkdown`, and
 * corpus/evidence/qualification-2026-08-06-v0.19.1.md's own rotating-case section for a real
 * example of the same run producing different results on nominally identical inputs). That flat
 * line is not a bug in this instrument — it is this instrument telling the truth about a harness
 * that was never wired to the thing being swept. What this script CAN still show, honestly: (a) that
 * the knob does not perturb the engine/classification/gate/publisher stages `corpus/run.mjs` DOES
 * measure — a regression check on the frozen qualification basis, not a Pareto curve — and (b) an
 * N-repeat measurement of serving variance itself, since N stages that provably do not differ in
 * what they measure are, mechanically, N independent re-runs of the identical configuration. A
 * strictness Pareto curve for `substantiate()` would need a harness on the `planAndAudit` side of
 * that split (`corpus/real-diffs.mjs`, or a purpose-built fixture) — out of scope here, and not
 * something this script attempts.
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
 * A full corpus run costs 1,200,000-1,700,000 tokens and roughly 40 minutes (AGENTS.md; this
 * script's own task brief). Four stages of that is four times the money and four times the wait —
 * and, per the section above, the strictness axis is not even the thing that cost would be buying on
 * the default `--stages`. `estimateStageCost`/`buildPlan` compute and `renderDryRunPlan` prints an
 * explicit estimate before a single stage runs, `--dry-run` stops there and spends nothing, `--only`
 * narrows every stage to one case (roughly 1/39th of a full run — corpus/cases.mjs; the 2026-08-06
 * v0.19.1 qualification's own 27/29 recall + 10/10 precision scoreboard is 39 cases), and `--stages`
 * narrows which levels run at all. None of this is optional politeness: `npm run corpus` alone is
 * already excluded from `verify` and gated on a human's explicit go-ahead (AGENTS.md, "Three
 * commands spend real money"), and this script can spend up to four times that in one invocation.
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
 * Same environment contract as `corpus/run.mjs` (OCR_BINARY, OCR_LLM_URL, OCR_LLM_TOKEN,
 * OCR_LLM_MODEL, OCR_RULE, OCR_ALLOW_MODEL_DEVIATION) — this script sets only `KFQ_SUBSTANTIATION_STRICTNESS`
 * and `OCR_REPORT` per child, inheriting everything else from its own environment unchanged.
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

// Given by this script's own task brief and AGENTS.md's "Three commands spend real money" section —
// not derived, not measured here, and not to be replaced with a computed guess. A full run's cost
// varies with which cases rotate through a repair or a resume; this range is the honest envelope
// that variation has been observed to sit inside, not a promise either bound is exact.
export const FULL_CORPUS_TOKENS_LOW = 1_200_000;
export const FULL_CORPUS_TOKENS_HIGH = 1_700_000;
export const FULL_CORPUS_MINUTES = 40;

// corpus/cases.mjs's own case count, cross-checked against a real scoreboard rather than trusted to
// a comment staying in sync with the array: corpus/evidence/qualification-2026-08-06-v0.19.1.md
// records "recall 27/29" and "precision 10/10" under this exact rule/engine/model binding, i.e. 29
// recall-graded cases plus 10 precision-graded cases. `case-coherence.test.mjs` is what actually
// keeps corpus/cases.mjs honest; this constant is a cost-estimation input, not a second source of
// truth for it.
export const FULL_CORPUS_CASE_COUNT = 39;

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
 * or not, and the ONLY thing `--dry-run` prints. Leads with the structural limitation (this file's
 * own header comment), not the price: a reader deciding whether to spend real money needs to know
 * FIRST that the default sweep cannot show the curve it sounds like it shows, and only second what
 * that non-answer costs.
 */
export function renderDryRunPlan(plan) {
  const lines = [
    "OPERATING-POINT SWEEP — PLAN ONLY, NOTHING SPENT YET",
    "",
    "READ THIS FIRST: corpus/run.mjs never calls src/publish/substantiate.ts (planCaseFindings",
    "calls planPublication directly, never planAndAudit — see this script's own header comment for",
    "the exact call chain). Sweeping KFQ_SUBSTANTIATION_STRICTNESS through corpus/run.mjs is",
    "therefore expected to leave recall/precision/publishable UNCHANGED at every stage, modulo",
    "serving variance. Treat a real run of this plan as a regression check plus a variance sample —",
    "never as the substantiation Pareto curve.",
    "",
    `stages (${String(plan.stages.length)}): ${plan.stages.join(" -> ")}`,
    plan.only !== undefined ? `only: ${plan.only}` : "only: (unset — full corpus per stage)",
    "",
    `per-stage estimate:   ${formatTokenRange(plan.perStage.tokensLow, plan.perStage.tokensHigh)} tokens, ~${String(plan.perStage.minutes)} min` +
      (plan.perStage.isProportional
        ? ` (PROPORTIONAL estimate: 1/${String(FULL_CORPUS_CASE_COUNT)} of a full run — see estimateStageCost's own doc comment)`
        : ` (${String(FULL_CORPUS_CASE_COUNT)} cases)`),
    `total for this plan:  ${formatTokenRange(plan.totalTokensLow, plan.totalTokensHigh)} tokens, ~${String(plan.totalMinutes)} min` +
      ` across ${String(plan.stages.length)} stage(s)`,
    "",
    'This is real money against a real endpoint (AGENTS.md, "Three commands spend real money") —',
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
 * such fields (substantiate() never runs on this path — see this file's header comment), and
 * inventing them here would be exactly the fabricated measurement AGENTS.md and this script's own
 * task both forbid. `buildSweepRows` renders their absence as "n/a", not as zero.
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
    "\n\n* not measured by this harness — corpus/run.mjs never calls src/publish/substantiate.ts, " +
    "so this stage's KFQ_SUBSTANTIATION_STRICTNESS setting never reached a judge call. See this " +
    "script's own header comment."
  );
}

function bindingLine(binding) {
  if (binding === undefined) return "binding: unavailable (report carried no binding)";
  return (
    `engine ${String(binding.engine?.sha256).slice(0, 12)} · rule ${String(binding.rule?.sha256).slice(0, 12)} · ` +
    `cases ${String(binding.corpus?.cases).slice(0, 12)} · scorer ${String(binding.corpus?.scorer).slice(0, 12)} · ` +
    `model ${String(binding.model?.id)}`
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
    "corpus/run.mjs builds its findings through `planPublication` directly and never through",
    "`planAndAudit` (src/review.ts), which is the only caller of `substantiate()`. Every stage below",
    "therefore ran the SAME code path regardless of its KFQ_SUBSTANTIATION_STRICTNESS setting: the",
    "differences in the table, if any, are serving variance and case rotation, not the strictness",
    "axis. A real substantiation Pareto curve needs a harness on the planAndAudit side (e.g.",
    "corpus/real-diffs.mjs) — out of scope for this script. What IS genuine evidence here: whether",
    "the knob destabilizes the frozen qualification pipeline (it should not, and if any row below",
    "disagrees with the others outside plausible serving variance, that is the finding), and an",
    "N-stage repeated measurement of that pipeline's own run-to-run variance.",
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

/** One stage: a fresh OCR_REPORT path, a child `corpus/run.mjs` invocation carrying this stage's
 *  strictness and (optionally) `--only`, and the parsed-back report. */
async function runStage(stage, only) {
  const reportPath = join(
    tmpdir(),
    `kfq-sweep-${stage}-${String(process.pid)}-${String(Date.now())}.json`,
  );
  const env = { ...process.env, [STRICTNESS_ENV_VAR]: stage, OCR_REPORT: reportPath };
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
