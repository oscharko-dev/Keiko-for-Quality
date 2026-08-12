import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** Rejects an input-context reference anywhere inside a GitHub expression in shell code. */
function assertNoDispatchInputsInShell(source, filename) {
  for (const block of runBlocks(source)) {
    assert.doesNotMatch(
      block,
      /\$\{\{(?:(?!\}\})[\s\S])*(?:github\.event\.)?inputs(?:\.|\[)(?:(?!\}\})[\s\S])*\}\}/u,
      `${filename} must move workflow_dispatch inputs into env: before a run: block`,
    );
  }
}

function jobSection(jobName) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${jobName}:`);
  assert(start >= 0, `${jobName} job must exist`);
  const nextJobOffset = lines.slice(start + 1).findIndex((line) => /^ {2}\S/u.test(line));
  const end = nextJobOffset < 0 ? lines.length : start + 1 + nextJobOffset;
  return lines.slice(start, end).join("\n");
}

function evidenceCardinalityGuard() {
  const lines = jobSection("promotion").split("\n");
  const start = lines.findIndex((line) => line.trim() === "require_single_evidence() {");
  assert(start >= 0, "promotion must define the evidence cardinality guard");
  const endOffset = lines.slice(start + 1).findIndex((line) => line === "          }");
  assert(endOffset >= 0, "evidence cardinality guard must close at the run-block indentation");
  return lines
    .slice(start, start + endOffset + 2)
    .map((line) => line.slice(10))
    .join("\n");
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
    assert.match(
      workflow,
      /channel:\n {8}description: "standard keeps every quality-promotion floor; recovery requires an explicit withheld reason"/u,
    );
    assert.match(workflow, /RECOVERY_REASON: \$\{\{ inputs\.recovery_reason \}\}/u);
    assert.match(preflight, /historical_holdout_fixed_retention_low/u);
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
    assert.match(workflow, /historical-replay-\$\(date -u \+%F\)-v\$\{EXPECTED_VERSION\}\.json/u);
    assert.match(workflow, /seed-gate-\$\(date -u \+%F\)-v\$\{EXPECTED_VERSION\}\.md/u);
    assert.match(workflow, /completion-\$\(date -u \+%F\)-v\$\{EXPECTED_VERSION\}\.md/u);
    assert.equal([...workflow.matchAll(/if-no-files-found: error/gu)].length, 4);
    const completion = jobSection("completion");
    assert.match(
      completion,
      /- name: Upload completion evidence\n {8}if: always\(\)/u,
      "red completion evidence remains available for diagnosis while the job stays red",
    );
  });

  it("promotes only the complete evidence set for the exact candidate", () => {
    const promotion = jobSection("promotion");
    for (const dependency of ["preflight", "qualification", "historical", "seed", "completion"]) {
      assert.match(promotion, new RegExp(`^ {6}- ${dependency}$`, "mu"));
    }
    assert.match(promotion, /ref: \$\{\{ inputs\.expected_reviewer_sha \}\}/u);
    assert.match(promotion, /persist-credentials: false/u);

    for (const artifact of ["qualification", "historical", "seed", "completion"]) {
      assert.match(
        promotion,
        new RegExp(`name: ${artifact}-v\\$\\{\\{ inputs\\.version \\}\\}`),
        `${artifact} evidence is downloaded by its version-scoped artifact name`,
      );
      assert.match(
        promotion,
        new RegExp(`path: \\$\\{\\{ runner\\.temp \\}\\}/release-evidence/${artifact}`),
        `${artifact} evidence has an isolated download directory`,
      );
    }

    assert.match(promotion, /shopt -s nullglob/u);
    assert.match(promotion, /if \(\( \$# != 1 \)\); then/u);
    assert.match(promotion, /Expected exactly one \$\{label\} evidence file; found \$#/u);
    for (const artifact of ["qualification", "historical", "seed", "completion"]) {
      assert.match(
        promotion,
        new RegExp(`require_single_evidence ${artifact} "\\$\\{${artifact}\\[@\\]\\}"`),
        `${artifact} evidence uses the cardinality guard`,
      );
    }
    assert.match(promotion, /git rev-parse HEAD\^\{tree\}/u);
    assert.match(promotion, /node scripts\/check-release-evidence\.mjs/u);
    for (const flag of [
      "version",
      "head",
      "tree",
      "qualification",
      "historical",
      "seed",
      "completion",
      "channel",
    ]) {
      assert.match(promotion, new RegExp(`--${flag} `), `promotion passes --${flag}`);
    }
    assert.match(promotion, /channel_args=\(--channel "\$\{RELEASE_CHANNEL\}"\)/u);
  });

  it("names zero, duplicate, and non-file evidence before failing closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "kfq-evidence-cardinality-"));
    try {
      const evidence = join(directory, "historical.json");
      writeFileSync(evidence, "{}");
      const runGuard = (...paths) =>
        spawnSync(
          "bash",
          [
            "-c",
            `${evidenceCardinalityGuard()}\nrequire_single_evidence historical "$@"`,
            "evidence-guard",
            ...paths,
          ],
          { encoding: "utf8" },
        );

      assert.equal(runGuard(evidence).status, 0);
      for (const [paths, count] of [
        [[], 0],
        [[evidence, evidence], 2],
      ]) {
        const result = runGuard(...paths);
        assert.equal(result.status, 1);
        assert.match(
          result.stdout,
          new RegExp(`::error::Expected exactly one historical evidence file; found ${count}\\.`),
        );
      }
      const missing = runGuard(join(directory, "missing.json"));
      assert.equal(missing.status, 1);
      assert.match(missing.stdout, /selected historical evidence path is not a file/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never passes workflow_dispatch inputs directly to a shell", () => {
    for (const filename of readdirSync(workflowsDirectory)) {
      if (!/\.ya?ml$/u.test(filename)) continue;
      const source = readFileSync(resolve(workflowsDirectory, filename), "utf8");
      assertNoDispatchInputsInShell(source, filename);
    }
  });

  it("rejects dispatch inputs hidden inside compound shell expressions", () => {
    for (const expression of [
      "${{ inputs.version || '0.0.0' }}",
      "${{ format('{0}', inputs.version) }}",
      "${{ github.event.inputs['version'] || '0.0.0' }}",
    ]) {
      assert.throws(
        () =>
          assertNoDispatchInputsInShell(`steps:\n  run: |\n    echo ${expression}`, "fixture.yml"),
        /must move workflow_dispatch inputs into env/u,
      );
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
