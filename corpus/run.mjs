#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CASES } from "./cases.mjs";

/**
 * Measures the reviewer against the seeded-defect corpus.
 *
 * This is the only thing that turns "the reviews are good" into a claim anyone can check. It runs
 * the real pinned engine against a real model — no mocks — because the question it answers is about
 * judgement, and judgement is exactly what a mock cannot stand in for.
 *
 * It reports recall and precision separately, and it treats the precision cases as first-class. A
 * reviewer that fires on every change trains its readers to ignore it, which is a worse outcome
 * than missing one defect.
 *
 * Usage:
 *   OCR_LLM_URL=... OCR_LLM_TOKEN=... OCR_LLM_MODEL=... node corpus/run.mjs [--only <id>]
 *
 * The engine binary path comes from OCR_BINARY, and the rule file from OCR_RULE — both so a loop
 * can vary one and hold the other fixed.
 */

const BINARY = process.env.OCR_BINARY;
const RULE = process.env.OCR_RULE;
if (!BINARY) {
  console.error("OCR_BINARY must point at the pinned engine binary");
  process.exit(2);
}

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
const cases = only ? CASES.filter((c) => c.id === only) : CASES;

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_AUTHOR_NAME: "corpus",
      GIT_AUTHOR_EMAIL: "corpus@example.test",
      GIT_COMMITTER_NAME: "corpus",
      GIT_COMMITTER_EMAIL: "corpus@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

/** Builds a throwaway repository whose single commit introduces the case's change. */
function buildRepo(testCase) {
  const dir = mkdtempSync(join(tmpdir(), `kfq-case-${testCase.id}-`));
  git(["init", "-q", "-b", "main"], dir);
  const target = join(dir, testCase.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, testCase.base);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "base", "--no-gpg-sign"], dir);
  writeFileSync(target, testCase.head);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "head", "--no-gpg-sign"], dir);
  return dir;
}

function runEngine(dir) {
  const home = mkdtempSync(join(tmpdir(), "kfq-home-"));
  try {
    const args = ["review", "--from", "HEAD~1", "--to", "HEAD", "--format", "json"];
    if (RULE) args.push("--rule", RULE);
    const stdout = execFileSync(BINARY, args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        LC_ALL: "C",
        OCR_LLM_URL: process.env.OCR_LLM_URL ?? "",
        OCR_LLM_TOKEN: process.env.OCR_LLM_TOKEN ?? "",
        OCR_LLM_MODEL: process.env.OCR_LLM_MODEL ?? "",
        OCR_USE_ANTHROPIC: process.env.OCR_USE_ANTHROPIC ?? "false",
        OCR_LLM_TIMEOUT: "180",
        OCR_ENABLE_TELEMETRY: "false",
        OCR_CONTENT_LOGGING: "false",
      },
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function scoreOne(testCase, result) {
  const findings = result.comments ?? [];
  const tokens = result.summary?.total_tokens ?? 0;
  const wanted = testCase.expect.find;

  if (!wanted) {
    return {
      id: testCase.id,
      kind: "precision",
      pass: findings.length === 0,
      detail: findings.length === 0 ? "silent" : `${String(findings.length)} unwanted finding(s)`,
      findings,
      tokens,
    };
  }

  if (findings.length === 0) {
    return { id: testCase.id, kind: "recall", pass: false, detail: "MISSED", findings, tokens };
  }

  // Detection and classification are scored separately: a found defect filed as a nit is a
  // different failure from a missed defect, and conflating them hides which one is happening.
  const top = findings[0];
  const categoryOk = top.category === testCase.category;
  const severityOk = top.severity === testCase.severity;
  const notes = [];
  if (!categoryOk) notes.push(`category ${String(top.category)} != ${testCase.category}`);
  if (!severityOk) notes.push(`severity ${String(top.severity)} != ${testCase.severity}`);
  return {
    id: testCase.id,
    kind: "recall",
    pass: true,
    classified: categoryOk && severityOk,
    detail: notes.length ? notes.join(", ") : "classified correctly",
    findings,
    tokens,
  };
}

const results = [];
for (const testCase of cases) {
  const dir = buildRepo(testCase);
  try {
    const result = runEngine(dir);
    const scored = scoreOne(testCase, result);
    results.push(scored);
    const mark = scored.pass ? "PASS" : "FAIL";
    const cls = scored.kind === "recall" && scored.pass && !scored.classified ? " (class)" : "";
    console.log(`${mark}${cls}  ${scored.id.padEnd(24)} ${scored.detail}`);
    for (const f of scored.findings) {
      const first = String(f.content).split("\n")[0];
      console.log(`        ${String(f.severity)}/${String(f.category)}  ${first.slice(0, 92)}`);
    }
  } catch (error) {
    results.push({
      id: testCase.id,
      kind: "error",
      pass: false,
      detail: String(error).slice(0, 120),
      findings: [],
      tokens: 0,
    });
    console.log(`ERROR  ${testCase.id}  ${String(error).slice(0, 120)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const recall = results.filter((r) => r.kind === "recall");
const precision = results.filter((r) => r.kind === "precision");
const found = recall.filter((r) => r.pass);
const classified = found.filter((r) => r.classified);
const silent = precision.filter((r) => r.pass);
const tokens = results.reduce((sum, r) => sum + r.tokens, 0);

console.log("");
console.log(`recall      ${String(found.length)}/${String(recall.length)} seeded defects found`);
console.log(
  `classified  ${String(classified.length)}/${String(found.length)} with the expected category and severity`,
);
console.log(
  `precision   ${String(silent.length)}/${String(precision.length)} clean changes left silent`,
);
console.log(
  `tokens      ${String(tokens)} total, ${String(Math.round(tokens / Math.max(1, results.length)))} per case`,
);

if (process.env.OCR_REPORT) {
  writeFileSync(process.env.OCR_REPORT, JSON.stringify({ results, tokens }, null, 2));
  console.log(`report      ${process.env.OCR_REPORT}`);
}

const failures = results.filter((r) => !r.pass);
process.exitCode = failures.length === 0 ? 0 : 1;
