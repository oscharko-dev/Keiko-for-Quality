/**
 * Collects one repository's card numbers from the GitHub API — whole-window, tolerant, honest.
 *
 * Definitions, so the card means the same thing everywhere:
 * - `runs30d`: completed runs of the consumer's review workflow (any workflow file whose path
 *   contains `keiko-for-quality` or ends in `self-review.yml`) created in the exact trailing
 *   thirty days. Skipped and cancelled runs are not reviews — superseded pushes cancel their runs
 *   under the consumer's concurrency group — and do not count.
 * - `runStatus`/`lastRunHours`: retained as low-level workflow telemetry only. Neither value is
 *   rendered as review quality.
 * - `runSuccessPct`: the share of counted runs whose GitHub conclusion is `success`.
 * - `summaryRecords30d`/`completionPct`/`settlementStatus`: from the reviewer's maintained,
 *   marker-bound run-summary issue comment. One current record per pull request is counted when
 *   that summary's own event timestamp is in the window. `complete` is the actual product
 *   settlement, not a green workflow conclusion.
 * - `findings`: reviewer-bot review threads whose first comment was created inside that same exact
 *   window, fixed-template incomplete-review notices excluded. The coarse
 *   pull-request search window is only candidate discovery; every thread is filtered by its full
 *   timestamp locally.
 * - `resolvedPct`, `openThreads`, `prsWithFindings`: current resolution state of those findings,
 *   the corresponding unresolved count, and the distinct pull requests that contain them.
 *
 * Two hard lessons are structural here, both measured live against oscharko-dev/Keiko:
 * - **No silent caps.** A fixed page or PR bound quietly turns a busy month into a sample — the
 *   first shipped collector read 345 window reviews as 131 and graded acted-on over the 30 most
 *   recently updated of 421 window pull requests. Every loop below pages until it leaves the
 *   window; the safety ceilings exist only against runaway pagination, and HITTING one degrades
 *   the metric to absent rather than reporting the floor as the truth.
 * - **Request budget.** One shared 50-request budget begins before GitHub App authentication and
 *   is then shared by both concurrent collection branches. Findings and resolution stats come
 *   from paginated GraphQL search over the window (tens of pull requests per request), rather than
 *   two REST calls per pull request. A refused 51st request withholds every metric.
 *
 * Every failure degrades to `undefined` for that metric and the card renders an em dash; nothing
 * here invents a zero.
 */

import type { CardData } from "./card.js";
import type { GitHubRequestBudget } from "./request-budget.js";

/** GraphQL reports a GitHub App's author login WITHOUT the "[bot]" suffix REST uses — measured
 *  live against oscharko-dev/Keiko, where the suffixed comparison counted zero threads. */
const BOT_LOGIN_GRAPHQL = "keiko-for-quality";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Runaway-pagination ceilings, far above any real window — see the header before raising. */
const MAX_WORKFLOW_PAGES = 10;
const MAX_RUN_PAGES = 10;
const MAX_SEARCH_PAGES = 40;
const SEARCH_PAGE_SIZE = 25;
/** GitHub caps every filtered workflow-run search at 1,000 results. Seven-day partitions keep the
 *  live repositories comfortably below that boundary; a busier partition becomes unknown rather
 *  than a plausible-looking first thousand. */
const RUN_PARTITION_MS = 7 * DAY_MS;
const MAX_FILTERED_RESULTS = 1_000;

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
  readonly id?: number;
  readonly created_at?: string;
  readonly conclusion?: string | null;
  readonly status?: string;
}

const WORKFLOW_PATH_MAX_LENGTH = 1_024;
const RUN_STATUSES = new Set([
  "completed",
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);
const RUN_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

function validWorkflowPath(path: string | undefined): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.trim() === path &&
    path.length <= WORKFLOW_PATH_MAX_LENGTH &&
    !hasControlCharacter(path)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function isReviewWorkflow(path: string): boolean {
  return path.includes("keiko-for-quality") || path.endsWith("self-review.yml");
}

function isCoverageStub(body: string | undefined): boolean {
  return (
    body?.includes("**This change was not fully reviewed.**") === true &&
    body.includes("Keiko for Quality could not complete its review.")
  );
}

interface RunStats {
  readonly runs30d?: number;
  readonly runSuccessPct?: number;
  readonly runStatus?: CardData["runStatus"];
  readonly lastRunHours?: number;
}

function validBoundedTotal(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_FILTERED_RESULTS
  );
}

function validRunSearchTotal(value: number | undefined): value is number {
  // Exactly 1,000 is indistinguishable from GitHub's hard filtered-search ceiling. A smaller
  // partition is complete; a saturated one is deliberately unknown.
  return validBoundedTotal(value) && value < MAX_FILTERED_RESULTS;
}

interface WorkflowDescriptor {
  readonly id?: number;
  readonly path?: string;
}

interface WorkflowPage {
  readonly total_count?: number;
  readonly workflows?: readonly unknown[];
}

interface WorkflowDiscoveryState {
  readonly allIds: Set<number>;
  readonly reviewIds: Set<number>;
  expectedTotal?: number;
}

type PageDecision = "complete" | "continue" | "invalid";

interface CompleteWorkflowPage extends WorkflowPage {
  readonly total_count: number;
  readonly workflows: readonly unknown[];
}

function validWorkflowPage(reply: WorkflowPage | undefined): reply is CompleteWorkflowPage {
  if (!Array.isArray(reply?.workflows)) return false;
  return validBoundedTotal(reply.total_count);
}

function validWorkflowDescriptor(
  value: unknown,
  allIds: ReadonlySet<number>,
): value is WorkflowDescriptor & { readonly id: number; readonly path: string } {
  if (typeof value !== "object" || value === null) return false;
  const workflow = value as WorkflowDescriptor;
  return (
    Number.isSafeInteger(workflow.id) &&
    (workflow.id ?? 0) > 0 &&
    !allIds.has(workflow.id ?? 0) &&
    validWorkflowPath(workflow.path)
  );
}

