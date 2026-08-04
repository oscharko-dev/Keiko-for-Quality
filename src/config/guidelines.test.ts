import { describe, expect, it } from "vitest";

import { ValidationError } from "../core/brands.js";
import { parseGuidelinePaths } from "./guidelines.js";

/**
 * `MAX_DOCUMENTS` is module-private, and restating it here rather than exporting it for a test is
 * deliberate: a test that imports the constant follows it wherever it goes and can never pin the
 * boundary. Written out, moving the cap fails the two cases below and has to be done on purpose.
 */
const MAX_DOCUMENTS = 8;

/** `count` well-formed repository-relative paths, in the newline form both entry points hand over. */
function documents(count: number): string {
  return Array.from({ length: count }, (_, i) => `docs/rule-${String(i + 1)}.md`).join("\n");
}

/**
 * The four rejections in `parseGuidelinePaths` are the whole of the property its doc comment
 * claims — "the path cannot leave the checkout" — and that property is load-bearing rather than
 * defensive. `rule-file.ts`'s `guidanceSection` renders each path verbatim into the rule file and
 * tells the model to read it, so a path that escapes the checkout is a file outside the repository
 * handed to the engine, named by whichever input reached the parser.
 *
 * Three of those four could be deleted with the whole suite still green before this file existed:
 * only the `..`-segment check was reachable from any test, and only end to end, through
 * `cli.test.ts`'s "exits 4 when the guidelines list is malformed". CONTRIBUTING.md's "A test must
 * be able to fail" is written for exactly this case — a test that guards a security property
 * proves nothing until breaking the property has been seen to turn it red.
 *
 * So each rejecting case below is chosen so that exactly one source line can catch it, and every
 * case names the line it pins. `/etc/shadow` has no `..` segment; the backslash cases contain no
 * `/` at all, so the split-based check is blind to them (the reason `profile.ts`'s
 * `parseCounterpartPaths` cites this function for the same idiom); and the traversal cases are
 * neither absolute nor backslashed. Deleting one line reds that line's cases and no others.
 */
describe("parseGuidelinePaths", () => {
  describe("what it accepts", () => {
    it("splits on newlines and commas alike, trimming entries and dropping empty ones", () => {
      expect(parseGuidelinePaths(" AGENTS.md ,\n docs/qa/review-rules.md \n").paths).toEqual([
        "AGENTS.md",
        "docs/qa/review-rules.md",
      ]);
    });

    // Both entry points reach this function with the empty string when nothing is configured —
    // `cli.ts:246` defaults the flag to `""`, and `readInput` (action/inputs.ts:19) returns `""`
    // for an absent input — and `corpus/real-diffs.mjs:223` builds its `NO_GUIDELINES` this way on
    // purpose, through the real parser rather than a hand-built literal. An empty index is the
    // ordinary case, not a malformed one.
    it("treats an empty input as an empty index rather than a malformed one", () => {
      expect(parseGuidelinePaths("").paths).toEqual([]);
    });

    // The accepting half of the cap, and the only case that can catch an off-by-one in it. The
    // rejection below stays green if `>` becomes `>=`, which would quietly move the real limit to
    // seven without any input ever being rejected that should have been accepted elsewhere.
    it(`accepts exactly ${String(MAX_DOCUMENTS)} paths — the cap is a maximum, not one below it`, () => {
      expect(parseGuidelinePaths(documents(MAX_DOCUMENTS)).paths).toHaveLength(MAX_DOCUMENTS);
    });
  });

  describe("what it rejects, so a named path cannot leave the checkout", () => {
    // guidelines.ts:41. Its own comment gives the reason: a governance section is a claim about
    // where the rules live, and an unbounded list turns it into a directory listing.
    it(`rejects more than ${String(MAX_DOCUMENTS)} paths`, () => {
      expect(() => parseGuidelinePaths(documents(MAX_DOCUMENTS + 1))).toThrow(ValidationError);
    });

    // guidelines.ts:43, first half. `"/etc/shadow".split("/")` contains no `..` segment, so the
    // check on the line below cannot catch this one: delete line 43 and this case is what reds.
    //
    // The `field` assertion rides along here rather than in a case of its own because
    // `ValidationError` withholds the offending value from its message on purpose
    // (brands.ts:55-57) — the field name is the whole of what an operator has to act on, so it is
    // worth pinning wherever a rejection is already being asserted.
    it("rejects an absolute path, naming the default field", () => {
      try {
        parseGuidelinePaths("/etc/shadow");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).field).toBe("guidelines");
      }
    });

    // guidelines.ts:43, second half — and the reason it is a check of its own rather than an
    // afterthought on the absolute-path one: neither of these contains a `/`, so `split("/")`
    // yields a single segment that is not `..` and the traversal check below sees nothing wrong.
    // A Windows separator is rejected whether or not it is carrying a traversal, which is what
    // makes the rule cheap to state and impossible to walk around.
    it("rejects a backslash, which no `/`-split can see as traversal", () => {
      expect(() => parseGuidelinePaths("..\\..\\outside-the-repo.md")).toThrow(ValidationError);
      expect(() => parseGuidelinePaths("docs\\rules.md")).toThrow(ValidationError);
    });

    // guidelines.ts:44. Neither case is absolute or backslashed, so line 43 passes both through
    // and this is the only line that can stop them. `cli.test.ts` already reaches this branch end
    // to end through `--guidelines`; this pins it at the parser, where the property is stated, so
    // the branch does not depend on one CLI test continuing to exist to stay covered.
    it("rejects a `..` segment, leading or interior", () => {
      expect(() => parseGuidelinePaths("../outside-the-repo.md")).toThrow(ValidationError);
      expect(() => parseGuidelinePaths("docs/../../outside-the-repo.md")).toThrow(ValidationError);
    });

    // No caller overrides `field` today — cli.ts:428, main.ts:309 and corpus/real-diffs.mjs:223
    // all take the default — so without this case the parameter is pinned by nothing and dropping
    // it would be invisible. Hung on the count cap rather than on a path check deliberately, so
    // that deleting either path-check line still reds only its own cases.
    it("carries a caller-supplied field name into the error", () => {
      try {
        parseGuidelinePaths(documents(MAX_DOCUMENTS + 1), "profile.guidelines");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).field).toBe("profile.guidelines");
      }
    });
  });
});
