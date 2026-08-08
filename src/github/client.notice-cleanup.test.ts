import { afterEach, describe, expect, it } from "vitest";

import { GitHubClient } from "./client.js";

/**
 * `resolveSupersededOwnNotices` — the write half of the notice-cleanup feature. Pins the read
 * predicate (`collectResolvableNoticeThreadIds`, exercised indirectly here exactly the way
 * `collectThreadOverlays` already is in `client.resolved.test.ts`) and the mutation call it drives.
 *
 * `IDENTITY` matches this reviewer's own login on purpose: every fixture below is asking "does this
 * reviewer resolve ITS OWN threads", so a mismatch on this constant would make every "does not
 * resolve" case pass for the wrong reason (nobody's identity matched anything) rather than the right
 * one (the narrowing condition under test actually excluded it).
 */

const REF = { owner: "acme", repo: "widget" };
const IDENTITY = "keiko-for-quality[bot]";
const CURRENT_HEAD = "1111111111111111111111111111111111111111";
const NOTICE_BODY = "Keiko for Quality could not complete its review.";

/**
 * A self-contained stand-in for `presentation.ts`'s `isIncompleteNoticeBody`, not an import across
 * the `github/` → `publish/` layering this reviewer's own dependency direction forbids (`publish/`
 * depends on `github/`, never the reverse). `resolveSupersededOwnNotices` treats this parameter as
 * an opaque predicate — every test below is about the CLIENT's own pagination/identity/mutation
 * logic, never about what the predicate itself considers a notice — so the sentence-only check here
 * is deliberately simpler than the real one (#42 also requires a well-formed marker) and does not
 * need to track it.
 */
function isNoticeBody(body: string): boolean {
  return body.includes(NOTICE_BODY);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function threadsPage(
  nodes: readonly unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): unknown {
  return {
    data: {
      repository: {
        pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } },
      },
    },
  };
}

interface CapturedCall {
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

/** Every POST is a GraphQL call in this client — routes purely by call order against a scripted
 *  response sequence, and records the request body of each so a test can assert on the mutation's
 *  own variables. A plain object is wrapped as a JSON `Response` automatically, so a fixture built
 *  from `threadsPage(...)` needs no separate `jsonResponse(...)` wrapping at its call site. */
function scriptedGraphql(responses: readonly unknown[]): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let call = 0;
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as CapturedCall;
    calls.push(parsed);
    const response = responses[call];
    call += 1;
    if (response instanceof Response) return Promise.resolve(response);
    return Promise.resolve(jsonResponse(response ?? { data: {} }));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("GitHubClient.resolveSupersededOwnNotices", () => {
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
  });

