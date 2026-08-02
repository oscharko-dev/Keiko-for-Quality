import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildRuleFile, serializeRuleFile } from "./rule-file.js";
import { loadReviewProfile } from "../config/profile.js";
import { sanitizeFindingBody } from "../publish/sanitize.js";

/** Only the fields `buildRuleFile` reads. The rest of a compiled profile is irrelevant here. */
function profileWith(overrides: {
  reviewRelevant?: string[];
  generated?: string[];
  excluded?: { pattern: string; reason: string }[];
  pathInstructions?: { paths: string[]; instructions: string }[];
}): Parameters<typeof buildRuleFile>[0] {
  return {
    profile: {
      version: 1,
      reviewRelevant: overrides.reviewRelevant ?? ["src/**/*.ts"],
      deletionCritical: [],
      generated: overrides.generated ?? [],
      excluded: overrides.excluded ?? [],
      benignWarnings: [],
      pathInstructions: overrides.pathInstructions ?? [],
    },
  } as unknown as Parameters<typeof buildRuleFile>[0];
}

describe("buildRuleFile", () => {
  it("derives include from the consumer's review-relevance statement", () => {
    const file = buildRuleFile(profileWith({ reviewRelevant: ["src/**/*.ts", "scripts/**"] }));
    expect(file.include).toEqual(["src/**/*.ts", "scripts/**"]);
  });

  /**
   * The engine takes one whole filter layer rather than merging them, so an empty `exclude` means
   * no exclusions apply at all. Every generated path that also matched a review-relevant glob was
   * then sent to the model while the inventory counted it as generated — the two sides answering
   * different questions while their totals appeared to agree.
   */
  it("excludes the generated paths", () => {
    const file = buildRuleFile(profileWith({ generated: ["**/dist/**", "**/*.min.js"] }));
    expect(file.exclude).toEqual(["**/dist/**", "**/*.min.js"]);
  });

  /**
   * The two sides resolve an overlap in opposite directions: `classify` checks `generated` first
   * and `excluded` last, so review-relevance beats an exclusion rule — while the engine's filter
   * lets exclude beat include. Passing the profile's `excluded` rules through therefore made them
   * disagree about every path matching both, and that is not a corner case: `docs/qa/**\/*.md` is
   * review-relevant in Keiko's profile *and* matched by its `docs/**\/*.{md,json}` exclusion. The
   * engine dropped those files, the inventory counted them reviewable, and every pull request
   * touching one settled incomplete with a blocking notice. Found in production on the first live
   * run, not in review.
   */
  it("never excludes a path the profile also calls review-relevant", () => {
    const file = buildRuleFile(
      profileWith({
        reviewRelevant: ["docs/qa/**/*.md", "src/**/*.ts"],
        generated: ["**/dist/**"],
        excluded: [{ pattern: "docs/**/*.{md,json}", reason: "prose" }],
      }),
    );
    expect(file.include).toContain("docs/qa/**/*.md");
    expect(file.exclude).not.toContain("docs/**/*.{md,json}");
    expect(file.exclude).toEqual(["**/dist/**"]);
  });

  it("refuses an empty review-relevance statement instead of widening to everything", () => {
    expect(() => buildRuleFile(profileWith({ reviewRelevant: [] }))).toThrow(TypeError);
  });

  /**
   * The inventory's pure-rename downgrade only stops this adapter from *requiring* engine
   * coverage of the path — it does not, by itself, stop the engine from spending on it anyway.
   * Forwarding the path as an exclude is what actually stops the spend.
   */
  describe("mechanically-clean paths", () => {
    it("appends them to exclude, alongside the generated paths", () => {
      const file = buildRuleFile(profileWith({ generated: ["**/dist/**"] }), { paths: [] }, [
        "src/renamed.ts",
      ]);
      expect(file.exclude).toEqual(["**/dist/**", "src/renamed.ts"]);
    });

    it("defaults to an empty list when the caller passes none", () => {
      const file = buildRuleFile(profileWith({ generated: ["**/dist/**"] }));
      expect(file.exclude).toEqual(["**/dist/**"]);
    });

    it("never widens include: a mechanically-clean path is exclude-only", () => {
      const file = buildRuleFile(profileWith({ reviewRelevant: ["src/**/*.ts"] }), { paths: [] }, [
        "src/renamed.ts",
      ]);
      expect(file.include).toEqual(["src/**/*.ts"]);
    });
  });

  it("applies its guidance to every path", () => {
    const file = buildRuleFile(profileWith({}));
    expect(file.rules).toHaveLength(1);
    expect(file.rules[0]?.path).toBe("**/*");
    expect(file.rules[0]?.merge_system_rule).toBe(true);
  });

  /**
   * The rule text tells the model what it may emit, and the sanitizer decides what is publishable.
   * If the two disagree the reviewer loses correct findings and settles incomplete — which is what
   * happened when the link pattern rejected any line starting with `//` while the rule invited a
   * fenced code block. Round-tripping the rule's own examples through the sanitizer keeps the two
   * documents honest about each other.
   */
  it("asks for nothing the publisher would reject", () => {
    const rule = buildRuleFile(profileWith({})).rules[0]?.rule ?? "";
    const examples = [
      "Validate the token in full, not by prefix.\n\nThe comparison accepts any value whose first eight characters match.",
      "Close the handle after reading.\n\nIt leaks on every call:\n\n```js\n// no close on this path\nreturn handle.readFile();\n```",
      "Pin this action to a full commit SHA.\n\nA tag is movable, so the reviewed bytes and the executed bytes stop being the same bytes.",
    ];
    for (const example of examples) {
      expect(sanitizeFindingBody(example).ok).toBe(true);
    }
    expect(rule).toContain("Do not emit HTML, images, links or URLs");
  });

  /**
   * Found by running the reviewer over real merged Keiko commits rather than constructed fixtures.
   * It reported a genuine cross-platform defect — `git diff --no-index -- /dev/null <path>` fails on
   * Windows — and the finding was discarded, because `<path>` matches the HTML check. The guard is
   * correct and stays; what changed is that the rule now tells the model not to write placeholders
   * that way. This pins both halves so they cannot drift apart again.
   */
  it("warns about the placeholder shape that the publisher rejects", () => {
    const rule = buildRuleFile(profileWith({})).rules[0]?.rule ?? "";
    expect(
      sanitizeFindingBody("Use a null device.\n\nIt runs `diff -- /dev/null <path>` today."),
    ).toEqual({
      ok: false,
      reason: "html",
    });
    expect(rule).toContain("Never write a placeholder in angle brackets");
    // A comparison must remain writable — `<` followed by a space is not a tag.
    expect(
      sanitizeFindingBody("Fix the bound.\n\nThe guard `i < items.length` became `i <= n`.").ok,
    ).toBe(true);
  });

  /**
   * Issue #58: the corpus's own measured gap (epic #26's judged-uniques classification) named
   * mechanisms the rule text did not yet ask for. Each assertion here pins one addition to the
   * text a corpus case (`corpus/cases.mjs`) now depends on being present — a regression here would
   * silently widen the gap the case was added to close, with the case itself still green (an
   * anchor-matching false pass would need the model to reconstruct the guidance on its own).
   */
  describe("issue #58 coverage-gap guidance", () => {
    it("asks for a cleared value and a success-shaped error fallback to be treated as defects", () => {
      const rule = buildRuleFile(profileWith({})).rules[0]?.rule ?? "";
      expect(rule).toContain("empty, zero, or cleared value is not the same as no value provided");
      expect(rule).toContain("maps every failure to a success-shaped fallback");
    });

    it("asks for a narrowed-to-exclusion or stale-reference assertion to be treated as weakened", () => {
      const rule = buildRuleFile(profileWith({})).rules[0]?.rule ?? "";
      expect(rule).toContain("exact-value assertion narrowed to merely excluding the old value");
      expect(rule).toContain("captured before a later refresh or refetch");
    });

    it("requires an exhaustive-search statement before a negative-existence claim is published", () => {
      const rule = buildRuleFile(profileWith({})).rules[0]?.rule ?? "";
      expect(rule).toContain("before claiming nothing calls, passes, or reaches a value");
      expect(rule).toContain("no caller passes X");
    });

    it("guards the two ghost-defect classes: a schema-ruled-out collision, and an unverified claim", () => {
      const rule = buildRuleFile(profileWith({})).rules[0]?.rule ?? "";
      expect(rule).toContain("primary key or unique constraint on the compared columns already");
      expect(rule).toContain("before stating how an encoding, format, or algorithm behaves");
      expect(rule).toContain("confidently wrong claim about padding, rounding");
    });
  });

  describe("path-scoped instructions", () => {
    it("renders no section, and changes nothing, when the profile declares none", () => {
      const withoutField = buildRuleFile(profileWith({}));
      const withEmptyArray = buildRuleFile(profileWith({ pathInstructions: [] }));
      expect(withEmptyArray.rules[0]?.rule).toBe(withoutField.rules[0]?.rule);
      expect(withoutField.rules[0]?.rule).not.toContain("Path-scoped guidance");
    });

    it("renders a clearly delimited section naming the globs and the guidance", () => {
      const rule =
        buildRuleFile(
          profileWith({
            pathInstructions: [
              { paths: ["**/*.sql"], instructions: "Use snake_case identifiers." },
            ],
          }),
        ).rules[0]?.rule ?? "";
      expect(rule).toContain("## Path-scoped guidance from the review profile");
      expect(rule).toContain("For files matching `**/*.sql`: Use snake_case identifiers.");
    });

    /**
     * A second `rules[]` entry per pattern was the shape first proposed for this feature and
     * rejected — see `pathInstructionsSection`'s doc comment in `rule-file.ts`. This pins the
     * decision: any number of declared entries still produces exactly one rule for the engine.
     */
    it("still emits exactly one rules[] entry — guidance is prose inside it, not a second entry", () => {
      const file = buildRuleFile(
        profileWith({
          pathInstructions: [
            { paths: ["**/*.sql"], instructions: "First." },
            { paths: ["**/*.md"], instructions: "Second." },
          ],
        }),
      );
      expect(file.rules).toHaveLength(1);
      expect(file.rules[0]?.path).toBe("**/*");
    });

    it("renders entries in profile order, however they are declared", () => {
      const forward =
        buildRuleFile(
          profileWith({
            pathInstructions: [
              { paths: ["**/*.sql"], instructions: "First." },
              { paths: ["**/*.md"], instructions: "Second." },
            ],
          }),
        ).rules[0]?.rule ?? "";
      expect(forward.indexOf("First.")).toBeLessThan(forward.indexOf("Second."));

      const reversed =
        buildRuleFile(
          profileWith({
            pathInstructions: [
              { paths: ["**/*.md"], instructions: "Second." },
              { paths: ["**/*.sql"], instructions: "First." },
            ],
          }),
        ).rules[0]?.rule ?? "";
      expect(reversed.indexOf("Second.")).toBeLessThan(reversed.indexOf("First."));
    });

    /**
     * `base` comes from calling `buildRuleFile` itself with no instructions declared, never from a
     * hand-copied `CATCH_ALL_RULE` (private to `rule-file.ts`) — only the appended `section` below
     * is this test's own expectation, and it exists to pin exactly that append contract.
     */
    it("byte-for-byte renders a two-entry profile as one appended, delimited section", () => {
      const base = buildRuleFile(profileWith({ reviewRelevant: ["src/**/*.ts"] })).rules[0]?.rule;
      const withInstructions = buildRuleFile(
        profileWith({
          reviewRelevant: ["src/**/*.ts"],
          pathInstructions: [
            {
              paths: ["**/*.sql", "db/**"],
              instructions: "Use snake_case identifiers and avoid `SELECT *`.",
            },
            { paths: ["**/*.md"], instructions: "Prefer active voice and short paragraphs." },
          ],
        }),
      ).rules[0]?.rule;

      const section = [
        "",
        "## Path-scoped guidance from the review profile",
        "",
        "The consumer's review profile attaches guidance below to specific path patterns. Apply an",
        "entry only to files matching its patterns — it refines how you review them, not which paths",
        "are reviewed; that is decided solely by review-relevant, deletion-critical, and excluded",
        "above.",
        "",
        "- For files matching `**/*.sql`, `db/**`: Use snake_case identifiers and avoid `SELECT *`.",
        "- For files matching `**/*.md`: Prefer active voice and short paragraphs.",
      ].join("\n");

      expect(withInstructions).toBe(`${base ?? ""}${section}`);
    });
  });

  /**
   * `profileWith` above hand-shapes a `CompiledProfile` and casts past the type checker, which is
   * fast but proves nothing about `parsePathInstructions`/`compileProfile`. This block instead goes
   * through `loadReviewProfile` — the same JSON-to-`CompiledProfile` path a consumer's own profile
   * file takes — so a mismatch between how the parser shapes an entry and how the renderer reads it
   * would fail here even if it happened to agree with `profileWith`'s fixture shape.
   */
  describe("path-scoped instructions through the real parser", () => {
    const asJson = (pathInstructions?: unknown): string =>
      JSON.stringify({
        version: 1,
        reviewRelevant: ["src/**/*.ts"],
        deletionCritical: [],
        generated: [],
        excluded: [],
        benignWarnings: [],
        ...(pathInstructions === undefined ? {} : { pathInstructions }),
      });

    it("renders a path instruction declared in the profile's own JSON", () => {
      const compiled = loadReviewProfile(
        asJson([{ paths: ["**/*.sql"], instructions: "Use snake_case identifiers." }]),
      );
      const rule = buildRuleFile(compiled).rules[0]?.rule ?? "";
      expect(rule).toContain("For files matching `**/*.sql`: Use snake_case identifiers.");
    });

    it("keeps two declared entries in profile order all the way through the real parser", () => {
      const compiled = loadReviewProfile(
        asJson([
          { paths: ["**/*.sql"], instructions: "First." },
          { paths: ["**/*.md"], instructions: "Second." },
        ]),
      );
      const rule = buildRuleFile(compiled).rules[0]?.rule ?? "";
      expect(rule.indexOf("First.")).toBeLessThan(rule.indexOf("Second."));
    });

    it("an absent pathInstructions key parses and renders exactly like an empty array", () => {
      const a = buildRuleFile(loadReviewProfile(asJson())).rules[0]?.rule;
      const b = buildRuleFile(loadReviewProfile(asJson([]))).rules[0]?.rule;
      expect(a).toBe(b);
    });
  });
});

describe("serializeRuleFile", () => {
  it("round-trips to the same document", () => {
    const file = buildRuleFile(profileWith({ generated: ["**/dist/**"] }));
    expect(JSON.parse(serializeRuleFile(file))).toEqual(file);
  });
});

describe("the qualification harness path", () => {
  // Pins corpus/run.mjs's rule generation: the committed corpus profile must build through the
  // production loader. #44 broke exactly this — the harness fed raw JSON into `buildRuleFile`,
  // whose input only ever resembled a compiled profile by coincidence, and the corpus crashed at
  // startup while every product path stayed green. The corpus is priced in model tokens, so no CI
  // lane executes it; this hermetic test is what fails instead of the release-gate run.
  it("builds the committed corpus profile through the production loader", () => {
    const text = readFileSync(new URL("../../corpus/profile.json", import.meta.url), "utf8");
    const file = buildRuleFile(loadReviewProfile(text, "corpus/profile.json"));
    expect(file.rules).toHaveLength(1);
    expect(file.rules[0]?.rule).toContain("Look before you claim");
    expect(JSON.parse(serializeRuleFile(file))).toEqual(file);
  });
});
