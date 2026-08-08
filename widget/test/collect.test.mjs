import { test } from "node:test";
import assert from "node:assert/strict";

import { collectCardData } from "../src/collect.ts";

/**
 * The collector's contract is "render what you know": every assertion here is either a counting
 * rule (which runs, comments and threads belong to the reviewer) or a degradation rule (a failed
 * endpoint leaves its metric undefined instead of inventing a zero). The fake fetch maps URL
 * substrings to canned bodies; anything unmatched is a 500, which doubles as the failure fixture.
 *
 * Two fixture shapes are load-bearing, both measured live against oscharko-dev/Keiko:
 * runs are served per-workflow (`/actions/workflows/<id>/runs`), because the flat runs listing
 * undercounts on a busy repository; and GraphQL thread authors carry NO "[bot]" suffix, while
 * REST review-comment users DO.
 */

const NOW = Date.parse("2026-08-08T12:00:00Z");
const RECENT = "2026-08-07T12:00:00Z";
const OLDER = "2026-08-01T00:00:00Z";
const STALE = "2026-05-01T00:00:00Z";
const BOT_REST = "keiko-for-quality[bot]";
const BOT_GRAPHQL = "keiko-for-quality";

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

function threadsReply(nodes) {
  return { data: { repository: { pullRequest: { reviewThreads: { nodes } } } } };
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
      "/pulls?": [],
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
      "/pulls?": [],
    }),
    NOW,
  );
  assert.equal(data.outcome, "incomplete");
});

test("findings count the bot's REST comments without coverage stubs; actedOn uses GraphQL logins", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      "/pulls?": [
        { number: 7, updated_at: RECENT },
        { number: 6, updated_at: STALE },
      ],
      "/pulls/7/comments": [
        { user: { login: BOT_REST }, body: "**TESTS · MAJOR** finding" },
        { user: { login: BOT_REST }, body: "this file was not fully reviewed" },
        { user: { login: "human" }, body: "reply" },
      ],
      graphql: threadsReply([
        {
          isResolved: true,
          comments: { nodes: [{ author: { login: BOT_GRAPHQL }, body: "finding" }] },
        },
        {
          isResolved: false,
          comments: { nodes: [{ author: { login: BOT_GRAPHQL }, body: "finding" }] },
        },
        { isResolved: true, comments: { nodes: [{ author: { login: "human" }, body: "chat" }] } },
        {
          isResolved: true,
          comments: { nodes: [{ author: { login: BOT_GRAPHQL }, body: "was not fully reviewed" }] },
        },
      ]),
    }),
    NOW,
  );
  assert.equal(data.findings, 1);
  assert.equal(data.actedOnPct, 50);
});

test("stale pull requests are outside the window entirely", async () => {
  const calls = [];
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      "/pulls?": [{ number: 6, updated_at: STALE }],
      "/pulls/6/comments": (url) => {
        calls.push(url);
        return [];
      },
    }),
    NOW,
  );
  assert.equal(calls.length, 0);
  assert.equal(data.findings, 0);
  assert.equal(data.actedOnPct, undefined);
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

test("graphql failure keeps findings but drops actedOn", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      "/pulls?": [{ number: 7, updated_at: RECENT }],
      "/pulls/7/comments": [{ user: { login: BOT_REST }, body: "finding" }],
    }),
    NOW,
  );
  assert.equal(data.findings, 1);
  assert.equal(data.actedOnPct, undefined);
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
      "/pulls?": [],
    }),
    NOW,
  );
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(data.runs30d, 100);
});
