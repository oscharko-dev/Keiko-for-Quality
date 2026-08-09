/**
 * The reviewed file, whole, with its changed lines marked.
 *
 * ## Why this replaces the hunk view
 *
 * Measured on nine real pull requests (2026-08-08, `corpus/evidence/harvest-2026-08-09-baseline-window.md`):
 * of this reviewer's findings that a reader answered and git corroborated, **25.8%** were right.
 * Codex, reviewing the same pull requests, was right about **95.9%**. That gap is not a tuning
 * deficit and no filter closes it — the arithmetic of the target rules that out.
 *
 * The cause is a construction decision this module reverses. Single-shot showed the model the
 * CHANGED HUNKS of a file and then asked it to review the file. Almost every refutation in that
 * window is the same shape: a claim about what the file does, or fails to do, made from an excerpt
 * that cannot show it. "Reject records that include `voiceProfiles`" went out against a file whose
 * guard sits at line 655 of 1129. An excerpt can show presence; it can never show absence. Codex is
 * not smarter — it can open the file.
 *
 * So the model gets the file. Not as a second opinion after the fact (that is `verify-claims.ts`,
 * which cleans up afterwards and stays), but as the thing it reads in the first place.
 *
 * ## The one design rule everything here follows
 *
 * **The file is context. The change is the subject.** A reviewer handed a whole file will happily
 * report every pre-existing blemish in it, which would be a different product and a worse one — the
 * reader asked about their change. So changed lines carry a marker, and the prompt names the marker
 * as the boundary of what may be reported. The rest of the file exists to make claims checkable,
 * never to become findings of its own.
 *
 * ## What is deliberately NOT done here
 *
 * No summarising, no chunking, no "relevant excerpt" selection. Every one of those reintroduces the
 * exact failure being removed: a model reasoning about code it was not shown. A file that does not
 * fit under `MAX_REVIEW_FILE_CHARS` falls back to the hunk view and says so in the prompt, because a
 * partial file presented as a whole one is worse than an honest excerpt.
 */

/**
 * The ceiling for sending a file whole in the FINDING call.
 *
 * Deliberately HALF of `MAX_VERIFY_FILE_CHARS` (160k) rather than equal to it, and the gap is the
 * design. Equal ceilings would leave a file that is too large to show whole also too large to
 * verify — every big file would lose both the whole-file view and the verification pass at once,
 * which is strictly worse than what shipped before. Splitting them gives three honest bands:
 *
 * | file size      | finding call sees | verification pass |
 * |----------------|-------------------|-------------------|
 * | ≤ 80k chars    | the whole file    | skipped (it already read the file) |
 * | 80k – 160k     | the hunks         | runs, as before   |
 * | > 160k         | the hunks         | skipped, as before |
 *
 * The lower ceiling is also the honest one for this call specifically: the finding prompt carries
 * the rule document (~16.5k chars) and any companion hunks alongside the file, where the verify
 * prompt carries a few lines of instruction and the claims. Same budget, less room for the file.
 *
 * 80k characters is roughly a 2,000-line source file — above every hand-written file in the
 * consumer's reviewed surface.
 */
export const MAX_REVIEW_FILE_CHARS = 80_000;

/**
 * How much file a change has to earn — the ceiling on file characters per character of diff.
 *
 * The absolute ceiling above is not enough on its own, and the first live measurement proved it:
 * sending every file whole on Keiko#3011 cost 296,123 tokens against 203,691, **+45%**. Reading the
 * per-file sizes back showed where it went. `keiko-contracts/src/index.test.ts` is 68,791 characters
 * and its change is 627 — the review paid for 110 characters of file per character of change.
 * That is not context, it is ballast, and it buys nothing: a 627-character edit is not made
 * checkable by 68 kilobytes of unrelated tests.
 *
 * So a file rides along whole when it is at most this many times its own diff. The number is set
 * from that measurement rather than from taste: at 12, fourteen of Keiko#3011's nineteen files stay
 * whole and the five worst offenders fall back, cutting roughly 164,000 characters of prompt.
 *
 * The five that fall back are not left unprotected, and this is what makes the rule safe. They take
 * the path that shipped in v0.21.2 — hunks in the finding call, then the whole-file verification
 * pass for any claim that needs the file. A big file with a tiny change is exactly where an absence
 * claim is most tempting, and it is exactly what that pass was built for. So the cost stays
 * CONDITIONAL there — paid only when a claim actually needs the file — while cheap files get the
 * file up front unconditionally, where it costs almost nothing.
 */
