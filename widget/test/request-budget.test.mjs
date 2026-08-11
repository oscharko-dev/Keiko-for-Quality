import { test } from "node:test";
import assert from "node:assert/strict";

import { createGitHubRequestBudget, MAX_GITHUB_REQUESTS } from "../src/request-budget.ts";

test("concurrent callers can never execute more than fifty GitHub requests", async () => {
  let executed = 0;
  const requests = createGitHubRequestBudget(async () => {
    executed += 1;
    return Response.json({});
  });
  const attempts = Array.from({ length: MAX_GITHUB_REQUESTS + 20 }, () =>
    requests.fetch("https://api.github.com"),
  );
  const results = await Promise.allSettled(attempts);
  assert.equal(executed, MAX_GITHUB_REQUESTS);
  assert.equal(requests.used, MAX_GITHUB_REQUESTS);
  assert.equal(requests.exhausted, true);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    MAX_GITHUB_REQUESTS,
  );
});

test("exactly fifty completed requests are admissible until another request is attempted", async () => {
  const requests = createGitHubRequestBudget(async () => Response.json({}));
  for (let index = 0; index < MAX_GITHUB_REQUESTS; index += 1) {
    assert.equal((await requests.fetch("https://api.github.com")).ok, true);
  }
  assert.equal(requests.exhausted, false);
  await assert.rejects(requests.fetch("https://api.github.com"), /budget exhausted/u);
  assert.equal(requests.exhausted, true);
  assert.equal(requests.used, MAX_GITHUB_REQUESTS);
});
