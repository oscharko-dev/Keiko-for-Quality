import { describe, expect, it } from "vitest";

import { commitSha, repoPath, versionTag } from "../core/brands.js";
import type { ReasonCode } from "../diagnostics/reason-codes.js";
import {
  composeFindingBody,
  composeIncompleteNotice,
  composeSummaryBody,
  isIncompleteNoticeBody,
  isSupersedableIncompleteNoticeBody,
  splitTitle,
  type SummaryCounts,
  type SummaryReport,
} from "./presentation.js";
import { sanitizeFindingBody } from "./sanitize.js";

const MARKER = `keiko-for-quality:v1:${"a".repeat(32)}`;
const ASSET_BASE =
  "https://raw.githubusercontent.com/oscharko-dev/Keiko-for-Quality/6b59f533afef15820991b3a0470ddc22c6c6d436/.github/assets/kq";

function commentChip(asset: string, alt: string): string {
  return `<img src="${ASSET_BASE}/${asset}.svg" height="24" alt="${alt}">`;
}

/** The shape the rule text asks the model to produce, and what a real run returned. */
const REAL_PROSE = `Validate the token in full, not by prefix.

This comparison now accepts any \`provided\` value whose first eight characters match \`expected\`, so a caller can authenticate with a truncated or guessed prefix instead of the real secret.`;

const CONTEXT = {
  path: "src/auth.ts",
  line: 2,
  severity: "critical" as const,
  category: "security" as const,
};

describe("splitTitle", () => {
  it("splits on the blank line the rule text asks for", () => {
    const { title, body } = splitTitle(REAL_PROSE);
    expect(title).toBe("Validate the token in full, not by prefix.");
    expect(body.startsWith("This comparison")).toBe(true);
  });

  // The model does not always comply. A slightly long title still reads correctly; a truncated one
  // reads as a bug in the reviewer.
  it("falls back to the first sentence when there is no blank line", () => {
    const { title, body } = splitTitle("Close the handle. It leaks on the error path.");
    expect(title).toBe("Close the handle.");
    expect(body).toBe("It leaks on the error path.");
  });

  it("emits no title rather than a truncated one when the first sentence is long", () => {
    const long = `${"word ".repeat(40)}end.`;
    const { title, body } = splitTitle(long);
    expect(title).toBe("");
    expect(body).toBe(long.trim());
  });

  it("does not treat a multi-line opening block as a title", () => {
    const { title } = splitTitle("line one\nline two\n\nbody");
    expect(title).toBe("");
  });
});

