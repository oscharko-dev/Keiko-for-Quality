import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildHarvestDocument,
  escapesRepository,
  isIsoDate,
  parsePrList,
  parseRepoArgument,
  realLocation,
  extractHarvestRecords,
  findRecallGaps,
  firstForeignReply,
  gradeRecord,
  tallyLabels,
} from "./harvest-lib.mjs";

/**
 * Hermetic, like the rest of `corpus/` — no network, no `gh`. The label matrix below is the part
 * that matters: every rule this harvest will ever distil comes from `refuted_confirmed`, and the
 * test that keeps that honest is the one where the prose says "already handled" and a later commit
 * edited that exact region anyway.
 */

const KFQ = "keiko-for-quality";

function comment(overrides = {}) {
  return {
    databaseId: 1,
    url: "https://example.invalid/1",
    body: "Reject records that include `voiceProfiles` — the payload reaches the wire unvalidated.",
    path: "src/voice.ts",
    line: 40,
    originalLine: 40,
    startLine: 40,
    originalStartLine: 40,
    createdAt: "2026-08-08T10:00:00Z",
    commit: { oid: "a".repeat(40) },
    author: { login: KFQ, __typename: "Bot" },
    replyTo: null,
    ...overrides,
  };
}

function thread(comments, overrides = {}) {
  return {
    id: "PRRT_1",
    isResolved: true,
    isOutdated: false,
    comments: { totalCount: comments.length, nodes: comments },
    ...overrides,
  };
}

function commitTouching(path, startLine, endLine, committedDate) {
  const patch = `@@ -${String(startLine)},3 +${String(startLine)},4 @@\n line\n+added\n line\n line`;
  return {
    sha: "b".repeat(40),
    committedDate,
    files: [{ path, previousPath: null, status: "modified", patch }],
  };
}

function commitElsewhere(committedDate) {
  return {
    sha: "c".repeat(40),
    committedDate,
    files: [
      {
        path: "src/unrelated.ts",
        previousPath: null,
        status: "modified",
        patch: "@@ -1,2 +1,3 @@\n a\n+b\n c",
      },
    ],
  };
}

test("keeps every reply body — the half the committed evidence document drops", () => {
  const { records } = extractHarvestRecords([
    thread([
      comment(),
      comment({
        databaseId: 2,
        body: "Refuted: the guard is at line 655.",
        author: { login: "oscharko-dev", __typename: "User" },
        replyTo: { databaseId: 1 },
      }),
    ]),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].replies.length, 1);
  assert.equal(records[0].replies[0].body, "Refuted: the guard is at line 655.");
  assert.equal(records[0].replies[0].isHuman, true);
  assert.equal(records[0].arenaId, "kfq");
});

test("a bot reply is marked as not human, from __typename rather than from the login", () => {
  const { records } = extractHarvestRecords([
    thread([
      comment(),
      comment({
        databaseId: 2,
        body: "Fixed in abc123.",
        // A login that reads human, reported by the API as a Bot: the typename is what decides.
        author: { login: "release-automation", __typename: "Bot" },
        replyTo: { databaseId: 1 },
      }),
    ]),
  ]);
  assert.equal(records[0].replies[0].isHuman, false);
});

test("the reviewer's own follow-up is not the reply that grades the finding", () => {
  const { records } = extractHarvestRecords([
    thread([
      comment(),
      comment({ databaseId: 2, body: "Still open.", replyTo: { databaseId: 1 } }),
      comment({
        databaseId: 3,
        body: "Refuted: already handled.",
        author: { login: "oscharko-dev", __typename: "User" },
        replyTo: { databaseId: 1 },
      }),
    ]),
  ]);
  assert.equal(firstForeignReply(records[0]).databaseId, 3);
});

test("a coverage notice is a notice, not a finding", () => {
  const { records } = extractHarvestRecords([
    thread([comment({ body: "This change was not fully reviewed." })]),
  ]);
  assert.equal(records[0].isNotice, true);
  const doc = buildHarvestDocument({
    repo: "o/r",
    generatedAt: "2026-08-09T00:00:00Z",
    prs: [{ number: 1, commits: [], records, recallGaps: [] }],
  });
  assert.equal(doc.aggregate.findings, 0);
});

// ---------------------------------------------------------------------------------------------
// The label matrix.
// ---------------------------------------------------------------------------------------------

function recordWithReply(body) {
  const { records } = extractHarvestRecords([
    thread([
      comment(),
      comment({
        databaseId: 2,
        body,
        author: { login: "oscharko-dev", __typename: "User" },
        replyTo: { databaseId: 1 },
      }),
    ]),
  ]);
  return records[0];
}

test("refuted prose plus an untouched region is the only label a rule may come from", () => {
  const graded = gradeRecord(recordWithReply("Refuted: the guard is at line 655."), [
    commitElsewhere("2026-08-08T12:00:00Z"),
  ]);
  assert.equal(graded.label, "refuted_confirmed");
  assert.equal(graded.gitClassification, "resolved_without_change");
});

