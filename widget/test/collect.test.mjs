import { test } from "node:test";
import assert from "node:assert/strict";

import { collectCardData as collectCardDataWithBudget } from "../src/collect.ts";
import { createGitHubRequestBudget } from "../src/request-budget.ts";

/**
 * The collector's contract is "render what you know": every assertion here is either a counting
 * rule or a degradation rule. The fake fetch maps URL substrings to canned bodies; anything
 * unmatched is a 500, which doubles as the failure fixture.
 *
 * Fixture shapes that are load-bearing, all measured live against oscharko-dev/Keiko: runs are
 * served per workflow (the flat listing undercounts on a busy repository), GraphQL thread authors
 * carry no "[bot]" suffix, and first-comment timestamps — not pull-request update dates — decide
 * whether a finding belongs to the exact rolling window.
 */

const NOW = Date.parse("2026-08-08T12:00:00Z");
const CUTOFF = "2026-07-09T12:00:00.000Z";
const BEFORE_CUTOFF = "2026-07-09T11:59:59.999Z";
const RECENT = "2026-08-07T12:00:00Z";
const OLDER = "2026-08-01T00:00:00Z";
const FUTURE = "2026-08-08T12:00:00.001Z";
const BOT = "keiko-for-quality";
let nextThreadId = 1;

function collectCardData(owner, repo, token, fetchImpl, nowMs) {
  return collectCardDataWithBudget(owner, repo, token, createGitHubRequestBudget(fetchImpl), nowMs);
}