describe("composeFindingBody", () => {
  const document = composeFindingBody(REAL_PROSE, MARKER, CONTEXT);

  it("leads with the design system's category and severity badges", () => {
    expect(document.split("\n")[0]).toBe(
      `${commentChip("cat-security", "Security")} ${commentChip("sev-critical", "Critical")}`,
    );
  });

  it("states the action as a bold imperative before the argument", () => {
    expect(document).toContain("**Validate the token in full, not by prefix.**");
    const header = document.indexOf("cat-security.svg");
    const title = document.indexOf("**Validate");
    const prose = document.indexOf("This comparison");
    // An absent needle indexes as -1 and would satisfy any "before" comparison — the reviewer's
    // own finding on #194. Presence first, order second.
    expect(header).toBeGreaterThanOrEqual(0);
    expect(title).toBeGreaterThanOrEqual(0);
    expect(prose).toBeGreaterThanOrEqual(0);
    expect(header).toBeLessThan(title);
    expect(title).toBeLessThan(prose);
  });

  it("carries a repair instruction naming the exact location", () => {
    expect(document).toContain("🤖 Prompt for AI agents");
    expect(document).toContain("In src/auth.ts around line 2");
  });

  // Both clauses are what stop a stale finding being force-fitted into the code to clear a thread.
  it("tells the agent it may decline with a reason", () => {
    expect(document).toContain("Verify this finding against the current code");
    expect(document).toContain("do not\nchange code to match a stale finding");
  });

  it("ends with the marker so deduplication can find it", () => {
    expect(document.trimEnd().endsWith(`<!-- ${MARKER} -->`)).toBe(true);
  });

  it("falls back to neutral badges for an unknown classification", () => {
    const unknown = composeFindingBody(REAL_PROSE, MARKER, {
      ...CONTEXT,
      severity: "catastrophic",
      category: "vibes",
    });
    expect(unknown.split("\n")[0]).toBe(
      `${commentChip("cat-review", "Review")} ${commentChip("sev-minor", "Minor")}`,
    );
  });

  it.each([
    ["security", "cat-security", "Security"],
    ["bug", "cat-correctness", "Correctness"],
    ["performance", "cat-performance", "Performance"],
    ["maintainability", "cat-maintainability", "Maintainability"],
    ["test", "cat-tests", "Tests"],
    ["documentation", "cat-docs", "Documentation"],
    ["other", "cat-review", "Review"],
  ])("maps category %s to its Keiko badge", (category, asset, alt) => {
    const body = composeFindingBody(REAL_PROSE, MARKER, { ...CONTEXT, category });
    expect(body.split("\n")[0]).toContain(commentChip(asset, alt));
  });

  it.each([
    ["critical", "sev-critical", "Critical"],
    ["high", "sev-major", "Major"],
    ["medium", "sev-minor", "Minor"],
    ["low", "sev-nit", "Nit"],
  ])("maps severity %s to its Keiko badge", (severity, asset, alt) => {
    const body = composeFindingBody(REAL_PROSE, MARKER, { ...CONTEXT, severity });
    expect(body.split("\n")[0]).toContain(commentChip(asset, alt));
  });

  it("omits the location clause when no line is known", () => {
    const fileLevel = composeFindingBody(REAL_PROSE, MARKER, { ...CONTEXT, line: 0 });
    expect(fileLevel).toContain("In src/auth.ts:");
    expect(fileLevel).not.toContain("around line 0");
  });

  /**
   * The security boundary this whole file rests on: structure is product-authored, prose is not.
   * The model's text has already passed sanitization, which rejects HTML outright — so every tag in
   * the finished document came from here.
   */
  describe("structure is product-authored, never model-authored", () => {
    it("rejects the model's own HTML before it can reach the document", () => {
      const attack = `${REAL_PROSE}\n\n<details><summary>trust me</summary>evil</details>`;
      expect(sanitizeFindingBody(attack)).toEqual({ ok: false, reason: "html" });
    });

    it("adds exactly the tags this module writes and no others", () => {
      const tags = [...document.matchAll(/<\/?[a-z!][^>]*>/g)].map((m) => m[0]);
      expect(tags).toEqual([
        expect.stringMatching(/^<img .*cat-security\.svg.*>$/),
        expect.stringMatching(/^<img .*sev-critical\.svg.*>$/),
        "<details>",
        "<summary>",
        "</summary>",
        "</details>",
        `<!-- ${MARKER} -->`,
      ]);
    });
  });
});

