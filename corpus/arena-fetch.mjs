import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter as pathDelimiter, join as joinPath } from "node:path";

/**
 * The impure half of the arena scoreboard (issue #39): everything that calls `gh`.
 *
 * `corpus/arena-lib.mjs`'s header comment explains why the *pure* computation is tested against
 * fixtures instead of a live pull request. This module's own logic — pagination, error surfacing,
 * resolving `gh` itself — is tested the same hermetic way, in `corpus/arena-fetch.test.mjs`, by
 * passing a fake `runGh` in place of the real one; only `runGh`/`runGraphql` themselves, the two
 * functions that actually invoke a subprocess, are untested against the network. This module's job
 * is to turn "a repo and a pull request number" into the raw GraphQL shape `extractConversations`
 * consumes, and "a repo and a date" into a list of pull request numbers. It never reads the model
 * credential, never publishes anything, and reads only data already public in the target repository
 * through the ambient `gh` authentication of whoever runs it.
 *
 * GraphQL, not the REST review-comments endpoint, because thread resolution (`isResolved`,
 * `isOutdated`) has no REST equivalent, and the REST and GraphQL author logins differ in a way
 * worth knowing about: REST appends `[bot]` to a bot login, GraphQL does not. Fetching everything
 * through one API means `arena-lib.mjs` only has to understand one shape.
 */

/**
 * Resolves `gh` to an absolute path by walking `PATH` once, ourselves, instead of invoking the bare
 * command name and letting the OS search for it on every call. This is this repository's static
 * analysis's actual request (CWE-426/427, "OS commands should not rely on PATH resolution"): once
 * `execFileSync` is given a path containing a separator, it does not search `PATH` at all, which is
 * the real mitigation — not a particular shape of the `env` option, which does not change how the
 * executable itself is located. `exists` is injectable so the search itself is testable against a
 * temporary directory rather than the real filesystem's real `PATH`.
 */
export function resolveGhBinary(exists = existsSync) {
  const executableNames = process.platform === "win32" ? ["gh.exe", "gh.cmd", "gh.bat"] : ["gh"];
  const directories = (process.env.PATH ?? "").split(pathDelimiter).filter((dir) => dir !== "");
  for (const directory of directories) {
    for (const executableName of executableNames) {
      const candidate = joinPath(directory, executableName);
      if (exists(candidate)) return candidate;
    }
  }
  throw new Error("gh was not found on PATH — install the GitHub CLI (https://cli.github.com)");
}

let cachedGhBinary;

/**
 * Runs `gh` at its resolved absolute path (cached after the first call) with the full ambient
 * environment: `gh` authenticates through any of several mechanisms (a config file under `HOME`,
 * `GH_TOKEN`, `GITHUB_TOKEN`, an enterprise host, …), and this reads only data already public in the
 * target repository, so there is no credential here worth narrowing the environment to protect —
 * unlike the engine invocations elsewhere in `corpus/`, which do carry a model credential.
 */
function runGh(args) {
  cachedGhBinary ??= resolveGhBinary();
  return execFileSync(cachedGhBinary, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 50) {
            totalCount
            nodes {
              databaseId
              url
              body
              path
              line
              originalLine
              startLine
              originalStartLine
              createdAt
              commit { oid }
              author { login __typename }
              replyTo { databaseId }
            }
          }
        }
      }
    }
  }
}`;

function runGraphql(runGhImpl, variables, after) {
  const raw = runGhImpl([
    "api",
    "graphql",
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    "-F",
    `owner=${variables.owner}`,
    "-F",
    `repo=${variables.repo}`,
    "-F",
    `number=${String(variables.number)}`,
    ...(after === null ? [] : ["-F", `after=${after}`]),
  ]);
  return JSON.parse(raw);
}

/**
 * Merges one GraphQL page's threads into the accumulator and reports the result of doing so.
 * Split out of `fetchPullRequestReviewThreads` so that function's own control flow — the page loop
 * and its two failure modes — stays simple enough to read in one pass.
 */
function mergePage(threads, response, owner, repo, number) {
  if (response.errors) {
    throw new Error(
      `GitHub GraphQL error for ${owner}/${repo}#${String(number)}: ${JSON.stringify(response.errors)}`,
    );
  }
  const pullRequest = response.data?.repository?.pullRequest;
  if (!pullRequest)
    throw new Error(`pull request ${owner}/${repo}#${String(number)} was not found`);
  let truncatedThreadCount = 0;
  for (const thread of pullRequest.reviewThreads.nodes) {
    if (thread.comments.totalCount > thread.comments.nodes.length) truncatedThreadCount += 1;
    threads.push(thread);
  }
  return {
    headSha: pullRequest.headRefOid,
    pageInfo: pullRequest.reviewThreads.pageInfo,
    truncatedThreadCount,
  };
}

/** However large a real pull request's review-thread list could plausibly be paginated to. */
const MAX_THREAD_PAGES = 50;

/**
 * Fetches every review thread on one pull request, following both pagination dimensions: the
 * thread list itself, and — defensively — the comments within a single thread, though no thread
 * observed while building this tool carried more than two. A thread whose reply count this run
 * could not fully page is reported rather than silently truncated (`truncatedThreadCount`), and the
 * same discipline applies to the outer page limit: a pull request with more review threads than
 * `MAX_THREAD_PAGES` pages can hold throws instead of silently returning a partial list, so a
 * partial scoreboard is never mistaken for a complete one.
 *
 * `runGhImpl` defaults to the real, network-calling `runGh` and is overridden in tests with a fake
 * that returns canned GraphQL responses, so the pagination and error-handling logic above is
 * verified without a network call or a `gh` installation.
 */
export function fetchPullRequestReviewThreads(owner, repo, number, runGhImpl = runGh) {
  const threads = [];
  let headSha = null;
  let after = null;
  let truncatedThreadCount = 0;
  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    const response = runGraphql(runGhImpl, { owner, repo, number }, after);
    const merged = mergePage(threads, response, owner, repo, number);
    headSha = merged.headSha;
    truncatedThreadCount += merged.truncatedThreadCount;
    if (!merged.pageInfo.hasNextPage) return { headSha, threads, truncatedThreadCount };
    after = merged.pageInfo.endCursor;
  }
  throw new Error(
    `pull request ${owner}/${repo}#${String(number)} has more than ${String(MAX_THREAD_PAGES)} ` +
      "pages of review threads — this run cannot page all of them",
  );
}

/**
 * Lists pull request numbers created on or after `sinceDate` (an ISO date, `YYYY-MM-DD`), in
 * ascending number order. Used only by `--since`; a caller that already knows which pull requests
 * to measure has no reason to call this. `runGhImpl` is injectable for the same reason as above.
 */
export function discoverPullRequestNumbers(
  owner,
  repo,
  sinceDate,
  state = "all",
  runGhImpl = runGh,
) {
  const raw = runGhImpl([
    "pr",
    "list",
    "--repo",
    `${owner}/${repo}`,
    "--state",
    state,
    "--search",
    `created:>=${sinceDate}`,
    "--json",
    "number",
    "--limit",
    "200",
  ]);
  return JSON.parse(raw)
    .map((entry) => entry.number)
    .sort((a, b) => a - b);
}
