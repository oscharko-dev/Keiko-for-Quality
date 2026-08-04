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
  | { readonly ok: true; readonly body: string; readonly neutralized?: number }
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

/** A fence opener: up to three spaces, a run of three or more backticks or tildes, an info string. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A fence closer: the same run alone on its line, trailing blanks allowed. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Inline spans: equal-length backtick runs on one line, so a longer or shorter run inside stays
 * content (``escape `this` here``).
 *
 * The content class is a single unambiguous `[^\n]`. An earlier `(?:[^`\n]|`+)+?` let one backtick
 * run decompose many ways (three backticks as 3, or 1+2, or 2+1, or 1+1+1), which is exponential
 * backtracking on hostile input, not a nicety — this module validates model output produced while
 * reading attacker-influenced material, so a body of backticks is a reachable denial of service.
 */
const INLINE_SPAN = /(?<!`)(`+)(?!`)([^\n]+?)\1(?!`)/g;

/** Index of the line closing a fence opened with `marker`, or -1 when the fence never closes. */
function closingFenceIndex(lines: readonly string[], from: number, marker: string): number {
  const char = marker.slice(0, 1);
  for (let k = from; k < lines.length; k += 1) {
    const run = FENCE_CLOSE.exec(lines[k] ?? "")?.[1];
    if (run?.startsWith(char) === true && run.length >= marker.length) return k;
  }
  return -1;
}

/** The marker of a fence this line opens, or undefined when it opens none. */
function openingFenceMarker(line: string): string | undefined {
  const opened = FENCE_OPEN.exec(line);
  const marker = opened?.[1];
  if (marker === undefined) return undefined;
  // A backtick fence's info string may not contain a backtick; a tilde fence's may.
  if (marker.startsWith("`") && (opened?.[2] ?? "").includes("`")) return undefined;
  return marker;
}

/**
 * Masks the body of every closed fenced block, walking LINES rather than matching a multi-line
 * regex: the regex form was super-linear (Sonar S8786) because a lazy `[\s\S]*?` re-scans toward
 * every candidate closing line. A line walk is linear and states CommonMark's rules directly.
 */
function maskFencedBlocks(body: string): string {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const marker = openingFenceMarker(lines[i] ?? "");
    if (marker === undefined) continue;
    const close = closingFenceIndex(lines, i + 1, marker);
    if (close === -1) continue;
    for (let k = i + 1; k < close; k += 1) lines[k] = (lines[k] ?? "").replace(/./g, "x");
    i = close;
  }
  return lines.join("\n");
}

/**
 * Replaces the CONTENT of well-delimited code regions with `x` runs of equal length, keeping the
 * delimiters and all offsets stable. Fenced blocks first (their content may contain backticks),
 * then single-line inline spans. Unclosed fences and unbalanced inline backticks mask nothing —
 * the text stays subject to the masked checks, which is the strict side of every ambiguity.
 */
function maskCodeRegions(body: string): string {
  return maskFencedBlocks(body).replace(
    INLINE_SPAN,
    (_whole, ticks: string, content: string) => `${ticks}${"x".repeat(content.length)}${ticks}`,
  );
}

function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_SHAPES.some((pattern) => pattern.test(text));
}

/**
 * Neutralization: rewrites a specific, mechanically reversible prose slip into inline code, which
 * every check above already treats as inert — instead of discarding a whole finding over
 * formatting a model could just as easily have gotten right the first time. Production has already
 * lost a correct, high-severity finding this way (`Record<string, string>`, unbackticked), and the
 * rule text spends hundreds of words trying to talk the model out of the same handful of shapes.
 *
 * The asymmetry that limits this to exactly three shapes — an `@mention`, a bare URL, or an
 * unbackticked generic — is that each is, outside a code span, IDENTICAL in every publishable
 * respect to the same text already inside one: wrapping it changes only its Markdown escaping,
 * never what it says. A reversible formatting slip like this costs the consumer a blocked merge
 * today, over a fix that is entirely mechanical. Nothing else qualifies for that treatment. A real
 * HTML tag, an actual Markdown link, a credential shape, or a hidden or bidirectional character is
 * not a formatting accident — it is meaning-bearing or actively dangerous, rewriting it would
 * launder that into something publishable, and that is exactly what "reject rather than repair"
 * exists to prevent. Those keep failing closed, unchanged by anything below.
 *
 * Every rewrite here is found against a MASKED snapshot of the body (`maskCodeRegions`), so a span
 * already inside a code region is invisible to it: content masked to `x` cannot contain a literal
 * `@`, `://`, `www.`, or `<`. That makes neutralizing an already-backticked span impossible by
 * construction, which is also what makes a second pass over an already-neutralized body a no-op —
 * the idempotence this module's caller depends on falls out of reusing the masking machinery rather
 * than needing its own proof.
 */

