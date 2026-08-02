import { describe, expect, it } from "vitest";

import { buildRuleFile, serializeRuleFile } from "./rule-file.js";
import { sanitizeFindingBody } from "../publish/sanitize.js";

/** Only the fields `buildRuleFile` reads. The rest of a compiled profile is irrelevant here. */
function profileWith(overrides: {
  reviewRelevant?: string[];
  generated?: string[];
  excluded?: { pattern: string; reason: string }[];
}): Parameters<typeof buildRuleFile>[0] {
  return {
    profile: {
      version: 1,
      reviewRelevant: overrides.reviewRelevant ?? ["src/**/*.ts"],
      deletionCritical: [],
      generated: overrides.generated ?? [],
      excluded: overrides.excluded ?? [],
      benignWarnings: [],
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
});

describe("serializeRuleFile", () => {
  it("round-trips to the same document", () => {
    const file = buildRuleFile(profileWith({ generated: ["**/dist/**"] }));
    expect(JSON.parse(serializeRuleFile(file))).toEqual(file);
  });
});
