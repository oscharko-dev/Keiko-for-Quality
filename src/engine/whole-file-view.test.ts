import { describe, expect, it } from "vitest";

import {
  buildWholeFileBlock,
  changedNewFileLines,
  deletedLineHints,
  fitsWholeFile,
  MAX_FILE_TO_DIFF_RATIO,
  MAX_REVIEW_FILE_CHARS,
  WHOLE_FILE_FLOOR_CHARS,
  renderWholeFile,
  WHOLE_FILE_PROMPT,
} from "./whole-file-view.js";

/**
 * The numbering is the contract. Every stage downstream of the engine — placement, similarity,
 * marker anchoring, the verification fallback — reads `start_line` as the absolute line in the new
 * file, so a whole-file view that numbered differently from the hunk view would silently move every
 * finding in the product. Most of what is pinned here is that one property.
 */

const FILE = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;"].join(
  "\n",
);

/** A fragment in the shape `splitFileDiffs` produces: headers, then hunk bodies. */
const DIFF = [
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  " const c = 3;",
  "-const gone = 0;",
  " const d = 4;",
].join("\n");

describe("changedNewFileLines", () => {
  it("marks exactly the added lines, at their absolute new-file numbers", () => {
    expect([...changedNewFileLines(DIFF)]).toEqual([2]);
  });

  it("does not advance the counter on a removed line — it has no new-file number", () => {
    const diff = [
      "@@ -1,4 +1,2 @@",
      " keep",
      "-drop one",
      "-drop two",
      "+added after the drops",
    ].join("\n");
    // 'keep' is line 1; both removals occupy no new line; the addition is line 2, not line 4.
    expect([...changedNewFileLines(diff)]).toEqual([2]);
  });

  /**
   * A line the change ADDED whose own text begins with `++` is written `+++` in a unified diff, and
   * a prefix test for the `+++ b/path` header would drop it. The header needs no test of its own:
   * it precedes the first `@@`, where the walker is not counting yet.
   */
  it("counts an added line whose text starts with ++", () => {
    const diff = ["+++ b/src/x.ts", "@@ -1,1 +1,2 @@", " a", "+++b"].join("\n");
    expect([...changedNewFileLines(diff)]).toEqual([2]);
  });

  it("handles several hunks, each restarting at its own header", () => {
    const diff = ["@@ -1,2 +1,2 @@", " a", "+b", "@@ -40,2 +40,2 @@", " x", "+y"].join("\n");
    expect([...changedNewFileLines(diff)]).toEqual([2, 41]);
  });

  it("finds nothing in a fragment with no hunk header", () => {
    expect([...changedNewFileLines("--- a/x\n+++ b/x\n")]).toEqual([]);
  });

  /**
   * `\ No newline at end of file` annotates the line above it and occupies no line of its own.
   * Before this it fell through the walker's chain, leaving the counter un-advanced — so every
   * marker and every anchor after it in that file shifted by one.
   */
  it("does not let a no-newline marker shift every line after it", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " a",
      "-old tail",
      "\\ No newline at end of file",
      "+new tail",
      " b",
    ].join("\n");
    // 'a' is 1; the removal takes no new line; 'new tail' is 2; 'b' is 3.
    expect([...changedNewFileLines(diff)]).toEqual([2]);
  });
});

describe("deletedLineHints", () => {
  it("carries the removed text, anchored to the line it was removed at", () => {
    expect(deletedLineHints(DIFF)).toEqual(["at 4: const gone = 0;"]);
  });

  it("is empty for a pure addition", () => {
    expect(deletedLineHints(["@@ -1,1 +1,2 @@", " a", "+b"].join("\n"))).toEqual([]);
  });
});

describe("renderWholeFile", () => {
  it("numbers every line from 1 and marks only the changed ones", () => {
    const rendered = renderWholeFile(FILE, new Set([2, 4]));
    expect(rendered.split("\n")).toEqual([
      "1 const a = 1;",
      "2+const b = 2;",
      "3 const c = 3;",
      "4+const d = 4;",
      "5 const e = 5;",
    ]);
  });

  /**
   * The marker is one character wide on both branches. A wider "changed" marker would push the code
   * of changed lines out of alignment with unchanged ones, which is the kind of thing a model reads
   * as structure.
   */
  it("keeps changed and unchanged lines the same width", () => {
    const [changed, unchanged] = renderWholeFile("x\ny", new Set([1])).split("\n");
    expect(changed?.indexOf("x")).toBe(unchanged?.indexOf("y"));
  });

  it("numbers identically to the hunk view's absolute numbering", () => {
    // The whole-file line 2 and the diff's added line 2 must be the same line.
    const changed = changedNewFileLines(DIFF);
    const line2 = renderWholeFile(FILE, changed).split("\n")[1];
    expect(line2).toBe("2+const b = 2;");
  });
});