export const MAX_FILE_TO_DIFF_RATIO = 12;

/**
 * Below this, the ratio does not apply: a small file is cheap whatever its diff.
 *
 * Without a floor, the ratio would push tiny files with one-line changes onto the fallback path for
 * a saving measured in hundreds of characters, and cost them the up-front evidence for it. A
 * one-line change to a 5 kB barrel file is exactly the case where seeing the whole file is nearly
 * free and settles the question outright.
 */
export const WHOLE_FILE_FLOOR_CHARS = 12_000;

/** The marker on a line this pull request added or changed, in the numbered whole-file view. */
export const CHANGED_MARKER = "+";

/** The marker on a line that was already there — one character wide, so the numbering stays aligned. */
export const CONTEXT_MARKER = " ";

/**
 * The new-file line numbers this diff fragment adds or modifies.
 *
 * Walks the unified-diff hunk headers and counts forward, exactly as the numbered-hunk renderer
 * does, so a line marked changed here is a line the hunk view would have shown with a `+`. Removed
 * lines have no new-file number and therefore cannot be marked — that is a real limitation of a
 * whole-file view and the reason `deletedLineHints` exists below.
 */
export function changedNewFileLines(fileDiff: string): ReadonlySet<number> {
  const changed = new Set<number>();
  walkHunks(fileDiff, (kind, newLine) => {
    if (kind === "added") changed.add(newLine);
  });
  return changed;
}

/**
 * Walks a fragment's hunk bodies, reporting each line's kind and the new-file number it sits at.
 *
 * One walker for both readers below, so they can never drift on what counts as an added line.
 *
 * The `--- a/x` and `+++ b/x` file headers need no special case: they precede the first `@@`, and
 * until one is seen `newLine` is 0 and every line is skipped. Testing for them by prefix would be
 * the bug it looks like a fix for — an ADDED line whose own text begins with `++` is written `+++`
 * in a diff, and a prefix test would silently drop it.
 */
function walkHunks(
  fileDiff: string,
  visit: (kind: "added" | "removed" | "context", newLine: number, text: string) => void,
): void {
  let newLine = 0;
  for (const line of fileDiff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header?.[1] !== undefined) {
      newLine = Number(header[1]);
      continue;
    }
    if (newLine === 0) continue;
    if (line.startsWith("+")) {
      visit("added", newLine, line.slice(1));
      newLine += 1;
    } else if (line.startsWith("-")) {
      // A removed line occupies no new-file number, so the counter does not advance — it names the
      // line the deletion happened AT, which is what anchors the hint below.
      visit("removed", newLine, line.slice(1));
    } else if (line.startsWith(" ") || line === "") {
      visit("context", newLine, line.slice(1));
      newLine += 1;
    }
  }
}

/**
 * The lines this change REMOVED, as text, grouped by where they were removed from.
 *
 * A whole-file view shows what the code is now and is structurally blind to what it stopped being —
 * and "this change deleted the guard" is a real defect class. The hunk view carried it in
 * `__old hunk__`; this restores it in the smallest form that keeps it: the removed text itself,
 * anchored to the new-file line it was removed at.
 */
export function deletedLineHints(fileDiff: string): readonly string[] {
  const hints: string[] = [];
  walkHunks(fileDiff, (kind, newLine, text) => {
    if (kind === "removed") hints.push(`at ${String(newLine)}: ${text}`);
  });
  return hints;
}

/** How many hint lines travel with one file — enough to carry a deleted guard, not a whole rewrite. */
const MAX_DELETED_HINTS = 60;

/**
 * The file, every line numbered, each marked as changed by this pull request or as pre-existing
 * context.
 *
 * The numbering is the same one `numberFileLines` (`verify-claims.ts`) uses and the same one the
 * hunk view emitted, so `start_line` means the identical thing across every stage of this pipeline.
 * That continuity is why the anchoring, placement, and similarity stages downstream need no change
 * at all for this view.
 */
export function renderWholeFile(fileText: string, changed: ReadonlySet<number>): string {
  return fileText
    .split("\n")
    .map((line, index) => {
      const number = index + 1;
      const marker = changed.has(number) ? CHANGED_MARKER : CONTEXT_MARKER;
      return `${String(number)}${marker}${line}`;
    })
    .join("\n");
}

