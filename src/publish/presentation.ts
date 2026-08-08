/**
 * How a finding is presented on GitHub.
 *
 * The shape here is not invented. It follows the conventions that mature review bots converged on
 * over thousands of published comments — a scannable classification line, an imperative one-line
 * claim, prose that names the defect and its consequence, and a collapsed repair instruction aimed
 * at the agent that will fix it. Those conventions exist because reviewers read dozens of comments
 * and act on few; anything that does not help that triage is noise.
 *
 * The security boundary runs straight through this file, and it is the reason the structure can be
 * rich at all. Everything the **model** produced is prose that has already passed sanitization —
 * no HTML, no links, no images. Everything **structural** is composed here, by product code, from
 * values this product controls. A finding body can therefore carry collapsible sections and
 * formatting without giving model output under hostile input any way to inject them.
 */

import type { CommitSha, VersionTag } from "../core/brands.js";
import { isReasonCode, type ReasonCode } from "../diagnostics/reason-codes.js";
import { extractMarker } from "./marker.js";
import { escapeInline } from "./sanitize.js";

export interface FindingContext {
  readonly path: string;
  readonly line: number;
  readonly severity: string | undefined;
  readonly category: string | undefined;
}

/**
 * Category labels.
 *
 * Deliberately coarse. A reader triaging a page of findings needs to know whether this is about
 * correctness or about tidiness; finer taxonomy buys nothing at a glance.
 */
const CATEGORIES: Readonly<Record<string, string>> = {
  security: "Security",
  bug: "Correctness",
  performance: "Performance",
  maintainability: "Maintainability",
  test: "Tests",
  documentation: "Documentation",
  other: "Review",
};

/** Severity labels. The word carries the meaning; the design system's text grammar carries it
 *  without colour on purpose — findings stay fully textual (design-system/, section 04). */
const SEVERITIES: Readonly<Record<string, string>> = {
  critical: "Critical",
  high: "Major",
  medium: "Minor",
  low: "Nit",
};

function label(
  table: Readonly<Record<string, string>>,
  key: string | undefined,
  fallback: string,
): string {
  if (key === undefined) return fallback;
  return table[key.toLowerCase()] ?? fallback;
}

/** Used when the model omits a classification or invents one outside the vocabulary. */
const FALLBACK_CATEGORY = "Review";
const FALLBACK_SEVERITY = "Minor";

/**
 * Comment assets are pinned to the full commit SHA the `kq-assets-v1` tag names — the SHA, not
 * the tag, for the same reason consumers pin this action by SHA: a tag is mutable, and a
 * published comment must never change appearance retroactively, nor be redirectable to content
 * this repository did not review. (This reviewer found that distinction itself, reviewing the
 * change that introduced the tag reference — Keiko-for-Quality#184.) The tag remains the
 * human-readable alias for the same commit. Findings deliberately do NOT use these assets: a
 * finding is an argument, and it renders as text everywhere, including in clients that strip
 * or block images. Icons appear only on the two product-voice surfaces — the run summary and
 * the coverage notice — where the word the icon decorates is always right next to it, which is
 * also why every `alt` is empty: with images blocked the surfaces degrade to exactly the text
 * they carried before icons.
 */
const ASSET_BASE =
  "https://raw.githubusercontent.com/oscharko-dev/Keiko-for-Quality/1869ec1ce1f4fa465d5a0d512f11f18b76ba9a9c/.github/assets/kq";

function assetIcon(name: string, size: number): string {
  return `<img src="${ASSET_BASE}/${name}.svg" width="${String(size)}" height="${String(size)}" alt="">`;
}

const MAX_TITLE_CHARS = 120;

/**
 * Splits the model's prose into a title and a body.
 *
 * The rule text asks for an imperative first line followed by a blank line. When the model complies
 * this is exact. When it does not, the first sentence becomes the title rather than forcing an
 * awkward split — a finding with a slightly long title still reads correctly, whereas one with a
 * truncated title reads as a bug in the reviewer.
 */
export function splitTitle(prose: string): { title: string; body: string } {
  const trimmed = prose.trim();
  const paragraphBreak = trimmed.indexOf("\n\n");
  if (paragraphBreak > 0 && paragraphBreak <= MAX_TITLE_CHARS) {
    const candidate = trimmed.slice(0, paragraphBreak).trim();
    if (!candidate.includes("\n")) {
      return { title: candidate, body: trimmed.slice(paragraphBreak).trim() };
    }
  }
  const sentenceEnd = /[.!?](\s|$)/.exec(trimmed);
  if (sentenceEnd !== null && sentenceEnd.index > 0 && sentenceEnd.index <= MAX_TITLE_CHARS) {
    const end = sentenceEnd.index + 1;
    return { title: trimmed.slice(0, end).trim(), body: trimmed.slice(end).trim() };
  }
  return { title: "", body: trimmed };
}

