import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARENA_BOT_ORDER,
  classifyAuthor,
  buildIdentityTable,
  isIncompleteNotice,
  lineWindow,
  rangesOverlap,
  normalizeForSimilarity,
  jaccardSimilarity,
  clusterDuplicateFindings,
  clusterAcrossBots,
  extractConversations,
  buildPrRecord,
  buildEvidenceDocument,
} from "./arena-lib.mjs";
import {
  PR_2926_RAW_THREADS,
  PR_2926_HEAD_SHA,
  PR_2924_RAW_THREADS,
  PR_2924_HEAD_SHA,
} from "./fixtures/arena-fixtures.mjs";

/**
 * Tests for the arena scoreboard's pure computation (issue #39).
 *
 * Run with `node --test corpus/*.test.mjs`. This module has no network access and needs none: the
 * fetch layer (`corpus/arena-fetch.mjs`) is impure and untested by design (see its header comment),
 * and everything exercised here is a pure function over fixture data shaped like the real GraphQL
 * `reviewThreads` connection (`corpus/fixtures/arena-fixtures.mjs`).
 *
 * The duplicate-clustering tests are a direct regression pin for bug #38: Keiko for Quality posted
 * three textually-different paraphrases of one claim at `codingContextRoutes.ts:236` on Keiko pull
 * request #2926. The fixture reproduces that shape (three distinct bodies, one location); the test
 * fails if the normalizer stops collapsing them, which is the whole point of shipping this
 * scoreboard as bug #38's regression meter — after that fix lands, a live re-run is expected to
 * show Keiko for Quality's duplicate-variant count fall to zero, and this fixture-based test keeps
 * proving the *mechanism* that would detect a regression either way.
 */

test("classifyAuthor matches both REST ([bot] suffix) and GraphQL (bare) login shapes", () => {
  assert.equal(classifyAuthor("keiko-for-quality[bot]", "Bot").arenaId, "kfq");
  assert.equal(classifyAuthor("keiko-for-quality", "Bot").arenaId, "kfq");
  assert.equal(classifyAuthor("KEIKO-FOR-QUALITY[BOT]", "Bot").arenaId, "kfq");
  assert.equal(classifyAuthor("coderabbitai[bot]", "Bot").arenaId, "coderabbit");
  assert.equal(classifyAuthor("coderabbitai", "Bot").arenaId, "coderabbit");
  assert.equal(classifyAuthor("chatgpt-codex-connector[bot]", "Bot").arenaId, "codex");
  assert.equal(classifyAuthor("chatgpt-codex-connector", "Bot").arenaId, "codex");
});

test("classifyAuthor leaves an unrecognized login unattributed rather than guessing", () => {
  const classified = classifyAuthor("oscharko", "User");
  assert.equal(classified.arenaId, null);
  assert.equal(classified.rawLogin, "oscharko");
  assert.equal(classified.identityMismatch, false);
});

test("classifyAuthor handles a deleted/null author without throwing", () => {
  const classified = classifyAuthor(null, null);
  assert.equal(classified.arenaId, null);
  assert.equal(classified.rawLogin, "[deleted]");
  assert.equal(classified.typename, "Unknown");
});

test("classifyAuthor flags a known bot name reported under a non-Bot account type", () => {
  const classified = classifyAuthor("coderabbitai", "User");
  assert.equal(classified.arenaId, "coderabbit");
  assert.equal(
    classified.identityMismatch,
    true,
    "a login match without a Bot typename must be flagged, not silently trusted",
  );
});

test("buildIdentityTable counts every observed login and keeps distinct raw forms separate", () => {
  const table = buildIdentityTable([
    { login: "keiko-for-quality[bot]", typename: "Bot" },
    { login: "keiko-for-quality[bot]", typename: "Bot" },
    { login: "keiko-for-quality", typename: "Bot" },
    { login: "oscharko", typename: "User" },
  ]);
  assert.deepEqual(
    table.knownBots.map((bot) => bot.arenaId),
    ARENA_BOT_ORDER,
    "knownBots is always the full roster, in the canonical order, regardless of what was observed",
  );
  const byLogin = Object.fromEntries(table.observedLogins.map((entry) => [entry.rawLogin, entry]));
  assert.equal(byLogin["keiko-for-quality[bot]"].commentCount, 2);
  assert.equal(byLogin["keiko-for-quality"].commentCount, 1);
  assert.equal(byLogin["keiko-for-quality"].arenaId, "kfq");
  assert.equal(byLogin.oscharko.arenaId, null);
  assert.deepEqual(
    table.observedLogins.map((entry) => entry.rawLogin),
    [...table.observedLogins.map((entry) => entry.rawLogin)].sort((a, b) => a.localeCompare(b)),
    "observedLogins is sorted for deterministic output",
  );
});

