#!/usr/bin/env node
// The harvest's driver: read a consumer's closed pull requests and write every finding, every
// reply, and what git did afterwards, as labelled teaching examples. See `harvest-lib.mjs` for what
// the labels mean and why only one of them may become a rule.
//
//   node corpus/harvest.mjs --repo oscharko-dev/Keiko --since 2026-07-01 --out ~/kfq-harvest.json
//   node corpus/harvest.mjs --repo oscharko-dev/Keiko --prs 3037,3031 --out ~/kfq-harvest.json
//
// Reads only — no model call, no token spend, nothing written to the consumer. `gh` supplies the
// credential the same way `arena.mjs` and `precision-gate.mjs` do.
//
// **`--out` must point outside this repository.** The document carries verbatim comment text
// written by humans and by third-party bots on a public repository, which is exactly what the
// committed arena evidence redacts. This driver refuses a path inside the repository tree rather
// than trusting the operator to remember; only distilled rules, reviewed as a pull request in the
// consumer, ever become durable.
//
// The commit timeline is the expensive half — one REST call per commit per pull request — and it is
// what separates "the reader said this was wrong" from "the reader said this was wrong and then
// never touched that code". That distinction is the point, so it is ON by default and `--no-commits`
// turns it off for a cheap survey. A survey run cannot confirm a refutation, and its labels say so.

import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  discoverPullRequestNumbers,
  fetchPullRequestCommitTimeline,
  fetchPullRequestReviewThreads,
} from "./arena-fetch.mjs";
import { classifyActedUpon, clusterAcrossBots } from "./arena-lib.mjs";
import { buildHarvestDocument, extractHarvestRecords, findRecallGaps } from "./harvest-lib.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function usage(message) {
  console.error(message);
  console.error(
    "usage: node corpus/harvest.mjs --repo <owner/name> (--since <YYYY-MM-DD> | --prs <n,n>)" +
      " --out <path outside this repo> [--no-commits]",
  );
  process.exit(2);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const repo = argValue("--repo");
if (repo?.includes("/") !== true) usage("--repo <owner/name> is required");
const [owner, name] = repo.split("/");
const since = argValue("--since");
const prsRaw = argValue("--prs");
if (since === undefined && prsRaw === undefined) usage("one of --since or --prs is required");

const out = argValue("--out");
if (out === undefined) usage("--out <file.json> is required");
const outPath = resolve(out);
const insideRepo = !relative(REPO_ROOT, outPath).startsWith("..");
if (insideRepo) {
  usage(
    `--out ${outPath} is inside this repository. The harvest carries verbatim third-party comment ` +
      "text and is never committed — write it elsewhere.",
  );
}

const withCommits = !process.argv.includes("--no-commits");

const numbers =
  prsRaw === undefined
    ? discoverPullRequestNumbers(owner, name, since, "closed")
    : prsRaw
        .split(",")
        .map((token) => Number(token.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);

if (numbers.length === 0) usage("no pull requests matched");

/**
 * One pull request's findings, replies, commit timeline, and cross-bot recall gaps.
 *
 * Cross-bot clustering runs on the non-notice findings of every bot, and a cluster carrying no
 * `kfq` entry is a candidate gap — filtered in `findRecallGaps` to the ones a later commit actually
 * touched, because path-plus-window clustering alone cannot tell a missed defect from a nitpick
 * nobody wanted.
 */
function harvestOne(number) {
  const { threads } = fetchPullRequestReviewThreads(owner, name, number);
  const { records } = extractHarvestRecords(threads);
  const commits = withCommits ? fetchPullRequestCommitTimeline(owner, name, number) : [];

  const findings = records.filter((record) => !record.isNotice && record.arenaId !== null);
  const byBot = {};
  for (const finding of findings) {
    byBot[finding.arenaId] ??= [];
    byBot[finding.arenaId].push(finding);
  }

  const actedUpon = new Map(
    commits.length === 0
      ? []
      : findings.map((finding) => [
          finding.databaseId,
          {
            arenaId: finding.arenaId,
            classification: classifyActedUpon(finding, commits).classification,
          },
        ]),
  );
  const recallGaps = findRecallGaps(clusterAcrossBots(byBot), actedUpon);
  return { number, commits, records, recallGaps };
}

const prs = [];
for (const number of numbers) {
  // One unreadable pull request must not void the harvest: reported and skipped, the same posture
  // the precision gate takes for a measurement failure.
  try {
    prs.push(harvestOne(number));
    process.stderr.write(`#${String(number)} `);
  } catch (error) {
    console.error(`\nskipped #${String(number)}: ${error instanceof Error ? error.message : "?"}`);
  }
}
process.stderr.write("\n");

const document = buildHarvestDocument({
  repo,
  generatedAt: new Date().toISOString(),
  prs,
});
writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);

const counts = document.aggregate.byLabel;
console.log(
  `harvest: ${String(document.aggregate.findings)} findings from ${String(prs.length)} pull requests`,
);
console.log(`  written to ${outPath} (unredacted — never commit this)`);
if (!withCommits) {
  console.log(
    "  --no-commits: no refutation in this run can be confirmed, and none is labelled so",
  );
}
for (const [label, count] of Object.entries(counts)) {
  console.log(`  ${label.padEnd(22)} ${String(count)}`);
}
console.log(
  `  recall gaps (acted upon, we said nothing): ${String(document.aggregate.recallGaps)}`,
);
console.log(
  `\nOnly \`refuted_confirmed\` may become a suppression rule — see harvest-lib.mjs for why.`,
);
