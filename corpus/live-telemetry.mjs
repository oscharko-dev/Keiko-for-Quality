#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveGhBinary } from "./arena-fetch.mjs";
import { splitRepo } from "./arena.mjs";
import { isReasonCode } from "../src/diagnostics/reason-codes.ts";

/**
 * Live cost telemetry (v0.12.0's measurement wave, Keiko for Quality#87): turns the diagnostics a
 * consumer's own Actions job log already carries — one JSON object per line, written by
 * `src/diagnostics/sink.ts` — into a trend a person can actually read, instead of something nobody
 * ever scrolls back through.
 *
 * v0.12.0 is the first release that emits real cost telemetry: `run.spend` (engine + classify +
 * total token spend), `model.usage` (requests, prompt/completion/**cached** tokens, as observed on
 * the wire by the loopback proxy — the only layer that sees whether prefix caching actually fired),
 * `engine.run.completed`/`settlement.complete`'s duration, `cache.hits`, and the v0.12.0 suppression
 * counters (`publish.finding_suppressed_similar`/`_intra_run`, `classify.skipped_budget`). All of it
 * already ships to every consumer run's log; nothing here calls a model or a mutating API. This is a
 * read-only operator tool against the CONSUMER repository — the one that installed this action —
 * exactly the idiom `corpus/arena.mjs`/`corpus/arena-fetch.mjs` established for the reviewer arena:
 * `gh`'s ambient authentication, no credential of its own to narrow, no publication.
 *
 * Pipeline: `listWorkflowRuns` (gh) -> `fetchRunLogText` (gh, one call per run) ->
 * `parseDiagnosticLines` (extracts every closed-vocabulary diagnostic line, tolerating whatever
 * prefix Actions or `gh run view --log` wrapped around it) -> `summarizeRun` (folds one run's
 * records into named totals) -> `aggregate` (totals, percentiles, and the two cross-run ratios that
 * matter: tokens per published finding, and cached-share) -> `renderMarkdown`. Every function up to
 * and including `renderMarkdown` is pure — no `node:fs`, no `node:child_process` — which is exactly
 * what `corpus/live-telemetry.test.mjs` exercises, against fixture log text, never a live run.
 *
 * The closed vocabulary itself is imported from `src/diagnostics/reason-codes.ts` rather than
 * hand-copied here, so this extractor cannot silently drift from what a real run can actually emit
 * the way two independently maintained copies of "the same" list eventually do (see AGENTS.md's
 * rule-text/sanitizer story for why that lesson is written down at all). Node's built-in TypeScript
 * support (this repository pins `node >=24`, where it needs no flag) resolves the import directly;
 * everything under `corpus/` sits outside `tsconfig.json`'s own `include` (TypeScript files under
 * `src/` only), so the import has no effect on `npm run typecheck`.
 *
 * Redaction (non-negotiable, matching every other diagnostic-reading tool in this repository): the
 * output carries counts, reason codes, run ids, head SHAs, and durations — the same fields
 * `src/diagnostics/sink.ts`'s `DiagnosticFields` already allows a diagnostic to carry — and NEVER a
 * raw log line, a finding body, or a file path from the consumer repository. `parseDiagnosticLines`
 * only ever keeps a line that parsed as a JSON object carrying a closed-vocabulary `code`; every
 * summary field below reads one specific, already-bounded property off that object, and nothing here
 * ever stores or prints an entire raw record.
 *
 * Usage:
 *   node corpus/live-telemetry.mjs --repo owner/name [--workflow path] [--limit N]
 *     [--since ISO8601] [--out file.json] [--md file.md]
 *
 * Defaults: workflow `.github/workflows/keiko-for-quality.yml` (the name a consumer's own
 * repository would give the workflow that calls this action), limit 20. Requires only ambient `gh`
 * authentication with read access to the target repository, exactly like `corpus/arena-fetch.mjs`.
 */

// =================================================================================================
// Pure computation. No `node:fs`, no `node:child_process` — exercised entirely by
// `corpus/live-telemetry.test.mjs` against fixture text, never a live job log.
// =================================================================================================

/** An Actions-style timestamp prefix (`2026-08-04T10:15:32.1234567Z `), fraction optional. */
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z[ \t]*/;
/** `gh run view --log`'s own wrapping: `<job>\t<step>\t` ahead of the runner's raw line. */
const JOB_STEP_PREFIX = /^[^\t\r\n]*\t[^\t\r\n]*\t/;
/**
 * ANSI CSI sequences (color, cursor movement) that can appear anywhere in a raw log line.
 * Written as `\x1b` rather than an embedded literal escape byte, which would be invisible in
 * source and fragile across editors/encodings.
 */
