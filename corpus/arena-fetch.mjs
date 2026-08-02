import { execFileSync } from "node:child_process";

/**
 * The impure half of the arena scoreboard (issue #39): everything that calls `gh`.
 *
 * Deliberately thin and untested against the network — `corpus/arena-lib.mjs`'s header comment
 * explains why. This module's only job is to turn "a repo and a pull request number" into the raw
 * GraphQL shape `extractConversations` consumes, and "a repo and a date" into a list of pull
 * request numbers. It never reads the model credential, never publishes anything, and reads only
 * data already public in the target repository through the ambient `gh` authentication of whoever
 * runs it.
 *
 * GraphQL, not the REST review-comments endpoint, because thread resolution (`isResolved`,
 * `isOutdated`) has no REST equivalent, and the REST and GraphQL author logins differ in a way
 * worth knowing about: REST appends `[bot]` to a bot login, GraphQL does not. Fetching everything
 * through one API means `arena-lib.mjs` only has to understand one shape.
 */

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

/**
 * The environment `gh` is allowed to see: `PATH` to be found at all, plus every variable `gh help
 * environment` documents as one of its own ambient authentication mechanisms (a config file under
 * `HOME`/`XDG_CONFIG_HOME`/`GH_CONFIG_DIR`, a `github.com` token, or a GitHub Enterprise Server
 * token and host). Listed explicitly, like the engine invocations elsewhere in `corpus/`, rather
 * than passed through wholesale — this repository's static analysis requires `PATH` to be a fixed
 * value a child process could not widen, and an explicit list is also the honest documentation of
 * what this script can actually authenticate with. A key `gh` does not see falls back to its own
 * defaults; Node omits an `undefined` value from the child's environment rather than stringifying
 * it, so a variable unset here is unset there too, not the literal text `"undefined"`.
 */
function runGh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
      GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN,
      GH_HOST: process.env.GH_HOST,
    },
  });
}

function runGraphql(variables, after) {
  const raw = runGh([
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
 * Fetches every review thread on one pull request, following both pagination dimensions: the
 * thread list itself, and — defensively — the comments within a single thread, though no thread
 * observed while building this tool carried more than two. A thread whose reply count this run
 * could not fully page is reported rather than silently truncated, so a future pull request with an
 * unusually long conversation cannot quietly lose data to a hard page size.
 */
export function fetchPullRequestReviewThreads(owner, repo, number) {
  const threads = [];
  let headRefOid = null;
  let after = null;
  let truncatedThreadCount = 0;
  for (let page = 0; page < 50; page += 1) {
    const response = runGraphql({ owner, repo, number }, after);
    if (response.errors) {
      throw new Error(
        `GitHub GraphQL error for ${owner}/${repo}#${String(number)}: ${JSON.stringify(response.errors)}`,
      );
    }
    const pullRequest = response.data?.repository?.pullRequest;
    if (!pullRequest)
      throw new Error(`pull request ${owner}/${repo}#${String(number)} was not found`);
    headRefOid = pullRequest.headRefOid;
    const connection = pullRequest.reviewThreads;
    for (const thread of connection.nodes) {
      if (thread.comments.totalCount > thread.comments.nodes.length) truncatedThreadCount += 1;
      threads.push(thread);
    }
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return { headSha: headRefOid, threads, truncatedThreadCount };
}

/**
 * Lists pull request numbers created on or after `sinceDate` (an ISO date, `YYYY-MM-DD`), newest
 * first. Used only by `--since`; a caller that already knows which pull requests to measure has no
 * reason to call this.
 */
export function discoverPullRequestNumbers(owner, repo, sinceDate, state = "all") {
  const raw = runGh([
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