describe("buildWholeFileBlock", () => {
  it("carries the file, the markers, and what the change removed", () => {
    const built = buildWholeFileBlock(FILE, DIFF);
    expect(built?.changedCount).toBe(1);
    expect(built?.block).toContain("<current_file>");
    expect(built?.block).toContain("2+const b = 2;");
    expect(built?.block).toContain("<removed_by_this_change>");
    expect(built?.block).toContain("at 4: const gone = 0;");
  });

  it("omits the removed block entirely when the change removed nothing", () => {
    const built = buildWholeFileBlock(FILE, ["@@ -1,1 +1,2 @@", " const a = 1;", "+x"].join("\n"));
    expect(built?.block).not.toContain("<removed_by_this_change>");
  });

  /**
   * The one refusal that matters. A file past the ceiling must fall back to hunks, never be sent
   * truncated: a partial file presented as the complete one licenses exactly the absence claims
   * this view exists to prevent — the model would "check" for a guard in text that stops early.
   */
  it("returns undefined for a file past the ceiling rather than truncating it", () => {
    const huge = "x\n".repeat(MAX_REVIEW_FILE_CHARS);
    expect(fitsWholeFile(huge, DIFF)).toBe(false);
    expect(buildWholeFileBlock(huge, DIFF)).toBeUndefined();
  });

  it("accepts a file exactly at the ceiling when the change earns it", () => {
    const atCeiling = "y".repeat(MAX_REVIEW_FILE_CHARS);
    expect(fitsWholeFile(atCeiling, "d".repeat(MAX_REVIEW_FILE_CHARS))).toBe(true);
  });
});

/**
 * The ratio rule, and the measurement it comes from. Sending every file whole on Keiko#3011 cost
 * 296,123 tokens against 203,691 — the worst single trade in that run was a 68,791-character test
 * file carrying a 627-character change, 110 characters of file per character of diff.
 */
describe("fitsWholeFile — what a change has to earn", () => {
  const big = "x".repeat(60_000);

  it("refuses a large file whose change is tiny", () => {
    // 60,000 / 627 ≈ 96 — far past the ratio, well under the absolute ceiling.
    expect(fitsWholeFile(big, "d".repeat(627))).toBe(false);
  });

  it("accepts the same file when the change is substantial", () => {
    expect(fitsWholeFile(big, "d".repeat(6_000))).toBe(true);
  });

  /**
   * The raw-size gate is an estimate of the block; this is the block. Numbering adds six or more
   * characters per line, so a file of very short lines passes the raw ceiling and renders far past
   * it — and one deleted minified line carries an arbitrary payload that `MAX_DELETED_HINTS` does
   * not bound, since that limits the COUNT of hints and not their length.
   */
  it("falls back when the RENDERED block outgrows the ceiling, not just the raw file", () => {
    // 30,000 two-character lines: 60,000 raw characters, under the ceiling, but each renders to
    // roughly eight, so the block lands far above it.
    const shortLines = "x\n".repeat(30_000);
    expect(fitsWholeFile(shortLines, "d".repeat(30_000))).toBe(true);
    expect(buildWholeFileBlock(shortLines, "@@ -1,1 +1,1 @@\n+x")).toBeUndefined();
  });

  it("accepts a small file however small its change — the floor overrides the ratio", () => {
    const small = "x".repeat(WHOLE_FILE_FLOOR_CHARS);
    expect(fitsWholeFile(small, "d")).toBe(true);
  });

  it("refuses rather than dividing by an empty diff", () => {
    expect(fitsWholeFile(big, "")).toBe(false);
  });

  it("holds the ratio boundary exactly", () => {
    const diff = "d".repeat(5_000);
    expect(fitsWholeFile("x".repeat(5_000 * MAX_FILE_TO_DIFF_RATIO), diff)).toBe(true);
    expect(fitsWholeFile("x".repeat(5_000 * MAX_FILE_TO_DIFF_RATIO + 1), diff)).toBe(false);
  });
});

describe("WHOLE_FILE_PROMPT", () => {
  /**
   * Two instructions carry the whole behavioural difference of this view, and losing either one
   * turns it into a different product: without the scope rule the reviewer audits the file instead
   * of the change, and without the permission rule it keeps hedging the absence claims that seeing
   * the file was supposed to make checkable.
   */
  it("states the scope boundary and the search obligation", () => {
    expect(WHOLE_FILE_PROMPT).toContain("SCOPE");
    expect(WHOLE_FILE_PROMPT).toContain("NOT a finding");
    expect(WHOLE_FILE_PROMPT).toContain("SEARCH THE FILE ABOVE");
  });

  it("still forbids claims about code outside this file", () => {
    expect(WHOLE_FILE_PROMPT).toContain("NOT in this file remains forbidden");
  });
});
