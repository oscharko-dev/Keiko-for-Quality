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
  it("excludes everything the profile calls generated or excluded", () => {
    const file = buildRuleFile(
      profileWith({
        generated: ["**/dist/**", "**/*.min.js"],
        excluded: [{ pattern: "docs/**", reason: "prose" }],
      }),
    );
    expect(file.exclude).toEqual(["**/dist/**", "**/*.min.js", "docs/**"]);
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
});

describe("serializeRuleFile", () => {
  it("round-trips to the same document", () => {
    const file = buildRuleFile(profileWith({ generated: ["**/dist/**"] }));
    expect(JSON.parse(serializeRuleFile(file))).toEqual(file);
  });
});
