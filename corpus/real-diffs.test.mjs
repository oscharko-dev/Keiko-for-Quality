import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FIXED_PATH } from "./fixed-path.mjs";
import { registerTsExtensionHooks } from "./rule-source.mjs";
import {
  buildEngineRuntimeConfig,
  buildEvidenceReviewEntry,
  buildLocalReviewRequest,
  computeAggregate,
  countRejectedSanitization,
  formatAggregateLine,
  formatCommitHeader,
  formatCommitSummary,
  formatFindingLines,
  gitContextFor,
  loadCompiledProfile,
  parseArgs,
  resolveCommitPair,
  reviewCommit,
  run,
} from "./real-diffs.mjs";

/**
 * Hermetic coverage for the issue #99 rewiring: `corpus/real-diffs.mjs` now drives
 * `performLocalReview` (`src/review.ts`) instead of hand-rolling its own engine invocation. Nothing
 * below ever calls the real `performLocalReview`, reaches a model endpoint, or spends a token —
 * every test that needs one supplies its own stub `runLocalReview`, exactly the injection
 * `src/cli.test.ts` uses for `MainDeps.runLocalReview`. What IS real, in every test that needs it,
 * is git: a throwaway two-commit repository built the same way `corpus/gate.test.mjs` and
 * `corpus/run.mjs` build theirs, which is what lets this suite prove the request-assembly path
 * (`buildLocalReviewRequest`, `resolveCommitPair`, `loadCompiledProfile`,
 * `buildEngineRuntimeConfig`) is the real thing and not a second, hand-rolled approximation of it.
 *
 * `real-diffs.mjs` itself never runs its top-level review loop on import: everything the module
 * does when executed directly (`node corpus/real-diffs.mjs`) lives behind an `isEntryModule()`
 * guard at the bottom of that file, the identical pattern `corpus/arena.mjs`/`arena.test.mjs`
 * already use — so importing it here, as this file does, is safe.
 */

registerTsExtensionHooks();
const { createDiagnostics } = await import("../src/index.ts");

const VALID_ENV = {
  OCR_LLM_URL: "https://model.example.test/v1",
  OCR_LLM_TOKEN: "test-token",
  OCR_LLM_MODEL: "test-model",
};

const VALID_PROFILE = {
  version: 1,
  reviewRelevant: ["src/**"],
  deletionCritical: [],
  generated: [],
  excluded: [],
  benignWarnings: [],
};

/** Mirrors `src/cli.test.ts`'s own `baseReport` helper — the same minimal, fully-populated
 *  `LocalReviewReport` shape, so a stub `runLocalReview` here returns exactly what the real one
 *  contractually would. */
function baseReport(overrides = {}) {
  return {
    outcome: "complete",
    findings: [],
    spend: { engine: 0, classify: 0, total: 0, allotted: 0 },
    inventory: { total: 0, reviewable: 0, reviewed: 0 },
    ruleDigest: "a".repeat(64),
    engineVersion: "v1.8.4",
    cacheHits: 0,
    cacheMisses: 0,
    ...overrides,
  };
}

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

/** A throwaway two-commit repository (base, head) carrying a minimal valid profile — a smaller
 *  mirror of `corpus/run.mjs`'s own `buildRepo`, not an import of it (run.mjs cannot be imported;
 *  see `corpus/gate.test.mjs`'s header comment). */
function buildRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kfq-real-diffs-test-"));
  git(["init", "-q", "-b", "main"], dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "base", "--no-gpg-sign"], dir);
  writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "head", "--no-gpg-sign"], dir);
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github/keiko-for-quality.json"), JSON.stringify(VALID_PROFILE));
  return dir;
}

function headShaOf(dir) {
  return git(["rev-parse", "HEAD"], dir).trim();
}

// ---------------------------------------------------------------------------------------------
// parseArgs — pure.
// ---------------------------------------------------------------------------------------------

test("parseArgs parses a repository and a single commit", () => {
  assert.deepEqual(parseArgs(["/repo", "abc123"]), {
    ok: true,
    repo: "/repo",
    commits: ["abc123"],
    evidencePath: null,
  });
});

