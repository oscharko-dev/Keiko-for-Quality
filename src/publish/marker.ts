import { createHash } from "node:crypto";

/**
 * The hidden identifier that lets a later run recognise a finding it already published.
 *
 * The fingerprint deliberately excludes line numbers. A finding that is still unrepaired after
 * unrelated edits shifted it down the file is the *same* finding, and reposting it would punish a
 * contributor for touching a neighbouring line. It is derived instead from the content of the
 * finding itself, which changes only when the reviewer has something new to say.
 */
export interface MarkerInput {
  readonly repository: string;
  readonly pullNumber: number;
  readonly path: string;
  readonly rule: string;
  readonly body: string;
  /**
   * Included in the hashed material only when supplied.
   *
   * A finding omits it deliberately — see the class doc above. The incomplete-review notice
   * supplies it, because a notice's whole meaning is "this exact head was not covered"; without it,
   * a notice about a since-superseded head could suppress the notice a fresh run for the current
   * head needs to publish.
   */
  readonly head?: string;
}

export const MARKER_PREFIX = "keiko-for-quality";
const MARKER_PATTERN = new RegExp(`<!--\\s*${MARKER_PREFIX}:v1:([0-9a-f]{32})\\s*-->`);

/**
 * Joins fingerprint fields before hashing.
 *
 * A NUL cannot appear in `repository` (GitHub's own naming rules), `pullNumber` (a number), or
 * `rule` (a closed enum or a validated token) — see `computeKey` in `review-cache.ts` for the same
 * reasoning applied to the review-cache key. `path` and the normalized `body` are the two fields
 * that could otherwise collide across a delimiter: a path may legitimately contain a space, so
 * joining with one would let two differently-split field sets hash to the same material.
 */
const FIELD_SEPARATOR = "\0";

/**
 * Canonicalizes text before either deduplication stage's own additional processing runs.
 *
 * `normalizeForFingerprint` below and `similarity.ts`'s `tokenize` used to apply their own,
 * independently written Unicode handling, and diverged on exactly the inputs that matter most for
 * cross-run deduplication: the same finding, reproduced with a cosmetically different but
 * semantically identical encoding. `normalizeForFingerprint`'s old ASCII-only keep-set stripped an
 * NFC-composed accented letter as a single unit but kept an NFD-decomposed one's bare base letter, so
 * the *same* word normalized to two different skeletons depending on which form happened to arrive —
 * silently defeating the exact-marker stage's whole purpose (freeze-backlog item B6). Folding these
 * dimensions here, once, before either stage's own logic runs, means a fingerprint and a token set now
 * agree on what "the same text" looks like, even though they still deliberately disagree on
 * everything each stage does afterward (this function strips code fences; `tokenize` drops stopwords
 * and short words — neither of those merges into this primitive).
 *
 * Exported for `similarity.ts` to import: this module has no internal dependencies of its own and the
 * widest fan-in of any module in `publish/` (summary, publisher, and both dedup stages already sit on
 * top of it), which makes it the lower-level of the two — `similarity.ts` importing from here cannot
 * create a cycle, whereas the reverse direction would run against the same fact.
 *
 * - Unicode normalization form: NFC, so a precomposed character and its canonically decomposed
 *   equivalent (an accented letter as one codepoint versus base letter plus combining mark) collapse
 *   to one representation before anything downstream inspects individual codepoints. A residual
 *   combining mark NFC cannot compose away (attached to a character with no precomposed form) is left
 *   for each caller's own keep-set to classify — both already exclude it the same way (neither
 *   `\p{M}` nor an ASCII alphanumeric is kept), so no further handling is needed here.
 * - Zero-width characters (zero-width space/joiner/non-joiner, word joiner, BOM) are deleted rather
 *   than turned into a separator, so one silently inserted mid-word does not fragment it into two
 *   tokens.
 * - Curly quotes fold to their straight equivalents.
 * - Any Unicode space separator (`\p{Zs}`, which includes the non-breaking space) folds to a plain
 *   space.
 * - Case folds via `toLowerCase`.
 */
export function normalizeUnicodeText(input: string): string {
  return (
    input
      .normalize("NFC")
      // Zero-width space/non-joiner/joiner (U+200B-200D), word joiner (U+2060), BOM (U+FEFF). Written
      // as explicit \u escapes rather than the literal invisible characters on purpose: a normalizer
      // whose whole job is stripping characters a reviewer cannot see must not itself hide any in its
      // own source.
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      // Curly single quotes/apostrophes (U+2018 left, U+2019 right, U+201A low-9, U+201B high-reversed-9).
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Curly double quotes (U+201C left, U+201D right, U+201E low-9, U+201F high-reversed-9).
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/\p{Zs}/gu, " ")
      .toLowerCase()
  );
}

/**
 * Normalizes a body so cosmetic drift does not create a "new" finding.
 *
 * A model asked the same question twice will vary whitespace and capitalization while making the
 * same point. Without this, a re-run would stack near-duplicate conversations onto the same defect.
 */
function normalizeForFingerprint(body: string): string {
  return normalizeUnicodeText(body)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function fingerprint(input: MarkerInput): string {
  const material = [
    input.repository,
    String(input.pullNumber),
    input.path,
    input.rule,
    normalizeForFingerprint(input.body),
    ...(input.head !== undefined ? [input.head] : []),
  ].join(FIELD_SEPARATOR);
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** The single HTML construct this product emits, in one fixed documented form. */
export function renderMarker(value: string): string {
  return `<!-- ${MARKER_PREFIX}:v1:${value} -->`;
}

export function extractMarker(body: string): string | undefined {
  return MARKER_PATTERN.exec(body)?.[1];
}

/** The marker's inner form, for callers that compose the surrounding document themselves. */
export function markerComment(value: string): string {
  return `${MARKER_PREFIX}:v1:${value}`;
}

/**
 * The fixed marker identifying the one maintained run-summary comment on a pull request.
 *
 * Every other caller of `fingerprint` wants the opposite of what the summary needs: a finding's
 * marker changes when its content changes, so a genuinely new finding is not suppressed as a
 * repost, and an incomplete-review notice's marker also varies with `head`, so a notice about a
 * superseded commit never suppresses the notice a fresh run for the current head still needs to
 * publish (see both doc comments above). The summary is the opposite of both: the same *one*
 * comment must be found and updated on every run against the same pull request, however the counts
 * changed and regardless of which head this run reviewed — that is what makes the upsert an update
 * instead of an accumulating pile of comments.
 *
 * Passing constant `path`/`rule`/`body` values and no `head` collapses `fingerprint`'s hash to a
 * function of `repository`/`pullNumber` alone, which is exactly the desired shape. This reuses the
 * exact hash and marker-regex format every other marker in this product already uses instead of
 * inventing a second one.
 */
export function summaryMarker(repository: string, pullNumber: number): string {
  return fingerprint({
    repository,
    pullNumber,
    path: "__run-summary__",
    rule: "run-summary",
    body: "run-summary",
  });
}
