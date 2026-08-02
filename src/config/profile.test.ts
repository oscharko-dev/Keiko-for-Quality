import { describe, expect, it } from "vitest";

import { ValidationError } from "../core/brands.js";
import { loadReviewProfile, parseReviewProfile } from "./profile.js";

const VALID = {
  version: 1,
  reviewRelevant: ["src/**/*.ts"],
  deletionCritical: ["tests/**"],
  generated: ["dist/**"],
  excluded: [{ pattern: "vendor/**", reason: "third-party source reviewed upstream" }],
  benignWarnings: [{ type: "context_truncated", justification: "known on very large files" }],
};

describe("parseReviewProfile", () => {
  it("accepts a complete profile", () => {
    expect(parseReviewProfile(VALID).reviewRelevant).toEqual(["src/**/*.ts"]);
  });

  it("rejects an unknown schema version", () => {
    expect(() => parseReviewProfile({ ...VALID, version: 2 })).toThrow(ValidationError);
  });

  it("rejects an unknown key", () => {
    expect(() => parseReviewProfile({ ...VALID, reviewRelevent: [] })).toThrow(ValidationError);
  });

  // An empty include list would classify every changed path as unclassified, which fails the run —
  // but failing at parse time says what is actually wrong.
  it("rejects an empty review-relevant list", () => {
    expect(() => parseReviewProfile({ ...VALID, reviewRelevant: [] })).toThrow(ValidationError);
  });

  describe("justifications are mandatory", () => {
    it("rejects an exclusion with no stated reason", () => {
      expect(() => parseReviewProfile({ ...VALID, excluded: [{ pattern: "vendor/**" }] })).toThrow(
        ValidationError,
      );
    });

    it("rejects an exclusion with an empty reason", () => {
      expect(() =>
        parseReviewProfile({ ...VALID, excluded: [{ pattern: "vendor/**", reason: "" }] }),
      ).toThrow(ValidationError);
    });

    it("rejects a benign-warning entry with no justification", () => {
      expect(() =>
        parseReviewProfile({ ...VALID, benignWarnings: [{ type: "context_truncated" }] }),
      ).toThrow(ValidationError);
    });

    it("rejects an extra key smuggled into an exclusion", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          excluded: [{ pattern: "vendor/**", reason: "ok", silent: true }],
        }),
      ).toThrow(ValidationError);
    });
  });
});

describe("loadReviewProfile", () => {
  it("compiles matchers from the parsed profile", () => {
    const compiled = loadReviewProfile(JSON.stringify(VALID));
    expect(compiled.reviewRelevant.matches("src/a.ts")).toBe(true);
    expect(compiled.generated.matches("dist/index.js")).toBe(true);
    expect(compiled.benignWarnings.get("context_truncated")).toBe("known on very large files");
  });

  it("rejects malformed JSON without echoing the document", () => {
    try {
      loadReviewProfile('{"version": 1, oops');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).not.toContain("oops");
    }
  });
});