test("parseArgs parses multiple commits", () => {
  const parsed = parseArgs(["/repo", "a", "b", "c"]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.commits, ["a", "b", "c"]);
});

test("parseArgs extracts --evidence from anywhere in argv, leaving repo/commits untouched", () => {
  assert.deepEqual(parseArgs(["/repo", "--evidence", "/tmp/e.json", "a"]), {
    ok: true,
    repo: "/repo",
    commits: ["a"],
    evidencePath: "/tmp/e.json",
  });
  assert.deepEqual(parseArgs(["--evidence", "/tmp/e.json", "/repo", "a"]), {
    ok: true,
    repo: "/repo",
    commits: ["a"],
    evidencePath: "/tmp/e.json",
  });
});

test("parseArgs rejects --evidence with no following value", () => {
  assert.equal(parseArgs(["/repo", "a", "--evidence"]).ok, false);
});

test("parseArgs rejects a missing repository or commit list", () => {
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(["/repo"]).ok, false);
});

// ---------------------------------------------------------------------------------------------
// buildEngineRuntimeConfig — reuses the real `parseRuntimeConfig` (src/config/runtime.ts); these
// tests pin that OCR_LLM_* still means what it always meant, and that a missing credential-shaped
// input is refused up front rather than discovered per commit.
// ---------------------------------------------------------------------------------------------

test("buildEngineRuntimeConfig builds an openai RuntimeConfig from OCR_LLM_* variables", () => {
  const config = buildEngineRuntimeConfig(VALID_ENV);
  assert.equal(config.protocol, "openai");
  assert.equal(config.endpoint, VALID_ENV.OCR_LLM_URL);
  assert.equal(config.model, VALID_ENV.OCR_LLM_MODEL);
  assert.equal(config.tokenEnvName, "OCR_LLM_TOKEN");
  // Generous relative to action.yml's own defaults, deliberately — see this function's own doc
  // comment in real-diffs.mjs for why a corpus real-diff run is not sized like a pull request.
  assert.equal(config.reviewTimeoutSeconds, 21_600);
  assert.equal(config.tokenBudget, 6_000_000);
  assert.equal(config.maxFindings, 500);
});

test("buildEngineRuntimeConfig selects the anthropic protocol when OCR_USE_ANTHROPIC=true", () => {
  assert.equal(
    buildEngineRuntimeConfig({ ...VALID_ENV, OCR_USE_ANTHROPIC: "true" }).protocol,
    "anthropic",
  );
  assert.equal(
    buildEngineRuntimeConfig({ ...VALID_ENV, OCR_USE_ANTHROPIC: "false" }).protocol,
    "openai",
  );
});

test("buildEngineRuntimeConfig rejects a missing OCR_LLM_URL instead of deferring to a per-commit failure", () => {
  assert.throws(() => buildEngineRuntimeConfig({ OCR_LLM_MODEL: "m", OCR_LLM_TOKEN: "t" }));
});

test("buildEngineRuntimeConfig rejects a non-https OCR_LLM_URL", () => {
  assert.throws(() =>
    buildEngineRuntimeConfig({ ...VALID_ENV, OCR_LLM_URL: "http://insecure.example.test" }),
  );
});

// ---------------------------------------------------------------------------------------------
// countRejectedSanitization — pure.
// ---------------------------------------------------------------------------------------------

test("countRejectedSanitization reads only the final local-report count", () => {
  assert.equal(countRejectedSanitization({ quality: { rejectedSanitization: 1 } }), 1);
});

test("countRejectedSanitization returns 0 for a report without the final count", () => {
  assert.equal(countRejectedSanitization({}), 0);
  assert.equal(countRejectedSanitization({ quality: {} }), 0);
});

// ---------------------------------------------------------------------------------------------
// Rendering — pure.
// ---------------------------------------------------------------------------------------------

test("formatFindingLines renders classification, location, title, and a length-bounded body", () => {
  const lines = formatFindingLines({
    path: "src/a.ts",
    startLine: 10,
    endLine: 12,
    category: "bug",
    severity: "high",
    body: `The retry loop never resets its counter.\n${"x".repeat(400)}`,
  });
  assert.equal(lines[0], "    - high/bug  src/a.ts:10-12");
  assert.equal(lines[1], "      The retry loop never resets its counter.");
  assert.equal(lines[2].slice(6).length, 300);
});

