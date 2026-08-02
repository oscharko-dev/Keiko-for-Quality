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

  /**
   * `pathInstructions` is optional and, before this feature existed, unknown: `rejectUnknownKeys`
   * threw on any profile declaring it (see "rejects an unknown key" above, which pins the same
   * mechanism for a misspelled field). Every "accepts" case below is therefore also the regression
   * proof — each one throws `ValidationError` against the pre-feature parser and only stops throwing
   * once `pathInstructions` is a recognized, validated key.
   */
  describe("pathInstructions", () => {
    it("defaults to an empty list when the key is absent", () => {
      expect(parseReviewProfile(VALID).pathInstructions).toEqual([]);
    });

    it("accepts a well-formed entry", () => {
      const profile = parseReviewProfile({
        ...VALID,
        pathInstructions: [{ paths: ["**/*.sql"], instructions: "Use snake_case identifiers." }],
      });
      expect(profile.pathInstructions).toEqual([
        { paths: ["**/*.sql"], instructions: "Use snake_case identifiers." },
      ]);
    });

    it("accepts several patterns on one entry, and several entries", () => {
      const profile = parseReviewProfile({
        ...VALID,
        pathInstructions: [
          { paths: ["**/*.sql", "db/**"], instructions: "Prefer parameterized queries." },
          { paths: ["**/*.md"], instructions: "Prefer active voice." },
        ],
      });
      expect(profile.pathInstructions).toHaveLength(2);
      expect(profile.pathInstructions[0]?.paths).toEqual(["**/*.sql", "db/**"]);
    });

    it("accepts instruction text containing a newline", () => {
      const profile = parseReviewProfile({
        ...VALID,
        pathInstructions: [
          { paths: ["**/*.sql"], instructions: "Use snake_case.\nAvoid SELECT *." },
        ],
      });
      expect(profile.pathInstructions[0]?.instructions).toBe("Use snake_case.\nAvoid SELECT *.");
    });

    it("accepts instructions text at exactly the per-entry bound (1024)", () => {
      const profile = parseReviewProfile({
        ...VALID,
        pathInstructions: [{ paths: ["**/*.sql"], instructions: "a".repeat(1024) }],
      });
      expect(profile.pathInstructions[0]?.instructions).toHaveLength(1024);
    });

    it("rejects a non-array pathInstructions", () => {
      expect(() => parseReviewProfile({ ...VALID, pathInstructions: "nope" })).toThrow(
        ValidationError,
      );
    });

    it("rejects more entries than the declared bound (32)", () => {
      const entries = Array.from({ length: 33 }, (_, i) => ({
        paths: [`pkg-${String(i)}/**`],
        instructions: "Keep this short.",
      }));
      expect(() => parseReviewProfile({ ...VALID, pathInstructions: entries })).toThrow(
        ValidationError,
      );
    });

    it("rejects an entry that is not an object", () => {
      expect(() => parseReviewProfile({ ...VALID, pathInstructions: ["**/*.sql"] })).toThrow(
        ValidationError,
      );
    });

    it("rejects an entry missing paths", () => {
      expect(() =>
        parseReviewProfile({ ...VALID, pathInstructions: [{ instructions: "Do X." }] }),
      ).toThrow(ValidationError);
    });

    it("rejects an entry missing instructions", () => {
      expect(() =>
        parseReviewProfile({ ...VALID, pathInstructions: [{ paths: ["**/*.sql"] }] }),
      ).toThrow(ValidationError);
    });

    it("rejects an extra key smuggled into an entry", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [{ paths: ["**/*.sql"], instructions: "Do X.", severity: "high" }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects a non-array paths field", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [{ paths: "**/*.sql", instructions: "Do X." }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects an entry with zero paths", () => {
      expect(() =>
        parseReviewProfile({ ...VALID, pathInstructions: [{ paths: [], instructions: "Do X." }] }),
      ).toThrow(ValidationError);
    });

    it("rejects more paths on one entry than the declared bound (16)", () => {
      const paths = Array.from({ length: 17 }, (_, i) => `pkg-${String(i)}/**`);
      expect(() =>
        parseReviewProfile({ ...VALID, pathInstructions: [{ paths, instructions: "Do X." }] }),
      ).toThrow(ValidationError);
    });

    it("rejects a path glob longer than the declared bound (512)", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [{ paths: [`**/${"a".repeat(512)}.ts`], instructions: "Do X." }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects a non-string path", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [{ paths: [42], instructions: "Do X." }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects an empty-string path", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [{ paths: [""], instructions: "Do X." }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects a path containing a control character", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [
            { paths: [`**/${String.fromCodePoint(0)}.ts`], instructions: "Do X." },
          ],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects duplicate globs declared within one entry", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [{ paths: ["**/*.sql", "**/*.sql"], instructions: "Do X." }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects the same glob declared across two different entries", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [
            { paths: ["**/*.sql"], instructions: "Do X." },
            { paths: ["**/*.sql"], instructions: "Do Y." },
          ],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects a non-string instructions field", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [{ paths: ["**/*.sql"], instructions: 42 }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects an empty instructions string", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [{ paths: ["**/*.sql"], instructions: "" }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects instructions text over the per-entry bound (1024)", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [{ paths: ["**/*.sql"], instructions: "a".repeat(1025) }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects instructions text containing a control character other than newline", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          pathInstructions: [
            { paths: ["**/*.sql"], instructions: `Do X.${String.fromCodePoint(0)}` },
          ],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects the total instructions length over the aggregate bound (8192) even though every entry stays within its own per-entry bound", () => {
      const entries = Array.from({ length: 9 }, (_, i) => ({
        paths: [`pkg-${String(i)}/**`],
        instructions: "a".repeat(1000),
      }));
      // 9 * 1000 = 9000 > 8192, while every individual entry is well under the 1024 per-entry cap.
      expect(() => parseReviewProfile({ ...VALID, pathInstructions: entries })).toThrow(
        ValidationError,
      );
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

  // `pathInstructions` reuses `GlobSet` — the same compiler `reviewRelevant`/`generated`/`excluded`
  // already use — rather than a second glob implementation, so a pattern behaves identically here.
  it("compiles pathInstructions patterns with the same glob semantics as reviewRelevant", () => {
    const compiled = loadReviewProfile(
      JSON.stringify({
        ...VALID,
        pathInstructions: [{ paths: ["**/*.sql"], instructions: "Use snake_case identifiers." }],
      }),
    );
    expect(compiled.pathInstructions).toHaveLength(1);
    expect(compiled.pathInstructions[0]?.matcher.matches("db/schema.sql")).toBe(true);
    expect(compiled.pathInstructions[0]?.matcher.matches("src/index.ts")).toBe(false);
    expect(compiled.pathInstructions[0]?.instructions).toBe("Use snake_case identifiers.");
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
