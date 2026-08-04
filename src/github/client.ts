import { setTimeout as delay } from "node:timers/promises";

import { commitSha, type CommitSha } from "../core/brands.js";

/**
 * A minimal GitHub REST client covering exactly the calls this reviewer makes.
 *
 * Written against `fetch` so the product carries no runtime dependencies. The surface is small on
 * purpose: read the pull request, list its review comments, create one, and read it back.
 */

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface ReviewCommentInput {
  readonly body: string;
  readonly commitId: CommitSha;
  readonly path: string;
  /** Absent for a file-level conversation. */
  readonly line?: number;
  readonly startLine?: number;
  /** `RIGHT` anchors on the head; `LEFT` anchors on the deletion side. */
  readonly side?: "LEFT" | "RIGHT";
}

export interface ReviewComment {
  readonly id: number;
  readonly body: string;
  readonly path: string;
  readonly authorLogin: string;
  readonly commitId: string;
  readonly url: string;
  /** The diff line this comment anchors, when it is line-anchored rather than file-level. */
  readonly line?: number;
  /** Present only for a multi-line comment; a single-line comment carries `line` alone. */
  readonly startLine?: number;
  /**
   * True once this comment's review thread is genuinely RESOLVED — GitHub's `isResolved`: a human or
   * bot marked the conversation done.
   *
   * Deliberately independent of `outdated` below: a later push moving the hunk this thread anchored
   * and a person resolving the thread are two different events, and a thread can be either, both, or
   * neither. Folding the two into one flag made an outdated-but-unresolved thread indistinguishable
   * from a resolved one to every caller downstream — which silenced deduplication's exact-marker
   * stage on every push that moved a still-open thread's hunk, measured as the dominant source of
   * this reviewer's duplicate findings. They are reported as two separate facts so a caller can tell
   * "someone decided this" apart from "a later push moved it," which is not the same fact and must
   * not be treated as one.
   *
   * Best-effort, sourced from a separate GraphQL lookup the REST comments endpoint cannot answer
   * (GitHub exposes thread resolution only through `PullRequestReviewThread.isResolved`/
   * `isOutdated`). Absent — not `false` — means the lookup did not run or did not resolve this
   * comment; callers must treat an absent value the same as `false`, i.e. "treated as open" — the
   * documented degradation contract (see README's Deduplication section) — never as "known
   * resolved".
   */
  readonly resolved?: boolean;
  /**
   * True once this comment's review thread is OUTDATED — GitHub's `isOutdated`: a later push moved or
   * removed the diff hunk the thread anchored. Independent of `resolved` above; see that field's doc
   * comment for why the two are reported separately instead of folded into one flag.
   *
   * Best-effort, the same GraphQL lookup and the same absent-means-unknown-and-treated-as-open
   * contract as `resolved`.
   */
  readonly outdated?: boolean;
  /**
   * The last reply on this comment's thread, when the same GraphQL lookup found the thread
   * genuinely RESOLVED (Keiko-for-Quality#64) — never set for a thread that is merely outdated. Now
   * that `outdated` is its own field, `resolved` alone already carries that distinction; this field's
   * own rule is otherwise unchanged: absent when the lookup did not run, the thread is not resolved,
   * or GitHub reported no usable reply (a deleted author, for instance). A thread whose only comment
   * is its own root finding reports that same root comment back here — there is nothing else to
   * report — which is what lets a caller that also knows this reviewer's own identity tell a bare
   * resolve apart from an answered one without this client needing to know what either of those mean.
   */
  readonly lastReply?: ThreadLastReply;
}

/** The shape of a thread's last reply this best-effort GraphQL lookup can report — see
 *  `ReviewComment.lastReply`. Structurally identical to, and deliberately not imported from,
 *  `publish/disposition.ts`'s type of the same name: this module is a transport layer and has no
 *  business knowing what a caller does with the shape, only how to fetch it. */
export interface ThreadLastReply {
  readonly authorLogin: string;
  readonly body: string;
}

export interface PullRequestState {
  readonly headSha: CommitSha;
  readonly draft: boolean;
  readonly baseRef: string;
  readonly headRepoFullName: string | undefined;
}

/**
 * The review-comment surface the publisher depends on.
 *
 * Narrower than the client on purpose: the publisher's security properties — author-verified
 * deduplication, the placement ladder, read-back confirmation — are the part worth testing
 * exhaustively, and they should be testable without a network or a token.
 */
