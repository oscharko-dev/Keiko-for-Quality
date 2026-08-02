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

import { escapeInline } from "./sanitize.js";

export interface FindingContext {
  readonly path: string;
  readonly line: number;
  readonly severity: string | undefined;
  readonly category: string | undefined;
}

interface Label {
  readonly icon: string;
  readonly text: string;
}

/**
 * Category labels.
 *
 * Deliberately coarse. A reader triaging a page of findings needs to know whether this is about
 * correctness or about tidiness; finer taxonomy buys nothing at a glance.
 */
const CATEGORIES: Readonly<Record<string, Label>> = {
  security: { icon: "🔒", text: "Security" },
  bug: { icon: "🐛", text: "Correctness" },
  performance: { icon: "⚡", text: "Performance" },
  maintainability: { icon: "🧹", text: "Maintainability" },
  test: { icon: "🧪", text: "Tests" },
  documentation: { icon: "📚", text: "Documentation" },
  other: { icon: "🔎", text: "Review" },
};

/** Severity labels. The colour carries the urgency; the word carries the meaning. */
const SEVERITIES: Readonly<Record<string, Label>> = {
  critical: { icon: "🔴", text: "Critical" },
  high: { icon: "🟠", text: "Major" },
  medium: { icon: "🟡", text: "Minor" },
  low: { icon: "🔵", text: "Nit" },
};

function label(
  table: Readonly<Record<string, Label>>,
  key: string | undefined,
  fallback: Label,
): Label {
  if (key === undefined) return fallback;
  return table[key.toLowerCase()] ?? fallback;
}

/** Used when the model omits a classification or invents one outside the vocabulary. */
const FALLBACK_CATEGORY: Label = { icon: "🔎", text: "Review" };
const FALLBACK_SEVERITY: Label = { icon: "🟡", text: "Minor" };

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
  const where = `${escapeInline(context.path)}${context.line > 0 ? ` around line ${String(context.line)}` : ""}`;
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

  const parts = [`_${category.icon} ${category.text}_ | _${severity.icon} ${severity.text}_`, ""];
  if (title !== "") parts.push(`**${title}**`, "");
  parts.push(body, "");
  parts.push(
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
 * The body of the incomplete-review notice.
 *
 * Deliberately plainer than a finding: it is not a defect in the change, and dressing it up like
 * one would mislead. It still carries the repair block, because the operator action is real.
 */
export function composeIncompleteNotice(reasonCode: string, marker: string): string {
  return [
    "_⚠️ Coverage_ | _🟠 Major_",
    "",
    "**This change was not fully reviewed.**",
    "",
    `Keiko for Quality could not complete its review. Reason code: \`${escapeInline(reasonCode)}\`.`,
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
