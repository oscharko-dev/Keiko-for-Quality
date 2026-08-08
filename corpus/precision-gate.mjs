#!/usr/bin/env node
// The precision gate's driver: read a consumer's recent pull requests and report how many of this
// reviewer's published findings a reader actually acted on. See `precision-gate-lib.mjs` for what
// the rate means and why no other gate in this repository can see it.
//
//   node corpus/precision-gate.mjs --repo oscharko-dev/Keiko --since 2026-08-01
//   node corpus/precision-gate.mjs --repo oscharko-dev/Keiko --prs 3037,3041 --threshold 0.5
//
// Reads only — no model call, no token spend, nothing written to the consumer. `gh` supplies the
// credential the same way `arena.mjs` uses it.

import { writeFileSync } from "node:fs";

import { discoverPullRequestNumbers, fetchPullRequestReviewThreads } from "./arena-fetch.mjs";
import {
  actionableRate,
  gradePullRequest,
  renderReport,
  sumRecords,
  verdictOf,
} from "./precision-gate-lib.mjs";

const DEFAULT_IDENTITY = "keiko-for-quality";
/**
 * Half of the answered findings being right is the floor this gate defends, not an aspiration.
 * The measurement that motivated the gate stood at 17%; a reviewer below one-in-two is spending
 * more of its reader's attention on refutations than on repairs, which is the failure the mandate
 * names. It is deliberately not set at the level a good reviewer should reach — a gate that fails
 * on a normal day teaches people to ignore it.
 */
const DEFAULT_THRESHOLD = 0.5;

function usage(message) {
  console.error(message);
  console.error(
    "usage: node corpus/precision-gate.mjs --repo <owner/name> (--since <YYYY-MM-DD> | --prs <n,n>)" +
      " [--identity <login>] [--threshold <0..1>] [--out <file.md>]",
  );
  process.exit(2);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const repo = argValue("--repo");
if (repo === undefined || !repo.includes("/")) usage("--repo <owner/name> is required");
const [owner, name] = repo.split("/");
const identity = argValue("--identity") ?? DEFAULT_IDENTITY;
const thresholdRaw = argValue("--threshold");
const threshold = thresholdRaw === undefined ? DEFAULT_THRESHOLD : Number(thresholdRaw);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  usage("--threshold must be a number between 0 and 1");
}
const since = argValue("--since");
const prsRaw = argValue("--prs");
if (since === undefined && prsRaw === undefined) usage("one of --since or --prs is required");

const numbers =
  prsRaw === undefined
    ? discoverPullRequestNumbers(owner, name, since, "closed")
    : prsRaw
        .split(",")
        .map((token) => Number(token.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);

if (numbers.length === 0) usage("no pull requests matched");

const perPr = [];
for (const number of numbers) {
  // One unreadable pull request must not void the window: it is reported and skipped, the same
  // posture the completion gate takes for a measurement failure.
  try {
    const { threads } = fetchPullRequestReviewThreads(owner, name, number);
    const record = gradePullRequest(threads, identity);
    if (record.findings > 0) perPr.push({ number, record });
  } catch (error) {
    console.error(`skipped #${String(number)}: ${error instanceof Error ? error.message : "?"}`);
  }
}

const totals = sumRecords(perPr.map((entry) => entry.record));
const report = renderReport({
  repo,
  identity,
  threshold,
  perPr,
  totals,
  generatedAt: new Date().toISOString(),
});
console.log(report);

const out = argValue("--out");
if (out !== undefined) writeFileSync(out, report);

const verdict = verdictOf(actionableRate(totals), threshold);
// GREY exits 0: a window nobody answered is not a failure of the reviewer, and failing on it would
// make the gate a coin flip on quiet days.
process.exit(verdict === "RED" ? 1 : 0);
