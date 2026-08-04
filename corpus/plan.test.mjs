import assert from "node:assert/strict";
import { test } from "node:test";

import { registerTsExtensionHooks } from "./rule-source.mjs";

/**
 * Hermetic coverage for the gap corpus/run.mjs's header comment names: the corpus measured the
 * engine, classification, and the deterministic gate, but never the PUBLISHER, so intra-run
 * deduplication and sanitizer neutralization were invisible to every qualification number. Zero
 * model calls anywhere below — this file pins the plan mechanism `run.mjs`'s `planCaseFindings`
 * hooks in, directly, without a real engine run or a throwaway git repository behind it.
 *
 * `planPublication` is imported through the same `.js`→`.ts` resolve-hook mechanism `run.mjs`
 * itself uses for `sanitizeFindingBody`/`compareContracts`/`loadReviewProfile` — never a
 * reimplementation of sanitization, intra-run clustering, or cross-run dedup. `run.mjs` cannot be
 * imported directly (it is a script with top-level side effects — see `gate.test.mjs`'s own header
 * comment for the identical reason), so the small amount of context-building code below
 * (`makeContext`, `makeFinding`, `unreachableClient`) is a minimal, independent mirror of
 * `run.mjs`'s own `planCaseFindings`/`planItems`/`unreachableClient`, not an import of them.
 */

registerTsExtensionHooks();
const { planPublication } = await import("../src/publish/publisher.ts");
const { commitSha, repoPath } = await import("../src/core/brands.ts");
const { createSilentDiagnostics } = await import("../src/diagnostics/sink.ts");

const REF = { owner: "acme", repo: "widget" };
const IDENTITY = "keiko-for-quality[bot]";
const HEAD_SHA = commitSha("b".repeat(40));

/** A corpus case is always a first review: nothing has ever been posted against it, so cross-run
 *  dedup has nothing to compare against — see `run.mjs`'s own `EMPTY_PREFETCH`. */
const EMPTY_PREFETCH = { markers: new Set(), threads: [] };

/**
 * A `ReviewCommentApi` whose every method rejects AND records that it was called, so a test can
 * assert both "this did not throw" and, more precisely, "the API was never touched at all" — the
 * empty-prefetch invariant this file's last test pins directly.
 */
function unreachableClient() {
  const calls = [];
  const unreachable = (method) => () => {
    calls.push(method);
    return Promise.reject(new Error(`must not call ReviewCommentApi.${method}`));
  };
  return {
    calls,
    listReviewComments: unreachable("listReviewComments"),
    createReviewComment: unreachable("createReviewComment"),
    getReviewComment: unreachable("getReviewComment"),
  };
}

function makeContext(overrides = {}) {
  return {
    client: unreachableClient(),
    ref: REF,
    pullNumber: 7,
    headSha: HEAD_SHA,
    identity: IDENTITY,
    items: new Map(),
    ...overrides,
  };
}

function makeFinding(overrides = {}) {
  return {
    path: repoPath("src/retry.ts"),
    content:
      "The retry loop never resets the attempt counter, so it spins forever after one failure.",
    startLine: 10,
    endLine: 12,
    severity: "high",
    category: "bug",
    ...overrides,
  };
}

/** `planPublication(context, findings, diagnostics, prefetch)` with this file's own defaults,
 *  so every test below varies only the one argument it is actually about. */
async function plan(findings, context = makeContext()) {
  return planPublication(context, findings, createSilentDiagnostics(), EMPTY_PREFETCH);
}

/**
 * The measured shape from the 2026-08-04 qualification run (`corpus/evidence/
 * qualification-2026-08-04-rule-ab.md`): one case emitted the same finding three times, and — before
 * the publisher stage existed in `run.mjs` — the corpus counted that as three separate units
 * instead of the one a pull request would actually have received, because nothing suppressed the
 * repeats before scoring. Three BYTE-IDENTICAL findings at one location is the simplest instance of
 * that shape: same path, same line range, same body, so `areIntraRunDuplicates`
 * (`src/publish/similarity.ts`) clusters all three on both its checks — `linesOverlap` trivially
 * (identical ranges) and `similarByContent` trivially (identical token sets, overlap 1.0) — and
 * `clusterIntraRunDuplicates` keeps exactly one representative.
 */
test("three byte-identical findings at one location collapse to one survivor, suppressedIntraRun 2", async () => {
  const finding = makeFinding();
  const result = await plan([finding, finding, finding]);

  assert.equal(result.survivors.length, 1);
  assert.equal(result.survivors[0].sanitizedBody, finding.content);
  assert.equal(result.counters.suppressedIntraRun, 2);
  assert.equal(result.counters.suppressed, 2);
  assert.equal(result.counters.suppressedExactDuplicate, 0);
  assert.equal(result.counters.suppressedSimilar, 0);
  assert.equal(result.counters.suppressedDispositioned, 0);
  assert.equal(result.counters.rejectedSanitization, 0);
});