/**
 * The repair instruction handed to whichever agent picks the finding up.
 *
 * Two clauses in it are doing real work, and both are lessons the mature bots encode. "Verify
 * against the current code" stops an agent applying a finding the branch has already moved past.
 * "Reply with a reason instead of changing anything" gives it a legitimate way to decline, which is
 * what prevents a wrong finding from being force-fitted into the code just to clear the thread.
 */
function repairPrompt(context: FindingContext, title: string): string {
  // A line of 0 means the finding carries no usable anchor, so the instruction names the file alone
  // rather than pointing an agent at line zero.
  const atLine = context.line > 0 ? ` around line ${String(context.line)}` : "";
  const where = `${escapeInline(context.path)}${atLine}`;
  return [
    "Verify this finding against the current code before acting on it.",
    "",
    `In ${where}: ${title === "" ? "address the finding above." : title}`,
    "",
    "If it no longer applies, reply on the thread with a one-line reason and resolve it — do not",
    "change code to match a stale finding. If it does apply, keep the fix minimal, fix the cause",
    "rather than the symptom, and run this repository's own verification before pushing.",
  ].join("\n");
}

/**
 * Composes the published body.
 *
 * Order matters for scanning: classification, then the claim, then the argument, then the machinery.
 * A reader who only reads the first two lines should still learn what is wrong and how much it
 * matters.
 */
export function composeFindingBody(
  sanitizedProse: string,
  marker: string,
  context: FindingContext,
): string {
  const category = label(CATEGORIES, context.category, FALLBACK_CATEGORY);
  const severity = label(SEVERITIES, context.severity, FALLBACK_SEVERITY);
  const { title, body } = splitTitle(sanitizedProse);

  // The design system's text grammar: `SECURITY · CRITICAL`. Chosen over icons for findings on
  // purpose — see `ASSET_BASE`'s doc comment.
  const parts = [`**${category.toUpperCase()} · ${severity.toUpperCase()}**`, ""];
  if (title !== "") parts.push(`**${title}**`, "");
  parts.push(
    body,
    "",
    "<details>",
    "<summary>🤖 Prompt for AI agents</summary>",
    "",
    "```",
    repairPrompt(context, title),
    "```",
    "",
    "</details>",
    "",
    `<!-- ${marker} -->`,
  );
  return parts.join("\n");
}

/**
 * The one optional sentence naming how much of the review is missing.
 *
 * Rendered only from count keys `settle.ts` itself writes; an unknown shape renders nothing rather
 * than guessing. Returned as an array so the caller can splice it in without an empty line when
 * absent.
 */
function gapLine(counts: Readonly<Record<string, number>> | undefined): string[] {
  if (counts === undefined) return [];
  const { gap, reviewable, reviewed, expected } = counts;
  if (gap !== undefined && reviewable !== undefined) {
    return [
      "",
      `The run finished and kept its findings; ${String(gap)} of ${String(reviewable)} reviewable file(s) remain unreviewed and stay owed to the next run.`,
    ];
  }
  if (reviewed !== undefined && expected !== undefined) {
    return [
      "",
      `The engine reports ${String(reviewed)} of ${String(expected)} expected files reviewed.`,
    ];
  }
  return [];
}

/**
 * The body of the incomplete-review notice.
 *
 * Deliberately plainer than a finding: it is not a defect in the change, and dressing it up like
 * one would mislead. It still carries the repair block, because the operator action is real.
 */
export function composeIncompleteNotice(
  reasonCode: string,
  marker: string,
  counts?: Readonly<Record<string, number>>,
): string {
  return [
    // "COVERAGE" is deliberately outside the CATEGORIES vocabulary above, so the two composers
    // can never collide on their opening line — the invariant `isIncompleteNoticeBody` documents.
    `${assetIcon("out-incomplete", 14)} **COVERAGE · MAJOR**`,
    "",
    "**This change was not fully reviewed.**",
    "",
    `Keiko for Quality could not complete its review. Reason code: \`${escapeInline(reasonCode)}\`.`,
    // The size of the shortfall, when the settlement measured one (2026-08-06). Numbers only, and
    // only the settlement's own numbers: they are what separates "one file is still owed" from
    // "nothing was reviewed", which is the first question every reader of this notice asks — the
    // eight notices on Keiko#3002 could not answer it. Inserted between the reason line and the
    // fixed sentences below so `isOwnIncompleteNotice`'s detector text stays byte-identical.
    ...gapLine(counts),
    "",
    "Treat this pull request as unreviewed by this bot. Resolving this conversation does not make",
    "the review complete — it only records that someone looked.",
    "",
    "<details>",
    "<summary>🤖 Prompt for AI agents</summary>",
    "",
    "```",
    "Do not treat this pull request as reviewed. Check the reviewer's run for the reason code shown",
    "above and address the cause, or push a new head so the reviewer runs again. Resolve this",
    "conversation only once a later run has completed.",
    "```",
    "",
    "</details>",
    "",
    `<!-- ${marker} -->`,
  ].join("\n");
}

