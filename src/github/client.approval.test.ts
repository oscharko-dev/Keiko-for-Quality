import { describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import { GitHubClient, type ReviewCommentInput } from "./client.js";

/**
 * The reviewer must never approve a pull request.
 *
 * This is a *behavioural* guarantee, not a permission boundary, and the distinction is the point.
 * GitHub's create-review API accepts an `APPROVE` event from any token holding
 * `pull-requests: write` — which both a GitHub App installation token and `GITHUB_TOKEN` hold. The
 * platform will not stop this client from approving; only this client's own behaviour will.
 *
 * ADR-0170 D3 in the consuming repository states exactly that and says the guarantee is pinned
 * upstream. This is that pin. If someone adds an approval path, this test fails before the claim
 * becomes false in a consumer's repository.
 */
describe("the client cannot approve", () => {
  const requested: string[] = [];

  function recordingFetch(): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(`${init?.method ?? "GET"} ${url}`);
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1, user: { login: "bot" } }), { status: 200 }),
      );
    }) as typeof fetch;
  }

  it("never posts to the reviews endpoint, only to the comments endpoint", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = recordingFetch();
    try {
      const client = new GitHubClient("https://api.github.test", "token");
      const input: ReviewCommentInput = {
        body: "A finding.",
        commitId: commitSha("a".repeat(40)),
        path: "src/a.ts",
        line: 3,
      };
      await client.createReviewComment({ owner: "o", repo: "r" }, 1, input);
    } finally {
      globalThis.fetch = original;
    }

    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("/pulls/1/comments");
    // `/pulls/{n}/reviews` is the only endpoint that can carry an APPROVE event.
    expect(requested[0]).not.toContain("/reviews");
  });

  it("exposes no method that could submit a review event", () => {
    const surface = Object.getOwnPropertyNames(GitHubClient.prototype);
    for (const name of surface) {
      expect(name.toLowerCase()).not.toContain("approve");
      expect(name.toLowerCase()).not.toContain("submitreview");
    }
    expect(surface).toContain("createReviewComment");
  });

  it("has no APPROVE literal anywhere in the client", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./client.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toContain("APPROVE");
    expect(source).not.toContain("/reviews");
  });
});