function fakeFetch(routes) {
  return async (url, init) => {
    const requestUrl = String(url);
    const key = Object.keys(routes).find((candidate) => requestUrl.includes(candidate));
    if (key === undefined) return new Response("boom", { status: 500 });
    const body = routes[key];
    const value = typeof body === "function" ? body(requestUrl, init) : body;
    return new Response(JSON.stringify(completeGitHubFixture(requestUrl, value)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function completeGitHubFixture(url, value) {
  if (url.includes("/actions/workflows?") && Array.isArray(value.workflows)) {
    return { total_count: value.workflows.length, ...value };
  }
  if (!url.includes("/actions/workflows/") || !url.includes("/runs?")) return value;
  if (!Array.isArray(value.workflow_runs)) return value;
  const request = new URL(url);
  const [start, end] = request.searchParams.get("created")?.split("..") ?? [];
  const startMs = Date.parse(start ?? "");
  const endMs = Date.parse(end ?? "");
  const all = value.workflow_runs
    .map((run, index) => ({ id: run.id ?? index + 1, ...run }))
    .filter((run) => {
      const createdMs = Date.parse(run.created_at ?? "");
      return Number.isFinite(createdMs) && createdMs >= startMs && createdMs <= endMs;
    });
  const page = Number(request.searchParams.get("page") ?? "1");
  const offset = (page - 1) * 100;
  return {
    ...value,
    total_count: value.total_count ?? all.length,
    workflow_runs: value.total_count === undefined ? all.slice(offset, offset + 100) : all,
  };
}

function createdRangeContains(url, timestamp) {
  const [start, end] = new URL(url).searchParams.get("created")?.split("..") ?? [];
  const value = Date.parse(timestamp);
  return value >= Date.parse(start ?? "") && value <= Date.parse(end ?? "");
}

const REVIEW_WORKFLOWS = {
  total_count: 3,
  workflows: [
    { id: 11, path: ".github/workflows/keiko-for-quality.yml" },
    { id: 12, path: ".github/workflows/self-review.yml" },
    { id: 99, path: ".github/workflows/ci.yml" },
  ],
};

function thread(author, resolved, body = "finding", createdAt = RECENT) {
  return {
    id: `THREAD_${String(nextThreadId++)}`,
    isResolved: resolved,
    comments: { nodes: [{ author: { login: author }, body, createdAt }] },
  };
}

function searchPage(threadLists, options = {}) {
  const {
    hasNext = false,
    cursor = null,
    numbers = [],
    issueCount = threadLists.length,
    threadTotals = [],
  } = options;
  return {
    data: {
      search: {
        issueCount,
        pageInfo: { hasNextPage: hasNext, endCursor: cursor },
        nodes: threadLists.map((nodes, index) => ({
          number: numbers[index] ?? index + 1,
          reviewThreads: {
            totalCount: threadTotals[index] ?? nodes.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        })),
      },
    },
  };
}

test("counts exact-window runs and reports workflow status, never review settlement", async () => {
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
  assert.equal(data.runSuccessPct, 50);
  assert.equal(data.runStatus, "ok");
  assert.equal(Math.round(data.lastRunHours), 24);
  assert.equal("outcome" in data, false);
});

test("the newest run decides RUN NOT OK across workflows", async () => {
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
  assert.equal(data.runStatus, "not_ok");
  assert.equal(data.runSuccessPct, 50);
});

test("workflow runs use complete non-overlapping partitions across the exact window", async () => {
  const ranges = [];
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": {
        workflows: [{ id: 11, path: ".github/workflows/self-review.yml" }],
      },
      "/actions/workflows/11/runs": (url) => {
        ranges.push(new URL(url).searchParams.get("created"));
        return {
          workflow_runs: [{ status: "completed", conclusion: "success", created_at: RECENT }],
        };
      },
      graphql: searchPage([]),
    }),
    NOW,
  );
  assert.equal(data.runs30d, 1);
  assert.equal(ranges.length, 5);
  assert.equal(ranges[0].split("..")[0], CUTOFF);
  assert.equal(ranges.at(-1).split("..")[1], new Date(NOW).toISOString());
  for (let index = 1; index < ranges.length; index += 1) {
    const previousEnd = Date.parse(ranges[index - 1].split("..")[1]);
    const nextStart = Date.parse(ranges[index].split("..")[0]);
    assert.equal(nextStart, previousEnd + 1_000);
  }
});

test("full timestamps enforce both edges of the exact rolling run and finding window", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": {
        workflows: [{ id: 11, path: ".github/workflows/keiko-for-quality.yml" }],
      },
      "/actions/workflows/11/runs": {
        workflow_runs: [
          { status: "completed", conclusion: "success", created_at: CUTOFF },
          { status: "completed", conclusion: "failure", created_at: BEFORE_CUTOFF },
          { status: "completed", conclusion: "failure", created_at: FUTURE },
        ],
      },
      graphql: searchPage([
        [
          thread(BOT, true, "at the boundary", CUTOFF),
          thread(BOT, false, "too old", BEFORE_CUTOFF),
          thread(BOT, false, "from the future", FUTURE),
          thread(BOT, false, "inside", RECENT),
        ],
      ]),
    }),
    NOW,
  );
  assert.equal(data.runs30d, 1);
  assert.equal(data.runSuccessPct, 100);
  assert.equal(data.runStatus, "ok");
  assert.equal(data.findings, 2);
  assert.equal(data.resolvedPct, 50);
  assert.equal(data.openThreads, 1);
  assert.equal(data.prsWithFindings, 1);
});

test("findings exclude other authors and coverage stubs and report only resolution", async () => {
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
          thread(
            BOT,
            true,
            "**This change was not fully reviewed.**\n\n" +
              "Keiko for Quality could not complete its review. Reason code: `coverage_gap`.",
          ),
        ],
        [thread(BOT, false), thread(BOT, false)],
      ]),
    }),
    NOW,
  );
  assert.equal(data.findings, 4);
  assert.equal(data.resolvedPct, 25);
  assert.equal(data.openThreads, 3);
  assert.equal(data.prsWithFindings, 2);
  assert.equal("actedOnPct" in data, false);
});

