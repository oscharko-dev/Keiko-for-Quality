import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(
  resolve(import.meta.dirname, "..", ".github/workflows/ci.yml"),
  "utf8",
);
const properties = readFileSync(
  resolve(import.meta.dirname, "..", "sonar-project.properties"),
  "utf8",
);
const readme = readFileSync(resolve(import.meta.dirname, "..", "README.md"), "utf8");

function jobSection(jobName) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${jobName}:`);
  assert(start >= 0, `${jobName} job must exist`);
  const nextJobOffset = lines.slice(start + 1).findIndex((line) => /^ {2}\S/u.test(line));
  const end = nextJobOffset < 0 ? lines.length : start + 1 + nextJobOffset;
  return lines.slice(start, end);
}

describe("required Sonar CI contract", () => {
  it("grants only job-local minimum permissions", () => {
    assert.equal(
      workflow.split("\n").some((line) => line.startsWith("permissions:")),
      false,
    );
    for (const jobName of [
      "core_verify",
      "engine-pin",
      "action-smoke",
      "sonar",
      "main_provenance",
    ]) {
      const section = jobSection(jobName);
      assert.equal(section.includes("    permissions:"), true, `${jobName} declares permissions`);
      assert.equal(section.includes("      contents: read"), true, `${jobName} reads contents`);
    }
    assert.equal(jobSection("verify").includes("    permissions: {}"), true);
  });

  it("keeps the protected verify context as an aggregate over core and Sonar", () => {
    assert.match(workflow, /\n {2}verify:\n {4}name: verify\n/u);
    assert.match(workflow, /needs: \[core_verify, main_provenance, sonar\]/u);
    assert.match(workflow, /CORE_RESULT: \$\{\{ needs\.core_verify\.result \}\}/u);
    assert.match(workflow, /MAIN_PROVENANCE_RESULT: \$\{\{ needs\.main_provenance\.result \}\}/u);
    assert.match(workflow, /SONAR_RESULT: \$\{\{ needs\.sonar\.result \}\}/u);
  });

  it("runs both the PR and all-open dev evidence checks after analysis", () => {
    const scan = workflow.indexOf("- name: SonarCloud CI-based analysis");
    const pullRequestGate = workflow.indexOf("node scripts/check-sonar-pr-quality-gate.mjs");
    const devGate = workflow.indexOf("node scripts/check-sonar-main-quality-gate.mjs");
    assert(scan >= 0);
    assert(pullRequestGate > scan);
    assert(devGate > pullRequestGate);
    assert.match(workflow, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev'/u);
  });

  it("runs Sonar only for same-repository pull requests and dev pushes", () => {
    assert.match(
      workflow,
      /github\.event_name == 'pull_request' &&\n {7}github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u,
    );
    assert.match(workflow, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev'/u);
    assert.doesNotMatch(workflow, /github\.event_name == 'push' \|\|/u);
  });

  it("fails every non-success Sonar result outside a byte-identical main push", () => {
    assert.doesNotMatch(workflow, /HEAD_REPOSITORY/u);
    assert.match(workflow, /if \[ "\$SONAR_RESULT" = "success" \]; then\n {12}exit 0/u);
    assert.match(workflow, /Sonar verification did not succeed/u);
    const skippedComparisons = [
      ...workflow.matchAll(/\[ "\$SONAR_RESULT" ([!=]+) "skipped" \]/gu),
    ].map((match) => match[1]);
    assert.deepEqual(skippedComparisons, ["!="]);
    assert.match(workflow, /\[ "\$MAIN_PROVENANCE_RESULT" != "success" \]/u);
  });

  it("accepts a main push only after exact dev-tree provenance", () => {
    assert.match(workflow, /\n {2}main_provenance:\n {4}name: main provenance\n/u);
    assert.match(
      workflow,
      /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/u,
    );
    assert.match(workflow, /git rev-parse 'HEAD\^\{tree\}'/u);
    assert.match(workflow, /git rev-parse 'origin\/dev\^\{tree\}'/u);
    assert.match(workflow, /if \[ "\$main_tree" != "\$dev_tree" \]; then/u);
  });

  it("keeps tested Sonar evidence code inside the 85% coverage scope", () => {
    const exclusions = /^sonar\.coverage\.exclusions=(.*)$/mu.exec(properties)?.[1]?.split(",");
    assert(exclusions !== undefined);
    assert.equal(exclusions.includes("scripts/**"), false);
    for (const path of [
      "scripts/check-sonar-main-quality-gate.mjs",
      "scripts/check-sonar-pr-quality-gate.mjs",
      "scripts/sonar-quality-gate-contract.mjs",
    ]) {
      assert.equal(exclusions.includes(path), false, `${path} must remain coverable`);
    }
    for (const path of ["scripts/build.mjs", "scripts/check-bundle.mjs", "scripts/release.mjs"]) {
      assert.equal(exclusions.includes(path), true, `${path} is an explicit top-level driver`);
    }
  });

  it("keeps public badges bound to the evidence they display", () => {
    assert.match(
      readme,
      /alt="Keiko Banking Grade CI contract" src="https:\/\/github\.com\/oscharko-dev\/Keiko-for-Quality\/actions\/workflows\/ci\.yml\/badge\.svg\?branch=dev"/u,
    );
    assert.doesNotMatch(readme, /metric=alert_status/u);
    assert.doesNotMatch(readme, /sonarcloud\.io\/summary\/new_code/u);
    const metrics = [
      ...readme.matchAll(/project_badges\/measure\?[^"\s]+&metric=([^"&\s]+)/gu),
    ].map((match) => match[1]);
    assert.deepEqual(metrics, [
      "duplicated_lines_density",
      "coverage",
      "reliability_rating",
      "security_rating",
      "sqale_rating",
      "sqale_index",
      "vulnerabilities",
    ]);
    assert.equal(new Set(metrics).size, metrics.length);
  });
});
