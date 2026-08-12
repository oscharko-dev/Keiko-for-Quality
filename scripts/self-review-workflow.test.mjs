import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(
  resolve(import.meta.dirname, "..", ".github/workflows/self-review.yml"),
  "utf8",
);
const lines = workflow.split("\n");

function stepBlock(name) {
  const start = lines.indexOf(`      - name: ${name}`);
  assert(start >= 0, `${name} step must exist`);
  const nextStepOffset = lines.slice(start + 1).findIndex((line) => /^ {6}- /u.test(line));
  const end = nextStepOffset < 0 ? lines.length : start + 1 + nextStepOffset;
  return lines.slice(start, end).join("\n");
}

function runScript(step) {
  const stepLines = step.split("\n");
  const run = stepLines.indexOf("        run: |");
  assert(run >= 0, "settlement gate must be an inline protected-base script");
  return stepLines
    .slice(run + 1)
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

describe("required self-review settlement gate", () => {
  it("reads the pinned action's output after reviewing from the protected base", () => {
    const review = stepBlock("Review");
    const gate = stepBlock("Require a complete settlement");

    assert.match(workflow, /^on:\n {2}pull_request_target:/mu);
    assert.match(
      stepBlock("Check out protected base"),
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u,
    );
    assert.match(review, /\n {8}id: review\n/u);
    assert.match(review, /uses: oscharko-dev\/Keiko-for-Quality@[0-9a-f]{40}/u);
    assert(workflow.indexOf(gate) > workflow.indexOf(review));
    assert.match(gate, /REVIEW_OUTCOME: \$\{\{ steps\.review\.outputs\.outcome \}\}/u);
    assert.doesNotMatch(runScript(gate), /\$\{\{/u);
  });

  it("accepts exactly complete and fails closed for every other action outcome", () => {
    const script = runScript(stepBlock("Require a complete settlement"));
    const execute = (outcome) =>
      spawnSync("/bin/bash", ["-eu", "-o", "pipefail", "-c", script], {
        encoding: "utf8",
        env: { ...process.env, REVIEW_OUTCOME: outcome },
      });

    assert.equal(execute("complete").status, 0);
    for (const outcome of [
      "",
      "incomplete",
      "abandoned",
      "skipped",
      "complete ",
      "complete\nignored",
      "complete; exit 0",
      "unknown-future-outcome",
    ]) {
      const result = execute(outcome);
      assert.notEqual(result.status, 0, `${JSON.stringify(outcome)} must fail the required check`);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(outcome || "unreachable", "u"));
    }
  });

  it("does not obtain the verdict from mutable PR state or expose credentials", () => {
    const gate = stepBlock("Require a complete settlement");
    assert.doesNotMatch(gate, /continue-on-error/u);
    assert.doesNotMatch(gate, /secrets\.|github\.token|GH_TOKEN|KFQ_MODEL_TOKEN/u);
    assert.doesNotMatch(gate, /\b(?:curl|gh)\b|issues\/comments|summary_comment_url/u);
    assert.doesNotMatch(runScript(gate), /REVIEW_OUTCOME[^\n]*(?:echo|printf)/u);
  });
});