/**
 * Whether this file is worth showing whole, or must fall back to its hunks.
 *
 * Two independent refusals, and they refuse for different reasons. The absolute ceiling is about
 * what fits in one prompt beside the rule document. The ratio is about what the change has earned:
 * a file may be small enough to send and still be a bad trade against a two-line edit.
 */
export function fitsWholeFile(fileText: string, fileDiff: string): boolean {
  if (fileText.length > MAX_REVIEW_FILE_CHARS) return false;
  if (fileText.length <= WHOLE_FILE_FLOOR_CHARS) return true;
  // A fragment with no body cannot justify anything — treat it as an infinite ratio rather than
  // dividing by zero into `Infinity <= 12`, which reads as false only by accident.
  if (fileDiff.length === 0) return false;
  return fileText.length <= fileDiff.length * MAX_FILE_TO_DIFF_RATIO;
}

/**
 * The `<current_file>` block: the whole file, its change markers, and what the change removed.
 *
 * Returns `undefined` when the file does not fit, which is the caller's signal to fall back to the
 * hunk view rather than to send a truncated file — a half file presented as a whole one would
 * license exactly the absence claims this module exists to prevent.
 */
export function buildWholeFileBlock(
  fileText: string,
  fileDiff: string,
): { readonly block: string; readonly changedCount: number } | undefined {
  if (!fitsWholeFile(fileText, fileDiff)) return undefined;
  const changed = changedNewFileLines(fileDiff);
  const deleted = deletedLineHints(fileDiff);
  const shownHints = deleted.slice(0, MAX_DELETED_HINTS);
  const omitted = deleted.length - shownHints.length;
  return {
    changedCount: changed.size,
    block: [
      "<current_file>",
      "The COMPLETE file at the reviewed head. Every line is numbered. The character right after",
      `the number is \`${CHANGED_MARKER}\` for a line THIS pull request added or changed, and a space`,
      "for a line that was already there.",
      "",
      renderWholeFile(fileText, changed),
      "</current_file>",
      ...(shownHints.length === 0
        ? []
        : [
            "",
            "<removed_by_this_change>",
            "Lines this pull request DELETED, with the line they were removed at. They are no longer",
            "in the file above — consult these when judging whether the change dropped something.",
            "",
            ...shownHints,
            ...(omitted > 0 ? [`(${String(omitted)} further removed line(s) not shown)`] : []),
            "</removed_by_this_change>",
          ]),
    ].join("\n"),
  };
}

/**
 * The system-prompt paragraph that governs the whole-file view.
 *
 * Two instructions carry the entire behavioural difference, and both are here rather than in the
 * shared rule document because they are true only in this mode:
 *
 * 1. **The scope rule.** Without it, a model handed a whole file reports the whole file. The reader
 *    asked about their change; a review that arrives with forty pre-existing observations is a
 *    different product and an unwelcome one.
 * 2. **The permission rule.** The reason this view exists is to make absence claims CHECKABLE, so
 *    the prompt must say plainly that they are now allowed — and equally plainly that they are
 *    allowed *because* the evidence is present, which means a claim about anything outside this
 *    file is still forbidden.
 */
export const WHOLE_FILE_PROMPT = [
  "You are shown the COMPLETE file, not an excerpt. Lines this pull request changed are marked with",
  `\`${CHANGED_MARKER}\` directly after the line number; every other line is pre-existing context.`,
  "",
  "SCOPE — report only what THIS CHANGE is responsible for:",
  "- a defect the marked lines introduce;",
  "- a defect the marked lines leave behind because they changed something adjacent and missed this;",
  "- something the change removed that the file still needs (see `<removed_by_this_change>`).",
  "A pre-existing problem on an unmarked line is NOT a finding. The file is here so your claims can",
  "be checked, not so it can be audited. If you cannot tie a finding to the marked lines, drop it.",
  "",
  "EVIDENCE — because you can see the whole file, you are now expected to check before claiming:",
  '- Before writing that something is missing, absent, unhandled, unvalidated, or "never" done,',
  "  SEARCH THE FILE ABOVE for it. If the file already does it anywhere, there is no finding.",
  "- Before writing that a symbol behaves a certain way, find its definition or use in the file.",
  "- A claim about code NOT in this file remains forbidden. You still cannot see the rest of the",
  "  repository, and a guess about it is not a finding.",
  "",
  "`start_line`/`end_line` are the numbers in this file. Anchor every finding to a MARKED line.",
].join("\n");