/**
 * The guard the module exists for. "Already handled, not applicable" reads as a refutation to
 * `classifyReply` — and then a later commit edited exactly that region. Prose and behaviour
 * disagree, so this must never become a rule that silences the same finding forever.
 */
test("refuted prose contradicted by a later commit on that region is kept apart", () => {
  const graded = gradeRecord(
    recordWithReply("Not applicable — the sibling module already handles this."),
    [commitTouching("src/voice.ts", 40, 43, "2026-08-08T12:00:00Z")],
  );
  assert.equal(graded.replyVerdict, "refuted");
  assert.equal(graded.label, "refuted_contradicted");
});

test("fixed prose corroborated by a commit on that region is the recall side's ground truth", () => {
  const graded = gradeRecord(recordWithReply("Fixed in abc123."), [
    commitTouching("src/voice.ts", 40, 43, "2026-08-08T12:00:00Z"),
  ]);
  assert.equal(graded.label, "fixed_confirmed");
});

test("fixed prose git cannot corroborate is counted neither way", () => {
  const graded = gradeRecord(recordWithReply("Fixed in abc123."), [
    commitElsewhere("2026-08-08T12:00:00Z"),
  ]);
  assert.equal(graded.label, "fixed_unconfirmed");
});

test("an unanswered thread is a measurement failure, not a verdict", () => {
  const { records } = extractHarvestRecords([thread([comment()])]);
  assert.equal(gradeRecord(records[0], []).label, "unanswered");
});

test("a reply neither vocabulary can read is unclassified, never fixed", () => {
  assert.equal(gradeRecord(recordWithReply("Taking a look at this."), []).label, "unclassified");
});

/**
 * An absent measurement must not read as a passing one: with no commit timeline, a refutation
 * cannot be confirmed, so it lands in the label that is never distilled from.
 */
test("no commit timeline means no confirmation — refutations do not pass by default", () => {
  const graded = gradeRecord(recordWithReply("Refuted: the guard is at line 655."), []);
  // `refuted_unconfirmed`, deliberately NOT `refuted_contradicted`: nothing contradicted this
  // reply, git simply could not be asked. Folding the two together would report a contradiction
  // that was never observed, and the aggregate would carry that fiction as a count.
  assert.equal(graded.label, "refuted_unconfirmed");
  assert.equal(graded.gitClassification, "unavailable");
});

test("a rebase that unmaps the region is unconfirmed, not contradicted", () => {
  // A commit that renames the file away leaves `classifyActedUpon` unable to map the region.
  const gone = {
    sha: "d".repeat(40),
    committedDate: "2026-08-08T12:00:00Z",
    files: [
      { path: "src/renamed.ts", previousPath: "src/voice.ts", status: "renamed", patch: null },
    ],
  };
  const graded = gradeRecord(recordWithReply("Refuted: the guard is at line 655."), [gone]);
  assert.equal(graded.gitClassification, "outdated_by_rebase");
  assert.equal(graded.label, "refuted_unconfirmed");
});

// ---------------------------------------------------------------------------------------------
// Recall gaps.
// ---------------------------------------------------------------------------------------------

test("a cross-bot cluster this reviewer joined is not a gap", () => {
  const clusters = [{ path: "src/a.ts", bots: ["kfq", "coderabbit"], memberDatabaseIds: [10, 11] }];
  const actedUpon = new Map([
    [10, { arenaId: "kfq", classification: "acted_upon" }],
    [11, { arenaId: "coderabbit", classification: "acted_upon" }],
  ]);
  assert.deepEqual(findRecallGaps(clusters, actedUpon), []);
});

test("a gap counts only when a later commit actually touched what the other bot flagged", () => {
  const clusters = [
    { path: "src/a.ts", bots: ["coderabbit"], memberDatabaseIds: [11] },
    { path: "src/b.ts", bots: ["codex"], memberDatabaseIds: [12] },
  ];
  const actedUpon = new Map([
    [11, { arenaId: "coderabbit", classification: "acted_upon" }],
    // Nobody changed anything here — a difference of opinion, not a miss.
    [12, { arenaId: "codex", classification: "open_unaddressed" }],
  ]);
  const gaps = findRecallGaps(clusters, actedUpon);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].arenaId, "coderabbit");
  assert.equal(gaps[0].databaseId, 11);
});

test("every label appears in a tally, so an absent one reads as zero", () => {
  const counts = tallyLabels([{ label: "refuted_confirmed" }, { label: "refuted_confirmed" }]);
  assert.equal(counts.refuted_confirmed, 2);
  assert.equal(counts.fixed_confirmed, 0);
  assert.equal(counts.unanswered, 0);
  assert.equal(counts.refuted_unconfirmed, 0);
});

