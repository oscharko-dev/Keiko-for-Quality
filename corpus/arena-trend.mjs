#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ARENA_BOT_ORDER, BOT_IDENTITIES } from "./arena-lib.mjs";

/**
 * The reviewer arena's release-over-release trend (companion to `corpus/arena.mjs`).
 *
 * `corpus/arena.mjs` measures one snapshot — a set of pull requests, fetched live — and a
 * maintainer archives the qualified result as `corpus/evidence/arena-baseline-vX.Y.Z.json` (see
 * README/CONTRIBUTING's release process). Nobody had turned that growing pile of archived
 * snapshots into a "getting better or worse?" answer: reading it meant opening two
 * multi-hundred-kilobyte JSON files by hand and subtracting numbers. This module does that
 * subtraction, deterministically, from files already sitting in the repository.
 *
 * Zero network, zero API calls, zero model spend: `corpus/evidence/arena-baseline-*.json` is
 * already committed evidence, produced once by `corpus/arena.mjs` against a live pull request and
 * never touched again. Reading it back is pure file I/O, which is what makes this module's own test
 * (`corpus/arena-trend.test.mjs`) able to run under `node --test` with zero setup, exactly like
 * every other hermetic corpus/*.test.mjs suite.
 *
 * Every computation is a pure function of already-parsed baseline documents — `summarizeBaseline`,
 * `renderBaselineSection`, `computeDeltasByBot`, `renderDeltaSection`, and `renderTrendReport` never
 * touch `node:fs`. File discovery (`discoverBaselineFiles`) and reading (`loadSummaries`) are the
 * one impure seam, kept thin and untested by design — the same split `corpus/arena.mjs` draws
 * around `corpus/arena-fetch.mjs`, and `corpus/arena.test.mjs` draws around its own `main`.
 *
 * `aggregate.actedUpon` does not exist on every archived baseline: it is absent on
 * `arena-baseline-v0.10.0.json`, which predates issue #56. `summarizeBaseline` reports `null` for
 * that bot's acted-upon rate whenever the block, or that specific bot's entry on it, is missing —
 * never a thrown error and never a manufactured zero.
 *
 * Usage: node corpus/arena-trend.mjs [--evidence-dir corpus/evidence]
 */

const BOT_DISPLAY_NAMES = Object.fromEntries(
  BOT_IDENTITIES.map((bot) => [bot.arenaId, bot.displayName]),
);

function displayName(arenaId) {
  return BOT_DISPLAY_NAMES[arenaId] ?? arenaId;
}

const BASELINE_FILENAME = /^arena-baseline-v(\d+)\.(\d+)\.(\d+)\.json$/;

/**
 * Extracts `{version, major, minor, patch}` from a baseline's filename, or `null` when the name
 * does not match `arena-baseline-vX.Y.Z.json` — the caller decides whether a non-matching file in
 * the same directory is ignored or an error, this function only ever describes the name itself.
 */
