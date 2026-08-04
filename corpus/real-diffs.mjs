#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FIXED_PATH } from "./fixed-path.mjs";
import { generateRuleDocument, registerTsExtensionHooks } from "./rule-source.mjs";

registerTsExtensionHooks();
const { sanitizeFindingBody } = await import("../src/publish/sanitize.ts");

/**
 * Runs the reviewer over real, already-merged commits of a real repository.
 *
 * The seeded corpus answers "does it find a defect I planted?". This answers the question a
 * consumer actually has before switching the reviewer on: **what will it say about my code, and
 * how much of that will I want to read?** Already-merged commits are the right material because
 * they have passed whatever gates that repository runs — so a high finding rate is mostly noise,
 * and the few findings that survive scrutiny are the product's real value.
 *
 * It is also the only harness that has found defects the seeded corpus structurally could not.
 * The corpus never produced a finding containing an angle-bracket placeholder; the first real run
 * did, and that finding was discarded by the publisher's HTML check — a correct high-severity
 * report about a Windows-incompatible null device, lost. Constructed fixtures cannot surface what
 * their author did not think to construct.
 *
 * Nothing is published. This reads git objects and prints; it never touches the GitHub API.
 *
 * Usage:
 *   OCR_BINARY=... OCR_LLM_URL=... OCR_LLM_TOKEN=... OCR_LLM_MODEL=... \
 *     node corpus/real-diffs.mjs [--evidence <path>] <repo-path> <commit> [commit...]
 *
 * The profile is read from `<repo-path>/.github/keiko-for-quality.json` when present, so the
 * include and exclude sets match what a real run in that repository would use. Expect each review
 * to cost far more than a corpus case — a real multi-file commit has run to several hundred
 * thousand tokens.
 *
 * `--evidence <path>` writes a second, JSON evidence file alongside the console output above —
 * additive only: the console output is byte-for-byte what it always was when the flag is absent.
 * Redaction is STRICT, mirroring corpus/evidence/*.json (see arena-lib.mjs's own redaction note):
 * counts, commit shas, and token totals, never a finding body, never a path inside the target
 * repository, never any other text this harness or the model produced. This script exists
 * specifically to run against a caller's own, possibly private, repository — its evidence output
 * has to be safe to paste somewhere the console output above is not.
 */

const BINARY = process.env.OCR_BINARY;

const USAGE =
  "usage: OCR_BINARY=... real-diffs.mjs [--evidence <path>] <repo-path> <commit> [commit...]";

/**
 * Pulls the one optional flag this script accepts out of argv before the remainder is read as
 * `<repo-path> <commit>...` — every other argument shape is exactly what it was before this flag
 * existed, which is what keeps a caller that never passes it seeing byte-identical behavior.
 */
function parseArgs(argv) {
  const rest = [...argv];
  const flagIndex = rest.indexOf("--evidence");
  let evidencePath = null;
  if (flagIndex !== -1) {
    evidencePath = rest[flagIndex + 1];
    if (evidencePath === undefined || evidencePath === "") {
      console.error(`--evidence requires a path\n${USAGE}`);
      process.exit(2);
    }
    rest.splice(flagIndex, 2);
  }
  const [repo, ...commits] = rest;
  return { repo, commits, evidencePath };
}

const { repo, commits, evidencePath } = parseArgs(process.argv.slice(2));
if (BINARY === undefined || repo === undefined || commits.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

function loadProfileText() {
  const path = join(repo, ".github", "keiko-for-quality.json");
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.error(`no profile at ${path} — pass a repository that carries one`);
    process.exit(2);
  }
}

const ruleDir = mkdtempSync(join(tmpdir(), "kfq-real-"));
const rulePath = join(ruleDir, "rule.json");
// Through the production loader (rule-source.mjs) — the raw `{ profile: JSON.parse(...) }`
// shape was the same #48 loader bypass the qualification harness carried, second instance.
writeFileSync(rulePath, await generateRuleDocument(loadProfileText()));

function subjectOf(commit) {
  return execFileSync("git", ["log", "-1", "--format=%s", commit], {
    cwd: repo,
    encoding: "utf8",
    env: { PATH: FIXED_PATH },
  }).trim();
}

