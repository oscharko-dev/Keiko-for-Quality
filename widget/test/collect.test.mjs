import { test } from "node:test";
import assert from "node:assert/strict";

import { collectCardData } from "../src/collect.ts";

/**
 * The collector's contract is "render what you know": every assertion here is either a counting
 * rule (which runs, comments and threads belong to the reviewer) or a degradation rule (a failed
 * endpoint leaves its metric undefined instead of inventing a zero). The fake fetch maps URL
 * substrings to canned bodies; anything unmatched is a 500, which doubles as the failure fixture.
 */

const NOW = Date.parse("2026-08-08T12:00:00Z");
const RECENT = "2026-08-07T12:00:00Z";
const STALE = "2026-05-01T00:00:00Z";
const BOT = "keiko-for-quality[bot]";

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

function threadsReply(nodes) {
  return { data: { repository: { pullRequest: { reviewThreads: { nodes } } } } };
}

test("counts review-workflow runs and reads outcome from the newest", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/runs": {
        workflow_runs: [
          {
            path: ".github/workflows/keiko-for-quality.yml",
            status: "completed",
            conclusion: "success",
            created_at: RECENT,
          },
          {
            path: ".github/workflows/self-review.yml",
            status: "completed",
            conclusion: "failure",
            created_at: STALE,
          },
          {
            path: ".github/workflows/ci.yml",
            status: "completed",
            conclusion: "success",
            created_at: RECENT,
          },
          {
            path: ".github/workflows/keiko-for-quality.yml",
            status: "in_progress",
            conclusion: null,
            created_at: RECENT,
          },
        ],
      },
      "/pulls?": [],
    }),
    NOW,
  );
  assert.equal(data.runs30d, 2);
  assert.equal(data.outcome, "complete");
  assert.equal(Math.round(data.lastRunHours), 24);
});

test("a red newest run reads incomplete", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/runs": {
        workflow_runs: [
          {
            path: ".github/workflows/keiko-for-quality.yml",
            status: "completed",
            conclusion: "failure",
            created_at: RECENT,
          },
        ],
      },
      "/pulls?": [],
    }),
    NOW,
  );
  assert.equal(data.outcome, "incomplete");
});

test("findings count the bot's comments without coverage stubs; actedOn is the resolved share", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/runs": { workflow_runs: [] },
      "/pulls?": [
        { number: 7, updated_at: RECENT },
        { number: 6, updated_at: STALE },
      ],
      "/pulls/7/comments": [
        { user: { login: BOT }, body: "**TESTS · MAJOR** finding" },
        { user: { login: BOT }, body: "this file was not fully reviewed" },
        { user: { login: "human" }, body: "reply" },
      ],
      graphql: threadsReply([
        { isResolved: true, comments: { nodes: [{ author: { login: BOT }, body: "finding" }] } },
        { isResolved: false, comments: { nodes: [{ author: { login: BOT }, body: "finding" }] } },
        { isResolved: true, comments: { nodes: [{ author: { login: "human" }, body: "chat" }] } },
        {
          isResolved: true,
          comments: { nodes: [{ author: { login: BOT }, body: "was not fully reviewed" }] },
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
      "/actions/runs": { workflow_runs: [] },
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
      "/actions/runs": { workflow_runs: [] },
      "/pulls?": [{ number: 7, updated_at: RECENT }],
      "/pulls/7/comments": [{ user: { login: BOT }, body: "finding" }],
    }),
    NOW,
  );
  assert.equal(data.findings, 1);
  assert.equal(data.actedOnPct, undefined);
});
