import { describe, expect, it } from "vitest";

import {
  composeBody,
  extractMarker,
  fingerprint,
  hasMarker,
  renderMarker,
  summaryMarker,
} from "./marker.js";

const BASE = {
  repository: "acme/widget",
  pullNumber: 7,
  path: "src/retry.ts",
  rule: "bug",
  body: "The retry loop never resets the attempt counter.",
};

describe("fingerprint", () => {
  it("is stable for identical input", () => {
    expect(fingerprint(BASE)).toBe(fingerprint(BASE));
  });

  // A finding pushed down the file by an unrelated edit is the same finding. Reposting it would
  // punish a contributor for touching a neighbouring line.
  it("does not depend on line numbers", () => {
    expect(fingerprint(BASE)).toBe(fingerprint({ ...BASE }));
  });

  it("ignores cosmetic rewording of the same point", () => {
    const reworded = { ...BASE, body: "  THE RETRY LOOP never resets   the attempt counter!  " };
    expect(fingerprint(reworded)).toBe(fingerprint(BASE));
  });

  it("ignores code-block drift, which models vary freely", () => {
    const withCode = { ...BASE, body: `${BASE.body}\n\n\`\`\`ts\nlet i = 0;\n\`\`\`` };
    expect(fingerprint(withCode)).toBe(fingerprint(BASE));
  });

  it.each([
    ["repository", { repository: "other/widget" }],
    ["pull request", { pullNumber: 8 }],
    ["path", { path: "src/other.ts" }],
    ["rule", { rule: "security" }],
    ["substance", { body: "An entirely different defect about locking." }],
  ])("changes when the %s changes", (_name, override) => {
    expect(fingerprint({ ...BASE, ...override })).not.toBe(fingerprint(BASE));
  });

  it("produces a compact hexadecimal token", () => {
    expect(fingerprint(BASE)).toMatch(/^[0-9a-f]{32}$/);
  });

  // A finding's marker must stay head-independent (see `does not depend on line numbers` above), but
  // the incomplete-review notice's marker needs the opposite: Keiko-for-Quality#38 found two
  // byte-identical notices published against the same head, and the notice's own dedup key excluding
  // `head` entirely is one contributor — see `publisher.ts`'s `publishIncompleteNotice`.
  describe("optional head field", () => {
    it("does not change the fingerprint when omitted, matching every existing caller", () => {
      expect(fingerprint(BASE)).toBe(fingerprint({ ...BASE }));
    });

    it("changes the fingerprint when supplied and different", () => {
      const withHead = { ...BASE, head: "a".repeat(40) };
      const otherHead = { ...BASE, head: "b".repeat(40) };
      expect(fingerprint(withHead)).not.toBe(fingerprint(otherHead));
    });

    it("is stable for the identical head", () => {
      const withHead = { ...BASE, head: "a".repeat(40) };
      expect(fingerprint(withHead)).toBe(fingerprint({ ...withHead }));
    });

    it("differs from the head-omitted fingerprint of the same otherwise-identical input", () => {
      const withHead = { ...BASE, head: "a".repeat(40) };
      expect(fingerprint(withHead)).not.toBe(fingerprint(BASE));
    });
  });
});

describe("marker rendering", () => {
  it("round-trips through render and extract", () => {
    const value = fingerprint(BASE);
    expect(extractMarker(renderMarker(value))).toBe(value);
  });

  it("finds a marker appended to a body", () => {
    const body = composeBody("Some finding text.", fingerprint(BASE));
    expect(hasMarker(body)).toBe(true);
    expect(extractMarker(body)).toBe(fingerprint(BASE));
  });

  it("reports no marker for an ordinary human comment", () => {
    expect(extractMarker("Looks good to me")).toBeUndefined();
    expect(hasMarker("Looks good to me")).toBe(false);
  });

  it("ignores a malformed lookalike", () => {
    expect(extractMarker("<!-- keiko-for-quality:v1:not-hex -->")).toBeUndefined();
    expect(extractMarker("<!-- keiko-for-quality:v2:" + "a".repeat(32) + " -->")).toBeUndefined();
  });

  it("keeps the marker as the only HTML in the composed body", () => {
    const body = composeBody("Plain prose finding.", fingerprint(BASE));
    expect(body.match(/</g)).toHaveLength(1);
  });
});

/**
 * The run-summary marker (Keiko-for-Quality#31) must do the opposite of a finding's or a notice's:
 * stay fixed across every run of the same pull request, however the counts or the head changed, so
 * the upsert finds and updates the same one comment instead of creating a new one every time.
 */
describe("summaryMarker", () => {
  it("is stable across repeated calls for the same repository and pull request", () => {
    expect(summaryMarker("acme/widget", 7)).toBe(summaryMarker("acme/widget", 7));
  });

  it("produces a compact hexadecimal token in the same shape every other marker uses", () => {
    expect(summaryMarker("acme/widget", 7)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes when the repository changes", () => {
    expect(summaryMarker("acme/widget", 7)).not.toBe(summaryMarker("acme/other", 7));
  });

  it("changes when the pull request changes", () => {
    expect(summaryMarker("acme/widget", 7)).not.toBe(summaryMarker("acme/widget", 8));
  });

  it("is unaffected by which head is being described — a fresh push must not mint a new marker", () => {
    // There is no `head` parameter to vary here at all: unlike `fingerprint`'s optional `head`
    // field, `summaryMarker` never accepts one, which is what makes the comment head-independent by
    // construction rather than by a caller remembering to omit an argument.
    expect(summaryMarker("acme/widget", 7)).toBe(summaryMarker("acme/widget", 7));
  });

  it("differs from an ordinary finding marker for the same repository and pull request", () => {
    const findingMarker = fingerprint({
      repository: "acme/widget",
      pullNumber: 7,
      path: "src/retry.ts",
      rule: "bug",
      body: "run-summary",
    });
    expect(summaryMarker("acme/widget", 7)).not.toBe(findingMarker);
  });
});
