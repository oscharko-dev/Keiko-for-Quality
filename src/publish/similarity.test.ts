import { describe, expect, it } from "vitest";

import { markerComment } from "./marker.js";
import { composeFindingBody } from "./presentation.js";
import {
  areIntraRunDuplicates,
  findsDispositionedConversation,
  findsOutdatedRecurrence,
  findsSimilarOpenConversation,
  type CandidateForDedup,
  type ExistingConversation,
  type SimilarityCandidate,
} from "./similarity.js";

const IDENTITY = "keiko-for-quality[bot]";
const PATH = "src/connectors/codingContextRoutes.ts";

/**
 * The production-calibrated recurrence pair from oscharko-dev/Keiko#2981 — the real restatement
 * that sits at 10 shared content words and a 0.71 overlap, the measurement `RECURRENCE_THRESHOLD`
 * (similarity.ts) is pinned to. Module-scoped because two suites hold the coordinate-free bar
 * against it: `findsOutdatedRecurrence`'s own, and — since 2026-08-06 —
 * `findsDispositionedConversation`'s anchor-less clause.
 */
const ORIGINAL =
  "Do not lower the expected number of commit preview calls; this weakens a regression guard " +
  "and may hide unintended duplicate requests.";
const RESTATED =
  "Do not reduce the expected number of commit preview calls; this weakens the regression guard " +
  "and may let missing requests through.";
/**
 * A DIFFERENT defect written into the same sentence template as `ORIGINAL` — shares 6 content
 * words at exactly 0.50, so it clears the ORDINARY similarity thresholds and must still fail the
 * raised recurrence bar. The nearest-false-positive measurement in `RECURRENCE_THRESHOLD`'s own
 * doc comment, and the fixture that would fail first if a coordinate-free admission ever slipped
 * down to the anchored stages' thresholds.
 */
