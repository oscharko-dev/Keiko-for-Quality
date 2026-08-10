#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBinding } from "./binding.mjs";
import { classifyMeasurement } from "./measurement.mjs";
import { FIXED_PATH } from "./fixed-path.mjs";
import {
  engineArguments,
  engineEvidence,
  scoreCleanCase,
  singleShotCorpusConcurrency,
  skipRetryAfterBudgetStop,
} from "./engine-invocation.mjs";
import { evidenceShapeCounts, statesTriggeringCondition } from "./evidence-shape.mjs";
import { checkQualificationModel, DEVIATION_ENV } from "./qualification-model.mjs";
import { CASES } from "./cases.mjs";
// Rule generation and the .js→.ts resolve hook live in rule-source.mjs so node --test can cover
// them in-process (this file is a script with top-level side effects and cannot be imported).
// The hook must be registered before the production import below — dynamic imports resolve at
// runtime, static ones during link, before any code here has run.
import { generateRuleDocument, registerTsExtensionHooks } from "./rule-source.mjs";
import {
  CORPUS_REVIEW_TIMEOUT_SECONDS,
  corpusReviewDeadlineMs,
  qualificationEngineIdentity,
  singleShotCorpusContextOptions,
  singleShotCorpusDispatch,
} from "./single-shot-invocation.mjs";

registerTsExtensionHooks();
const { repairClassification, auditClassification } = await import("../src/engine/classify.ts");
const { startModelProxy } = await import("../src/engine/model-proxy.ts");
// The deterministic contract gate (issue #80 technique D) the main loop below merges in, mirrored
// from `collectGateFindings` / `compareAgainstCounterparts` in src/review.ts — the same import
// mechanism as `planPublication` below, so the corpus measures the shipped comparison and the
// shipped profile compiler, never a copy of either.
const { compareDeclaredContracts, describeMismatch, findUncoveredUnionMembers, describeUnionGap } =
  await import("../src/contracts/shape-gate.ts");
const { detectPinDesync, describePinDesync } = await import("../src/contracts/pin-desync.ts");
const { loadReviewProfile } = await import("../src/config/profile.ts");
// The single-shot runner (feat/single-shot-review): imported so the KFQ_SINGLE_SHOT=1 branch in
// `runEngine` below can measure the one-call-per-file mode on the SAME fixtures, graders, and
// resume harness as the pinned binary — same import mechanism as everything above, so the corpus
// measures the shipped runner, never a restatement of it.
const { runSingleShotEngine } = await import("../src/engine/single-shot.ts");
// The publisher stage: everything the gate merge (below) produces — engine plus classification
// plus the deterministic gate — is run through the real, shipped `planPublication` before scoring,
// never a restatement of sanitization or deduplication. Same import mechanism as everything above.
// See `planCaseFindings`'s own doc comment for the empty-prefetch argument and the synthetic
// `PublishContext` it builds.
const { planPublication } = await import("../src/publish/publisher.ts");
const { commitSha, repoPath } = await import("../src/core/brands.ts");
const { createSilentDiagnostics } = await import("../src/diagnostics/sink.ts");

const execFileAsync = promisify(execFile);