test("formatFindingLines falls back to unclassified when category/severity are absent", () => {
  const lines = formatFindingLines({
    path: "src/a.ts",
    startLine: 1,
    endLine: 1,
    body: "Just one line, nothing more.",
  });
  assert.equal(lines[0], "    - unclassified/unclassified  src/a.ts:1-1");
  assert.equal(lines.length, 2);
});

test("formatCommitHeader", () => {
  assert.equal(formatCommitHeader("abc123", "Fix the thing"), "\n=== abc123  Fix the thing");
});

test("formatCommitSummary replaces the raw engine's status with the settlement outcome", () => {
  const line = formatCommitSummary({
    outcome: "complete",
    reviewed: 3,
    findingCount: 2,
    unpublishableCount: 1,
    tokens: 999,
  });
  assert.equal(line, "    outcome=complete reviewed=3 findings=2 unpublishable=1 tokens=999");
});

test("formatAggregateLine", () => {
  const line = formatAggregateLine({
    findingCount: 2,
    commitCount: 4,
    unpublishable: 1,
    tokenCount: 800,
  });
  assert.equal(
    line,
    "\n2 finding(s) over 4 commit(s), 1 unpublishable, 800 tokens (200 per review)",
  );
});

test("computeAggregate computes tokensPerReview and tokensPerFinding", () => {
  assert.deepEqual(
    computeAggregate({ commitCount: 4, findingCount: 5, unpublishable: 1, tokenCount: 1000 }),
    {
      commits: 4,
      findings: 5,
      unpublishable: 1,
      tokens: 1000,
      tokensPerReview: 250,
      tokensPerFinding: 200,
    },
  );
});

test("computeAggregate reports tokensPerFinding as null, not a number over a zero denominator", () => {
  const aggregate = computeAggregate({
    commitCount: 2,
    findingCount: 0,
    unpublishable: 0,
    tokenCount: 40,
  });
  assert.equal(aggregate.tokensPerFinding, null);
  assert.equal(aggregate.tokensPerReview, 20);
});

test("buildEvidenceReviewEntry maps a LocalReviewReport onto the evidence schema's existing field names", () => {
  const report = baseReport({
    findings: [{ path: "src/a.ts", startLine: 1, endLine: 1, body: "x" }],
    spend: { engine: 10, classify: 5, total: 15, allotted: 100 },
    inventory: { total: 2, reviewable: 2, reviewed: 2 },
  });
  assert.deepEqual(buildEvidenceReviewEntry("abc123", report, 3), {
    commit: "abc123",
    filesReviewed: 2,
    findings: 1,
    unpublishable: 3,
    tokens: 15,
  });
});

// ---------------------------------------------------------------------------------------------
// Request assembly against a real, hermetic git repository — no model, no network. Proves
// `buildLocalReviewRequest` is the same assembly `src/cli.ts`'s `prepareRequest` performs, not a
// second, hand-rolled approximation of it.
// ---------------------------------------------------------------------------------------------

test("gitContextFor uses the corpus's hardened FIXED_PATH rather than an inherited PATH", () => {
  assert.deepEqual(gitContextFor("/some/repo"), {
    cwd: "/some/repo",
    timeoutMs: 120_000,
    pathValue: FIXED_PATH,
  });
});

