import { test } from "node:test";
import assert from "node:assert/strict";

import { collectCardData } from "../src/collect.ts";

/**
 * The collector's contract is "render what you know": every assertion here is either a counting
 * rule (which runs and threads belong to the reviewer) or a degradation rule (a failed endpoint —
 * or a window that outruns a safety ceiling — leaves its metric undefined instead of inventing a
 * number). The fake fetch maps URL substrings to canned bodies; anything unmatched is a 500,
 * which doubles as the failure fixture.
 *
 * Fixture shapes that are load-bearing, all measured live against oscharko-dev/Keiko: runs are
 * served per-workflow (the flat listing undercounts on a busy repository), GraphQL thread
 * authors carry NO "[bot]" suffix, and findings/acted-on pages through GraphQL search over the
 * whole window rather than sampling recent pull requests.
 */

const NOW = Date.parse("2026-08-08T12:00:00Z");
const RECENT = "2026-08-07T12:00:00Z";
const OLDER = "2026-08-01T00:00:00Z";
const BOT = "keiko-for-quality";

function fakeFetch(routes) {
  return async (url, init) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (key === undefined) return new Response("boom", { status: 500 });
    const body = routes[key];
    const value = typeof body === "function" ? body(String(url), init) : body;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const REVIEW_WORKFLOWS = {
  workflows: [
    { id: 11, path: ".github/workflows/keiko-for-quality.yml" },
    { id: 12, path: ".github/workflows/self-review.yml" },
    { id: 99, path: ".github/workflows/ci.yml" },
  ],
};

function thread(author, resolved, body = "finding") {
  return { isResolved: resolved, comments: { nodes: [{ author: { login: author }, body }] } };
}

function searchPage(threadLists, hasNext = false, cursor = null) {
  return {
    data: {
      search: {
        pageInfo: { hasNextPage: hasNext, endCursor: cursor },
        nodes: threadLists.map((nodes) => ({ reviewThreads: { nodes } })),
      },
    },
  };
}

test("counts runs per review workflow and reads outcome from the newest", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": REVIEW_WORKFLOWS,
      "/actions/workflows/11/runs": {
        workflow_runs: [
          { status: "completed", conclusion: "success", created_at: RECENT },
          { status: "in_progress", conclusion: null, created_at: RECENT },
          { status: "completed", conclusion: "skipped", created_at: RECENT },
          { status: "completed", conclusion: "cancelled", created_at: RECENT },
        ],
      },
      "/actions/workflows/12/runs": {
        workflow_runs: [{ status: "completed", conclusion: "failure", created_at: OLDER }],
      },
      graphql: searchPage([]),
    }),
    NOW,
  );
  // ci.yml (id 99) is never queried: its route is absent and would 500 the whole stat.
  assert.equal(data.runs30d, 2);
  assert.equal(data.outcome, "complete");
  assert.equal(Math.round(data.lastRunHours), 24);
});

test("the newest run decides the outcome across workflows", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": REVIEW_WORKFLOWS,
      "/actions/workflows/11/runs": {
        workflow_runs: [{ status: "completed", conclusion: "success", created_at: OLDER }],
      },
      "/actions/workflows/12/runs": {
        workflow_runs: [{ status: "completed", conclusion: "failure", created_at: RECENT }],
      },
      graphql: searchPage([]),
    }),
    NOW,
  );
  assert.equal(data.outcome, "incomplete");
});

test("findings count the bot's threads without coverage stubs; actedOn is their resolved share", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: searchPage([
        [
          thread(BOT, true),
          thread(BOT, false),
          thread("human", true),
          thread(BOT, true, "this file was not fully reviewed"),
        ],
        [thread(BOT, false), thread(BOT, false)],
      ]),
    }),
    NOW,
  );
  assert.equal(data.findings, 4);
  assert.equal(data.actedOnPct, 25);
});

test("search pagination follows the cursor across the whole window", async () => {
  const cursors = [];
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: (url, init) => {
        const vars = JSON.parse(init.body).variables;
        cursors.push(vars.after);
        return vars.after === null
          ? searchPage([[thread(BOT, true)]], true, "C1")
          : searchPage([[thread(BOT, false)]]);
      },
    }),
    NOW,
  );
  assert.deepEqual(cursors, [null, "C1"]);
  assert.equal(data.findings, 2);
  assert.equal(data.actedOnPct, 50);
});

test("a thread-heavy pull request's overflow pages are followed to the end", async () => {
  const calls = [];
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: (url, init) => {
        const { query, variables } = JSON.parse(init.body);
        if (query.includes("pullRequest(number")) {
          calls.push([variables.n, variables.after]);
          return {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [thread(BOT, false)],
                  },
                },
              },
            },
          };
        }
        const page = searchPage([[thread(BOT, true)]]);
        const pr = page.data.search.nodes[0];
        pr.number = 7;
        pr.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "T1" };
        return page;
      },
    }),
    NOW,
  );
  assert.deepEqual(calls, [[7, "T1"]]);
  assert.equal(data.findings, 2);
  assert.equal(data.actedOnPct, 50);
});

test("a window that outruns the search safety ceiling drops the metric, never a floor", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: () => searchPage([[thread(BOT, true)]], true, "MORE"),
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.actedOnPct, undefined);
});

test("a run window that outruns the pagination ceiling drops the run metrics too", async () => {
  const fullPage = {
    workflow_runs: Array.from({ length: 100 }, () => ({
      status: "completed",
      conclusion: "success",
      created_at: RECENT,
    })),
  };
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [{ id: 11, path: "keiko-for-quality.yml" }] },
      "/actions/workflows/11/runs": fullPage,
      graphql: searchPage([]),
    }),
    NOW,
  );
  assert.equal(data.runs30d, undefined);
  assert.equal(data.outcome, undefined);
});

test("a full page requests the next one, a short page stops", async () => {
  const pages = [];
  const fullPage = {
    workflow_runs: Array.from({ length: 100 }, () => ({
      status: "completed",
      conclusion: "success",
      created_at: RECENT,
    })),
  };
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [{ id: 11, path: "keiko-for-quality.yml" }] },
      "/actions/workflows/11/runs": (url) => {
        pages.push(new URL(url).searchParams.get("page"));
        return pages.length < 2 ? fullPage : { workflow_runs: [] };
      },
      graphql: searchPage([]),
    }),
    NOW,
  );
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(data.runs30d, 100);
});

test("every endpoint failing leaves every metric undefined", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    async () => new Response("no", { status: 500 }),
    NOW,
  );
  assert.deepEqual(data, { owner: "o", repo: "r" });
});

test("a throwing fetch degrades the same way", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    async () => {
      throw new Error("network down");
    },
    NOW,
  );
  assert.deepEqual(data, { owner: "o", repo: "r" });
});