function acceptWorkflowPage(
  reply: WorkflowPage | undefined,
  state: WorkflowDiscoveryState,
): PageDecision {
  if (!validWorkflowPage(reply)) return "invalid";
  state.expectedTotal ??= reply.total_count;
  if (reply.total_count !== state.expectedTotal) return "invalid";
  for (const workflow of reply.workflows) {
    if (!validWorkflowDescriptor(workflow, state.allIds)) return "invalid";
    state.allIds.add(workflow.id);
    if (isReviewWorkflow(workflow.path)) state.reviewIds.add(workflow.id);
  }
  return state.allIds.size === state.expectedTotal ? "complete" : "continue";
}

/** The review workflows' numeric ids — scoped-by-workflow run queries, because the flat
 *  `/actions/runs` listing returns the newest 100 runs of EVERY workflow and a dense CI pushes
 *  month-old review runs straight out of that window. */
async function reviewWorkflowIds(
  base: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<readonly number[] | undefined> {
  const state: WorkflowDiscoveryState = { allIds: new Set(), reviewIds: new Set() };
  for (let page = 1; page <= MAX_WORKFLOW_PAGES; page += 1) {
    const reply = await json<WorkflowPage>(
      fetchImpl,
      `${base}/actions/workflows?per_page=100&page=${String(page)}`,
      token,
    );
    const decision = acceptWorkflowPage(reply, state);
    if (decision === "invalid") return undefined;
    if (decision === "complete") return [...state.reviewIds];
  }
  return undefined;
}

interface WorkflowTally {
  readonly count: number;
  readonly successes: number;
  readonly newest: CountedRun | undefined;
}

interface CountedRun {
  readonly conclusion: string;
  readonly createdMs: number;
}

type WindowRun =
  | { readonly kind: "counted"; readonly run: CountedRun }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" };

function parsedTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (match === null) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const wholeSeconds = match[1];
  if (wholeSeconds === undefined) return undefined;
  const canonical = `${wholeSeconds}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  return new Date(parsed).toISOString() === canonical ? parsed : undefined;
}

function classifyCompletedRun(run: WorkflowRun, since: number, nowMs: number): WindowRun {
  const conclusion = run.conclusion;
  if (typeof conclusion !== "string" || !RUN_CONCLUSIONS.has(conclusion)) {
    return { kind: "invalid" };
  }
  if (conclusion === "skipped" || conclusion === "cancelled") return { kind: "ignored" };
  const createdMs = parsedTimestamp(run.created_at);
  if (createdMs === undefined) return { kind: "invalid" };
  if (createdMs < since || createdMs > nowMs) return { kind: "ignored" };
  return { kind: "counted", run: { conclusion, createdMs } };
}

function classifyWindowRun(run: WorkflowRun, since: number, nowMs: number): WindowRun {
  const status = run.status;
  if (typeof status !== "string" || !RUN_STATUSES.has(status)) return { kind: "invalid" };
  if (status !== "completed") {
    return run.conclusion === null ? { kind: "ignored" } : { kind: "invalid" };
  }
  return classifyCompletedRun(run, since, nowMs);
}

interface RunPartition {
  readonly startMs: number;
  readonly endMs: number;
}

function runPartitions(since: number, nowMs: number): readonly RunPartition[] {
  const partitions: RunPartition[] = [];
  let startMs = Math.floor(since / 1_000) * 1_000;
  const finalMs = Math.floor(nowMs / 1_000) * 1_000;
  while (startMs <= finalMs) {
    const endMs = Math.min(startMs + RUN_PARTITION_MS - 1_000, finalMs);
    partitions.push({ startMs, endMs });
    startMs = endMs + 1_000;
  }
  return partitions;
}

function mergeWorkflowTallies(a: WorkflowTally, b: WorkflowTally): WorkflowTally {
  return {
    count: a.count + b.count,
    successes: a.successes + b.successes,
    newest: newerRun(a.newest, b.newest),
  };
}

interface RunPage {
  readonly total_count?: number;
  readonly workflow_runs?: readonly unknown[];
}

interface RunPageState {
  readonly seenIds: Set<number>;
  expectedTotal?: number;
  tally: WorkflowTally;
}

interface CompleteRunPage extends RunPage {
  readonly total_count: number;
  readonly workflow_runs: readonly unknown[];
}

function validRunPage(reply: RunPage | undefined): reply is CompleteRunPage {
  if (!Array.isArray(reply?.workflow_runs)) return false;
  return validRunSearchTotal(reply.total_count);
}

function validUnseenRunId(id: number | undefined, seenIds: ReadonlySet<number>): id is number {
  return id !== undefined && Number.isSafeInteger(id) && id > 0 && !seenIds.has(id);
}

function timestampInsidePartition(createdMs: number | undefined, partition: RunPartition): boolean {
  return createdMs !== undefined && createdMs >= partition.startMs && createdMs <= partition.endMs;
}

function addWindowRun(tally: WorkflowTally, classified: WindowRun): WorkflowTally | undefined {
  if (classified.kind === "invalid") return undefined;
  if (classified.kind === "ignored") return tally;
  return mergeWorkflowTallies(tally, {
    count: 1,
    successes: classified.run.conclusion === "success" ? 1 : 0,
    newest: classified.run,
  });
}

function runPageDecision(runCount: number, state: RunPageState): PageDecision {
  if (state.seenIds.size === state.expectedTotal) return "complete";
  if (runCount < 100) return "invalid";
  return state.seenIds.size > (state.expectedTotal ?? 0) ? "invalid" : "continue";
}

function acceptRunPage(
  reply: RunPage | undefined,
  state: RunPageState,
  partition: RunPartition,
  since: number,
  nowMs: number,
): PageDecision {
  if (!validRunPage(reply)) return "invalid";
  state.expectedTotal ??= reply.total_count;
  if (reply.total_count !== state.expectedTotal) return "invalid";
  for (const value of reply.workflow_runs) {
    if (typeof value !== "object" || value === null) return "invalid";
    const run = value as WorkflowRun;
    if (!validUnseenRunId(run.id, state.seenIds)) return "invalid";
    if (!timestampInsidePartition(parsedTimestamp(run.created_at), partition)) return "invalid";
    state.seenIds.add(run.id);
    const tally = addWindowRun(state.tally, classifyWindowRun(run, since, nowMs));
    if (tally === undefined) return "invalid";
    state.tally = tally;
  }
  return runPageDecision(reply.workflow_runs.length, state);
}

/** Every page of one date-bounded workflow-run search. GitHub caps a filtered search at 1,000
 *  results, so both `total_count` and the exact unique-id population are validated before any
 *  tally is admitted. */
async function tallyRunPartition(
  base: string,
  workflowId: number,
  partition: RunPartition,
  token: string,
  fetchImpl: typeof fetch,
  since: number,
  nowMs: number,
): Promise<WorkflowTally | undefined> {
  const state: RunPageState = {
    seenIds: new Set(),
    tally: { count: 0, successes: 0, newest: undefined },
  };
  const created = encodeURIComponent(
    `${new Date(partition.startMs).toISOString()}..${new Date(partition.endMs).toISOString()}`,
  );
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const reply = await json<RunPage>(
      fetchImpl,
      `${base}/actions/workflows/${String(workflowId)}/runs?per_page=100&page=${String(page)}&created=${created}`,
      token,
    );
    const decision = acceptRunPage(reply, state, partition, since, nowMs);
    if (decision === "invalid") return undefined;
    if (decision === "complete") return state.tally;
  }
  return undefined;
}

async function tallyWorkflowRuns(
  base: string,
  workflowId: number,
  token: string,
  fetchImpl: typeof fetch,
  since: number,
  nowMs: number,
): Promise<WorkflowTally | undefined> {
  let tally: WorkflowTally = { count: 0, successes: 0, newest: undefined };
  for (const partition of runPartitions(since, nowMs)) {
    const part = await tallyRunPartition(
      base,
      workflowId,
      partition,
      token,
      fetchImpl,
      since,
      nowMs,
    );
    if (part === undefined) return undefined;
    tally = mergeWorkflowTallies(tally, part);
  }
  return tally;
}

function newerRun(a: CountedRun | undefined, b: CountedRun | undefined): CountedRun | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.createdMs >= b.createdMs ? a : b;
}

async function collectRunStats(
  base: string,
  token: string,
  fetchImpl: typeof fetch,
  nowMs: number,
  since: number,
): Promise<RunStats> {
  const ids = await reviewWorkflowIds(base, token, fetchImpl);
  if (ids === undefined) return {};
  let runs30d = 0;
  let successes = 0;
  let newest: CountedRun | undefined;
  for (const id of ids) {
    const tally = await tallyWorkflowRuns(base, id, token, fetchImpl, since, nowMs);
    if (tally === undefined) return {};
    runs30d += tally.count;
    successes += tally.successes;
    newest = newerRun(newest, tally.newest);
  }
  if (newest === undefined) return { runs30d };
  return {
    runs30d,
    runSuccessPct: (successes / runs30d) * 100,
    lastRunHours: (nowMs - newest.createdMs) / HOUR_MS,
    runStatus: newest.conclusion === "success" ? "ok" : "not_ok",
  };
}

/** One search page: every window pull request's review threads, tens of pull requests per
 *  request — the shape that keeps the Worker inside its subrequest budget. The thread
 *  connection carries its own page info because a review-heavy pull request overflows one page:
 *  measured live, five window pull requests held 110–249 threads against the 100-per-page cap. */
const SEARCH_QUERY =
  `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:${String(SEARCH_PAGE_SIZE)},after:$after){` +
  "issueCount pageInfo{hasNextPage endCursor}nodes{... on PullRequest{number " +
  "reviewThreads(first:100){totalCount pageInfo{hasNextPage endCursor}" +
  "nodes{id isResolved comments(first:1){nodes{author{login} body createdAt}}}}" +
  "comments(first:100){totalCount pageInfo{hasNextPage endCursor}" +
  "nodes{id databaseId author{login} body createdAt updatedAt}}}}}}";

/** Follow-up pages of one pull request's threads, for the overflow case above. */
const THREADS_QUERY =
  "query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){" +
  "pullRequest(number:$n){reviewThreads(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor}" +
  "nodes{id isResolved comments(first:1){nodes{author{login} body createdAt}}}}}}}";

/** Follow-up pages of one pull request's issue comments, used only when it has over 100. */
const COMMENTS_QUERY =
  "query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){" +
  "pullRequest(number:$n){comments(first:100,after:$after){totalCount " +
  "pageInfo{hasNextPage endCursor}nodes{id databaseId author{login} body createdAt updatedAt}}}}}";

/** Thread pages per pull request past the first — 10 covers a 1,100-thread pull request. */
const MAX_THREAD_PAGES = 10;

interface ThreadComment {
  readonly author?: { readonly login?: string };
  readonly body?: string;
  readonly createdAt?: string;
}

interface ThreadNode {
  readonly id?: string;
  readonly isResolved?: boolean;
  readonly comments?: {
    readonly nodes?: readonly unknown[];
  };
}

interface PageInfo {
  readonly hasNextPage?: boolean;
  readonly endCursor?: string | null;
}

interface CompletePageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

interface ThreadConnection {
  readonly totalCount?: number;
  readonly pageInfo?: PageInfo;
  readonly nodes?: readonly unknown[];
}

interface IssueCommentNode {
  readonly id?: string;
  readonly databaseId?: number;
  readonly author?: { readonly login?: string } | null;
  readonly body?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

interface IssueCommentConnection {
  readonly totalCount?: number;
  readonly pageInfo?: PageInfo;
  readonly nodes?: readonly unknown[];
}

type PaginatedConnection = ThreadConnection | IssueCommentConnection;

type CompleteConnection<T extends PaginatedConnection> = T & {
  readonly totalCount: number;
  readonly pageInfo: CompletePageInfo;
  readonly nodes: readonly unknown[];
};

interface SearchPullRequest {
  readonly number?: number;
  readonly reviewThreads?: ThreadConnection;
  readonly comments?: IssueCommentConnection;
}

interface BoundSearchPullRequest extends SearchPullRequest {
  readonly number: number;
}

interface SearchResults {
  readonly issueCount?: number;
  readonly pageInfo?: PageInfo;
  readonly nodes?: readonly unknown[];
}

type CompleteSearchResults = SearchResults & {
  readonly issueCount: number;
  readonly pageInfo: CompletePageInfo;
  readonly nodes: readonly unknown[];
};

function validPageInfo(pageInfo: PageInfo | undefined): pageInfo is CompletePageInfo {
  if (typeof pageInfo?.hasNextPage !== "boolean") return false;
  if (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string") return false;
  if (!pageInfo.hasNextPage) return true;
  return pageInfo.endCursor !== null && pageInfo.endCursor.length > 0;
}

function validConnection<T extends PaginatedConnection>(
  connection: T | undefined,
): connection is CompleteConnection<T> {
  return (
    Array.isArray(connection?.nodes) &&
    Number.isSafeInteger(connection.totalCount) &&
    (connection.totalCount ?? -1) >= 0 &&
    validPageInfo(connection.pageInfo)
  );
}

function validSearchResults(search: SearchResults | undefined): search is CompleteSearchResults {
  return (
    Array.isArray(search?.nodes) &&
    search.issueCount !== undefined &&
    Number.isSafeInteger(search.issueCount) &&
    search.issueCount >= 0 &&
    search.issueCount <= MAX_SEARCH_PAGES * SEARCH_PAGE_SIZE &&
    validPageInfo(search.pageInfo)
  );
}

interface SearchPopulationState {
  readonly seenPullRequests: Set<number>;
  expectedTotal?: number;
}

function acceptSearchPopulation(
  search: CompleteSearchResults,
  state: SearchPopulationState,
): readonly BoundSearchPullRequest[] | undefined {
  state.expectedTotal ??= search.issueCount;
  if (search.issueCount !== state.expectedTotal) return undefined;
  const bound: BoundSearchPullRequest[] = [];
  for (const value of search.nodes) {
    if (typeof value !== "object" || value === null) return undefined;
    const pr = value as SearchPullRequest;
    const number = pr.number;
    if (
      number === undefined ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      state.seenPullRequests.has(number)
    ) {
      return undefined;
    }
    state.seenPullRequests.add(number);
    bound.push({ ...pr, number });
  }
  return bound;
}

type SearchContinuation =
  | { readonly kind: "complete" }
  | { readonly kind: "next"; readonly cursor: string }
  | { readonly kind: "invalid" };

function searchContinuation(
  search: SearchResults & { readonly pageInfo: CompletePageInfo },
  state: SearchPopulationState,
): SearchContinuation {
  if (!search.pageInfo.hasNextPage) {
    return state.seenPullRequests.size === state.expectedTotal
      ? { kind: "complete" }
      : { kind: "invalid" };
  }
  if (state.seenPullRequests.size >= (state.expectedTotal ?? 0)) return { kind: "invalid" };
  return { kind: "next", cursor: search.pageInfo.endCursor ?? "" };
}

interface SearchPage {
  readonly data?: { readonly search?: SearchResults };
  readonly errors?: readonly unknown[];
}

interface ThreadsPage {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: { readonly reviewThreads?: ThreadConnection };
    };
  };
  readonly errors?: readonly unknown[];
}

type ThreadClassification =
  | { readonly kind: "finding"; readonly resolved: boolean }
  | { readonly kind: "other" }
  | { readonly kind: "invalid" };

/** A thread counts only when the reviewer opened it inside the exact window and it is a finding,
 *  not a coverage stub. Missing fields make the whole metric unknown instead of silently lowering
 *  its numerator or denominator. */
function classifyThread(node: ThreadNode, since: number, nowMs: number): ThreadClassification {
  const comments = node.comments;
  if (!hasExactlyOneComment(comments)) return { kind: "invalid" };
  const first = comments.nodes[0];
  if (typeof first.author?.login !== "string" || first.author.login.length === 0) {
    return { kind: "invalid" };
  }
  if (first.author.login !== BOT_LOGIN_GRAPHQL) return { kind: "other" };
  return classifyBotThread(node, first.body, first.createdAt, since, nowMs);
}

function hasExactlyOneComment(
  value: unknown,
): value is { readonly nodes: readonly [ThreadComment] } {
  if (typeof value !== "object" || value === null) return false;
  const comments = value as { readonly nodes?: readonly unknown[] };
  if (!Array.isArray(comments.nodes) || comments.nodes.length !== 1) {
    return false;
  }
  return typeof comments.nodes[0] === "object" && comments.nodes[0] !== null;
}

function classifyBotThread(
  node: ThreadNode,
  body: string | undefined,
  createdAt: string | undefined,
  since: number,
  nowMs: number,
): ThreadClassification {
  if (typeof body !== "string") return { kind: "invalid" };
  if (typeof createdAt !== "string") return { kind: "invalid" };
  if (isCoverageStub(body)) return { kind: "other" };
  const createdMs = parsedTimestamp(createdAt);
  if (createdMs === undefined) return { kind: "invalid" };
  if (createdMs < since || createdMs > nowMs) return { kind: "other" };
  if (typeof node.isResolved !== "boolean") return { kind: "invalid" };
  return { kind: "finding", resolved: node.isResolved };
}

interface FindingStats {
  readonly findings?: number;
  readonly resolvedPct?: number;
  readonly openThreads?: number;
  readonly prsWithFindings?: number;
}

interface SettlementStats {
  readonly summaryRecords30d?: number;
  readonly completionPct?: number;
  readonly settlementStatus?: CardData["settlementStatus"];
  readonly lastReviewHours?: number;
}

interface ReviewStats {
  readonly findings: FindingStats;
  readonly settlements: SettlementStats;
}

function finishedStats(tally: ThreadTally, prsWithFindings: ReadonlySet<number>): FindingStats {
  const { findings, resolved } = tally;
  return {
    findings,
    openThreads: findings - resolved,
    prsWithFindings: prsWithFindings.size,
    ...(findings > 0 ? { resolvedPct: (resolved / findings) * 100 } : {}),
  };
}

interface ThreadTally {
  findings: number;
  resolved: number;
}

interface ThreadPopulationState {
  readonly seenIds: Set<string>;
  expectedTotal?: number;
  readonly tally: ThreadTally;
}

function threadPageDecision(
  connection: CompleteConnection<ThreadConnection>,
  state: ThreadPopulationState,
): PageDecision {
  if (state.seenIds.size > (state.expectedTotal ?? -1)) return "invalid";
  if (!connection.pageInfo.hasNextPage) {
    return state.seenIds.size === state.expectedTotal ? "complete" : "invalid";
  }
  return state.seenIds.size < (state.expectedTotal ?? 0) ? "continue" : "invalid";
}

function acceptThreadPage(
  connection: ThreadConnection | undefined,
  since: number,
  nowMs: number,
  state: ThreadPopulationState,
): PageDecision {
  if (!validConnection(connection)) return "invalid";
  state.expectedTotal ??= connection.totalCount;
  if (connection.totalCount !== state.expectedTotal) return "invalid";
  for (const node of connection.nodes) {
    if (!acceptThreadNode(node, since, nowMs, state)) return "invalid";
  }
  return threadPageDecision(connection, state);
}

function acceptThreadNode(
  value: unknown,
  since: number,
  nowMs: number,
  state: ThreadPopulationState,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const node = value as ThreadNode;
  const id = node.id;
  if (typeof id !== "string" || id.length === 0 || state.seenIds.has(id)) return false;
  state.seenIds.add(id);
  const classification = classifyThread(node, since, nowMs);
  if (classification.kind === "invalid") return false;
  if (classification.kind !== "finding") return true;
  state.tally.findings += 1;
  if (classification.resolved) state.tally.resolved += 1;
  return true;
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
  if (reply?.errors !== undefined) return undefined;
  return reply?.data?.repository?.pullRequest?.reviewThreads;
}

interface FindingCollectionContext {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly fetchImpl: typeof fetch;
  readonly since: number;
  readonly nowMs: number;
}

interface CommentsPage {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: { readonly comments?: IssueCommentConnection };
    };
  };
  readonly errors?: readonly unknown[];
}

type SettlementOutcome = Exclude<CardData["settlementStatus"], undefined>;

interface SettlementRecord {
  readonly databaseId: number;
  readonly eventMs: number;
  readonly outcome: SettlementOutcome;
}

interface CommentPopulationState {
  readonly seenIds: Set<string>;
  readonly summaries: SettlementRecord[];
  expectedTotal?: number;
}

interface SettlementTally {
  records: number;
  complete: number;
  latest?: SettlementRecord;
}

const SUMMARY_TITLE = "**Keiko for Quality — run summary**";
const SUMMARY_MARKER = /<!-- keiko-for-quality:v1:[0-9a-f]{32} -->/u;
const SUMMARY_IMAGE_PREFIX =
  '<img src="https://raw.githubusercontent.com/oscharko-dev/Keiko-for-Quality/';
const SUMMARY_IMAGE_MIDDLE = "/.github/assets/kq/out-";
const SUMMARY_IMAGE_SUFFIX = '.svg" height="20" alt="';
const SUMMARY_TAIL_PREFIX = " · head `";
const LEGACY_ICON_TITLE_SUFFIX = '/.github/assets/kq/reviewer.svg" width="18" height="18" alt=""> ';
const LEGACY_ICON_OUTCOME_SUFFIX = '.svg" width="12" height="12" alt=""> ';
/** v0.6.0-v0.20.x summaries used text glyphs and v0.21.0 briefly used an icon plus adjacent text
 *  before the pinned design-system chips. They remain valid historical product records; refusing
 *  either released grammar would silently select only newer reviews and inflate the apparent
 *  completion rate. */

type SummaryClassification =
  | { readonly kind: "summary"; readonly record: SettlementRecord }
  | { readonly kind: "other" }
  | { readonly kind: "invalid" };

interface ParsedSummaryHeadline {
  readonly outcome: SettlementOutcome;
  readonly eventMs: number;
}

function hasOnlyCharacters(value: string, allowed: (code: number) => boolean): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || !allowed(code)) return false;
  }
  return true;
}

