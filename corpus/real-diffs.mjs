#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXED_PATH } from "./fixed-path.mjs";
import { registerTsExtensionHooks } from "./rule-source.mjs";

registerTsExtensionHooks();
const { performLocalReview, loadReviewProfile, parseRuntimeConfig, createDiagnostics } =
  await import("../src/index.ts");
const { resolveRef } = await import("../src/git/plumbing.ts");
const { parseGuidelinePaths } = await import("../src/config/guidelines.ts");

/**
 * Runs the reviewer over real, already-merged commits of a real repository — through
 * `performLocalReview` (`src/review.ts`, exported via `src/index.ts`), the same orchestrator
 * `npm run review` (`src/cli.ts`) and the GitHub Action both drive (issue #99; epic #94's own
 * "Reuse And No-Duplication Gate": "corpus/real-diffs.mjs already demonstrates the offline path;
 * the CLI child should subsume its role rather than leaving a parallel harness").
 *
 * The seeded corpus (`corpus/run.mjs`, frozen — see AGENTS.md) answers "does it find a defect I
 * planted?". This answers the question a consumer actually has before switching the reviewer on:
 * **what will it say about my code, and how much of that will I want to read?** Already-merged
 * commits are the right material because they have passed whatever gates that repository runs — so
 * a high finding rate is mostly noise, and the few findings that survive scrutiny are the product's
 * real value.
 *
 * Nothing is published. This reads git objects and prints; it never touches the GitHub API.
 *
 * ## What changed when this stopped hand-rolling the engine invocation
 *
 * Before this rewiring, this file spawned the pinned engine binary directly
 * (`execFileSync(OCR_BINARY, ["review", "--from", ..., "--to", ..., "--rule", rulePath])`) and
 * printed the raw, pre-publication findings it returned — no inventory or classification, no
 * review-cache, no deterministic contract gate, no change-level cross-artifact pass, no
 * classification repair or publish-time audit, and no real deduplication: this script called
 * `sanitizeFindingBody` itself, once per finding, as its own approximation of what the publisher
 * would have kept. That was a second, parallel measurement of the engine, never of the pipeline a
 * pull request actually receives.
 *
 * Driving `performLocalReview` instead means every one of those stages now runs for real — the
 * exact same pipeline `performReview` runs, minus only the two GitHub-only steps (head-currency and
 * publish-execute) a local run has no pull request to perform. Concretely, this is a strictly MORE
 * FAITHFUL measurement, not merely a refactor:
 *
 * - the engine binary is acquired, cached, and SHA-256-verified against
 *   `src/engine/pinned-release.ts` (`acquireEngine`) instead of trusted from a caller-supplied
 *   path — `OCR_BINARY` is gone from this script's environment surface entirely, and
 *   `npm run fetch:engine` is no longer a prerequisite for running it;
 * - classification repair AND the publish-time classification audit both run, so a finding's
 *   category/severity here is what a pull request would actually see, not the engine's raw guess;
 * - the deterministic contract gate and the change-level cross-artifact pass both run when the
 *   reviewed repository's profile declares contract pairs or enables the latter;
 * - findings are deduplicated and sanitized through the real, shipped `planPublication` — the same
 *   function `corpus/run.mjs`'s own publisher-stage measurement (see its header comment) exercises
 *   — rather than this script's own ad hoc, post-hoc `sanitizeFindingBody` call;
 * - a real per-run token allotment now applies (`computeAllottedBudget`, `src/review.ts`; hard
 *   ceiling 6,000,000 tokens regardless of the generous `tokenBudget` this script configures) where
 *   the raw engine invocation ran fully unbounded — the price of measuring the same pipeline a
 *   consumer's run is capped by, rather than a harness-only exemption from it.
 *
 * One capability is deliberately NOT preserved: previously, a finding that failed
 * `sanitizeFindingBody` was printed inline as `[UNPUBLISHABLE: <reason>]`, showing the raw rejected
 * content — which is how this script found the Windows-null-device finding this header comment used
 * to cite as its own headline discovery. `planPublication` (like production) never surfaces a
 * rejected finding's body or reason outside the sanitizer itself; only a COUNT is observable, via
 * the local report's final count after Truth/Falsifier and PR-wide ranking. `corpus/run.mjs`'s own
 * `rejectedSanitization` counter has carried this exact limitation for as long as it has existed
 * ("there is nothing honest to put in each element beyond a placeholder") — this script now matches
 * that, rather than being the one place in this repository that could still see through the
 * sanitizer's own reject-rather-than-repair boundary.
 *
 * Usage (env unchanged in name and meaning except `OCR_BINARY`, which is no longer read):
 *   OCR_LLM_URL=... OCR_LLM_TOKEN=... OCR_LLM_MODEL=... [OCR_USE_ANTHROPIC=true] \
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

const USAGE =
  "usage: OCR_LLM_URL=... OCR_LLM_TOKEN=... OCR_LLM_MODEL=... " +
  "real-diffs.mjs [--evidence <path>] <repo-path> <commit> [commit...]";

/**
 * Pulls the one optional flag this script accepts out of argv before the remainder is read as
 * `<repo-path> <commit>...`, and confirms both required positionals are present — every argument
 * shape this accepted before this rewiring still means exactly what it did. Returns a discriminated
 * result rather than calling `process.exit` itself (mirrors `src/cli.ts`'s own `ParseArgsResult`),
 * which is what lets `corpus/real-diffs.test.mjs` exercise every branch without being able to
 * terminate the test process out from under itself.
 */