/**
 * True for a comment body this exact function produced — a fixed, product-controlled sentence,
 * never model content, and never reachable from `composeFindingBody`: no entry in `CATEGORIES`
 * above maps to "Coverage", the header word every incomplete notice opens with, so the two
 * composers can never collide on their opening line, and the sentence checked here is stricter
 * still.
 *
 * Exists so a later run can recognise its OWN past incomplete notices well enough to resolve the
 * ones a subsequent push has superseded (`github/client.ts`'s `resolveSupersededOwnNotices`),
 * without re-deriving the exact reason-code/head/path fingerprint that produced any given one just
 * to ask "was this mine". Kept next to `composeIncompleteNotice` on purpose, the same discipline
 * `rule-file.ts`/`sanitize.ts` document for themselves: change the template, update the detector in
 * the same diff, or a later run stops recognising its own past notices.
 *
 * The sentence alone (#42) is public, product-controlled text — visible in every published comment,
 * in this README, and in the committed `dist/index.js` — so it is guessable by anyone, not a secret
 * this reviewer alone could have written. Combined with `resolveSupersededOwnNotices` now also
 * requiring a provably exclusive identity (`action/identity.ts`), this raises the bar from "copy a
 * public sentence" to "also carry a well-formed marker" before the mutation this predicate gates
 * will even consider a thread. It does not make forgery impossible on its own — the fingerprint
 * `extractMarker` checks the SHAPE of, not the exact value of, has no secret component — but a
 * marker-less, sentence-only body (a contributor quoting the notice in conversation, say) no longer
 * qualifies at all.
 */
export function isIncompleteNoticeBody(body: string): boolean {
  return (
    body.includes("Keiko for Quality could not complete its review.") &&
    extractMarker(body) !== undefined
  );
}

/** Mirrors `ReviewOutcome` (`review.ts`) without importing it, so `publish/` never depends on the
 *  top-level review orchestrator — only the orchestrator depends on `publish/`. */
export type SummaryOutcome = "complete" | "incomplete" | "abandoned";

/**
 * Path and finding accounting for one run, aggregate only — never a per-path list. A path list on a
 * large pull request is noise, not signal, and every field here is a plain count already computed
 * by the production inventory and publication code, never restated from a fixture's own formula.
 */
export interface SummaryCounts {
  readonly totalPaths: number;
  readonly reviewablePaths: number;
  readonly excludedPaths: number;
  readonly mechanicallyClean: number;
  /** Submodule-pointer bumps on a critical path — see `ReviewReport.criticalPointers` (review.ts). */
  readonly criticalPointers: number;
  /** Reviewable paths a review-cache hit answered instead of the engine (v0.9.0). Always 0 when inert. */
  readonly cacheHits: number;
  /** Of the cache misses, how many were a content match the changed-path-set shape invalidated —
   *  see `ReviewReport.contextInvalidated` (review.ts). Always 0 when inert. */
  readonly contextInvalidated: number;
  /** Reviewable paths actually sent to the engine this run: `reviewablePaths - cacheHits`. */
  readonly freshlyReviewed: number;
  readonly findingsPublished: number;
  /** Suppressed as a near-duplicate of another finding in the SAME run (v0.12.0) — see
   *  `similarity.ts`'s `areIntraRunDuplicates`. Always a plain number here, never `undefined`: the
   *  optionality on `PublishOutcome.suppressedIntraRun` is a compile-time backward-compatibility
   *  concern for a literal written before the field existed, not a real absence this table has to
   *  represent — `buildSummaryReport` (`summary.ts`) already collapses it to `0` either way. */
  readonly suppressedIntraRun: number;
  readonly suppressedExactDuplicate: number;
  readonly suppressedSimilar: number;
  /** Suppressed against a resolved thread with a substantive disposition reply (Keiko-for-Quality#64). */
  readonly suppressedDispositioned: number;
  /** Suppressed as a restatement of a still-open conversation the anchored stages cannot see —
   *  push-outdated, or (2026-08-06) file-level with no line anchor at all; see `similarity.ts`'s
   *  `findsOutdatedRecurrence`. Always a plain number here, for the same reason
   *  `suppressedIntraRun` above is. */
  readonly suppressedRecurrence: number;
  /**
   * The four counters `publicationDegraded` (`review.ts`) actually decides complete-vs-incomplete
   * on. Without them, a reader of the summary comment could see `findingsPublished` fall short of
   * what the run's own diagnostics implied and have no visible reason why — these are that reason,
   * surfaced on the one comment meant to answer "what happened this run" without requiring a log.
   */
  readonly rejectedSanitization: number;
  readonly rejectedPlacement: number;
  readonly readbackFailures: number;
  readonly apiFailures: number;
}

