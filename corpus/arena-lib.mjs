import { createHash } from "node:crypto";

/**
 * Pure computation for the reviewer arena scoreboard (issue #39).
 *
 * Every Keiko pull request eligible for this reviewer is, since activation, also reviewed by
 * CodeRabbit and Codex on the identical head — a controlled comparison a solo review history
 * cannot provide. This module turns the raw GitHub review-thread shape into that comparison:
 * which bot said what, whether it repeated itself, and where two bots landed on the same code.
 *
 * Nothing here touches the network or the filesystem. `corpus/arena-fetch.mjs` is the impure
 * half that calls `gh`; `corpus/arena.mjs` wires the two together. Keeping this half pure is what
 * lets `corpus/arena-lib.test.mjs` exercise attribution, the duplicate heuristic, and the
 * cross-bot overlap against fixtures instead of a live pull request.
 *
 * Redaction: the evidence document `buildEvidenceDocument` returns never carries a comment body.
 * `arena-lib.test.mjs` pins that property directly by asserting the assembled document never
 * contains a fixture body substring. One exported value is deliberately not redacted:
 * `extractConversations`'s own result keeps `body` on each conversation, because
 * `clusterDuplicateFindings` still needs it to compute a similarity token set — treat that result as
 * unredacted intermediate state, never something to serialize or write to disk directly.
 *
 * `arenaId` throughout is one of the three keys in `ARENA_BOT_ORDER` — never a raw GitHub login,
 * which varies by API (REST appends `[bot]`; GraphQL does not) and could drift if a bot migrates
 * identities. `buildIdentityTable` is what makes that mapping auditable rather than assumed: it
 * records every login this run observed, whichever arena bot (if any) it resolved to.
 */

export const ARENA_BOT_ORDER = ["kfq", "coderabbit", "codex"];

/**
 * The three bots this arena compares, and the GitHub login each is known to post under today.
 *
 * A login is matched after stripping a trailing `[bot]` (case-insensitive) and lower-casing, so
 * both API shapes match the same entry: REST's `user.login` carries the suffix
 * (`keiko-for-quality[bot]`), GraphQL's `author.login` does not (`keiko-for-quality`). Observed on
 * Keiko pull request #2926 on 2026-08-02; if a bot migrates identity, `buildIdentityTable` reports
 * the new login as unattributed rather than silently miscounting it.
 */
export const BOT_IDENTITIES = [
  { arenaId: "kfq", displayName: "Keiko for Quality", login: "keiko-for-quality" },
  { arenaId: "coderabbit", displayName: "CodeRabbit", login: "coderabbitai" },
  { arenaId: "codex", displayName: "Codex", login: "chatgpt-codex-connector" },
];

/** The similarity floor for two of one bot's own findings to count as paraphrase duplicates. */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.15;

/**
 * The literal sentence `composeIncompleteNotice` (`src/publish/presentation.ts`) always emits for
 * a settlement notice. Matching it precisely, rather than a looser "could not review" guess, is
 * what keeps a genuine finding that happens to discuss review coverage from being pulled out of
 * the findings pool. If that producer's wording ever changes, this constant must move with it —
 * the same drift risk `AGENTS.md` already names for the rule text and the sanitizer.
 */
const INCOMPLETE_NOTICE_MARKER = "This change was not fully reviewed.";

function normalizeLogin(login) {
  return login.replace(/\[bot\]$/i, "").toLowerCase();
}

/** Resolves a raw GitHub author to one of the three arena bots, or `null` if it matches none. */
export function classifyAuthor(login, typename) {
  const rawLogin = login ?? "[deleted]";
  const normalizedLogin = normalizeLogin(rawLogin);
  const identity = BOT_IDENTITIES.find((bot) => bot.login === normalizedLogin);
  return {
    rawLogin,
    normalizedLogin,
    typename: typename ?? "Unknown",
    arenaId: identity ? identity.arenaId : null,
    // A login that names a known bot but was not reported as a Bot account is exactly the silent
    // misattribution this table exists to surface — see `buildIdentityTable`.
    identityMismatch: identity !== undefined && typename !== "Bot",
  };
}