export function parseArgs(argv) {
  const rest = [...argv];
  const flagIndex = rest.indexOf("--evidence");
  let evidencePath = null;
  if (flagIndex !== -1) {
    evidencePath = rest[flagIndex + 1];
    if (evidencePath === undefined || evidencePath === "") {
      return { ok: false, message: `--evidence requires a path\n${USAGE}` };
    }
    rest.splice(flagIndex, 2);
  }
  const [repo, ...commits] = rest;
  if (repo === undefined || commits.length === 0) {
    return { ok: false, message: USAGE };
  }
  return { ok: true, repo, commits, evidencePath };
}

// -------------------------------------------------------------------------------------------------
// Request assembly — the same field set `src/cli.ts`'s own `prepareRequest` builds for
// `npm run review`, reused rather than restated: `parseRuntimeConfig` and `loadReviewProfile` are
// the real validators (`src/config/runtime.ts`, `src/config/profile.ts`), never a second,
// hand-rolled check.
// -------------------------------------------------------------------------------------------------

const TOKEN_ENV_NAME = "OCR_LLM_TOKEN";

/**
 * Mirrors `src/cli.ts`'s own `RUNTIME_FLAG_DEFAULTS`/`FIXED_RUNTIME_DEFAULTS` (which in turn mirror
 * `action.yml`'s defaults) for everything this script exposes no flag for — concurrency, timeouts,
 * budget, findings ceiling, rename detection, language, and the cross-artifact pass. Not imported
 * from `cli.ts` directly: those constants are private to that module, and — like `cli.ts`'s own doc
 * comment says of `buildRuntimeConfig` vs. `runtimeConfigFromInputs` — the two callers are shaped by
 * different environment-variable conventions (`KFQ_MODEL_*` there, `OCR_LLM_*` here), not by
 * different validation, which is why `parseRuntimeConfig` itself — the shared validator, not either
 * caller's own env-reading wrapper — is what `buildEngineRuntimeConfig` below actually reuses.
 *
 * Two values are deliberately NOT copied from the action's defaults, because this script's own
 * documented use case is bigger than a pull request diff (see this file's header comment: "a real
 * multi-file commit has run to several hundred thousand tokens"):
 *
 * - `reviewTimeoutSeconds` is `parseRuntimeConfig`'s own maximum (21600s / 6h) rather than the
 *   action's 1800s (30 min) — this script is run by a human waiting at a terminal, not a CI job
 *   under a wall-clock SLA, and a review this script exists to run should never be truncated by a
 *   budget sized for a pull request.
 * - `tokenBudget` is 6,000,000 — `src/review.ts`'s own `ALLOTMENT_CEILING`, the hard cap
 *   `computeAllottedBudget` applies no matter how large a `tokenBudget` is configured here. Any
 *   larger value would have zero further effect, so this names the real ceiling instead of a bigger
 *   number that only looks less bounded.
 * - `maxFindings` is `parseRuntimeConfig`'s own maximum (500) rather than the action's 50 — an
 *   already-merged, multi-file commit legitimately draws more observations than a typical pull
 *   request diff, and this script's whole purpose is to see them, not to have the run settle
 *   incomplete over an implausible-count guard sized for CI.
 * - The large-review policy controls are disabled here because this script is an intentional local
 *   measurement harness, not an automatic pull-request reviewer deciding whether CI should spend.
 */