test("ordinary finding prose cannot collide with the fixed incomplete-review notice", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: searchPage([
        [thread(BOT, false, "The fallback branch was not fully reviewed before this change.")],
      ]),
    }),
    NOW,
  );
  assert.equal(data.findings, 1);
  assert.equal(data.openThreads, 1);
});

test("zero findings produces exact zero counts but no denominator-free percentage", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: searchPage([[thread("human", true)]]),
    }),
    NOW,
  );
  assert.equal(data.findings, 0);
  assert.equal(data.openThreads, 0);
  assert.equal(data.prsWithFindings, 0);
  assert.equal(data.resolvedPct, undefined);
});

test("search pagination follows the cursor across the whole candidate window", async () => {
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
          ? searchPage([[thread(BOT, true)]], {
              hasNext: true,
              cursor: "C1",
              numbers: [7],
              issueCount: 2,
            })
          : searchPage([[thread(BOT, false)]], { numbers: [8], issueCount: 2 });
      },
    }),
    NOW,
  );
  assert.deepEqual(cursors, [null, "C1"]);
  assert.equal(data.findings, 2);
  assert.equal(data.resolvedPct, 50);
  assert.equal(data.prsWithFindings, 2);
});

test("a partial GraphQL population cannot publish a plausible findings floor", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: searchPage([[thread(BOT, true)]], { issueCount: 2, numbers: [7] }),
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.openThreads, undefined);
  assert.equal(data.prsWithFindings, undefined);
});

test("duplicate pull requests across search pages make every finding metric unknown", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: (url, init) => {
        const { after } = JSON.parse(init.body).variables;
        return after === null
          ? searchPage([[thread(BOT, true)]], {
              hasNext: true,
              cursor: "C1",
              issueCount: 2,
              numbers: [7],
            })
          : searchPage([[thread(BOT, false)]], { issueCount: 2, numbers: [7] });
      },
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.resolvedPct, undefined);
});

test("candidate discovery includes the exact UTC day boundary", async () => {
  let query;
  await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: (url, init) => {
        query = JSON.parse(init.body).variables.q;
        return searchPage([]);
      },
    }),
    NOW,
  );
  assert.match(query, /updated:>=2026-07-09(?:\s|$)/u);
});

test("a partial GraphQL response with errors cannot publish metrics", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: {
        ...searchPage([[thread(BOT, true)]]),
        errors: [{ message: "partial" }],
      },
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.openThreads, undefined);
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
                    totalCount: 2,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [thread(BOT, false)],
                  },
                },
              },
            },
          };
        }
        const page = searchPage([[thread(BOT, true)]], {
          numbers: [7],
          threadTotals: [2],
        });
        page.data.search.nodes[0].reviewThreads.pageInfo = {
          hasNextPage: true,
          endCursor: "T1",
        };
        return page;
      },
    }),
    NOW,
  );
  assert.deepEqual(calls, [[7, "T1"]]);
  assert.equal(data.findings, 2);
  assert.equal(data.resolvedPct, 50);
  assert.equal(data.openThreads, 1);
  assert.equal(data.prsWithFindings, 1);
});

test("thread collection requests ids and total counts on search and overflow pages", async () => {
  const queries = [];
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: (url, init) => {
        const { query } = JSON.parse(init.body);
        queries.push(query);
        if (query.includes("pullRequest(number")) {
          return {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    totalCount: 2,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [thread(BOT, false)],
                  },
                },
              },
            },
          };
        }
        const page = searchPage([[thread(BOT, true)]], { threadTotals: [2] });
        page.data.search.nodes[0].reviewThreads.pageInfo = {
          hasNextPage: true,
          endCursor: "T1",
        };
        return page;
      },
    }),
    NOW,
  );
  assert.equal(data.findings, 2);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(query, /reviewThreads\([^)]*\)\{totalCount pageInfo/u);
    assert.match(query, /nodes\{id isResolved/u);
  }
});

