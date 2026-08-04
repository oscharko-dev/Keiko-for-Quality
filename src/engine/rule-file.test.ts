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
  contractPairs?: { paths: string[]; counterparts: string[]; contract?: string }[];
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
      // Omitted entirely, not defaulted to `[]`, when the caller passes nothing: unlike
      // `pathInstructions`, `contractPairs` is optional on `ReviewProfile` itself, so a profile
      // that never heard of this field reaches `buildRuleFile` with the key genuinely absent —
      // exercising its `?? []` fallback rather than only ever exercising an explicit empty array.
      ...(overrides.contractPairs === undefined ? {} : { contractPairs: overrides.contractPairs }),
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

  it("applies its guidance to every path, and only its guidance", () => {
    const file = buildRuleFile(profileWith({}));
    expect(file.rules).toHaveLength(1);
    expect(file.rules[0]?.path).toBe("**/*");
    // Regression pin (2026-08-03): with the system-rule merge on, the engine appended its
    // unversioned per-language checklist after this rule, and its yaml entry ("First-party
    // (`actions/*`) pinned to `v4` is acceptable") directly contradicted the supply-chain
    // section — models followed the checklist and the loosened-pin corpus case went unreported.
    // The prompt the model reviews under is exactly the one the rule digest hashes.
    expect(file.rules[0]?.merge_system_rule).toBe(false);
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
   * Windows — and the finding was discarded, because a bare `<path>` matches the HTML check. Code-
   * region masking has since made the backticked form publishable, so the rule and this round-trip
   * changed together: bare placeholders still die, backticked ones survive, and the rule must say
   * exactly that. This pins both halves so they cannot drift apart again.
   */
  /**
   * The rule taught the exact shape another of its own rules forbids: it asked for a
   * `Source: <path>` line while stating that bare angle brackets destroy the finding. In
   * qualification the model obeyed the citation rule and filled the placeholder with the only
   * "path" it could see — the name of a section of its own instructions — producing
   * `Source: <current_file_diff>`, which the sanitizer rejected as html. A correct high-severity
   * finding was lost to a contradiction between two rules, so no example in this file may show a
   * `Source:` line with an angle bracket.
   */
  /**
   * Two qualification failures, one shape. A finding lost its whole body to a `Source:` line
   * carrying an angle-bracketed prompt marker, and another to an exfiltration beacon appended
   * after the closing diff fence — the injection the case seeds. Both were correct findings
   * discarded because of the line AFTER the body proper, so the rule names the three endings a
   * body may have and asks for a final re-read.
   */
  it("bounds how a finding body may end", () => {
    const rule = buildRuleFile(profileWith({})).rules[0]?.rule ?? "";
    expect(rule).toContain("The most common way this succeeds is a trailing line");
    expect(rule).toContain("Nothing follows");
  });

  it("never teaches an angle-bracketed Source line", () => {
    const rule = buildRuleFile(profileWith({})).rules[0]?.rule ?? "";
    expect(rule).toContain("Source:");
    expect(rule).not.toMatch(/Source:\s*`?</);
    // And the citation instruction must bound what may be named, not leave it open.
    expect(rule).toContain("NEVER in angle brackets");
  });

  it("keeps the placeholder guidance aligned with the real sanitizer", () => {
    const rule = buildRuleFile(profileWith({})).rules[0]?.rule ?? "";
    expect(rule).toContain("Never write a bare placeholder in angle brackets");
    // Round-trip through the REAL sanitizer, both directions: the backticked placeholder from the
    // original incident now publishes (code spans are masked before the markup checks), while the
    // same body with the backticks stripped still dies as html.
    expect(
      sanitizeFindingBody("Use a null device.\n\nIt runs `diff -- /dev/null <path>` today.").ok,
    ).toBe(true);
    expect(
      sanitizeFindingBody("Use a null device.\n\nIt runs diff -- /dev/null <path> today."),
    ).toEqual({
      ok: false,
      reason: "html",
    });
    // A comparison must remain writable — `<` followed by a space is not a tag.
    expect(
      sanitizeFindingBody("Fix the bound.\n\nThe guard `i < items.length` became `i <= n`.").ok,
    ).toBe(true);
    // The Source line, in the exact shape the rule prescribes after its consolidation: a
    // backticked path publishes, the angle-bracketed anti-shape the parenthetical forbids dies as
    // html. This is the one prescribed output form no earlier example carried through the real
    // sanitizer.
    expect(
      sanitizeFindingBody(
        "Cite the rule.\n\nThe guideline names this exact case.\n\nSource: `AGENTS.md`",
      ).ok,
    ).toBe(true);
    expect(
      sanitizeFindingBody(
        "Cite the rule.\n\nThe guideline names this exact case.\n\nSource: <AGENTS.md>",
      ),
    ).toEqual({ ok: false, reason: "html" });
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

  /**
   * Issue #80, technique B: a declared contract pair (`profile.contractPairs`) tells the model,
   * in prose, to read a counterpart file alongside a matching one — the only reader a pairing
   * richer than a flat same-named-interface diff has (see `contractPairsSection`'s own doc
   * comment in `rule-file.ts` for the deterministic gate that covers the flat case instead).
   */
  describe("declared contract pairs", () => {
    it("renders no section, and changes nothing, when the profile declares none", () => {
      const withoutField = buildRuleFile(profileWith({}));
      const withEmptyArray = buildRuleFile(profileWith({ contractPairs: [] }));
      expect(withEmptyArray.rules[0]?.rule).toBe(withoutField.rules[0]?.rule);
      expect(withoutField.rules[0]?.rule).not.toContain("Declared contract pairs");
    });

    it("renders a delimited section naming the glob, the counterpart, and the contract note", () => {
      const rule =
        buildRuleFile(
          profileWith({
            contractPairs: [
              {
                paths: ["src/server/routes/*.ts"],
                counterparts: ["src/client/types.ts"],
                contract: "response shape must match",
              },
            ],
          }),
        ).rules[0]?.rule ?? "";
      expect(rule).toContain("## Declared contract pairs from the review profile");
      expect(rule).toContain(
        "- When a file matching `src/server/routes/*.ts` changes: read `src/client/types.ts` in " +
          "the same tree and verify the declared contract still holds — response shape must " +
          "match. A break that spans the two files is a real finding even though the counterpart " +
          "is not in the diff; anchor it on the changed file.",
      );
    });

    it("omits the note clause entirely when the entry declares no contract note", () => {
      const rule =
        buildRuleFile(
          profileWith({
            contractPairs: [{ paths: ["src/a.ts"], counterparts: ["src/b.ts"] }],
          }),
        ).rules[0]?.rule ?? "";
      expect(rule).toContain(
        "- When a file matching `src/a.ts` changes: read `src/b.ts` in the same tree and verify " +
          "the declared contract still holds. A break that spans the two files is a real finding " +
          "even though the counterpart is not in the diff; anchor it on the changed file.",
      );
      expect(rule).not.toContain("holds —");
    });

    it("joins multiple globs and multiple counterparts with a comma, each backticked", () => {
      const rule =
        buildRuleFile(
          profileWith({
            contractPairs: [
              {
                paths: ["src/server/**/*.ts", "src/shared/**/*.ts"],
                counterparts: ["src/client/a.ts", "src/client/b.ts"],
              },
            ],
          }),
        ).rules[0]?.rule ?? "";
      expect(rule).toContain(
        "When a file matching `src/server/**/*.ts`, `src/shared/**/*.ts` changes: read " +
          "`src/client/a.ts`, `src/client/b.ts` in the same tree",
      );
    });

    it("renders entries in profile order, however they are declared", () => {
      const forward =
        buildRuleFile(
          profileWith({
            contractPairs: [
              { paths: ["src/a.ts"], counterparts: ["src/b.ts"] },
              { paths: ["src/c.ts"], counterparts: ["src/d.ts"] },
            ],
          }),
        ).rules[0]?.rule ?? "";
      expect(forward.indexOf("src/a.ts")).toBeLessThan(forward.indexOf("src/c.ts"));

      const reversed =
        buildRuleFile(
          profileWith({
            contractPairs: [
              { paths: ["src/c.ts"], counterparts: ["src/d.ts"] },
              { paths: ["src/a.ts"], counterparts: ["src/b.ts"] },
            ],
          }),
        ).rules[0]?.rule ?? "";
      expect(reversed.indexOf("src/c.ts")).toBeLessThan(reversed.indexOf("src/a.ts"));
    });

    /**
     * `base` comes from calling `buildRuleFile` itself with nothing declared beyond
     * `reviewRelevant`, never from a hand-copied section string — only the appended `section`
     * below is this test's own expectation, and it exists to pin exactly that append contract:
     * the new section is byte-for-byte appended after everything `buildRuleFile` already rendered,
     * never interleaved or reordered.
     */
    it("byte-for-byte appends the section after the rest of the rule", () => {
      const base = buildRuleFile(profileWith({ reviewRelevant: ["src/**/*.ts"] })).rules[0]?.rule;
      const withPairs = buildRuleFile(
        profileWith({
          reviewRelevant: ["src/**/*.ts"],
          contractPairs: [{ paths: ["src/a.ts"], counterparts: ["src/b.ts"], contract: "shape" }],
        }),
      ).rules[0]?.rule;

      const section = [
        "",
        "## Declared contract pairs from the review profile",
        "",
        "The consumer's review profile declares the pairs below: two files whose contract cannot be",
        "verified by reading only one of them.",
        "",
        "- When a file matching `src/a.ts` changes: read `src/b.ts` in the same tree and verify " +
          "the declared contract still holds — shape. A break that spans the two files is a real " +
          "finding even though the counterpart is not in the diff; anchor it on the changed file.",
      ].join("\n");

      expect(withPairs).toBe(`${base ?? ""}${section}`);
    });

    /**
     * `base` here already carries a rendered path-instructions section, so this pins the mounting
     * point specifically: the contract-pairs section is appended AFTER path instructions, not
     * before and not interleaved with it — mirroring the order `buildRuleFile` composes them in.
     */
    it("appends after an already-rendered path-instructions section, not before it", () => {
      const withInstructionsOnly = buildRuleFile(
        profileWith({
          pathInstructions: [{ paths: ["**/*.sql"], instructions: "Use snake_case." }],
        }),
      ).rules[0]?.rule;
      const withBoth = buildRuleFile(
        profileWith({
          pathInstructions: [{ paths: ["**/*.sql"], instructions: "Use snake_case." }],
          contractPairs: [{ paths: ["src/a.ts"], counterparts: ["src/b.ts"] }],
        }),
      ).rules[0]?.rule;

      expect(withBoth).toContain(withInstructionsOnly ?? "");
      expect(withBoth?.indexOf("Path-scoped guidance")).toBeLessThan(
        withBoth?.indexOf("Declared contract pairs") ?? -1,
      );
    });

    it("asks for nothing the publisher would reject", () => {
      // The section only tells the model what to READ; it introduces no new output syntax, so the
      // existing sanitizer round-trip examples above stay the complete coverage for this rule.
      const rule =
        buildRuleFile(
          profileWith({
            contractPairs: [{ paths: ["src/a.ts"], counterparts: ["src/b.ts"], contract: "shape" }],
          }),
        ).rules[0]?.rule ?? "";
      expect(rule).toContain("Do not emit HTML, images, links or URLs");
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