/**
 * `sanitizeFindingBody`'s neutralization pass (`src/publish/sanitize.ts`): a bare URL and an
 * `@mention`-shaped token (`@octokit/request`, indistinguishable in shape from a GitHub username —
 * see `MENTION`'s own doc comment) are reversible formatting slips, rewritten into inline code
 * rather than discarded. Production has already lost a correct, high-severity finding this way
 * (`Record<string, string>`, unbackticked — `sanitize.ts`'s own header comment), which is exactly
 * the failure this proves the plan does NOT reproduce.
 */
test("a body with a bare URL and an @mention-shaped token survives, neutralized into backticks, instead of being rejected", async () => {
  const body =
    "The retry handler links to https://example.test/docs for its backoff table and never " +
    "checks @octokit/request's own retry option before scheduling a second attempt.";
  const result = await plan([makeFinding({ content: body })]);

  assert.equal(result.counters.rejectedSanitization, 0);
  assert.equal(result.survivors.length, 1);
  const [survivor] = result.survivors;
  assert.ok(survivor.sanitizedBody.includes("`https://example.test/docs`"));
  assert.ok(survivor.sanitizedBody.includes("`@octokit/request`"));
  // Neutralization rewrites the ORIGINAL text into a code span; it never discards or paraphrases —
  // stripping the four backticks the two rewrites added must reproduce the raw body exactly.
  assert.equal(survivor.sanitizedBody.replace(/`/g, ""), body);
});

/**
 * A real HTML tag is meaning-bearing or actively dangerous, never a formatting accident — unlike the
 * three neutralizable shapes above, `sanitize.ts`'s own header comment is explicit that this keeps
 * failing closed. `<div>` is preceded by whitespace, not an identifier, so it cannot be mistaken for
 * the `Record<string, string>` generic shape neutralization does rewrite (`genericSpans`,
 * `sanitize.ts`) — this is unambiguously the HTML case.
 */
test("a body with real HTML stays rejected, counted in rejectedSanitization, and produces no survivor", async () => {
  const body =
    "This handler renders <div>{userInput}</div> without escaping it, which is a stored XSS risk.";
  const result = await plan([makeFinding({ content: body })]);

  assert.equal(result.survivors.length, 0);
  assert.equal(result.counters.rejectedSanitization, 1);
  assert.equal(result.counters.suppressedIntraRun ?? 0, 0);
  assert.equal(result.counters.suppressed, 0);
});

test("findings at distinct locations all survive untouched", async () => {
  const a = makeFinding({
    path: repoPath("src/a.ts"),
    startLine: 10,
    endLine: 12,
    content: "The exported parser accepts a negative length and reads past the buffer's end.",
  });
  const b = makeFinding({
    path: repoPath("src/b.ts"),
    startLine: 40,
    endLine: 42,
    content: "This endpoint never validates that the request payload stays under the size limit.",
  });
  const result = await plan([a, b]);

  assert.equal(result.survivors.length, 2);
  assert.deepEqual(
    result.survivors.map((s) => s.sanitizedBody).sort(),
    [a.content, b.content].sort(),
  );
  assert.equal(result.counters.suppressedIntraRun ?? 0, 0);
  assert.equal(result.counters.suppressed, 0);
  assert.equal(result.counters.rejectedSanitization, 0);
});

/**
 * The empty-prefetch invariant `run.mjs`'s own `EMPTY_PREFETCH` depends on: a corpus case is always
 * a first review of a synthetic pull request, so `planPublication` must never reach the review
 * comment API at all when handed a prefetch directly — it has no reason to call
 * `prefetchExistingConversations`, the API's only caller inside `planPublication`. The throwing
 * stub proves it: a call would reject and fail this test outright, and the explicit `calls`
 * assertion below proves the stronger claim that none of the three methods was even attempted, not
 * merely that a call (if any) happened not to throw.
 */
test("planPublication never calls the review-comment API when a prefetch is supplied", async () => {
  const client = unreachableClient();
  const context = makeContext({ client });
  const findings = [
    makeFinding(),
    makeFinding({
      path: repoPath("src/other.ts"),
      startLine: 1,
      endLine: 1,
      content: "x".repeat(20),
    }),
  ];

  const result = await planPublication(
    context,
    findings,
    createSilentDiagnostics(),
    EMPTY_PREFETCH,
  );

  assert.deepEqual(client.calls, []);
  assert.equal(result.survivors.length, 2);
});