// \x1b IS the ANSI escape byte this pattern exists to strip — the intentional match target, not an
// accident.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Extracts every diagnostic record from raw job-log text: a line that, once Actions/`gh` noise is
 * stripped from it, is a JSON object carrying a `code` field from the closed reason-code vocabulary.
 * Everything else — timestamps, `##[group]`/`##[endgroup]` markers, plain prose, npm/eslint/vitest
 * output, a line that merely starts with `{` but is not actually valid JSON, a JSON array or scalar,
 * an object with no `code` or an unrecognized one — is silently skipped. Never throws: a malformed or
 * truncated log is exactly the input this function exists to survive.
 *
 * Line noise is stripped in a fixed order — job/step TSV columns, then ANSI escapes, then the
 * timestamp — so this tolerates both `gh run view --log`'s TSV-wrapped shape and the plain
 * `<timestamp> <message>` shape the REST logs endpoint's raw files use; a pattern that does not
 * match its own line is a no-op, so a caller on either shape (or a fixture with no prefix at all)
 * is handled identically.
 */
export function parseDiagnosticLines(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const records = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(JOB_STEP_PREFIX, "");
    line = line.replace(ANSI_ESCAPE, "");
    line = line.replace(TIMESTAMP_PREFIX, "");
    line = line.trim();
    if (!line.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (typeof parsed.code !== "string" || !isReasonCode(parsed.code)) continue;
    records.push(parsed);
  }
  return records;
}

const RUN_SPEND = "run.spend";
const MODEL_USAGE = "model.usage";
const CACHE_HITS = "cache.hits";
const CLASSIFY_SKIPPED_BUDGET = "classify.skipped_budget";
const SETTLEMENT_COMPLETE = "settlement.complete";
const SETTLEMENT_INCOMPLETE_PREFIX = "settlement.incomplete.";
const PUBLISH_FINDING_PUBLISHED = "publish.finding_published";
const PUBLISH_SUPPRESSED_DUPLICATE = "publish.finding_suppressed_duplicate";
const PUBLISH_SUPPRESSED_SIMILAR = "publish.finding_suppressed_similar";
const PUBLISH_SUPPRESSED_INTRA_RUN = "publish.finding_suppressed_intra_run";
const DEDUP_DISPOSITIONED = "dedup.dispositioned";

/**
 * Sums `record.counts[field]` over every record of `code` in this run's records. `undefined` —
 * never `0` — when `code` never appears at all: that is the "this run did not report it" case
 * `summarizeRun`'s own doc comment promises never collapses into a false zero. Summed rather than
 * "take the one value" because a resumed engine run (`engine.resumed_once`) makes `model.usage`
 * legitimately fire twice in a single run, and the run's real total usage is both attempts together.
 */
