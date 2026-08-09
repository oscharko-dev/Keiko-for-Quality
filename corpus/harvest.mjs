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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverPullRequestNumbers,
  fetchPullRequestCommitTimeline,
  fetchPullRequestReviewThreads,
  runGh,
} from "./arena-fetch.mjs";
import { classifyActedUpon, clusterAcrossBots, clusterDuplicateFindings } from "./arena-lib.mjs";
import {
  buildHarvestDocument,
  escapesRepository,
  extractHarvestRecords,
  findRecallGaps,
  isIsoDate,
  parsePrList,
  parseRepoArgument,
  realLocation,
} from "./harvest-lib.mjs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

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

const parsedRepo = parseRepoArgument(argValue("--repo"));
if (parsedRepo === undefined) {
  usage("--repo <owner/name> is required, with exactly two non-empty components");
}
const { owner, name } = parsedRepo;
const repo = `${owner}/${name}`;
const since = argValue("--since");
const prsRaw = argValue("--prs");
if (since === undefined && prsRaw === undefined) usage("one of --since or --prs is required");
if (since !== undefined && prsRaw !== undefined) {
  usage("--since and --prs select different populations — pass exactly one");
}
if (since !== undefined && !isIsoDate(since)) usage(`--since must be YYYY-MM-DD, got: ${since}`);

const out = argValue("--out");
if (out === undefined) usage("--out <file.json> is required");
const outPath = realLocation(resolve(out));
if (!escapesRepository(REPO_ROOT, outPath)) {
  usage(
    `--out ${outPath} is inside this repository. The harvest carries verbatim third-party comment ` +
      "text and is never committed — write it elsewhere.",
  );
}

const withCommits = !process.argv.includes("--no-commits");

let numbers;
if (prsRaw === undefined) {
  try {
    numbers = discoverPullRequestNumbers(owner, name, since, "closed");
  } catch (error) {
    usage(error instanceof Error ? error.message : "could not list pull requests");
  }
} else {
  const parsed = parsePrList(prsRaw);
  if (parsed.bad !== undefined) {
    usage(`--prs contains values that are not pull request numbers: ${parsed.bad.join(", ")}`);
  }
  numbers = parsed.numbers;
}

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
  // An explicitly named pull request may still be open, and an open history is a moving one: a
  // refutation looks `refuted_confirmed` only because the push that contradicts it has not landed
  // yet. `--since` already filters to `closed`; this closes the `--prs` door.
  if (prsRaw !== undefined) {
    const state = JSON.parse(
      runGh(["api", `repos/${owner}/${name}/pulls/${String(number)}`, "--jq", "{state:.state}"]),
    ).state;
    if (state !== "closed") {
      throw new Error(
        `pull request is ${String(state)} — an open history cannot corroborate a refutation`,
      );
    }
  }
  const { threads, truncatedThreadCount } = fetchPullRequestReviewThreads(owner, name, number);
  // A thread whose replies did not fit one 50-comment page is a conversation we did not read
  // whole, and the missing reply is exactly what decides a disposition. Refused, not graded.
  if (truncatedThreadCount > 0) {
    throw new Error(
      `${String(truncatedThreadCount)} thread(s) have more replies than one page — the harvest ` +
        "would grade a partial conversation",
    );
  }
  const { records } = extractHarvestRecords(threads);
  const commits = withCommits ? fetchPullRequestCommitTimeline(owner, name, number) : [];

  const findings = records.filter((record) => !record.isNotice && record.arenaId !== null);
  const byBot = {};
  for (const finding of findings) {
    byBot[finding.arenaId] ??= [];
    byBot[finding.arenaId].push(finding);
  }
  // One representative per within-bot duplicate cluster, which is what `clusterAcrossBots` is
  // documented to expect. Same-bot findings are never joined there, so a bot that paraphrased one
  // objection three times used to yield three separate recall gaps from a single missed defect.
  const representatives = {};
  for (const [arenaId, list] of Object.entries(byBot)) {
    representatives[arenaId] = clusterDuplicateFindings(list).map((cluster) =>
      list.find((finding) => finding.databaseId === cluster.memberDatabaseIds[0]),
    );
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
  // Without a commit timeline nothing can be classified `acted_upon`, so the gap set is not
  // "empty", it is UNMEASURED — reported as absent rather than as a passing zero.
  const recallGaps = withCommits
    ? findRecallGaps(clusterAcrossBots(representatives), actedUpon)
    : undefined;
  return { number, commits, records, ...(recallGaps === undefined ? {} : { recallGaps }) };
}

const prs = [];
const skipped = [];
for (const number of numbers) {
  // One unreadable pull request must not void the harvest: reported and skipped, the same posture
  // the precision gate takes for a measurement failure.
  try {
    prs.push(harvestOne(number));
    process.stderr.write(`#${String(number)} `);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "?";
    skipped.push({ number, reason });
    console.error(`\nskipped #${String(number)}: ${reason}`);
  }
}
process.stderr.write("\n");

// A run where everything was skipped writes a valid-looking zero-finding document and exits 0 —
// a total measurement failure wearing the shape of a clean harvest. It fails instead.
if (prs.length === 0) {
  console.error(
    `harvest: all ${String(numbers.length)} requested pull request(s) were skipped — nothing was ` +
      "measured. Check `gh auth status` and rate limits.",
  );
  process.exit(1);
}

const document = buildHarvestDocument({
  repo,
  generatedAt: new Date().toISOString(),
  prs,
  skipped,
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
  document.aggregate.recallGaps === null
    ? "  recall gaps: NOT MEASURED (--no-commits gives nothing to classify as acted upon)"
    : `  recall gaps (acted upon, we said nothing): ${String(document.aggregate.recallGaps)}`,
);
if (skipped.length > 0) {
  console.log(`  ${String(skipped.length)} pull request(s) skipped and NOT in these numbers:`);
  for (const entry of skipped) console.log(`    #${String(entry.number)}: ${entry.reason}`);
}
console.log(
  `\nOnly \`refuted_confirmed\` may become a suppression rule — see harvest-lib.mjs for why.`,
);
