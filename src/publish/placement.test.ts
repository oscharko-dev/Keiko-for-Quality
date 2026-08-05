import { describe, expect, it } from "vitest";

import { commitSha, repoPath } from "../core/brands.js";
import type { InventoryItem } from "../inventory/classify.js";
import type { EngineFinding } from "../engine/result.js";
import { describePlacement, placementLadder, tallyPlacementAttempts } from "./placement.js";

/**
 * `placementLadder` decides, before a single API call, which anchors are even worth attempting —
 * every rung past the first costs a real rejected `createReviewComment` round trip when it cannot
 * succeed (Keiko-for-Quality's own placement cost). These pin the two shapes that can never succeed
 * on ANY line-level rung (a deletion, an unknown path) and the one that can never succeed on the
 * LEFT rung specifically (an added file, which has no pre-image at all).
 */

const HEAD = commitSha("a".repeat(40));

function finding(overrides: Partial<EngineFinding> = {}): EngineFinding {
  return {
    path: repoPath("src/a.ts"),
    content: "Close the handle.",
    startLine: 10,
    endLine: 12,
    severity: "high",
    category: "bug",
    ...overrides,
  };
}

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    path: repoPath("src/a.ts"),
    status: "M",
    classification: { kind: "reviewed" },
    modeChanged: false,
    reviewable: true,
    changedLines: 5,
    ...overrides,
  };
}

describe("placementLadder", () => {
  it("tries RIGHT, then LEFT, then file-level for an ordinary modified file", () => {
    const ladder = placementLadder(finding(), item(), HEAD);
    expect(ladder.map(describePlacement)).toEqual(["line", "deletion", "file"]);
  });

  it("goes straight to file-level for a deleted file — no line-level rung can ever succeed", () => {
    const ladder = placementLadder(finding(), item({ status: "D" }), HEAD);
    expect(ladder.map(describePlacement)).toEqual(["file"]);
  });

  it("goes straight to file-level for a file classified as reviewed-as-deletion", () => {
    const ladder = placementLadder(
      finding(),
      item({ classification: { kind: "reviewed-as-deletion" } }),
      HEAD,
    );
    expect(ladder.map(describePlacement)).toEqual(["file"]);
  });

  /**
   * An unknown path (`item === undefined`) was never part of the diff at all, the same "nothing
   * here can ever anchor" shape as a deletion — GitHub has no line to accept a comment against
   * either way, so paying for the LEFT and RIGHT rungs is pure guaranteed-422 cost.
   */
  it("goes straight to file-level when the finding's path is not in the inventory at all", () => {
    const ladder = placementLadder(finding(), undefined, HEAD);
    expect(ladder.map(describePlacement)).toEqual(["file"]);
  });

  /**
   * An added file has no pre-image — the LEFT (deletion-side) rung is a guaranteed 422 for every
   * finding on one, not an occasional miss, since GitHub has no left-hand diff to anchor it to.
   */
  it("skips the LEFT rung for an added file — RIGHT then file-level only", () => {
    const ladder = placementLadder(finding(), item({ status: "A" }), HEAD);
    expect(ladder.map(describePlacement)).toEqual(["line", "file"]);
  });

  it("still tries LEFT for a renamed file with real content edits — it has a pre-image", () => {
    const ladder = placementLadder(finding(), item({ status: "R" }), HEAD);
    expect(ladder.map(describePlacement)).toEqual(["line", "deletion", "file"]);
  });

  it("goes straight to file-level when the finding carries no usable line at all", () => {
    const ladder = placementLadder(finding({ startLine: 0, endLine: 0 }), item(), HEAD);
    expect(ladder.map(describePlacement)).toEqual(["file"]);
  });
});

describe("tallyPlacementAttempts", () => {
  it("counts every rung's own kind, including the trailing file-level retry", () => {
    const ladder = placementLadder(finding(), item(), HEAD);
    expect(tallyPlacementAttempts(ladder)).toStrictEqual({ line: 1, deletion: 1, file: 1 });
  });

  it("counts only what the narrowed added-file ladder actually contains", () => {
    const ladder = placementLadder(finding(), item({ status: "A" }), HEAD);
    expect(tallyPlacementAttempts(ladder)).toStrictEqual({ line: 1, file: 1 });
  });
});
