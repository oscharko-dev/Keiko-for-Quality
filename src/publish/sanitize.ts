/**
 * Content validation for anything this reviewer is about to publish.
 *
 * The body of a finding is model output produced while reading attacker-influenced input, so it is
 * treated as hostile by default. This module rejects rather than repairs: a rejected finding makes
 * the run incomplete, which is visible and blocking, whereas a silently rewritten one would publish
 * something no one wrote and no one reviewed.
 *
 * The engine is separately instructed not to emit any of these constructs, so a rejection here is
 * evidence that something went wrong — a model failure, or a successful injection — and not the
 * ordinary case.
 */

export type RejectionReason =
  | "control_characters"
  | "bidirectional_override"
  | "zero_width"
  | "html"
  | "suggestion_block"
  | "mention"
  | "image"
  | "link"
  | "credential"
  | "empty"
  | "too_long";

export type SanitizeResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: RejectionReason };

/** Newline and tab are the only control characters a Markdown body legitimately needs. */
// eslint-disable-next-line no-control-regex -- detecting control characters is this rule's purpose
const CONTROL_EXCEPT_WHITESPACE = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]");

/**
 * Bidirectional formatting characters can make rendered text read in a different order than it is
 * stored, so a comment can claim one thing to a human and another to a parser.
 */
const BIDIRECTIONAL = new RegExp("[\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u061C]");

/** Zero-width characters are invisible, which makes them a carrier for hidden content. */
// Each code point is rejected on its own. They are never meant to combine into a grapheme here —
// that they could is precisely why they are listed.
// eslint-disable-next-line no-misleading-character-class -- see above
const ZERO_WIDTH = new RegExp("[\\u200B\\u200C\\u200D\\u2060\\uFEFF\\u180E]");

/** Any tag-like construct. GitHub renders a subset of HTML, and that subset is enough. */
const HTML_TAG = new RegExp("<[A-Za-z!/?]");

/** A one-click-applicable code block. Never acceptable from a model reading hostile input. */
const SUGGESTION_BLOCK = new RegExp("```+\\s*suggestion", "i");

/** `@name` outside of code. Publishing one notifies a real person on the model's behalf. */
const MENTION = new RegExp("(^|[^\\w`])@[A-Za-z0-9][A-Za-z0-9-]{0,38}", "m");

const IMAGE = new RegExp("!\\[");

/**
 * Any URI scheme, plus protocol-relative and bare-www forms.
 *
 * The protocol-relative alternative requires a host-shaped segment immediately after the slashes —
 * `//example.test`, not `// a comment`. The `m` flag makes `^` match every line start, so the
 * earlier bare `^//` rejected any line beginning with a comment marker. The rule file invites a
 * short fenced code block showing the line at issue, and in JavaScript or TypeScript that block
 * very often contains one; the whole finding was then discarded and the run settled incomplete.
 * A correct review was lost to a pattern meant to catch a URL.
 */
const LINK = new RegExp("([A-Za-z][A-Za-z0-9+.-]*://|\\bwww\\.|^//[A-Za-z0-9-]+\\.[A-Za-z])", "m");

/**
 * Shapes that look like credentials.
 *
 * This is a backstop, not a secret scanner: the engine should never have been given a credential to
 * echo. It exists because the cost of publishing one publicly is unrecoverable.
 */
const CREDENTIAL_SHAPES = [
  new RegExp("gh[pousr]_[A-Za-z0-9]{16,}"),
  new RegExp("github_pat_[A-Za-z0-9_]{20,}"),
  new RegExp("sk-[A-Za-z0-9]{20,}"),
  new RegExp("-----BEGIN [A-Z ]*PRIVATE KEY-----"),
  new RegExp("(?:AKIA|ASIA)[A-Z0-9]{16}"),
  new RegExp("eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\."),
];

const MAX_BODY_CHARS = 8000;
const MIN_BODY_CHARS = 12;

/**
 * Checks that run against the RAW body: security- and form-relevant regardless of Markdown
 * context. A credential or control character inside a code span is exactly as dangerous as one
 * outside it, and a suggestion fence is detected by its own delimiter line.
 */
