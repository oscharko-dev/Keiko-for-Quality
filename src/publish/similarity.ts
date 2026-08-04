import { normalizeUnicodeText } from "./marker.js";

/**
 * The second, phrasing-independent deduplication stage.
 *
 * The exact-marker stage in `marker.ts` suppresses a repost only when the model's wording of a
 * finding is byte-for-byte the same as before (after light cosmetic normalization). A model asked to
 * describe the same defect twice routinely varies its wording enough to change that hash, and the
 * exact-marker stage then has nothing to compare against — the repost is published as if it were new
 * (Keiko-for-Quality#38).
 *
 * This stage does not replace the marker: it runs only after the marker check has already found no
 * match, and it reasons about *where* a finding sits and *what it overlaps in meaning*, not what its
 * hash is. A candidate is a duplicate of an existing conversation when all of the following hold:
 *
 * - the conversation is this reviewer's own (authorship, reused from the marker stage's own check —
 *   spoofing an unresolved-open conversation is exactly as dangerous as spoofing a marker);
 * - the conversation is still open (a resolved or outdated thread must not silence a recurrence);
 * - it anchors the same file path;
 * - its line range overlaps the candidate's, allowing a small tolerance for unrelated drift; and
 * - its body is conservatively similar to the candidate's — either a shared quoted code snippet, or
 *   token-set overlap above a threshold with enough shared content words to be meaningful.
 *
 * Every one of those is a narrowing condition. When any of them is uncertain or fails, this stage
 * returns "not a duplicate" — losing a real finding to over-eager suppression is worse than
 * publishing an occasional duplicate.
 *
 * `areIntraRunDuplicates`, below, reuses this file's conservative judgement for a separate,
 * INTRA-run stage that `publisher.ts` runs on sanitized candidates before any cross-run stage —
 * marker, similarity, or dispositioned — ever sees them (v0.12.0). It answers a different question:
 * whether two of THIS run's own candidates describe the same defect at the same place, which none
 * of the stages above can catch, because they only ever compare a candidate against an
 * ALREADY-PUBLISHED conversation, and two candidates from one run arrive together, before either is
 * published. It is built from the identical `linesOverlap` (including the nonpositive-anchor rule)
 * and token/snippet similarity core this file already uses, so "duplicate" means the same thing
 * everywhere in it; only eligibility — which pairs a stage may even compare — differs between them.
 */

export interface ExistingConversation {
  readonly path: string;
  readonly authorLogin: string;
  /** True once the conversation is resolved or the diff hunk it anchored is now outdated. */
  readonly resolved: boolean;
  /**
   * True when `resolved` and this thread's last reply was a substantive disposition rather than a
   * bare resolve (Keiko-for-Quality#64) — see `disposition.ts`. Always `false` when not resolved,
   * and computed independently of `resolved` so a caller can never read it as "resolved" on its own.
   */
  readonly dispositioned: boolean;
  readonly body: string;
  /** Absent when this conversation carries no usable line anchor (a file-level comment). */
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
}

export interface SimilarityCandidate {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
}

/**
 * The shape `areIntraRunDuplicates` compares, below.
 *
 * Structurally identical to `SimilarityCandidate` — the same four fields — but named and
 * documented separately because the role differs. A `SimilarityCandidate` is always one half of an
 * ASYMMETRIC comparison against an `ExistingConversation`: one side raw, one side composed. Two
 * `CandidateForDedup` values are compared against EACH OTHER, symmetrically, and neither side is
 * ever composed — both are this run's own raw sanitized prose, straight from `sanitizeFindingBody`,
 * with nothing yet published for either one to be composed from.
 */
export interface CandidateForDedup {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
}

/** How far a conversation's anchor may drift from the candidate's and still count as the same spot. */
const LINE_TOLERANCE = 2;

/**
 * Overlap-coefficient threshold for the two bodies' content-word sets: shared words divided by the
 * smaller body's own word count.
 *
 * Chosen over Jaccard (shared / union) because paraphrases of the same finding are often quite
 * different in length — one terse, one hedged — and Jaccard's union term punishes exactly that size
 * difference regardless of how much of the shorter body the longer one actually contains. Calibrated
 * against the three real production paraphrases in Keiko-for-Quality#38: their weakest pairing
 * shares exactly half of the smaller body's words, and every pairing shares at least
 * `MIN_SHARED_TOKENS`.
 *
 * Known limitation: this is a bag-of-words measure, so it cannot always tell "the same defect,
 * reworded" apart from "a different defect described in the same sentence template with one key
 * identifier swapped" — the second case can score *higher* than a genuine paraphrase, because it
 * differs by fewer words. Nothing measured against production evidence exercises that shape yet; if
 * it starts to, the fix is a signal that weighs a swapped identifier more than a swapped adjective,
 * not a smaller threshold, which would only cost recall on the paraphrases this stage exists to
 * catch.
 */
