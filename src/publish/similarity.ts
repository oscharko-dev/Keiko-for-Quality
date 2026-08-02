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
 */

export interface ExistingConversation {
  readonly path: string;
  readonly authorLogin: string;
  /** True once the conversation is resolved or the diff hunk it anchored is now outdated. */
  readonly resolved: boolean;
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
    matches.map((block) => block.replace(/\s+/g, " ").trim()).filter((block) => block.length > 8),
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

/** Lowercased, code-fence-stripped, stopword-filtered content words. Unicode-aware for non-English review output. */
function tokenize(text: string): ReadonlySet<string> {
  const withoutCode = clip(text).replace(/```[\s\S]*?```/g, " ");
  const words = withoutCode
    .toLowerCase()
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

/** Conservative similarity gate: an identical code quote, or enough shared content vocabulary. */
function bodiesAreSimilar(a: string, b: string): boolean {
  if (shareCodeBlock(a, b)) return true;
  const { score, shared } = tokenOverlap(tokenize(a), tokenize(b));
  return shared >= MIN_SHARED_TOKENS && score >= SIMILARITY_THRESHOLD;
}

/** Interval overlap with a symmetric tolerance band; a conversation with no line anchor never matches. */
function linesOverlap(candidate: SimilarityCandidate, existing: ExistingConversation): boolean {
  if (existing.startLine === undefined || existing.endLine === undefined) return false;
  return (
    candidate.startLine <= existing.endLine + LINE_TOLERANCE &&
    existing.startLine <= candidate.endLine + LINE_TOLERANCE
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
    (thread) =>
      thread.authorLogin === identity &&
      !thread.resolved &&
      thread.path === candidate.path &&
      linesOverlap(candidate, thread) &&
      bodiesAreSimilar(candidate.body, thread.body),
  );
}
