/**
 * Collects one repository's card numbers from the GitHub API — bounded, tolerant, and honest.
 *
 * Definitions, so the card means the same thing everywhere:
 * - `runs30d`: completed, non-skipped runs of the consumer's review workflow (any workflow file
 *   whose path contains `keiko-for-quality` or ends in `self-review.yml`) created in the
 *   trailing thirty days.
 * - `outcome`/`lastRunHours`: from the newest of those runs. The REST API sees the job
 *   conclusion, not settlement, so green renders `complete` and red renders `incomplete` — a
 *   bounded simplification; the run summary on the pull request remains the authority.
 * - `findings`: review comments authored by the reviewer bot on pull requests updated in the
 *   window, coverage stubs excluded (their body carries "was not fully reviewed").
 * - `actedOnPct`: resolved review threads among the bot's threads on those pull requests, via
 *   one GraphQL query per pull request, bounded at `MAX_PRS` pull requests and 100 threads
 *   each.
 *
 * Every failure degrades to `undefined` for that metric and the card renders an em dash;
 * nothing here invents a zero.
 */

import type { CardData } from "./card.js";

const MAX_PRS = 30;
const BOT_LOGIN = "keiko-for-quality[bot]";
/** GraphQL reports a GitHub App's author login WITHOUT the "[bot]" suffix REST uses — measured
 *  live against oscharko-dev/Keiko, where the suffixed comparison counted zero threads. */
const BOT_LOGIN_GRAPHQL = "keiko-for-quality";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Runs pages fetched per review workflow (100 runs each) — a bound, not a guess at infinity. */
const MAX_RUN_PAGES = 3;

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
  readonly path?: string;
  readonly created_at?: string;
  readonly conclusion?: string | null;
  readonly status?: string;
}

interface PullSummary {
  readonly number?: number;
  readonly updated_at?: string;
}

interface ReviewComment {
  readonly user?: { readonly login?: string };
  readonly body?: string;
}

interface ThreadNode {
  readonly isResolved?: boolean;
  readonly comments?: {
    readonly nodes?: readonly {
      readonly author?: { readonly login?: string };
      readonly body?: string;
    }[];
  };
}

interface ThreadsReply {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        readonly reviewThreads?: { readonly nodes?: readonly ThreadNode[] };
      };
    };
  };
}

function isReviewWorkflow(path: string | undefined): boolean {
  return (
    path !== undefined && (path.includes("keiko-for-quality") || path.endsWith("self-review.yml"))
  );
}

function isCoverageStub(body: string | undefined): boolean {
  return body?.includes("was not fully reviewed") === true;
}

interface RunStats {
  readonly runs30d?: number;
  readonly outcome?: CardData["outcome"];
  readonly lastRunHours?: number;
}

/**
 * The review workflows' numeric ids. Scoped-by-workflow run queries are what make the count
 * honest on a busy repository: the flat `/actions/runs` listing returns the newest 100 runs of
 * EVERY workflow, and a dense CI pushes month-old review runs straight out of that window —
 * measured live on oscharko-dev/Keiko, where the flat query undercounted 42 review runs as 10.
 */
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

async function tallyWorkflowRuns(
  base: string,
  workflowId: number,
  day: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<WorkflowTally> {
  let count = 0;
  let newest: WorkflowRun | undefined;
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const reply = await json<{ workflow_runs?: readonly WorkflowRun[] }>(
      fetchImpl,
      `${base}/actions/workflows/${String(workflowId)}/runs?per_page=100&page=${String(page)}&created=%3E${day}`,
      token,
    );
    const runs = reply?.workflow_runs ?? [];
    for (const run of runs) {
      // A skipped or cancelled run is not a review — superseded pushes cancel their runs under
      // the consumer's concurrency group, and counting those would inflate the card.
      if (run.status !== "completed") continue;
      if (run.conclusion === "skipped" || run.conclusion === "cancelled") continue;
      count += 1;
      newest ??= run;
    }
    if (runs.length < 100) break;
  }
  return { count, newest };
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

const THREADS_QUERY =
  "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n)" +
  "{reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login} body}}}}}}}";

interface ThreadTally {
  readonly resolved: number;
  readonly threads: number;
}

/** A thread counts when the reviewer opened it and it is a finding, not a coverage stub. */
function isBotFindingThread(node: ThreadNode): boolean {
  const first = node.comments?.nodes?.[0];
  return first?.author?.login === BOT_LOGIN_GRAPHQL && !isCoverageStub(first.body);
}

async function tallyThreads(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ThreadTally> {
  const reply = await json<ThreadsReply>(fetchImpl, "https://api.github.com/graphql", token, {
    method: "POST",
    body: JSON.stringify({ query: THREADS_QUERY, variables: { o: owner, r: repo, n: prNumber } }),
  });
  const nodes = reply?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const counted = nodes.filter(isBotFindingThread);
  return {
    resolved: counted.filter((node) => node.isResolved === true).length,
    threads: counted.length,
  };
}

interface FindingStats {
  readonly findings?: number;
  readonly actedOnPct?: number;
}

async function collectFindingStats(
  owner: string,
  repo: string,
  base: string,
  token: string,
  fetchImpl: typeof fetch,
  since: number,
): Promise<FindingStats> {
  const pulls = await json<readonly PullSummary[]>(
    fetchImpl,
    `${base}/pulls?state=all&sort=updated&direction=desc&per_page=${String(MAX_PRS)}`,
    token,
  );
  if (pulls === undefined) return {};
  let findings = 0;
  let resolved = 0;
  let threads = 0;
  for (const pr of pulls) {
    if (pr.number === undefined || pr.updated_at === undefined) continue;
    if (Date.parse(pr.updated_at) < since) continue;
    const comments = await json<readonly ReviewComment[]>(
      fetchImpl,
      `${base}/pulls/${String(pr.number)}/comments?per_page=100`,
      token,
    );
    if (comments === undefined) continue;
    findings += comments.filter(
      (c) => c.user?.login === BOT_LOGIN && !isCoverageStub(c.body),
    ).length;
    const tally = await tallyThreads(owner, repo, pr.number, token, fetchImpl);
    resolved += tally.resolved;
    threads += tally.threads;
  }
  return { findings, ...(threads > 0 ? { actedOnPct: (resolved / threads) * 100 } : {}) };
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
  const [runs, findings] = await Promise.all([
    collectRunStats(base, token, fetchImpl, nowMs, since),
    collectFindingStats(owner, repo, base, token, fetchImpl, since),
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
  if (findings.findings !== undefined) data.findings = findings.findings;
  if (findings.actedOnPct !== undefined) data.actedOnPct = findings.actedOnPct;
  return data;
}