/**
 * Both fields are `undefined` when the underlying diagnostic never fired this run — an engine
 * failure before `engine.run.completed`, or a run that never reached the engine at all. Absent is
 * rendered as omitted, never as a fabricated zero.
 */
export interface SummaryBudget {
  readonly allotted: number | undefined;
  readonly spent: number | undefined;
}

/**
 * The complete, typed input to `composeSummaryBody`.
 *
 * This is the enforcement mechanism for the run summary's central invariant: it must never carry
 * model or candidate-influenced text. Every field is a number, a closed-vocabulary reason code, a
 * branded SHA or version tag, or a narrowly trusted identifier sourced from the triggering event
 * payload (`pull_request.updated_at`) or the Actions runtime (`GITHUB_ACTION_REF`) — never engine
 * output, never a finding body. There is no `string` field here wide enough to hold arbitrary
 * prose, so a caller cannot smuggle unsanitized content through this type even by mistake.
 */
export interface SummaryReport {
  readonly outcome: SummaryOutcome;
  /** Populated only when `outcome` is `"incomplete"`. */
  readonly reason: ReasonCode | undefined;
  readonly headSha: CommitSha;
  /** ISO-8601 from the triggering event payload. Empty when the event carried none — never wall clock. */
  readonly eventTimestamp: string;
  readonly engineVersion: VersionTag;
  /** `GITHUB_ACTION_REF` — the ref/SHA the consumer pinned this run to. Empty outside Actions. */
  readonly actionVersion: string;
  readonly counts: SummaryCounts;
  readonly budget: SummaryBudget;
  /**
   * Wall-clock milliseconds `main.ts` measured around `performReview` — unlike `eventTimestamp`
   * above, this one IS a wall clock, deliberately. Issue #59 is visibility only: nothing here reads
   * this number back to gate or speed anything up.
   */
  readonly durationMs: number;
}

function shortSha(sha: CommitSha): string {
  return (sha as string).slice(0, 7);
}

/**
 * Re-validates the reason code against the closed vocabulary before it can reach the document.
 *
 * `report.reason` is already typed `ReasonCode | undefined`, so this looks redundant against the
 * type — until a caller builds a `SummaryReport` through an `as` cast or a hand-built object
 * literal that bypasses the type checker, which is precisely the scenario this guards against. A
 * value outside the closed vocabulary is rendered as `"unknown"`, never interpolated verbatim.
 */
function reasonText(reason: ReasonCode | undefined): string {
  if (reason === undefined) return "unknown";
  return isReasonCode(reason) ? reason : "unknown";
}

function outcomeText(report: SummaryReport): string {
  switch (report.outcome) {
    case "complete":
      return `${assetIcon("out-complete", 12)} complete`;
    case "abandoned":
      return `${assetIcon("out-abandoned", 12)} abandoned`;
    case "incomplete":
      return `${assetIcon("out-incomplete", 12)} incomplete (\`${reasonText(report.reason)}\`)`;
  }
}

/**
 * The metric table's rows, in the fixed order the epic's visibility requirement asks for: the path
 * accounting first, then the finding/dedup accounting, with the four duplicate-suppression stages
 * (v0.12.0's intra-run clustering, Keiko-for-Quality#38/#51's exact marker and phrasing-independent
 * similarity, #64's dispositioned recurrence) broken out separately rather than folded into one
 * number, in the same order those stages run: intra-run clustering happens first, inside
 * `planPublication`, before a candidate ever reaches the other three. These counts are independently
 * meaningful and are not required to sum to `totalPaths` — a generated, binary, or non-critical
 * pointer path is neither reviewable, excluded, nor mechanically clean, and omitting that remainder
 * from this compact table is deliberate (see the epic's leanness requirement). A CRITICAL pointer
 * bump is the one exception (#37): it is the supply-chain-relevant case CONTRIBUTING.md's threat
 * model names by name, and folding it into that same silent remainder is exactly the gap this row
 * closes.
 */
