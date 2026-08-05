import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubApiError, GitHubClient } from "./client.js";

/**
 * `GitHubClient`'s issue-comment surface (Keiko-for-Quality#31): `listIssueComments`,
 * `createIssueComment`, `updateIssueComment`. This is a different GitHub API family from the
 * review-comment surface `client.approval.test.ts` and `client.resolved.test.ts` already cover —
 * `/issues/{number}/comments`, not `/pulls/{number}/comments`, and never `/reviews`. That
 * distinction is the acceptance criterion this file exists to pin.
 *
 * The retry/backoff suite at the bottom of this file is unrelated to that split — it exercises
 * `requestUrl`, shared machinery underneath every endpoint above and in the sibling client test
 * files — and lives here only because this is this worker's one writable client test file.
 */

const { sleepCalls, sleepStub } = vi.hoisted(() => {
  const sleepCalls: number[] = [];
  return {
    sleepCalls,
    // Records the requested wait instead of actually waiting it out, so a test can assert exactly
    // which backoff (linear, or an honored `retry-after`) a given response provoked without paying
    // for it in wall-clock time.
    sleepStub: (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
  };
});

// `client.ts` imports `node:timers/promises`' `setTimeout` as `delay`; replacing the module's own
// export is what reaches that binding, since `vi.spyOn` cannot intercept a plain function import.
vi.mock("node:timers/promises", () => ({ setTimeout: sleepStub }));

const REF = { owner: "acme", repo: "widget" };

interface RequestLog {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function recordingFetch(response: unknown): { fetch: typeof fetch; requested: RequestLog[] } {
  const requested: RequestLog[] = [];
  const handler = ((input: string | URL | Request, init?: RequestInit) => {
    requested.push({
      url: urlOf(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
    return Promise.resolve(jsonResponse(response));
  }) as typeof fetch;
  return { fetch: handler, requested };
}

function rawComment(
  id: number,
  login: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    body: `comment ${String(id)}`,
    user: { login },
    html_url: `https://example.test/comments/${String(id)}`,
    ...overrides,
  };
}

describe("GitHubClient issue comments", () => {
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
  });

  describe("createIssueComment", () => {
    it("posts to the issues comments endpoint, never /reviews and never /pulls/{n}/comments", async () => {
      const { fetch: stub, requested } = recordingFetch(
        rawComment(1, "keiko-for-quality[bot]", { body: "summary body" }),
      );
      globalThis.fetch = stub;

      const client = new GitHubClient("https://api.github.test", "token");
      const created = await client.createIssueComment(REF, 7, "summary body");

      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatchObject({ method: "POST" });
      expect(requested[0]?.url).toContain("/repos/acme/widget/issues/7/comments");
      expect(requested[0]?.url).not.toContain("/reviews");
      expect(requested[0]?.url).not.toContain("/pulls/7/comments");
      expect(JSON.parse(requested[0]?.body ?? "{}")).toEqual({ body: "summary body" });
      expect(created).toEqual({
        id: 1,
        body: "summary body",
        authorLogin: "keiko-for-quality[bot]",
        url: "https://example.test/comments/1",
      });
    });
  });

  describe("updateIssueComment", () => {
    it("PATCHes the specific comment id, distinct from the pulls review-comments endpoint", async () => {
      const { fetch: stub, requested } = recordingFetch(
        rawComment(42, "keiko-for-quality[bot]", { body: "updated body" }),
      );
      globalThis.fetch = stub;

      const client = new GitHubClient("https://api.github.test", "token");
      const updated = await client.updateIssueComment(REF, 42, "updated body");

      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatchObject({ method: "PATCH" });
      expect(requested[0]?.url).toContain("/repos/acme/widget/issues/comments/42");
      expect(requested[0]?.url).not.toContain("/pulls/comments/42");
      expect(requested[0]?.url).not.toContain("/reviews");
      expect(JSON.parse(requested[0]?.body ?? "{}")).toEqual({ body: "updated body" });
      expect(updated).toMatchObject({ id: 42, body: "updated body" });
    });
  });

  describe("listIssueComments", () => {
    it("lists from the issues comments endpoint, not the review-comments one", async () => {
      globalThis.fetch = ((input: string | URL | Request) => {
        expect(urlOf(input)).toContain("/repos/acme/widget/issues/7/comments");
        expect(urlOf(input)).not.toContain("/pulls/7/comments");
        return Promise.resolve(jsonResponse([rawComment(1, "someone")]));
      }) as typeof fetch;

      const client = new GitHubClient("https://api.github.test", "token");
      const comments = await client.listIssueComments(REF, 7);

      expect(comments).toEqual([
        {
          id: 1,
          body: "comment 1",
          authorLogin: "someone",
          url: "https://example.test/comments/1",
        },
      ]);
    });

    it("follows pagination to the end", async () => {
      let calls = 0;
      globalThis.fetch = ((input: string | URL | Request) => {
        calls += 1;
        const page = /[?&]page=(\d+)/.exec(urlOf(input))?.[1] ?? "1";
        if (page === "1") {
          const full = Array.from({ length: 100 }, (_unused, i) => rawComment(i + 1, "someone"));
          return Promise.resolve(jsonResponse(full));
        }
        return Promise.resolve(jsonResponse([rawComment(101, "someone")]));
      }) as typeof fetch;

      const client = new GitHubClient("https://api.github.test", "token");
      const comments = await client.listIssueComments(REF, 7);

      expect(calls).toBe(2);
      expect(comments).toHaveLength(101);
    });

    it("stops after a short page without an extra trailing request", async () => {
      let calls = 0;
      globalThis.fetch = (() => {
        calls += 1;
        return Promise.resolve(jsonResponse([rawComment(1, "someone")]));
      }) as typeof fetch;

      const client = new GitHubClient("https://api.github.test", "token");
      const comments = await client.listIssueComments(REF, 7);

      expect(calls).toBe(1);
      expect(comments).toHaveLength(1);
    });

    it("stops on an empty page rather than looping", async () => {
      globalThis.fetch = (() => Promise.resolve(jsonResponse([]))) as typeof fetch;
      const client = new GitHubClient("https://api.github.test", "token");
      expect(await client.listIssueComments(REF, 7)).toEqual([]);
    });
  });
});

/**
 * GitHub's secondary rate limit — tripped by rapid comment creation, exactly this reviewer's own
 * publish loop — arrives as a 403 carrying `retry-after` and/or `x-ratelimit-remaining: 0`, not the
 * primary limit's 429. Before this suite, `requestUrl`'s retry path (`RETRYABLE`, backoff) had no
 * test at all: the sibling files' one 403 case (`client.resolved.test.ts`) deliberately uses a bare,
 * headerless 403 to *avoid* paying a retryable status's backoff delay, which coincidentally also
 * means it stays exactly as this suite's own "bare 403" case still requires — a 403 with neither
 * signal must fail immediately, not retry.
 */
describe("GitHubClient retry and backoff (secondary rate limit)", () => {
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
  });

  beforeEach(() => {
    sleepCalls.length = 0;
  });

  function statusResponse(status: number, headers: Record<string, string> = {}): Response {
    return new Response("", { status, headers });
  }

  /** Replays `responses` in order, holding on the last one — enough to script "fails N times, then
   *  succeeds" without a test having to know exactly how many attempts it will take. */
  function sequencedFetch(responses: readonly Response[]): {
    fetch: typeof fetch;
    callCount: () => number;
  } {
    let calls = 0;
    const handler = (() => {
      const response = responses[Math.min(calls, responses.length - 1)]!;
      calls += 1;
      return Promise.resolve(response);
    }) as typeof fetch;
    return { fetch: handler, callCount: () => calls };
  }

  it("retries a 403 carrying retry-after and then succeeds", async () => {
    const { fetch: stub, callCount } = sequencedFetch([
      statusResponse(403, { "retry-after": "1" }),
      jsonResponse({ id: 1, user: { login: "keiko-for-quality[bot]" } }),
    ]);
    globalThis.fetch = stub;
    const client = new GitHubClient("https://api.github.test", "token");

    const comment = await client.getReviewComment(REF, 1);

    expect(comment.id).toBe(1);
    expect(callCount()).toBe(2);
    // The header's own wait is honored instead of the linear backoff's attempt-1 second.
    expect(sleepCalls).toEqual([1000]);
  });

  it("retries a 403 carrying x-ratelimit-remaining: 0 even without a retry-after header", async () => {
    const { fetch: stub, callCount } = sequencedFetch([
      statusResponse(403, { "x-ratelimit-remaining": "0" }),
      jsonResponse({ id: 2, user: { login: "keiko-for-quality[bot]" } }),
    ]);
    globalThis.fetch = stub;
    const client = new GitHubClient("https://api.github.test", "token");

    const comment = await client.getReviewComment(REF, 2);

    expect(comment.id).toBe(2);
    expect(callCount()).toBe(2);
    // No `retry-after` to honor here, so this falls back to the same linear backoff as any other
    // retryable status.
    expect(sleepCalls).toEqual([1000]);
  });

  it("fails immediately on a bare 403 carrying neither signal, never retrying", async () => {
    const { fetch: stub, callCount } = sequencedFetch([statusResponse(403)]);
    globalThis.fetch = stub;
    const client = new GitHubClient("https://api.github.test", "token");

    await expect(client.getReviewComment(REF, 3)).rejects.toThrow(GitHubApiError);
    expect(callCount()).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  it("caps a retry-after wait at 60 seconds", async () => {
    const { fetch: stub, callCount } = sequencedFetch([
      statusResponse(403, { "retry-after": "600" }),
      jsonResponse({ id: 4, user: { login: "keiko-for-quality[bot]" } }),
    ]);
    globalThis.fetch = stub;
    const client = new GitHubClient("https://api.github.test", "token");

    await client.getReviewComment(REF, 4);

    expect(callCount()).toBe(2);
    expect(sleepCalls).toEqual([60_000]);
  });

  // Not this fix's own scenario, but the shared code path it touches had no coverage at all before
  // this suite — a guard against the 403 changes above silently swallowing the pre-existing 5xx path.
  it("still retries an ordinary 5xx with the unchanged linear backoff", async () => {
    const { fetch: stub, callCount } = sequencedFetch([
      statusResponse(503),
      jsonResponse({ id: 5, user: { login: "keiko-for-quality[bot]" } }),
    ]);
    globalThis.fetch = stub;
    const client = new GitHubClient("https://api.github.test", "token");

    await client.getReviewComment(REF, 5);

    expect(callCount()).toBe(2);
    expect(sleepCalls).toEqual([1000]);
  });

  /**
   * The primary rate limit (v0.13.0): no `retry-after` at all, only `x-ratelimit-remaining: 0` and
   * `x-ratelimit-reset` (a Unix epoch second). Before this, a 429 shaped like this fell through to
   * the ordinary linear backoff — a few seconds — and burned all three attempts against a limit that
   * was never going to lift that fast.
   */
  it("honors x-ratelimit-reset on a primary-limit 429, not the linear backoff", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 45;
    const { fetch: stub, callCount } = sequencedFetch([
      statusResponse(429, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt),
      }),
      jsonResponse({ id: 6, user: { login: "keiko-for-quality[bot]" } }),
    ]);
    globalThis.fetch = stub;
    const client = new GitHubClient("https://api.github.test", "token");

    await client.getReviewComment(REF, 6);

    expect(callCount()).toBe(2);
    // Within 1s of the real 45s window — `Date.now()` moves between the fixture's own computation
    // and the function's internal read of it, so an exact match would be flaky.
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(44_000);
    expect(sleepCalls[0]).toBeLessThanOrEqual(45_000);
  });

  it("falls back to the linear backoff when a primary-limit 429 carries no readable reset", async () => {
    const { fetch: stub, callCount } = sequencedFetch([
      statusResponse(429, { "x-ratelimit-remaining": "0" }),
      jsonResponse({ id: 7, user: { login: "keiko-for-quality[bot]" } }),
    ]);
    globalThis.fetch = stub;
    const client = new GitHubClient("https://api.github.test", "token");

    await client.getReviewComment(REF, 7);

    expect(callCount()).toBe(2);
    expect(sleepCalls).toEqual([1000]);
  });

  /**
   * The ambiguous-write refusal (v0.13.0): a 5xx on a WRITE (creating a comment) may have already
   * succeeded server-side before the response was lost, and retrying could create a SECOND comment
   * for the one finding — unlike a 5xx on a read, which costs nothing to repeat.
   */
  it("does not retry a 500 on createIssueComment — an ambiguous write, unlike an ordinary read", async () => {
    const { fetch: stub, callCount } = sequencedFetch([statusResponse(500)]);
    globalThis.fetch = stub;
    const client = new GitHubClient("https://api.github.test", "token");

    await expect(client.createIssueComment(REF, 1, "a summary")).rejects.toThrow(GitHubApiError);
    expect(callCount()).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  it("still retries a 429 or a secondary-rate-limit 403 on the same write — neither is ambiguous", async () => {
    const { fetch: stub, callCount } = sequencedFetch([
      statusResponse(429),
      jsonResponse({ id: 99, body: "posted" }),
    ]);
    globalThis.fetch = stub;
    const client = new GitHubClient("https://api.github.test", "token");

    const created = await client.createIssueComment(REF, 1, "a summary");

    expect(created.id).toBe(99);
    expect(callCount()).toBe(2);
  });
});
