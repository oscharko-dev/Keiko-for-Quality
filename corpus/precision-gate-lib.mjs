// The precision gate's pure half: classify what a reader DID with each published finding.
//
// Why this gate exists, and why none of the others could have caught what it measures. On
// 2026-08-08 the reviewer published 82 findings across twelve live hours on the consumer. The
// reader refuted 55 of them after verification and fixed 14 — an actionable rate of 17%. Every
// gate we had was green at the same moment: the seed gate scores RECALL on seeded defects (does
// the reviewer find the planted bug), the completion gate scores whether a run FINISHES, the
// corpus scores recall and classification on a fixed basis. A reviewer that finds the planted bug
// and then buries it under six wrong claims passes all three. Noise was simply not measured.
//
// It is measured here, and from the only source that can settle it: what the reader replied.
// A finding whose thread carries a refutation was wrong; one whose thread carries a fix was
// right; one nobody answered is not evidence either way and is reported separately rather than
// counted — the same "measurement failures excluded from the rate" discipline the completion gate
// states in its own header.
//
// The classifier is deliberately conservative in one direction: a reply it cannot read is
// `unclassified`, never `fixed`. A gate that guesses in its own favour is decoration.

/** Phrases a reader uses when the finding was wrong. */
const REFUTED = [
  /\brefut(ed|ing|es)\b/i,
  /\bnot applicable\b/i,
  /\bno longer applies\b/i,
  /\bfalse positive\b/i,
  /\balready (handles|handled|exists|guards|guarded|does|covered)\b/i,
  /\bincorrect (premise|claim|reading)\b/i,
  /\bthis is (wrong|mistaken)\b/i,
];

/** Phrases a reader uses when the finding was right and the code changed. */
const FIXED = [
  /\bfixed\b/i,
  /\bapplied\b/i,
  /\baddressed\b/i,
  /\bimplemented\b/i,
  /\bcorrected\b/i,
  /\bdone in\b/i,
];

/** The earliest match of a pattern set, or Infinity when none matches. */
function earliest(text, patterns) {
  let best = Infinity;
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found !== null && found.index < best) best = found.index;
  }
  return best;
}

/**
 * One reply, classified.
 *
 * Whichever verdict appears FIRST wins, because a reader who fixed something often explains what
 * was wrong afterwards ("Fixed in abc123 — the guard was missing"), and one who refutes often
 * describes the proposed fix afterwards ("Refuted: applying this would reintroduce..."). Position
 * is the only signal that separates those two without reading meaning.
 */
export function classifyReply(body) {
  if (typeof body !== "string" || body.trim() === "") return "unclassified";
  const refuted = earliest(body, REFUTED);
  const fixed = earliest(body, FIXED);
  if (refuted === Infinity && fixed === Infinity) return "unclassified";
  return refuted <= fixed ? "refuted" : "fixed";
}

/** True for the reviewer's own coverage notice, which is not a finding and is never graded. */
export function isCoverageNotice(body) {
  return typeof body === "string" && body.includes("was not fully reviewed");
}

/**
 * Grades one pull request's threads.
 *
 * `threads` are `arena-fetch.mjs`'s raw GraphQL nodes, unmodified — `{ comments: { nodes: [{
 * author: { login }, body }] } }`. The identity is the GraphQL login, which for a GitHub App
 * carries NO `[bot]` suffix (that file's own header records the same trap).
 *
 * A thread counts as the reviewer's finding when the reviewer opened it and it is not a notice.
 */
export function gradePullRequest(threads, identity) {
  const record = { findings: 0, fixed: 0, refuted: 0, unanswered: 0, unclassified: 0 };
  for (const thread of threads ?? []) {
    const comments = thread?.comments?.nodes ?? [];
    const first = comments[0];
    if (first?.author?.login !== identity || isCoverageNotice(first?.body)) continue;
    record.findings += 1;
    const reply = comments.slice(1).find((comment) => comment?.author?.login !== identity);
    if (reply === undefined) {
      record.unanswered += 1;
      continue;
    }
    const verdict = classifyReply(reply.body);
    if (verdict === "fixed") record.fixed += 1;
    else if (verdict === "refuted") record.refuted += 1;
    else record.unclassified += 1;
  }
  return record;
}

/**
 * The rate, over the graded population only.
 *
 * `undefined` when nothing was graded — a window with no answered finding says nothing about
 * precision, and reporting 0% or 100% for it would be a fabricated number in a product whose
 * whole contract is that absent means absent.
 */
export function actionableRate(totals) {
  const graded = totals.fixed + totals.refuted;
  return graded === 0 ? undefined : totals.fixed / graded;
}

export function sumRecords(records) {
  return records.reduce(
    (acc, r) => ({
      findings: acc.findings + r.findings,
      fixed: acc.fixed + r.fixed,
      refuted: acc.refuted + r.refuted,
      unanswered: acc.unanswered + r.unanswered,
      unclassified: acc.unclassified + r.unclassified,
    }),
    { findings: 0, fixed: 0, refuted: 0, unanswered: 0, unclassified: 0 },
  );
}

/** GREEN at or above the threshold, RED below it, and GREY when nothing could be graded. */
export function verdictOf(rate, threshold) {
  if (rate === undefined) return "GREY";
  return rate >= threshold ? "GREEN" : "RED";
}

export function renderReport({ repo, identity, threshold, perPr, totals, generatedAt }) {
  const rate = actionableRate(totals);
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    "Measures one thing only: of the findings a reader ANSWERED, how many were right.",
    "Recall gates cannot see noise; this is the only gate that can.",
    "",
    `- Repository: ${repo}`,
    `- Reviewer identity: ${identity}`,
    `- Generated: ${generatedAt}`,
    `- Findings published: ${String(totals.findings)}`,
    `- **Actionable rate: ${rate === undefined ? "—" : pct(rate)}** (${String(totals.fixed)} fixed / ${String(totals.fixed + totals.refuted)} graded, threshold ${pct(threshold)}) — ${verdictOf(rate, threshold)}`,
    `- Refuted: ${String(totals.refuted)}`,
    `- Unanswered (not graded): ${String(totals.unanswered)}`,
    `- Reply unclassified (not graded): ${String(totals.unclassified)}`,
    "",
  ];
  for (const entry of perPr) {
    lines.push(
      `## PR #${String(entry.number)}`,
      "",
      `- ${String(entry.record.findings)} finding(s): ${String(entry.record.fixed)} fixed, ${String(entry.record.refuted)} refuted, ${String(entry.record.unanswered)} unanswered, ${String(entry.record.unclassified)} unclassified`,
      "",
    );
  }
  return lines.join("\n");
}