/**
 * A half-open `[start, end)` range in the body, found against a masked snapshot but sliced from the
 * original text — masking never changes length or offsets, so the two stay addressable with the
 * same indices.
 */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * `MENTION`'s own token shape, extended with an optional scoped-package suffix (`@types/node`) so
 * the whole token is wrapped as one unit rather than leaving a bare `/node` dangling after a
 * partially-backticked `@types`. Deliberately no broader than that: the boundary and the first
 * character after `@` are copied verbatim from `MENTION`, so anything that does not already match
 * the shape the check rejects is left alone, and the check rejects it exactly as it did before this
 * pass existed.
 */
const MENTION_NEUTRALIZE = new RegExp(
  "(^|[^\\w`])(@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:/[A-Za-z0-9][A-Za-z0-9-]{0,38})?)",
  "gm",
);

/**
 * `LINK`'s first two alternatives — scheme and bare `www.` — deliberately without its third: the
 * protocol-relative `^//host` form is rare in prose and already shares its shape with an accepted
 * divider of slashes (see `LINK`'s own comment), so it is left to keep rejecting rather than
 * guessed at.
 */
const LINK_NEUTRALIZE = new RegExp("([A-Za-z][A-Za-z0-9+.-]*://|\\bwww\\.)\\S*", "g");

/** Trailing punctuation that closes a sentence or a parenthetical, not the URL itself. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** An identifier immediately followed by `<` — the head of a generic type reference. */
const GENERIC_HEAD = /[A-Za-z_$][\w$]*</g;

function mentionSpans(masked: string): Span[] {
  const spans: Span[] = [];
  for (const match of masked.matchAll(MENTION_NEUTRALIZE)) {
    const boundary = match[1] ?? "";
    const token = match[2] ?? "";
    const start = match.index + boundary.length;
    spans.push({ start, end: start + token.length });
  }
  return spans;
}

/**
 * A Markdown inline link's destination sits immediately after `](` with no space between, per
 * CommonMark — the one shape neutralization must never touch. Backtick-wrapping only the URL would
 * leave the link syntax intact around it, and a destination that merely looks broken can still
 * render as a clickable link — a rendered link is exactly what the redaction contract forbids, and
 * rewriting its syntax would change meaning rather than just its escaping. That case must keep
 * failing closed, so it is excluded here rather than left for a check further down to catch.
 */
function isLinkDestination(masked: string, start: number): boolean {
  return masked.slice(Math.max(0, start - 2), start) === "](";
}

function linkSpans(masked: string): Span[] {
  const spans: Span[] = [];
  for (const match of masked.matchAll(LINK_NEUTRALIZE)) {
    const start = match.index;
    if (isLinkDestination(masked, start)) continue;
    const trimmed = match[0].replace(URL_TRAILING_PUNCTUATION, "");
    if (trimmed.length === 0) continue;
    spans.push({ start, end: start + trimmed.length });
  }
  return spans;
}

/**
 * Index of the `>` that balances the `<` at `openAngle`, scanning forward on the SAME line only —
 * "on one line" is part of the shape this rewrites, not an incidental limit. Returns -1 when the
 * line ends, or the body does, before depth returns to zero, which leaves the candidate for
 * `HTML_TAG` to reject exactly as before this pass existed.
 */
function balancedGenericEnd(masked: string, openAngle: number): number {
  let depth = 1;
  for (let i = openAngle + 1; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === "\n") return -1;
    if (c === "<") depth += 1;
    else if (c === ">") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Spans shaped like `Record<string, string>`. `HTML_TAG` cannot itself tell this from a real tag —
 * both are `<` immediately followed by a letter — so the signal used here is the one `HTML_TAG`
 * does not look at: an identifier directly before the `<`, and a balanced close on the same line.
 * A closing tag's `/`, a comment's `!`, or a processing instruction's `?` right after the `<` is
 * excluded explicitly, so `content</div>` is never mistaken for a generic whose content happens to
 * close early — that shape keeps rejecting, same as a bare `<div>` or `<!--` with nothing in front
 * of it that reads as an identifier at all.
 */
function genericSpans(masked: string): Span[] {
  const spans: Span[] = [];
  for (const match of masked.matchAll(GENERIC_HEAD)) {
    const start = match.index;
    const openAngle = start + match[0].length - 1;
    const next = masked.charAt(openAngle + 1);
    if (next === "" || "/!?".includes(next)) continue;
    const end = balancedGenericEnd(masked, openAngle);
    if (end !== -1) spans.push({ start, end: end + 1 });
  }
  return spans;
}

/**
 * Sorts by start and drops any span that starts before the previous accepted one ends, so two
 * candidates that overlap — a nested generic inside an outer one, in practice — keep only the
 * outer, earlier-starting span rather than double-wrapping the same text.
 */
function resolveOverlaps(spans: readonly Span[]): Span[] {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const accepted: Span[] = [];
  for (const span of ordered) {
    const last = accepted[accepted.length - 1];
    if (last !== undefined && span.start < last.end) continue;
    accepted.push(span);
  }
  return accepted;
}

/**
 * Wraps every accepted span in backticks, in one left-to-right pass over the ORIGINAL body — never
 * the masked one, and never re-scanning a span's own output. That single pass is what keeps this
 * bounded on adversarial input: nothing here re-processes rewritten text looking for more to do.
 */
function applySpans(body: string, spans: readonly Span[]): string {
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += body.slice(cursor, span.start) + "`" + body.slice(span.start, span.end) + "`";
    cursor = span.end;
  }
  return result + body.slice(cursor);
}