const ENGINE_RUNTIME_DEFAULTS = {
  language: "English",
  concurrency: 4,
  fileTimeoutSeconds: 300,
  reviewTimeoutSeconds: 21_600,
  tokenBudget: 6_000_000,
  maxFindings: 500,
  renameDetectionPercent: 50,
  crossArtifactPass: false,
  // Local replay deliberately measures large commits; CI admission policy would make that impossible.
  largeReviewMaxFiles: 0,
  budgetFailureRetryLimit: 0,
  budgetFailureMinFiles: 0,
  largeReviewOverrideLabel: "",
};

/**
 * Builds this run's `RuntimeConfig` from the `OCR_LLM_*` environment variables this script has
 * always read — unchanged in name and meaning — through `parseRuntimeConfig`
 * (`src/config/runtime.ts`), the same validator `src/cli.ts`'s `buildRuntimeConfig` hands its own
 * `KFQ_MODEL_*` candidate to. Throws `ValidationError` (`src/core/brands.ts`) on a missing or
 * malformed endpoint/model/protocol — including an unset `OCR_LLM_URL`, which resolves to `""` and
 * fails the https-only endpoint check immediately, rather than starting a review that spends
 * nothing and reports an opaque per-commit `ERROR` the way an empty endpoint did before this
 * rewiring. `readModelToken` (called deep inside `performLocalReview`, at the point the engine is
 * actually about to be spawned) is what refuses to run without a credential in hand — `tokenEnvName`
 * names `OCR_LLM_TOKEN` here so that refusal reads the same variable this script's own usage line
 * has always named.
 */
export function buildEngineRuntimeConfig(env) {
  return parseRuntimeConfig(
    {
      protocol: env.OCR_USE_ANTHROPIC === "true" ? "anthropic" : "openai",
      endpoint: env.OCR_LLM_URL ?? "",
      model: env.OCR_LLM_MODEL ?? "",
      tokenEnvName: TOKEN_ENV_NAME,
      ...ENGINE_RUNTIME_DEFAULTS,
    },
    "config",
  );
}

/**
 * Reads and compiles the reviewed repository's own profile — the identical file, at the identical
 * path, `loadProfile` (`src/cli.ts`) reads for `npm run review` — through `loadReviewProfile`
 * (`src/config/profile.ts`), the real production loader. #44's own lesson (see
 * `corpus/rule-source.mjs`'s doc comment) is exactly why this is never a bare `JSON.parse`.
 */
export async function loadCompiledProfile(repo) {
  const path = join(repo, ".github", "keiko-for-quality.json");
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`no profile at ${path} — pass a repository that carries one`);
  }
  try {
    return loadReviewProfile(text);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`profile at ${path} is invalid${detail}`);
  }
}

/** No `--guidelines` flag exists on this script (unchanged by this rewiring) — an empty
 *  `GuidelineIndex`, built through the real `parseGuidelinePaths` rather than a hand-built object
 *  literal, is what every `LocalReviewRequest` below carries. */
const NO_GUIDELINES = parseGuidelinePaths("");

/** Mirrors `src/cli.ts`'s own `gitContextFor`, except `pathValue` is always the corpus's hardened
 *  `FIXED_PATH` (`corpus/fixed-path.mjs`) rather than an inherited `PATH` — this script already ran
 *  every git and engine subprocess under `FIXED_PATH` before this rewiring, and `fixed-path.mjs`'s
 *  own doc comment on why a writable inherited directory is unsafe next to a model credential
 *  applies at least as much here as it did before. */
export function gitContextFor(repo) {
  return { cwd: repo, timeoutMs: 120_000, pathValue: FIXED_PATH };
}

/** `<commit>~1` as the base and `<commit>` as the head — the identical diff boundary the old raw
 *  `--from <commit>~1 --to <commit>` engine invocation reviewed, now resolved through `resolveRef`
 *  (`src/git/plumbing.ts`) into the verified `CommitSha` values `LocalReviewRequest` requires,
 *  rather than passed through as unverified strings. */
export async function resolveCommitPair(ctx, commit) {
  const base = await resolveRef(ctx, `${commit}~1`, "base");
  const head = await resolveRef(ctx, commit, "head");
  return { base, head };
}

