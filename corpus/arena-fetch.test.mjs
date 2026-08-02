import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter as pathDelimiter, join as joinPath } from "node:path";

import {
  resolveGhBinary,
  fetchPullRequestReviewThreads,
  discoverPullRequestNumbers,
} from "./arena-fetch.mjs";

/**
 * Tests for the arena scoreboard's fetch layer (issue #39).
 *
 * `corpus/arena-fetch.mjs`'s own header explains the split: `runGh`/`runGraphql`, the two functions
 * that actually spawn `gh`, are not exercised here — there is no network access or `gh` installation
 * to depend on in a test run. Everything else in that module — resolving `gh` on `PATH`, paging
 * through a multi-page GraphQL response, surfacing a GraphQL error or a missing pull request — is
 * ordinary logic with real failure modes, and is tested the same hermetic way as
 * `corpus/arena-lib.test.mjs`: by injecting a fake in place of the one impure call.
 */

function withPath(entries, run) {
  const original = process.env.PATH;
  process.env.PATH = entries.join(pathDelimiter);
  try {
    return run();
  } finally {
    process.env.PATH = original;
  }
}

test("resolveGhBinary returns the executable in the first PATH directory that has it", () => {
  withPath(["/nowhere", "/opt/tools", "/usr/bin"], () => {
    const exists = (candidate) => candidate === joinPath("/opt/tools", "gh");
    assert.equal(resolveGhBinary(exists), joinPath("/opt/tools", "gh"));
  });
});

test("resolveGhBinary does not stop at the first PATH directory if it lacks the executable", () => {
  withPath(["/opt/tools", "/usr/bin"], () => {
    const exists = (candidate) => candidate === joinPath("/usr/bin", "gh");
    assert.equal(resolveGhBinary(exists), joinPath("/usr/bin", "gh"));
  });
});

test("resolveGhBinary throws a clear error when gh is on no PATH directory", () => {
  withPath(["/opt/tools", "/usr/bin"], () => {
    assert.throws(() => resolveGhBinary(() => false), /gh was not found on PATH/);
  });
});

test("resolveGhBinary ignores empty PATH entries", () => {
  withPath(["", "/opt/tools", ""], () => {
    const exists = (candidate) => candidate === joinPath("/opt/tools", "gh");
    assert.equal(resolveGhBinary(exists), joinPath("/opt/tools", "gh"));
  });
});

function threadFixture(id, login, path = "a.ts") {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    comments: {
      totalCount: 1,
      nodes: [
        {
          databaseId: 1,
          url: "https://example.invalid",
          body: "body",
          path,
          line: 1,
          originalLine: 1,
          startLine: null,
          originalStartLine: null,
          createdAt: "2026-01-01T00:00:00Z",
          commit: { oid: "abc" },
          author: { login, __typename: "Bot" },
          replyTo: null,
        },
      ],
    },
  };
}

function graphqlPage(headRefOid, threads, pageInfo) {
  return {
    data: {
      repository: { pullRequest: { headRefOid, reviewThreads: { pageInfo, nodes: threads } } },
    },
  };
}

test("fetchPullRequestReviewThreads returns a single page's threads without paging further", () => {
  const threads = [threadFixture("t1", "someone")];
  const page = graphqlPage("headsha1", threads, { hasNextPage: false, endCursor: null });
  let calls = 0;
  const fakeRunGh = () => {
    calls += 1;
    return JSON.stringify(page);
  };
  const result = fetchPullRequestReviewThreads("owner", "repo", 1, fakeRunGh);
  assert.equal(calls, 1);
  assert.equal(result.headSha, "headsha1");
  assert.equal(result.threads.length, 1);
  assert.equal(result.truncatedThreadCount, 0);
});

test("fetchPullRequestReviewThreads follows pagination and merges threads across pages", () => {
  const firstPage = graphqlPage("headsha1", [threadFixture("t1", "a")], {
    hasNextPage: true,
    endCursor: "cursor-1",
  });
  const secondPage = graphqlPage("headsha1", [threadFixture("t2", "b")], {
    hasNextPage: false,
    endCursor: null,
  });
  let calls = 0;
  const fakeRunGh = () => {
    calls += 1;
    return JSON.stringify(calls === 1 ? firstPage : secondPage);
  };
  const result = fetchPullRequestReviewThreads("owner", "repo", 1, fakeRunGh);
  assert.equal(calls, 2);
  assert.deepEqual(
    result.threads.map((t) => t.id),
    ["t1", "t2"],
  );
});

/**
 * Regression pin: the page loop originally had no failure mode of its own — if `hasNextPage` was
 * still `true` after the 50th page, the loop simply ended and returned a partial thread list with
 * no signal, contradicting the same module's own documented discipline for the inner, per-thread
 * reply cap (`truncatedThreadCount`). A pull request would need thousands of review threads to
 * reach this in practice, but a silent truncation at either level is the one thing this function's
 * own docstring promises never happens.
 */
test("fetchPullRequestReviewThreads throws, rather than silently truncating, when a pull request has more pages of review threads than it can page", () => {
  const alwaysAnotherPage = graphqlPage("headsha1", [threadFixture("t", "someone")], {
    hasNextPage: true,
    endCursor: "keep-going",
  });
  let calls = 0;
  const fakeRunGh = () => {
    calls += 1;
    return JSON.stringify(alwaysAnotherPage);
  };
  assert.throws(
    () => fetchPullRequestReviewThreads("owner", "repo", 1, fakeRunGh),
    /more than 50 pages/,
  );
  assert.equal(calls, 50, "must attempt exactly the documented page cap before giving up");
});

test("fetchPullRequestReviewThreads counts a thread whose replies were not fully paged in", () => {
  const thread = threadFixture("t1", "someone");
  thread.comments.totalCount = 5; // more replies than the single node included above
  const page = graphqlPage("headsha1", [thread], { hasNextPage: false, endCursor: null });
  const result = fetchPullRequestReviewThreads("owner", "repo", 1, () => JSON.stringify(page));
  assert.equal(result.truncatedThreadCount, 1);
});

test("fetchPullRequestReviewThreads throws with the GraphQL error payload on a GraphQL error", () => {
  const errorResponse = { errors: [{ message: "field not found" }] };
  assert.throws(
    () => fetchPullRequestReviewThreads("owner", "repo", 1, () => JSON.stringify(errorResponse)),
    /GitHub GraphQL error for owner\/repo#1/,
  );
});

test("fetchPullRequestReviewThreads throws a clear error when the pull request does not exist", () => {
  const missing = { data: { repository: { pullRequest: null } } };
  assert.throws(
    () => fetchPullRequestReviewThreads("owner", "repo", 999, () => JSON.stringify(missing)),
    /pull request owner\/repo#999 was not found/,
  );
});

test("discoverPullRequestNumbers sorts the discovered numbers ascending", () => {
  const fakeRunGh = () => JSON.stringify([{ number: 42 }, { number: 7 }, { number: 100 }]);
  assert.deepEqual(
    discoverPullRequestNumbers("owner", "repo", "2026-01-01", "all", fakeRunGh),
    [7, 42, 100],
  );
});

test("discoverPullRequestNumbers passes the requested state and since-date through to gh", () => {
  let capturedArgs;
  const fakeRunGh = (args) => {
    capturedArgs = args;
    return "[]";
  };
  discoverPullRequestNumbers("owner", "repo", "2026-06-15", "open", fakeRunGh);
  assert.ok(capturedArgs.includes("--state"));
  assert.ok(capturedArgs.includes("open"));
  assert.ok(capturedArgs.some((arg) => arg.includes("2026-06-15")));
});
