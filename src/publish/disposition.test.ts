import { describe, expect, it } from "vitest";

import { isSubstantiveDisposition, type ThreadLastReply } from "./disposition.js";

const IDENTITY = "keiko-for-quality[bot]";

const AUTOMATION_FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

const REAL_DISPOSITION =
  "Fixed in commit abc1234 — the fallback connector now falls back correctly when the primary " +
  "endpoint is unset. See the follow-up pull request for the full explanation of the change.";

function reply(overrides: Partial<ThreadLastReply> = {}): ThreadLastReply {
  return { authorLogin: "a-contributor", body: REAL_DISPOSITION, ...overrides };
}

describe("isSubstantiveDisposition", () => {
  it("is false when there is no last reply at all", () => {
    expect(isSubstantiveDisposition(undefined, IDENTITY)).toBe(false);
  });

  /**
   * A thread whose only comment is its own root finding reports that same comment back as
   * `lastReply` — there is nothing else in the thread. This is what makes a bare "resolved, no
   * reply at all" click read as undispositioned without `client.ts` needing to know why.
   */
  it("is false when the last reply is this reviewer's own root comment (a bare resolve)", () => {
    expect(isSubstantiveDisposition(reply({ authorLogin: IDENTITY }), IDENTITY)).toBe(false);
  });

  it("is true for a real, substantive disposition reply", () => {
    expect(isSubstantiveDisposition(reply(), IDENTITY)).toBe(true);
  });

  it("is false for a short acknowledgement with no reasoning", () => {
    expect(isSubstantiveDisposition(reply({ body: "Resolved, thanks." }), IDENTITY)).toBe(false);
  });

  it("is false for a reply that is only the automation footer, however long its link makes it", () => {
    const longFooter =
      "🤖 Generated with [Claude Code](https://claude.com/claude-code/a/very/long/path/segment" +
      "/that/pads/this/single/line/well/past/eighty/characters/on/its/own)";
    expect(longFooter.length).toBeGreaterThanOrEqual(80);
    expect(isSubstantiveDisposition(reply({ body: longFooter }), IDENTITY)).toBe(false);
  });

  it("is false for a reply that is only a Co-Authored-By trailer", () => {
    expect(
      isSubstantiveDisposition(
        reply({ body: "Co-Authored-By: Someone Helpful <helpful@example.test>" }),
        IDENTITY,
      ),
    ).toBe(false);
  });

  it("is true when substantive text is followed by the automation footer — the footer is stripped, not counted, but does not poison the rest", () => {
    expect(
      isSubstantiveDisposition(
        reply({ body: `${REAL_DISPOSITION}\n\n${AUTOMATION_FOOTER}` }),
        IDENTITY,
      ),
    ).toBe(true);
  });

  it("does not count an HTML comment's own characters toward substance", () => {
    const shortText = "Not a real reply.";
    const paddedWithComment = `${shortText}\n\n<!-- ${"x".repeat(200)} -->`;
    // Without stripping, the raw length would clear 80 characters purely from the comment.
    expect(paddedWithComment.length).toBeGreaterThanOrEqual(80);
    expect(isSubstantiveDisposition(reply({ body: paddedWithComment }), IDENTITY)).toBe(false);
  });

  describe("the 80-character boundary", () => {
    it("is true at exactly 80 substantive characters", () => {
      expect(isSubstantiveDisposition(reply({ body: "x".repeat(80) }), IDENTITY)).toBe(true);
    });

    it("is false at 79 substantive characters", () => {
      expect(isSubstantiveDisposition(reply({ body: "x".repeat(79) }), IDENTITY)).toBe(false);
    });
  });

  it("is false for an empty reply body", () => {
    expect(isSubstantiveDisposition(reply({ body: "" }), IDENTITY)).toBe(false);
  });

  /**
   * A thread's last reply is candidate-influenced content — anyone who can comment can shape what
   * this function scans — and `HTML_COMMENT`'s `[\s\S]*?` is the same unanchored-scan shape
   * `similarity.ts`'s own bound exists for. This pins that a degenerate, comment-free body of
   * realistic hostile size still evaluates promptly rather than reading as evidence the bound is
   * missing (a hang here would fail the test file's own timeout, not this assertion).
   */
  it("evaluates promptly against a large, comment-free reply instead of scanning it unbounded", () => {
    const hostile = "x".repeat(500_000);
    const started = performance.now();
    expect(isSubstantiveDisposition(reply({ body: hostile }), IDENTITY)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