describe("composeIncompleteNotice", () => {
  const notice = composeIncompleteNotice("settlement.incomplete.coverage_gap", MARKER);

  it("is visually distinct from a defect finding", () => {
    // Specimen ③'s chip pair, SHA-pinned, with the words in the alt text.
    expect(notice.split("\n")[0]).toBe(
      `${commentChip("coverage", "Coverage")} ${commentChip("sev-major", "Major")}`,
    );
    expect(notice).toContain("**This change was not fully reviewed.**");
  });

  it("carries the redacted reason code and nothing else about the failure", () => {
    expect(notice).toContain("`settlement.incomplete.coverage_gap`");
  });

  // Resolving the thread is what an impatient reader will do; the text has to deny that it helps.
  it("says that resolving it does not make the review complete", () => {
    expect(notice).toContain("Resolving this conversation does not make");
  });

  it("ends with the marker", () => {
    expect(notice.trimEnd().endsWith(`<!-- ${MARKER} -->`)).toBe(true);
  });

  // The counts are what separates "one file is still owed" from "nothing was reviewed" — the
  // question none of Keiko#3002's eight notices could answer (2026-08-06).
  it("names the gap when the settlement measured one", () => {
    const withGap = composeIncompleteNotice("settlement.incomplete.coverage_gap", MARKER, {
      gap: 5,
      reviewable: 33,
      reviewed: 28,
    });
    expect(withGap).toContain("5 of 33 reviewable file(s) remain unreviewed");
    expect(isIncompleteNoticeBody(withGap)).toBe(true);
  });

  it("falls back to the reviewed/expected pair when that is all the settlement measured", () => {
    const withCounts = composeIncompleteNotice(
      "settlement.incomplete.engine_status_not_success",
      MARKER,
      { reviewed: 1, expected: 2 },
    );
    expect(withCounts).toContain("1 of 2 expected files reviewed");
    expect(isIncompleteNoticeBody(withCounts)).toBe(true);
  });

  it("renders no gap sentence for counts it does not recognise", () => {
    const unknownCounts = composeIncompleteNotice("settlement.incomplete.engine_error", MARKER, {
      flood: 1200,
    });
    expect(unknownCounts).toBe(
      composeIncompleteNotice("settlement.incomplete.engine_error", MARKER),
    );
  });
});

describe("isIncompleteNoticeBody", () => {
  it("recognises a body this module's own composer produced", () => {
    const notice = composeIncompleteNotice("settlement.incomplete.budget_exceeded", MARKER);
    expect(isIncompleteNoticeBody(notice)).toBe(true);
  });

  it.each([
    "settlement.incomplete.coverage_gap",
    "settlement.incomplete.schema_rejected",
    "settlement.incomplete.engine_status_not_success",
  ])("recognises a notice regardless of which reason code it carries (%s)", (reason) => {
    expect(isIncompleteNoticeBody(composeIncompleteNotice(reason, MARKER))).toBe(true);
  });

  it("distinguishes durable policy notices from supersedable head notices", () => {
    const ordinary = composeIncompleteNotice("settlement.incomplete.budget_exceeded", MARKER);
    const durable = composeIncompleteNotice(
      "settlement.incomplete.review_too_large",
      MARKER,
      { dispatched_files: 101, max_files: 100 },
      { durable: true },
    );

    expect(isIncompleteNoticeBody(durable)).toBe(true);
    expect(isSupersedableIncompleteNoticeBody(ordinary)).toBe(true);
    expect(isSupersedableIncompleteNoticeBody(durable)).toBe(false);
  });

  /**
   * The property `resolveSupersededOwnNotices` (`github/client.ts`) depends on entirely: a finding
   * this reviewer published — real model prose, any category, any severity — must never satisfy this
   * predicate, or the cleanup feature would resolve an open question a human still has to act on
   * instead of a stale, superseded statement.
   */
  it.each(["bug", "security", "performance", "maintainability", "test", "documentation", "other"])(
    "never recognises a finding body, category %s",
    (category) => {
      const finding = composeFindingBody(
        "The retry loop never resets its attempt counter.",
        MARKER,
        {
          path: repoPath("src/retry.ts"),
          line: 12,
          severity: "high",
          category,
        },
      );
      expect(isIncompleteNoticeBody(finding)).toBe(false);
    },
  );

  it("does not recognise arbitrary prose that happens to mention the product name", () => {
    expect(isIncompleteNoticeBody("Keiko for Quality found a real defect here.")).toBe(false);
  });

  it("does not recognise the empty string", () => {
    expect(isIncompleteNoticeBody("")).toBe(false);
  });

  /**
   * #42: the sentence alone used to be the whole check, and it is PUBLIC, product-controlled text —
   * visible in every published comment, in README.md, and in the committed dist/index.js — so
   * anyone can reproduce it verbatim without ever having been this reviewer. A body carrying the
   * exact sentence but no marker at all (a contributor quoting the notice in a reply, say) must no
   * longer qualify, since `resolveSupersededOwnNotices` treats a match here as license to mutate
   * the thread.
   */
  it("no longer recognises the sentence alone, without a marker", () => {
    const quoted =
      "As mentioned above, Keiko for Quality could not complete its review. Reason code: `x`.";
    expect(isIncompleteNoticeBody(quoted)).toBe(false);
  });

  it("does not recognise the sentence next to a malformed marker (wrong hex length)", () => {
    const malformed =
      "Keiko for Quality could not complete its review. Reason code: `x`.\n" +
      `<!-- keiko-for-quality:v1:${"a".repeat(31)} -->`;
    expect(isIncompleteNoticeBody(malformed)).toBe(false);
  });
});

