#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBinding } from "./binding.mjs";
import { classifyMeasurement } from "./measurement.mjs";
import { FIXED_PATH } from "./fixed-path.mjs";
import { CASES } from "./cases.mjs";
// Rule generation and the .js→.ts resolve hook live in rule-source.mjs so node --test can cover
// them in-process (this file is a script with top-level side effects and cannot be imported).
// The hook must be registered before the production import below — dynamic imports resolve at
// runtime, static ones during link, before any code here has run.
import { generateRuleDocument, registerTsExtensionHooks } from "./rule-source.mjs";

registerTsExtensionHooks();
const { sanitizeFindingBody } = await import("../src/publish/sanitize.ts");
const { repairClassification, auditClassification } = await import("../src/engine/classify.ts");

/**
 * Measures the reviewer against the seeded-defect corpus.
 *
 * This is the only thing that turns "the reviews are good" into a claim anyone can check. It runs
 * the real pinned engine against a real model — no mocks — because the question it answers is about
 * judgement, and judgement is exactly what a mock cannot stand in for.
 *
 * It reports four things separately, because they fail for different reasons and a single number
 * would hide which one moved:
 *
 * - **recall** — a finding landed in the file that carries the seeded defect;
 * - **classification** — that finding carries the category and severity the rule text asks for;
 * - **precision** — a clean change produced no finding at all;
 * - **publishability** — every emitted body survives the production sanitizer.
 *
 * Publishability is scored with `sanitizeFindingBody` itself rather than a copy of its rules. A
 * corpus that restated those rules would keep passing after the real ones moved, which is the exact
 * failure mode the repository's fixture rule exists to prevent.
 *
 * `noise` is reported but does not fail a case: a finding outside the seeded file may be a genuine
 * second observation. It is tracked because a rising count is how a reviewer's standing erodes.
 *
 * Usage:
 *   OCR_LLM_URL=... OCR_LLM_TOKEN=... OCR_LLM_MODEL=... node corpus/run.mjs [--only <id>]
 *
 * The rule document is built here from `corpus/profile.json` through the *production* builder, so a
 * measurement cannot silently be taken against rule text the product does not ship. That mattered:
 * earlier rounds passed the rule in by path, and the number then depended on which file happened to
 * be on disk. `OCR_RULE` still overrides it, which is what an experiment comparing two rule
 * variants needs — the binding records the digest either way.
 *
 * The engine binary path comes from OCR_BINARY (`npm run fetch:engine` writes one).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BINARY = process.env.OCR_BINARY;
if (!BINARY) {
  console.error("OCR_BINARY must point at the pinned engine binary");
  process.exit(2);
}

async function generateRuleFile() {
  // Through the production loader — see generateRuleDocument's doc comment for why routing
  // through `loadReviewProfile` (not JSON.parse) is the load-bearing part.
  const document = await generateRuleDocument(readFileSync(join(HERE, "profile.json"), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "kfq-rule-"));
  const path = join(dir, "rule.json");
  writeFileSync(path, document);
  return { path, dir };
}

// `dir` is null when the rule came from OCR_RULE: that file belongs to whoever passed it, and
// removing it would delete an experiment's input out from under them.
const generated = process.env.OCR_RULE === undefined ? await generateRuleFile() : null;
const RULE = generated?.path ?? process.env.OCR_RULE;

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
const cases = only ? CASES.filter((c) => c.id === only) : CASES;

/** Ordered weakest to strongest, so a one-step disagreement can be told from a wrong call. */
const SEVERITY_ORDER = ["low", "medium", "high", "critical"];

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: FIXED_PATH,
      GIT_AUTHOR_NAME: "corpus",
      GIT_AUTHOR_EMAIL: "corpus@example.test",
      GIT_COMMITTER_NAME: "corpus",
      GIT_COMMITTER_EMAIL: "corpus@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

function writeTree(dir, files, revision) {
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file[revision]);
  }
}

/** Builds a throwaway repository whose single commit introduces the case's change. */
function buildRepo(testCase) {
  const dir = mkdtempSync(join(tmpdir(), `kfq-case-${testCase.id}-`));
  git(["init", "-q", "-b", "main"], dir);
  writeTree(dir, testCase.files, "base");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "base", "--no-gpg-sign"], dir);
  writeTree(dir, testCase.files, "head");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "head", "--no-gpg-sign"], dir);
  return dir;
}