interface NeutralizeOutcome {
  readonly body: string;
  readonly neutralized: number;
}

function neutralize(body: string): NeutralizeOutcome {
  const masked = maskCodeRegions(body);
  const spans = resolveOverlaps([
    ...mentionSpans(masked),
    ...linkSpans(masked),
    ...genericSpans(masked),
  ]);
  if (spans.length === 0) return { body, neutralized: 0 };
  return { body: applySpans(body, spans), neutralized: spans.length };
}

/** True when some fence in the body never closes — the same walk `maskFencedBlocks` performs,
 *  reported as a boolean instead of applied. */
function hasUnclosedFence(body: string): boolean {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const marker = openingFenceMarker(lines[i] ?? "");
    if (marker === undefined) continue;
    const close = closingFenceIndex(lines, i + 1, marker);
    if (close === -1) return true;
    i = close;
  }
  return false;
}

/**
 * Gates the whole pass on fence closure: an unclosed fence makes `maskCodeRegions` leave that
 * region visible to every check rather than guess where it ends (see `maskFencedBlocks`'s own doc
 * comment), and that same uncertainty makes it impossible to trust ANY span in the body as
 * definitely-prose rather than the inside of a fence whose delimiter never arrived. Neutralization
 * runs nowhere in that case rather than somewhere by guesswork — the existing fail-closed rationale,
 * extended from masking to the pass that depends on it.
 */
function neutralizeGuardingUnclosedFence(body: string): NeutralizeOutcome {
  return hasUnclosedFence(body) ? { body, neutralized: 0 } : neutralize(body);
}

/**
 * Adds the `neutralized` count only when a rewrite happened, so an ordinary body's result is
 * exactly `{ ok: true, body }`, as it was before this pass existed. `exactOptionalPropertyTypes`
 * makes an explicit `neutralized: undefined` a type error in this project regardless, so omission
 * is the only spelling of "none" available here.
 */
function withNeutralizedCount(body: string, neutralized: number): SanitizeResult {
  return neutralized > 0 ? { ok: true, body, neutralized } : { ok: true, body };
}

/**
 * Validates a finding body, neutralizing what is mechanically fixable along the way.
 *
 * Normalization is limited to trimming and collapsing runs of blank lines — changes that cannot
 * alter meaning. The RAW checks (control characters, bidirectional overrides, zero-width
 * characters, a suggestion fence, and the credential backstop) run first and are untouched by
 * neutralization: none of those is reversible formatting, and a credential or a steganographic
 * carrier must never be rewritten into something publishable. Only after those does neutralization
 * get a chance to turn a `mention`/`link`/`html` false positive into inline code, BEFORE the masked
 * checks run — a successfully neutralized span no longer trips them. Everything else remains a
 * pass/fail decision.
 */
export function sanitizeFindingBody(raw: string): SanitizeResult {
  const body = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (body.length < MIN_BODY_CHARS) return { ok: false, reason: "empty" };
  for (const check of RAW_CHECKS) {
    if (check.pattern.test(body)) return { ok: false, reason: check.reason };
  }
  if (looksLikeCredential(body)) return { ok: false, reason: "credential" };

  const { body: candidate, neutralized } = neutralizeGuardingUnclosedFence(body);

  // Checked AFTER neutralization, not before: a backtick pair adds two characters, so a body that
  // only clears 8000 once its own rewrites are undone is still over the bound. Honesty about size
  // outranks the convenience of a rewrite that only fits by construction.
  if (candidate.length > MAX_BODY_CHARS) return { ok: false, reason: "too_long" };
  const masked = maskCodeRegions(candidate);
  for (const check of MASKED_CHECKS) {
    if (check.pattern.test(masked)) return { ok: false, reason: check.reason };
  }
  return withNeutralizedCount(candidate, neutralized);
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