/**
 * Measures the reviewer against the seeded-defect corpus.
 *
 * This is the only thing that turns "the reviews are good" into a claim anyone can check. It runs
 * the release-selected generation workflow against a real model — no mocks — because the question
 * it answers is about judgement, and judgement is exactly what a mock cannot stand in for.
 *
 * It reports four things separately, because they fail for different reasons and a single number
 * would hide which one moved:
 *
 * - **recall** — a finding landed in the file that carries the seeded defect;
 * - **classification** — that finding carries the category and severity the rule text asks for;
 * - **precision** — a clean change produced no finding at all;
 * - **publishability** — every finding the production publisher would still consider survives its
 *   sanitizer.
 *
 * Publishability, `noise`, and the suppression counts below are all scored against the output of
 * the real, shipped `planPublication` (`src/publish/publisher.ts`) — never a copy of its rules, and
 * never the raw, pre-publisher findings. A corpus that restated those rules would keep passing
 * after the real ones moved, which is the exact failure mode the repository's fixture rule exists
 * to prevent (see `AGENTS.md`'s "The rule text and the sanitizer must move together").
 *
 * This closes a gap the same shape as the deterministic-gate one above it: before the publisher
 * stage existed here, the corpus measured the engine, classification, and the gate, but never the
 * publisher, so intra-run deduplication and sanitizer neutralization were invisible to every
 * qualification number — measured, not hypothesized: one qualification run had a case emit the same
 * finding three times, and the corpus scored that as three units of noise, when production would
 * have collapsed the three into the one finding a pull request actually receives before ever
 * posting it. `planCaseFindings`, below, runs every case's engine-plus-gate findings through the
 * shipped plan with an EMPTY existing-conversation prefetch: a corpus case is always a first review
 * of a synthetic pull request, so cross-run dedup (marker, similarity, dispositioned) has nothing to
 * compare against, and only sanitization and intra-run clustering — the two stages this harness
 * could not see before — ever act. `suppressedIntraRun` and `rejectedSanitization`
 * (`plan.counters`) are reported per case and in the scoreboard for the same reason tokens are: a
 * number that only ever appears summed hides which case moved it. A per-finding *neutralization*
 * count is deliberately NOT reported: `PublicationPlan`/`PlannedFinding`/`PlanCounters` never
 * surface how many bodies the sanitizer rewrote, only whether each one ultimately passed, and
 * inventing that number by some other means would be exactly the restatement this file exists to
 * avoid.
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
// The single-shot mode never spawns the binary, so demanding one would block the measurement it
// exists for; every other invocation keeps the guard exactly as it was.
if (!BINARY && process.env.KFQ_SINGLE_SHOT !== "1") {
  console.error("OCR_BINARY must point at the pinned engine binary");
  process.exit(2);
}

// Before anything spends a token: this project measures only against the pinned model (AGENTS.md).
// Checked here rather than at the first model call so a wrong configuration costs nothing at all —
// the failure this guards against already happened once and cost a full 32-case run.
const modelCheck = checkQualificationModel(process.env);
if (!modelCheck.ok) {
  console.error(modelCheck.reason);
  process.exit(2);
}
if (modelCheck.allowed) {
  console.warn(
    `${DEVIATION_ENV}=1 — measuring against a model this project does not run.\n` +
      "  This run is a cross-model experiment, not a qualification.",
  );
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

/**
 * The declared contract pairs the deterministic gate (below) reads, through the same production
 * loader `generateRuleDocument` calls internally — never a second, hand-rolled `JSON.parse` that
 * could silently drift from validation/defaulting (see rule-source.mjs's own doc comment for
 * exactly that failure mode, #44). Read from `corpus/profile.json` on disk unconditionally,
 * independent of `OCR_RULE`: that override only ever replaces the rule TEXT the model sees, never
 * which contract pairs this repository declares for the model-independent gate.
 */
const CONTRACT_PAIRS =
  loadReviewProfile(readFileSync(join(HERE, "profile.json"), "utf8")).contractPairs ?? [];

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
 * Reads one path's blob content at the case's HEAD commit, or `undefined` when the path is absent
 * there — the same undefined-on-absence contract `readTextAtCommit` (src/git/plumbing.ts) carries,
 * built from this file's own `git()` helper above rather than imported: the corpus already
 * hand-rolls its git plumbing (`buildRepo`, `writeTree`) instead of reusing production's, and this
 * is one more line of the same kind. The gate COMPARISON below is the part that must be — and is —
 * the real, shipped function, never a copy of it.
 */
function readAtHead(dir, path) {
  try {
    return git(["cat-file", "blob", `HEAD:${path}`], dir);
  } catch {
    return undefined;
  }
}

/**
 * One gate finding, in the exact shape this harness has always produced.
 *
 * Fixed `bug`/`high` at line 0 is production's own shape for a gate finding
 * (`collectGateFindings` / `collectPinDesyncFindings`, src/review.ts): the gate speaks only about
 * declarations it fully parsed, so its category and severity are certain before any model sees them
 * — which is why the main loop below merges these findings AFTER classification repair and audit.
 * `gate: true` is this harness's own marker, not a production field — see `computeGateFindings`
 * below.
 */
function gateFinding(file, content) {
  return {
    path: file.path,
    content,
    startLine: 0,
    endLine: 0,
    category: "bug",
    severity: "high",
    gate: true,
  };
}

/**
 * One changed file against one pair's counterparts, mirroring `compareAgainstCounterparts`
 * (src/review.ts): `compareDeclaredContracts` (not `compareContracts`: the profile named the two
 * files counterparts, so the positional fallback is the declaration's own meaning) plus the
 * union-coverage check, in that order, over each counterpart in turn.
 *
 * This harness ran only the older same-name comparison until the v0.13.0 qualification measured the
 * gap: all three cross-artifact fixtures MISSED here while the product's own wiring would have
 * published every one of them. The scorer digest recorded in each binding is what separates
 * measurements taken before and after this alignment.
 */
function computeCounterpartFindings(dir, pair, file, left) {
  const findings = [];
  for (const counterpart of pair.counterparts) {
    const right = readAtHead(dir, counterpart);
    if (right === undefined) continue;
    for (const mismatch of compareDeclaredContracts(left, right)) {
      findings.push(gateFinding(file, describeMismatch(mismatch, file.path, counterpart)));
    }
    for (const gap of findUncoveredUnionMembers(file.base, left, right)) {
      findings.push(gateFinding(file, describeUnionGap(gap, file.path, counterpart)));
    }
  }
  return findings;
}