const SIMILARITY_THRESHOLD = 0.5;

/** Below this many shared content words, a ratio above the threshold is not a meaningful signal. */
const MIN_SHARED_TOKENS = 4;

/**
 * Minimum length, after whitespace collapse, for a shared fenced code block to count toward
 * `shareCodeBlock`'s own branch of `bodiesAreSimilar` — a long-enough shared snippet is still
 * sufficient on its own, with no prose overlap required at all; this only raises how long "long
 * enough" is.
 *
 * Below this length, a quoted fragment tends to identify a LOCATION — a one-line signature, a single
 * call site two unrelated findings both happen to quote — rather than the FINDING itself, and
 * location overlap is already what `linesOverlap`'s tolerance band checks. At the old 8-character
 * floor, something as short as `const x=1;` qualified on its own, so two different defects that both
 * quoted the same short line within the line-tolerance band could collapse into one. 24 characters
 * still comfortably covers a real quoted statement or expression — the kind of snippet that is
 * itself evidence of the same defect, not just the same neighbourhood.
 */
const MIN_SHARED_SNIPPET_CHARS = 24;

/** Bounds tokenization cost against a hostile or degenerate body regardless of caller behaviour. */
const MAX_INPUT_CHARS = 20_000;

/**
 * Short, topic-neutral words filtered before comparison so the signal concentrates on identifiers
 * and domain terms — the words that actually distinguish one defect from another.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "are",
  "this",
  "that",
  "with",
  "from",
  "when",
  "does",
  "not",
  "but",
  "was",
  "were",
  "been",
  "have",
  "has",
  "had",
  "will",
  "would",
  "into",
  "than",
  "then",
  "there",
  "their",
  "which",
  "while",
  "should",
  "could",
  "about",
  "your",
  "you",
]);

function clip(text: string): string {
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

/** Extracts fenced code blocks, normalized so incidental whitespace does not defeat comparison. */
function codeBlocks(text: string): ReadonlySet<string> {
  const matches = clip(text).match(/```[\s\S]*?```/g) ?? [];
  return new Set(
    matches
      .map((block) => block.replace(/\s+/g, " ").trim())
      .filter((block) => block.length >= MIN_SHARED_SNIPPET_CHARS),
  );
}

/** True when the two bodies quote at least one identical fenced code block. */
function shareCodeBlock(a: string, b: string): boolean {
  const blocksA = codeBlocks(a);
  if (blocksA.size === 0) return false;
  for (const block of codeBlocks(b)) {
    if (blocksA.has(block)) return true;
  }
  return false;
}

/**
 * Lowercased, code-fence-stripped, stopword-filtered content words. Unicode-aware for non-English
 * review output.
 *
 * Canonicalized through `marker.ts`'s `normalizeUnicodeText` before this function's own keep-set
 * (`\p{L}\p{N}`, still Unicode-wide — unlike the fingerprint's ASCII-only skeleton) and stopword/
 * length filter run, so the two dedup stages now agree on what "the same text" looks like at the
 * Unicode-encoding level (NFC form, curly quotes, exotic spaces, zero-width characters, case) — see
 * that function's doc comment for exactly which dimensions and why it lives there rather than here.
 */
function tokenize(text: string): ReadonlySet<string> {
  const withoutCode = clip(text).replace(/```[\s\S]*?```/g, " ");
  const words = normalizeUnicodeText(withoutCode)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return new Set(words);
}

/** Overlap coefficient (shared / smaller set) plus the raw count — see `SIMILARITY_THRESHOLD`. */
function tokenOverlap(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): { readonly score: number; readonly shared: number } {
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  const smaller = Math.min(a.size, b.size);
  return { score: smaller === 0 ? 0 : shared / smaller, shared };
}