const RAW_CHECKS: readonly { readonly pattern: RegExp; readonly reason: RejectionReason }[] = [
  { pattern: CONTROL_EXCEPT_WHITESPACE, reason: "control_characters" },
  { pattern: BIDIRECTIONAL, reason: "bidirectional_override" },
  { pattern: ZERO_WIDTH, reason: "zero_width" },
  { pattern: SUGGESTION_BLOCK, reason: "suggestion_block" },
];

/**
 * Checks that run against the body with code regions MASKED. GitHub renders fenced blocks and
 * inline code spans literally, so markup inside them cannot smuggle HTML, images, links, or
 * mentions — while the qualification corpus proved the unmasked scan rejects legitimate reviews:
 * quoting `Record<string, string>` in a finding tripped the raw `<`-plus-letter test, and the
 * whole (correct) finding was lost. Masking is deliberately conservative: only well-delimited
 * regions are masked, and anything unbalanced stays visible to these checks — fail closed.
 */
const MASKED_CHECKS: readonly { readonly pattern: RegExp; readonly reason: RejectionReason }[] = [
  { pattern: HTML_TAG, reason: "html" },
  { pattern: IMAGE, reason: "image" },
  { pattern: LINK, reason: "link" },
  { pattern: MENTION, reason: "mention" },
];

/**
 * Replaces the CONTENT of well-delimited code regions with `x` runs of equal length, keeping the
 * delimiters and all offsets stable. Fenced blocks first (their content may contain backticks),
 * then single-line inline spans. Fences follow CommonMark's envelope: backtick or tilde runs of
 * three or more, up to three spaces of indentation, an info string (which a backtick fence
 * forbids backticks in), and a closing run of the same character at least as long, alone on its
 * line bar trailing blanks. Inline spans pair equal-length backtick runs, so a longer or
 * shorter run inside stays content (``escape `this` here``). Unclosed fences and unbalanced
 * inline backticks mask nothing — the text stays subject to the masked checks, which is the
 * strict side of every ambiguity.
 */
function maskCodeRegions(body: string): string {
  const maskLines = (content: string): string => content.replace(/[^\n]/g, "x");
  const maskFence = (
    whole: string,
    open: string,
    info: string,
    inner: string,
    close: string,
  ): string =>
    close.trim().length >= open.trim().length
      ? `${open}${info}\n${maskLines(inner)}\n${close}`
      : whole;
  let masked = body.replace(/^( {0,3}`{3,})([^`\n]*)\n([\s\S]*?)\n( {0,3}`{3,} *)$/gm, maskFence);
  masked = masked.replace(/^( {0,3}~{3,})([^\n]*)\n([\s\S]*?)\n( {0,3}~{3,} *)$/gm, maskFence);
  masked = masked.replace(
    /(?<!`)(`+)(?!`)((?:[^`\n]|`+)+?)\1(?!`)/g,
    (_whole, ticks: string, content: string) => `${ticks}${"x".repeat(content.length)}${ticks}`,
  );
  return masked;
}

function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_SHAPES.some((pattern) => pattern.test(text));
}

/**
 * Validates a finding body.
 *
 * Normalization is limited to trimming and collapsing runs of blank lines — changes that cannot
 * alter meaning. Everything else is a pass/fail decision.
 */
export function sanitizeFindingBody(raw: string): SanitizeResult {
  const body = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (body.length < MIN_BODY_CHARS) return { ok: false, reason: "empty" };
  if (body.length > MAX_BODY_CHARS) return { ok: false, reason: "too_long" };
  for (const check of RAW_CHECKS) {
    if (check.pattern.test(body)) return { ok: false, reason: check.reason };
  }
  const masked = maskCodeRegions(body);
  for (const check of MASKED_CHECKS) {
    if (check.pattern.test(masked)) return { ok: false, reason: check.reason };
  }
  if (looksLikeCredential(body)) return { ok: false, reason: "credential" };
  return { ok: true, body };
}

/**
 * Escapes text this product composes itself, such as a path inside a notice.
 *
 * Product-authored text still embeds candidate-controlled values, so it is escaped rather than
 * trusted for being ours.
 */
export function escapeInline(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}