export interface ReviewCommentApi {
  listReviewComments(ref: RepoRef, number: number): Promise<ReviewComment[]>;
  createReviewComment(
    ref: RepoRef,
    number: number,
    input: ReviewCommentInput,
  ): Promise<ReviewComment>;
  getReviewComment(ref: RepoRef, id: number): Promise<ReviewComment>;
}

/**
 * A top-level pull-request conversation comment.
 *
 * Distinct from `ReviewComment`: this is GitHub's *issue* comment family
 * (`/issues/{number}/comments`), not the *review* comment family (`/pulls/{number}/comments`). An
 * issue comment is not anchored to a diff position and carries no `commit_id` — it is not bound to
 * the commit it was written about the way a review comment is, which is exactly why the run summary
 * that uses this surface must state its reviewed head in its own text (see `publish/summary.ts`).
 */
export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly url: string;
}

/**
 * The issue-comment surface the run-summary upsert depends on.
 *
 * Kept as its own narrow interface, the same reasoning as `ReviewCommentApi`: the summary's own
 * security property — updating only a comment this reviewer's own identity authored, never a
 * foreign comment that merely carries a look-alike marker — is worth testing without a network.
 */
export interface IssueCommentApi {
  listIssueComments(ref: RepoRef, number: number): Promise<IssueComment[]>;
  createIssueComment(ref: RepoRef, number: number, body: string): Promise<IssueComment>;
  updateIssueComment(ref: RepoRef, id: number, body: string): Promise<IssueComment>;
}

export class GitHubApiError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    // No response body: GitHub echoes request content, which can include a finding body.
    super(`github api ${String(status)}`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

const RETRYABLE: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/**
 * GitHub reports its secondary rate limit — tripped by rapid comment creation, exactly this
 * client's own publish loop — as a 403, not the primary limit's 429, distinguished only by carrying
 * a `retry-after` header and/or `x-ratelimit-remaining: 0`. A 403 with neither is an authorization
 * failure instead: permanent by contract, where retrying would only spend three attempts repeating
 * the same refusal before failing anyway. Throttling and authorization share a status code on this
 * API; only the headers tell them apart, so both signals are checked rather than assuming either one
 * is always present.
 */
function isSecondaryRateLimit(response: Response): boolean {
  if (response.status !== 403) return false;
  return (
    response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"
  );
}

const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * The server's own requested wait, in milliseconds, when it supplies one. Honored over the linear
 * backoff below because guessing a shorter wait would just trip the same limit again — but capped so
 * a large or malformed value cannot stall the job far longer than the job itself is worth; a run that
 * would need to wait past the cap should fail and let the next trigger retry rather than block CI on
 * someone else's outage.
 */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1000;
}

/**
 * Walks every review thread on the pull request, each carrying whether it is resolved or outdated,
 * the database id — the same id the REST comments endpoint returns — of every comment inside it, and
 * (aliased `lastComment`) that same thread's true last comment, however many it has.
 *
 * The two `comments` connections answer different questions and neither substitutes for the other.
 * `first: 100` is generous for the identity list: a single review thread with more than a hundred
 * replies has never been observed, and undercounting a thread's later replies here still leaves its
 * first comment (where this reviewer's own marker or finding lives) correctly identified. But
 * `lastComment` (Keiko-for-Quality#64) needs the thread's *actual* final reply to decide whether
 * someone gave it a considered disposition — on that one question, "the last of the first 100" would
 * silently answer a different, wrong question the moment a thread ever grew past a hundred replies,
 * which is exactly the shape a long-lived, heavily re-litigated thread can reach. `last: 1` fetches
 * from the end of the connection regardless of its total size, so it is correct at any thread length,
 * not just today's observed ones.
 */
