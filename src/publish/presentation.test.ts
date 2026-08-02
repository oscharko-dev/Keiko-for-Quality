import { describe, expect, it } from "vitest";

import { composeFindingBody, composeIncompleteNotice, splitTitle } from "./presentation.js";
import { sanitizeFindingBody } from "./sanitize.js";

const MARKER = `keiko-for-quality:v1:${"a".repeat(32)}`;

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

  it("leads with a scannable classification line", () => {
    expect(document.split("\n")[0]).toBe("_🔒 Security_ | _🔴 Critical_");
  });

  it("states the action as a bold imperative before the argument", () => {
    expect(document).toContain("**Validate the token in full, not by prefix.**");
    const header = document.indexOf("_🔒 Security_");
    const title = document.indexOf("**Validate");
    const prose = document.indexOf("This comparison");
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

  it("falls back to neutral labels for an unknown classification", () => {
    const unknown = composeFindingBody(REAL_PROSE, MARKER, {
      ...CONTEXT,
      severity: "catastrophic",
      category: "vibes",
    });
    expect(unknown.split("\n")[0]).toBe("_🔎 Review_ | _🟡 Minor_");
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
    expect(notice.split("\n")[0]).toBe("_⚠️ Coverage_ | _🟠 Major_");
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
});