function isLowerHex(value: string, length: number): boolean {
  return (
    value.length === length &&
    hasOnlyCharacters(value, (code) => (code >= 48 && code <= 57) || (code >= 97 && code <= 102))
  );
}

function isReason(value: string): boolean {
  return hasOnlyCharacters(
    value,
    (code) =>
      (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 46 || code === 95,
  );
}

function isVersion(value: string): boolean {
  const components = value.split(".");
  return (
    components.length === 3 &&
    components.every((component) =>
      hasOnlyCharacters(component, (code) => code >= 48 && code <= 57),
    )
  );
}

function isSummaryHead(value: string | undefined): boolean {
  return (
    value !== undefined &&
    value.startsWith("head `") &&
    value.endsWith("`") &&
    isLowerHex(value.slice(6, -1), 7)
  );
}

function isSummaryEngine(value: string | undefined): boolean {
  return (
    value !== undefined &&
    value.startsWith("engine `v") &&
    value.endsWith("`") &&
    isVersion(value.slice(9, -1))
  );
}

function isSummaryAction(value: string | undefined): boolean {
  return (
    value === undefined ||
    (value.startsWith("action `") &&
      value.endsWith("`") &&
      value.length > "action ``".length &&
      !value.slice(8, -1).includes("`"))
  );
}

function parsedSummaryTail(tail: string): number | undefined {
  const headEnd = tail.indexOf(" · ");
  if (headEnd === -1) return undefined;
  const timestampEnd = tail.indexOf(" · ", headEnd + 3);
  if (timestampEnd === -1) return undefined;
  const engineEnd = tail.indexOf(" · ", timestampEnd + 3);
  const head = tail.slice(0, headEnd);
  const timestamp = tail.slice(headEnd + 3, timestampEnd);
  const engine = tail.slice(timestampEnd + 3, engineEnd === -1 ? tail.length : engineEnd);
  const action = engineEnd === -1 ? undefined : tail.slice(engineEnd + 3);
  if (!isSummaryHead(head) || !isSummaryEngine(engine)) return undefined;
  if (!isSummaryAction(action)) return undefined;
  return parsedTimestamp(timestamp);
}

function parsedReasonAndTail(remainder: string, outcome: SettlementOutcome): number | undefined {
  let reason: string | undefined;
  let tail = remainder;
  if (remainder.startsWith(" (`")) {
    const closing = remainder.indexOf("`)");
    if (closing === -1) return undefined;
    reason = remainder.slice(3, closing);
    tail = remainder.slice(closing + 2);
  }
  if (
    (outcome === "incomplete") !== (reason !== undefined) ||
    (reason !== undefined && !isReason(reason))
  ) {
    return undefined;
  }
  if (!tail.startsWith(SUMMARY_TAIL_PREFIX)) return undefined;
  return parsedSummaryTail(tail.slice(3));
}

function parsedCurrentHeadline(headline: string): ParsedSummaryHeadline | undefined {
  if (!headline.startsWith(SUMMARY_IMAGE_PREFIX)) return undefined;
  const afterSha = headline.slice(SUMMARY_IMAGE_PREFIX.length);
  const middle = afterSha.indexOf(SUMMARY_IMAGE_MIDDLE);
  if (middle === -1 || !isLowerHex(afterSha.slice(0, middle), 40)) return undefined;
  const afterImage = afterSha.slice(middle + SUMMARY_IMAGE_MIDDLE.length);
  for (const outcome of ["complete", "incomplete", "abandoned"] as const) {
    const image = `${outcome}${SUMMARY_IMAGE_SUFFIX}${outcome.toUpperCase()}">`;
    if (!afterImage.startsWith(image)) continue;
    const eventMs = parsedReasonAndTail(afterImage.slice(image.length), outcome);
    if (eventMs !== undefined) return { outcome, eventMs };
  }
  return undefined;
}

function parsedIconTextHeadline(headline: string): ParsedSummaryHeadline | undefined {
  if (!headline.startsWith(SUMMARY_IMAGE_PREFIX)) return undefined;
  const afterSha = headline.slice(SUMMARY_IMAGE_PREFIX.length);
  const middle = afterSha.indexOf(SUMMARY_IMAGE_MIDDLE);
  if (middle === -1 || !isLowerHex(afterSha.slice(0, middle), 40)) return undefined;
  const afterImage = afterSha.slice(middle + SUMMARY_IMAGE_MIDDLE.length);
  for (const outcome of ["complete", "incomplete", "abandoned"] as const) {
    const imageAndText = `${outcome}${LEGACY_ICON_OUTCOME_SUFFIX}${outcome}`;
    if (!afterImage.startsWith(imageAndText)) continue;
    const eventMs = parsedReasonAndTail(afterImage.slice(imageAndText.length), outcome);
    if (eventMs !== undefined) return { outcome, eventMs };
  }
  return undefined;
}

function legacyOutcomeAndRemainder(
  headline: string,
): { readonly outcome: SettlementOutcome; readonly remainder: string } | undefined {
  const complete = "✅ complete";
  if (headline.startsWith(complete))
    return { outcome: "complete", remainder: headline.slice(complete.length) };
  const abandoned = "⏳ abandoned";
  if (headline.startsWith(abandoned))
    return { outcome: "abandoned", remainder: headline.slice(abandoned.length) };
  const incomplete = "⚠️ incomplete";
  if (headline.startsWith(incomplete))
    return { outcome: "incomplete", remainder: headline.slice(incomplete.length) };
  return undefined;
}

function parsedLegacyHeadline(headline: string): ParsedSummaryHeadline | undefined {
  const parsed = legacyOutcomeAndRemainder(headline);
  if (parsed === undefined) return undefined;
  const eventMs = parsedReasonAndTail(parsed.remainder, parsed.outcome);
  return eventMs === undefined ? undefined : { outcome: parsed.outcome, eventMs };
}

function isBotSummary(comment: IssueCommentNode): SummaryClassification | undefined {
  if (comment.author?.login === BOT_LOGIN_GRAPHQL) return undefined;
  return comment.author?.login === undefined ? { kind: "invalid" } : { kind: "other" };
}

function summaryMetadata(comment: IssueCommentNode, body: string): number | undefined {
  const { databaseId, createdAt, updatedAt } = comment;
  if (
    typeof databaseId !== "number" ||
    !Number.isSafeInteger(databaseId) ||
    databaseId <= 0 ||
    typeof createdAt !== "string" ||
    parsedTimestamp(createdAt) === undefined ||
    typeof updatedAt !== "string" ||
    parsedTimestamp(updatedAt) === undefined ||
    !SUMMARY_MARKER.test(body)
  ) {
    return undefined;
  }
  return databaseId;
}

function summaryHeadline(body: string): string | undefined {
  return body.split("\n")[2];
}

function hasSummaryTitle(body: string): boolean {
  if (body.startsWith(`${SUMMARY_TITLE}\n\n`)) return true;
  if (!body.startsWith(SUMMARY_IMAGE_PREFIX)) return false;
  const titleEnd = body.indexOf("\n\n");
  if (titleEnd === -1) return false;
  const afterSha = body.slice(SUMMARY_IMAGE_PREFIX.length, titleEnd);
  return (
    isLowerHex(afterSha.slice(0, 40), 40) &&
    afterSha.slice(40) === `${LEGACY_ICON_TITLE_SUFFIX}${SUMMARY_TITLE}`
  );
}

export function parseSummaryRecord(comment: IssueCommentNode): SummaryClassification {
  const body = comment.body;
  if (typeof body !== "string" || !hasSummaryTitle(body)) return { kind: "other" };
  const identity = isBotSummary(comment);
  if (identity !== undefined) return identity;
  const databaseId = summaryMetadata(comment, body);
  const headline = summaryHeadline(body);
  if (databaseId === undefined || headline === undefined) return { kind: "invalid" };
  const parsed =
    parsedCurrentHeadline(headline) ??
    parsedIconTextHeadline(headline) ??
    parsedLegacyHeadline(headline);
  if (parsed === undefined) return { kind: "invalid" };
  return {
    kind: "summary",
    record: {
      databaseId,
      eventMs: parsed.eventMs,
      outcome: parsed.outcome,
    },
  };
}

function acceptCommentNode(value: unknown, state: CommentPopulationState): boolean {
  if (typeof value !== "object" || value === null) return false;
  const comment = value as IssueCommentNode;
  if (typeof comment.id !== "string" || comment.id.length === 0 || state.seenIds.has(comment.id)) {
    return false;
  }
  state.seenIds.add(comment.id);
  const classification = parseSummaryRecord(comment);
  if (classification.kind === "invalid") return false;
  if (classification.kind === "summary") state.summaries.push(classification.record);
  return true;
}

function acceptCommentPage(
  connection: IssueCommentConnection | undefined,
  state: CommentPopulationState,
): PageDecision {
  if (!validConnection(connection)) return "invalid";
  state.expectedTotal ??= connection.totalCount;
  if (connection.totalCount !== state.expectedTotal) return "invalid";
  for (const node of connection.nodes) {
    if (!acceptCommentNode(node, state)) return "invalid";
  }
  if (state.seenIds.size > state.expectedTotal) return "invalid";
  if (!connection.pageInfo.hasNextPage) {
    return state.seenIds.size === state.expectedTotal ? "complete" : "invalid";
  }
  return state.seenIds.size < state.expectedTotal ? "continue" : "invalid";
}

async function fetchCommentPage(
  context: FindingCollectionContext,
  prNumber: number,
  after: string | null,
): Promise<IssueCommentConnection | undefined> {
  const reply = await json<CommentsPage>(
    context.fetchImpl,
    "https://api.github.com/graphql",
    context.token,
    {
      method: "POST",
      body: JSON.stringify({
        query: COMMENTS_QUERY,
        variables: { o: context.owner, r: context.repo, n: prNumber, after },
      }),
    },
  );
  if (reply?.errors !== undefined) return undefined;
  return reply?.data?.repository?.pullRequest?.comments;
}

function newestSettlement(records: readonly SettlementRecord[]): SettlementRecord | undefined {
  return records.reduce<SettlementRecord | undefined>(
    (latest, record) =>
      latest === undefined || record.databaseId > latest.databaseId ? record : latest,
    undefined,
  );
}

async function pullRequestSettlement(
  pr: BoundSearchPullRequest,
  context: FindingCollectionContext,
): Promise<SettlementRecord | undefined | false> {
  const state: CommentPopulationState = { seenIds: new Set(), summaries: [] };
  if (!(await collectSettlementPages(pr, context, state))) return false;
  const latest = newestSettlement(state.summaries);
  if (latest !== undefined && latest.eventMs > context.nowMs) return false;
  if (latest === undefined || latest.eventMs < context.since) return undefined;
  return latest;
}

async function collectSettlementPages(
  pr: BoundSearchPullRequest,
  context: FindingCollectionContext,
  state: CommentPopulationState,
): Promise<boolean> {
  let connection = pr.comments;
  let decision = acceptCommentPage(connection, state);
  for (let page = 1; decision === "continue" && page <= MAX_THREAD_PAGES; page += 1) {
    connection = await fetchCommentPage(
      context,
      pr.number,
      connection?.pageInfo?.endCursor ?? null,
    );
    decision = acceptCommentPage(connection, state);
  }
  return decision === "complete";
}

function newerSettlement(
  current: SettlementRecord | undefined,
  candidate: SettlementRecord,
): SettlementRecord {
  if (current === undefined || candidate.eventMs > current.eventMs) return candidate;
  if (candidate.eventMs === current.eventMs && candidate.databaseId > current.databaseId) {
    return candidate;
  }
  return current;
}

async function tallySearchSettlements(
  pullRequests: readonly BoundSearchPullRequest[],
  context: FindingCollectionContext,
  tally: SettlementTally,
): Promise<boolean> {
  for (const pr of pullRequests) {
    const record = await pullRequestSettlement(pr, context);
    if (record === false) return false;
    if (record === undefined) continue;
    tally.records += 1;
    if (record.outcome === "complete") tally.complete += 1;
    tally.latest = newerSettlement(tally.latest, record);
  }
  return true;
}

function finishedSettlementStats(tally: SettlementTally, nowMs: number): SettlementStats {
  if (tally.records === 0) return { summaryRecords30d: 0 };
  const latest = tally.latest;
  if (latest === undefined) return {};
  return {
    summaryRecords30d: tally.records,
    completionPct: (tally.complete / tally.records) * 100,
    settlementStatus: latest.outcome,
    lastReviewHours: (nowMs - latest.eventMs) / HOUR_MS,
  };
}

interface OverflowThreadsRequest extends FindingCollectionContext {
  readonly prNumber: number;
  readonly cursor: string | null;
}

/** The overflow pages of one pull request's threads; false when the API failed or the ceiling
 *  was hit — the caller must then drop the metric rather than publish a floor. */
async function tallyOverflowThreads(
  request: OverflowThreadsRequest,
  state: ThreadPopulationState,
): Promise<boolean> {
  let after = request.cursor;
  for (let page = 1; page <= MAX_THREAD_PAGES; page += 1) {
    const conn = await fetchThreadPage(
      request.owner,
      request.repo,
      request.prNumber,
      after,
      request.token,
      request.fetchImpl,
    );
    const decision = acceptThreadPage(conn, request.since, request.nowMs, state);
    if (decision === "invalid") return false;
    if (decision === "complete") return true;
    after = conn?.pageInfo?.endCursor ?? null;
  }
  return false;
}

/** One pull request's threads, first page plus any overflow; false means "drop the metric". */
async function tallyPullRequest(
  pr: BoundSearchPullRequest,
  context: FindingCollectionContext,
): Promise<ThreadTally | undefined> {
  const tally: ThreadTally = { findings: 0, resolved: 0 };
  const state: ThreadPopulationState = { seenIds: new Set(), tally };
  const conn = pr.reviewThreads;
  const decision = acceptThreadPage(conn, context.since, context.nowMs, state);
  if (decision === "invalid") return undefined;
  if (decision === "complete") return tally;
  const cursor = conn?.pageInfo?.endCursor ?? null;
  const complete = await tallyOverflowThreads({ ...context, prNumber: pr.number, cursor }, state);
  return complete ? tally : undefined;
}

async function tallySearchPullRequests(
  pullRequests: readonly BoundSearchPullRequest[],
  context: FindingCollectionContext,
  tally: ThreadTally,
  prsWithFindings: Set<number>,
): Promise<boolean> {
  for (const pr of pullRequests) {
    const prTally = await tallyPullRequest(pr, context);
    if (prTally === undefined) return false;
    tally.findings += prTally.findings;
    tally.resolved += prTally.resolved;
    if (prTally.findings > 0) prsWithFindings.add(pr.number);
  }
  return true;
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
  if (reply?.errors !== undefined) return undefined;
  return reply?.data?.search;
}

interface ReviewMetricAvailability {
  findingsKnown: boolean;
  settlementsKnown: boolean;
}

function unavailableReviewStats(): ReviewStats {
  return { findings: {}, settlements: {} };
}

function completedReviewStats(
  availability: ReviewMetricAvailability,
  tally: ThreadTally,
  prsWithFindings: ReadonlySet<number>,
  settlementTally: SettlementTally,
  nowMs: number,
): ReviewStats {
  return {
    findings: availability.findingsKnown ? finishedStats(tally, prsWithFindings) : {},
    settlements: availability.settlementsKnown
      ? finishedSettlementStats(settlementTally, nowMs)
      : {},
  };
}

async function collectSearchPageStats(
  search: CompleteSearchResults,
  population: SearchPopulationState,
  context: FindingCollectionContext,
  availability: ReviewMetricAvailability,
  tally: ThreadTally,
  prsWithFindings: Set<number>,
  settlementTally: SettlementTally,
): Promise<boolean> {
  const pullRequests = acceptSearchPopulation(search, population);
  if (pullRequests === undefined) return false;
  if (availability.findingsKnown) {
    availability.findingsKnown = await tallySearchPullRequests(
      pullRequests,
      context,
      tally,
      prsWithFindings,
    );
  }
  if (availability.settlementsKnown) {
    availability.settlementsKnown = await tallySearchSettlements(
      pullRequests,
      context,
      settlementTally,
    );
  }
  return true;
}

async function collectReviewStats(
  owner: string,
  repo: string,
  token: string,
  fetchImpl: typeof fetch,
  since: number,
  nowMs: number,
): Promise<ReviewStats> {
  const context: FindingCollectionContext = { owner, repo, token, fetchImpl, since, nowMs };
  const day = new Date(since).toISOString().slice(0, 10);
  // The inclusive coarse boundary prevents a thread created exactly at 00:00Z from disappearing;
  // classifyThread still applies the exact millisecond window locally.
  const q = `repo:${owner}/${repo} is:pr updated:>=${day}`;
  const tally: ThreadTally = { findings: 0, resolved: 0 };
  const settlementTally: SettlementTally = { records: 0, complete: 0 };
  const prsWithFindings = new Set<number>();
  const population: SearchPopulationState = { seenPullRequests: new Set() };
  const availability: ReviewMetricAvailability = { findingsKnown: true, settlementsKnown: true };
  let after: string | null = null;
  for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
    const search = await fetchSearchPage(q, after, token, fetchImpl);
    if (!validSearchResults(search)) return unavailableReviewStats();
    if (
      !(await collectSearchPageStats(
        search,
        population,
        context,
        availability,
        tally,
        prsWithFindings,
        settlementTally,
      ))
    )
      return unavailableReviewStats();
    const continuation = searchContinuation(search, population);
    if (continuation.kind === "complete") {
      return completedReviewStats(availability, tally, prsWithFindings, settlementTally, nowMs);
    }
    if (continuation.kind === "invalid") return unavailableReviewStats();
    after = continuation.cursor;
  }
  // The window outran the safety ceiling: absent beats publishing a floor as the truth.
  return unavailableReviewStats();
}