test("isIncompleteNotice matches only the fixed settlement-notice sentence", () => {
  assert.equal(
    isIncompleteNotice(
      "_⚠️ Coverage_ | _🟠 Major_\n\n**This change was not fully reviewed.**\n\nReason code: `x`.",
    ),
    true,
  );
  assert.equal(isIncompleteNotice("**This finding was not fully explained.**"), false);
  assert.equal(
    isIncompleteNotice("An ordinary finding body with no notice language at all."),
    false,
  );
});

test("lineWindow prefers the original (diff-stable) position over the live one", () => {
  const outdated = { line: null, originalLine: 33, startLine: null, originalStartLine: 31 };
  assert.deepEqual(lineWindow(outdated), { startLine: 31, endLine: 33, isFileLevel: false });
});

test("lineWindow falls back to the live position only when the original is absent", () => {
  const liveOnly = { line: 10, originalLine: null, startLine: 8, originalStartLine: null };
  assert.deepEqual(lineWindow(liveOnly), { startLine: 8, endLine: 10, isFileLevel: false });
});

test("lineWindow treats a single-line comment's start as its own line", () => {
  const singleLine = { line: 5, originalLine: 5, startLine: null, originalStartLine: null };
  assert.deepEqual(lineWindow(singleLine), { startLine: 5, endLine: 5, isFileLevel: false });
});

test("lineWindow reports a whole-file comment as file-level with no numeric window", () => {
  const fileLevel = { line: null, originalLine: null, startLine: null, originalStartLine: null };
  assert.deepEqual(lineWindow(fileLevel), { startLine: null, endLine: null, isFileLevel: true });
});

test("rangesOverlap is true for intersecting windows and false for disjoint ones", () => {
  const a = { startLine: 10, endLine: 20, isFileLevel: false };
  const b = { startLine: 18, endLine: 25, isFileLevel: false };
  const c = { startLine: 30, endLine: 40, isFileLevel: false };
  assert.equal(rangesOverlap(a, b), true);
  assert.equal(rangesOverlap(a, c), false);
  assert.equal(rangesOverlap(b, c), false);
});

test("rangesOverlap treats a file-level window as overlapping any window on the same path", () => {
  const fileLevel = { startLine: null, endLine: null, isFileLevel: true };
  const specific = { startLine: 400, endLine: 410, isFileLevel: false };
  assert.equal(rangesOverlap(fileLevel, specific), true);
  assert.equal(rangesOverlap(specific, fileLevel), true);
});

test("normalizeForSimilarity strips the category badge, the details block, and the marker", () => {
  const body =
    "_🐛 Correctness_ | _🟠 Major_\n\n**A title.**\n\nSome prose about a widget.\n\n<details>\n" +
    "<summary>🤖 Prompt for AI agents</summary>\n\n```\nirrelevant boilerplate text\n```\n\n" +
    "</details>\n\n<!-- keiko-for-quality:v1:abc -->";
  const tokens = normalizeForSimilarity(body);
  assert.ok(tokens.has("widget"));
  assert.ok(tokens.has("title"));
  assert.ok(!tokens.has("correctness"), "the badge line must not contribute tokens");
  assert.ok(!tokens.has("boilerplate"), "the details block must not contribute tokens");
  assert.ok(!tokens.has("abc"), "the trailing marker comment must not contribute tokens");
});

test("jaccardSimilarity is 0 for two token sets with nothing in common, including two empty sets", () => {
  assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
  assert.equal(jaccardSimilarity(new Set(["a"]), new Set(["b"])), 0);
});