  it("resolves an outdated, unresolved thread carrying this reviewer's own incomplete notice", async () => {
    const { fetch, calls } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_1",
          isResolved: false,
          isOutdated: true,
          comments: { nodes: [{ databaseId: 1, author: { login: IDENTITY }, body: NOTICE_BODY }] },
        },
      ]),
      jsonResponse({
        data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } },
      }),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    const outcome = await client.resolveSupersededOwnNotices(
      REF,
      1,
      IDENTITY,
      isNoticeBody,
      CURRENT_HEAD,
      false,
    );

    expect(outcome).toStrictEqual({ attempted: 1, resolved: 1 });
    expect(calls[1]?.query).toContain("resolveReviewThread");
    expect(calls[1]?.variables).toStrictEqual({ threadId: "PRRT_1" });
  });

  /**
   * Keiko#3003, measured: an `engine_error` notice stayed open while a LATER run reviewed the very
   * same head to completion. The head never moved, so neither `isOutdated` nor the older-head test
   * could see the notice had been answered — only the outcome of the run doing the cleanup can.
   */
  it("resolves a same-head notice once a run completes, which the head tests cannot see", async () => {
    const { fetch, calls } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_SAME",
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                databaseId: 9,
                author: { login: IDENTITY },
                body: NOTICE_BODY,
                originalCommit: { oid: CURRENT_HEAD },
              },
            ],
          },
        },
      ]),
      jsonResponse({
        data: { resolveReviewThread: { thread: { id: "PRRT_SAME", isResolved: true } } },
      }),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    const outcome = await client.resolveSupersededOwnNotices(
      REF,
      1,
      IDENTITY,
      isNoticeBody,
      CURRENT_HEAD,
      true,
    );

    expect(outcome).toStrictEqual({ attempted: 1, resolved: 1 });
    expect(calls[1]?.variables).toStrictEqual({ threadId: "PRRT_SAME" });
  });

  // The same thread under an INCOMPLETE run stays open: a run that could not review the head has
  // not answered the notice about that head, and saying otherwise is exactly the "incomplete reads
  // as clean" failure this product exists to prevent.
  it("leaves a same-head notice open when the run did not complete", async () => {
    const { fetch } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_SAME",
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                databaseId: 9,
                author: { login: IDENTITY },
                body: NOTICE_BODY,
                originalCommit: { oid: CURRENT_HEAD },
              },
            ],
          },
        },
      ]),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    expect(
      await client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, false),
    ).toStrictEqual({ attempted: 0, resolved: 0 });
  });

  // A completed run resolves NOTICES, never findings: a finding is an open question for a human,
  // and the collector's own author/body test is what keeps that line — asserted here because the
  // completed-run branch is the widest one in that predicate.
  it("never resolves a finding thread, even on a completed run", async () => {
    const { fetch } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_FIND",
          isResolved: false,
          isOutdated: true,
          comments: {
            nodes: [
              {
                databaseId: 3,
                author: { login: IDENTITY },
                body: "`TESTS · MAJOR`\n\n**A finding.**",
              },
            ],
          },
        },
      ]),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    expect(
      await client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, true),
    ).toStrictEqual({ attempted: 0, resolved: 0 });
  });

  it("does not resolve a thread that is outdated but already genuinely resolved", async () => {
    const { fetch, calls } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_2",
          isResolved: true,
          isOutdated: true,
          comments: { nodes: [{ databaseId: 2, author: { login: IDENTITY }, body: NOTICE_BODY }] },
        },
      ]),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    const outcome = await client.resolveSupersededOwnNotices(
      REF,
      1,
      IDENTITY,
      isNoticeBody,
      CURRENT_HEAD,
      false,
    );

    expect(outcome).toStrictEqual({ attempted: 0, resolved: 0 });
    expect(calls).toHaveLength(1); // the list query only — no mutation was ever attempted
  });

  it("does not resolve a thread that is still current (not outdated)", async () => {
    const { fetch } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_3",
          isResolved: false,
          isOutdated: false,
          comments: { nodes: [{ databaseId: 3, author: { login: IDENTITY }, body: NOTICE_BODY }] },
        },
      ]),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    expect(
      await client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, false),
    ).toStrictEqual({
      attempted: 0,
      resolved: 0,
    });
  });

  /**
   * The Keiko#3002 accumulation, pinned (2026-08-06): a notice is a FILE-level comment, GitHub
   * never marks a file-level thread outdated, and eight of them piled up unresolved on one pull
   * request. The notice's own `originalCommit` is the supersession fact `isOutdated` cannot carry
   * for a file-level thread.
   */
  it("resolves a file-level notice whose originalCommit is no longer the reviewed head", async () => {
    const { fetch, calls } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_9",
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                databaseId: 9,
                author: { login: IDENTITY },
                body: NOTICE_BODY,
                originalCommit: { oid: "0000000000000000000000000000000000000000" },
              },
            ],
          },
        },
      ]),
      jsonResponse({
        data: { resolveReviewThread: { thread: { id: "PRRT_9", isResolved: true } } },
      }),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    const outcome = await client.resolveSupersededOwnNotices(
      REF,
      1,
      IDENTITY,
      isNoticeBody,
      CURRENT_HEAD,
      false,
    );

    expect(outcome).toStrictEqual({ attempted: 1, resolved: 1 });
    expect(calls[1]?.variables).toStrictEqual({ threadId: "PRRT_9" });
  });

  it("never resolves the notice the current head's own settlement just published", async () => {
    const { fetch, calls } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_10",
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                databaseId: 10,
                author: { login: IDENTITY },
                body: NOTICE_BODY,
                originalCommit: { oid: CURRENT_HEAD },
              },
            ],
          },
        },
      ]),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    const outcome = await client.resolveSupersededOwnNotices(
      REF,
      1,
      IDENTITY,
      isNoticeBody,
      CURRENT_HEAD,
      false,
    );

    expect(outcome).toStrictEqual({ attempted: 0, resolved: 0 });
    expect(calls).toHaveLength(1);
  });

  /**
   * The property that keeps this feature from ever touching a finding: a finding's own body never
   * satisfies `isNoticeBody`, however outdated and however authored, because `presentation.ts`'s two
   * composers never produce overlapping text — pinned here at the client layer too, not only in
   * `presentation.test.ts`, since this is the layer that would actually fire the mutation.
   */
  it("does not resolve an outdated, unresolved thread whose body is not recognised as a notice", async () => {
    const { fetch } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_4",
          isResolved: false,
          isOutdated: true,
          comments: {
            nodes: [
              { databaseId: 4, author: { login: IDENTITY }, body: "The retry loop never resets." },
            ],
          },
        },
      ]),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    expect(
      await client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, false),
    ).toStrictEqual({
      attempted: 0,
      resolved: 0,
    });
  });

  it("does not resolve a notice-shaped thread authored by someone else", async () => {
    const { fetch } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_5",
          isResolved: false,
          isOutdated: true,
          comments: {
            nodes: [{ databaseId: 5, author: { login: "a-contributor" }, body: NOTICE_BODY }],
          },
        },
      ]),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    expect(
      await client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, false),
    ).toStrictEqual({
      attempted: 0,
      resolved: 0,
    });
  });

  it("finds its own notice anywhere in the thread's comments, not only the first", async () => {
    const { fetch } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_6",
          isResolved: false,
          isOutdated: true,
          comments: {
            nodes: [
              { databaseId: 6, author: { login: IDENTITY }, body: NOTICE_BODY },
              { databaseId: 7, author: { login: "a-contributor" }, body: "Acknowledged." },
            ],
          },
        },
      ]),
      jsonResponse({
        data: { resolveReviewThread: { thread: { id: "PRRT_6", isResolved: true } } },
      }),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    expect(
      await client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, false),
    ).toStrictEqual({
      attempted: 1,
      resolved: 1,
    });
  });

  it("follows GraphQL pagination and resolves matching threads on every page", async () => {
    const { fetch } = scriptedGraphql([
      threadsPage(
        [
          {
            id: "PRRT_8",
            isResolved: false,
            isOutdated: true,
            comments: {
              nodes: [{ databaseId: 8, author: { login: IDENTITY }, body: NOTICE_BODY }],
            },
          },
        ],
        true,
        "cursor-1",
      ),
      threadsPage([
        {
          id: "PRRT_9",
          isResolved: false,
          isOutdated: true,
          comments: { nodes: [{ databaseId: 9, author: { login: IDENTITY }, body: NOTICE_BODY }] },
        },
      ]),
      jsonResponse({
        data: { resolveReviewThread: { thread: { id: "PRRT_8", isResolved: true } } },
      }),
      jsonResponse({
        data: { resolveReviewThread: { thread: { id: "PRRT_9", isResolved: true } } },
      }),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    expect(
      await client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, false),
    ).toStrictEqual({
      attempted: 2,
      resolved: 2,
    });
  });

  it("counts only the mutations that actually report resolved, continuing past one that fails", async () => {
    const { fetch } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_10",
          isResolved: false,
          isOutdated: true,
          comments: { nodes: [{ databaseId: 10, author: { login: IDENTITY }, body: NOTICE_BODY }] },
        },
        {
          id: "PRRT_11",
          isResolved: false,
          isOutdated: true,
          comments: { nodes: [{ databaseId: 11, author: { login: IDENTITY }, body: NOTICE_BODY }] },
        },
      ]),
      jsonResponse({ errors: [{ message: "thread already resolved by another actor" }] }),
      jsonResponse({
        data: { resolveReviewThread: { thread: { id: "PRRT_11", isResolved: true } } },
      }),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    // Two of two were attempted; one of two mutations failed and the other still ran and counted —
    // a per-thread failure must not abandon the rest of the batch, the same containment posture
    // `publisher.ts`'s `executeOne` uses.
    expect(
      await client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, false),
    ).toStrictEqual({
      attempted: 2,
      resolved: 1,
    });
  });

  it("degrades to zero attempted, without throwing, when the thread lookup itself fails", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("", { status: 403 }))) as typeof fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    await expect(
      client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, false),
    ).resolves.toStrictEqual({ attempted: 0, resolved: 0 });
  });

  it("never resolves a thread with no comment at all authored by this reviewer", async () => {
    const { fetch } = scriptedGraphql([
      threadsPage([
        {
          id: "PRRT_12",
          isResolved: false,
          isOutdated: true,
          comments: { nodes: [] },
        },
      ]),
    ]);
    globalThis.fetch = fetch;
    const client = new GitHubClient("https://api.example.test", "token");

    expect(
      await client.resolveSupersededOwnNotices(REF, 1, IDENTITY, isNoticeBody, CURRENT_HEAD, false),
    ).toStrictEqual({
      attempted: 0,
      resolved: 0,
    });
  });
});