const RESOLVED_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          isResolved
          isOutdated
          comments(first: 100) { nodes { databaseId } }
          lastComment: comments(last: 1) { nodes { author { login } body } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

interface ReviewThreadNode {
  readonly isResolved?: unknown;
  readonly isOutdated?: unknown;
  readonly comments?: { readonly nodes?: readonly { readonly databaseId?: unknown }[] };
  readonly lastComment?: {
    readonly nodes?: readonly {
      readonly author?: { readonly login?: unknown } | null;
      readonly body?: unknown;
    }[];
  };
}

interface ReviewThreadsPage {
  readonly nodes?: readonly ReviewThreadNode[];
  readonly pageInfo?: { readonly hasNextPage?: unknown; readonly endCursor?: unknown };
}

interface ReviewThreadsResponse {
  readonly data?: {
    readonly repository?: { readonly pullRequest?: { readonly reviewThreads?: ReviewThreadsPage } };
  };
  readonly errors?: unknown;
}

/**
 * The thread's true last reply, read off the `lastComment` alias — never derived from the bounded
 * `comments(first: 100)` connection above, which would silently report comment #100 instead of the
 * real last one on an exceptionally long thread. A missing or non-string author/body — a deleted
 * account, a malformed response — degrades to "no reply to report" rather than a guess.
 */
function extractLastReply(node: ReviewThreadNode): ThreadLastReply | undefined {
  const last = node.lastComment?.nodes?.[0];
  const authorLogin = last?.author?.login;
  const body = last?.body;
  if (typeof authorLogin !== "string" || typeof body !== "string") return undefined;
  return { authorLogin, body };
}

/** One review thread's state as it applies to every comment inside it — the internal shape
 *  `collectThreadOverlays` builds and `applyThreadOverlays` unpacks onto `ReviewComment.resolved`/
 *  `outdated`/`lastReply`, the public fields this collapses onto. */
interface ThreadOverlay {
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly lastReply: ThreadLastReply | undefined;
}

/**
 * `Map<databaseId, overlay>` for every comment belonging to a resolved-or-outdated thread, `resolved`
 * and `outdated` carried as the two separate GraphQL facts they are: GitHub sets `isResolved` and
 * `isOutdated` independently, so a thread can be either, both, or neither, and folding them into one
 * flag (the shape this map held before this split) made an outdated-but-unresolved thread
 * indistinguishable from a resolved one to every caller downstream. A comment whose thread is neither
 * is left out of the map entirely rather than written with two `false`s, so `has()` alone still
 * answers "did this comment's thread tell us anything" the way callers already rely on.
 *
 * `lastReply` keeps its pre-existing rule unchanged: populated only for a thread GitHub reports as
 * genuinely `isResolved` (Keiko-for-Quality#64) — a merely-outdated thread never had anyone decide
 * anything, so it is `undefined` here, exactly like a resolved thread whose last comment carried no
 * usable author/body.
 */
function collectThreadOverlays(
  nodes: readonly ReviewThreadNode[],
  into: Map<number, ThreadOverlay>,
): void {
  for (const node of nodes) {
    const isResolved = node.isResolved === true;
    const isOutdated = node.isOutdated === true;
    if (!isResolved && !isOutdated) continue;
    const lastReply = isResolved ? extractLastReply(node) : undefined;
    for (const comment of node.comments?.nodes ?? []) {
      if (typeof comment.databaseId === "number") {
        into.set(comment.databaseId, { resolved: isResolved, outdated: isOutdated, lastReply });
      }
    }
  }
}

/** A GraphQL error response, or one with no page at all, ends the walk with nothing more to add. */
function reviewThreadsPage(raw: ReviewThreadsResponse): ReviewThreadsPage | undefined {
  if (raw.errors !== undefined) return undefined;
  return raw.data?.repository?.pullRequest?.reviewThreads;
}

/** The cursor for the next page, or `undefined` once GitHub reports there is none. */
function nextThreadsCursor(page: ReviewThreadsPage): string | undefined {
  if (page.pageInfo?.hasNextPage !== true) return undefined;
  const cursor = page.pageInfo.endCursor;
  return typeof cursor === "string" ? cursor : undefined;
}

/** GitHub's default GraphQL endpoint. Actions sets `GITHUB_GRAPHQL_URL` to the correct value on
 *  GitHub Enterprise Server; this is only the fallback for a caller that does not supply one. */
const DEFAULT_GRAPHQL_BASE = "https://api.github.com/graphql";

export class GitHubClient implements ReviewCommentApi, IssueCommentApi {
  private readonly apiBase: string;
  private readonly token: string;
  private readonly graphqlBase: string;

  public constructor(apiBase: string, token: string, graphqlBase: string = DEFAULT_GRAPHQL_BASE) {
    // Trailing slashes go, so every `${this.apiBase}${path}` below joins exactly once. The
    // lookbehind is not decoration: the plain `\/+$` it replaced is super-linear (Sonar S8786) —
    // unanchored at the start, the engine retries at every index inside a run of slashes,
    // re-expanding the run before `$` fails, which is quadratic in that run's length. `(?<!\/)`
    // admits only the index a run starts at, and the leftmost index from which slashes run to end
    // of string IS the start of the final run, so the match — and therefore the stripped result —
    // is unchanged for every input.
    this.apiBase = apiBase.replace(/(?<!\/)\/+$/, "");
    this.token = token;
    this.graphqlBase = graphqlBase;
  }

  private async requestUrl(url: string, init: RequestInit = {}): Promise<Response> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "keiko-for-quality",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
      });
      if (response.ok) return response;
      lastStatus = response.status;
      if (!RETRYABLE.has(response.status) && !isSecondaryRateLimit(response)) {
        throw new GitHubApiError(response.status);
      }
      // Linear backoff is the default: the ordinary retryable cases are transient, and a reviewer
      // that hammers a rate-limited API makes the consumer's situation worse, not better. A response
      // naming its own wait (the secondary rate limit's `retry-after`) overrides it instead.
      await delay(retryAfterMs(response) ?? attempt * 1000);
    }
    throw new GitHubApiError(lastStatus);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.requestUrl(`${this.apiBase}${path}`, init);
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(path, init);
    return await response.json();
  }

  /** A GraphQL POST, sharing the same retry/backoff and auth as every REST call above. */
  private async graphqlJson(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const response = await this.requestUrl(this.graphqlBase, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    return await response.json();
  }

  public async getPullRequest(ref: RepoRef, number: number): Promise<PullRequestState> {
    const raw = (await this.json(
      `/repos/${ref.owner}/${ref.repo}/pulls/${String(number)}`,
    )) as Record<string, unknown>;
    const head = raw.head as Record<string, unknown> | undefined;
    const base = raw.base as Record<string, unknown> | undefined;
    const headRepo = head?.repo as Record<string, unknown> | undefined;
    return {
      headSha: commitSha(text(head?.sha), "pull.head.sha"),
      draft: raw.draft === true,
      baseRef: text(base?.ref),
      headRepoFullName: typeof headRepo?.full_name === "string" ? headRepo.full_name : undefined,
    };
  }

  /** Lists every review comment on the pull request, following pagination to the end. */
  public async listReviewComments(ref: RepoRef, number: number): Promise<ReviewComment[]> {
    const comments: ReviewComment[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = (await this.json(
        `/repos/${ref.owner}/${ref.repo}/pulls/${String(number)}/comments?per_page=100&page=${String(page)}`,
      )) as unknown[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const entry of batch) comments.push(toReviewComment(entry as Record<string, unknown>));
      if (batch.length < 100) break;
    }
    return this.applyThreadOverlays(ref, number, comments);
  }

  /**
   * Layers each thread's resolved/outdated state onto comments already read from REST — as two
   * independent facts, `resolved` and `outdated`, never folded into one (see `ReviewComment.resolved`
   * for why that distinction matters to deduplication).
   *
   * The REST comments endpoint has no notion of thread resolution — only GraphQL's
   * `PullRequestReviewThread.isResolved`/`isOutdated` answer it. This is deliberately best-effort:
   * a lookup failure (a token without the right scope, a transient error, GHES without the feature)
   * degrades to "nothing known" on both facts, which is exactly today's behaviour without this
   * lookup — it never turns a dedup optimization into a reason the review itself fails.
   */
  private async applyThreadOverlays(
    ref: RepoRef,
    number: number,
    comments: readonly ReviewComment[],
  ): Promise<ReviewComment[]> {
    const overlays = await this.fetchThreadOverlays(ref, number);
    if (overlays.size === 0) return [...comments];
    return comments.map((comment) => {
      const overlay = overlays.get(comment.id);
      if (overlay === undefined) return comment;
      return {
        ...comment,
        ...(overlay.resolved ? { resolved: true } : {}),
        ...(overlay.outdated ? { outdated: true } : {}),
        ...(overlay.lastReply !== undefined ? { lastReply: overlay.lastReply } : {}),
      };
    });
  }

  /**
   * Bounded, best-effort GraphQL walk of every review thread, returning a map of every comment id
   * belonging to a resolved-or-outdated thread to that thread's own resolved/outdated/last-reply
   * state (Keiko-for-Quality#64) — see `collectThreadOverlays` for exactly what each part means.
   */
  private async fetchThreadOverlays(
    ref: RepoRef,
    number: number,
  ): Promise<ReadonlyMap<number, ThreadOverlay>> {
    const overlays = new Map<number, ThreadOverlay>();
    try {
      let cursor: string | null = null;
      for (let page = 1; page <= 20; page += 1) {
        const raw = (await this.graphqlJson(RESOLVED_THREADS_QUERY, {
          owner: ref.owner,
          repo: ref.repo,
          number,
          cursor,
        })) as ReviewThreadsResponse;
        const threads = reviewThreadsPage(raw);
        if (threads === undefined) break;
        collectThreadOverlays(threads.nodes ?? [], overlays);
        const next = nextThreadsCursor(threads);
        if (next === undefined) break;
        cursor = next;
      }
    } catch {
      // Best-effort: see `applyThreadOverlays`'s doc comment. A failed lookup is not a failed review.
      return new Map();
    }
    return overlays;
  }

  public async createReviewComment(
    ref: RepoRef,
    number: number,
    input: ReviewCommentInput,
  ): Promise<ReviewComment> {
    const payload: Record<string, unknown> = {
      body: input.body,
      commit_id: input.commitId,
      path: input.path,
    };
    if (input.line === undefined) {
      payload.subject_type = "file";
    } else {
      payload.line = input.line;
      payload.side = input.side ?? "RIGHT";
      if (input.startLine !== undefined && input.startLine < input.line) {
        payload.start_line = input.startLine;
        payload.start_side = input.side ?? "RIGHT";
      }
    }
    const created = (await this.json(
      `/repos/${ref.owner}/${ref.repo}/pulls/${String(number)}/comments`,
      { method: "POST", body: JSON.stringify(payload) },
    )) as Record<string, unknown>;
    return toReviewComment(created);
  }

  /** Re-reads a created comment so publication is confirmed by the server, not by the request. */
  public async getReviewComment(ref: RepoRef, id: number): Promise<ReviewComment> {
    const raw = (await this.json(
      `/repos/${ref.owner}/${ref.repo}/pulls/comments/${String(id)}`,
    )) as Record<string, unknown>;
    return toReviewComment(raw);
  }

  /** Resolves the login this token authors as. Used to make deduplication spoof-resistant. */
  public async resolveViewerLogin(): Promise<string | undefined> {
    try {
      const raw = (await this.json("/user")) as Record<string, unknown>;
      return typeof raw.login === "string" ? raw.login : undefined;
    } catch {
      // An installation token cannot read `/user`. The caller supplies the App identity instead.
      return undefined;
    }
  }

  /** Lists every top-level issue comment on the pull request, following pagination to the end. */
  public async listIssueComments(ref: RepoRef, number: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = (await this.json(
        `/repos/${ref.owner}/${ref.repo}/issues/${String(number)}/comments?per_page=100&page=${String(page)}`,
      )) as unknown[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const entry of batch) comments.push(toIssueComment(entry as Record<string, unknown>));
      if (batch.length < 100) break;
    }
    return comments;
  }

  /** Posts a new top-level issue comment. Never the review-comments or reviews endpoint. */
  public async createIssueComment(
    ref: RepoRef,
    number: number,
    body: string,
  ): Promise<IssueComment> {
    const created = (await this.json(
      `/repos/${ref.owner}/${ref.repo}/issues/${String(number)}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    )) as Record<string, unknown>;
    return toIssueComment(created);
  }

  /** Replaces an existing issue comment's body in place — an upsert's "update" half. */
  public async updateIssueComment(ref: RepoRef, id: number, body: string): Promise<IssueComment> {
    const updated = (await this.json(
      `/repos/${ref.owner}/${ref.repo}/issues/comments/${String(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ body }),
      },
    )) as Record<string, unknown>;
    return toIssueComment(updated);
  }
}