/**
 * The pair-declared half of the gate: every profile-declared pair against every file this case
 * changed, pair outer and changed file inner — the order `collectGateFindings` (src/review.ts)
 * walks them, and the order `computeGateFindings`'s caller merges into `result.comments`.
 *
 * The head-side read happens only after the glob match, so a file no pair claims costs this half of
 * the gate no git call. That is a property of this function, not of the gate: `computePinDesyncFindings`
 * below is pair-independent and reads every changed file regardless.
 *
 * The inner results are appended one at a time rather than spread into `push`. The extracted
 * helper accumulates across ALL of a pair's counterparts, so the spread's argument count would be
 * the summed finding count rather than one counterpart's — and past the engine's argument ceiling
 * that throws where the single-finding `push` this replaced simply returned. Unreachable with the
 * committed fixtures, but the harness must not acquire a size limit the code it measures does not
 * have.
 */
function computePairFindings(dir, changed) {
  const findings = [];
  for (const pair of CONTRACT_PAIRS) {
    for (const file of changed) {
      if (!pair.matcher.matches(file.path)) continue;
      const left = readAtHead(dir, file.path);
      if (left === undefined) continue;
      for (const finding of computeCounterpartFindings(dir, pair, file, left)) {
        findings.push(finding);
      }
    }
  }
  return findings;
}

/**
 * Pin-desync — pair-independent, modified files only, mirroring `collectPinDesyncFindings`
 * (src/review.ts). `file.base` stands in for production's base-side blob read: cases.mjs carries
 * both revisions in memory, so only the head side needs a git call here.
 */
function computePinDesyncFindings(dir, changed) {
  const findings = [];
  for (const file of changed) {
    const head = readAtHead(dir, file.path);
    if (head === undefined) continue;
    for (const desync of detectPinDesync(file.base, head)) {
      findings.push(gateFinding(file, describePinDesync(desync, file.path)));
    }
  }
  return findings;
}

/**
 * The deterministic contract gate (issue #80 technique D), mirrored from `collectGateFindings` /
 * `compareAgainstCounterparts` in src/review.ts: for every profile-declared contract pair whose
 * `paths` glob matches a file this CASE actually changed — `base !== head` is the corpus's own
 * stand-in for "appears in the diff", since a byte-identical counterpart file never appears in a
 * real diff either (see cases.mjs's own header comment on the cross-artifact cases) — read both
 * sides at the case's head commit and compare same-named flat interfaces with the real, imported
 * `compareContracts` / `describeMismatch`. No model call, so this never adds to the run's token
 * total; the caller folds the result straight into `result.comments`.
 *
 * Findings anchor on the CHANGED file, never the counterpart, exactly as production does — see
 * `compareAgainstCounterparts`'s own doc comment for why. `gate: true` is this harness's own
 * marker, not a production field: it is how the per-case console output below tells a gate finding
 * from a model finding at a glance; `scoreOne` never reads it.
 *
 * The two halves are collected separately and concatenated in the order production merges them —
 * every declared pair first, then pin-desync. Production threads ONE array through both halves so
 * that its shared `MAX_GATE_FINDINGS` bound can stop either of them; this harness applies no such
 * bound, so each half returning its own list yields the identical findings in the identical order.
 */
function computeGateFindings(dir, testCase) {
  const changed = testCase.files.filter((file) => file.base !== file.head);
  return [...computePairFindings(dir, changed), ...computePinDesyncFindings(dir, changed)];
}

/**
 * The synthetic identity every case's plan run shares.
 *
 * `planPublication` fingerprints a finding on `ref`/`pullNumber`/`path`/`category`/`body` (never on
 * `headSha`, which only ever rides on a diagnostic record and on the separate incomplete-notice
 * marker this harness never constructs) and reads `identity` only to decide which EXISTING
 * conversation is this reviewer's own — moot here, since `EMPTY_PREFETCH` below hands it zero
 * existing conversations to own. A fixed synthetic value is therefore honest, not a shortcut: two
 * different cases never share a `PublishContext`, or compare against each other's markers, so
 * nothing depends on these values beyond internal self-consistency within one case's own plan call.
 */
const PLAN_IDENTITY = "keiko-for-quality[bot]";
const PLAN_REF = { owner: "keiko-for-quality", repo: "corpus" };
const PLAN_PULL_NUMBER = 1;
const PLAN_HEAD_SHA = commitSha("c".repeat(40));

/**
 * `planPublication`'s `prefetch` argument, fixed to empty for every case.
 *
 * A corpus case is a single synthetic pull request nothing has ever commented on, so cross-run
 * dedup — the marker, similarity, and dispositioned stages, all of which compare a candidate against
 * an ALREADY-PUBLISHED conversation — has nothing to compare against and can never suppress
 * anything here. Only sanitization and intra-run clustering (`clusterIntraRunDuplicates`,
 * `src/publish/publisher.ts`) can act on a corpus run, which is exactly the part of the pipeline
 * this harness did not measure before the publisher stage existed. Passing this explicitly (rather
 * than omitting the argument) also means `planPublication` never calls
 * `prefetchExistingConversations`, so `context.client.listReviewComments` is never reached —
 * `unreachableClient`, below, turns a silent, wrong dependency on that not being true into a loud
 * failure instead of a fake pass.
 */