/**
 * Strips the structural wrapper `composeFindingBody` (`presentation.ts`) builds around every
 * published finding, leaving only the model's own prose for comparison.
 *
 * Only the EXISTING side of a `bodiesAreSimilar` comparison is ever composed. `publisher.ts`'s
 * `classifySuppression` builds `SimilarityCandidate.body` straight from `sanitized.body` — the
 * model's raw sanitized prose for the finding under consideration right now, never composed — while
 * `toExistingConversation` reads `comment.body` straight off a comment that `publishComposedFinding`
 * (`publisher.ts`) already posted through `composeFindingBody`: a `_<category>_ | _<severity>_`
 * label line, the finding's own prose, a collapsed `<details>` repair-prompt block, and a hidden
 * marker comment (see `presentation.ts`). Three of those four parts are fixed product vocabulary
 * stamped on every single finding this reviewer ever publishes, never model content — the label
 * words, "details"/"summary"/"prompt"/"agents", the entire fixed repair-prompt template ("verify",
 * "finding", "code", "fix", "cause", "resolve", "repository", "verification", ...), and the marker's
 * own hex. Left in, they inflate shared-token counts between a candidate and ANY existing finding
 * whenever the candidate's own prose happens to use one of those ordinary words — tightening this
 * stage's false-suppression risk in exactly the direction Keiko-for-Quality#38 exists to avoid. The
 * candidate side is never composed, so it is never passed through this function.
 *
 * Each piece stripped below mirrors one literal piece of `composeFindingBody`'s own construction —
 * see that function. This is deliberately tight rather than a generic HTML strip:
 * `similarity.test.ts` builds its stripping fixture by calling the real
 * `composeFindingBody`/`markerComment`, not a hand-rolled copy of their shape, so a future change to
 * that composition breaks a test here instead of silently letting composition noise back into the
 * score.
 */
function stripComposedArtifacts(body: string): string {
  return clip(body)
    .replace(/^_[^_\n]*_ \| _[^_\n]*_[ \t]*\n?/, "") // the leading category/severity label line
    .replace(/<details>[\s\S]*?<\/details>/g, " ") // the collapsed repair-prompt block
    .replace(/<!--[\s\S]*?-->/g, " "); // the hidden marker comment
}

/**
 * The token/snippet similarity core: an identical (long-enough) shared code quote, or enough shared
 * content vocabulary — see `MIN_SHARED_SNIPPET_CHARS`, `MIN_SHARED_TOKENS`, `SIMILARITY_THRESHOLD`.
 *
 * Shared, unmodified, by both `bodiesAreSimilar` (cross-run, asymmetric) and `areIntraRunDuplicates`
 * (intra-run, symmetric) below — each decides what stripping, if any, happens to either side BEFORE
 * calling this, so the threshold and floor constants themselves are never duplicated between stages.
 */
function similarByContent(a: string, b: string): boolean {
  if (shareCodeBlock(a, b)) return true;
  const { score, shared } = tokenOverlap(tokenize(a), tokenize(b));
  return shared >= MIN_SHARED_TOKENS && score >= SIMILARITY_THRESHOLD;
}

/**
 * Conservative similarity gate: an identical code quote, or enough shared content vocabulary.
 *
 * Deliberately asymmetric: `existingBody` is always a fully composed, previously published document
 * — see `stripComposedArtifacts`, applied to it alone — while `candidateBody` is always the model's
 * raw sanitized prose for the finding under consideration right now.
 */
function bodiesAreSimilar(candidateBody: string, existingBody: string): boolean {
  return similarByContent(candidateBody, stripComposedArtifacts(existingBody));
}

/**
 * True when a range is anchored nowhere: either endpoint at or below line 0.
 *
 * GitHub line numbers are always >= 1, so this is the only shape a "no real anchor" range can take
 * once it has reached this function as two numbers rather than `undefined` — the engine reports
 * `(0, 0)` for a finding it could not place on a line at all, and `SimilarityCandidate.startLine`/
 * `endLine` are non-optional, so that sentinel arrives here as `(0, 0)` rather than as the
 * `undefined` the existing side uses for the same situation (guarded separately, above this
 * function's call site in `linesOverlap`).
 */
function hasNoAnchor(startLine: number, endLine: number): boolean {
  return startLine <= 0 || endLine <= 0;
}

/**
 * The minimal shape `linesOverlap`'s second argument needs. Both `ExistingConversation` (the
 * cross-run caller) and `CandidateForDedup` (the intra-run caller, below) satisfy it structurally —
 * the latter's `startLine`/`endLine` are non-optional numbers, which is itself a valid `number |
 * undefined`, so no adapter object is needed to share this function between the two stages.
 */
interface LineAnchored {
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
}

/**
 * Interval overlap with a symmetric tolerance band; a conversation with no line anchor never
 * matches.
 *
 * A nonpositive range on either side is checked before the tolerance arithmetic runs, and short-
 * circuits to "no overlap" regardless of the other side — not folded into that arithmetic — because
 * `LINE_TOLERANCE` would otherwise let a `(0, 0)` "anchored nowhere" candidate satisfy
 * `0 <= existing.endLine + 2` for any thread anchored at line 1 or 2: a match by coincidence of the
 * sentinel value, not by any real proximity. A finding with no anchor cannot be "at the same place"
 * as anything, existing or candidate.
 */
