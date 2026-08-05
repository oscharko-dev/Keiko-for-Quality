import { afterEach, describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import { GitHubClient } from "./client.js";

/**
 * The REST comments endpoint has no notion of thread resolution — only GraphQL's
 * `PullRequestReviewThread.isResolved`/`isOutdated` answer it. These pin `listReviewComments`'s merge
 * of that GraphQL lookup onto the REST comments it already reads — `resolved` and `outdated` surfaced
 * as two independent facts, never folded into one flag (see `ReviewComment.resolved`/`outdated` in
 * `client.ts` for why that split matters to deduplication) — and its fail-safe degradation: a broken
 * lookup must cost nothing but the optimization it exists to provide, so a failure degrades BOTH
 * facts to "unknown", which every caller downstream treats the same as "open" (Keiko-for-Quality#38,
 * requirement 3: "resolved/outdated conversations must not suppress" — still exactly true for the
 * similarity stage; see `publish/publisher.ts`'s `ownMarkers` for the one stage that now reads
 * `outdated` differently, on purpose).
 */

const REF = { owner: "acme", repo: "widget" };
const HEAD = commitSha("a".repeat(40));

function restComment(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    body: `comment ${String(id)}`,
    path: "src/a.ts",
    user: { login: "keiko-for-quality[bot]" },
    commit_id: HEAD,
    html_url: `https://example.test/${String(id)}`,
    line: 12,
    start_line: 10,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Routes by URL: the comments page, or the GraphQL endpoint — anything else is a test bug. */
function routingFetch(
  restPages: readonly unknown[][],
  graphqlPages: readonly unknown[],
): typeof fetch {
  let graphqlCall = 0;
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/graphql")) {
      const page = graphqlPages[graphqlCall];
      graphqlCall += 1;
      if (page === undefined) return Promise.resolve(jsonResponse({ data: {} }));
      return Promise.resolve(jsonResponse(page));
    }
    // `[?&]` avoids matching the `page=100` inside `per_page=100` before the real parameter.
    const pageMatch = /[?&]page=(\d+)/.exec(url);
    const pageNumber = pageMatch === null ? 1 : Number(pageMatch[1]);
    return Promise.resolve(jsonResponse(restPages[pageNumber - 1] ?? []));
  }) as typeof fetch;
}

function threadsResponse(
  nodes: readonly unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } },
        },
      },
    },
  };
}