const EMPTY_PREFETCH = { markers: new Set(), threads: [] };

/**
 * A `ReviewCommentApi` whose every method rejects, so a call this harness did not anticipate is a
 * loud test/run failure rather than a silently-wrong result. `planPublication` never reaches any of
 * these three when handed `EMPTY_PREFETCH` directly (see that constant's own doc comment above), and
 * this harness never calls `executePublication`/`publishFindings` — the functions that would
 * otherwise reach `createReviewComment`/`getReviewComment` — at all.
 */
function unreachableClient() {
  const unreachable = (method) => () =>
    Promise.reject(
      new Error(`corpus harness: ReviewCommentApi.${method} must not be called by planPublication`),
    );
  return {
    listReviewComments: unreachable("listReviewComments"),
    createReviewComment: unreachable("createReviewComment"),
    getReviewComment: unreachable("getReviewComment"),
  };
}

/**
 * `PublishContext.items`, built from the case's own changed paths.
 *
 * `planPublication` never reads `.items` today — only `executePublication`'s placement ladder does
 * (`placementLadder`, `src/publish/publisher.ts`), and this harness never calls that function — so
 * this is supplied for honesty rather than necessity: a future `planPublication` that starts
 * depending on it finds a representative map here instead of an empty one that would silently paper
 * over the gap. `status`/`classification`/`changedLines` are plausible fixed values rather than ones
 * derived from the case, because `cases.mjs` does not track add/delete/rename status at all — see
 * that file's own header comment — and nothing downstream reads them regardless.
 */
function planItems(testCase) {
  const items = new Map();
  for (const file of testCase.files) {
    if (file.base === file.head) continue;
    items.set(file.path, {
      path: repoPath(file.path),
      status: "M",
      classification: { kind: "reviewed" },
      modeChanged: false,
      reviewable: true,
      changedLines: 0,
    });
  }
  return items;
}

/**
 * Runs one case's engine-plus-gate findings through the real, shipped `planPublication` — the
 * publisher stage this file's header comment names. Called after the gate merge and before scoring,
 * mirroring where production itself merges `collectGateFindings`'s output before calling
 * `planPublication` (`publishSettledFindings`, `src/review.ts`: `merged = [...engine findings,
 * ...gate, ...changePass]` feeds the same plan call this mirrors).
 *
 * The `PublishContext` built here is synthetic but honest: `client` throws if any method is ever
 * called (`unreachableClient`), `items` is a representative map built from the case's own changed
 * paths (`planItems`) even though nothing here reads it today, and `prefetch` is always
 * `EMPTY_PREFETCH` — see each constant's own doc comment above for why every field is what it is.
 * `corpus/plan.test.mjs` pins this same mechanism hermetically, with zero model calls.
 */
async function planCaseFindings(testCase, findings) {
  const context = {
    client: unreachableClient(),
    ref: PLAN_REF,
    pullNumber: PLAN_PULL_NUMBER,
    headSha: PLAN_HEAD_SHA,
    identity: PLAN_IDENTITY,
    items: planItems(testCase),
  };
  return await planPublication(context, findings, createSilentDiagnostics(), EMPTY_PREFETCH);
}

/**
 * The KFQ_SINGLE_SHOT=1 branch of `runEngine`: the one-call-per-file runner over the identical
 * fixture commit (HEAD~1..HEAD, exactly what `engineArguments` hands the binary), the identical
 * profile-derived rule (both paths route through the production `buildRuleFile`), the identical
 * sampling pin threaded as `samplingSeed`, and production Inventory plus context-pack preparation.
 * The caller's retry/resume mirror sees the same stdout shape either way. Additive and env-gated:
 * with the flag unset, not one byte of the frozen classic-engine measurement basis below changes.
 *
 * Motivated the same day it was built (2026-08-07): the agentic loop spent 2.17M tokens against a
 * 1.27M allotment on this product's own pull request and settled coverage_gap twice, and the
 * single-shot smoke on the same commit ran complete at 132k. Recall is the open question, and this
 * branch is what lets the current corpus answer it with the same fixtures, graders, and publication
 * gates as every qualification before it.
 */