export async function collectCardData(
  owner: string,
  repo: string,
  token: string,
  requests: GitHubRequestBudget,
  nowMs: number,
): Promise<CardData> {
  const since = nowMs - 30 * DAY_MS;
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const [runs, reviewStats] = await Promise.all([
    collectRunStats(base, token, requests.fetch, nowMs, since),
    collectReviewStats(owner, repo, token, requests.fetch, since, nowMs),
  ]);
  if (requests.exhausted) return { owner, repo };
  return cardData(owner, repo, nowMs, runs, reviewStats);
}

type CardMetrics = Omit<CardData, "owner" | "repo">;

function presentMetric<Key extends keyof CardMetrics>(
  key: Key,
  value: CardMetrics[Key],
): Pick<CardMetrics, Key> | Record<never, never> {
  return value === undefined ? {} : ({ [key]: value } as Pick<CardMetrics, Key>);
}

function cardData(
  owner: string,
  repo: string,
  nowMs: number,
  runs: RunStats,
  reviewStats: ReviewStats,
): CardData {
  const { findings, settlements } = reviewStats;
  return {
    owner,
    repo,
    dataAsOf: new Date(nowMs).toISOString(),
    ...presentMetric("runs30d", runs.runs30d),
    ...presentMetric("runSuccessPct", runs.runSuccessPct),
    ...presentMetric("runStatus", runs.runStatus),
    ...presentMetric("lastRunHours", runs.lastRunHours),
    ...presentMetric("findings", findings.findings),
    ...presentMetric("resolvedPct", findings.resolvedPct),
    ...presentMetric("openThreads", findings.openThreads),
    ...presentMetric("prsWithFindings", findings.prsWithFindings),
    ...presentMetric("summaryRecords30d", settlements.summaryRecords30d),
    ...presentMetric("completionPct", settlements.completionPct),
    ...presentMetric("settlementStatus", settlements.settlementStatus),
    ...presentMetric("lastReviewHours", settlements.lastReviewHours),
  };
}
