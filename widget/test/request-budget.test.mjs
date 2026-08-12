import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("the scheduled renderer gives evidence only the repository budget remainder", () => {
  const source = readFileSync(new URL("../scripts/render-card.mjs", import.meta.url), "utf8");
  const collection = source.indexOf("await collectCardData(owner, repo, token, requests, nowMs)");
  const evidence = source.indexOf("await loadReleasedQualityEvidence(token, requests.fetch)");
  assert(collection >= 0, "repository collection must use the shared request budget");
  assert(evidence > collection, "released evidence must run after repository collection");
  assert.doesNotMatch(source, /loadReleasedQualityEvidence\(token\)(?![,\w])/u);
});
