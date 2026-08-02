import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter as pathDelimiter, join as joinPath } from "node:path";

import {
  resolveGhBinary,
  fetchPullRequestReviewThreads,
  discoverPullRequestNumbers,
  fetchPullRequestCommitShas,
  fetchCommitWithFiles,
  fetchPullRequestCommitTimeline,
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

// ---------------------------------------------------------------------------------------------
// Commit timeline fetch (issue #56): fetchPullRequestCommitShas, fetchCommitWithFiles, and the
// fetchPullRequestCommitTimeline orchestrator. Same hermetic discipline as the rest of this file —
// only the injected `runGhImpl` fake is exercised, never a real `gh` process.
// ---------------------------------------------------------------------------------------------

test("fetchPullRequestCommitShas returns the sha of every commit gh reports, in the given order", () => {
  const fakeRunGh = () =>
    JSON.stringify([{ sha: "aaa1111" }, { sha: "bbb2222" }, { sha: "ccc3333" }]);
  const shas = fetchPullRequestCommitShas("owner", "repo", 42, fakeRunGh);
  assert.deepEqual(shas, ["aaa1111", "bbb2222", "ccc3333"]);
});

test("fetchPullRequestCommitShas requests the pull-request-commits endpoint with pagination", () => {
  let capturedArgs;
  const fakeRunGh = (args) => {
    capturedArgs = args;
    return "[]";
  };
  fetchPullRequestCommitShas("owner", "repo", 42, fakeRunGh);
  assert.ok(capturedArgs.includes("repos/owner/repo/pulls/42/commits"));
  assert.ok(capturedArgs.includes("--paginate"));
});

test("fetchPullRequestCommitShas does not throw when the reported commit count reaches the documented cap", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ sha: `sha-${String(i)}` }));
  const shas = fetchPullRequestCommitShas("owner", "repo", 42, () => JSON.stringify(many));
  assert.equal(shas.length, 250, "still returns everything gh reported, warning aside");
});

function restCommitFixture({
  sha = "abc123",
  committerDate = "2026-08-02T12:00:00Z",
  authorDate = null,
  files = [{ filename: "a.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" }],
}) {
  return {
    sha,
    commit: {
      committer: committerDate === null ? undefined : { date: committerDate },
      author: authorDate === null ? undefined : { date: authorDate },
    },
    files,
  };
}

test("fetchCommitWithFiles normalizes GitHub's REST file shape into the camelCase shape arena-lib.mjs reads", () => {
  const fixture = restCommitFixture({
    files: [
      {
        filename: "new.ts",
        previous_filename: "old.ts",
        status: "renamed",
        patch: "@@ -1,1 +1,1 @@\n",
      },
      { filename: "b.ts", status: "removed" },
    ],
  });
  const commit = fetchCommitWithFiles("owner", "repo", "abc123", () => JSON.stringify(fixture));
  assert.equal(commit.sha, "abc123");
  assert.equal(commit.committedDate, "2026-08-02T12:00:00Z");
  assert.deepEqual(commit.files, [
    { path: "new.ts", previousPath: "old.ts", status: "renamed", patch: "@@ -1,1 +1,1 @@\n" },
    { path: "b.ts", previousPath: null, status: "removed", patch: null },
  ]);
});

test("fetchCommitWithFiles falls back to the author date when the committer date is absent", () => {
  const fixture = restCommitFixture({ committerDate: null, authorDate: "2026-08-02T09:00:00Z" });
  const commit = fetchCommitWithFiles("owner", "repo", "abc123", () => JSON.stringify(fixture));
  assert.equal(commit.committedDate, "2026-08-02T09:00:00Z");
});

test("fetchCommitWithFiles reports an empty file list, not a crash, when GitHub omits files entirely", () => {
  const fixture = restCommitFixture({});
  delete fixture.files;
  const commit = fetchCommitWithFiles("owner", "repo", "abc123", () => JSON.stringify(fixture));
  assert.deepEqual(commit.files, []);
});

test("fetchCommitWithFiles requests the single-commit endpoint for the given sha", () => {
  let capturedArgs;
  const fakeRunGh = (args) => {
    capturedArgs = args;
    return JSON.stringify(restCommitFixture({}));
  };
  fetchCommitWithFiles("owner", "repo", "deadbeef", fakeRunGh);
  assert.ok(capturedArgs.includes("repos/owner/repo/commits/deadbeef"));
});

test("fetchPullRequestCommitTimeline fetches the list once, then one call per commit, and sorts by committed date", () => {
  const calls = [];
  const fakeRunGh = (args) => {
    calls.push(args);
    if (args[1] === "repos/owner/repo/pulls/7/commits") {
      return JSON.stringify([{ sha: "later" }, { sha: "earlier" }]);
    }
    if (args[1] === "repos/owner/repo/commits/later") {
      return JSON.stringify(
        restCommitFixture({ sha: "later", committerDate: "2026-08-02T18:00:00Z" }),
      );
    }
    if (args[1] === "repos/owner/repo/commits/earlier") {
      return JSON.stringify(
        restCommitFixture({ sha: "earlier", committerDate: "2026-08-02T09:00:00Z" }),
      );
    }
    throw new Error(`unexpected args: ${JSON.stringify(args)}`);
  };
  const commits = fetchPullRequestCommitTimeline("owner", "repo", 7, fakeRunGh);
  assert.equal(calls.length, 3, "one list call plus one call per commit");
  assert.deepEqual(
    commits.map((c) => c.sha),
    ["earlier", "later"],
    "sorted chronologically regardless of the order gh listed them in",
  );
});

test("fetchPullRequestCommitTimeline breaks a tie on identical committed dates by sha", () => {
  const fakeRunGh = (args) => {
    if (args[1] === "repos/owner/repo/pulls/7/commits") {
      return JSON.stringify([{ sha: "zzz" }, { sha: "aaa" }]);
    }
    return JSON.stringify(
      restCommitFixture({ sha: args[1].split("/").pop(), committerDate: "2026-08-02T12:00:00Z" }),
    );
  };
  const commits = fetchPullRequestCommitTimeline("owner", "repo", 7, fakeRunGh);
  assert.deepEqual(
    commits.map((c) => c.sha),
    ["aaa", "zzz"],
  );
});