test("jaccardSimilarity is 1 for two identical non-empty token sets", () => {
  assert.equal(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "b"])), 1);
});

// ---------------------------------------------------------------------------------------------
// Duplicate clustering: the bug #38 regression pin.
// ---------------------------------------------------------------------------------------------

function findingsFor(rawThreads, arenaId) {
  return extractConversations(rawThreads).conversations.filter(
    (conversation) => conversation.arenaId === arenaId && !conversation.isNotice,
  );
}

test("three paraphrase duplicates at codingContextRoutes.ts:236 collapse to one finding plus two duplicate variants", () => {
  const kfqFindings = findingsFor(PR_2926_RAW_THREADS, "kfq");
  assert.equal(kfqFindings.length, 3, "fixture setup: three raw kfq findings expected");
  const clusters = clusterDuplicateFindings(kfqFindings);
  assert.equal(clusters.length, 1, "the three paraphrases must land in exactly one cluster");
  assert.equal(clusters[0].memberCount, 3);
  assert.equal(clusters[0].path, "packages/keiko-server/src/coding-context/codingContextRoutes.ts");
  assert.deepEqual(clusters[0].memberDatabaseIds, [5001, 5002, 5003]);
});

test("three distinct CodeRabbit findings at overlapping lines do not collapse", () => {
  const settingsFindings = findingsFor(PR_2926_RAW_THREADS, "coderabbit").filter((finding) =>
    finding.path.endsWith("SettingsPanel.tsx"),
  );
  assert.equal(
    settingsFindings.length,
    3,
    "fixture setup: three raw SettingsPanel findings expected",
  );
  const clusters = clusterDuplicateFindings(settingsFindings);
  assert.equal(
    clusters.length,
    3,
    "overlapping location alone must not merge genuinely distinct findings",
  );
  assert.ok(clusters.every((cluster) => cluster.memberCount === 1));
});

test("findings on the same path at non-overlapping windows are never clustered", () => {
  const vaultFindings = findingsFor(PR_2926_RAW_THREADS, "coderabbit").filter((finding) =>
    finding.path.endsWith("tombstones.ts"),
  );
  assert.equal(vaultFindings.length, 3);
  const clusters = clusterDuplicateFindings(vaultFindings);
  assert.equal(clusters.length, 3);
});

test("clusterDuplicateFindings never merges findings on different paths", () => {
  const a = {
    path: "a.ts",
    startLine: 1,
    endLine: 5,
    isFileLevel: false,
    databaseId: 1,
    createdAt: "2026-01-01T00:00:00Z",
    body: "**Same words same words same words.**",
  };
  const b = { ...a, path: "b.ts", databaseId: 2 };
  const clusters = clusterDuplicateFindings([a, b]);
  assert.equal(clusters.length, 2);
});

// ---------------------------------------------------------------------------------------------
// Cross-bot overlap.
// ---------------------------------------------------------------------------------------------

test("clusterAcrossBots groups distinct findings from different bots at an overlapping location into one consensus cluster", () => {
  const { conversations } = extractConversations(PR_2926_RAW_THREADS);
  const byBot = {
    kfq: conversations.filter((c) => c.arenaId === "kfq" && !c.isNotice).slice(0, 1),
    coderabbit: conversations.filter((c) => c.arenaId === "coderabbit" && c.databaseId === 5101),
    codex: conversations.filter((c) => c.arenaId === "codex"),
  };
  const clusters = clusterAcrossBots(byBot);
  const routesCluster = clusters.find((cluster) => cluster.bots.length === 3);
  assert.ok(routesCluster, "expected one all-three consensus cluster");
  assert.deepEqual(routesCluster.bots, ["kfq", "coderabbit", "codex"]);
  // Union of kfq's 235-236, CodeRabbit's 235-243, and Codex's 236-240.
  assert.equal(routesCluster.startLine, 235);
  assert.equal(routesCluster.endLine, 243);
});