describe("GitHubClient.listReviewComments resolved/outdated merge", () => {
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
  });

  it("marks a comment resolved, and not outdated, when its thread is resolved", async () => {
    globalThis.fetch = routingFetch(
      [[restComment(10), restComment(11)]],
      [threadsResponse([{ isResolved: true, comments: { nodes: [{ databaseId: 10 }] } }])],
    );
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments.find((c) => c.id === 10)?.resolved).toBe(true);
    expect(comments.find((c) => c.id === 10)?.outdated).toBeUndefined();
    expect(comments.find((c) => c.id === 11)?.resolved).toBeUndefined();
  });

  /**
   * The dominant source of this reviewer's own duplicate findings, measured live in the reviewer
   * arena: GitHub marks a thread outdated the instant a push moves its hunk, regardless of whether
   * anyone ever answered it. Before `resolved` and `outdated` were split into independent facts here,
   * this thread would have read as `resolved: true` — indistinguishable from a genuinely resolved
   * one — and `publish/publisher.ts`'s exact-marker stage would have read that as license to
   * republish an already-published, still-open finding as a brand-new conversation on every push
   * that touched the file. This is the client-level half of that fix: the two facts must arrive
   * independently, never folded, so a caller downstream can tell them apart.
   */
  it("marks a comment outdated, but NOT genuinely resolved, when its thread is merely outdated", async () => {
    globalThis.fetch = routingFetch(
      [[restComment(20)]],
      [threadsResponse([{ isOutdated: true, comments: { nodes: [{ databaseId: 20 }] } }])],
    );
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments[0]?.outdated).toBe(true);
    expect(comments[0]?.resolved).toBeUndefined();
  });

  // GitHub sets `isResolved` and `isOutdated` independently: a thread can be both at once (someone
  // resolved it, and a later push also moved its hunk). Both facts must surface, not just one.
  it("marks a comment both resolved and outdated when its thread is genuinely both", async () => {
    globalThis.fetch = routingFetch(
      [[restComment(22)]],
      [
        threadsResponse([
          { isResolved: true, isOutdated: true, comments: { nodes: [{ databaseId: 22 }] } },
        ]),
      ],
    );
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments[0]?.resolved).toBe(true);
    expect(comments[0]?.outdated).toBe(true);
  });

  it("leaves every comment unresolved and not outdated when no thread is resolved or outdated", async () => {
    globalThis.fetch = routingFetch(
      [[restComment(30)]],
      [
        threadsResponse([
          { isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 30 }] } },
        ]),
      ],
    );
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments[0]?.resolved).toBeUndefined();
    expect(comments[0]?.outdated).toBeUndefined();
  });

  it("follows GraphQL pagination across multiple thread pages", async () => {
    globalThis.fetch = routingFetch(
      [[restComment(40), restComment(41)]],
      [
        threadsResponse(
          [{ isResolved: true, comments: { nodes: [{ databaseId: 40 }] } }],
          true,
          "cursor-1",
        ),
        threadsResponse(
          [{ isResolved: true, comments: { nodes: [{ databaseId: 41 }] } }],
          false,
          null,
        ),
      ],
    );
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments.find((c) => c.id === 40)?.resolved).toBe(true);
    expect(comments.find((c) => c.id === 41)?.resolved).toBe(true);
  });

  /**
   * Keiko-for-Quality#64: extends the `lastComment` alias's `comments(last: 1)` fetch — the thread's
   * true last reply, not "the last of the first 100" — through the same GraphQL walk. These pin the
   * new field's data fidelity independently of the disposition decision built on top of it in
   * `publish/disposition.ts`.
   */
  describe("last-reply capture (Keiko-for-Quality#64)", () => {
    it("captures a resolved thread's last reply author and body", async () => {
      globalThis.fetch = routingFetch(
        [[restComment(80)]],
        [
          threadsResponse([
            {
              isResolved: true,
              comments: { nodes: [{ databaseId: 80 }] },
              lastComment: {
                nodes: [{ author: { login: "a-contributor" }, body: "Fixed in commit abc1234." }],
              },
            },
          ]),
        ],
      );
      const client = new GitHubClient("https://api.example.test", "token");

      const comments = await client.listReviewComments(REF, 1);

      expect(comments.find((c) => c.id === 80)?.lastReply).toStrictEqual({
        authorLogin: "a-contributor",
        body: "Fixed in commit abc1234.",
      });
    });

    // A merely-outdated thread never had anyone decide anything — resolution and staleness are
    // different facts, and only the first one has a disposition worth reporting.
    it("does not report a last reply for a thread that is merely outdated, not resolved", async () => {
      globalThis.fetch = routingFetch(
        [[restComment(81)]],
        [
          threadsResponse([
            {
              isOutdated: true,
              isResolved: false,
              comments: { nodes: [{ databaseId: 81 }] },
              // Present in the raw response, but must not surface: this thread is outdated, not
              // genuinely resolved, so nothing here counts as a considered disposition.
              lastComment: { nodes: [{ author: { login: "someone" }, body: "A stray reply." }] },
            },
          ]),
        ],
      );
      const client = new GitHubClient("https://api.example.test", "token");

      const comments = await client.listReviewComments(REF, 1);

      const comment = comments.find((c) => c.id === 81);
      expect(comment?.outdated).toBe(true);
      expect(comment?.resolved).toBeUndefined();
      expect(comment?.lastReply).toBeUndefined();
    });

    it("reports no last reply when the thread's own root comment is the only comment (a bare resolve)", async () => {
      globalThis.fetch = routingFetch(
        [[restComment(82)]],
        [
          threadsResponse([
            {
              isResolved: true,
              comments: { nodes: [{ databaseId: 82 }] },
              // The thread's only comment, reported back as its own "last" one — no reply exists.
              lastComment: {
                nodes: [{ author: { login: "keiko-for-quality[bot]" }, body: "The finding body." }],
              },
            },
          ]),
        ],
      );
      const client = new GitHubClient("https://api.example.test", "token");

      const comments = await client.listReviewComments(REF, 1);

      // The client itself has no opinion on whether this counts as a disposition — it reports the
      // reply faithfully; `publish/disposition.ts` is what excludes this reviewer's own identity.
      expect(comments.find((c) => c.id === 82)?.lastReply).toStrictEqual({
        authorLogin: "keiko-for-quality[bot]",
        body: "The finding body.",
      });
    });

    it("degrades to no last reply when the last comment's author is null (a deleted account)", async () => {
      globalThis.fetch = routingFetch(
        [[restComment(83)]],
        [
          threadsResponse([
            {
              isResolved: true,
              comments: { nodes: [{ databaseId: 83 }] },
              lastComment: { nodes: [{ author: null, body: "Some reply text." }] },
            },
          ]),
        ],
      );
      const client = new GitHubClient("https://api.example.test", "token");

      const comments = await client.listReviewComments(REF, 1);

      expect(comments.find((c) => c.id === 83)?.lastReply).toBeUndefined();
    });

    it("degrades to no last reply when the thread reports no comment in the `last: 1` connection", async () => {
      globalThis.fetch = routingFetch(
        [[restComment(84)]],
        [
          threadsResponse([
            {
              isResolved: true,
              comments: { nodes: [{ databaseId: 84 }] },
              lastComment: { nodes: [] },
            },
          ]),
        ],
      );
      const client = new GitHubClient("https://api.example.test", "token");

      const comments = await client.listReviewComments(REF, 1);

      expect(comments.find((c) => c.id === 84)?.lastReply).toBeUndefined();
    });

    /**
     * The consumer pull request that surfaced Keiko-for-Quality#64 (oscharko-dev/Keiko#2931) had
     * well over a hundred review threads. The outer `reviewThreads` walk already follows
     * `pageInfo.hasNextPage`/`endCursor` across pages (see "follows GraphQL pagination across
     * multiple thread pages" above) — this proves the new `lastComment` field survives that same
     * walk unchanged, on a thread from the *second* page, not just the first.
     */
    it("captures each page's own last-reply data across multiple thread pages", async () => {
      globalThis.fetch = routingFetch(
        [[restComment(90), restComment(91)]],
        [
          threadsResponse(
            [
              {
                isResolved: true,
                comments: { nodes: [{ databaseId: 90 }] },
                lastComment: {
                  nodes: [{ author: { login: "page-one-author" }, body: "Resolved on page one." }],
                },
              },
            ],
            true,
            "cursor-1",
          ),
          threadsResponse(
            [
              {
                isResolved: true,
                comments: { nodes: [{ databaseId: 91 }] },
                lastComment: {
                  nodes: [{ author: { login: "page-two-author" }, body: "Resolved on page two." }],
                },
              },
            ],
            false,
            null,
          ),
        ],
      );
      const client = new GitHubClient("https://api.example.test", "token");

      const comments = await client.listReviewComments(REF, 1);

      expect(comments.find((c) => c.id === 90)?.lastReply).toStrictEqual({
        authorLogin: "page-one-author",
        body: "Resolved on page one.",
      });
      expect(comments.find((c) => c.id === 91)?.lastReply).toStrictEqual({
        authorLogin: "page-two-author",
        body: "Resolved on page two.",
      });
    });
  });

  // Both facts must degrade together: a caller that only checked `resolved` for "unknown" and forgot
  // `outdated` would still read this comment as eligible for suppression on a false premise.
  it("degrades to unresolved AND not-outdated for everyone when the GraphQL call fails, without throwing", async () => {
    // 403, not a retryable status: this is the realistic shape of the failure (a token without
    // GraphQL scope), and it keeps the test from paying the retry/backoff delay a 5xx would trigger.
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/graphql")) return Promise.resolve(new Response("", { status: 403 }));
      return Promise.resolve(jsonResponse([restComment(50)]));
    }) as typeof fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments).toHaveLength(1);
    expect(comments[0]?.resolved).toBeUndefined();
    expect(comments[0]?.outdated).toBeUndefined();
  });

  it("degrades to unresolved AND not-outdated when GraphQL answers with an errors payload", async () => {
    globalThis.fetch = routingFetch([[restComment(60)]], [{ errors: [{ message: "not found" }] }]);
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments[0]?.resolved).toBeUndefined();
    expect(comments[0]?.outdated).toBeUndefined();
  });

  it("reads the line anchor from REST fields, falling back to the original position once outdated", async () => {
    globalThis.fetch = routingFetch(
      [
        [
          restComment(70, { line: 12, start_line: 10 }),
          restComment(71, {
            line: undefined,
            start_line: undefined,
            original_line: 8,
            original_start_line: 6,
          }),
        ],
      ],
      [threadsResponse([])],
    );
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments.find((c) => c.id === 70)).toMatchObject({ line: 12, startLine: 10 });
    expect(comments.find((c) => c.id === 71)).toMatchObject({ line: 8, startLine: 6 });
  });

  /**
   * v0.13.0: nothing for the GraphQL walk to attach state to when there are zero REST comments —
   * a fresh pull request this reviewer has never commented on yet, which every one of its runs
   * reaches at least once. Skipping the round trip entirely costs nothing this reviewer needed.
   */
  it("never calls GraphQL at all when the REST comment list is empty", async () => {
    let graphqlCalled = false;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/graphql")) {
        graphqlCalled = true;
        return Promise.resolve(jsonResponse(threadsResponse([])));
      }
      return Promise.resolve(jsonResponse([]));
    }) as typeof fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments).toEqual([]);
    expect(graphqlCalled).toBe(false);
  });

  it("uses the caller-supplied GraphQL endpoint instead of the github.com default", async () => {
    const requested: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      if (url.includes("graphql")) return Promise.resolve(jsonResponse(threadsResponse([])));
      // At least one REST comment: the GraphQL overlay walk has nothing to attach state to, and is
      // deliberately skipped entirely, on an empty comment list — this test is about which endpoint
      // gets used, not about that skip, so it needs a comment to reach the walk at all.
      return Promise.resolve(jsonResponse([restComment(90)]));
    }) as typeof fetch;
    const client = new GitHubClient(
      "https://ghes.example.test/api/v3",
      "token",
      "https://ghes.example.test/api/graphql",
    );

    await client.listReviewComments(REF, 1);

    expect(requested.some((url) => url === "https://ghes.example.test/api/graphql")).toBe(true);
  });
});
