import { afterEach, describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import { GitHubClient } from "./client.js";

/**
 * The REST comments endpoint has no notion of thread resolution — only GraphQL's
 * `PullRequestReviewThread.isResolved`/`isOutdated` answer it (Keiko-for-Quality#38, requirement 3:
 * "resolved/outdated conversations must not suppress"). These pin `listReviewComments`' merge of
 * that GraphQL lookup onto the REST comments it already reads, and its fail-safe degradation: a
 * broken lookup must cost nothing but the optimization it exists to provide.
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

  it("marks a comment resolved when its thread is resolved", async () => {
    globalThis.fetch = routingFetch(
      [[restComment(10), restComment(11)]],
      [threadsResponse([{ isResolved: true, comments: { nodes: [{ databaseId: 10 }] } }])],
    );
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments.find((c) => c.id === 10)?.resolved).toBe(true);
    expect(comments.find((c) => c.id === 11)?.resolved).toBeUndefined();
  });

  it("marks a comment resolved when its thread is merely outdated", async () => {
    globalThis.fetch = routingFetch(
      [[restComment(20)]],
      [threadsResponse([{ isOutdated: true, comments: { nodes: [{ databaseId: 20 }] } }])],
    );
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments[0]?.resolved).toBe(true);
  });

  it("leaves every comment unresolved when no thread is resolved or outdated", async () => {
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

  it("degrades to unresolved for everyone when the GraphQL call fails, without throwing", async () => {
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
  });

  it("degrades to unresolved when GraphQL answers with an errors payload", async () => {
    globalThis.fetch = routingFetch([[restComment(60)]], [{ errors: [{ message: "not found" }] }]);
    const client = new GitHubClient("https://api.example.test", "token");

    const comments = await client.listReviewComments(REF, 1);

    expect(comments[0]?.resolved).toBeUndefined();
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

  it("uses the caller-supplied GraphQL endpoint instead of the github.com default", async () => {
    const requested: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      if (url.includes("graphql")) return Promise.resolve(jsonResponse(threadsResponse([])));
      return Promise.resolve(jsonResponse([]));
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
