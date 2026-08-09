// The harvest's pure half: turn review threads into labelled teaching examples.
//
// What this is for. The reviewer's precision on the consumer was measured at 21.0% — of the
// findings a reader answered, four in five were refuted (`evidence/precision-2026-08-08-baseline.md`).
// Every refutation is a sentence a human or an agent wrote explaining why a claim was wrong, and
// today that sentence is read once and thrown away. This module keeps it, attaches what git says
// actually happened afterwards, and labels the pair.
//
// Why it is a sibling of `arena-lib.mjs`'s evidence builder rather than an extension of it. That
// document is committed as release evidence and carries a deliberate invariant, pinned by its own
// test: it never places a comment body in its output. The harvest's entire value IS the bodies, so
// extending that builder would mean deleting the property rather than respecting it. Two builders,
// one redacted and committed, one unredacted and local, is the honest shape.
//
// **Output of this module is never committed.** It contains verbatim comment text written by
// humans and by third-party bots on a public repository. `harvest.mjs` writes it outside the
// repository tree for that reason, and only the distilled rules — reviewed as a pull request in the
// consumer — ever become durable.
//
// The one idea worth reading twice: **a refutation the code later contradicted is not a
// refutation.** A reader who writes "already handled, not applicable" and then edits that exact
// region has told us two different things, and only one of them is behaviour. `gradeRecord` keeps
// those apart under their own label rather than averaging them into the pile a rule would be
// distilled from. See `HARVEST_LABELS`.

import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { classifyActedUpon, classifyAuthor, isIncompleteNotice, lineWindow } from "./arena-lib.mjs";
import { classifyReply, isCoverageNotice } from "./precision-gate-lib.mjs";

// ---------------------------------------------------------------------------------------------
// Argument and path validation.
//
// Here rather than in the driver because a driver is top-level script code that no test can call.
// These four decide WHAT gets harvested and WHERE the unredacted document lands — the two questions
// on which a silent mistake is most expensive — so they belong where a test can reach them.
// ---------------------------------------------------------------------------------------------

/** `owner/name`, exactly two non-empty components. */
export function parseRepoArgument(raw) {
  const parts = typeof raw === "string" ? raw.split("/") : [];
  if (parts.length !== 2 || parts.includes("")) return undefined;
  return { owner: parts[0], name: parts[1] };
}

/** `YYYY-MM-DD`, and a date that exists — `2026-02-31` parses and then is not February. */
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

/**
 * Every token, or none.
 *
 * A typo among valid numbers used to be filtered out, narrowing the population silently while the
 * run exited 0 — the document gave no sign that an explicitly requested pull request was missing.
 */
export function parsePrList(raw) {
  const tokens = String(raw)
    .split(",")
    .map((token) => token.trim());
  const numbers = tokens.map(Number);
  const bad = tokens.filter((_, index) => !Number.isInteger(numbers[index]) || numbers[index] <= 0);
  return bad.length > 0 ? { bad } : { numbers };
}

/**
 * The real filesystem location a path names, following symlinks.
 *
 * `resolve` is lexical: it flattens `..` and makes the path absolute, and follows nothing. Two
 * distinct holes came out of that, both found in review. An `--out` that IS a symlink into the
 * repository, or sits below one, passed the containment check and then had `writeFileSync` follow
 * it. And a DANGLING link — one whose target does not exist yet, which is the normal case for an
 * output file — read as absent to `existsSync`, so the ancestor walk appended its own name back
 * unresolved while the write still followed it.
 *
 * So: resolve the link chain first (bounded, because links can cycle), then canonicalize the
 * nearest ancestor that exists. `fs` is injectable so the whole thing is testable without touching
 * a real filesystem.
 */
export function realLocation(path, fs = { existsSync, lstatSync, readlinkSync, realpathSync }) {
  let candidate = path;
  for (let hops = 0; hops < 16; hops += 1) {
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch {
      break;
    }
    if (!stats.isSymbolicLink()) break;
    candidate = resolve(dirname(candidate), fs.readlinkSync(candidate));
  }
  let probe = candidate;
  while (!fs.existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return candidate;
    probe = parent;
  }
  return resolve(fs.realpathSync(probe), relative(probe, candidate));
}

/**
 * Whether `outPath` lies outside `repoRoot`.
 *
 * A path COMPONENT of exactly `..`, never the two leading characters: `relative()` returns
 * `..harvest.json` for an in-repo file of that name, and a raw prefix test read that as escaping.
 */