/**
 * Reads a field as text only when it genuinely is text.
 *
 * Coercing with `String()` would turn an unexpected object into `"[object Object]"` and carry it
 * onward as if it were a real value — into a comparison that then silently fails, or into a
 * comparison that silently succeeds.
 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A finite integer, or `undefined` for anything else — including a JSON `null`. */
function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * Once a comment's diff position goes stale (a later push moved the hunk it anchored), GitHub nulls
 * `line`/`start_line` and keeps the historical value in `original_line`/`original_start_line`. This
 * still anchors the similarity stage's overlap check to where the comment *was*, which is exactly
 * what "outdated" should mean for deduplication rather than "no longer has a location at all".
 */
function toReviewComment(raw: Record<string, unknown>): ReviewComment {
  const user = raw.user as Record<string, unknown> | undefined;
  const line = optionalInteger(raw.line) ?? optionalInteger(raw.original_line);
  const startLine = optionalInteger(raw.start_line) ?? optionalInteger(raw.original_start_line);
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    body: text(raw.body),
    path: text(raw.path),
    authorLogin: text(user?.login),
    commitId: text(raw.commit_id),
    url: text(raw.html_url),
    ...(line !== undefined ? { line } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
  };
}

/** No diff position, no `commit_id` — an issue comment carries strictly less than a review comment. */
function toIssueComment(raw: Record<string, unknown>): IssueComment {
  const user = raw.user as Record<string, unknown> | undefined;
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    body: text(raw.body),
    authorLogin: text(user?.login),
    url: text(raw.html_url),
  };
}
