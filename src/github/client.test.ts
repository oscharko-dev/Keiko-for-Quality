import { afterEach, describe, expect, it } from "vitest";

import { GitHubClient } from "./client.js";

/**
 * `GitHubClient`'s issue-comment surface (Keiko-for-Quality#31): `listIssueComments`,
 * `createIssueComment`, `updateIssueComment`. This is a different GitHub API family from the
 * review-comment surface `client.approval.test.ts` and `client.resolved.test.ts` already cover —
 * `/issues/{number}/comments`, not `/pulls/{number}/comments`, and never `/reviews`. That
 * distinction is the acceptance criterion this file exists to pin.
 */

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