test("a changed review-thread total across overflow pages makes findings unknown", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: (url, init) => {
        const { query } = JSON.parse(init.body);
        if (query.includes("pullRequest(number")) {
          return {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    totalCount: 3,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [thread(BOT, false)],
                  },
                },
              },
            },
          };
        }
        const page = searchPage([[thread(BOT, true)]], { threadTotals: [2] });
        page.data.search.nodes[0].reviewThreads.pageInfo = {
          hasNextPage: true,
          endCursor: "T1",
        };
        return page;
      },
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.resolvedPct, undefined);
  assert.equal(data.openThreads, undefined);
});

test("a duplicate review-thread id across pages makes findings unknown", async () => {
  const duplicate = "THREAD_DUPLICATE";
  const first = { ...thread(BOT, true), id: duplicate };
  const second = { ...thread(BOT, false), id: duplicate };
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: (url, init) => {
        const { query } = JSON.parse(init.body);
        if (query.includes("pullRequest(number")) {
          return {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    totalCount: 2,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [second],
                  },
                },
              },
            },
          };
        }
        const page = searchPage([[first]], { threadTotals: [2] });
        page.data.search.nodes[0].reviewThreads.pageInfo = {
          hasNextPage: true,
          endCursor: "T1",
        };
        return page;
      },
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.openThreads, undefined);
});

test("a terminal review-thread page must exactly match totalCount", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: searchPage([[thread(BOT, true)]], { threadTotals: [2] }),
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.prsWithFindings, undefined);
});

test("workflow discovery pages instead of silently sampling the first hundred", async () => {
  const pages = [];
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": (url) => {
        const page = new URL(url).searchParams.get("page");
        pages.push(page);
        return page === "1"
          ? {
              total_count: 101,
              workflows: Array.from({ length: 100 }, (_, index) => ({
                id: index + 100,
                path: `.github/workflows/ci-${String(index)}.yml`,
              })),
            }
          : {
              total_count: 101,
              workflows: [{ id: 11, path: ".github/workflows/self-review.yml" }],
            };
      },
      "/actions/workflows/11/runs": {
        workflow_runs: [{ status: "completed", conclusion: "success", created_at: RECENT }],
      },
      graphql: searchPage([]),
    }),
    NOW,
  );
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(data.runs30d, 1);
});

test("a malformed workflow descriptor makes only run metrics unknown", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [{ id: 11 }] },
      graphql: searchPage([[thread(BOT, false)]]),
    }),
    NOW,
  );
  assert.equal(data.runs30d, undefined);
  assert.equal(data.runSuccessPct, undefined);
  assert.equal(data.runStatus, undefined);
  assert.equal(data.findings, 1);
});

test("invalid workflow ids and paths cannot be silently classified as non-review workflows", async () => {
  for (const workflow of [
    null,
    { id: 0, path: ".github/workflows/ci.yml" },
    { id: 11, path: "" },
    { id: 11, path: "  " },
    { id: 11, path: 42 },
    { id: 11, path: ".github/workflows/ci.yml\u0000hidden" },
  ]) {
    const data = await collectCardData(
      "o",
      "r",
      "tok",
      fakeFetch({
        "/actions/workflows?": { workflows: [workflow] },
        graphql: searchPage([]),
      }),
      NOW,
    );
    assert.equal(data.runs30d, undefined);
  }
});

test("a window that outruns the search safety ceiling drops all finding metrics", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: () =>
        searchPage([[thread(BOT, true)]], { hasNext: true, cursor: "MORE", numbers: [7] }),
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.resolvedPct, undefined);
  assert.equal(data.openThreads, undefined);
  assert.equal(data.prsWithFindings, undefined);
});

test("GitHub's thousand-result search cap degrades to unknown instead of a sample", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: () => searchPage([[thread(BOT, true)]], { issueCount: 1_001 }),
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.openThreads, undefined);
});

