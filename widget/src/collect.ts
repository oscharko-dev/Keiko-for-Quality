/**
 * Collects one repository's card numbers from the GitHub API — whole-window, tolerant, honest.
 *
 * Definitions, so the card means the same thing everywhere:
 * - `runs30d`: completed runs of the consumer's review workflow (any workflow file whose path
 *   contains `keiko-for-quality` or ends in `self-review.yml`) created in the trailing thirty
 *   days. Skipped and cancelled runs are not reviews — superseded pushes cancel their runs under
 *   the consumer's concurrency group — and do not count.
 * - `outcome`/`lastRunHours`: from the newest counted run. The API sees the job conclusion, not
 *   settlement, so green renders `complete` and red `incomplete`; the run summary on the pull
 *   request remains the authority.
 * - `findings`: review threads the reviewer bot opened on pull requests updated in the window,
 *   coverage stubs excluded (their body carries "was not fully reviewed").
 * - `actedOnPct`: the resolved share of those same threads.
 *
 * Two hard lessons are structural here, both measured live against oscharko-dev/Keiko:
 * - **No silent caps.** A fixed page or PR bound quietly turns a busy month into a sample — the
 *   first shipped collector read 345 window reviews as 131 and graded acted-on over the 30 most
 *   recently updated of 421 window pull requests. Every loop below pages until it leaves the
 *   window; the safety ceilings exist only against runaway pagination, and HITTING one degrades
 *   the metric to absent rather than reporting the floor as the truth.
 * - **Request budget.** The Cloudflare Worker route lives under a subrequest limit, so findings
 *   and acted-on come from paginated GraphQL search over the window (tens of pull requests per
 *   request) rather than two REST calls per pull request.
 *
 * Every failure degrades to `undefined` for that metric and the card renders an em dash; nothing
 * here invents a zero.
 */

import type { CardData } from "./card.js";

/** GraphQL reports a GitHub App's author login WITHOUT the "[bot]" suffix REST uses — measured
 *  live against oscharko-dev/Keiko, where the suffixed comparison counted zero threads. */
const BOT_LOGIN_GRAPHQL = "keiko-for-quality";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Runaway-pagination ceilings, far above any real window — see the header before raising. */
const MAX_RUN_PAGES = 30;
const MAX_SEARCH_PAGES = 40;

async function json<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  init?: { method?: string; body?: string },
): Promise<T | undefined> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "keiko-quality-widget",
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

interface WorkflowRun {
  readonly created_at?: string;
  readonly conclusion?: string | null;
  readonly status?: string;
}

function isReviewWorkflow(path: string | undefined): boolean {
  return (
    path !== undefined && (path.includes("keiko-for-quality") || path.endsWith("self-review.yml"))
  );
}

function isCoverageStub(body: string | undefined): boolean {
  return body?.includes("was not fully reviewed") === true;
}

function countsAsReview(run: WorkflowRun): boolean {
  if (run.status !== "completed") return false;
  return run.conclusion !== "skipped" && run.conclusion !== "cancelled";
}

interface RunStats {
  readonly runs30d?: number;
  readonly outcome?: CardData["outcome"];
  readonly lastRunHours?: number;
}

/** The review workflows' numeric ids — scoped-by-workflow run queries, because the flat
 *  `/actions/runs` listing returns the newest 100 runs of EVERY workflow and a dense CI pushes
 *  month-old review runs straight out of that window. */