export function parseBaselineFilename(filename) {
  const match = BASELINE_FILENAME.exec(filename);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return {
    version: `${major}.${minor}.${patch}`,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

/** Ascending semver order — oldest baseline first, so every delta reads as "since the last one". */
export function compareBaselineVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** A ratio in `[0, 1]`, or `null` for a zero denominator — never `Infinity` or `NaN`. */
export function safeRate(numerator, denominator) {
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Reduces one baseline document's `aggregate` block to the numbers this report tracks, one row per
 * arena bot, under the caller-supplied `label` (the CLI's `main` derives this from the filename, so
 * the parsing rule and the display label are decided in exactly one place).
 *
 * Throws on a `schemaVersion` other than `1`: every baseline on disk today is schema 1, and a
 * silently-skipped baseline is a maintainer discovering months later that a release never made it
 * into the trend, which is a worse failure than a loud one at read time.
 */
export function summarizeBaseline(label, document) {
  if (document.schemaVersion !== 1) {
    throw new Error(
      `${label}: unsupported schemaVersion ${JSON.stringify(document.schemaVersion)} (expected 1)`,
    );
  }
  const hasActedUpon = document.aggregate.actedUpon !== undefined;
  const bots = {};
  for (const arenaId of ARENA_BOT_ORDER) {
    const metrics = document.aggregate.bots[arenaId];
    const actedUpon = document.aggregate.actedUpon?.[arenaId] ?? null;
    bots[arenaId] = {
      posted: metrics.findingsPosted,
      distinct: metrics.distinctFindings,
      duplicateVariants: metrics.duplicateVariants,
      duplicateRate: safeRate(metrics.duplicateVariants, metrics.distinctFindings),
      actedUponAdjustedRate:
        actedUpon === null
          ? null
          : safeRate(actedUpon.actedUponWithOpportunity, actedUpon.hadOpportunity),
    };
  }
  return {
    label,
    generatedAt: document.generatedAt,
    targetRepo: document.targetRepo,
    prCount: document.aggregate.prCount,
    hasActedUpon,
    bots,
  };
}

function formatPercent(rate) {
  return rate === null ? "n/a" : `${String(Math.round(rate * 100))}%`;
}

function renderTable(header, rows) {
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

const BASELINE_TABLE_HEADER = [
  "Bot",
  "Posted",
  "Distinct",
  "Duplicate variants",
  "Duplicate rate",
  "Acted-upon (adjusted)",
];

/** Renders one baseline's per-bot table as a markdown section, heading first. */
export function renderBaselineSection(summary) {
  const rows = ARENA_BOT_ORDER.map((arenaId) => {
    const bot = summary.bots[arenaId];
    return [
      displayName(arenaId),
      String(bot.posted),
      String(bot.distinct),
      String(bot.duplicateVariants),
      formatPercent(bot.duplicateRate),
      formatPercent(bot.actedUponAdjustedRate),
    ];
  });
  const heading =
    `### ${summary.label} — ${String(summary.prCount)} pull request(s), ` +
    `generated ${summary.generatedAt}`;
  const note = summary.hasActedUpon
    ? ""
    : "\n\n_No acted-upon data in this baseline — it predates issue #56._";
  return `${heading}\n\n${renderTable(BASELINE_TABLE_HEADER, rows)}${note}`;
}

/**
 * One bot's numeric movement between two consecutive baselines. Count deltas (`posted`, `distinct`,
 * `duplicateVariants`) are always numbers; rate deltas (`duplicateRate`, `actedUponAdjustedRate`)
 * are `null` whenever either side's own rate was `null` — a delta against "no data" is not zero, it
 * is itself "no data".
 */
export function computeDelta(fromSummary, toSummary, arenaId) {
  const from = fromSummary.bots[arenaId];
  const to = toSummary.bots[arenaId];
  const rateDelta = (a, b) => (a === null || b === null ? null : b - a);
  return {
    fromLabel: fromSummary.label,
    toLabel: toSummary.label,
    posted: to.posted - from.posted,
    distinct: to.distinct - from.distinct,
    duplicateVariants: to.duplicateVariants - from.duplicateVariants,
    duplicateRate: rateDelta(from.duplicateRate, to.duplicateRate),
    actedUponAdjustedRate: rateDelta(from.actedUponAdjustedRate, to.actedUponAdjustedRate),
  };
}

/**
 * Every consecutive-pair delta, one array per bot. `summaries` must already be in the order the
 * deltas should read in (oldest first) — this function does not sort, `loadSummaries` does, once,
 * so the sort rule lives in exactly one place.
 */
export function computeDeltasByBot(summaries) {
  const byBot = {};
  for (const arenaId of ARENA_BOT_ORDER) {
    const deltas = [];
    for (let i = 1; i < summaries.length; i += 1) {
      deltas.push(computeDelta(summaries[i - 1], summaries[i], arenaId));
    }
    byBot[arenaId] = deltas;
  }
  return byBot;
}

function formatSignedCount(n) {
  return n > 0 ? `+${String(n)}` : String(n);
}

function formatSignedPercentPoints(rate) {
  if (rate === null) return "n/a";
  const points = Math.round(rate * 100);
  return points > 0 ? `+${String(points)}pp` : `${String(points)}pp`;
}

const DELTA_TABLE_HEADER = [
  "From",
  "To",
  "Posted",
  "Distinct",
  "Duplicate variants",
  "Duplicate rate",
  "Acted-upon (adjusted)",
];

/**
 * The cross-baseline delta section: one table per bot, one row per consecutive baseline pair. With
 * fewer than two baselines there is nothing to subtract, and this says so rather than printing an
 * empty table that looks like a bug.
 */
export function renderDeltaSection(summaries) {
  if (summaries.length < 2) {
    return (
      "## Cross-baseline deltas\n\n" +
      "Only one baseline is available — nothing to compare it against yet."
    );
  }
  const byBot = computeDeltasByBot(summaries);
  const sections = ARENA_BOT_ORDER.map((arenaId) => {
    const rows = byBot[arenaId].map((delta) => [
      delta.fromLabel,
      delta.toLabel,
      formatSignedCount(delta.posted),
      formatSignedCount(delta.distinct),
      formatSignedCount(delta.duplicateVariants),
      formatSignedPercentPoints(delta.duplicateRate),
      formatSignedPercentPoints(delta.actedUponAdjustedRate),
    ]);
    return `#### ${displayName(arenaId)}\n\n${renderTable(DELTA_TABLE_HEADER, rows)}`;
  });
  return `## Cross-baseline deltas\n\n${sections.join("\n\n")}`;
}

/**
 * The full report: one markdown table per baseline (oldest first), plus the cross-baseline delta
 * section. `summaries` is assumed already sorted — see `computeDeltasByBot`'s own note.
 */
export function renderTrendReport(summaries) {
  // Joined into one blob (not spread as separate array elements) so a blank line separates each
  // baseline's table from the next — spreading them left consecutive sections butting against each
  // other with a single newline, since the outer join below has no "" element between them.
  const sections = summaries.map((summary) => renderBaselineSection(summary)).join("\n\n");
  return [
    "# Reviewer arena trend",
    "",
    "One table per qualified baseline (`corpus/evidence/arena-baseline-*.json`, schemaVersion 1), " +
      "oldest first, plus how each bot's numbers moved between consecutive baselines. Zero network " +
      "and zero model spend — every number here already lived in a committed evidence file.",
    "",
    sections,
    "",
    renderDeltaSection(summaries),
    "",
  ].join("\n");
}

// -------------------------------------------------------------------------------------------------
// CLI (impure): discovers and reads the baseline files, then prints the pure report above. Not
// exercised by corpus/arena-trend.test.mjs, the same "thin and untested against the filesystem"
// boundary corpus/arena.mjs draws around its own `main`.
// -------------------------------------------------------------------------------------------------

function discoverBaselineFiles(evidenceDir) {
  return readdirSync(evidenceDir)
    .map((filename) => ({ filename, parsed: parseBaselineFilename(filename) }))
    .filter((entry) => entry.parsed !== null)
    .sort((a, b) => compareBaselineVersions(a.parsed, b.parsed));
}

function loadSummaries(evidenceDir) {
  const files = discoverBaselineFiles(evidenceDir);
  if (files.length === 0) {
    throw new Error(`no arena-baseline-vX.Y.Z.json files found under ${evidenceDir}`);
  }
  return files.map(({ filename, parsed }) => {
    const document = JSON.parse(readFileSync(join(evidenceDir, filename), "utf8"));
    return summarizeBaseline(`v${parsed.version}`, document);
  });
}

function main() {
  const flagIndex = process.argv.indexOf("--evidence-dir");
  const evidenceDir = flagIndex === -1 ? "corpus/evidence" : process.argv[flagIndex + 1];
  if (flagIndex !== -1 && evidenceDir === undefined) {
    console.error("--evidence-dir requires a path");
    process.exit(2);
  }
  try {
    console.log(renderTrendReport(loadSummaries(evidenceDir)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

// Only run when executed directly (`node corpus/arena-trend.mjs`), not when imported by a test.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