/** Assembles one commit's `LocalReviewRequest` — the same field set `src/cli.ts`'s own
 *  `prepareRequest` builds for `npm run review`, minus only the review-cache store: this script has
 *  never had a `--store` flag, and adding one is out of this rewiring's scope. */
export async function buildLocalReviewRequest({ ctx, repo, commit, profile, config, env }) {
  const { base, head } = await resolveCommitPair(ctx, commit);
  return {
    base,
    head,
    repositoryPath: repo,
    config,
    profile,
    guidelines: NO_GUIDELINES,
    env,
    pathValue: ctx.pathValue,
  };
}

// -------------------------------------------------------------------------------------------------
// The one seam that spends real model tokens. `corpus/real-diffs.test.mjs` stubs
// `deps.runLocalReview` and never calls the real `performLocalReview` — mirrors `src/cli.test.ts`'s
// own `MainDeps.runLocalReview` injection.
// -------------------------------------------------------------------------------------------------

/** Final selected sanitizer losses from the local report. Earlier sanitizer diagnostics describe
 *  raw hypotheses and must not become failures when quality work legitimately removes them. */
export function countRejectedSanitization(report) {
  const count = report.quality?.rejectedSanitization;
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/**
 * Reviews one commit through `deps.runLocalReview` (`performLocalReview` in real use) and returns
 * the report plus this commit's rejected-by-sanitization count. A fresh `Diagnostics` sink per
 * commit — drained and discarded, never written anywhere — is what makes the count exact without
 * this script printing a single diagnostic line the old version never printed either.
 */
export async function reviewCommit(deps, commit) {
  const request = await buildLocalReviewRequest({
    ctx: deps.ctx,
    repo: deps.repo,
    commit,
    profile: deps.profile,
    config: deps.config,
    env: deps.env,
  });
  const diagnostics = deps.createDiagnostics(() => {});
  const report = await deps.runLocalReview(request, diagnostics);
  diagnostics.drain();
  return { report, unpublishable: countRejectedSanitization(report) };
}

// -------------------------------------------------------------------------------------------------
// Rendering — the same console shape this script has always printed, sourced from
// `LocalReviewReport`/`LocalReviewFinding` (`src/review.ts`) instead of the raw engine's own JSON.
// -------------------------------------------------------------------------------------------------

function classificationLabel(value) {
  return value ?? "unclassified";
}

/** A finding's `category`/`severity` may now be absent (an unclassified finding is still reported —
 *  see `LocalReviewFinding`'s own doc comment, `src/review.ts`) where the raw engine result this
 *  replaced always carried both; `classificationLabel` is the only new fallback this requires. */
export function formatFindingLines(finding) {
  const contentLines = finding.body.split("\n");
  const out = [
    `    - ${classificationLabel(finding.severity)}/${classificationLabel(finding.category)}  ` +
      `${finding.path}:${String(finding.startLine)}-${String(finding.endLine)}`,
    `      ${contentLines[0] ?? ""}`,
  ];
  const rest = contentLines.slice(1).join(" ").trim().replace(/\s+/g, " ");
  if (rest !== "") out.push(`      ${rest.slice(0, 300)}`);
  return out;
}

export function formatCommitHeader(commit, subject) {
  return `\n=== ${commit}  ${subject}`;
}

/** `outcome` replaces the raw engine's own `status` string with the shared pipeline's settlement
 *  vocabulary (`complete`/`incomplete`/`abandoned`, `src/review.ts`) — the same one `npm run
 *  review`'s own rendering (`renderSettlement`, `src/cli.ts`) reports. `unpublishable` is new: the
 *  old per-finding inline `[UNPUBLISHABLE: reason]` marker is gone (see this file's header comment),
 *  replaced by this per-commit aggregate count. */
export function formatCommitSummary({
  outcome,
  reviewed,
  findingCount,
  unpublishableCount,
  tokens,
}) {
  return (
    `    outcome=${outcome} reviewed=${String(reviewed)} findings=${String(findingCount)} ` +
    `unpublishable=${String(unpublishableCount)} tokens=${String(tokens)}`
  );
}

export function formatAggregateLine({ findingCount, commitCount, unpublishable, tokenCount }) {
  return (
    `\n${String(findingCount)} finding(s) over ${String(commitCount)} commit(s), ` +
    `${String(unpublishable)} unpublishable, ${String(tokenCount)} tokens ` +
    `(${String(Math.round(tokenCount / commitCount))} per review)`
  );
}

/** Guarded the same way `corpus/run.mjs`'s own `tokensPerFinding` is: `null`, not a number computed
 *  over a zero denominator, when nothing was found across the whole run. */
export function computeAggregate({ commitCount, findingCount, unpublishable, tokenCount }) {
  return {
    commits: commitCount,
    findings: findingCount,
    unpublishable,
    tokens: tokenCount,
    tokensPerReview: Math.round(tokenCount / commitCount),
    tokensPerFinding: findingCount > 0 ? Math.round(tokenCount / findingCount) : null,
  };
}

/** STRICT redaction, mirroring corpus/evidence/*.json: a commit sha and counts only — never a
 *  finding body, never a path inside the target repository, never any other text this harness or
 *  the model produced. Field names are unchanged from before this rewiring. */
export function buildEvidenceReviewEntry(commit, report, unpublishable) {
  return {
    commit,
    filesReviewed: report.inventory.reviewed,
    findings: report.findings.length,
    unpublishable,
    tokens: report.spend.total,
  };
}

function subjectOf(repo, commit) {
  return execFileSync("git", ["log", "-1", "--format=%s", commit], {
    cwd: repo,
    encoding: "utf8",
    env: { PATH: FIXED_PATH },
  }).trim();
}

// -------------------------------------------------------------------------------------------------
// Orchestration
// -------------------------------------------------------------------------------------------------

/**
 * Runs the whole script end to end against injected `deps`, never calling `process.exit` itself —
 * mirrors `src/cli.ts`'s own `runCli`/`MainDeps` split. This is what lets
 * `corpus/real-diffs.test.mjs` drive this with a stub `runLocalReview` and a real, hermetic
 * throwaway git repository, asserting the printed output and the written evidence without ever
 * spending a token or reaching a real model endpoint.
 */
export async function run(deps) {
  const parsed = parseArgs(deps.argv);
  if (!parsed.ok) throw new Error(parsed.message);
  const { repo, commits, evidencePath } = parsed;

  const config = buildEngineRuntimeConfig(deps.env);
  const profile = await loadCompiledProfile(repo);
  const ctx = gitContextFor(repo);
  const commitDeps = {
    ctx,
    repo,
    profile,
    config,
    env: deps.env,
    runLocalReview: deps.runLocalReview,
    createDiagnostics: deps.createDiagnostics,
  };

  let findingCount = 0;
  let tokenCount = 0;
  let unpublishable = 0;
  const evidenceReviews = [];

  for (const commit of commits) {
    try {
      const { report, unpublishable: unpublishableHere } = await reviewCommit(commitDeps, commit);
      findingCount += report.findings.length;
      tokenCount += report.spend.total;
      unpublishable += unpublishableHere;

      deps.log(formatCommitHeader(commit, subjectOf(repo, commit)));
      deps.log(
        formatCommitSummary({
          outcome: report.outcome,
          reviewed: report.inventory.reviewed,
          findingCount: report.findings.length,
          unpublishableCount: unpublishableHere,
          tokens: report.spend.total,
        }),
      );
      for (const finding of report.findings) {
        for (const line of formatFindingLines(finding)) deps.log(line);
      }
      evidenceReviews.push(buildEvidenceReviewEntry(commit, report, unpublishableHere));
    } catch (error) {
      deps.log(`\n=== ${commit}  ERROR ${String(error).slice(0, 200)}`);
    }
  }

  deps.log(
    formatAggregateLine({ findingCount, commitCount: commits.length, unpublishable, tokenCount }),
  );

  if (evidencePath !== null) {
    const evidence = {
      reviews: evidenceReviews,
      aggregate: computeAggregate({
        commitCount: commits.length,
        findingCount,
        unpublishable,
        tokenCount,
      }),
    };
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    deps.log(`evidence  ${evidencePath}`);
  }
}

function isEntryModule() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

// Only run when executed directly (`node corpus/real-diffs.mjs`), never when imported by a test —
// mirrors `corpus/arena.mjs`'s identical guard, so `corpus/real-diffs.test.mjs` can import every
// function above with zero risk of starting a real, paid review.
if (isEntryModule()) {
  try {
    await run({
      argv: process.argv.slice(2),
      env: process.env,
      log: (text) => {
        console.log(text);
      },
      runLocalReview: performLocalReview,
      createDiagnostics,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