async function runSingleShotForCorpus(dir, seed, budgetTokens) {
  const git = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { PATH: FIXED_PATH } }).trim();
  const head = git(["rev-parse", "HEAD"]);
  const base = git(["rev-parse", "HEAD~1"]);
  const profile = loadReviewProfile(readFileSync(join(HERE, "profile.json"), "utf8"));
  const allotted = budgetTokens ?? 6_000_000;
  const pair = { base: commitSha(base), head: commitSha(head), mergeBase: commitSha(base) };
  const dispatch = await singleShotCorpusDispatch({
    repositoryPath: dir,
    pair,
    profile,
    pathValue: FIXED_PATH,
    renameDetectionPercent: 50,
    diagnostics: createSilentDiagnostics(),
  });
  const context = await singleShotCorpusContextOptions({
    repositoryPath: dir,
    pair,
    pathValue: FIXED_PATH,
    expectedReviewablePaths: dispatch.expectedReviewablePaths,
    mechanicallyCleanPaths: dispatch.mechanicallyCleanPaths,
  });
  const output = await runSingleShotEngine(
    {
      binaryPath: "/unused-in-single-shot",
      repositoryPath: dir,
      pair,
      config: {
        protocol: "openai",
        endpoint: process.env.OCR_LLM_URL ?? "",
        model: process.env.OCR_LLM_MODEL ?? "",
        tokenEnvName: "OCR_LLM_TOKEN",
        language: "English",
        concurrency: singleShotCorpusConcurrency(budgetTokens),
        fileTimeoutSeconds: 180,
        reviewTimeoutSeconds: CORPUS_REVIEW_TIMEOUT_SECONDS,
        tokenBudget: allotted,
        maxFindings: 50,
        renameDetectionPercent: 50,
      },
      profile,
      guidelines: { paths: [] },
      env: process.env,
      pathValue: FIXED_PATH,
      reviewDeadlineMs: corpusReviewDeadlineMs(),
      allottedBudget: allotted,
      expectedReviewablePaths: dispatch.expectedReviewablePaths,
      mechanicallyCleanPaths: dispatch.mechanicallyCleanPaths,
      ...context,
      samplingSeed: seed,
    },
    createSilentDiagnostics(),
  );
  return JSON.parse(output.stdout);
}

