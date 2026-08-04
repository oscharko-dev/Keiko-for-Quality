import { describe, expect, it } from "vitest";

import { ValidationError } from "../core/brands.js";
import {
  loadReviewProfile,
  parseReviewProfile,
  type CompiledProfile,
  type ContractPair,
  type ReviewProfile,
} from "./profile.js";

const VALID = {
  version: 1,
  reviewRelevant: ["src/**/*.ts"],
  deletionCritical: ["tests/**"],
  generated: ["dist/**"],
  excluded: [{ pattern: "vendor/**", reason: "third-party source reviewed upstream" }],
  benignWarnings: [{ type: "context_truncated", justification: "known on very large files" }],
};

/**
 * `contractPairs` is optional on both `ReviewProfile` and `CompiledProfile` — see profile.ts's own
 * comment on why a field this new stays optional at the type level, not only in the source JSON.
 * Every test below that reaches for these helpers has itself declared `contractPairs`, so `?? []` is
 * exactly as safe here as the `noUncheckedIndexedAccess` `?.` already used throughout this file for
 * `pathInstructions[0]`: it turns the type back into a plain array without hiding a real regression,
 * because a parser or compiler that stopped populating the field would still fail these tests' own
 * content assertions — an empty array's `[0]` is `undefined`, and every assertion below expects
 * otherwise.
 */
function pairs(profile: ReviewProfile): readonly ContractPair[] {
  return profile.contractPairs ?? [];
}

