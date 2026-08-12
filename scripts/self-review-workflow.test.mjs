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
  const start = lines.findIndex((line) => {
    const match = /^(\s*)- name: (.+)$/u.exec(line);
    return match?.[2] === name;
  });
  assert(start >= 0, `${name} step must exist`);
  const indentation = /^(\s*)-/u.exec(lines[start])?.[1];
  assert(indentation !== undefined, `${name} step indentation must be readable`);
  const nextStepOffset = lines
    .slice(start + 1)
    .findIndex((line) => line.startsWith(`${indentation}- `));
  const end = nextStepOffset < 0 ? lines.length : start + 1 + nextStepOffset;
  return lines.slice(start, end).join("\n");
}

function runScript(step) {
  const stepLines = step.split("\n");
  const run = stepLines.findIndex((line) => /^\s+run: \|$/u.test(line));
  assert(run >= 0, "settlement gate must be an inline protected-base script");
  const runIndentation = /^\s*/u.exec(stepLines[run])?.[0].length ?? 0;
  const scriptLines = stepLines.slice(run + 1);
  const contentIndentation = Math.min(
    ...scriptLines
      .filter((line) => line.trim().length > 0)
      .map((line) => /^\s*/u.exec(line)?.[0].length ?? 0),
  );
  assert(contentIndentation > runIndentation, "inline script must be nested below run");
  return scriptLines
    .map((line) => {
      if (line.trim().length === 0) return "";
      assert(
        /^\s*/u.exec(line)?.[0].length >= contentIndentation,
        "every inline script line must share the block indentation",
      );
      return line.slice(contentIndentation);
    })
    .join("\n");
}

const expectedGateScript = [
  'if [ "$REVIEW_OUTCOME" != "complete" ]; then',
  '  echo "::error::Keiko for Quality did not settle this self-review as complete."',
  "  exit 1",
  "fi",
  "",
].join("\n");

describe("required self-review settlement gate", () => {
  it("reads the pinned action's output after reviewing from the protected base", () => {
    const review = stepBlock("Review");
    const gate = stepBlock("Require a complete settlement");

    assert.match(workflow, /^on:\n +pull_request_target:/mu);
    assert.match(
      stepBlock("Check out protected base"),
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u,
    );
    assert.match(review, /^\s+id: review$/mu);
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
    assert.equal(runScript(gate), expectedGateScript);
  });
});