const SAME_TEMPLATE_DIFFERENT_DEFECT =
  "Do not lower the configured retry ceiling; this weakens a timeout guard and may hide " +
  "unintended socket exhaustion.";

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

  // Re-pinned 2026-08-08: three lines of drift with an identical body is now the wide band's
  // legitimate suppression (a critical was republished as a duplicate after a 79→91 force-push
  // shift on the first live day), so the boundary this test holds moved to the wide band's edge.
  it("does not suppress once the drift exceeds even the wide drift band", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 300, endLine: 300 }),
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

  // Re-pinned 2026-08-08 alongside the open-conversation twin above: the boundary moved to the
  // wide drift band's edge.
  it("does not suppress once the drift exceeds even the wide band, at a dispositioned location", () => {
    const found = findsDispositionedConversation(
      candidate({ startLine: 300, endLine: 300 }),
      [thread({ resolved: true, dispositioned: true, startLine: 236, endLine: 236 })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  /**
   * 2026-08-06: the same anchor-less blindness `findsOutdatedRecurrence`'s file-level suite pins,
   * on this stage's own eligibility — see that suite for the read-back mechanics. A file-level
   * thread resolved with a substantive disposition was invisible to `isSameFindingAtSameLocation`'s
   * anchor requirement, so a reworded recurrence re-litigated the settled question on every push.
   * The admission replaces the missing anchor with the RAISED coordinate-free bar, never the
   * ordinary thresholds this suite's anchored fixtures clear.
   */
  describe("anchor-less (file-level) dispositioned threads (2026-08-06)", () => {
    function dispositionedFileLevel(
      overrides: Partial<ExistingConversation> = {},
    ): ExistingConversation {
      return thread({
        body: ORIGINAL,
        resolved: true,
        dispositioned: true,
        startLine: undefined,
        endLine: undefined,
        ...overrides,
      });
    }

    it("suppresses a reworded recurrence of a dispositioned file-level finding", () => {
      const found = findsDispositionedConversation(
        candidate({ body: RESTATED }),
        [dispositionedFileLevel()],
        IDENTITY,
      );
      expect(found).toBe(true);
    });

    /**
     * The over-suppression guard: this body clears the ORDINARY similarity thresholds against
     * `ORIGINAL` (6 shared words at exactly 0.50 — an anchored dispositioned thread at the same
     * location would suppress it), so it proves the anchor-less clause holds the raised
     * coordinate-free bar rather than the bar the anchored match uses.
     */
    it("does not swallow a different defect that merely clears the ordinary thresholds", () => {
      const found = findsDispositionedConversation(
        candidate({ body: SAME_TEMPLATE_DIFFERENT_DEFECT }),
        [dispositionedFileLevel()],
        IDENTITY,
      );
      expect(found).toBe(false);
    });

    // Keiko-for-Quality#38, unchanged by the anchor-less clause: bare resolution is not a verdict,
    // with or without an anchor.
    it("does not suppress for a bare-resolved file-level thread that was never dispositioned", () => {
      const found = findsDispositionedConversation(
        candidate({ body: RESTATED }),
        [dispositionedFileLevel({ dispositioned: false })],
        IDENTITY,
      );
      expect(found).toBe(false);
    });

    it("does not suppress another author's dispositioned file-level thread", () => {
      const found = findsDispositionedConversation(
        candidate({ body: RESTATED }),
        [dispositionedFileLevel({ authorLogin: "contributor" })],
        IDENTITY,
      );
      expect(found).toBe(false);
    });
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

/**
 * Freeze-backlog item B6, this stage's own side: every pair `marker.test.ts`'s matching
 * "Unicode-adversarial pairs" suite pins for `fingerprint` must ALSO be a duplicate by this stage's
 * own, more permissive tokenizer — built from the identical bodies, so the two suites together prove
 * both dedup stages now agree on what "the same text" looks like. See that file's suite for which of
 * these five pairs provably diverged before `marker.ts`'s `normalizeUnicodeText` was extracted (NFC
 * vs NFD, and the zero-width joiner) versus which already agreed by coincidence (curly quotes,
 * non-breaking space, mixed case) — the same split applies here, since both functions now share the
 * identical upstream normalization.
 *
 * `areIntraRunDuplicates` is the right entry point rather than `findsSimilarOpenConversation`: both
 * sides raw and uncomposed, compared symmetrically — exactly what a cross-run repost of the same
 * finding looks like before either stage's own downstream logic (the fingerprint's alnum skeleton, or
 * this stage's stopword/length filter) runs.
 */
describe("areIntraRunDuplicates: Unicode-adversarial pairs agree (freeze-backlog B6)", () => {
  function pairCandidate(body: string): CandidateForDedup {
    return { path: PATH, startLine: 100, endLine: 100, body };
  }

  it("NFC vs NFD: the same accented letter, precomposed and canonically decomposed", () => {
    const nfc = "The café approach breaks under load during a retry.";
    const nfd = nfc.normalize("NFD");
    expect(nfc).not.toBe(nfd); // sanity: the pair is actually byte-different going in
    expect(areIntraRunDuplicates(pairCandidate(nfc), pairCandidate(nfd))).toBe(true);
  });

  it("curly vs straight quotes", () => {
    const straight = "The retry loop doesn't reset the counter after a timeout.";
    const curly = "The retry loop doesn’t reset the counter after a timeout.";
    expect(areIntraRunDuplicates(pairCandidate(straight), pairCandidate(curly))).toBe(true);
  });

  it("non-breaking space vs a normal space", () => {
    const normal = "Restore the fallback connector when the endpoint is unset.";
    const nbsp = normal.replace(/ /g, "\u00A0");
    expect(nbsp).not.toBe(normal); // sanity
    expect(areIntraRunDuplicates(pairCandidate(normal), pairCandidate(nbsp))).toBe(true);
  });

  it("a zero-width joiner silently inserted mid-word", () => {
    const clean = "Validate the token before granting access to the resource.";
    const withZwj = clean.replace("token", "to\u200Dken");
    expect(areIntraRunDuplicates(pairCandidate(clean), pairCandidate(withZwj))).toBe(true);
  });

  it("mixed case", () => {
    const upper = "NULL POINTER EXCEPTION in the retry handler during shutdown.";
    const lower = "null pointer exception in the retry handler during shutdown.";
    expect(areIntraRunDuplicates(pairCandidate(upper), pairCandidate(lower))).toBe(true);
  });

  it("still rejects genuinely different content after normalization — the fix does not collapse everything", () => {
    const a = pairCandidate("Restore the fallback connector when the endpoint is unset.");
    const b = pairCandidate("An unrelated defect about a locking bug entirely elsewhere.");
    expect(areIntraRunDuplicates(a, b)).toBe(false);
  });
});

/**
 * The stage that exists because the three above cannot see an outdated thread at all — see
 * `findsOutdatedRecurrence`. Every fixture here is drawn from the production repeats on
 * oscharko-dev/Keiko#2981, where one unfixed regression-guard objection became three separate
 * blocking conversations across three pushes.
 */
describe("findsOutdatedRecurrence", () => {
  function outdated(overrides: Partial<ExistingConversation> = {}): ExistingConversation {
    return thread({ body: ORIGINAL, outdatedOnly: true, resolved: true, ...overrides });
  }

  it("returns false for an empty existing-thread list", () => {
    expect(findsOutdatedRecurrence(candidate({ body: RESTATED }), [], IDENTITY)).toBe(false);
  });

  it("suppresses the same objection re-filed after a push moved the hunk", () => {
    expect(findsOutdatedRecurrence(candidate({ body: RESTATED }), [outdated()], IDENTITY)).toBe(
      true,
    );
  });

  /**
   * The point of the stage: it decides without a coordinate, so a candidate whose line has drifted
   * far past `LINE_TOLERANCE` — or lost its anchor entirely — is still recognised. Every other
   * stage in this file returns false for both of these.
   */
  it.each([
    ["a line far from the original anchor", { startLine: 902, endLine: 902 }],
    ["no usable anchor at all", { startLine: 0, endLine: 0 }],
    ["a stale anchor on the existing side", { startLine: 236, endLine: 236 }],
  ])("matches regardless of %s", (_label, anchor) => {
    const found = findsOutdatedRecurrence(
      candidate({ body: RESTATED, ...anchor }),
      [outdated({ startLine: undefined, endLine: undefined })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });

  it("ignores a thread that is not outdated — the anchored stages own that case", () => {
    const found = findsOutdatedRecurrence(
      candidate({ body: RESTATED }),
      [outdated({ outdatedOnly: false })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("ignores a thread with no outdated fact recorded at all", () => {
    // `outdatedOnly` absent, not false: a caller that predates the field must not gain suppression
    // it never asked for.
    const bare = thread({ body: ORIGINAL, resolved: true });
    expect(findsOutdatedRecurrence(candidate({ body: RESTATED }), [bare], IDENTITY)).toBe(false);
  });

  it("ignores a thread on a different path", () => {
    const found = findsOutdatedRecurrence(
      candidate({ body: RESTATED }),
      [outdated({ path: "src/other.ts" })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("ignores a thread this reviewer did not author", () => {
    const found = findsOutdatedRecurrence(
      candidate({ body: RESTATED }),
      [outdated({ authorLogin: "contributor" })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  /**
   * The precision bar, exercised where it actually bites. Both bodies below would clear the
   * ORDINARY similarity threshold if a line anchor were narrowing alongside them; without one they
   * must not, which is the whole justification for `RECURRENCE_THRESHOLD` being higher.
   */
  it.each([
    [
      "a different defect that happens to share the sentence template",
      SAME_TEMPLATE_DIFFERENT_DEFECT,
    ],
    ["an unrelated defect in the same file", "The locking order here inverts under contention."],
  ])("does not suppress %s", (_label, body) => {
    expect(findsOutdatedRecurrence(candidate({ body }), [outdated()], IDENTITY)).toBe(false);
  });

  /**
   * A shared code quote is sufficient on its own for `similarByContent`, and deliberately is NOT
   * reachable here: a snippet identifies a location, and location is exactly what this stage has
   * agreed not to trust.
   */
  it("does not suppress on a shared code block alone", () => {
    const snippet = "```\nexpect(commitPreviews).toHaveLength(1);\n```";
    const found = findsOutdatedRecurrence(
      candidate({ body: `Something entirely different. ${snippet}` }),
      [outdated({ body: `A quite separate objection about naming. ${snippet}` })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  /**
   * The 2026-08-06 addition: threads that NEVER had a line anchor. A finding published as a
   * FILE-level comment (a deleted file, a path outside the diff, a `(0, 0)` engine anchor, a line
   * rung the API 422-rejected — see `placement.ts`) reads back with `line`/`start_line` null and,
   * unlike an outdated thread, no `original_*` fallback either, so both bounds are `undefined` and
   * every anchored stage refuses the thread. GitHub can also never mark it outdated — there is no
   * hunk to go stale — so `outdatedOnly` never admits it here either. Before this clause, only the
   * exact marker could suppress a repeat, and any rewording republished the finding as a brand-new
   * conversation on every push.
   */
  describe("anchor-less (file-level) threads (2026-08-06)", () => {
    function fileLevel(overrides: Partial<ExistingConversation> = {}): ExistingConversation {
      return thread({ body: ORIGINAL, startLine: undefined, endLine: undefined, ...overrides });
    }

    it("suppresses a reworded repeat of an own open file-level finding on the same path", () => {
      const found = findsOutdatedRecurrence(candidate({ body: RESTATED }), [fileLevel()], IDENTITY);
      expect(found).toBe(true);
    });

    it("matches a (0, 0)-anchored candidate too — the gate-finding shape that lands file-level", () => {
      const found = findsOutdatedRecurrence(
        candidate({ body: RESTATED, startLine: 0, endLine: 0 }),
        [fileLevel()],
        IDENTITY,
      );
      expect(found).toBe(true);
    });

    /**
     * The over-suppression guard, exercised where it bites: without an anchor the body carries the
     * whole decision, so the FULL recurrence bar applies — never path-match alone, and never the
     * ordinary thresholds (the first fixture clears those). A genuinely new finding on the same
     * path must stay publishable.
     */
    it.each([
      [
        "a different defect that happens to share the sentence template",
        SAME_TEMPLATE_DIFFERENT_DEFECT,
      ],
      ["an unrelated defect on the same path", "The locking order here inverts under contention."],
    ])("does not swallow %s", (_label, body) => {
      expect(findsOutdatedRecurrence(candidate({ body }), [fileLevel()], IDENTITY)).toBe(false);
    });

    /**
     * The additive-only guard: a line-anchored thread still requires `outdatedOnly`, exactly as
     * before. An open, anchored, non-outdated thread is the anchored stages' case
     * (`findsSimilarOpenConversation`), and this stage must not reach around their line-tolerance
     * precision by matching it on body alone.
     */
    it("still ignores an open, line-anchored, non-outdated thread with a matching body", () => {
      const anchored = thread({ body: ORIGINAL });
      expect(findsOutdatedRecurrence(candidate({ body: RESTATED }), [anchored], IDENTITY)).toBe(
        false,
      );
    });

    it("does not suppress against another author's file-level thread", () => {
      const found = findsOutdatedRecurrence(
        candidate({ body: RESTATED }),
        [fileLevel({ authorLogin: "contributor" })],
        IDENTITY,
      );
      expect(found).toBe(false);
    });

    /**
     * Keiko-for-Quality#38, unchanged: someone resolved this thread, so a defect that comes back
     * must be able to speak again. The `!resolved` guard on the anchor-less clause is what keeps
     * bare resolution from becoming a verdict; the substantively answered ones are
     * `findsDispositionedConversation`'s case, below.
     */
    it("does not suppress against a RESOLVED file-level thread", () => {
      const found = findsOutdatedRecurrence(
        candidate({ body: RESTATED }),
        [fileLevel({ resolved: true })],
        IDENTITY,
      );
      expect(found).toBe(false);
    });
  });
});

describe("wide-drift suppression (2026-08-08 live audit)", () => {
  const CANDIDATE = {
    path: "packages/keiko-server/src/coding-runtime/packagedSecureWorkspaceTextRead.ts",
    startLine: 91,
    endLine: 91,
    body: "Enforce signature verification independently of platformAssurance.\n\nWhen the lane value comes from the activation file, verification can be disabled.",
  };
  const thread = (
    overrides: Partial<{ startLine: number; endLine: number; body: string }>,
  ): ExistingConversation => ({
    authorLogin: "keiko-for-quality[bot]",
    path: CANDIDATE.path,
    startLine: 79,
    endLine: 79,
    resolved: false,
    dispositioned: false,
    body: CANDIDATE.body,
    ...overrides,
  });

  it("suppresses the same text republished after a twelve-line anchor drift", () => {
    expect(findsSimilarOpenConversation(CANDIDATE, [thread({})], "keiko-for-quality[bot]")).toBe(
      true,
    );
  });

  it("does not let the wide band suppress a merely similar body", () => {
    expect(
      findsSimilarOpenConversation(
        CANDIDATE,
        [
          thread({
            body: "Enforce signature verification independently of platformAssurance.\n\nA related but different observation about the update path.",
          }),
        ],
        "keiko-for-quality[bot]",
      ),
    ).toBe(false);
  });

  it("keeps the near band's similarity semantics unchanged", () => {
    expect(
      findsSimilarOpenConversation(
        { ...CANDIDATE, startLine: 80, endLine: 80 },
        [
          thread({
            body: "Enforce signature verification independently of platformAssurance.\n\nWhen the lane value comes from the activation file, verification can be disabled entirely.",
          }),
        ],
        "keiko-for-quality[bot]",
      ),
    ).toBe(true);
  });
});
