import { describe, expect, it } from "vitest";

import { markerComment } from "./marker.js";
import { composeFindingBody } from "./presentation.js";
import {
  areIntraRunDuplicates,
  findsDispositionedConversation,
  findsSimilarOpenConversation,
  type CandidateForDedup,
  type ExistingConversation,
  type SimilarityCandidate,
} from "./similarity.js";

const IDENTITY = "keiko-for-quality[bot]";
const PATH = "src/connectors/codingContextRoutes.ts";

function candidate(overrides: Partial<SimilarityCandidate> = {}): SimilarityCandidate {
  return {
    path: PATH,
    startLine: 236,
    endLine: 236,
    body: "Restore the route's fallback connector construction when the primary endpoint is unset.",
    ...overrides,
  };
}

function thread(overrides: Partial<ExistingConversation> = {}): ExistingConversation {
  return {
    path: PATH,
    authorLogin: IDENTITY,
    resolved: false,
    dispositioned: false,
    body: "Restore the route's fallback connector construction when the primary endpoint is unset.",
    startLine: 236,
    endLine: 236,
    ...overrides,
  };
}

describe("findsSimilarOpenConversation", () => {
  it("returns false for an empty existing-thread list", () => {
    expect(findsSimilarOpenConversation(candidate(), [], IDENTITY)).toBe(false);
  });

  it("suppresses a real paraphrase of the same defect at the same location", () => {
    // The three real production paraphrases from Keiko-for-Quality#38 (oscharko-dev/Keiko#2926),
    // truncated in the issue but reconstructed here in full for a self-contained fixture.
    const paraphrases = [
      "Restore the route's fallback connector construction when the primary endpoint is unset.",
      "Restore the route's default connector construction when the primary endpoint is missing.",
      "Keep the fallback port construction for route requests when no primary endpoint exists.",
    ];
    for (const first of paraphrases) {
      for (const second of paraphrases) {
        const found = findsSimilarOpenConversation(
          candidate({ body: second }),
          [thread({ body: first })],
          IDENTITY,
        );
        expect(found).toBe(true);
      }
    }
  });

  it("does not suppress a genuinely different defect at the identical line", () => {
    const found = findsSimilarOpenConversation(
      candidate({
        body: "This handler never validates that the uploaded file size is below the configured limit.",
      }),
      [thread({ body: "Restore the route's fallback connector construction." })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress a genuinely different defect on an adjacent line", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 237, endLine: 237, body: "The retry loop never resets its counter." }),
      [thread({ body: "The response body is never closed on the error branch." })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("suppresses when the anchor drifted by up to the line tolerance", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 238, endLine: 238 }),
      [thread({ startLine: 236, endLine: 236 })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });

  it("does not suppress once the drift exceeds the line tolerance", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 239, endLine: 239 }),
      [thread({ startLine: 236, endLine: 236 })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress a similar body on a different file", () => {
    const found = findsSimilarOpenConversation(
      candidate({ path: "src/other.ts" }),
      [thread({ path: PATH })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress a conversation authored by someone else", () => {
    const found = findsSimilarOpenConversation(
      candidate(),
      [thread({ authorLogin: "contributor" })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress once the conversation is resolved", () => {
    const found = findsSimilarOpenConversation(candidate(), [thread({ resolved: true })], IDENTITY);
    expect(found).toBe(false);
  });

  it("does not suppress against a conversation with no usable line anchor", () => {
    const found = findsSimilarOpenConversation(
      candidate(),
      [thread({ startLine: undefined, endLine: undefined })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("suppresses on an identical quoted code snippet even when the prose framing is unrelated", () => {
    const snippet = "```ts\nconst port = fallback ?? DEFAULT_PORT;\n```";
    const found = findsSimilarOpenConversation(
      candidate({ body: `Something entirely different is wrong here.\n\n${snippet}` }),
      [thread({ body: `A completely unrelated sentence follows.\n\n${snippet}` })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });

  it("ignores incidental whitespace differences inside a quoted code snippet", () => {
    const found = findsSimilarOpenConversation(
      candidate({ body: "See below.\n\n```ts\nconst  port = fallback ?? DEFAULT_PORT;\n```" }),
      [thread({ body: "See below.\n\n```ts\nconst port =\nfallback ?? DEFAULT_PORT;\n```" })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });

  it("does not let a short, generic body false-trigger on stopwords alone", () => {
    const found = findsSimilarOpenConversation(
      candidate({ body: "This is not correct for this case here." }),
      [thread({ body: "This is not correct for that case there." })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("survives a very long, hostile body without throwing or hanging", () => {
    const hostile = `${"A".repeat(200_000)} 建設 construction fallback connector`;
    expect(() =>
      findsSimilarOpenConversation(
        candidate({ body: hostile }),
        [thread({ body: hostile })],
        IDENTITY,
      ),
    ).not.toThrow();
  });

  it("survives unicode and markdown-heavy content without throwing", () => {
    // The fenced block is two statements, not one, so it still clears MIN_SHARED_SNIPPET_CHARS
    // (24, see similarity.ts) after whitespace collapse — a single `const x = 1;` line would not.
    const unicode =
      "# Überschrift 🔥\n\n- 一つ目の欠陥\n- **重要**: `restore` 함수가 실패합니다\n\n> quoted text\n\n```js\nconst x = 1;\nconst y = 2;\n```";
    expect(() =>
      findsSimilarOpenConversation(
        candidate({ body: unicode }),
        [thread({ body: unicode })],
        IDENTITY,
      ),
    ).not.toThrow();
    // Two identical hostile bodies at the same location are the same finding by any reasonable
    // reading, and the shared-code-block path alone is enough to catch this pair.
    expect(
      findsSimilarOpenConversation(
        candidate({ body: unicode }),
        [thread({ body: unicode })],
        IDENTITY,
      ),
    ).toBe(true);
  });

  it("does not falsely suppress two different non-Latin bodies with no shared code", () => {
    const found = findsSimilarOpenConversation(
      candidate({ body: "これは最初の欠陥に関する説明です。" }),
      [thread({ body: "これは二番目の全く異なる欠陥に関する説明です。" })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });
});

/**
 * The existing side of a comparison is never raw: `publisher.ts`'s `toExistingConversation` reads
 * `comment.body` straight off a comment `publishComposedFinding` already posted through
 * `composeFindingBody` (`presentation.ts`) — a label line, the finding's own prose, a collapsed
 * `<details>` repair-prompt block, and a hidden marker comment. `composedExisting` below is built
 * with the REAL `composeFindingBody`/`markerComment`, not a hand-rolled copy of their shape, so a
 * future change to that composition breaks a test here instead of silently letting composition
 * noise back into the similarity score (see `stripComposedArtifacts` in similarity.ts).
 */
describe("existing-side composition stripping", () => {
  const existingProse =
    "Restore the retry loop's backoff counter after a transient network failure.";
  const composedExisting = composeFindingBody(
    existingProse,
    markerComment("deadbeefdeadbeefdeadbeefdeadbeef"),
    { path: PATH, line: 42, severity: "medium", category: "maintainability" },
  );

  it("is not similar to a candidate that only shares composition-wrapper vocabulary", () => {
    // Every content word here — "maintainability", "minor", "prompt", "agents", "details",
    // "summary", "quality" — comes from the label line or the <details> wrapper composeFindingBody
    // stamps on every finding, never from `existingProse` above. Unstripped, this candidate shares
    // 7 of those wrapper words with the composed existing body at a ~0.54 overlap score — enough to
    // clear both SIMILARITY_THRESHOLD and MIN_SHARED_TOKENS on wrapper noise alone, which is exactly
    // the false-suppression risk stripComposedArtifacts exists to close.
    const candidateBody =
      "This is a minor maintainability nit about the prompt agents receive, and about the details " +
      "and summary layout here — it hurts overall quality.";
    const found = findsSimilarOpenConversation(
      candidate({ body: candidateBody }),
      [thread({ body: composedExisting })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("is still similar to a candidate that shares the underlying finding's own vocabulary", () => {
    const candidateBody =
      "Fix the retry loop's backoff counter so it resets after a transient network failure.";
    const found = findsSimilarOpenConversation(
      candidate({ body: candidateBody }),
      [thread({ body: composedExisting })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });
});

describe("zero-line anchors", () => {
  it("does not match a (0, 0) candidate against a thread anchored at line 1", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 0, endLine: 0 }),
      [thread({ startLine: 1, endLine: 1 })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not match a (0, 0) candidate against a (0, 0) thread", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 0, endLine: 0 }),
      [thread({ startLine: 0, endLine: 0 })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("still suppresses a genuine range within the line tolerance, unchanged", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 238, endLine: 238 }),
      [thread({ startLine: 236, endLine: 236 })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });
});

describe("shared code-block length floor", () => {
  it("no longer suppresses on a 10-char shared snippet with no prose overlap", () => {
    const snippet = "```\nab\n```"; // 10 chars after the existing whitespace collapse
    const found = findsSimilarOpenConversation(
      candidate({ body: `Something entirely unrelated is going on here.\n\n${snippet}` }),
      [thread({ body: `A completely different sentence follows elsewhere.\n\n${snippet}` })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("still suppresses on a 30-char shared snippet alone, with no prose overlap", () => {
    const snippet = "```\nconst timeout = 50000;\n```"; // 30 chars after whitespace collapse
    const found = findsSimilarOpenConversation(
      candidate({ body: `Something entirely unrelated is going on here.\n\n${snippet}` }),
      [thread({ body: `A completely different sentence follows elsewhere.\n\n${snippet}` })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });
});

/**
 * Keiko-for-Quality#64: `findsSimilarOpenConversation` above deliberately never suppresses on a
 * resolved thread, so a genuinely recurred defect stays publishable. This is the narrower,
 * deliberately separate case: a resolved thread this reviewer authored whose last reply was a
 * substantive disposition (`thread.dispositioned`) should suppress a matching recurrence, to stop
 * the argue-with-the-bot loop a long-lived pull request otherwise falls into.
 */
describe("findsDispositionedConversation", () => {
  it("returns false for an empty existing-thread list", () => {
    expect(findsDispositionedConversation(candidate(), [], IDENTITY)).toBe(false);
  });

  it("suppresses a matching finding at a resolved, dispositioned location", () => {
    const found = findsDispositionedConversation(
      candidate(),
      [thread({ resolved: true, dispositioned: true })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });

  it("suppresses a paraphrase of the same defect at a dispositioned location, not just an exact repeat", () => {
    const found = findsDispositionedConversation(
      candidate({
        body: "Restore the route's default connector construction when the primary endpoint is missing.",
      }),
      [thread({ resolved: true, dispositioned: true })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });

  // The exact case Keiko-for-Quality#38 protects and #64 must not regress: a resolved thread with
  // no substantive reply (`dispositioned: false`, the fixture default) never suppresses, so a
  // genuinely recurred defect stays publishable.
  it("does not suppress a resolved thread that was never dispositioned", () => {
    const found = findsDispositionedConversation(
      candidate(),
      [thread({ resolved: true, dispositioned: false })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress an open (unresolved) thread even if it were somehow flagged dispositioned", () => {
    const found = findsDispositionedConversation(
      candidate(),
      [thread({ resolved: false, dispositioned: true })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress a genuinely different defect at the same dispositioned location", () => {
    const found = findsDispositionedConversation(
      candidate({
        body: "This handler never validates that the uploaded file size is below the configured limit.",
      }),
      [thread({ resolved: true, dispositioned: true, body: "Restore the fallback connector." })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress a dispositioned conversation authored by someone else", () => {
    const found = findsDispositionedConversation(
      candidate(),
      [thread({ resolved: true, dispositioned: true, authorLogin: "contributor" })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress once the drift exceeds the line tolerance, even at a dispositioned location", () => {
    const found = findsDispositionedConversation(
      candidate({ startLine: 239, endLine: 239 }),
      [thread({ resolved: true, dispositioned: true, startLine: 236, endLine: 236 })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });
});

/**
 * The intra-run deduplication stage (v0.12.0): `publisher.ts`'s `planPublication` runs this, between
 * sanitization and the cross-run checks above, over pairs of THIS run's own sanitized candidates —
 * see the module doc comment. Both sides here are always raw sanitized prose, so — unlike every test
 * above — neither `candidate()` nor `thread()` (which builds an `ExistingConversation`, a shape this
 * function never takes) is reused; a local, minimal `CandidateForDedup` helper stands in for both
 * sides of the comparison instead.
 */
describe("areIntraRunDuplicates", () => {
  function intraCandidate(overrides: Partial<CandidateForDedup> = {}): CandidateForDedup {
    return {
      path: PATH,
      startLine: 236,
      endLine: 236,
      body: "Restore the route's fallback connector construction when the primary endpoint is unset.",
      ...overrides,
    };
  }

  it("is a duplicate: same path, overlapping lines, shared vocabulary", () => {
    // The same paraphrase pair `findsSimilarOpenConversation`'s own suite pins as similar, above —
    // reused here to show the intra-run stage reaches the identical verdict on two RAW bodies.
    const a = intraCandidate();
    const b = intraCandidate({
      body: "Restore the route's default connector construction when the primary endpoint is missing.",
    });
    expect(areIntraRunDuplicates(a, b)).toBe(true);
    // Symmetric, unlike the cross-run stage's deliberately asymmetric `bodiesAreSimilar`: neither
    // side is ever composed here, so there is no "existing" side to strip.
    expect(areIntraRunDuplicates(b, a)).toBe(true);
  });

  it("is not a duplicate on a different path, even with identical bodies and identical lines", () => {
    const a = intraCandidate();
    const b = intraCandidate({ path: "src/other.ts" });
    expect(areIntraRunDuplicates(a, b)).toBe(false);
  });

  it("is not a duplicate for genuinely different defect vocabulary at overlapping lines — publish-bias pinned", () => {
    const a = intraCandidate();
    const b = intraCandidate({
      body: "This handler never validates that the uploaded file size is below the configured limit.",
    });
    expect(areIntraRunDuplicates(a, b)).toBe(false);
  });

  it("is never a duplicate when either side carries a nonpositive anchor", () => {
    const anchored = intraCandidate();
    const zeroAnchor = intraCandidate({ startLine: 0, endLine: 0 });
    expect(areIntraRunDuplicates(anchored, zeroAnchor)).toBe(false);
    expect(areIntraRunDuplicates(zeroAnchor, anchored)).toBe(false);
    // Two (0, 0) "anchored nowhere" candidates must not match each other by coincidence of the
    // sentinel value either — the same case `linesOverlap`'s own zero-line-anchor tests pin above.
    expect(areIntraRunDuplicates(zeroAnchor, intraCandidate({ startLine: 0, endLine: 0 }))).toBe(
      false,
    );
  });

  it("still suppresses within the line tolerance, unchanged", () => {
    const a = intraCandidate({ startLine: 238, endLine: 238 });
    const b = intraCandidate({ startLine: 236, endLine: 236 });
    expect(areIntraRunDuplicates(a, b)).toBe(true);
  });

  it("inherits the snippet-floor semantics: a shared >=24-char snippet alone is enough, no prose overlap required", () => {
    const snippet = "```\nconst timeout = 50000;\n```"; // 30 chars after whitespace collapse
    const a = intraCandidate({
      body: `Something entirely unrelated is going on here.\n\n${snippet}`,
    });
    const b = intraCandidate({
      body: `A completely different sentence follows elsewhere.\n\n${snippet}`,
    });
    expect(areIntraRunDuplicates(a, b)).toBe(true);
  });

  it("does not suppress on a shared snippet below the floor, with no prose overlap", () => {
    const snippet = "```\nab\n```"; // 10 chars after whitespace collapse — below MIN_SHARED_SNIPPET_CHARS
    const a = intraCandidate({
      body: `Something entirely unrelated is going on here.\n\n${snippet}`,
    });
    const b = intraCandidate({
      body: `A completely different sentence follows elsewhere.\n\n${snippet}`,
    });
    expect(areIntraRunDuplicates(a, b)).toBe(false);
  });

  /**
   * Contrasts against "existing-side composition stripping" above on the IDENTICAL fixture, rather
   * than asserting `areIntraRunDuplicates` in isolation, because two identical bodies would match
   * whether or not stripping happened — that alone cannot show which behaviour occurred. Feeding the
   * same two bodies to both functions can: `findsSimilarOpenConversation` strips `composedExisting`
   * and finds no real overlap (proven above — the shared words are only the composed wrapper's own
   * fixed vocabulary); `areIntraRunDuplicates` strips neither side, so that same wrapper vocabulary is
   * what it sees, and it matches. Same inputs, opposite verdicts — proof the two stages disagree
   * about stripping on purpose.
   */
  it("strips neither side, unlike bodiesAreSimilar's existing side — shared wrapper-only vocabulary matches here", () => {
    const existingProse =
      "Restore the retry loop's backoff counter after a transient network failure.";
    const composedExisting = composeFindingBody(
      existingProse,
      markerComment("deadbeefdeadbeefdeadbeefdeadbeef"),
      { path: PATH, line: 42, severity: "medium", category: "maintainability" },
    );
    const wrapperOnlyBody =
      "This is a minor maintainability nit about the prompt agents receive, and about the details " +
      "and summary layout here — it hurts overall quality.";

    expect(
      findsSimilarOpenConversation(
        candidate({ body: wrapperOnlyBody }),
        [thread({ body: composedExisting })],
        IDENTITY,
      ),
    ).toBe(false);
    expect(
      areIntraRunDuplicates(
        intraCandidate({ body: wrapperOnlyBody }),
        intraCandidate({ body: composedExisting }),
      ),
    ).toBe(true);
  });
});