function review(commit) {
  const home = mkdtempSync(join(tmpdir(), "kfq-home-"));
  try {
    const stdout = execFileSync(
      BINARY,
      ["review", "--from", `${commit}~1`, "--to", commit, "--format", "json", "--rule", rulePath],
      {
        cwd: repo,
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        env: {
          PATH: FIXED_PATH,
          HOME: home,
          LC_ALL: "C",
          OCR_LLM_URL: process.env.OCR_LLM_URL ?? "",
          OCR_LLM_TOKEN: process.env.OCR_LLM_TOKEN ?? "",
          OCR_LLM_MODEL: process.env.OCR_LLM_MODEL ?? "",
          OCR_USE_ANTHROPIC: process.env.OCR_USE_ANTHROPIC ?? "false",
          OCR_LLM_TIMEOUT: "300",
          OCR_ENABLE_TELEMETRY: "false",
          OCR_CONTENT_LOGGING: "false",
        },
      },
    );
    return JSON.parse(stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

let findingCount = 0;
let tokenCount = 0;
let unpublishable = 0;
// One entry per commit that produced a result at all. An errored commit contributes nothing here,
// mirroring findingCount/tokenCount/unpublishable above, which also only ever count a completed
// review — its ERROR line above is still the console's own, unchanged record of that commit.
const evidenceReviews = [];

for (const commit of commits) {
  try {
    const result = review(commit);
    const findings = result.comments ?? [];
    const tokens = result.summary?.total_tokens ?? 0;
    findingCount += findings.length;
    tokenCount += tokens;
    let unpublishableHere = 0;
    console.log(`\n=== ${commit}  ${subjectOf(commit)}`);
    console.log(
      `    status=${String(result.status)} reviewed=${String(result.summary?.files_reviewed ?? "?")} ` +
        `findings=${String(findings.length)} tokens=${String(tokens)}`,
    );
    for (const finding of findings) {
      // Every body goes through the production sanitizer. A rejection here is the interesting
      // case: the reviewer said something and the publisher would have thrown it away.
      const verdict = sanitizeFindingBody(String(finding.content));
      if (!verdict.ok) {
        unpublishable += 1;
        unpublishableHere += 1;
        console.log(`    [UNPUBLISHABLE: ${verdict.reason}]`);
      }
      const lines = String(finding.content).split("\n");
      console.log(
        `    - ${String(finding.severity)}/${String(finding.category)}  ` +
          `${String(finding.path)}:${String(finding.start_line)}`,
      );
      console.log(`      ${String(lines[0])}`);
      const body = lines.slice(1).join(" ").trim().replace(/\s+/g, " ");
      if (body !== "") console.log(`      ${body.slice(0, 300)}`);
    }
    // STRICT redaction, mirroring corpus/evidence/*.json: a commit sha and counts only — never a
    // finding body, never a path inside the target repository, never any other text this harness
    // or the model produced.
    evidenceReviews.push({
      commit,
      filesReviewed: result.summary?.files_reviewed ?? 0,
      findings: findings.length,
      unpublishable: unpublishableHere,
      tokens,
    });
  } catch (error) {
    console.log(`\n=== ${commit}  ERROR ${String(error).slice(0, 200)}`);
  }
}

console.log(
  `\n${String(findingCount)} finding(s) over ${String(commits.length)} commit(s), ` +
    `${String(unpublishable)} unpublishable, ${String(tokenCount)} tokens ` +
    `(${String(Math.round(tokenCount / commits.length))} per review)`,
);

if (evidencePath !== null) {
  const evidence = {
    reviews: evidenceReviews,
    aggregate: {
      commits: commits.length,
      findings: findingCount,
      unpublishable,
      tokens: tokenCount,
      tokensPerReview: Math.round(tokenCount / commits.length),
      // Guarded rather than divided into a plausible-looking number over a zero denominator: no
      // finding anywhere in the run means "n/a", not a number that happens to print as 0 or NaN.
      tokensPerFinding: findingCount > 0 ? Math.round(tokenCount / findingCount) : null,
    },
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence  ${evidencePath}`);
}

rmSync(ruleDir, { recursive: true, force: true });
