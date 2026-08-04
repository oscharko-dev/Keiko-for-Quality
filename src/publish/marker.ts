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
 * Normalizes a body so cosmetic drift does not create a "new" finding.
 *
 * A model asked the same question twice will vary whitespace and capitalization while making the
 * same point. Without this, a re-run would stack near-duplicate conversations onto the same defect.
 */
function normalizeForFingerprint(body: string): string {
  return body
    .toLowerCase()
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