test("the document is deterministic for one input and one generatedAt", () => {
  const { records } = extractHarvestRecords([
    thread([
      comment(),
      comment({
        databaseId: 2,
        body: "Refuted: already covered.",
        author: { login: "oscharko-dev", __typename: "User" },
        replyTo: { databaseId: 1 },
      }),
    ]),
  ]);
  const build = () =>
    buildHarvestDocument({
      repo: "o/r",
      generatedAt: "2026-08-09T00:00:00Z",
      prs: [
        { number: 7, commits: [commitElsewhere("2026-08-08T12:00:00Z")], records, recallGaps: [] },
        { number: 3, commits: [], records: [], recallGaps: [] },
      ],
    });
  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
  const doc = build();
  assert.deepEqual(
    doc.pullRequests.map((pr) => pr.number),
    [3, 7],
  );
  assert.equal(doc.aggregate.byLabel.refuted_confirmed, 1);
  // The flag a reader of this file needs before deciding where to put it.
  assert.equal(doc.unredacted, true);
});

// ---------------------------------------------------------------------------------------------
// Argument and path validation — the two questions where a silent mistake is most expensive:
// what gets harvested, and where the unredacted document lands.
// ---------------------------------------------------------------------------------------------

test("a repository argument is exactly two non-empty components", () => {
  assert.deepEqual(parseRepoArgument("owner/name"), { owner: "owner", name: "name" });
  // `owner/name/extra` used to pass, query owner/name, and record the three-part string as the
  // document's targetRepo — data bound to a repository the artifact does not name.
  for (const bad of ["owner/name/extra", "owner", "owner/", "/name", "", undefined, 7]) {
    assert.equal(parseRepoArgument(bad), undefined, String(bad));
  }
});

test("a since-date must exist, not merely match the shape", () => {
  assert.equal(isIsoDate("2026-08-09"), true);
  // Parses, and is not February.
  assert.equal(isIsoDate("2026-02-31"), false);
  for (const bad of ["last tuesday", "2026-8-9", "20260809", "", undefined, 20260809]) {
    assert.equal(isIsoDate(bad), false, String(bad));
  }
});

test("a pull-request list is accepted whole or rejected whole", () => {
  assert.deepEqual(parsePrList("3037, 3031,3041"), { numbers: [3037, 3031, 3041] });
  // The typo that used to be filtered out, narrowing the population while the run exited 0.
  assert.deepEqual(parsePrList("3037,304O,3041"), { bad: ["304O"] });
  assert.deepEqual(parsePrList("3037,-1"), { bad: ["-1"] });
  assert.deepEqual(parsePrList(""), { bad: [""] });
});

test("an in-repository path is recognised even when its name begins with two dots", () => {
  // `relative()` returns `..harvest.json` here, and a raw startsWith("..") read that as escaping.
  assert.equal(escapesRepository("/repo", "/repo/..harvest.json"), false);
  assert.equal(escapesRepository("/repo", "/repo/corpus/out.json"), false);
  assert.equal(escapesRepository("/repo", "/elsewhere/out.json"), true);
});

/** A filesystem stub: `links` maps a path to its target, `present` is the set that exists. */
function fakeFs(links, present) {
  return {
    lstatSync(path) {
      if (!(path in links) && !present.has(path)) throw new Error("ENOENT");
      return { isSymbolicLink: () => path in links };
    },
    readlinkSync(path) {
      return links[path];
    },
    existsSync(path) {
      return present.has(path);
    },
    realpathSync(path) {
      return path;
    },
  };
}

test("a symlink pointing into the repository is resolved before the containment check", () => {
  const fs = fakeFs({ "/outside/link.json": "/repo/secret.json" }, new Set(["/repo", "/outside"]));
  const resolved = realLocation("/outside/link.json", fs);
  assert.equal(resolved, "/repo/secret.json");
  assert.equal(escapesRepository("/repo", resolved), false, "and is then refused");
});

/**
 * The case the first version missed. An output file normally does not exist yet, so a link whose
 * TARGET is absent reads as absent to `existsSync` — the ancestor walk then appended the link's own
 * name back unresolved, while `writeFileSync` follows it and creates the target inside the repo.
 */
test("a DANGLING symlink into the repository is resolved too, and then refused", () => {
  const fs = fakeFs({ "/outside/link.json": "/repo/new.json" }, new Set(["/repo", "/outside"]));
  const resolved = realLocation("/outside/link.json", fs);
  assert.equal(resolved, "/repo/new.json");
  // Resolving is only half the guard. Without this the two functions could drift apart and a
  // dangling link would be resolved correctly and then waved through by the containment check.
  assert.equal(escapesRepository("/repo", resolved), false);
});

test("a symlinked parent directory cannot hide the target either", () => {
  const fs = fakeFs({ "/outside/dir": "/repo/inner" }, new Set(["/repo", "/repo/inner"]));
  const resolved = realLocation("/outside/dir", fs);
  assert.equal(resolved, "/repo/inner");
  assert.equal(escapesRepository("/repo", resolved), false);
});

test("a symlink cycle terminates instead of hanging", () => {
  const fs = fakeFs({ "/a": "/b", "/b": "/a" }, new Set(["/"]));
  assert.equal(typeof realLocation("/a", fs), "string");
});

test("an ordinary path outside the repository is returned unchanged and accepted", () => {
  const fs = fakeFs({}, new Set(["/home/user"]));
  const resolved = realLocation("/home/user/out.json", fs);
  assert.equal(resolved, "/home/user/out.json");
  assert.equal(escapesRepository("/repo", resolved), true);
});