test("clusterAcrossBots never joins two findings from the same bot, even at an identical window", () => {
  const shared = {
    path: "x.ts",
    startLine: 1,
    endLine: 5,
    isFileLevel: false,
    databaseId: 1,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const byBot = {
    kfq: [
      { ...shared, databaseId: 1 },
      { ...shared, databaseId: 2 },
    ],
    coderabbit: [],
    codex: [],
  };
  const clusters = clusterAcrossBots(byBot);
  assert.equal(
    clusters.length,
    2,
    "same-bot findings must form separate singleton clusters, never merge with each other",
  );
  assert.ok(clusters.every((cluster) => cluster.bots.length === 1 && cluster.bots[0] === "kfq"));
});

test("a finding with no overlapping counterpart from another bot forms its own unique singleton cluster", () => {
  const byBot = {
    kfq: [],
    coderabbit: [
      {
        path: "solo.ts",
        startLine: 1,
        endLine: 2,
        isFileLevel: false,
        databaseId: 9,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    codex: [],
  };
  const clusters = clusterAcrossBots(byBot);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].bots, ["coderabbit"]);
});

// ---------------------------------------------------------------------------------------------
// extractConversations: raw-shape attribution, root-vs-reply, notices.
// ---------------------------------------------------------------------------------------------

test("extractConversations reads only the root comment as a conversation's identity, but counts replies in identityObservations", () => {
  const { conversations, identityObservations } = extractConversations(PR_2926_RAW_THREADS);
  // The third kfq thread carries a human reply; it must not appear as a conversation of its own.
  assert.equal(conversations.filter((c) => c.rawLogin === "oscharko").length, 0);
  assert.ok(identityObservations.some((observation) => observation.login === "oscharko"));
});

test("extractConversations marks the two ADR incomplete-review notices and excludes them from findings", () => {
  const { conversations } = extractConversations(PR_2926_RAW_THREADS);
  const adrConversations = conversations.filter((c) => c.path.includes("ADR-0117"));
  assert.equal(adrConversations.length, 2);
  assert.ok(adrConversations.every((c) => c.isNotice && c.arenaId === "kfq"));
});

test("extractConversations captures the commit each conversation's root comment was posted against", () => {
  const { conversations } = extractConversations(PR_2926_RAW_THREADS);
  const first = conversations.find((c) => c.databaseId === 5001);
  assert.equal(first.commitOid, "092f356678aa1b2c3d4e5f60718293a4b5c6d7e");
});

// ---------------------------------------------------------------------------------------------
// buildPrRecord / buildEvidenceDocument: integration, determinism, redaction.
// ---------------------------------------------------------------------------------------------

test("buildPrRecord reproduces the full per-bot scoreboard for the PR #2926 fixture", () => {
  const { conversations } = extractConversations(PR_2926_RAW_THREADS);
  const record = buildPrRecord({ number: 2926, headSha: PR_2926_HEAD_SHA }, conversations);

  assert.deepEqual(record.bots.kfq, {
    findingsPosted: 3,
    distinctFindings: 1,
    duplicateVariants: 2,
    incompleteNotices: 2,
    filesTouched: 2,
    threads: { resolved: 3, unresolved: 2, outdated: 0 },
    uniqueToBot: 0,
    coFound: { kfq: null, coderabbit: 1, codex: 1 },
    coFoundAllThree: 1,
  });
  assert.deepEqual(record.bots.coderabbit, {
    findingsPosted: 7,
    distinctFindings: 7,
    duplicateVariants: 0,
    incompleteNotices: 0,
    filesTouched: 3,
    threads: { resolved: 1, unresolved: 4, outdated: 2 },
    uniqueToBot: 6,
    coFound: { kfq: 1, coderabbit: null, codex: 1 },
    coFoundAllThree: 1,
  });
  assert.deepEqual(record.bots.codex, {
    findingsPosted: 1,
    distinctFindings: 1,
    duplicateVariants: 0,
    incompleteNotices: 0,
    filesTouched: 1,
    threads: { resolved: 0, unresolved: 1, outdated: 0 },
    uniqueToBot: 0,
    coFound: { kfq: 1, coderabbit: 1, codex: null },
    coFoundAllThree: 1,
  });
  assert.equal(record.duplicateClusters.length, 1);
  assert.equal(record.crossBotClusters.length, 1);
});

test("buildEvidenceDocument is byte-identical across two calls with the same input", () => {
  const prs = [
    { number: 2926, headSha: PR_2926_HEAD_SHA, ...extractConversations(PR_2926_RAW_THREADS) },
    { number: 2924, headSha: PR_2924_HEAD_SHA, ...extractConversations(PR_2924_RAW_THREADS) },
  ];
  const input = { repo: "oscharko-dev/Keiko", generatedAt: "2026-08-02T12:00:00Z", prs };
  const first = JSON.stringify(buildEvidenceDocument(input));
  const second = JSON.stringify(buildEvidenceDocument(input));
  assert.equal(first, second);
});

test("buildEvidenceDocument orders pull requests ascending by number regardless of input order", () => {
  const prs = [
    { number: 2926, headSha: PR_2926_HEAD_SHA, ...extractConversations(PR_2926_RAW_THREADS) },
    { number: 2924, headSha: PR_2924_HEAD_SHA, ...extractConversations(PR_2924_RAW_THREADS) },
  ];
  const document = buildEvidenceDocument({ repo: "oscharko-dev/Keiko", generatedAt: "x", prs });
  assert.deepEqual(
    document.pullRequests.map((pr) => pr.number),
    [2924, 2926],
  );
});

test("buildEvidenceDocument aggregates per-bot totals across every included pull request", () => {
  const prs = [
    { number: 2926, headSha: PR_2926_HEAD_SHA, ...extractConversations(PR_2926_RAW_THREADS) },
    { number: 2924, headSha: PR_2924_HEAD_SHA, ...extractConversations(PR_2924_RAW_THREADS) },
  ];
  const document = buildEvidenceDocument({ repo: "oscharko-dev/Keiko", generatedAt: "x", prs });
  assert.equal(document.aggregate.prCount, 2);
  assert.equal(document.aggregate.bots.kfq.findingsPosted, 4);
  assert.equal(document.aggregate.bots.kfq.distinctFindings, 2);
  assert.equal(document.aggregate.bots.kfq.duplicateVariants, 2);
  assert.equal(document.aggregate.bots.coderabbit.findingsPosted, 8);
  assert.equal(document.aggregate.bots.coderabbit.uniqueToBot, 7);
  assert.equal(document.aggregate.bots.codex.findingsPosted, 2);
  assert.equal(document.aggregate.bots.kfq.coFoundAllThree, 1);
});

test("buildEvidenceDocument never places a comment body, or any distinctive fragment of one, in its output", () => {
  const prs = [
    { number: 2926, headSha: PR_2926_HEAD_SHA, ...extractConversations(PR_2926_RAW_THREADS) },
  ];
  const serialized = JSON.stringify(
    buildEvidenceDocument({ repo: "oscharko-dev/Keiko", generatedAt: "x", prs }),
  );
  const distinctiveBodyFragments = [
    "missing-credentials",
    "fallback connector construction",
    "confirm dialog",
    "correlation id",
    "framework version",
    "negative TTL",
    "settlement.incomplete",
  ];
  for (const fragment of distinctiveBodyFragments) {
    assert.ok(!serialized.includes(fragment), `evidence document must not contain "${fragment}"`);
  }
});

test("buildEvidenceDocument's identity table reports both API shapes of the Codex login as one arena bot", () => {
  const prs = [
    { number: 2926, headSha: PR_2926_HEAD_SHA, ...extractConversations(PR_2926_RAW_THREADS) },
    { number: 2924, headSha: PR_2924_HEAD_SHA, ...extractConversations(PR_2924_RAW_THREADS) },
  ];
  const document = buildEvidenceDocument({ repo: "oscharko-dev/Keiko", generatedAt: "x", prs });
  const codexLogins = document.identity.observedLogins.filter((entry) => entry.arenaId === "codex");
  assert.deepEqual(codexLogins.map((entry) => entry.rawLogin).sort(), [
    "chatgpt-codex-connector",
    "chatgpt-codex-connector[bot]",
  ]);
  const humanEntry = document.identity.observedLogins.find(
    (entry) => entry.rawLogin === "oscharko",
  );
  assert.ok(humanEntry, "a human reply's login must still appear in the identity table");
  assert.equal(humanEntry.arenaId, null);
});