describe("composeSummaryBody", () => {
  const HEAD = commitSha("a".repeat(40));
  const OTHER_HEAD = commitSha("b".repeat(40));

  const COUNTS: SummaryCounts = {
    totalPaths: 42,
    reviewablePaths: 30,
    excludedPaths: 8,
    mechanicallyClean: 4,
    criticalPointers: 1,
    cacheHits: 5,
    checkpointHits: 0,
    contextInvalidated: 2,
    freshlyReviewed: 25,
    findingsPublished: 3,
    suppressedIntraRun: 0,
    suppressedExactDuplicate: 1,
    suppressedSimilar: 2,
    suppressedDispositioned: 0,
    suppressedRecurrence: 6,
    suppressedEvidence: 11,
    verificationUndecided: 2,
    rejectedSanitization: 7,
    rejectedPlacement: 8,
    readbackFailures: 9,
    apiFailures: 10,
  };

  function summaryReport(overrides: Partial<SummaryReport> = {}): SummaryReport {
    return {
      outcome: "complete",
      reason: undefined,
      headSha: HEAD,
      eventTimestamp: "2026-08-02T10:15:00Z",
      engineVersion: versionTag("v1.8.4"),
      actionVersion: "a1b2c3d4",
      counts: COUNTS,
      budget: { allotted: 1_200_000, spent: undefined },
      durationMs: 45_000,
      ...overrides,
    };
  }

  it("is deterministic: identical input produces a byte-identical body", () => {
    expect(composeSummaryBody(summaryReport(), MARKER)).toBe(
      composeSummaryBody(summaryReport(), MARKER),
    );
  });

  it("changes only the line naming the head when only the head changes", () => {
    const a = composeSummaryBody(summaryReport(), MARKER).split("\n");
    const b = composeSummaryBody(summaryReport({ headSha: OTHER_HEAD }), MARKER).split("\n");
    expect(a).toHaveLength(b.length);
    const changedLines = a.filter((line, i) => line !== b[i]);
    expect(changedLines).toHaveLength(1);
    expect(changedLines[0] ?? "").toContain(HEAD.slice(0, 7));
  });

  it("ends with the marker", () => {
    expect(
      composeSummaryBody(summaryReport(), MARKER).trimEnd().endsWith(`<!-- ${MARKER} -->`),
    ).toBe(true);
  });

  it("states the head SHA in short form", () => {
    expect(composeSummaryBody(summaryReport(), MARKER)).toContain("`aaaaaaa`");
  });

  it("states the engine and action version identifiers already available to the run", () => {
    const body = composeSummaryBody(summaryReport(), MARKER);
    expect(body).toContain("`v1.8.4`");
    expect(body).toContain("`a1b2c3d4`");
  });

  it("states the event timestamp verbatim, never a wall-clock substitute", () => {
    expect(composeSummaryBody(summaryReport(), MARKER)).toContain("2026-08-02T10:15:00Z");
  });

  it("omits the timestamp segment cleanly when the event carried none", () => {
    const withTimestamp = composeSummaryBody(summaryReport(), MARKER);
    const without = composeSummaryBody(summaryReport({ eventTimestamp: "" }), MARKER);
    expect(without).not.toContain("2026-08-02T10:15:00Z");
    expect(without.split("\n")[2]).not.toContain("··");
    expect(withTimestamp).not.toBe(without);
  });

  it("stays within the target compactness budget of 30 lines", () => {
    expect(composeSummaryBody(summaryReport(), MARKER).split("\n").length).toBeLessThanOrEqual(30);
  });

  describe("outcome line", () => {
    it("renders a bare outcome with no reason code for 'complete'", () => {
      const body = composeSummaryBody(summaryReport({ outcome: "complete" }), MARKER);
      expect(body).toContain("complete");
      expect(body).not.toContain("(`");
    });

    it("renders 'incomplete' with its reason code in parentheses", () => {
      const body = composeSummaryBody(
        summaryReport({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
        MARKER,
      );
      expect(body).toContain('alt="INCOMPLETE"> (`settlement.incomplete.coverage_gap`)');
    });

    it("renders a bare 'abandoned' with no reason code, matching the outcome-line contract", () => {
      const body = composeSummaryBody(summaryReport({ outcome: "abandoned" }), MARKER);
      expect(body).toContain("abandoned");
      expect(body).not.toContain("(`");
    });
  });

  describe("counts table", () => {
    it("renders every documented count", () => {
      const body = composeSummaryBody(summaryReport(), MARKER);
      expect(body).toContain("| Total paths | 42 |");
      expect(body).toContain("| Reviewable | 30 |");
      expect(body).toContain("| Excluded | 8 |");
      expect(body).toContain("| Mechanically clean | 4 |");
      expect(body).toContain("| Critical pointer changes (content not reviewable) | 1 |");
      expect(body).toContain("| Replayed from cache | 5 |");
      expect(body).not.toContain("Resumed from generation checkpoint");
      expect(body).toContain("| Cache miss (path-set shape changed) | 2 |");
      expect(body).toContain("| Freshly reviewed | 25 |");
      expect(body).toContain("| Findings published | 3 |");
      expect(body).toContain("| Suppressed (intra-run duplicate) | 0 |");
      expect(body).toContain("| Suppressed (exact duplicate) | 1 |");
      expect(body).toContain("| Suppressed (similar) | 2 |");
      expect(body).toContain("| Suppressed (dispositioned) | 0 |");
      expect(body).toContain("| Suppressed (outdated recurrence) | 6 |");
      expect(body).toContain("| Withheld by evidence (undecided) | 11 (2) |");
      // The four counters `publicationDegraded` (review.ts) actually decides complete-vs-incomplete
      // on — previously computed but never surfaced on this comment.
      expect(body).toContain("| Rejected (sanitization) | 7 |");
      expect(body).toContain("| Rejected (placement) | 8 |");
      expect(body).toContain("| Read-back failures | 9 |");
      expect(body).toContain("| API failures | 10 |");
    });

    it("shows resumed generation only when a checkpoint actually saved model work", () => {
      const body = composeSummaryBody(
        summaryReport({ counts: { ...COUNTS, checkpointHits: 4, freshlyReviewed: 21 } }),
        MARKER,
      );
      expect(body).toContain("| Resumed from generation checkpoint | 4 |");
      expect(body).toContain("| Freshly reviewed | 21 |");
    });

    // Keiko-for-Quality#50's visibility requirement: replay staleness and dedup behaviour must stay
    // visible, which is why the four duplicate-suppression stages (v0.12.0's intra-run clustering,
    // #38's exact marker, #51's phrasing-independent similarity, #64's dispositioned recurrence) are
    // surfaced as four counts, never folded into one.
    it("carries every duplicate-suppression stage separately, never merged into one count", () => {
      const body = composeSummaryBody(
        summaryReport({
          counts: {
            ...COUNTS,
            suppressedIntraRun: 5,
            suppressedExactDuplicate: 9,
            suppressedSimilar: 4,
            suppressedDispositioned: 7,
          },
        }),
        MARKER,
      );
      expect(body).toContain("| Suppressed (intra-run duplicate) | 5 |");
      expect(body).toContain("| Suppressed (exact duplicate) | 9 |");
      expect(body).toContain("| Suppressed (similar) | 4 |");
      expect(body).toContain("| Suppressed (dispositioned) | 7 |");
    });

    it("never lists an individual path — aggregate counts only", () => {
      const body = composeSummaryBody(summaryReport(), MARKER);
      expect(body).not.toMatch(/\.ts`|\.js`|\.md`/);
    });
  });

  describe("budget line", () => {
    it("shows only the allotted budget when no spend was reported", () => {
      const body = composeSummaryBody(
        summaryReport({ budget: { allotted: 1_200_000, spent: undefined } }),
        MARKER,
      );
      expect(body).toContain("Budget: 1200000 tokens allotted");
      expect(body).not.toContain("reported");
    });

    it("shows both the allotted budget and the reported spend when both are known", () => {
      const body = composeSummaryBody(
        summaryReport({ budget: { allotted: 1_200_000, spent: 980_000 } }),
        MARKER,
      );
      expect(body).toContain("Budget: 1200000 tokens allotted, 980000 reported");
    });

    it("omits the budget line entirely when neither was recorded, rather than fabricating a zero", () => {
      const body = composeSummaryBody(
        summaryReport({ budget: { allotted: undefined, spent: undefined } }),
        MARKER,
      );
      expect(body).not.toContain("Budget:");
    });
  });

  describe("duration row (Issue #59)", () => {
    it("renders the measured wall-clock duration in whole seconds", () => {
      const body = composeSummaryBody(summaryReport({ durationMs: 42_000 }), MARKER);
      expect(body).toContain("| Duration (s) | 42 |");
    });

    it("rounds to the nearest whole second rather than truncating", () => {
      const body = composeSummaryBody(summaryReport({ durationMs: 42_600 }), MARKER);
      expect(body).toContain("| Duration (s) | 43 |");
    });

    it("renders even a zero duration rather than omitting the row", () => {
      const body = composeSummaryBody(summaryReport({ durationMs: 0 }), MARKER);
      expect(body).toContain("| Duration (s) | 0 |");
    });
  });

  describe("tokens-per-published-finding row", () => {
    it("renders the ceiling of spend divided by findings published, when both are known", () => {
      const body = composeSummaryBody(
        summaryReport({
          budget: { allotted: 1_200_000, spent: 100_001 },
          counts: { ...COUNTS, findingsPublished: 3 },
        }),
        MARKER,
      );
      // 100_001 / 3 = 33_333.67 — asserting the ceiling, not a value floor/round would also produce.
      expect(body).toContain("| Tokens per published finding | 33334 |");
    });

    it("omits the row when spend was never recorded this run", () => {
      const body = composeSummaryBody(
        summaryReport({
          budget: { allotted: 1_200_000, spent: undefined },
          counts: { ...COUNTS, findingsPublished: 3 },
        }),
        MARKER,
      );
      expect(body).not.toContain("Tokens per published finding");
    });

    it("omits the row when nothing was published, rather than dividing by zero", () => {
      const body = composeSummaryBody(
        summaryReport({
          budget: { allotted: 1_200_000, spent: 100_000 },
          counts: { ...COUNTS, findingsPublished: 0 },
        }),
        MARKER,
      );
      expect(body).not.toContain("Tokens per published finding");
    });
  });

  /**
   * `SummaryReport.reason` is typed `ReasonCode | undefined`, which already stops any ordinary
   * caller from constructing a non-enum value at compile time — there is no wider `string` field it
   * could flow through instead. This proves the second half of that guarantee: even a caller that
   * bypasses the type checker entirely (a raw cast, exactly what a defect elsewhere in the pipeline
   * could produce) cannot make a hostile value reach the published body, because `composeSummaryBody`
   * re-validates against the closed vocabulary at runtime rather than trusting the static type.
   */
  describe("redaction: the closed reason-code vocabulary cannot be bypassed", () => {
    it("never renders a value outside the closed vocabulary, even if the type system is bypassed", () => {
      const hostile = "hostile <script>alert(1)</script> injected-value" as unknown as ReasonCode;
      const body = composeSummaryBody(
        summaryReport({ outcome: "incomplete", reason: hostile }),
        MARKER,
      );
      expect(body).not.toContain("hostile");
      expect(body).not.toContain("<script>");
      expect(body).toContain("(`unknown`)");
    });
  });
});
