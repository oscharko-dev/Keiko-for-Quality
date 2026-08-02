#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildEvidenceDocument, extractConversations, renderMarkdown } from "./arena-lib.mjs";
import { discoverPullRequestNumbers, fetchPullRequestReviewThreads } from "./arena-fetch.mjs";

/**
 * The reviewer arena scoreboard (issue #39): measures Keiko for Quality head-to-head against
 * CodeRabbit and Codex on real, already-co-reviewed Keiko pull requests.
 *
 * Every eligible Keiko pull request is, since this reviewer's activation, reviewed by all three
 * bots on the identical head — a controlled comparison a solo review history could never provide.
 * This script turns that into a repeatable measurement instead of something read by hand: it
 * fetches each bot's inline review threads through the GitHub API (read-only, no publication, no
 * model call — see `corpus/arena-fetch.mjs`), attributes and normalizes them
 * (`corpus/arena-lib.mjs`), and emits a deterministic JSON evidence document plus a human Markdown
 * scoreboard. Nothing here scores "correctness" — that needs a human, and the epic this issue
 * belongs to (#26) is explicit that this script records, a person judges.
 *
 * Usage:
 *   node corpus/arena.mjs [--repo owner/name] [--generated-at ISO8601] [--out-dir dir]
 *     [--out-json path] [--out-md path] <prNumber> [prNumber...]
 *
 *   node corpus/arena.mjs [--repo owner/name] --since YYYY-MM-DD [--state open|closed|all] [...]
 *
 * Requires only ambient `gh` authentication with read access to the target repository — the same
 * data any collaborator can already see on the pull request's "Files changed" tab.
 *
 * Defaults: repo `oscharko-dev/Keiko`, output under `corpus/evidence/arena-latest.{json,md}`.
 * `--generated-at` exists so a caller can pin the document's timestamp for a reproducible archival
 * copy; omitted, it is the wall clock at invocation, which is why that clock lives here and nowhere
 * inside `corpus/arena-lib.mjs`.
 */

function parseArgs(argv) {
  const options = {
    repo: "oscharko-dev/Keiko",
    since: null,
    state: "all",
    generatedAt: new Date().toISOString(),
    outDir: "corpus/evidence",
    outJson: null,
    outMd: null,
    prNumbers: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (arg === "--repo") options.repo = next();
    else if (arg === "--since") options.since = next();
    else if (arg === "--state") options.state = next();
    else if (arg === "--generated-at") options.generatedAt = next();
    else if (arg === "--out-dir") options.outDir = next();
    else if (arg === "--out-json") options.outJson = next();
    else if (arg === "--out-md") options.outMd = next();
    else if (/^\d+$/.test(arg)) options.prNumbers.push(Number(arg));
    else {
      console.error(`unrecognized argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function usageAndExit() {
  console.error(
    "usage: node corpus/arena.mjs [--repo owner/name] [--generated-at ISO8601] " +
      "[--out-dir dir] [--out-json path] [--out-md path] " +
      "(<prNumber> [prNumber...] | --since YYYY-MM-DD [--state open|closed|all])",
  );
  process.exit(2);
}

function resolvePrNumbers(options, owner, repoName) {
  if (options.since !== null) {
    if (options.prNumbers.length > 0) {
      console.error("pass either explicit pull request numbers or --since, not both");
      process.exit(2);
    }
    return discoverPullRequestNumbers(owner, repoName, options.since, options.state);
  }
  if (options.prNumbers.length === 0) usageAndExit();
  return [...new Set(options.prNumbers)].sort((a, b) => a - b);
}

function loadPr(owner, repoName, number) {
  const { headSha, threads, truncatedThreadCount } = fetchPullRequestReviewThreads(
    owner,
    repoName,
    number,
  );
  if (truncatedThreadCount > 0) {
    console.error(
      `warning: pull request #${String(number)} has ${String(truncatedThreadCount)} thread(s) ` +
        "with more replies than this run paged in — see corpus/arena-fetch.mjs",
    );
  }
  return { number, headSha, ...extractConversations(threads) };
}

function writeOutputs(options, document, markdown) {
  const jsonPath = options.outJson ?? join(options.outDir, "arena-latest.json");
  const mdPath = options.outMd ?? join(options.outDir, "arena-latest.md");
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(mdPath, `${markdown}\n`);
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const [owner, repoName] = options.repo.split("/");
  if (!owner || !repoName) {
    console.error(`--repo must be "owner/name", got: ${options.repo}`);
    process.exit(2);
  }
  const prNumbers = resolvePrNumbers(options, owner, repoName);
  if (prNumbers.length === 0) {
    console.error("no pull requests to measure");
    process.exit(2);
  }
  console.log(`arena: ${options.repo}, pull request(s) ${prNumbers.join(", ")}`);
  const prs = prNumbers.map((number) => loadPr(owner, repoName, number));
  const document = buildEvidenceDocument({
    repo: options.repo,
    generatedAt: options.generatedAt,
    prs,
  });
  const markdown = renderMarkdown(document);
  console.log(`\n${markdown}`);
  writeOutputs(options, document, markdown);
}

main();
