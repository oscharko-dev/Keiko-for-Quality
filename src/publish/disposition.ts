/**
 * Whether a resolved thread's last reply counts as a considered disposition rather than a bare
 * "resolve" click (Keiko-for-Quality#64).
 *
 * The resolved-thread similarity stage (`similarity.ts`'s `findsDispositionedConversation`)
 * deliberately does not suppress on a bare resolve: Keiko-for-Quality#38 requires a genuinely
 * recurred defect to stay publishable, and a contributor who resolves a thread without saying why
 * has not decided anything an unconditional resolved check could safely rely on. Observed live on a
 * long-lived pull request (oscharko-dev/Keiko#2931, rounds 6-10): a dispositioned finding — reasoned
 * reply, thread resolved — reappeared as a "fresh" finding on every later run, because the similarity
 * stage's own resolved-thread exclusion has no memory of *why* a thread was resolved. This module
 * answers that narrower question: did someone write something substantive back, as opposed to
 * resolving silently or leaving only a templated signature line?
 */

/** The last reply on a resolved thread, as `github/client.ts`'s best-effort GraphQL lookup found it. */
export interface ThreadLastReply {
  readonly authorLogin: string;
  readonly body: string;
}

/**
 * The measurable floor for "substantive."
 *
 * Not arbitrary: it is comfortably below the shortest genuine disposition reply in this reviewer's
 * own production evidence ("Fixed in the linked commit, see the follow-up PR." clears it by a wide
 * margin) and comfortably above a bare "Resolved." or "Done, thanks." — the replies a contributor
 * leaves when they have not actually engaged with the finding.
 */
const MIN_SUBSTANTIVE_CHARS = 80;

/**
 * A line that is pure attribution or signature, not part of what the author is actually saying.
 *
 * This repository's own issues and pull requests append exactly this shape of line — an emoji-led
 * "Generated with <tool>" attribution, or a trailing "Co-Authored-By:" trailer — which is a
 * concrete enough pattern to generalize from: a reply that is *only* this, however long the linked
 * URL makes it, is not a disposition.
 */
const FOOTER_LINE = /^\s*(?:🤖\s*)?(?:generated with|co-authored-by:)/i;

/** An HTML comment: the exact shape this reviewer's own marker takes (`marker.ts`), and the general
 *  shape a templated signature block would also use. Never itself part of an authored argument. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Bounds `substantiveText`'s regex/scan cost against a hostile or degenerate reply body, mirroring
 * `similarity.ts`'s `MAX_INPUT_CHARS`/`clip()` exactly: `HTML_COMMENT`'s `[\s\S]*?` is the same
 * unanchored-scan shape a large, comment-free input turns quadratic — comfortably above
 * `MIN_SUBSTANTIVE_CHARS` so no real disposition's verdict can change, comfortably below any length
 * that makes the scan itself the cost. A thread's last reply is candidate-influenced content (an
 * attacker who can comment can shape what this function reads), the same trust boundary
 * `similarity.ts` already bounds for the identical reason.
 */
const MAX_INPUT_CHARS = 20_000;

function clip(text: string): string {
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

/** Strips signature and attribution noise, leaving only the text an author actually wrote. */
function substantiveText(body: string): string {
  return clip(body)
    .replace(HTML_COMMENT, " ")
    .split("\n")
    .filter((line) => !FOOTER_LINE.test(line))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when `lastReply` is a substantive disposition — long enough, once signature noise is
 * stripped, to be a considered answer rather than a bare acknowledgement.
 *
 * @param identity This reviewer's own posting identity. A thread whose only comment is its own root
 *   finding reports that same root comment back as `lastReply` (there is nothing else in the
 *   thread) — excluding it here is what keeps a bare "resolved, no reply at all" thread from ever
 *   being read as dispositioned, without `github/client.ts` needing to know what "dispositioned"
 *   means or care which login is this reviewer's own.
 */
export function isSubstantiveDisposition(
  lastReply: ThreadLastReply | undefined,
  identity: string,
): boolean {
  if (lastReply === undefined) return false;
  if (lastReply.authorLogin === identity) return false;
  return substantiveText(lastReply.body).length >= MIN_SUBSTANTIVE_CHARS;
}
