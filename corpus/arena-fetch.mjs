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
 *
 * `corpus/live-telemetry.mjs` runs its own `gh` calls through this one — the same posture holds
 * there (workflow run metadata and job logs of a repository the caller can already open in a
 * browser). The 64 MB `maxBuffer` is the reason to keep it single: a run log that outgrows the
 * bound throws rather than truncating, and raising it must not have to be remembered twice.
 */
export function runGh(args) {
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

// ---------------------------------------------------------------------------------------------
// Commit timeline fetch (issue #56): the git-data half of acted-upon linking.
//
// `corpus/arena-lib.mjs`'s "Acted-upon linking" section explains what this is for and how the
// result is used; this half only turns "a repo and a pull request number" into the commit list
// that computation reads. REST, not GraphQL, this time: a pull request's commit list and each
// commit's per-file unified-diff patch are REST concepts with no GraphQL equivalent worth using,
// unlike thread resolution above, which is why `fetchPullRequestReviewThreads` goes the other way.
// ---------------------------------------------------------------------------------------------

/**
 * However many commits GitHub's pull-request-commits endpoint reliably returns; the endpoint is
 * documented to cap out around this figure regardless of pagination, so a count at or above it is
 * reported rather than trusted as complete — the same discipline `MAX_THREAD_PAGES` above applies
 * to review threads.
 */
const MAX_PR_COMMITS = 250;

/**
 * Lists the SHAs of every commit currently in the pull request, oldest first as GitHub orders
 * them. "Currently" matters: a force-push drops a superseded commit from this list even though it
 * still exists in the repository's object database, which is exactly the signal issue #56's
 * `outdated_by_rebase` classification needs — a finding anchored to a commit no longer reachable
 * from here has, from this pull request's own perspective, had its history rewritten out from
 * under it.
 */
export function fetchPullRequestCommitShas(owner, repo, number, runGhImpl = runGh) {
  const raw = runGhImpl([
    "api",
    `repos/${owner}/${repo}/pulls/${String(number)}/commits`,
    "--paginate",
  ]);
  const commits = JSON.parse(raw);
  if (commits.length >= MAX_PR_COMMITS) {
    console.error(
      `warning: pull request ${owner}/${repo}#${String(number)} reports ${String(commits.length)} ` +
        `commits — GitHub's pull-request-commits endpoint is not guaranteed to page past ` +
        `${String(MAX_PR_COMMITS)}; the commit timeline used for acted-upon linking may be incomplete`,
    );
  }
  return commits.map((commit) => commit.sha);
}

/** Renames GitHub's REST file-entry shape into the camelCase shape `corpus/arena-lib.mjs` reads. */
function normalizeFileEntry(file) {
  return {
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    status: file.status,
    patch: file.patch ?? null,
  };
}

/**
 * Fetches one commit's committer date and per-file status/patch. `files` is absent from GitHub's
 * response for a commit that changed an unusually large number of files, in which case this reports
 * an empty list rather than guessing — the same "unmappable, not silently wrong" discipline
 * `corpus/arena-lib.mjs` applies to one file's own missing `patch`.
 */
export function fetchCommitWithFiles(owner, repo, sha, runGhImpl = runGh) {
  const raw = runGhImpl(["api", `repos/${owner}/${repo}/commits/${sha}`]);
  const parsed = JSON.parse(raw);
  return {
    sha: parsed.sha,
    committedDate: parsed.commit?.committer?.date ?? parsed.commit?.author?.date ?? null,
    files: (parsed.files ?? []).map(normalizeFileEntry),
  };
}

/**
 * Fetches the pull request's full commit timeline for issue #56's acted-upon linking: every commit
 * currently in the pull request, each with its own committer date and per-file diff. One
 * `pulls/.../commits` call plus one `commits/{sha}` call per commit — a pull request with `n`
 * commits costs `n + 1` read-only API calls. Sorted by committed date (SHA as a tiebreak) so every
 * caller sees the same chronological order regardless of what GitHub happened to return.
 */
export function fetchPullRequestCommitTimeline(owner, repo, number, runGhImpl = runGh) {
  const shas = fetchPullRequestCommitShas(owner, repo, number, runGhImpl);
  const commits = shas.map((sha) => fetchCommitWithFiles(owner, repo, sha, runGhImpl));
  return commits
    .slice()
    .sort((a, b) => a.committedDate.localeCompare(b.committedDate) || a.sha.localeCompare(b.sha));
}