async function reviewWorkflowIds(
  base: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<readonly number[] | undefined> {
  const reply = await json<{
    workflows?: readonly { readonly id?: number; readonly path?: string }[];
  }>(fetchImpl, `${base}/actions/workflows?per_page=100`, token);
  if (reply?.workflows === undefined) return undefined;
  return reply.workflows
    .filter((wf) => isReviewWorkflow(wf.path))
    .map((wf) => wf.id)
    .filter((id): id is number => id !== undefined);
}

interface WorkflowTally {
  readonly count: number;
  readonly newest: WorkflowRun | undefined;
}

/** Every window page of one workflow's runs; `undefined` when the window outruns the safety
 *  ceiling — the caller must then drop the metric, never publish the floor. */
async function tallyWorkflowRuns(
  base: string,
  workflowId: number,
  day: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<WorkflowTally | undefined> {
  let count = 0;
  let newest: WorkflowRun | undefined;
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const reply = await json<{ workflow_runs?: readonly WorkflowRun[] }>(
      fetchImpl,
      `${base}/actions/workflows/${String(workflowId)}/runs?per_page=100&page=${String(page)}&created=%3E${day}`,
      token,
    );
    if (reply?.workflow_runs === undefined) return undefined;
    const runs = reply.workflow_runs;
    for (const run of runs) {
      if (!countsAsReview(run)) continue;
      count += 1;
      newest ??= run;
    }
    if (runs.length < 100) return { count, newest };
  }
  return undefined;
}

function newerRun(a: WorkflowRun | undefined, b: WorkflowRun | undefined): WorkflowRun | undefined {
  if (a?.created_at === undefined) return b;
  if (b?.created_at === undefined) return a;
  return Date.parse(a.created_at) >= Date.parse(b.created_at) ? a : b;
}

async function collectRunStats(
  base: string,
  token: string,
  fetchImpl: typeof fetch,
  nowMs: number,
  since: number,
): Promise<RunStats> {
  const day = new Date(since).toISOString().slice(0, 10);
  const ids = await reviewWorkflowIds(base, token, fetchImpl);
  if (ids === undefined) return {};
  let runs30d = 0;
  let newest: WorkflowRun | undefined;
  for (const id of ids) {
    const tally = await tallyWorkflowRuns(base, id, day, token, fetchImpl);
    if (tally === undefined) return {};
    runs30d += tally.count;
    newest = newerRun(newest, tally.newest);
  }
  if (newest?.created_at === undefined) return { runs30d };
  return {
    runs30d,
    lastRunHours: Math.max(0, (nowMs - Date.parse(newest.created_at)) / HOUR_MS),
    outcome: newest.conclusion === "success" ? "complete" : "incomplete",
  };
}

/** One search page: every window pull request's review threads, tens of pull requests per
 *  request — the shape that keeps the Worker inside its subrequest budget. The thread
 *  connection carries its own page info because a review-heavy pull request overflows one page:
 *  measured live, five window pull requests held 110–249 threads against the 100-per-page cap. */
const SEARCH_QUERY =
  "query($q:String!,$after:String){search(query:$q,type:ISSUE,first:25,after:$after){" +
  "pageInfo{hasNextPage endCursor}nodes{... on PullRequest{number " +
  "reviewThreads(first:100){pageInfo{hasNextPage endCursor}" +
  "nodes{isResolved comments(first:1){nodes{author{login} body}}}}}}}}";

/** Follow-up pages of one pull request's threads, for the overflow case above. */
const THREADS_QUERY =
  "query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){" +
  "pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}" +
  "nodes{isResolved comments(first:1){nodes{author{login} body}}}}}}}";

/** Thread pages per pull request past the first — 10 covers a 1,100-thread pull request. */
const MAX_THREAD_PAGES = 10;

interface ThreadNode {
  readonly isResolved?: boolean;
  readonly comments?: {
    readonly nodes?: readonly {
      readonly author?: { readonly login?: string };
      readonly body?: string;
    }[];
  };
}

interface PageInfo {
  readonly hasNextPage?: boolean;
  readonly endCursor?: string | null;
}

interface ThreadConnection {
  readonly pageInfo?: PageInfo;
  readonly nodes?: readonly ThreadNode[];
}

interface SearchResults {
  readonly pageInfo?: PageInfo;
  readonly nodes?: readonly {
    readonly number?: number;
    readonly reviewThreads?: ThreadConnection;
  }[];
}

interface SearchPage {
  readonly data?: { readonly search?: SearchResults };
}

interface ThreadsPage {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: { readonly reviewThreads?: ThreadConnection };
    };
  };
}

/** A thread counts when the reviewer opened it and it is a finding, not a coverage stub. */
function isBotFindingThread(node: ThreadNode): boolean {
  const first = node.comments?.nodes?.[0];
  return first?.author?.login === BOT_LOGIN_GRAPHQL && !isCoverageStub(first.body);
}

interface FindingStats {
  readonly findings?: number;
  readonly actedOnPct?: number;
}

function finishedStats(tally: ThreadTally): FindingStats {
  const { findings, resolved } = tally;
  return { findings, ...(findings > 0 ? { actedOnPct: (resolved / findings) * 100 } : {}) };
}

interface ThreadTally {
  findings: number;
  resolved: number;
}

function tallyThreads(nodes: readonly ThreadNode[] | undefined, into: ThreadTally): void {
  const threads = (nodes ?? []).filter(isBotFindingThread);
  into.findings += threads.length;
  into.resolved += threads.filter((t: ThreadNode) => t.isResolved === true).length;
}