/**
 * Aggregates every observed (login, typename) pair into the identity table the tool's own output
 * leads with. `observations` carries one entry per root comment or reply this run read — a login
 * this run never saw simply does not appear, which is the honest answer to "who commented."
 */
export function buildIdentityTable(observations) {
  const counts = new Map();
  for (const observation of observations) {
    const classified = classifyAuthor(observation.login, observation.typename);
    const key = classified.rawLogin;
    const existing = counts.get(key);
    if (existing) {
      existing.commentCount += 1;
    } else {
      counts.set(key, { ...classified, commentCount: 1 });
    }
  }
  const observedLogins = [...counts.values()].sort((a, b) => a.rawLogin.localeCompare(b.rawLogin));
  const knownBots = BOT_IDENTITIES.map((bot) => ({
    arenaId: bot.arenaId,
    displayName: bot.displayName,
    matchLogin: bot.login,
  }));
  return { knownBots, observedLogins };
}

/** True for the fixed-template body `composeIncompleteNotice` publishes for a settlement notice. */
export function isIncompleteNotice(body) {
  return body.includes(INCOMPLETE_NOTICE_MARKER);
}

/**
 * The line window a comment anchors to, preferring the position in the *original* diff.
 *
 * `originalLine`/`originalStartLine` survive a thread going outdated; the live `line`/`startLine`
 * go `null` once the diff view they anchored to no longer exists. Using the live fields as primary
 * would make an outdated thread's window disappear exactly when history needs it most — arena
 * snapshots are meant to be comparable over time, which requires a window that outlives the push
 * that made it outdated.
 */
export function lineWindow(comment) {
  const end = comment.originalLine ?? comment.line ?? null;
  if (end === null) return { startLine: null, endLine: null, isFileLevel: true };
  const start = comment.originalStartLine ?? comment.startLine ?? end;
  return { startLine: start, endLine: end, isFileLevel: false };
}

/**
 * Whether two line windows on the same path describe overlapping code.
 *
 * A file-level window (no line at all — a whole-file conversation) is defined to overlap any
 * window on the same path: a whole-file remark and a specific-line remark are still both about
 * that file. Callers are expected to have already checked the two paths are equal.
 */