function countRows(counts: SummaryCounts): readonly string[] {
  const rows: readonly (readonly [string, number])[] = [
    ["Total paths", counts.totalPaths],
    ["Reviewable", counts.reviewablePaths],
    ["Excluded", counts.excludedPaths],
    ["Mechanically clean", counts.mechanicallyClean],
    ["Critical pointer changes (content not reviewable)", counts.criticalPointers],
    ["Replayed from cache", counts.cacheHits],
    ["Cache miss (path-set shape changed)", counts.contextInvalidated],
    ["Freshly reviewed", counts.freshlyReviewed],
    ["Findings published", counts.findingsPublished],
    ["Suppressed (intra-run duplicate)", counts.suppressedIntraRun],
    ["Suppressed (exact duplicate)", counts.suppressedExactDuplicate],
    ["Suppressed (similar)", counts.suppressedSimilar],
    ["Suppressed (dispositioned)", counts.suppressedDispositioned],
    ["Suppressed (outdated recurrence)", counts.suppressedRecurrence],
    ["Rejected (sanitization)", counts.rejectedSanitization],
    ["Rejected (placement)", counts.rejectedPlacement],
    ["Read-back failures", counts.readbackFailures],
    ["API failures", counts.apiFailures],
  ];
  return rows.map(([label, value]) => `| ${label} | ${String(value)} |`);
}

function budgetLine(budget: SummaryBudget): string | undefined {
  if (budget.allotted === undefined) return undefined;
  return budget.spent === undefined
    ? `Budget: ${String(budget.allotted)} tokens allotted`
    : `Budget: ${String(budget.allotted)} tokens allotted, ${String(budget.spent)} reported`;
}

/**
 * Whole seconds (Issue #59): this table is an operator's coarse overview, not a profiler, and
 * sub-second precision would not change any decision a reader makes from it. Always rendered —
 * `durationMs` is measured on every run, never conditionally, so there is no "unknown" case to omit
 * the way there is for `spent` below.
 */
function durationRow(durationMs: number): string {
  return `| Duration (s) | ${String(Math.round(durationMs / 1000))} |`;
}

/**
 * Rounded up, never down: a reader gauging whether spend is proportionate to output should never
 * see a number that understates real cost. Omitted rather than shown as a misleading zero when
 * spend was never measured this run (`budget.spent === undefined`), or when nothing published yet
 * exists to divide it by.
 */
function tokensPerFindingRow(budget: SummaryBudget, counts: SummaryCounts): string | undefined {
  if (budget.spent === undefined || counts.findingsPublished <= 0) return undefined;
  const perFinding = Math.ceil(budget.spent / counts.findingsPublished);
  return `| Tokens per published finding | ${String(perFinding)} |`;
}

/**
 * Composes the maintained run-summary comment (Keiko-for-Quality#31).
 *
 * `SummaryReport`'s own shape — see its doc comment — is what makes this function safe to call on
 * every run outcome, including one produced while reviewing hostile input: there is nothing in the
 * parameter type a prompt injection could have reached. Deliberately compact — counts and outcome,
 * never prose — so the comment stays a stable, scannable artifact this reviewer maintains in place
 * rather than a growing wall of text competing with the finding conversations it sits alongside.
 */
export function composeSummaryBody(report: SummaryReport, marker: string): string {
  const timestamp = report.eventTimestamp === "" ? undefined : escapeInline(report.eventTimestamp);
  const action = report.actionVersion === "" ? undefined : escapeInline(report.actionVersion);
  const headline = [
    outcomeText(report),
    `head \`${shortSha(report.headSha)}\``,
    ...(timestamp === undefined ? [] : [timestamp]),
    `engine \`${escapeInline(report.engineVersion)}\``,
    ...(action === undefined ? [] : [`action \`${action}\``]),
  ].join(" · ");

  const tokensPerFinding = tokensPerFindingRow(report.budget, report.counts);
  const parts = [
    `${assetIcon("reviewer", 18)} **Keiko for Quality — run summary**`,
    "",
    headline,
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    ...countRows(report.counts),
    durationRow(report.durationMs),
    ...(tokensPerFinding === undefined ? [] : [tokensPerFinding]),
  ];
  const budget = budgetLine(report.budget);
  if (budget !== undefined) parts.push("", budget);
  parts.push("", `<!-- ${marker} -->`);
  return parts.join("\n");
}