export function escapesRepository(repoRoot, outPath) {
  return relative(repoRoot, outPath).split(sep).includes("..");
}

/**
 * What one graded finding is worth as a teaching example.
 *
 * The four that matter are separated by whether the reader's PROSE and the repository's GIT HISTORY
 * agree. Prose alone is what `precision-gate.mjs` grades, and it is enough for a rate; it is not
 * enough to mint a rule that will silence future findings, because a rule distilled from a wrong
 * refutation permanently hides a real defect and nothing downstream would ever say so.
 *
 * - `refuted_confirmed` — the reader argued the finding was wrong, and no later commit touched the
 *   region. Prose and behaviour agree. **The only label a suppression rule may be distilled from.**
 * - `refuted_contradicted` — the reader argued it was wrong, and then a later commit edited exactly
 *   that region. Something is off: the refutation, the region match, or both. Kept and reported,
 *   never distilled. This is the guard the whole module exists for.
 * - `refuted_unconfirmed` — the reader argued it was wrong and git could not answer at all: no
 *   commit timeline was fetched, or a rebase left the region unmappable. Also never distilled, but
 *   deliberately NOT the same label as above. `refuted_contradicted` asserts that a commit
 *   contradicted the reply; folding an absent measurement into it would report a contradiction that
 *   was never observed, and `aggregate.byLabel` would carry that fiction as a count.
 * - `fixed_confirmed` — the reader said they fixed it and the region changed. The strongest
 *   positive example there is, and the recall side's ground truth.
 * - `fixed_unconfirmed` — the reader said they fixed it and git cannot corroborate (no later
 *   commit, a rebase that unmapped the region, a fix in a different place). Not evidence of a lie:
 *   evidence that this one cannot be counted either way.
 *
 * The remaining two are measurement failures, reported and never counted — the same discipline the
 * precision gate applies to its own `unanswered`.
 */
export const HARVEST_LABELS = [
  "refuted_confirmed",
  "refuted_contradicted",
  "refuted_unconfirmed",
  "fixed_confirmed",
  "fixed_unconfirmed",
  "unanswered",
  "unclassified",
];

const FULL_COMMIT_OID = /^[0-9a-f]{40}$/u;
const UNIFIED_DIFF_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?(?:\n|$)/u;

function parseRootCommitField(root, field, description) {
  const commit = root?.[field];
  if (commit === undefined || commit === null) return null;
  if (typeof commit !== "object" || Array.isArray(commit)) {
    throw new Error(`harvest root ${description} must be null or an object carrying an oid`);
  }
  const value = commit.oid;
  if (typeof value !== "string" || !FULL_COMMIT_OID.test(value)) {
    throw new Error(`harvest root ${description} oid must be exactly 40 lowercase hex characters`);
  }
  return value;
}

/**
 * GitHub's current binding for a root review comment.
 *
 * GitHub may remap this field when a comment survives later pushes. It is retained for auditing,
 * but it is never a valid historical replay source. `parseRootOriginalCommitOid` below owns that
 * trust boundary.
 */
export function parseRootCommitOid(root) {
  return parseRootCommitField(root, "commit", "commit");
}

/**
 * The immutable tree against which GitHub originally created the review comment.
 *
 * An absent value is an honest `null`: replay marks the case unmeasured. A present value must be a
 * full SHA-1 object id. It is never repaired and replay never falls back to the remappable `commit`
 * field, because either choice can silently put a human-confirmed defect after its own fix.
 */
export function parseRootOriginalCommitOid(root) {
  return parseRootCommitField(root, "originalCommit", "original commit");
}

/**
 * The hunk GitHub attached to the root review comment, byte for byte.
 *
 * An absent hunk is measurable as `null` (file-level comments and old API fixtures legitimately
 * have none). GitHub GraphQL returns the empty string, rather than null, for some outdated roots;
 * that documented-by-observation absence sentinel is normalized to null. Every non-empty value
 * must be an ordinary unified-diff hunk. Keeping it verbatim,
 * rather than reconstructing it from a later PR head, is what lets an offline verifier see the
 * same changed lines the original reviewer saw.
 */
export function parseRootDiffHunk(root) {
  const value = root?.diffHunk;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UNIFIED_DIFF_HUNK_HEADER.test(value)) {
    throw new Error("harvest root diff hunk must be null or a non-empty unified-diff hunk");
  }
  return value;
}