export function rangesOverlap(a, b) {
  if (a.isFileLevel || b.isFileLevel) return true;
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * Words this heuristic ignores when comparing two bodies: closed-class English function words plus
 * a handful of terms so generic to a code review (change, file, test, case…) that sharing them says
 * nothing about whether two findings share a claim.
 */
const SIMILARITY_STOPWORDS = new Set(
  (
    "the a an this that these those is are was were be been being have has had do does did will " +
    "would shall should may might must can could to of in on at for with by from as it its their " +
    "his her they them then than so but and or if when while not no every already own only now " +
    "first plus even here because unless directly still such existing also which who what how " +
    "into out about over under between across new old more most less least same different other " +
    "any all one two three yet just like get gets got make makes made call calls path route file " +
    "files test tests case cases change changes code line lines"
  ).split(/\s+/),
);

const BADGE_LINE = /^_.+_(\s*\|\s*_.+_)*$/;

/**
 * Reduces a finding body to the set of content words used to judge whether two bodies are
 * paraphrases of the same claim.
 *
 * Three structural pieces are stripped before tokenizing, because every finding from a given bot
 * shares them verbatim and counting them would inflate similarity between two unrelated findings
 * from the same bot rather than between two paraphrases of the same one: the trailing marker
 * comment, any `<details>` block (the "Prompt for AI agents" wrapper both bots in this arena use,
 * and CodeRabbit's "Analysis chain" script transcripts), and the leading category/severity badge
 * line (`_🐛 Correctness_ | _🟠 Major_`).
 */
export function normalizeForSimilarity(rawBody) {
  let text = rawBody.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<details>[\s\S]*?<\/details>/gi, " ");
  text = text.replace(/```[\s\S]*?```/g, " ");
  const lines = text.split("\n");
  if (lines.length > 0 && BADGE_LINE.test(lines[0].trim())) lines[0] = "";
  text = lines
    .join("\n")
    .replace(/[`*_#>]/g, " ")
    .toLowerCase();
  const tokens = text.match(/[a-z][a-z0-9]{2,}/g) ?? [];
  return new Set(tokens.filter((token) => !SIMILARITY_STOPWORDS.has(token)));
}

/**
 * Jaccard similarity of two token sets: the fraction of the combined vocabulary the two share.
 *
 * Two bodies with no comparable tokens at all score 0, not 1 — the absence of signal is not
 * evidence of similarity, and this heuristic would rather miss a duplicate than manufacture one
 * from two contentless bodies.
 */
export function jaccardSimilarity(setA, setB) {
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A minimal union-find over `[0, size)`, used to cluster findings by pairwise edges. */
function createUnionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  function find(index) {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    parent[index] = root;
    return root;
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  }
  return { find, union };
}

/**
 * The window a cluster spans: the narrowest window containing every member's own window. Any
 * file-level member makes the whole cluster file-level, since a whole-file remark's scope is the
 * entire file regardless of how narrowly the other members anchor.
 */
function unionWindow(memberIndexes, windows) {
  let isFileLevel = false;
  let startLine = null;
  let endLine = null;
  for (const index of memberIndexes) {
    const window = windows[index];
    if (window.isFileLevel) {
      isFileLevel = true;
      continue;
    }
    if (startLine === null || window.startLine < startLine) startLine = window.startLine;
    if (endLine === null || window.endLine > endLine) endLine = window.endLine;
  }
  if (isFileLevel) return { startLine: null, endLine: null, isFileLevel: true };
  return { startLine, endLine, isFileLevel: false };
}

/**
 * The final, always-numeric tiebreak: the smallest member id, which every cluster shape populates
 * (`memberDatabaseIds`, already sorted ascending) and `databaseId` does not — a cross-bot cluster
 * has no single representative id of its own. Two same-bot, same-path, same-window clusters (a
 * realistic case: two of one bot's file-level findings on one file, kept apart by the within-bot
 * similarity check but otherwise identical in location) would otherwise tie on `databaseId ??
 * undefined` on both sides, and `undefined - undefined` is `NaN` — a comparator that returns `NaN`
 * makes the sort order unspecified, which is exactly what a document promising byte-identical
 * output for byte-identical input cannot afford.
 */
function clusterSortKey(cluster) {
  return cluster.databaseId ?? cluster.memberDatabaseIds[0];
}

function compareClusterOrder(a, b) {
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  const aStart = a.startLine ?? -1;
  const bStart = b.startLine ?? -1;
  if (aStart !== bStart) return aStart - bStart;
  const aEnd = a.endLine ?? -1;
  const bEnd = b.endLine ?? -1;
  if (aEnd !== bEnd) return aEnd - bEnd;
  return clusterSortKey(a) - clusterSortKey(b);
}

/**
 * Clusters one bot's own findings on one pull request into duplicate-variant groups.
 *
 * Two findings join a cluster only when both hold: the same path, an overlapping line window, and
 * a similarity at or above `threshold`. Path-plus-window alone is not enough — CodeRabbit's own
 * review of Keiko #2926 put three unrelated findings (a confirm-dialog affordance, a swallowed
 * error, a React-version check) at overlapping lines in one `SettingsPanel.tsx` hunk, and merging
 * those would misreport genuinely distinct feedback as noise. Requiring similarity too is what
 * keeps that case apart while still catching the three-paraphrase cluster this feature exists to
 * measure (Keiko #2926, `codingContextRoutes.ts:236`, filed as bug #38).
 *
 * Clustering is transitive: if finding A is judged similar to B, and B to C, all three land in one
 * cluster even if A and C alone would not cross the threshold. No case in this tool's calibration
 * data has shown that chaining over-merge unrelated findings, but a long run of close paraphrases
 * could in principle produce it — a known limitation of a *simple* normalized-similarity heuristic,
 * not a hidden one.
 */
export function clusterDuplicateFindings(findings, threshold = DUPLICATE_SIMILARITY_THRESHOLD) {
  const uf = createUnionFind(findings.length);
  const tokenSets = findings.map((finding) => normalizeForSimilarity(finding.body));
  linkWithinBotDuplicates(findings, tokenSets, uf, threshold);
  // `findings` are already-normalized conversations (see `extractConversations`), which carry
  // `startLine`/`endLine`/`isFileLevel` directly — not raw comments, so `lineWindow` does not apply
  // here; each finding already *is* its own window.
  return groupIndexesByRoot(uf, findings.length)
    .map((memberIndexes) => buildDuplicateCluster(memberIndexes, findings))
    .sort(compareClusterOrder);
}

function linkWithinBotDuplicates(findings, tokenSets, uf, threshold) {
  for (let i = 0; i < findings.length; i += 1) {
    for (let j = i + 1; j < findings.length; j += 1) {
      if (findings[i].path !== findings[j].path) continue;
      if (!rangesOverlap(findings[i], findings[j])) continue;
      if (jaccardSimilarity(tokenSets[i], tokenSets[j]) >= threshold) uf.union(i, j);
    }
  }
}

function buildDuplicateCluster(memberIndexes, findings) {
  const sortedMembers = memberIndexes
    .slice()
    .sort(
      (a, b) =>
        findings[a].createdAt.localeCompare(findings[b].createdAt) ||
        findings[a].databaseId - findings[b].databaseId,
    );
  const representative = findings[sortedMembers[0]];
  const window = unionWindow(sortedMembers, findings);
  return {
    path: representative.path,
    startLine: window.startLine,
    endLine: window.endLine,
    isFileLevel: window.isFileLevel,
    databaseId: representative.databaseId,
    memberCount: sortedMembers.length,
    memberDatabaseIds: sortedMembers
      .map((index) => findings[index].databaseId)
      .sort((a, b) => a - b),
  };
}

/** Groups indexes `[0, size)` by their union-find root, one array of member indexes per root. */
function groupIndexesByRoot(uf, size) {
  const groups = new Map();
  for (let i = 0; i < size; i += 1) {
    const root = uf.find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()];
}

/**
 * Clusters *distinct* findings across all bots on one pull request by path-plus-overlapping-window
 * alone — no similarity check. This is deliberately coarser than the within-bot duplicate
 * heuristic: cross-bot overlap is a proxy for consensus ("more than one bot flagged this code"),
 * not a claim that the two bots described the same defect the same way, so requiring textual
 * similarity across two different bots' very different house styles would undercount agreement
 * that is real. Call this only with each bot's already-deduplicated findings — clustering raw,
 * undeduplicated findings would let one bot's own paraphrase trio inflate its apparent consensus
 * with every other bot three-fold.
 *
 * Edges only ever join *different* bots. Two of the same bot's own distinct findings can still
 * share an overlapping window — the within-bot heuristic kept them apart because their content
 * differed, and re-merging them here with no similarity check at all would contradict that
 * decision on a weaker basis than the one that made it. Excluding same-bot edges does not remove
 * transitive chaining through a third finding (bot A overlaps bot B's wide finding, which also
 * overlaps a second, unrelated bot A finding further along) — the same documented limitation as
 * the within-bot heuristic's chaining, one hop wider.
 */
export function clusterAcrossBots(distinctFindingsByBot) {
  const flat = flattenByArenaOrder(distinctFindingsByBot);
  const uf = createUnionFind(flat.length);
  linkCrossBotOverlaps(flat, uf);
  return groupIndexesByRoot(uf, flat.length)
    .map((memberIndexes) => buildCrossBotCluster(memberIndexes, flat))
    .sort(compareClusterOrder);
}

/** Flattens the per-bot distinct-finding lists into one array, each entry tagged with `arenaId`. */
function flattenByArenaOrder(distinctFindingsByBot) {
  const flat = [];
  for (const arenaId of ARENA_BOT_ORDER) {
    for (const finding of distinctFindingsByBot[arenaId] ?? []) flat.push({ ...finding, arenaId });
  }
  return flat;
}

function linkCrossBotOverlaps(flat, uf) {
  for (let i = 0; i < flat.length; i += 1) {
    for (let j = i + 1; j < flat.length; j += 1) {
      if (flat[i].arenaId === flat[j].arenaId) continue;
      if (flat[i].path !== flat[j].path) continue;
      if (rangesOverlap(flat[i], flat[j])) uf.union(i, j);
    }
  }
}

function buildCrossBotCluster(memberIndexes, flat) {
  const sorted = memberIndexes.slice().sort((a, b) => flat[a].databaseId - flat[b].databaseId);
  const first = flat[sorted[0]];
  const window = unionWindow(sorted, flat);
  const bots = [...new Set(sorted.map((index) => flat[index].arenaId))].sort(
    (a, b) => ARENA_BOT_ORDER.indexOf(a) - ARENA_BOT_ORDER.indexOf(b),
  );
  return {
    path: first.path,
    startLine: window.startLine,
    endLine: window.endLine,
    isFileLevel: window.isFileLevel,
    bots,
    memberDatabaseIds: sorted.map((index) => flat[index].databaseId).sort((a, b) => a - b),
  };
}

function threadStatus(record) {
  // Resolved takes priority over outdated: a resolved-and-outdated thread was still addressed by a
  // human, which is the more salient fact for a scoreboard reader than the diff having since moved.
  if (record.isResolved) return "resolved";
  if (record.isOutdated) return "outdated";
  return "unresolved";
}

function emptyThreadCounts() {
  return { resolved: 0, unresolved: 0, outdated: 0 };
}

function emptyCoFound() {
  return { kfq: null, coderabbit: null, codex: null };
}

/**
 * Builds one bot's metrics row for one pull request from its raw records (findings and notices)
 * and the two cluster views already computed for the PR.
 */
function buildBotMetrics(arenaId, records, duplicateClusters, crossBotClusters) {
  const findings = records.filter((record) => !record.isNotice);
  const notices = records.filter((record) => record.isNotice);
  const threads = emptyThreadCounts();
  const filePaths = new Set();
  for (const record of records) {
    threads[threadStatus(record)] += 1;
    filePaths.add(record.path);
  }
  const coFound = emptyCoFound();
  let coFoundAllThree = 0;
  let uniqueToBot = 0;
  for (const cluster of crossBotClusters) {
    if (!cluster.bots.includes(arenaId)) continue;
    if (cluster.bots.length === 1) {
      uniqueToBot += 1;
      continue;
    }
    for (const otherId of cluster.bots) {
      if (otherId !== arenaId) coFound[otherId] = (coFound[otherId] ?? 0) + 1;
    }
    if (cluster.bots.length === 3) coFoundAllThree += 1;
  }
  return {
    findingsPosted: findings.length,
    distinctFindings: duplicateClusters.length,
    duplicateVariants: findings.length - duplicateClusters.length,
    incompleteNotices: notices.length,
    filesTouched: filePaths.size,
    threads,
    uniqueToBot,
    coFound,
    coFoundAllThree,
  };
}

/**
 * Assembles one pull request's full arena record from its normalized conversations.
 *
 * `conversations` is the output of `extractConversations` — one entry per review thread, tagged
 * with `arenaId` (or `null`) and `isNotice`. This is the seam most unit tests target: it takes
 * fixture conversations in and returns the same deterministic shape `buildEvidenceDocument` embeds
 * per pull request, without needing a live fetch.
 */
export function buildPrRecord(pr, conversations) {
  const byBot = {};
  const duplicateClustersByBot = {};
  const distinctFindingsByBot = {};
  for (const arenaId of ARENA_BOT_ORDER) {
    const records = conversations.filter((conversation) => conversation.arenaId === arenaId);
    const findings = records.filter((record) => !record.isNotice);
    const clusters = clusterDuplicateFindings(findings);
    duplicateClustersByBot[arenaId] = clusters;
    // One representative per cluster stands in for the whole group in cross-bot overlap, so a
    // paraphrase trio cannot inflate consensus with another bot three-fold.
    distinctFindingsByBot[arenaId] = clusters.map(
      (cluster) =>
        findings.find((finding) => finding.databaseId === cluster.databaseId) ?? findings[0],
    );
    byBot[arenaId] = records;
  }
  const crossBotClusters = clusterAcrossBots(distinctFindingsByBot);
  const bots = {};
  for (const arenaId of ARENA_BOT_ORDER) {
    bots[arenaId] = buildBotMetrics(
      arenaId,
      byBot[arenaId],
      duplicateClustersByBot[arenaId],
      crossBotClusters,
    );
  }
  const duplicateClusters = ARENA_BOT_ORDER.flatMap((arenaId) =>
    duplicateClustersByBot[arenaId]
      .filter((cluster) => cluster.memberCount > 1)
      .map((cluster) => ({ arenaId, ...cluster })),
  ).sort((a, b) =>
    a.arenaId === b.arenaId ? compareClusterOrder(a, b) : a.arenaId.localeCompare(b.arenaId),
  );
  return {
    number: pr.number,
    headSha: pr.headSha,
    bots,
    duplicateClusters,
    crossBotClusters: crossBotClusters.filter((cluster) => cluster.bots.length > 1),
  };
}

function sumBotMetrics(rows) {
  const threads = emptyThreadCounts();
  const coFound = emptyCoFound();
  let coFoundAllThree = 0;
  const totals = {
    findingsPosted: 0,
    distinctFindings: 0,
    duplicateVariants: 0,
    incompleteNotices: 0,
    filesTouched: 0,
    uniqueToBot: 0,
  };
  for (const row of rows) {
    for (const key of Object.keys(totals)) totals[key] += row[key];
    for (const key of Object.keys(threads)) threads[key] += row.threads[key];
    for (const otherId of ARENA_BOT_ORDER) {
      if (row.coFound[otherId] !== null)
        coFound[otherId] = (coFound[otherId] ?? 0) + row.coFound[otherId];
    }
    coFoundAllThree += row.coFoundAllThree;
  }
  return { ...totals, threads, coFound, coFoundAllThree };
}

/** Sums every per-PR bot row into one aggregate row per bot, in `ARENA_BOT_ORDER`. */
export function buildAggregate(prRecords) {
  const bots = {};
  for (const arenaId of ARENA_BOT_ORDER) {
    bots[arenaId] = sumBotMetrics(prRecords.map((pr) => pr.bots[arenaId]));
  }
  return { prCount: prRecords.length, bots };
}

const HEURISTICS_METADATA = {
  duplicateSimilarity: {
    method: "jaccard-token-set-v1",
    threshold: DUPLICATE_SIMILARITY_THRESHOLD,
    note:
      "Two of one bot's own findings on the same pull request are treated as duplicate variants " +
      "of one finding when they share a path, their line windows overlap, and the Jaccard " +
      "similarity of their normalized content-word sets is at least the threshold. Estimates, not " +
      "a correctness judgement — see corpus/arena-lib.mjs for the exact normalization.",
  },
  crossBotOverlap: {
    method: "path-and-line-window-intersection-v1",
    note:
      "A cross-bot overlap cluster groups distinct (already deduplicated) findings from different " +
      "bots that share a path and an overlapping line window. No content comparison is applied " +
      "across bots, so this is a proxy for consensus location, not for agreement on the claim.",
  },
  incompleteNotice: {
    method: "literal-phrase-match-v1",
    note:
      "A conversation is an incomplete-review notice, not a finding, when its body contains the " +
      "fixed sentence Keiko for Quality's publisher emits for a settlement notice. Calibrated on " +
      "this reviewer; other bots are checked against the same phrase for symmetry but are not " +
      "expected to match it.",
  },
  disclaimer:
    "Duplicate-variant and cross-bot-overlap counts are heuristic estimates for a repeatable " +
    "scoreboard, not a human adjudication of correctness or noise. See the pull request that " +
    "introduced this tool for calibration evidence.",
};

/**
 * Builds the deterministic evidence document: identical `prs` input plus an identical
 * `generatedAt` string always produce byte-identical JSON, which is what makes this artifact
 * usable as release evidence rather than a one-off report. `generatedAt` is taken as a parameter
 * rather than read from the clock in here for exactly that reason — the wall clock lives in
 * `corpus/arena.mjs`, at the impure boundary, never inside this module.
 */
export function buildEvidenceDocument({ repo, generatedAt, prs }) {
  const identityObservations = prs.flatMap((pr) => pr.identityObservations);
  const identity = buildIdentityTable(identityObservations);
  const prRecords = prs
    .map((pr) => buildPrRecord(pr, pr.conversations))
    .sort((a, b) => a.number - b.number);
  return {
    schemaVersion: 1,
    generatedAt,
    targetRepo: repo,
    heuristics: HEURISTICS_METADATA,
    identity,
    pullRequests: prRecords,
    aggregate: buildAggregate(prRecords),
  };
}

/**
 * Normalizes one raw GraphQL review thread into the shape the rest of this module consumes.
 *
 * The root comment (`replyTo` absent) carries the thread's identity, location, and content; any
 * reply is read only far enough to be counted in `identityObservations` (so a human's reply login
 * is visible in the identity table) and is otherwise not treated as a finding of its own — a reply
 * is conversation, not a new claim about the code.
 */
export function extractConversations(rawThreads) {
  const conversations = [];
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
    conversations.push({
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
      commitOid: root.commit?.oid ?? null,
      arenaId: author.arenaId,
      rawLogin: author.rawLogin,
      isNotice: isIncompleteNotice(root.body),
      body: root.body,
      bodyHash: sha256Hex(root.body),
    });
  }
  return { conversations, identityObservations };
}

// ---------------------------------------------------------------------------------------------
// Markdown rendering.
//
// The human-readable half of the evidence: the same numbers as the JSON document, laid out as one
// table per pull request plus an aggregate, with no comment prose — a scoreboard, not a review.
// ---------------------------------------------------------------------------------------------

function displayName(arenaId) {
  return BOT_IDENTITIES.find((bot) => bot.arenaId === arenaId)?.displayName ?? arenaId;
}

function formatLocation(entry) {
  if (entry.isFileLevel) return entry.path;
  if (entry.startLine === entry.endLine) return `${entry.path}:${String(entry.startLine)}`;
  return `${entry.path}:${String(entry.startLine)}-${String(entry.endLine)}`;
}

const SCOREBOARD_HEADER = [
  "Bot",
  "Posted",
  "Distinct",
  "Duplicates",
  "Notices",
  "Files",
  "Resolved",
  "Unresolved",
  "Outdated",
  "Unique",
  ...ARENA_BOT_ORDER.map((id) => `vs ${displayName(id)}`),
  "All three",
];

function scoreboardRow(arenaId, metrics) {
  const coFoundCells = ARENA_BOT_ORDER.map((otherId) =>
    otherId === arenaId ? "—" : String(metrics.coFound[otherId] ?? 0),
  );
  return [
    displayName(arenaId),
    metrics.findingsPosted,
    metrics.distinctFindings,
    metrics.duplicateVariants,
    metrics.incompleteNotices,
    metrics.filesTouched,
    metrics.threads.resolved,
    metrics.threads.unresolved,
    metrics.threads.outdated,
    metrics.uniqueToBot,
    ...coFoundCells,
    metrics.coFoundAllThree,
  ].map(String);
}

function renderTable(header, rows) {
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function renderScoreboardTable(bots) {
  const rows = ARENA_BOT_ORDER.map((arenaId) => scoreboardRow(arenaId, bots[arenaId]));
  return renderTable(SCOREBOARD_HEADER, rows);
}

function renderClusterList(title, clusters, describeMembers) {
  if (clusters.length === 0) return `${title}: none.`;
  const items = clusters.map(
    (cluster) => `- ${formatLocation(cluster)} — ${describeMembers(cluster)}`,
  );
  return `${title}:\n\n${items.join("\n")}`;
}

function renderPrSection(pr) {
  const heading = `### Pull request #${String(pr.number)} (head \`${pr.headSha.slice(0, 12)}\`)`;
  const duplicates = renderClusterList(
    "Duplicate-variant clusters",
    pr.duplicateClusters,
    // "1 finding + N duplicate variants", not "N variants" — the cluster's `memberCount` includes
    // the finding itself, and the Duplicates column reports only the extra members beyond it. The
    // two must read as the same number, or a reader cannot reconcile the table with this list.
    (cluster) =>
      `${displayName(cluster.arenaId)}, 1 finding + ${String(cluster.memberCount - 1)} duplicate variant(s)`,
  );
  const overlaps = renderClusterList("Cross-bot overlap clusters", pr.crossBotClusters, (cluster) =>
    cluster.bots.map((id) => displayName(id)).join(" + "),
  );
  return [heading, "", renderScoreboardTable(pr.bots), "", duplicates, "", overlaps].join("\n");
}

function renderIdentityTable(identity) {
  const header = ["Observed login", "Account type", "Resolved to", "Comments", "Flag"];
  const rows = identity.observedLogins.map((entry) => [
    `\`${entry.rawLogin}\``,
    entry.typename,
    entry.arenaId ? displayName(entry.arenaId) : "(unattributed)",
    String(entry.commentCount),
    entry.identityMismatch ? "typename mismatch" : "",
  ]);
  return renderTable(header, rows);
}

/**
 * Renders the same numbers `buildEvidenceDocument` produces as a human-readable scoreboard: an
 * identity table (so misattribution is visible on sight, not just in the JSON), the heuristics in
 * force, one table per pull request, and the aggregate. No comment body ever reaches this output —
 * see `buildEvidenceDocument`'s own redaction note.
 */
export function renderMarkdown(document) {
  const sections = [
    "# Reviewer arena scoreboard",
    "",
    `Generated ${document.generatedAt} for \`${document.targetRepo}\`.`,
    "",
    "## Identity",
    "",
    "Every login this run observed, and which arena bot (if any) it resolved to — so a bot that " +
      "migrates identity, or an unrecognized login, is visible here rather than silently miscounted.",
    "",
    renderIdentityTable(document.identity),
    "",
    "## Heuristics",
    "",
    `- **Duplicate similarity** (\`${document.heuristics.duplicateSimilarity.method}\`, threshold ` +
      `${String(document.heuristics.duplicateSimilarity.threshold)}): ${document.heuristics.duplicateSimilarity.note}`,
    `- **Cross-bot overlap** (\`${document.heuristics.crossBotOverlap.method}\`): ${document.heuristics.crossBotOverlap.note}`,
    `- **Incomplete notice** (\`${document.heuristics.incompleteNotice.method}\`): ${document.heuristics.incompleteNotice.note}`,
    "",
    `> ${document.heuristics.disclaimer}`,
    "",
    "## Per pull request",
    "",
    ...document.pullRequests.map((pr) => renderPrSection(pr)),
    `## Aggregate across ${String(document.aggregate.prCount)} pull request(s)`,
    "",
    renderScoreboardTable(document.aggregate.bots),
    "",
  ];
  return sections.join("\n");
}