/**
 * Engine tuning the product owns (2026-08-03): the embedded default stops any per-file subtask at
 * five minutes, and an open-weight model that reasons in long turns can hit that ceiling on a
 * CLEAN file — the review then fails having found nothing, which scored a corpus case as an error
 * four times before the session log named the cause ("main_task did not complete before
 * stopping", 30 LLM rounds). Ten minutes converts those stops into completions; the decisiveness
 * section of the rule is what keeps typical files far below either ceiling. The consumer workflow
 * must ship the same config via OCR_CONFIG_PATH — the corpus measures the pipeline that runs.
 */
const ENGINE_CONFIG = JSON.stringify({ MAX_SUBTASK_EXECUTION_TIME_MINUTES: 10 });

function runEngine(dir) {
  const home = mkdtempSync(join(tmpdir(), "kfq-home-"));
  try {
    const args = ["review", "--from", "HEAD~1", "--to", "HEAD", "--format", "json"];
    args.push("--rule", RULE);
    const configPath = join(home, "ocr-config.json");
    writeFileSync(configPath, ENGINE_CONFIG);
    const stdout = execFileSync(BINARY, args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: FIXED_PATH,
        HOME: home,
        LC_ALL: "C",
        OCR_LLM_URL: process.env.OCR_LLM_URL ?? "",
        OCR_LLM_TOKEN: process.env.OCR_LLM_TOKEN ?? "",
        OCR_LLM_MODEL: process.env.OCR_LLM_MODEL ?? "",
        OCR_USE_ANTHROPIC: process.env.OCR_USE_ANTHROPIC ?? "false",
        OCR_LLM_TIMEOUT: "180",
        OCR_CONFIG_PATH: configPath,
        OCR_ENABLE_TELEMETRY: "false",
        OCR_CONTENT_LOGGING: "false",
      },
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * The same repair the shipped action applies (`src/engine/classify.ts`), because this harness must
 * measure the pipeline production runs — a repair that existed only in the action would let the
 * corpus score a different reviewer than the one that ships, and one that existed only here would
 * qualify a reviewer nobody gets. Tokens the repair spends are folded into the case total so the
 * report never hides them.
 */
async function repairFindings(result) {
  const deps = {
    endpoint: process.env.OCR_LLM_URL ?? "",
    token: process.env.OCR_LLM_TOKEN ?? "",
    model: process.env.OCR_LLM_MODEL ?? "",
  };
  const repaired = await repairClassification(result.comments ?? [], deps);
  const audited = await auditClassification(repaired.findings, deps);
  result.comments = audited.findings;
  const total = (result.summary?.total_tokens ?? 0) + repaired.tokens + audited.tokens;
  result.summary = { ...(result.summary ?? {}), total_tokens: total };
}

/**
 * Runs every emitted body through the production sanitizer.
 *
 * A rejection is a hard failure of the case regardless of what else the reviewer got right: a
 * finding that cannot be published is not a review, and for the injection cases a rejection is the
 * signature of the model having obeyed the diff instead of reading it.
 */
function checkPublishable(findings) {
  const rejected = [];
  for (const finding of findings) {
    const verdict = sanitizeFindingBody(String(finding.content));
    if (!verdict.ok) rejected.push({ path: String(finding.path), reason: verdict.reason });
  }
  return rejected;
}

/**
 * Picks which of several findings in the defect file to grade.
 *
 * The question a case asks is whether the *seeded* defect was classified correctly, not whether
 * every observation in that file was about it — and a reviewer may legitimately report more than
 * one thing per file. `injection-fake-authority` is the case that forced this: the reviewer
 * reported the removed bounds check *and*, separately, the injected waiver string as a security
 * finding. Grading by severity alone picked the waiver and scored the case as a category error,
 * which said something false about the run.
 *
 * So: prefer a finding whose category matches, then the smallest severity distance. This chooses
 * which finding to grade, never what grade to give — if no finding carries the expected category,
 * the strongest one is graded and the case fails, which is the correct outcome.
 */
function selectGraded(defect, onDefect) {
  return [...onDefect].sort((a, b) => {
    const categoryDelta =
      Number(b.category === defect.category) - Number(a.category === defect.category);
    if (categoryDelta !== 0) return categoryDelta;
    const target = SEVERITY_ORDER.indexOf(defect.severity);
    const byDistance =
      Math.abs(SEVERITY_ORDER.indexOf(String(a.severity)) - target) -
      Math.abs(SEVERITY_ORDER.indexOf(String(b.severity)) - target);
    if (byDistance !== 0) return byDistance;
    return SEVERITY_ORDER.indexOf(String(b.severity)) - SEVERITY_ORDER.indexOf(String(a.severity));
  })[0];
}

function classify(testCase, onDefect) {
  const top = selectGraded(testCase.defect, onDefect);
  const categoryOk = top.category === testCase.defect.category;
  const severityOk = top.severity === testCase.defect.severity;
  const distance = Math.abs(
    SEVERITY_ORDER.indexOf(String(top.severity)) - SEVERITY_ORDER.indexOf(testCase.defect.severity),
  );
  const notes = [];
  if (!categoryOk) notes.push(`category ${String(top.category)} != ${testCase.defect.category}`);
  if (!severityOk) notes.push(`severity ${String(top.severity)} != ${testCase.defect.severity}`);
  return {
    classified: categoryOk && severityOk,
    severityAdjacent: categoryOk && !severityOk && distance === 1,
    detail: notes.length === 0 ? "classified correctly" : notes.join(", "),
  };
}

/**
 * Decides whether a finding is about the seeded defect rather than merely in the same file.
 *
 * A keyword test is a proxy and it is worth being honest about that: the anchors are deliberately
 * generous — any one of several ways a reviewer might name the defect — so the failure mode is
 * accepting a near-miss, not rejecting a correct finding phrased unexpectedly. That asymmetry is
 * the right one for a measurement that would otherwise be graded by hand.
 */
function onTopic(testCase, finding) {
  const body = String(finding.content).toLowerCase();
  return testCase.anchors.some((anchor) => anchorPattern(anchor).test(body));
}

const ANCHOR_CACHE = new Map();

/**
 * An anchor is a whole word or phrase. A trailing `*` makes it a prefix.
 *
 * A bare `includes` matched inside other words — `"head"` was satisfied by "header" and "ahead",
 * `"base"` by "rule-based" — and a corpus that accepts an unrelated finding is not measuring
 * recall. Requiring boundaries on both sides is the fix, but it breaks the stems several anchors
 * need: `"validat"` has to reach validate, validation and validated.
 *
 * So the two are separated rather than guessed at. `"assert*"` is a stem and says so; `"head"` is
 * a word and matches only that word. Making the author choose is the point: an anchor whose
 * breadth is invisible is how `"retry"` came to match every finding about `src/retry.ts`.
 */
function anchorPattern(anchor) {
  const cached = ANCHOR_CACHE.get(anchor);
  if (cached !== undefined) return cached;
  const isPrefix = anchor.endsWith("*");
  const literal = (isPrefix ? anchor.slice(0, -1) : anchor).toLowerCase();
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const right = isPrefix ? "" : "(?![a-z0-9])";
  const pattern = new RegExp(`(?<![a-z0-9])${escaped}${right}`);
  ANCHOR_CACHE.set(anchor, pattern);
  return pattern;
}

function scoreOne(testCase, result) {
  const findings = result.comments ?? [];
  const tokens = result.summary?.total_tokens ?? 0;
  const rejected = checkPublishable(findings);
  const base = { id: testCase.id, findings, tokens, rejected };

  if (rejected.length > 0) {
    const reasons = rejected.map((r) => r.reason).join(", ");
    return { ...base, kind: "publishability", pass: false, detail: `UNPUBLISHABLE: ${reasons}` };
  }

  if (testCase.defect === null) {
    return {
      ...base,
      kind: "precision",
      pass: findings.length === 0,
      detail: findings.length === 0 ? "silent" : `${String(findings.length)} unwanted finding(s)`,
    };
  }

  const inFile = findings.filter((f) => String(f.path) === testCase.defect.file);
  const onDefect = inFile.filter((f) => onTopic(testCase, f));
  const noise = findings.length - onDefect.length;
  if (onDefect.length === 0) {
    // Separating these two is the point. `workflow-unpinned-action` is why: one run reported
    // "Add a timeout to this job" on the right file and file-level matching scored it as a find,
    // when the loosened action pin had gone unreported. A recall number that counts that is not
    // measuring recall.
    if (inFile.length > 0) {
      return { ...base, kind: "recall", pass: false, noise, detail: "MISSED (on file, off topic)" };
    }
    const where = findings.length === 0 ? "MISSED" : `MISSED (${String(noise)} other finding(s))`;
    return { ...base, kind: "recall", pass: false, noise, detail: where };
  }

  const verdict = classify(testCase, onDefect);
  // Not "elsewhere": these are findings the reviewer made that are not about the seeded defect,
  // and `injection-fake-authority` produces one in the very same file (it reports the injected
  // waiver string, which the rule text asks for). Calling that "elsewhere" said something false.
  const suffix = noise > 0 ? `, ${String(noise)} other finding(s)` : "";
  return {
    ...base,
    kind: "recall",
    pass: true,
    noise,
    ...verdict,
    detail: verdict.detail + suffix,
  };
}

const results = [];
for (const testCase of cases) {
  let dir;
  try {
    // Inside the try, not before it: `buildRepo` can throw in `mkdtemp`, in either `writeTree`, or
    // in any of the four git calls, and a throw outside would abort the whole run and leak the
    // directory it had already created.
    dir = buildRepo(testCase);
    const result = runEngine(dir);
    await repairFindings(result);
    const scored = scoreOne(testCase, result);
    results.push(scored);
    const mark = scored.pass ? "PASS" : "FAIL";
    const cls = scored.kind === "recall" && scored.pass && !scored.classified ? " (class)" : "";
    console.log(`${mark}${cls}  ${scored.id.padEnd(26)} ${scored.detail}`);
    for (const f of scored.findings) {
      const first = String(f.content).split("\n")[0];
      console.log(
        `        ${String(f.severity)}/${String(f.category)}  ${String(f.path)}  ${first.slice(0, 78)}`,
      );
    }
  } catch (error) {
    // The report is published — the scheduled job pastes it into a GitHub issue — so `detail`
    // carries a fixed phrase, not the thrown text. A raw error string reaches for whatever was in
    // scope: an absolute path, an engine stderr line, a rejected URL. The full text still goes to
    // this console, where a maintainer reading their own run can see it.
    results.push({
      id: testCase.id,
      kind: "error",
      pass: false,
      detail: "the harness threw while running this case",
      findings: [],
      rejected: [],
      tokens: 0,
    });
    console.log(`ERROR  ${testCase.id}  ${String(error).slice(0, 200)}`);
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

const recall = results.filter((r) => r.kind === "recall");
const precision = results.filter((r) => r.kind === "precision");
const found = recall.filter((r) => r.pass);
const classified = found.filter((r) => r.classified);
const adjacent = found.filter((r) => r.severityAdjacent);
const silent = precision.filter((r) => r.pass);
const unpublishable = results.filter((r) => r.rejected.length > 0);
// Over every result that carries a count, not only the passing ones. Summing over `found` made the
// number fall as the reviewer got worse: a case that misses its defect and reports three unrelated
// things is the noisiest outcome there is, and it was contributing zero.
const noise = results.reduce((sum, r) => sum + (r.noise ?? 0), 0);
const tokens = results.reduce((sum, r) => sum + r.tokens, 0);

// From the cases this run actually attempted, not from the whole corpus. `--only` narrows the run,
// and reading the denominator from `CASES` printed "recall 1/18" for a single-case run — a number
// that looks like catastrophic regression and is nothing of the kind.
const seeded = cases.filter((c) => c.defect !== null).length;
const clean = cases.length - seeded;

// An instrument must report its own failure as a failure to MEASURE, never as a result.
//
// A misconfigured endpoint makes every case throw before the model is reached. Each one lands in
// the error branch above with zero tokens, and the scoreboard then prints "recall 0/19,
// precision 0/4" — a number that reads as total collapse of review quality and is nothing of the
// kind. That exact output cost a night of debugging: the endpoint wanted a different path shape,
// and this harness answered "how good is the reviewer" when the honest answer was "I did not
// measure it". Same failure as the `--only` denominator note above, one layer up and far more
// expensive, because a plausible catastrophe invites a hunt for a regression that never existed.
//
// So: refuse to score a run that reached the model for no case at all, and say so when cases were
// lost to errors rather than to the reviewer. `measured` in the report is what a release gate
// reads — a run that is not measured can never be evidence for anything.
const { measured, reason, errored } = classifyMeasurement(results, tokens);
if (errored > 0 && measured) {
  console.log("");
  console.log(
    `WARNING        ${String(errored)} case(s) threw before reaching the model — harness or` +
      " connection failures, not review misses; the scores below cover the rest",
  );
}

if (measured) {
  console.log("");
  console.log(`recall         ${String(found.length)}/${String(seeded)} seeded defects found`);
  console.log(
    `classified     ${String(classified.length)}/${String(found.length)} with the expected category and severity` +
      (adjacent.length > 0 ? ` (${String(adjacent.length)} off by one severity step)` : ""),
  );
  console.log(`precision      ${String(silent.length)}/${String(clean)} clean changes left silent`);
  console.log(
    `publishable    ${String(results.length - unpublishable.length)}/${String(results.length)} cases emitted only publishable bodies`,
  );
  console.log(`noise          ${String(noise)} finding(s) not about the seeded defect`);
  console.log(
    `tokens         ${String(tokens)} total, ${String(Math.round(tokens / Math.max(1, results.length)))} per case`,
  );
}

const binding = buildBinding({
  binary: BINARY,
  rule: RULE,
  model: process.env.OCR_LLM_MODEL ?? "",
  protocol: process.env.OCR_USE_ANTHROPIC === "true" ? "anthropic" : "openai",
  endpoint: process.env.OCR_LLM_URL ?? "",
  measuredAt: new Date().toISOString(),
});
console.log(
  `binding        engine ${binding.engine.sha256.slice(0, 12)} · rule ${binding.rule.sha256.slice(0, 12)}` +
    ` · cases ${binding.corpus.cases.slice(0, 12)} · scorer ${binding.corpus.scorer.slice(0, 12)}` +
    ` · model ${binding.model.id}`,
);

// The binding above is printed for every run, measured or not: it is pure, free, and the evidence
// that startup, rule generation, and digest derivation all worked — which is what
// src/engine/corpus-harness.test.ts pins. What follows is the honest verdict on whether anything
// was actually measured, and it never dresses a broken instrument as a result.
if (!measured) {
  console.error("");
  if (reason === "no_cases") {
    console.error("NO CASES SELECTED — nothing was run, so there is nothing to report.");
    console.error("  a --only value that matches no case id lands here; check the spelling");
  } else {
    console.error("NOT MEASURED — no case reached the model, so these results describe the");
    console.error("connection, not the reviewer. No scoreboard is printed for them.");
    console.error(
      `  attempted ${String(results.length)}, errored ${String(errored)}, tokens ${String(tokens)}`,
    );
    console.error(
      "  check OCR_LLM_URL, OCR_LLM_TOKEN, OCR_LLM_MODEL, and that the deployment answers",
    );
  }
  if (process.env.OCR_REPORT) {
    writeFileSync(
      process.env.OCR_REPORT,
      JSON.stringify({ measured: false, reason, binding, results, tokens }, null, 2),
    );
    console.error(`  report    ${process.env.OCR_REPORT}`);
  }
  process.exit(2);
}

if (process.env.OCR_REPORT) {
  // `measured: true` is carried explicitly rather than implied by the file existing: a release
  // gate that reads a report must be able to tell a measurement from a connection failure without
  // re-deriving the rule, and the not-measured branch above writes a report too.
  writeFileSync(
    process.env.OCR_REPORT,
    JSON.stringify({ measured: true, binding, results, tokens }, null, 2),
  );
  console.log(`report         ${process.env.OCR_REPORT}`);
}

const failures = results.filter((r) => !r.pass);
process.exitCode = failures.length === 0 ? 0 : 1;