function linesOverlap(candidate: SimilarityCandidate, existing: LineAnchored): boolean {
  if (existing.startLine === undefined || existing.endLine === undefined) return false;
  if (hasNoAnchor(candidate.startLine, candidate.endLine)) return false;
  if (hasNoAnchor(existing.startLine, existing.endLine)) return false;
  return (
    candidate.startLine <= existing.endLine + LINE_TOLERANCE &&
    existing.startLine <= candidate.endLine + LINE_TOLERANCE
  );
}

/**
 * The location-and-substance match every dedup stage below shares: same author, same path, an
 * overlapping anchor, and a conservatively similar body. Eligibility — *which* threads this check
 * may even run against — is each caller's own question, kept deliberately separate: "is this the
 * same finding at the same spot" and "is this the kind of thread that should suppress" evolve for
 * different reasons (Keiko-for-Quality#38's open-thread contract versus #64's disposition contract).
 */
function isSameFindingAtSameLocation(
  candidate: SimilarityCandidate,
  thread: ExistingConversation,
  identity: string,
): boolean {
  return (
    thread.authorLogin === identity &&
    thread.path === candidate.path &&
    linesOverlap(candidate, thread) &&
    bodiesAreSimilar(candidate.body, thread.body)
  );
}

/**
 * True when `candidate` is a phrasing-independent duplicate of an open conversation this reviewer
 * already authored at the same location.
 */
export function findsSimilarOpenConversation(
  candidate: SimilarityCandidate,
  existing: readonly ExistingConversation[],
  identity: string,
): boolean {
  return existing.some(
    (thread) => !thread.resolved && isSameFindingAtSameLocation(candidate, thread, identity),
  );
}

/**
 * True when `candidate` is a same-location, same-substance match of a RESOLVED conversation this
 * reviewer authored whose last reply was a substantive disposition (Keiko-for-Quality#64) — the
 * caller's signal to suppress instead of republishing, which is what dampens the argue-with-the-bot
 * loop a long-lived pull request otherwise falls into.
 *
 * Deliberately separate from `findsSimilarOpenConversation` above, not a relaxation of it: that
 * function's own contract is that a resolved thread must never suppress on its own, because a
 * genuinely recurred defect has to stay publishable (Keiko-for-Quality#38) — bare resolution is not
 * a verdict. This function only ever returns `true` once `thread.dispositioned` is already `true`,
 * and that flag is `false` for a bare "resolved, no reply" thread by construction (see
 * `disposition.ts`), so the #38 guarantee is preserved: a thread resolved without a considered reply
 * can never reach this branch's `true` outcome, and its finding remains publishable exactly as
 * before.
 */
export function findsDispositionedConversation(
  candidate: SimilarityCandidate,
  existing: readonly ExistingConversation[],
  identity: string,
): boolean {
  return existing.some(
    (thread) =>
      thread.resolved &&
      thread.dispositioned &&
      isSameFindingAtSameLocation(candidate, thread, identity),
  );
}

/**
 * True when `a` and `b` are the same defect described twice within THIS run, at the same location —
 * the intra-run deduplication stage `publisher.ts`'s `planPublication` runs, between sanitization
 * and the cross-run checks, on every pair of this run's own sanitized candidates (v0.12.0). See the
 * module doc comment above for why this stage exists: every other function in this file only ever
 * compares a candidate against an ALREADY-PUBLISHED conversation, so a model that restates one
 * defect several times in a single pass had nothing here to catch it.
 *
 * Composed from the identical internals `isSameFindingAtSameLocation` uses above — the same path,
 * `linesOverlap` (including its nonpositive-anchor rule), and the token/snippet similarity core
 * (`similarByContent`) — so "duplicate" means the same thing here as everywhere else in this file.
 * The one deliberate difference: NEITHER side is ever composed. `a.body` and `b.body` are both this
 * run's own raw sanitized prose, straight from `sanitizeFindingBody` — unlike `bodiesAreSimilar`,
 * no `stripComposedArtifacts` call applies to either side, because neither candidate has been
 * published yet for there to be a composed document to strip.
 *
 * This is the same conservative similarity judgement as the rest of the file, applied intra-run:
 * every narrowing condition above still narrows, and an uncertain comparison returns `false` —
 * publish-bias, same as everywhere else here, because losing a real finding to over-eager
 * suppression is worse than publishing an occasional duplicate.
 */
export function areIntraRunDuplicates(a: CandidateForDedup, b: CandidateForDedup): boolean {
  return a.path === b.path && linesOverlap(a, b) && similarByContent(a.body, b.body);
}