function sumCount(records, code, field) {
  let total = 0;
  let seen = false;
  for (const record of records) {
    if (record.code !== code) continue;
    const value = record.counts?.[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : undefined;
}

/**
 * Counts records of `code`, `undefined` when none exist — the one-record-per-event counterpart of
 * `sumCount` above, for diagnostics like `publish.finding_published` that carry no count field of
 * their own because each record already represents exactly one occurrence (one finding).
 */
function countOccurrences(records, code) {
  let count = 0;
  for (const record of records) {
    if (record.code === code) count += 1;
  }
  return count > 0 ? count : undefined;
}

/**
 * The run's terminal settlement record: `settlement.complete`, or the one
 * `settlement.incomplete.*` this run settled as — `undefined` when the run never reached a
 * settlement decision at all (a crash before `performReviewInner` returned anything, in
 * `src/review.ts`). At most one such record exists per run; the flow that decides settlement
 * returns immediately after recording it.
 */
function findSettlement(records) {
  for (const record of records) {
    if (record.code === SETTLEMENT_COMPLETE) return record;
    if (typeof record.code === "string" && record.code.startsWith(SETTLEMENT_INCOMPLETE_PREFIX)) {
      return record;
    }
  }
  return undefined;
}

/**
 * Folds one run's diagnostic records into a flat, closed-vocabulary summary.
 *
 * Every field independently answers "did this run's log carry the diagnostic this field reads
 * from" — `undefined` if not, the real (possibly zero) value if so. A run whose engine crashed
 * before `run.spend` was ever recorded therefore shows `engineTokens: undefined`, not `0`: `0` is
 * reserved for a run that genuinely spent nothing after being measured (memoization answered every
 * path), which is a very different operational fact from "this run never got that far" — collapsing
 * the two into one fabricated zero is exactly the blind spot this module exists to remove.
 *
 * `outcome`/`reason` mirror `src/publish/presentation.ts`'s own `SummaryReport` contract: `reason`
 * is populated only when `outcome` is `"incomplete"`, and both are `undefined` when this run's log
 * carries no settlement record at all.
 */
export function summarizeRun(records) {
  const settlement = findSettlement(records);
  const outcome =
    settlement === undefined
      ? undefined
      : settlement.code === SETTLEMENT_COMPLETE
        ? "complete"
        : "incomplete";
  const reason = outcome === "incomplete" ? settlement.code : undefined;

  const engineTokens = sumCount(records, RUN_SPEND, "engine");
  const classifyTokens = sumCount(records, RUN_SPEND, "classify");
  const totalTokens = sumCount(records, RUN_SPEND, "total");

  const requests = sumCount(records, MODEL_USAGE, "requests");
  const promptTokens = sumCount(records, MODEL_USAGE, "prompt");
  const completionTokens = sumCount(records, MODEL_USAGE, "completion");
  const cachedTokens = sumCount(records, MODEL_USAGE, "cached");
  const cachedShare =
    cachedTokens === undefined || promptTokens === undefined || promptTokens === 0
      ? undefined
      : cachedTokens / promptTokens;

  const durationMs =
    settlement !== undefined && typeof settlement.durationMs === "number"
      ? settlement.durationMs
      : undefined;

  const cacheHits = sumCount(records, CACHE_HITS, "hits");
  const cacheMisses = sumCount(records, CACHE_HITS, "misses");

  const published = countOccurrences(records, PUBLISH_FINDING_PUBLISHED);
  const suppressedExact = countOccurrences(records, PUBLISH_SUPPRESSED_DUPLICATE);
  const suppressedSimilar = countOccurrences(records, PUBLISH_SUPPRESSED_SIMILAR);
  const suppressedDispositioned = countOccurrences(records, DEDUP_DISPOSITIONED);
  const suppressedIntraRun = countOccurrences(records, PUBLISH_SUPPRESSED_INTRA_RUN);

  const auditSkippedBudget = sumCount(records, CLASSIFY_SKIPPED_BUDGET, "skipped");

  return {
    outcome,
    reason,
    engineTokens,
    classifyTokens,
    totalTokens,
    requests,
    promptTokens,
    completionTokens,
    cachedTokens,
    cachedShare,
    durationMs,
    cacheHits,
    cacheMisses,
    published,
    suppressedExact,
    suppressedSimilar,
    suppressedDispositioned,
    suppressedIntraRun,
    auditSkippedBudget,
  };
}

/** Sums `run[field]` across every run that reported it; `undefined` only when NONE did. */
function sumDefined(runs, field) {
  let total = 0;
  let seen = false;
  for (const run of runs) {
    const value = run[field];
    if (typeof value !== "number") continue;
    seen = true;
    total += value;
  }
  return seen ? total : undefined;
}

/**
 * A ratio, or `undefined` for a missing operand or a zero denominator — never `Infinity`/`NaN`.
 * Generalizes `corpus/arena-trend.mjs`'s own `safeRate` to operands that may themselves be
 * `undefined` (an aggregate total nothing contributed to), which `safeRate` does not need to
 * handle because its own inputs are always plain counts, never a possibly-absent total.
 */
export function safeDivide(numerator, denominator) {
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
  return numerator / denominator;
}

function median(sortedAscending) {
  const n = sortedAscending.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAscending[mid - 1] + sortedAscending[mid]) / 2 : sortedAscending[mid];
}

/**
 * Nearest-rank percentile: the reported value was always actually observed, never an interpolated
 * average of two neighbors. `p` in `[0, 100]`.
 */
function percentileOf(sortedAscending, p) {
  const n = sortedAscending.length;
  const rank = Math.ceil((p / 100) * n);
  const index = Math.min(Math.max(rank - 1, 0), n - 1);
  return sortedAscending[index];
}

/**
 * `{ n, median, p95 }` over the finite numbers in `values` (non-numbers, including `undefined` for
 * a run that never reported the measurement, are dropped before computing), or `undefined` when
 * none remain — an empty series has no median to report, and `0` would be a fabricated one.
 */
export function percentileStats(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return undefined;
  const sorted = [...finite].sort((a, b) => a - b);
  return { n: sorted.length, median: median(sorted), p95: percentileOf(sorted, 95) };
}

/**
 * Totals across every run, plus duration/total-token percentiles, plus the two cross-run ratios
 * that answer the questions this whole module exists for: `tokensPerPublishedFinding` ("is this
 * getting cheaper per unit of value delivered") and the aggregate `cachedShare` ("is prefix caching
 * actually working"). Every division is guarded (`safeDivide`) — an early run, or a run that
 * published nothing, must read as "n/a", never divide-by-zero.
 */
export function aggregate(runs) {
  const runCount = runs.length;
  const completeCount = runs.filter((run) => run.outcome === "complete").length;
  const incompleteCount = runs.filter((run) => run.outcome === "incomplete").length;
  const unknownCount = runCount - completeCount - incompleteCount;

  const totals = {
    engineTokens: sumDefined(runs, "engineTokens"),
    classifyTokens: sumDefined(runs, "classifyTokens"),
    totalTokens: sumDefined(runs, "totalTokens"),
    requests: sumDefined(runs, "requests"),
    promptTokens: sumDefined(runs, "promptTokens"),
    completionTokens: sumDefined(runs, "completionTokens"),
    cachedTokens: sumDefined(runs, "cachedTokens"),
    cacheHits: sumDefined(runs, "cacheHits"),
    cacheMisses: sumDefined(runs, "cacheMisses"),
    published: sumDefined(runs, "published"),
    suppressedExact: sumDefined(runs, "suppressedExact"),
    suppressedSimilar: sumDefined(runs, "suppressedSimilar"),
    suppressedDispositioned: sumDefined(runs, "suppressedDispositioned"),
    suppressedIntraRun: sumDefined(runs, "suppressedIntraRun"),
    auditSkippedBudget: sumDefined(runs, "auditSkippedBudget"),
  };

  return {
    runCount,
    completeCount,
    incompleteCount,
    unknownCount,
    totals,
    stats: {
      durationMs: percentileStats(runs.map((run) => run.durationMs)),
      totalTokens: percentileStats(runs.map((run) => run.totalTokens)),
    },
    tokensPerPublishedFinding: safeDivide(totals.totalTokens, totals.published),
    cachedShare: safeDivide(totals.cachedTokens, totals.promptTokens),
  };
}

function formatValue(value) {
  return value === undefined ? "n/a" : String(value);
}

function formatPercent(value) {
  return value === undefined ? "n/a" : `${String(Math.round(value * 100))}%`;
}

function formatOutcome(run) {
  if (run.outcome === undefined) return "n/a";
  return run.outcome === "complete" ? "complete" : `incomplete (\`${run.reason}\`)`;
}

function renderTable(header, rows) {
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

const RUN_METRIC_ROWS = [
  ["Engine tokens", (r) => formatValue(r.engineTokens)],
  ["Classify tokens", (r) => formatValue(r.classifyTokens)],
  ["Total tokens", (r) => formatValue(r.totalTokens)],
  ["Requests", (r) => formatValue(r.requests)],
  ["Prompt tokens", (r) => formatValue(r.promptTokens)],
  ["Completion tokens", (r) => formatValue(r.completionTokens)],
  ["Cached tokens", (r) => formatValue(r.cachedTokens)],
  ["Cached share", (r) => formatPercent(r.cachedShare)],
  ["Duration (ms)", (r) => formatValue(r.durationMs)],
  ["Cache hits", (r) => formatValue(r.cacheHits)],
  ["Cache misses", (r) => formatValue(r.cacheMisses)],
  ["Published", (r) => formatValue(r.published)],
  ["Suppressed (exact duplicate)", (r) => formatValue(r.suppressedExact)],
  ["Suppressed (similar)", (r) => formatValue(r.suppressedSimilar)],
  ["Suppressed (dispositioned)", (r) => formatValue(r.suppressedDispositioned)],
  ["Suppressed (intra-run)", (r) => formatValue(r.suppressedIntraRun)],
  ["Classification audit skipped (budget)", (r) => formatValue(r.auditSkippedBudget)],
];

/** Renders one run's identifying heading plus its metric table. */
function renderRunSection(run) {
  const shortSha = typeof run.headSha === "string" ? run.headSha.slice(0, 12) : "unknown";
  const label = run.runNumber ?? run.runId ?? "?";
  const heading = `### Run #${String(label)} (id ${String(run.runId ?? "unknown")}, head \`${shortSha}\`)`;
  const meta =
    `Created ${run.createdAt ?? "unknown"} · conclusion \`${run.conclusion ?? "unknown"}\` · ` +
    `outcome ${formatOutcome(run)}`;
  const rows = RUN_METRIC_ROWS.map(([label_, get]) => [label_, get(run)]);
  return `${heading}\n\n${meta}\n\n${renderTable(["Metric", "Value"], rows)}`;
}

/** Renders the cross-run totals, percentiles, and ratio section. */
function renderAggregateSection(agg) {
  const intro =
    `${String(agg.runCount)} run(s): ${String(agg.completeCount)} complete, ` +
    `${String(agg.incompleteCount)} incomplete` +
    (agg.unknownCount > 0 ? `, ${String(agg.unknownCount)} unknown` : "") +
    ".";
  const totalsRows = [
    ["Engine tokens", formatValue(agg.totals.engineTokens)],
    ["Classify tokens", formatValue(agg.totals.classifyTokens)],
    ["Total tokens", formatValue(agg.totals.totalTokens)],
    ["Requests", formatValue(agg.totals.requests)],
    ["Prompt tokens", formatValue(agg.totals.promptTokens)],
    ["Completion tokens", formatValue(agg.totals.completionTokens)],
    ["Cached tokens", formatValue(agg.totals.cachedTokens)],
    ["Cache hits", formatValue(agg.totals.cacheHits)],
    ["Cache misses", formatValue(agg.totals.cacheMisses)],
    ["Published", formatValue(agg.totals.published)],
    ["Suppressed (exact duplicate)", formatValue(agg.totals.suppressedExact)],
    ["Suppressed (similar)", formatValue(agg.totals.suppressedSimilar)],
    ["Suppressed (dispositioned)", formatValue(agg.totals.suppressedDispositioned)],
    ["Suppressed (intra-run)", formatValue(agg.totals.suppressedIntraRun)],
    ["Classification audit skipped (budget)", formatValue(agg.totals.auditSkippedBudget)],
    ["Cached share (cached / prompt)", formatPercent(agg.cachedShare)],
    ["Tokens per published finding", formatValue(agg.tokensPerPublishedFinding)],
  ];
  const statsRows = [
    [
      "Duration (ms)",
      formatValue(agg.stats.durationMs?.median),
      formatValue(agg.stats.durationMs?.p95),
      formatValue(agg.stats.durationMs?.n),
    ],
    [
      "Total tokens",
      formatValue(agg.stats.totalTokens?.median),
      formatValue(agg.stats.totalTokens?.p95),
      formatValue(agg.stats.totalTokens?.n),
    ],
  ];
  return [
    "## Aggregate",
    "",
    intro,
    "",
    renderTable(["Metric", "Total"], totalsRows),
    "",
    renderTable(["Metric", "Median", "p95", "n"], statsRows),
  ].join("\n");
}

/**
 * The full report: one section per run (oldest-or-newest exactly as `runs` was given — this
 * function does not sort), plus the aggregate section. Pure: identical input renders byte-identical
 * output, and nothing here reads the wall clock — a caller that wants a generation timestamp adds
 * one outside this function, the same "the clock lives in the CLI, not the library" split
 * `corpus/arena.mjs`'s own header comment draws for the exact same reason.
 */
export function renderMarkdown(runs, agg) {
  const intro =
    runs.length === 0
      ? "No workflow runs were measured."
      : `${String(runs.length)} workflow run(s) measured.`;
  const sections = runs.map((run) => renderRunSection(run)).join("\n\n");
  return [
    "# Live cost telemetry",
    "",
    "Real cost telemetry (`run.spend`, `model.usage`, cache hits, and the publication suppression " +
      "counters) extracted from the diagnostics each consumer run already writes to its Actions job " +
      "log, one JSON object per line. Counts, reason codes, run ids, head SHAs, and durations only — " +
      "never a log line, a finding body, or a file path from the consumer repository. A field reads " +
      "`n/a` when the underlying diagnostic never fired for that run, which is not the same thing as " +
      "a real, reported zero.",
    "",
    intro,
    "",
    sections,
    "",
    renderAggregateSection(agg),
    "",
  ].join("\n");
}

// =================================================================================================
// Impure: `gh` invocations and the CLI entry point. Thin and untested against the network — the
// same boundary `corpus/arena.mjs` and `corpus/arena-trend.mjs` draw around their own `main`.
// =================================================================================================

let cachedGhBinary;

/**
 * Runs `gh` at its resolved absolute path (cached after the first call), mirroring
 * `corpus/arena-fetch.mjs`'s own `runGh`: the full ambient environment, no credential to narrow
 * since this only ever reads data already visible to whoever runs it — workflow run metadata and
 * job logs of a repository they can already open in a browser.
 */
function runGh(args) {
  cachedGhBinary ??= resolveGhBinary();
  return execFileSync(cachedGhBinary, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Lists recent runs of one workflow, in the order `gh` itself returns them (newest first). */
export function listWorkflowRuns(owner, repoName, workflow, limit, since, runGhImpl = runGh) {
  const args = [
    "run",
    "list",
    "--repo",
    `${owner}/${repoName}`,
    "--workflow",
    workflow,
    "--limit",
    String(limit),
    "--json",
    "databaseId,number,headSha,createdAt,conclusion,status,url",
  ];
  if (since !== null && since !== undefined) args.push("--created", `>=${since}`);
  return JSON.parse(runGhImpl(args));
}

/**
 * Fetches one run's full combined job log as plain text. `gh run view --log` prefixes every line
 * with `<job>\t<step>\t` ahead of the runner's own `<timestamp> <message>` — `parseDiagnosticLines`
 * strips both layers, so this works whether a caller's `runGhImpl` returns that CLI-wrapped shape or
 * the raw per-line format the REST logs endpoint would (unzipped) contain.
 */
export function fetchRunLogText(owner, repoName, runId, runGhImpl = runGh) {
  return runGhImpl(["run", "view", String(runId), "--repo", `${owner}/${repoName}`, "--log"]);
}

export const USAGE =
  "usage: node corpus/live-telemetry.mjs --repo owner/name [--workflow path] [--limit N] " +
  "[--since ISO8601] [--out file.json] [--md file.md]";

const DEFAULT_WORKFLOW = ".github/workflows/keiko-for-quality.yml";
const DEFAULT_LIMIT = 20;
const DEFAULT_OUT_JSON = "corpus/evidence/live-telemetry-latest.json";
const DEFAULT_OUT_MD = "corpus/evidence/live-telemetry-latest.md";

export function parseArgs(argv) {
  const options = {
    repo: null,
    workflow: DEFAULT_WORKFLOW,
    limit: DEFAULT_LIMIT,
    since: null,
    out: DEFAULT_OUT_JSON,
    md: DEFAULT_OUT_MD,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      // Fail here, naming the flag — not later, as `undefined` silently flowing into `splitRepo`'s
      // `.split("/")` or `--limit`'s own `Number(undefined)` (`NaN`, which the check below would
      // otherwise have to explain out of context).
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--repo") options.repo = next();
    else if (arg === "--workflow") options.workflow = next();
    else if (arg === "--limit") {
      const value = next();
      const parsedLimit = Number(value);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        throw new Error(`--limit must be a positive integer, got: ${value}`);
      }
      options.limit = parsedLimit;
    } else if (arg === "--since") options.since = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--md") options.md = next();
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  if (options.repo === null) throw new Error(USAGE);
  return options;
}

function buildRun(owner, repoName, meta) {
  const logText = fetchRunLogText(owner, repoName, meta.databaseId);
  const records = parseDiagnosticLines(logText);
  return {
    runId: meta.databaseId,
    runNumber: meta.number,
    headSha: meta.headSha,
    createdAt: meta.createdAt,
    conclusion: meta.conclusion,
    status: meta.status,
    url: meta.url,
    ...summarizeRun(records),
  };
}

function writeOutputs(options, runs, agg, markdown) {
  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(dirname(options.md), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify({ runs, aggregate: agg }, null, 2)}\n`);
  writeFileSync(options.md, `${markdown}\n`);
  console.log(`wrote ${options.out}`);
  console.log(`wrote ${options.md}`);
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const { owner, repoName } = splitRepo(options.repo);
  const runsMeta = listWorkflowRuns(
    owner,
    repoName,
    options.workflow,
    options.limit,
    options.since,
  );
  console.log(
    `live-telemetry: ${options.repo}, workflow ${options.workflow}, ${String(runsMeta.length)} run(s)`,
  );
  const runs = runsMeta.map((meta) => buildRun(owner, repoName, meta));
  const agg = aggregate(runs);
  const markdown = renderMarkdown(runs, agg);
  console.log(`\n${markdown}`);
  writeOutputs(options, runs, agg, markdown);
}

function main() {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

// Only run when executed directly (`node corpus/live-telemetry.mjs`), not when imported by a test.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