test("resolveCommitPair resolves <commit>~1 and <commit> to the same shas git itself reports", async () => {
  const dir = buildRepo();
  try {
    const head = headShaOf(dir);
    const base = git(["rev-parse", "HEAD~1"], dir).trim();
    const pair = await resolveCommitPair(gitContextFor(dir), head);
    assert.equal(pair.head, head);
    assert.equal(pair.base, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCommitPair rejects a commit that does not exist in the repository", async () => {
  const dir = buildRepo();
  try {
    await assert.rejects(() => resolveCommitPair(gitContextFor(dir), "not-a-real-commit"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCompiledProfile compiles the repository's own profile through the production loader", async () => {
  const dir = buildRepo();
  try {
    const profile = await loadCompiledProfile(dir);
    assert.equal(profile.profile.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCompiledProfile rejects a repository that carries no profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kfq-real-diffs-test-noprofile-"));
  try {
    await assert.rejects(() => loadCompiledProfile(dir), /no profile at/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalReviewRequest assembles the same field set src/cli.ts's prepareRequest builds, with no guidelines and the corpus's own FIXED_PATH", async () => {
  const dir = buildRepo();
  try {
    const head = headShaOf(dir);
    const ctx = gitContextFor(dir);
    const profile = await loadCompiledProfile(dir);
    const config = buildEngineRuntimeConfig(VALID_ENV);
    const request = await buildLocalReviewRequest({
      ctx,
      repo: dir,
      commit: head,
      profile,
      config,
      env: VALID_ENV,
    });
    assert.equal(request.head, head);
    assert.equal(request.base, git(["rev-parse", "HEAD~1"], dir).trim());
    assert.equal(request.repositoryPath, dir);
    assert.equal(request.config, config);
    assert.equal(request.profile, profile);
    assert.deepEqual(request.guidelines, { paths: [] });
    assert.equal(request.env, VALID_ENV);
    assert.equal(request.pathValue, FIXED_PATH);
    // No `--store` flag exists on this script; `cacheStore` must be genuinely absent, not `undefined`
    // — `exactOptionalPropertyTypes` is what `LocalReviewRequest.cacheStore?` relies on in the real
    // pipeline, so this pins the same "absent key, not an undefined value" shape at the boundary.
    assert.ok(!("cacheStore" in request));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// reviewCommit — the one seam that would spend real tokens in production. `runLocalReview` is
// always a local stub below; it is never the real `performLocalReview`.
// ---------------------------------------------------------------------------------------------

test("reviewCommit builds a real request, calls the injected runLocalReview exactly once, and counts final unpublishable findings", async () => {
  const dir = buildRepo();
  try {
    const head = headShaOf(dir);
    const ctx = gitContextFor(dir);
    const profile = await loadCompiledProfile(dir);
    const config = buildEngineRuntimeConfig(VALID_ENV);
    let calls = 0;
    let seenRequest;
    const runLocalReview = async (request, diagnostics) => {
      calls += 1;
      seenRequest = request;
      // The provisional rejections are not publication losses. Only the final rollup counts.
      diagnostics.record("publish.finding_rejected_sanitization", {});
      diagnostics.record("publish.finding_published", {});
      diagnostics.record("publish.finding_rejected_sanitization", {});
      return baseReport({
        quality: {
          evidenceWithheld: 0,
          rankedOut: 0,
          verificationUndecided: 0,
          rejectedSanitization: 1,
        },
        findings: [
          {
            path: "src/a.ts",
            startLine: 1,
            endLine: 1,
            category: "bug",
            severity: "high",
            body: "x",
          },
        ],
      });
    };
    const deps = {
      ctx,
      repo: dir,
      profile,
      config,
      env: VALID_ENV,
      runLocalReview,
      createDiagnostics,
    };

    const { report, unpublishable } = await reviewCommit(deps, head);

    assert.equal(calls, 1);
    assert.equal(unpublishable, 1);
    assert.equal(report.findings.length, 1);
    assert.equal(seenRequest.head, head);
    assert.equal(seenRequest.repositoryPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewCommit reports 0 unpublishable when the sink recorded no rejection", async () => {
  const dir = buildRepo();
  try {
    const head = headShaOf(dir);
    const deps = {
      ctx: gitContextFor(dir),
      repo: dir,
      profile: await loadCompiledProfile(dir),
      config: buildEngineRuntimeConfig(VALID_ENV),
      env: VALID_ENV,
      runLocalReview: async () => baseReport(),
      createDiagnostics,
    };
    const { unpublishable } = await reviewCommit(deps, head);
    assert.equal(unpublishable, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// run() — full per-commit orchestration and printing, against injected deps only.
// ---------------------------------------------------------------------------------------------

test("run() prints the commit header, outcome summary, and finding lines from the stubbed report", async () => {
  const dir = buildRepo();
  try {
    const head = headShaOf(dir);
    const lines = [];
    const runLocalReview = async () =>
      baseReport({
        outcome: "complete",
        findings: [
          {
            path: "src/a.ts",
            startLine: 1,
            endLine: 1,
            category: "bug",
            severity: "high",
            body: "Title line.\nMore detail here.",
          },
        ],
        spend: { engine: 111, classify: 22, total: 133, allotted: 200_000 },
        inventory: { total: 1, reviewable: 1, reviewed: 1 },
      });

    await run({
      argv: [dir, head],
      env: VALID_ENV,
      log: (text) => lines.push(text),
      runLocalReview,
      createDiagnostics,
    });

    const output = lines.join("\n");
    assert.ok(output.includes(`=== ${head}`));
    assert.ok(output.includes("outcome=complete reviewed=1 findings=1 unpublishable=0 tokens=133"));
    assert.ok(output.includes("- high/bug  src/a.ts:1-1"));
    assert.ok(output.includes("Title line."));
    assert.ok(
      output.includes(
        "1 finding(s) over 1 commit(s), 0 unpublishable, 133 tokens (133 per review)",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run() writes an --evidence file whose aggregate matches the stubbed report", async () => {
  const dir = buildRepo();
  const evidenceDir = mkdtempSync(join(tmpdir(), "kfq-real-diffs-evidence-"));
  const evidencePath = join(evidenceDir, "evidence.json");
  try {
    const head = headShaOf(dir);
    const runLocalReview = async () =>
      baseReport({
        findings: [
          {
            path: "src/a.ts",
            startLine: 1,
            endLine: 1,
            category: "bug",
            severity: "high",
            body: "x",
          },
        ],
        spend: { engine: 50, classify: 0, total: 50, allotted: 100_000 },
        inventory: { total: 1, reviewable: 1, reviewed: 1 },
      });

    await run({
      argv: ["--evidence", evidencePath, dir, head],
      env: VALID_ENV,
      log: () => {},
      runLocalReview,
      createDiagnostics,
    });

    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.deepEqual(evidence.aggregate, {
      commits: 1,
      findings: 1,
      unpublishable: 0,
      tokens: 50,
      tokensPerReview: 50,
      tokensPerFinding: 50,
    });
    assert.equal(evidence.reviews.length, 1);
    assert.deepEqual(evidence.reviews[0], {
      commit: head,
      filesReviewed: 1,
      findings: 1,
      unpublishable: 0,
      tokens: 50,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test("run() records an ERROR line and never calls runLocalReview for a commit that cannot be resolved", async () => {
  const dir = buildRepo();
  try {
    const lines = [];
    let calls = 0;
    const runLocalReview = async () => {
      calls += 1;
      return baseReport();
    };

    await run({
      argv: [dir, "not-a-real-commit"],
      env: VALID_ENV,
      log: (text) => lines.push(text),
      runLocalReview,
      createDiagnostics,
    });

    assert.equal(calls, 0);
    assert.ok(lines.some((line) => line.includes("ERROR")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The hard constraint this pins: the script must keep refusing to run without an explicit model
 * credential in place, exactly as it did before this rewiring — now enforced by
 * `buildEngineRuntimeConfig` (`parseRuntimeConfig`'s https-only endpoint check) failing the WHOLE
 * run before any commit is attempted, rather than each commit failing individually against an
 * empty endpoint. `runLocalReview` must never be reached.
 */
test("run() refuses to run without OCR_LLM_URL configured, and never calls runLocalReview", async () => {
  const dir = buildRepo();
  try {
    const head = headShaOf(dir);
    let calls = 0;
    const runLocalReview = async () => {
      calls += 1;
      return baseReport();
    };

    await assert.rejects(() =>
      run({
        argv: [dir, head],
        env: {},
        log: () => {},
        runLocalReview,
        createDiagnostics,
      }),
    );

    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run() rejects a missing repository or commit list the same way parseArgs does", async () => {
  let calls = 0;
  const runLocalReview = async () => {
    calls += 1;
    return baseReport();
  };
  await assert.rejects(() =>
    run({ argv: [], env: VALID_ENV, log: () => {}, runLocalReview, createDiagnostics }),
  );
  assert.equal(calls, 0);
});
