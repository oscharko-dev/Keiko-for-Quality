#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 *
 * `parseArgs` and `resolvePrNumbers` raise a plain `Error` on invalid input rather than calling
 * `process.exit` themselves — only `main` does that, in one place, after catching. That is what
 * makes both functions testable in `corpus/arena.test.mjs` without a test run being able to
 * terminate itself.
 */

export const USAGE =
  "usage: node corpus/arena.mjs [--repo owner/name] [--generated-at ISO8601] " +
  "[--out-dir dir] [--out-json path] [--out-md path] " +
  "(<prNumber> [prNumber...] | --since YYYY-MM-DD [--state open|closed|all])";

export function parseArgs(argv) {
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
      // A flag with nothing after it must fail here, with a message that names the flag — not
      // later, as `undefined` silently flowing into `--repo`'s `.split("/")`, `--since`'s
      // `options.since !== null` check (which `undefined` still passes), or the evidence
      // document's own `generatedAt` field.
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
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
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return options;
}

/**
 * Decides which pull request numbers to measure: the ones named explicitly (deduplicated and
 * sorted), or the result of `--since` discovery. `discover` is injectable so this decision — not
 * the network call `discoverPullRequestNumbers` itself makes — is what `arena.test.mjs` verifies.
 */
export function resolvePrNumbers(options, owner, repoName, discover = discoverPullRequestNumbers) {
  if (options.since !== null) {
    if (options.prNumbers.length > 0) {
      throw new Error("pass either explicit pull request numbers or --since, not both");
    }
    return discover(owner, repoName, options.since, options.state);
  }
  if (options.prNumbers.length === 0) throw new Error(USAGE);
  return [...new Set(options.prNumbers)].sort((a, b) => a - b);
}

/** Splits `owner/name` into its parts, or throws — the one shape every downstream call assumes. */
export function splitRepo(repo) {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) throw new Error(`--repo must be "owner/name", got: ${repo}`);
  return { owner, repoName };
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

function run() {
  const options = parseArgs(process.argv.slice(2));
  const { owner, repoName } = splitRepo(options.repo);
  const prNumbers = resolvePrNumbers(options, owner, repoName);
  if (prNumbers.length === 0) throw new Error("no pull requests to measure");
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

function main() {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

// Only run when executed directly (`node corpus/arena.mjs`), not when imported by a test.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