function compiledPairs(compiled: CompiledProfile): NonNullable<CompiledProfile["contractPairs"]> {
  return compiled.contractPairs ?? [];
}

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

  /**
   * `contractPairs` is optional and, before this feature existed, unknown — the same
   * `rejectUnknownKeys` mechanism the `pathInstructions` regression comment above describes. Every
   * "accepts" case below is therefore also that same regression proof, this time for `contractPairs`.
   */
  describe("contractPairs", () => {
    const MINIMAL_ENTRY = {
      paths: ["src/server/routes/**/*.ts"],
      counterparts: ["src/client/api-types.ts"],
    };

    it("defaults to an empty list when the key is absent", () => {
      expect(parseReviewProfile(VALID).contractPairs).toEqual([]);
    });

    it("accepts a well-formed minimal entry with no contract note", () => {
      const profile = parseReviewProfile({ ...VALID, contractPairs: [MINIMAL_ENTRY] });
      expect(profile.contractPairs).toEqual([MINIMAL_ENTRY]);
      // Never merely `undefined` — the key itself must be absent, which is what
      // `exactOptionalPropertyTypes` is for.
      expect(Object.hasOwn(pairs(profile)[0] ?? {}, "contract")).toBe(false);
    });

    it("accepts an entry with a contract note", () => {
      const profile = parseReviewProfile({
        ...VALID,
        contractPairs: [
          { ...MINIMAL_ENTRY, contract: "response shapes declared on both sides must agree" },
        ],
      });
      expect(pairs(profile)[0]?.contract).toBe("response shapes declared on both sides must agree");
    });

    it("accepts several paths and several counterparts on one entry, and several entries", () => {
      const profile = parseReviewProfile({
        ...VALID,
        contractPairs: [
          {
            paths: ["src/server/routes/**/*.ts", "src/server/handlers/**/*.ts"],
            counterparts: ["src/client/api-types.ts", "docs/api.md"],
          },
          { paths: ["src/db/migrations/**"], counterparts: ["src/db/schema.ts"] },
        ],
      });
      expect(profile.contractPairs).toHaveLength(2);
      expect(pairs(profile)[0]?.paths).toEqual([
        "src/server/routes/**/*.ts",
        "src/server/handlers/**/*.ts",
      ]);
      expect(pairs(profile)[0]?.counterparts).toEqual(["src/client/api-types.ts", "docs/api.md"]);
    });

    it("rejects a non-array contractPairs", () => {
      expect(() => parseReviewProfile({ ...VALID, contractPairs: "nope" })).toThrow(
        ValidationError,
      );
    });

    it("rejects an entry that is not an object", () => {
      expect(() =>
        parseReviewProfile({ ...VALID, contractPairs: ["src/server/routes/**/*.ts"] }),
      ).toThrow(ValidationError);
    });

    it("rejects an entry missing paths", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [{ counterparts: ["src/client/api-types.ts"] }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects an entry missing counterparts", () => {
      expect(() =>
        parseReviewProfile({ ...VALID, contractPairs: [{ paths: ["src/server/routes/**/*.ts"] }] }),
      ).toThrow(ValidationError);
    });

    it("rejects an extra key smuggled into an entry", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [{ ...MINIMAL_ENTRY, severity: "high" }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects an entry with zero paths", () => {
      expect(() =>
        parseReviewProfile({ ...VALID, contractPairs: [{ ...MINIMAL_ENTRY, paths: [] }] }),
      ).toThrow(ValidationError);
    });

    it("rejects an entry with zero counterparts", () => {
      expect(() =>
        parseReviewProfile({ ...VALID, contractPairs: [{ ...MINIMAL_ENTRY, counterparts: [] }] }),
      ).toThrow(ValidationError);
    });

    it("rejects more entries than the declared bound (16)", () => {
      const entries = Array.from({ length: 17 }, (_, i) => ({
        paths: [`pkg-${String(i)}/**`],
        counterparts: [`pkg-${String(i)}/counterpart.ts`],
      }));
      expect(() => parseReviewProfile({ ...VALID, contractPairs: entries })).toThrow(
        ValidationError,
      );
    });

    it("rejects more paths on one entry than the declared bound (8)", () => {
      const paths = Array.from({ length: 9 }, (_, i) => `pkg-${String(i)}/**`);
      expect(() =>
        parseReviewProfile({ ...VALID, contractPairs: [{ ...MINIMAL_ENTRY, paths }] }),
      ).toThrow(ValidationError);
    });

    it("rejects more counterparts on one entry than the declared bound (8)", () => {
      const counterparts = Array.from({ length: 9 }, (_, i) => `pkg-${String(i)}/counterpart.ts`);
      expect(() =>
        parseReviewProfile({ ...VALID, contractPairs: [{ ...MINIMAL_ENTRY, counterparts }] }),
      ).toThrow(ValidationError);
    });

    it("rejects a glob containing a control character in paths — parseGlobPaths is genuinely shared", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [{ ...MINIMAL_ENTRY, paths: [`src/${String.fromCodePoint(0)}/**`] }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects a counterpart containing a glob metacharacter", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [{ ...MINIMAL_ENTRY, counterparts: ["src/client/*.ts"] }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects a counterpart with a `..` segment", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [{ ...MINIMAL_ENTRY, counterparts: ["src/../secret.ts"] }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects an absolute counterpart path", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [{ ...MINIMAL_ENTRY, counterparts: ["/etc/passwd"] }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects a counterpart path longer than the declared bound (512)", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [{ ...MINIMAL_ENTRY, counterparts: [`src/${"a".repeat(512)}.ts`] }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects a contract note over the declared bound (256)", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [{ ...MINIMAL_ENTRY, contract: "a".repeat(257) }],
        }),
      ).toThrow(ValidationError);
    });

    it("accepts a contract note at exactly the declared bound (256)", () => {
      const profile = parseReviewProfile({
        ...VALID,
        contractPairs: [{ ...MINIMAL_ENTRY, contract: "a".repeat(256) }],
      });
      expect(pairs(profile)[0]?.contract).toHaveLength(256);
    });

    it("rejects a contract note containing a control character", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [
            { ...MINIMAL_ENTRY, contract: `agree on shape${String.fromCodePoint(0)}` },
          ],
        }),
      ).toThrow(ValidationError);
    });

    // Unlike `pathInstructions.instructions`, `contract` is documented as a single line: a newline is
    // a control character `CONTROL_EXCEPT_NEWLINE` would let through but `hasControlCharacters` does
    // not, and `contract` reuses the latter for exactly this reason.
    it("rejects a contract note containing a newline, unlike pathInstructions' instructions text", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [{ ...MINIMAL_ENTRY, contract: "agree on shape\nand nothing else" }],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects duplicate globs declared within one entry's paths", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [
            {
              ...MINIMAL_ENTRY,
              paths: ["src/server/routes/**/*.ts", "src/server/routes/**/*.ts"],
            },
          ],
        }),
      ).toThrow(ValidationError);
    });

    it("rejects duplicate counterparts declared within one entry", () => {
      expect(() =>
        parseReviewProfile({
          ...VALID,
          contractPairs: [
            {
              ...MINIMAL_ENTRY,
              counterparts: ["src/client/api-types.ts", "src/client/api-types.ts"],
            },
          ],
        }),
      ).toThrow(ValidationError);
    });

    // Deliberate divergence from `pathInstructions`, which threads one `Set` across its whole array
    // and would reject this. See `parseContractPairEntry`'s own comment in profile.ts for why: two
    // entries sharing a glob are not competing the way two guidance blocks would be.
    it("accepts the same glob declared across two different entries", () => {
      const profile = parseReviewProfile({
        ...VALID,
        contractPairs: [
          { paths: ["src/server/routes/**/*.ts"], counterparts: ["src/client/api-types.ts"] },
          { paths: ["src/server/routes/**/*.ts"], counterparts: ["docs/api.md"] },
        ],
      });
      expect(profile.contractPairs).toHaveLength(2);
      expect(pairs(profile)[0]?.paths).toEqual(pairs(profile)[1]?.paths);
    });

    // Same divergence, the other direction: a counterpart may recur across entries too — only
    // repetition within one entry's own list is rejected (see the "duplicate counterparts" case
    // above).
    it("accepts the same counterpart declared across two different entries", () => {
      const profile = parseReviewProfile({
        ...VALID,
        contractPairs: [
          { paths: ["src/server/routes/**/*.ts"], counterparts: ["src/client/api-types.ts"] },
          { paths: ["src/server/handlers/**/*.ts"], counterparts: ["src/client/api-types.ts"] },
        ],
      });
      expect(profile.contractPairs).toHaveLength(2);
    });

    it("parses a profile without contractPairs to a result deep-equal to the pre-existing shape, contractPairs included as []", () => {
      expect(parseReviewProfile(VALID)).toEqual({
        version: 1,
        reviewRelevant: ["src/**/*.ts"],
        deletionCritical: ["tests/**"],
        generated: ["dist/**"],
        excluded: [{ pattern: "vendor/**", reason: "third-party source reviewed upstream" }],
        benignWarnings: [{ type: "context_truncated", justification: "known on very large files" }],
        pathInstructions: [],
        contractPairs: [],
      });
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

  // `contractPairs` reuses the same `GlobSet` compiler for `paths` and carries `counterparts`/
  // `contract` through unchanged — the compiled shape `ContractPair`'s own doc comment promises.
  it("compiles contractPairs patterns with the same glob semantics as reviewRelevant, carrying counterparts and contract through verbatim", () => {
    const compiled = loadReviewProfile(
      JSON.stringify({
        ...VALID,
        contractPairs: [
          {
            paths: ["src/server/routes/**/*.ts"],
            counterparts: ["src/client/api-types.ts"],
            contract: "response shapes declared on both sides must agree",
          },
        ],
      }),
    );
    expect(compiled.contractPairs).toHaveLength(1);
    expect(compiledPairs(compiled)[0]?.matcher.matches("src/server/routes/users.ts")).toBe(true);
    expect(compiledPairs(compiled)[0]?.matcher.matches("src/index.ts")).toBe(false);
    expect(compiledPairs(compiled)[0]?.counterparts).toEqual(["src/client/api-types.ts"]);
    expect(compiledPairs(compiled)[0]?.contract).toBe(
      "response shapes declared on both sides must agree",
    );
  });

  it("compiles an entry with no contract note to a compiled entry carrying no contract key at all", () => {
    const compiled = loadReviewProfile(
      JSON.stringify({
        ...VALID,
        contractPairs: [
          { paths: ["src/server/routes/**/*.ts"], counterparts: ["src/client/api-types.ts"] },
        ],
      }),
    );
    expect(Object.hasOwn(compiledPairs(compiled)[0] ?? {}, "contract")).toBe(false);
  });

  // The additive contract at the compiled level, not just the parsed level: an absent key must
  // compile identically to an explicit empty list, so nothing about adding this field changes the
  // compiled shape of a profile that never declares it.
  it("compiles a profile without contractPairs identically to one that declares an empty list explicitly", () => {
    const withoutField = loadReviewProfile(JSON.stringify(VALID));
    const withEmptyList = loadReviewProfile(JSON.stringify({ ...VALID, contractPairs: [] }));
    expect(withoutField).toEqual(withEmptyList);
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