/**
 * Normalizes raw GraphQL review threads into harvest records — the same walk as
 * `extractConversations`, keeping what that one deliberately drops: every reply, with its body,
 * its author, and whether that author was a human.
 *
 * `isHuman` comes from GraphQL's `__typename`, not from the login. A login that looks like a bot
 * is a guess; `User` versus `Bot` is what the API asserts. The distinction is load-bearing later:
 * an agent refuting its own reviewer and a maintainer refuting it are different evidence, and only
 * one of them can be asked to justify itself.
 */
export function extractHarvestRecords(rawThreads) {
  const records = [];
  const identityObservations = [];
  for (const thread of rawThreads) {
    const comments = thread.comments.nodes;
    const root = comments.find((comment) => comment.replyTo === null) ?? comments[0];
    if (root === undefined) continue;
    for (const comment of comments) {
      identityObservations.push({
        login: comment.author?.login ?? null,
        typename: comment.author?.__typename ?? null,
      });
    }
    const author = classifyAuthor(root.author?.login ?? null, root.author?.__typename ?? null);
    const window = lineWindow(root);
    records.push({
      threadId: thread.id,
      databaseId: root.databaseId,
      url: root.url,
      path: root.path,
      startLine: window.startLine,
      endLine: window.endLine,
      isFileLevel: window.isFileLevel,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      createdAt: root.createdAt,
      commitOid: parseRootCommitOid(root),
      originalCommitOid: parseRootOriginalCommitOid(root),
      diffHunk: parseRootDiffHunk(root),
      arenaId: author.arenaId,
      rawLogin: author.rawLogin,
      isNotice: isIncompleteNotice(root.body) || isCoverageNotice(root.body),
      body: root.body,
      replies: comments
        .filter((comment) => comment !== root)
        .map((comment) => {
          const replyAuthor = classifyAuthor(
            comment.author?.login ?? null,
            comment.author?.__typename ?? null,
          );
          return {
            databaseId: comment.databaseId,
            createdAt: comment.createdAt,
            rawLogin: replyAuthor.rawLogin,
            arenaId: replyAuthor.arenaId,
            isHuman: replyAuthor.typename === "User",
            body: comment.body,
          };
        }),
    });
  }
  return { records, identityObservations };
}

/**
 * The first reply that is not the finding's own author — the reply the precision gate grades on,
 * found the same way so the two instruments cannot disagree about which sentence was read.
 */
export function firstForeignReply(record) {
  return record.replies.find((reply) => reply.rawLogin !== record.rawLogin);
}

/**
 * One finding, graded against both what the reader said and what the repository did.
 *
 * `commits` is the pull request's full commit timeline in `classifyActedUpon`'s shape. When it is
 * empty — the caller chose not to pay for it, or the pull request has none — every git-dependent
 * distinction collapses, so the label falls back to the prose-only reading and `gitClassification`
 * says `unavailable`. That is deliberately NOT the same as a confirmed refutation: an absent
 * measurement must not read as a passing one.
 */
export function gradeRecord(record, commits) {
  const reply = firstForeignReply(record);
  if (reply === undefined) {
    return { label: "unanswered", replyVerdict: null, gitClassification: null, reply: null };
  }
  const replyVerdict = classifyReply(reply.body);
  if (replyVerdict === "unclassified") {
    return { label: "unclassified", replyVerdict, gitClassification: null, reply };
  }
  if (commits.length === 0) {
    return {
      label: replyVerdict === "refuted" ? "refuted_unconfirmed" : "fixed_unconfirmed",
      replyVerdict,
      gitClassification: "unavailable",
      reply,
    };
  }
  const gitClassification = classifyActedUpon(record, commits).classification;
  // `outdated_by_rebase` means git could not answer — a patch was unavailable, or the path stopped
  // existing under a rename this run cannot follow. Reading it as "untouched" would let a
  // refutation git never corroborated become `refuted_confirmed` and mint a suppression rule. It
  // takes the same branch as a missing timeline: unavailable is not a pass.
  if (gitClassification === "outdated_by_rebase") {
    return {
      label: replyVerdict === "refuted" ? "refuted_unconfirmed" : "fixed_unconfirmed",
      replyVerdict,
      gitClassification,
      reply,
    };
  }
  const touched = gitClassification === "acted_upon";
  return { label: labelFor(replyVerdict, touched), replyVerdict, gitClassification, reply };
}

/**
 * The two-by-two the whole module turns on, written out rather than nested into one expression:
 * what the reader SAID, against whether a later commit touched the region they said it about.
 *
 * Note that `touched` means the opposite thing in each row. For a refutation it is bad news — the
 * argument and the behaviour disagree, so the pair is unusable. For a fix it is corroboration.
 */