test("a malformed bot thread drops all finding metrics instead of lowering the count", async () => {
  const malformed = {
    id: `THREAD_${String(nextThreadId++)}`,
    isResolved: true,
    comments: { nodes: [{ author: { login: BOT } }] },
  };
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": { workflows: [] },
      graphql: searchPage([[thread(BOT, true), malformed]]),
    }),
    NOW,
  );
  assert.equal(data.findings, undefined);
  assert.equal(data.openThreads, undefined);
});

test("a run window that outruns the pagination ceiling drops every run metric", async () => {
  const fullPage = {
    total_count: 1_000,
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
      "/actions/workflows?": {
        workflows: [{ id: 11, path: ".github/workflows/keiko-for-quality.yml" }],
      },
      "/actions/workflows/11/runs": fullPage,
      graphql: searchPage([]),
    }),
    NOW,
  );
  assert.equal(data.runs30d, undefined);
  assert.equal(data.runSuccessPct, undefined);
  assert.equal(data.runStatus, undefined);
});

test("a full run page requests the next one, a short page stops", async () => {
  const pages = [];
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": {
        workflows: [{ id: 11, path: ".github/workflows/keiko-for-quality.yml" }],
      },
      "/actions/workflows/11/runs": (url) => {
        if (!createdRangeContains(url, RECENT)) return { total_count: 0, workflow_runs: [] };
        const page = new URL(url).searchParams.get("page");
        pages.push(page);
        if (page === "1") {
          return {
            total_count: 101,
            workflow_runs: Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              status: "completed",
              conclusion: "success",
              created_at: RECENT,
            })),
          };
        }
        return {
          total_count: 101,
          workflow_runs: [
            { id: 101, status: "completed", conclusion: "success", created_at: RECENT },
          ],
        };
      },
      graphql: searchPage([]),
    }),
    NOW,
  );
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(data.runs30d, 101);
  assert.equal(data.runSuccessPct, 100);
});

test("malformed counted run data drops run metrics but preserves finding metrics", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": {
        workflows: [{ id: 11, path: ".github/workflows/self-review.yml" }],
      },
      "/actions/workflows/11/runs": {
        workflow_runs: [{ status: "completed", created_at: RECENT }],
      },
      graphql: searchPage([[thread(BOT, false)]]),
    }),
    NOW,
  );
  assert.equal(data.runs30d, undefined);
  assert.equal(data.findings, 1);
  assert.equal(data.openThreads, 1);
});

test("malformed workflow-run fields make run metrics unknown", async () => {
  for (const run of [
    { conclusion: null, created_at: RECENT },
    { id: 0, status: "completed", conclusion: "success", created_at: RECENT },
    { status: "compleetd", conclusion: "success", created_at: RECENT },
    { status: "completed", conclusion: "mystery", created_at: RECENT },
    { status: "in_progress", conclusion: "success", created_at: RECENT },
  ]) {
    const data = await collectCardData(
      "o",
      "r",
      "tok",
      fakeFetch({
        "/actions/workflows?": {
          workflows: [{ id: 11, path: ".github/workflows/self-review.yml" }],
        },
        "/actions/workflows/11/runs": { workflow_runs: [run] },
        graphql: searchPage([[thread(BOT, false)]]),
      }),
      NOW,
    );
    assert.equal(data.runs30d, undefined);
    assert.equal(data.runStatus, undefined);
    assert.equal(data.findings, 1);
  }
});

test("non-canonical workflow-run timestamps make run metrics unknown", async () => {
  const data = await collectCardData(
    "o",
    "r",
    "tok",
    fakeFetch({
      "/actions/workflows?": {
        workflows: [{ id: 11, path: ".github/workflows/self-review.yml" }],
      },
      "/actions/workflows/11/runs": {
        workflow_runs: [
          { status: "completed", conclusion: "success", created_at: "2026-08-07 12:00:00Z" },
        ],
      },
      graphql: searchPage([]),
    }),
    NOW,
  );
  assert.equal(data.runs30d, undefined);
  assert.equal(data.runSuccessPct, undefined);
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
