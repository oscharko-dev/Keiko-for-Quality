import { describe, expect, it } from "vitest";

import {
  buildVerifyPrompt,
  needsWholeFileEvidence,
  numberFileLines,
  parseVerdicts,
  tallyOf,
} from "./verify-claims.js";

/**
 * The selector is the load-bearing half of this module: too narrow and the false-positive class
 * the pass exists for walks through, too wide and every finding pays for a whole-file call. Both
 * directions are asserted below against real claim text from the audited window.
 */
describe("needsWholeFileEvidence", () => {
  const HUNK = ["12 +  const parsed = parseConfig(raw);", "13 +  return parsed.value;"].join("\n");

  it("selects absence claims written as the rule text's imperative", () => {
    for (const title of [
      "**Add handling for the new `imageInputModelIdsConfigured` flag on the server side.**",
      "**Ensure temporary workDir is removed when downloadAssets throws.**",
      "**Guard against undefined approvalReference before parsing.**",
      "**Reject duplicate capability IDs instead of silently overwriting them.**",
      "**Clear the pending-read flag when no file is selected.**",
      "**Validate the image input model IDs type instead of silently ignoring it.**",
    ]) {
      expect(needsWholeFileEvidence(title, HUNK)).toBe(true);
    }
  });

  // Widened against measurement: the first draft carried only the absence verbs and selected 36
  // of the window's 55 refutations. The missing 19 were all change imperatives.
  it("selects the change imperatives the first draft missed", () => {
    for (const title of [
      "**Adjust the header-name expectation to match the parser's normalization.**",
      "**Replace the use of `importMeta` with a proper directory resolution.**",
      "**Restore the original top-level coverage fields.**",
      "**Update consumers to read coverage metrics from the nested object.**",
      "**Move the definition before its first use.**",
      "**Cancel pending reads when the component unmounts.**",
    ]) {
      expect(needsWholeFileEvidence(title, HUNK)).toBe(true);
    }
  });

  it("selects prose that asserts absence outright", () => {
    expect(needsWholeFileEvidence("The parser does not reject duplicates.", HUNK)).toBe(true);
    expect(needsWholeFileEvidence("This path fails to clean up the directory.", HUNK)).toBe(true);
    expect(needsWholeFileEvidence("There is no guard for the empty case.", HUNK)).toBe(true);
  });

  it("selects a claim leaning on a symbol the model was never shown", () => {
    expect(needsWholeFileEvidence("`orphanedProfiles` is computed too late.", HUNK)).toBe(true);
  });

  // This reviewer's own finding on the change that introduced this function (#201): a substring
  // test reads `cat` as shown by `concatenate`, marking an unseen symbol as grounded.
  it("counts a symbol as shown only when the diff shows the whole identifier", () => {
    const diff = "12 +  const total = concatenate(parts);";
    expect(needsWholeFileEvidence("`cat` is never bounded.", diff)).toBe(true);
    expect(needsWholeFileEvidence("`concatenate` is never bounded.", diff)).toBe(false);
  });

  it("leaves a claim grounded in the shown hunk alone", () => {
    expect(
      needsWholeFileEvidence("`parseConfig` returns undefined here, so line 13 throws.", HUNK),
    ).toBe(false);
    expect(
      needsWholeFileEvidence("The added line dereferences a value that may be absent.", HUNK),
    ).toBe(false);
  });
});

describe("numberFileLines", () => {
  it("numbers from one so an evidence line means what the hunks mean", () => {
    expect(numberFileLines("alpha\nbeta")).toBe("1 alpha\n2 beta");
  });
});

describe("buildVerifyPrompt", () => {
  const CLAIMS = [
    { content: "**Add a guard.**", start_line: 42, end_line: 42 },
    { content: "**Reject duplicates.**", start_line: 0, end_line: 0 },
  ];

  it("carries the file, the path, and every claim with its anchor", () => {
    const prompt = buildVerifyPrompt("src/a.ts", "1 alpha", CLAIMS);
    expect(prompt).toContain('<file path="src/a.ts">');
    expect(prompt).toContain("1 alpha");
    expect(prompt).toContain("claim 1 (anchored at line 42):");
    expect(prompt).toContain("claim 2 (file level):");
    expect(prompt).toContain("**Reject duplicates.**");
  });
});

describe("parseVerdicts", () => {
  it("reads a well-formed verdict array", () => {
    const verdicts = parseVerdicts('[{"claim":1,"verdict":"contradicted","line":655}]', 2);
    expect(verdicts).toEqual([{ claim: 1, contradicted: true, line: 655 }]);
  });

  it("treats anything but `contradicted` as leaving the claim standing", () => {
    const verdicts = parseVerdicts('[{"claim":1,"verdict":"supported"}]', 1);
    expect(verdicts?.[0]?.contradicted).toBe(false);
  });

  // Reject rather than repair, exactly as the findings parser does: a shape this cannot read
  // must reach the caller as "no answer", which publishes every claim.
  it("returns undefined for a reply that is not a JSON array", () => {
    expect(parseVerdicts("not json", 1)).toBeUndefined();
    expect(parseVerdicts('{"claim":1}', 1)).toBeUndefined();
  });

  it("drops entries outside the asked range rather than mapping them onto a neighbour", () => {
    expect(
      parseVerdicts('[{"claim":9,"verdict":"contradicted"},{"claim":0,"verdict":"x"}]', 2),
    ).toEqual([]);
  });

  it("ignores malformed entries without discarding the sound ones", () => {
    const verdicts = parseVerdicts(
      '[null, 7, {"verdict":"contradicted"}, {"claim":"1","verdict":"contradicted"}, {"claim":2,"verdict":"contradicted"}]',
      2,
    );
    expect(verdicts).toEqual([{ claim: 2, contradicted: true, line: undefined }]);
  });
});

describe("tallyOf", () => {
  it("counts what was asked even when nothing was answered", () => {
    expect(tallyOf(undefined, 3)).toEqual({ asked: 3, dropped: 0 });
  });

  it("counts only contradicted claims as dropped", () => {
    const verdicts = [
      { claim: 1, contradicted: true, line: 5 },
      { claim: 2, contradicted: false, line: undefined },
    ];
    expect(tallyOf(verdicts, 2)).toEqual({ asked: 2, dropped: 1 });
  });
});