async function fetchThreadPage(
  owner: string,
  repo: string,
  prNumber: number,
  after: string | null,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ThreadConnection | undefined> {
  const reply = await json<ThreadsPage>(fetchImpl, "https://api.github.com/graphql", token, {
    method: "POST",
    body: JSON.stringify({
      query: THREADS_QUERY,
      variables: { o: owner, r: repo, n: prNumber, after },
    }),
  });
  return reply?.data?.repository?.pullRequest?.reviewThreads;
}

/** The overflow pages of one pull request's threads; false when the API failed or the ceiling
 *  was hit — the caller must then drop the metric rather than publish a floor. */
async function tallyOverflowThreads(
  owner: string,
  repo: string,
  prNumber: number,
  cursor: string | null,
  token: string,
  fetchImpl: typeof fetch,
  into: ThreadTally,
): Promise<boolean> {
  let after = cursor;
  for (let page = 1; page <= MAX_THREAD_PAGES; page += 1) {
    const conn = await fetchThreadPage(owner, repo, prNumber, after, token, fetchImpl);
    if (conn?.nodes === undefined) return false;
    tallyThreads(conn.nodes, into);
    if (conn.pageInfo?.hasNextPage !== true) return true;
    after = conn.pageInfo.endCursor ?? null;
  }
  return false;
}

/** One pull request's threads, first page plus any overflow; false means "drop the metric". */
async function tallyPullRequest(
  pr: { readonly number?: number; readonly reviewThreads?: ThreadConnection },
  owner: string,
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
  into: ThreadTally,
): Promise<boolean> {
  const conn = pr.reviewThreads;
  tallyThreads(conn?.nodes, into);
  if (conn?.pageInfo?.hasNextPage !== true) return true;
  if (pr.number === undefined) return false;
  const cursor = conn.pageInfo.endCursor ?? null;
  return tallyOverflowThreads(owner, repo, pr.number, cursor, token, fetchImpl, into);
}

async function fetchSearchPage(
  q: string,
  after: string | null,
  token: string,
  fetchImpl: typeof fetch,
): Promise<SearchResults | undefined> {
  const reply: SearchPage | undefined = await json<SearchPage>(
    fetchImpl,
    "https://api.github.com/graphql",
    token,
    { method: "POST", body: JSON.stringify({ query: SEARCH_QUERY, variables: { q, after } }) },
  );
  return reply?.data?.search;
}

async function collectFindingStats(
  owner: string,
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
  since: number,
): Promise<FindingStats> {
  const day = new Date(since).toISOString().slice(0, 10);
  const q = `repo:${owner}/${repo} is:pr updated:>${day}`;
  const tally: ThreadTally = { findings: 0, resolved: 0 };
  let after: string | null = null;
  for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
    const search = await fetchSearchPage(q, after, token, fetchImpl);
    if (search?.nodes === undefined) return {};
    for (const pr of search.nodes) {
      const complete = await tallyPullRequest(pr, owner, repo, token, fetchImpl, tally);
      if (!complete) return {};
    }
    if (search.pageInfo?.hasNextPage !== true) return finishedStats(tally);
    after = search.pageInfo.endCursor ?? null;
  }
  // The window outran the safety ceiling: absent beats publishing a floor as the truth.
  return {};
}

export async function collectCardData(
  owner: string,
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<CardData> {
  const since = nowMs - 30 * DAY_MS;
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const [runs, findingStats] = await Promise.all([
    collectRunStats(base, token, fetchImpl, nowMs, since),
    collectFindingStats(owner, repo, token, fetchImpl, since),
  ]);
  // Field-by-field under exactOptionalPropertyTypes: a metric is either present or absent —
  // an explicit `undefined` never enters CardData, matching the card's em-dash contract.
  const data: {
    owner: string;
    repo: string;
    runs30d?: number;
    findings?: number;
    actedOnPct?: number;
    outcome?: Exclude<CardData["outcome"], undefined>;
    lastRunHours?: number;
  } = { owner, repo };
  if (runs.runs30d !== undefined) data.runs30d = runs.runs30d;
  if (runs.outcome !== undefined) data.outcome = runs.outcome;
  if (runs.lastRunHours !== undefined) data.lastRunHours = runs.lastRunHours;
  if (findingStats.findings !== undefined) data.findings = findingStats.findings;
  if (findingStats.actedOnPct !== undefined) data.actedOnPct = findingStats.actedOnPct;
  return data;
}
