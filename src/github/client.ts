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

export class GitHubClient implements ReviewCommentApi {
  private readonly apiBase: string;
  private readonly token: string;

  public constructor(apiBase: string, token: string) {
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.token = token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await fetch(`${this.apiBase}${path}`, {
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
      if (!RETRYABLE.has(response.status)) throw new GitHubApiError(response.status);
      // Linear backoff is sufficient: the retryable cases are transient, and a reviewer that
      // hammers a rate-limited API makes the consumer's situation worse, not better.
      await delay(attempt * 1000);
    }
    throw new GitHubApiError(lastStatus);
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(path, init);
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
    return comments;
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

function toReviewComment(raw: Record<string, unknown>): ReviewComment {
  const user = raw.user as Record<string, unknown> | undefined;
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    body: text(raw.body),
    path: text(raw.path),
    authorLogin: text(user?.login),
    commitId: text(raw.commit_id),
    url: text(raw.html_url),
  };
}