async function runEngine(dir, seed = 42, budgetTokens = undefined) {
  if (process.env.KFQ_SINGLE_SHOT === "1") {
    return await runSingleShotForCorpus(dir, seed, budgetTokens);
  }
  const home = mkdtempSync(join(tmpdir(), "kfq-home-"));
  // The production sampling pin (src/engine/model-proxy.ts, temperature 0) — the corpus measures
  // the pipeline that ships, and the pin is precisely what makes "twice in a row" meaningful.
  const proxy = await startModelProxy({
    upstreamUrl: process.env.OCR_LLM_URL ?? "",
    temperature: 0,
    seed,
  });
  try {
    const args = engineArguments(RULE, budgetTokens);
    const { stdout } = await execFileAsync(BINARY, args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: FIXED_PATH,
        HOME: home,
        LC_ALL: "C",
        OCR_LLM_URL: proxy.url,
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
    await proxy.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Mirror of the shipped single resume (#57, `runEngineWithOneResume` in src/review.ts): the
 * corpus must measure the pipeline production runs, and production re-invokes a failed engine
 * run exactly once. The measured failure this absorbs is a per-file subtask spiral ("main_task
 * did not complete before stopping" after ~30 LLM rounds) that hits roughly a quarter of runs on
 * two specific cases; a second failure scores as the error it is.
 */
async function runEngineWithOneResume(dir, budgetTokens = undefined) {
  let result;
  try {
    result = await runEngine(dir, 42, budgetTokens);
  } catch {
    // Seed 43, mirroring the shipped resume: pinned sampling replays a deterministic failure
    // byte-for-byte, so the one retry varies exactly that one bit of entropy. The budget rides
    // along unchanged, as production's own thrown-first-attempt path keeps the full allotment —
    // a throw left nothing measured to subtract.
    return await runEngine(dir, 43, budgetTokens);
  }
  // Mirror of production's engine.resume_skipped_budget_exceeded (src/review.ts): a budget-stopped
  // attempt is never re-run — the retry below fires on any non-success status, which a budget stop
  // is, and without this guard a budgeted case would spend its budget twice and grade only the
  // second truncation. See skipRetryAfterBudgetStop for why it gates on the case being budgeted.
  if (skipRetryAfterBudgetStop(result, budgetTokens)) return result;
  // Production's second trigger, mirrored: the engine reports a failed run as
  // {"status":"failed"} on EXIT CODE ZERO, which resolves here — without this check the corpus
  // measured one attempt where production makes two. (Corpus runs are deliberately unbudgeted —
  // the recorded measurement basis of every qualification — EXCEPT where a case declares
  // `budgetTokens` explicitly: the budget-pressure precision cases exist to reproduce the
  // condition production actually fails under, and for exactly those cases the budget half of the
  // shipped resume is mirrored too, by the skip above.)
  if (result?.status !== "success") return await runEngine(dir, 43, budgetTokens);
  return result;
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
  // Spread straight from `result.summary`: an absent (or null) summary spreads to nothing, which is
  // what the `?? {}` this used to carry already produced — every other key the engine reported is
  // carried over, and only `total_tokens` is replaced, exactly as before.
  result.summary = { ...result.summary, total_tokens: total };
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
  // `String.raw` rather than "\\$&": both spell the same three characters — a literal backslash
  // followed by the `$&` whole-match reference `replace` expands — and the raw form is the one that
  // cannot be misread as escaping the `$`.
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const right = isPrefix ? "" : "(?![a-z0-9])";
  const pattern = new RegExp(`(?<![a-z0-9])${escaped}${right}`);
  ANCHOR_CACHE.set(anchor, pattern);
  return pattern;
}

/**
 * Scores one case against `plan` — the real, shipped `planPublication`'s verdict on this case's
 * engine-plus-gate findings (`planCaseFindings`) — instead of against the raw findings the engine
 * and gate produced. A rejection is a hard failure of the case regardless of what else the reviewer
 * got right: a finding that cannot be published is not a review, and for the injection cases a
 * rejection is the signature of the model having obeyed the diff instead of reading it.
 *
 * `published` is what a pull request would actually receive: every survivor's body is its
 * SANITIZED (and, where applicable, neutralized) form, never the raw model output — the honest
 * question this scores is "would a pull request have received a publishable, on-topic finding", not
 * "did the model's raw output happen to mention it". A same-location repeat collapses to one entry
 * here exactly as it would in production (`clusterIntraRunDuplicates`, `src/publish/publisher.ts`),
 * which is why `noise` and the "N unwanted finding(s)" precision detail below can now read lower
 * than a plain count of the model's raw output — that drop is the point, not a bug: the corpus used
 * to over-count exactly this (see this file's header comment).
 *
 * `base.findings` uses the RAW findings instead of `published` when the case is rejected, so the
 * console dump and the JSON report still show what was rejected — a rejected finding is never a
 * plan survivor, so `published` alone would make it invisible right when a maintainer most wants to
 * see it.
 */
function scoreOne(testCase, result, plan) {
  const rawFindings = result.comments ?? [];
  const tokens = result.summary?.total_tokens ?? 0;
  const rejectedSanitization = plan.counters.rejectedSanitization;
  const suppressedIntraRun = plan.counters.suppressedIntraRun ?? 0;
  const published = plan.survivors.map((survivor) => ({
    ...survivor.finding,
    content: survivor.sanitizedBody,
  }));
  const base = {
    id: testCase.id,
    findings: rejectedSanitization > 0 ? rawFindings : published,
    // The engine facts a budget-pressure case is actionable through (see engine-invocation.mjs) —
    // additive report key; check-qualification.mjs and measurement.mjs read only id/pass/rejected
    // and kind/tokens respectively, so an old report and a new one parse identically.
    engine: engineEvidence(result),
    // How many published findings say WHEN the defect bites (see evidence-shape.mjs). Measured on
    // production this separates us from the competitor bot more sharply than anything else in the
    // prose — 21.7% against 63.1%, alongside a 23% against 64% rate of findings the author actually
    // acted on. Reported, not graded: this run's numbers are the baseline a later cycle moves, and
    // grading a corpus of 38 cases on a property measured over 850 real findings would read a
    // handful of samples as a trend. Additive for the same reason `engine` is.
    evidenceShape: evidenceShapeCounts(published.map((finding) => finding.content)),
    tokens,
    rejectedSanitization,
    suppressedIntraRun,
    // Kept as an array, not a bare count, so scripts/check-qualification.mjs's existing
    // `(byId.get(c.id)?.rejected ?? [{}]).length === 0` check keeps parsing an old OR new report
    // identically. `planPublication` surfaces only a COUNT of sanitization rejections
    // (`PlanCounters.rejectedSanitization`), never which finding or why, so there is nothing honest
    // to put in each element beyond a placeholder.
    rejected: Array.from({ length: rejectedSanitization }, () => ({})),
  };

  if (rejectedSanitization > 0) {
    return {
      ...base,
      kind: "publishability",
      pass: false,
      detail: `UNPUBLISHABLE: ${String(rejectedSanitization)} finding(s) rejected by sanitization`,
    };
  }

  if (testCase.defect === null) {
    const verdict = scoreCleanCase(result, testCase.budgetTokens, published.length);
    return {
      ...base,
      kind: "precision",
      ...verdict,
    };
  }

  const inFile = published.filter((f) => String(f.path) === testCase.defect.file);
  const onDefect = inFile.filter((f) => onTopic(testCase, f));
  const noise = published.length - onDefect.length;
  if (onDefect.length === 0) {
    // Separating these two is the point. `workflow-unpinned-action` is why: one run reported
    // "Add a timeout to this job" on the right file and file-level matching scored it as a find,
    // when the loosened action pin had gone unreported. A recall number that counts that is not
    // measuring recall.
    if (inFile.length > 0) {
      return { ...base, kind: "recall", pass: false, noise, detail: "MISSED (on file, off topic)" };
    }
    const where = published.length === 0 ? "MISSED" : `MISSED (${String(noise)} other finding(s))`;
    return { ...base, kind: "recall", pass: false, noise, detail: where };
  }

  // Opt-in, and exactly one case sets it (`unevidenced-claim`). A finding that names the right
  // defect but never says under what circumstance the code is wrong is a true sentence the reader
  // still has to re-derive before acting — production measured 21.7% of our findings stating such a
  // condition against a competitor's 63.1%, alongside 23% versus 64% actually acted on. Gating one
  // purpose-built case on it turns that gap into something a run can fail, without re-basing the 38
  // cases whose measurement basis predates the property: an unflagged case never reaches this
  // branch, so every recorded qualification stays comparable.
  if (testCase.requiresTriggeringCondition === true) {
    const grounded = onDefect.filter((finding) =>
      statesTriggeringCondition(String(finding.content)),
    );
    if (grounded.length === 0) {
      return {
        ...base,
        kind: "recall",
        pass: false,
        noise,
        detail: "UNEVIDENCED: found the defect but never states when the code is wrong",
      };
    }
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
  // Hoisted out of the try, not declared inside it: a throw in `computeGateFindings`,
  // `planCaseFindings`, or anything else after the model already ran must still leave the catch
  // block able to read the real spend `result.summary.total_tokens` already carries by that
  // point — a `const` scoped to the try block would put it out of reach and force the catch back
  // to a hardcoded 0, discarding tokens that were genuinely spent.
  let result;
  try {
    // Inside the try, not before it: `buildRepo` can throw in `mkdtemp`, in either `writeTree`, or
    // in any of the four git calls, and a throw outside would abort the whole run and leak the
    // directory it had already created.
    dir = buildRepo(testCase);
    result = await runEngineWithOneResume(dir, testCase.budgetTokens);
    await repairFindings(result);
    // Merged AFTER classification repair/audit, at the same point production's
    // `publishSettledFindings` merges `collectGateFindings`'s output into what gets published — so a
    // gate finding is graded exactly as production ships it: never audited or reclassified, because
    // its category and severity are already certain (see `collectGateFindings`'s doc comment,
    // src/review.ts). Without this the corpus measures only the engine's half of the product; with
    // it, a case the gate alone closes shows up as a pass here too.
    result.comments = [...(result.comments ?? []), ...computeGateFindings(dir, testCase)];
    // The publisher stage (see this file's header comment): the same findings production would
    // merge into one `planPublication` call are run through that real, shipped function here too,
    // so `scoreOne` grades what a pull request would actually receive rather than the engine's raw
    // output.
    const plan = await planCaseFindings(testCase, result.comments);
    const scored = scoreOne(testCase, result, plan);
    results.push(scored);
    const mark = scored.pass ? "PASS" : "FAIL";
    const cls = scored.kind === "recall" && scored.pass && !scored.classified ? " (class)" : "";
    // Suppression rides on the verdict line the same way tokens do, and only when it moved anything
    // — a case with nothing collapsed says so via its absence, matching how the `noise` suffix
    // above already behaves.
    const suppressionNote =
      scored.suppressedIntraRun > 0
        ? ` (suppressedIntraRun ${String(scored.suppressedIntraRun)})`
        : "";
    // Tokens ride on the verdict line itself — cost-per-finding has no home anywhere in this
    // repository otherwise, and a reader chasing an expensive case should not have to open the
    // report JSON to find out which one it was.
    console.log(
      `${mark}${cls}  ${scored.id.padEnd(26)} ${scored.detail}${suppressionNote}` +
        ` (tokens ${String(scored.tokens)})`,
    );
    for (const f of scored.findings) {
      const first = String(f.content).split("\n")[0];
      // `[gate] ` flags a deterministic finding `computeGateFindings` added (see its own doc
      // comment above) — so a reader of this log can tell it from a model finding without opening
      // the JSON report.
      const tag = f.gate === true ? "[gate] " : "";
      console.log(
        `        ${tag}${String(f.severity)}/${String(f.category)}  ${String(f.path)}  ${first.slice(0, 78)}`,
      );
    }
    if (testCase.budgetTokens !== undefined) {
      // Counts only, matching the redaction discipline everywhere else in this log. The WARNING
      // marks an instrument failure, not a review failure: a budgeted case that never hit its
      // budget measured a different condition than it claims to, and a fake pass must be visible
      // in the run it happened in rather than discovered in a later argument about the numbers.
      const e = scored.engine;
      console.log(
        `        budget  allotted ${String(testCase.budgetTokens)}, spent ${String(e.total_tokens)},` +
          ` files_reviewed ${String(e.files_reviewed)}, budget_exceeded ${String(e.budget_exceeded)}`,
      );
      if (!e.budget_exceeded) {
        console.warn(
          `WARNING  ${testCase.id}  budgeted case finished without budget_exceeded — the pressure` +
            ` this case exists to apply never arrived; treat its verdict as unmeasured`,
        );
      }
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
      // The one fact still known even when the plan/gate stage fails: what the model call already
      // cost before the throw. `result` is `undefined` when `buildRepo` or the engine invocation
      // itself is what threw — there was nothing to spend yet, and 0 is the honest answer there too.
      tokens: result?.summary?.total_tokens ?? 0,
      engine: result === undefined ? null : engineEvidence(result),
      rejectedSanitization: 0,
      suppressedIntraRun: 0,
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
// The publisher-stage totals (see this file's header comment): summed the same way `noise` is
// above, from every result that carries a count, error-branch results included (they carry 0 for
// both, same as they carry 0 tokens).
const suppressedIntraRunTotal = results.reduce((sum, r) => sum + (r.suppressedIntraRun ?? 0), 0);
const rejectedSanitizationTotal = results.reduce(
  (sum, r) => sum + (r.rejectedSanitization ?? 0),
  0,
);

// From the cases this run actually attempted, not from the whole corpus. `--only` narrows the run,
// and reading the denominator from `CASES` printed "recall 1/18" for a single-case run — a number
// that looks like catastrophic regression and is nothing of the kind.
const seeded = cases.filter((c) => c.defect !== null).length;
const clean = cases.length - seeded;

// Cost-per-finding has no home anywhere in this repository otherwise. `isSevere` mirrors
// scripts/check-qualification.mjs's own selector exactly — the two must agree on what "severe"
// means, or a token cost measured here and a qualification verdict measured there would silently
// be talking about different sets of cases.
const isSevere = (c) => c.defect !== null && ["critical", "high"].includes(c.defect.severity);
const casesById = new Map(cases.map((c) => [c.id, c]));
// Every finding reported on a case that carried a seeded defect, on-topic or not: noise is still a
// real model output that cost real tokens, and excluding it would understate what a finding
// actually costs. A clean case's findings are excluded — those are scored as precision failures,
// never graded against a defect.
const findingsGraded = results.reduce((sum, r) => {
  const testCase = casesById.get(r.id);
  return testCase !== undefined && testCase.defect !== null ? sum + r.findings.length : sum;
}, 0);
const severeHits = found.filter((r) => {
  const testCase = casesById.get(r.id);
  return testCase !== undefined && isSevere(testCase);
}).length;
// `null`, not a number silently computed against a zero denominator: a reviewer that finds no
// severe defect at all — or none of the graded cases carries a finding — should read as "n/a", not
// as some plausible-looking cost figure.
const tokensPerFinding = findingsGraded > 0 ? Math.round(tokens / findingsGraded) : null;
const tokensPerSevereHit = severeHits > 0 ? Math.round(tokens / severeHits) : null;

// Written into the report ADDITIVELY, both where `measured` is true and where it is false:
// scripts/check-qualification.mjs and corpus/measurement.mjs must keep parsing a report written
// before this object, or any field on it, existed, so nothing above it in either write site moved
// or renamed to make room for it. Computed once and reused at both write sites rather than repeated
// as two literals that could drift from each other. `suppressedIntraRun`/`rejectedSanitization` are
// the publisher-stage totals (see this file's header comment); there is no `neutralized` here for
// the same reason `scoreOne` does not report one per case — `planPublication`'s own return shape
// never surfaces it.
const aggregates = {
  findingsGraded,
  tokensPerFinding,
  severeHits,
  tokensPerSevereHit,
  suppressedIntraRun: suppressedIntraRunTotal,
  rejectedSanitization: rejectedSanitizationTotal,
};

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
    `suppressed     ${String(suppressedIntraRunTotal)} intra-run duplicate(s) collapsed before` +
      ` publication, ${String(rejectedSanitizationTotal)} finding(s) rejected by sanitization`,
  );
  console.log(
    `tokens         ${String(tokens)} total, ${String(Math.round(tokens / Math.max(1, results.length)))} per case`,
  );
  // Cost-per-finding, added alongside the scoreboard above rather than in place of any of it — see
  // the aggregate computation earlier in this file for why each ratio is guarded against a zero
  // denominator instead of rounding a plausible-looking number out of one.
  console.log(
    `${"findings".padEnd(14)} ${String(findingsGraded)} finding(s) graded across seeded cases`,
  );
  console.log(
    `${"tokens/finding".padEnd(14)} ` +
      (tokensPerFinding === null ? "n/a (no findings graded)" : String(tokensPerFinding)),
  );
  console.log(
    `${"tokens/severe-hit".padEnd(14)} ` +
      (tokensPerSevereHit === null ? "n/a (no severe defects found)" : String(tokensPerSevereHit)),
  );
}

const binding = buildBinding({
  // Single-shot binds the explicit transitive source closure that assembles staged prompts and
  // prepares their corpus-only production inputs. Classic mode still binds the spawned binary.
  // The unused classic binary must not win merely because the workflow fetched it before mode
  // selection.
  engine: qualificationEngineIdentity({
    singleShot: process.env.KFQ_SINGLE_SHOT === "1",
    binary: BINARY,
    repositoryRoot: join(HERE, ".."),
  }),
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
      JSON.stringify(
        {
          measured: false,
          reason,
          binding,
          results,
          tokens,
          aggregates,
        },
        null,
        2,
      ),
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
    JSON.stringify(
      {
        measured: true,
        binding,
        results,
        tokens,
        aggregates,
      },
      null,
      2,
    ),
  );
  console.log(`report         ${process.env.OCR_REPORT}`);
}

const failures = results.filter((r) => !r.pass);
process.exitCode = failures.length === 0 ? 0 : 1;
