import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(
  resolve(import.meta.dirname, "..", ".github/workflows/release-gates.yml"),
  "utf8",
);

const workflowsDirectory = resolve(import.meta.dirname, "..", ".github/workflows");

/**
 * GitHub evaluates expressions before handing a `run:` value to the shell.  A
 * workflow_dispatch input is therefore untrusted shell data even when the
 * command later quotes the interpolation.  Keep the expression at an `env:`
 * boundary and expand the resulting shell variable instead.
 *
 * This intentionally inspects the YAML source rather than a parsed value: a
 * YAML parser cannot tell whether GitHub interpolated untrusted data before
 * Bash received it.
 */
function runBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/u.exec(lines[index]);
    if (!match) continue;

    const indentation = match[1].length;
    const block = [lines[index]];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim() && /^\s*/u.exec(line)[0].length <= indentation) break;
      block.push(line);
    }
    blocks.push(block.join("\n"));
  }

  return blocks;
}

function jobSection(jobName) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${jobName}:`);
  assert(start >= 0, `${jobName} job must exist`);
  const nextJobOffset = lines.slice(start + 1).findIndex((line) => /^ {2}\S/u.test(line));
  const end = nextJobOffset < 0 ? lines.length : start + 1 + nextJobOffset;
  return lines.slice(start, end).join("\n");
}

describe("paid release-gate workflow contract", () => {
  it("is manual-only and refuses anything except the exact dispatched dev candidate", () => {
    assert.match(workflow, /^on:\n {2}workflow_dispatch:/mu);
    assert.doesNotMatch(workflow, /^ {2}(?:pull_request|push|schedule):/mu);
    const preflight = jobSection("preflight");
    assert.match(preflight, /DISPATCH_REF.*github\.ref/u);
    assert.match(preflight, /"refs\/heads\/dev"/u);
    assert.match(preflight, /EXPECTED_REVIEWER_SHA.*DISPATCH_SHA/u);
    assert.match(preflight, /RUN_RELEASE_GATES/u);
    assert.match(preflight, /test -z "\$\(git status --porcelain\)"/u);
  });

  it("binds every paid job to the same protected environment and immutable checkout", () => {
    for (const jobName of ["qualification", "historical", "seed", "completion"]) {
      const section = jobSection(jobName);
      assert.match(section, /needs: preflight/u, `${jobName} waits for preflight`);
      assert.match(section, /environment: self-review/u, `${jobName} uses protected credentials`);
      assert.match(
        section,
        /ref: \$\{\{ inputs\.expected_reviewer_sha \}\}/u,
        `${jobName} checks out the candidate`,
      );
      assert.match(section, /persist-credentials: false/u, `${jobName} drops checkout credentials`);
      assert.match(section, /gpt-oss-120b/u, `${jobName} pins the measured model`);
    }
  });

  it("keeps the four version-scoped release evidence artifacts", () => {
    assert.match(workflow, /qualification-\$\(date -u \+%F\)-v\$\{EXPECTED_VERSION\}\.json/u);
    assert.match(
      workflow,
      /historical-replay-\$\(date -u \+%F\)-v\$\{EXPECTED_VERSION\}\.json/u,
    );
    assert.match(workflow, /seed-gate-\$\(date -u \+%F\)-v\$\{EXPECTED_VERSION\}\.md/u);
    assert.match(workflow, /completion-\$\(date -u \+%F\)-v\$\{EXPECTED_VERSION\}\.md/u);
    assert.equal([...workflow.matchAll(/if-no-files-found: error/gu)].length, 4);
  });

  it("never passes workflow_dispatch inputs directly to a shell", () => {
    for (const filename of readdirSync(workflowsDirectory)) {
      if (!/\.ya?ml$/u.test(filename)) continue;
      const source = readFileSync(resolve(workflowsDirectory, filename), "utf8");
      for (const block of runBlocks(source)) {
        assert.doesNotMatch(
          block,
          /\$\{\{\s*(?:github\.event\.)?inputs(?:\.[A-Za-z_][A-Za-z0-9_]*|\[['"][^'"]+['"]\])\s*\}\}/u,
          `${filename} must move workflow_dispatch inputs into env: before a run: block`,
        );
      }
    }
  });

  it("replays the complete calibrated population with a zero-token plan first", () => {
    const historical = jobSection("historical");
    assert.match(historical, /--prs 3003,3005,3006,3028,3031,3032,3037,3040,3041/u);
    assert.match(historical, /--dry-run/u);
    assert.equal([...historical.matchAll(/--max-tokens 61000000/gu)].length, 2);
    assert.equal([...historical.matchAll(/--holdout-from-pr 3037/gu)].length, 2);
  });

  it("measures three distinct PR sizes including the exact Keiko #3089 regression", () => {
    const completion = jobSection("completion");
    const paidStep = completion.slice(completion.indexOf("Run 41-file, 19-file, and 79-file"));
    assert.deepEqual(
      [...paidStep.matchAll(/--pr ([0-9]+)/gu)].map((match) => Number(match[1])),
      [2970, 3011, 3089],
    );
    assert.match(paidStep, /--runs 1/u);
    assert.match(completion, /Prove the zero-token stratified plan/u);
    assert.match(completion, /--dry-run/u);
  });
});