function labelFor(replyVerdict, touched) {
  if (replyVerdict === "refuted") return touched ? "refuted_contradicted" : "refuted_confirmed";
  return touched ? "fixed_confirmed" : "fixed_unconfirmed";
}

/**
 * The findings another bot made that this reviewer did not — filtered to the ones a later commit
 * actually touched.
 *
 * The filter is the whole point, and it is not conservatism. `clusterAcrossBots` links findings on
 * path plus overlapping window with NO similarity requirement (unlike the within-bot clustering
 * directly above it, which requires both), and a file-level window overlaps everything on its path.
 * So a cluster carrying no `kfq` entry means only "this reviewer said nothing anywhere near here" —
 * true, and by itself no evidence at all that there was anything to say. Style nitpicks, taste
 * remarks, and the volume this product spent five releases removing all live in that set.
 *
 * `acted_upon` is the anchor that separates a miss from a difference of opinion: somebody read the
 * remark and changed that code. Seeding the corpus from the unfiltered set would train the reviewer
 * back toward the noise it was built to stop making.
 *
 * `actedUpon` maps a finding's `databaseId` to its `{ arenaId, classification }` — the shape
 * `buildActedUponEntry` already produces, keyed rather than re-derived, because a cluster carries
 * only its members' ids (`memberDatabaseIds`) and never the findings themselves.
 */
export function findRecallGaps(crossBotClusters, actedUpon) {
  const gaps = [];
  for (const cluster of crossBotClusters) {
    if (cluster.bots.includes("kfq")) continue;
    for (const databaseId of cluster.memberDatabaseIds) {
      const entry = actedUpon.get(databaseId);
      if (entry?.classification !== "acted_upon") continue;
      gaps.push({
        arenaId: entry.arenaId,
        databaseId,
        path: cluster.path,
        startLine: cluster.startLine,
        endLine: cluster.endLine,
        isFileLevel: cluster.isFileLevel,
      });
    }
  }
  return gaps;
}

/**
 * Code-unit string order, stated rather than left to `Array.sort`'s default.
 *
 * The default sorts by string coercion, which happens to be right for these keys and would stop
 * being right the moment a caller passed anything else. This document is compared across runs, so
 * the ordering is part of its contract — the same reason `review-cache.ts` names its own.
 */
function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Every label's count, always all six keys, so an absent label reads as zero rather than absent. */
export function tallyLabels(graded) {
  const counts = Object.fromEntries(HARVEST_LABELS.map((label) => [label, 0]));
  for (const entry of graded) counts[entry.label] += 1;
  return counts;
}

/**
 * The harvest document. Deterministic for a given input and `generatedAt`, like its committed
 * sibling — but unlike it, this one carries bodies and must stay out of the repository.
 */
export function buildHarvestDocument({ repo, generatedAt, prs, skipped = [] }) {
  const pullRequests = prs
    .map((pr) => ({
      number: pr.number,
      ...(pr.baseSha === undefined ? {} : { baseCommitOid: pr.baseSha }),
      commitsAvailable: pr.commits.length > 0,
      findings: pr.records
        .filter((record) => !record.isNotice)
        .map((record) => ({ ...record, ...gradeRecord(record, pr.commits) })),
      // Absent, not empty: a run without a commit timeline did not measure gaps at all, and an
      // empty array would read as "we looked and found none".
      ...(pr.recallGaps === undefined ? {} : { recallGaps: pr.recallGaps }),
    }))
    .sort((a, b) => a.number - b.number);
  const allFindings = pullRequests.flatMap((pr) => pr.findings);
  const gapsMeasured = pullRequests.every((pr) => pr.recallGaps !== undefined);
  return {
    // v2 adds the immutable review-comment `originalCommitOid`. v1 carried only GitHub's
    // remappable `commitOid` and is intentionally unusable for historical source replay.
    schemaVersion: 2,
    unredacted: true,
    generatedAt,
    targetRepo: repo,
    skipped,
    pullRequests,
    aggregate: {
      findings: allFindings.length,
      byLabel: tallyLabels(allFindings),
      byBot: Object.fromEntries(
        [...new Set(allFindings.map((finding) => finding.arenaId ?? "other"))]
          .sort(byCodeUnit)
          .map((arenaId) => [
            arenaId,
            allFindings.filter((finding) => (finding.arenaId ?? "other") === arenaId).length,
          ]),
      ),
      recallGaps: gapsMeasured
        ? pullRequests.reduce((sum, pr) => sum + (pr.recallGaps?.length ?? 0), 0)
        : null,
    },
  };
}
