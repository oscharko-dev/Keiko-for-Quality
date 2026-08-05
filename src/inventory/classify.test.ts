import { describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import { blobId, repoPath } from "../core/brands.js";
import {
  MODE_ABSENT,
  MODE_EXECUTABLE,
  MODE_REGULAR,
  MODE_SUBMODULE,
  MODE_SYMLINK,
  type RawChange,
} from "../git/plumbing.js";
import { classify, toItem } from "./classify.js";

const PROFILE: ReviewProfile = {
  version: 1,
  reviewRelevant: ["src/**/*.ts", "scripts/**", ".github/workflows/**"],
  deletionCritical: ["tests/**", "docs/adr/**"],
  generated: ["dist/**"],
  excluded: [{ pattern: "vendor/**", reason: "third-party source, reviewed upstream" }],
  benignWarnings: [],
  pathInstructions: [],
};

const compiled = compileProfile(PROFILE);

// Distinct by default, as an ordinary content-changing modification would be. A test exercising
// the pure-rename downgrade overrides both to the same value explicitly.
const OLD_BLOB = blobId("a".repeat(40));
const NEW_BLOB = blobId("b".repeat(40));

function change(overrides: Omit<Partial<RawChange>, "path"> & { path: string }): RawChange {
  return {
    status: "M",
    oldMode: MODE_REGULAR,
    newMode: MODE_REGULAR,
    oldBlob: OLD_BLOB,
    newBlob: NEW_BLOB,
    binary: false,
    changedLines: 0,
    ...overrides,
    path: repoPath(overrides.path),
  };
}

describe("classify", () => {
  it("reviews a changed relevant path", () => {
    expect(classify(compiled, change({ path: "src/a.ts" }))).toEqual({ kind: "reviewed" });
  });

  it("marks a generated path as generated rather than reviewing it", () => {
    expect(classify(compiled, change({ path: "dist/index.js" }))).toEqual({ kind: "generated" });
  });

  it("carries the consumer's justification on an excluded path", () => {
    expect(classify(compiled, change({ path: "vendor/lib.ts" }))).toEqual({
      kind: "excluded",
      reason: "third-party source, reviewed upstream",
    });
  });

  describe("a catch-all exclusion", () => {
    // A complete profile ends with a catch-all so no path is left undescribed. If exclusions won
    // over inclusions, that catch-all would silently reduce every review to nothing while still
    // reporting a clean run.
    const withCatchAll = compileProfile({
      ...PROFILE,
      excluded: [
        ...PROFILE.excluded,
        { pattern: "**/*", reason: "catch-all: nothing else is review-relevant" },
      ],
    });

    it("does not override an explicitly review-relevant path", () => {
      expect(classify(withCatchAll, change({ path: "src/a.ts" }))).toEqual({ kind: "reviewed" });
    });

    it("does not override a review-critical deletion", () => {
      const result = classify(
        withCatchAll,
        change({ path: "tests/pin.test.ts", status: "D", newMode: MODE_ABSENT }),
      );
      expect(result).toEqual({ kind: "reviewed-as-deletion" });
    });

    it("still catches a path nothing else describes", () => {
      expect(classify(withCatchAll, change({ path: "random/file.txt" }))).toEqual({
        kind: "excluded",
        reason: "catch-all: nothing else is review-relevant",
      });
    });

    it("lets a specific exclusion keep its own justification", () => {
      expect(classify(withCatchAll, change({ path: "vendor/lib.ts" }))).toEqual({
        kind: "excluded",
        reason: "third-party source, reviewed upstream",
      });
    });
  });

  it("classifies a binary change as binary", () => {
    expect(classify(compiled, change({ path: "src/logo.ts", binary: true }))).toEqual({
      kind: "binary",
    });
  });

  describe("deletions", () => {
    it("treats deleting a review-critical test as review content, not a bare deletion", () => {
      const result = classify(
        compiled,
        change({ path: "tests/regression.test.ts", status: "D", newMode: MODE_ABSENT }),
      );
      expect(result).toEqual({ kind: "reviewed-as-deletion" });
    });

    it("treats deleting a review-relevant source file as review content", () => {
      const result = classify(
        compiled,
        change({ path: "src/a.ts", status: "D", newMode: MODE_ABSENT }),
      );
      expect(result).toEqual({ kind: "reviewed-as-deletion" });
    });

    it("refuses to silently accept a deletion the profile does not describe", () => {
      const result = classify(
        compiled,
        change({ path: "random/file.txt", status: "D", newMode: MODE_ABSENT }),
      );
      expect(result).toEqual({ kind: "unclassified" });
    });
  });

  describe("structural changes are decided before profile rules", () => {
    // A retargeted symlink or a moved submodule pointer hidden inside an excluded directory is
    // exactly the placement an attacker would choose, so exclusion must not answer this question.
    it("classifies a symlink inside an excluded directory as a pointer, not as excluded", () => {
      const result = classify(compiled, change({ path: "vendor/link", newMode: MODE_SYMLINK }));
      expect(result).toEqual({ kind: "symlink-pointer", critical: false });
    });

    it("classifies a submodule pointer inside a generated directory as a pointer", () => {
      const result = classify(
        compiled,
        change({ path: "dist/sub", oldMode: MODE_SUBMODULE, newMode: MODE_SUBMODULE }),
      );
      expect(result).toEqual({ kind: "submodule-pointer", critical: false });
    });

    it("marks a symlink over a review-relevant path as critical", () => {
      const result = classify(compiled, change({ path: "src/a.ts", newMode: MODE_SYMLINK }));
      expect(result).toEqual({ kind: "symlink-pointer", critical: true });
    });

    // The one combination #38 found untested: `critical: true` paired specifically with
    // `submodule-pointer`, not with `symlink-pointer` (the only kind the earlier test above pins).
    // `isReviewable` (below) does not honor this flag the way it honors a critical symlink's — a
    // gitlink SHA is not a blob this repository's object store holds — but the classification
    // itself must still report the fact accurately for `criticalPointerCount` (inventory.ts) to
    // read downstream.
    it("marks a submodule pointer over a deletion-critical path as critical", () => {
      const result = classify(
        compiled,
        change({ path: "tests/vendor", oldMode: MODE_SUBMODULE, newMode: MODE_SUBMODULE }),
      );
      expect(result).toEqual({ kind: "submodule-pointer", critical: true });
    });
  });

  describe("mechanically-clean: the pure-rename downgrade", () => {
    function rename(overrides: Omit<Partial<RawChange>, "path"> & { path: string }): RawChange {
      return change({
        status: "R",
        oldPath: repoPath("src/old.ts"),
        oldBlob: OLD_BLOB,
        newBlob: OLD_BLOB,
        ...overrides,
      });
    }

    it("downgrades a byte-identical rename with no mode change", () => {
      const result = classify(compiled, rename({ path: "src/new.ts" }));
      expect(result).toEqual({ kind: "mechanically-clean", reason: "pure-rename" });
    });

    it("falls through to full review when the rename also edits content", () => {
      const result = classify(compiled, rename({ path: "src/new.ts", newBlob: NEW_BLOB }));
      expect(result).toEqual({ kind: "reviewed" });
    });

    it("falls through to full review when the rename also flips the exec bit", () => {
      const result = classify(
        compiled,
        rename({ path: "src/new.ts", oldMode: MODE_REGULAR, newMode: MODE_EXECUTABLE }),
      );
      expect(result).toEqual({ kind: "reviewed" });
    });

    it("never downgrades a generated path, even a byte-identical rename of one", () => {
      const result = classify(compiled, rename({ path: "dist/new.js" }));
      expect(result).toEqual({ kind: "generated" });
    });

    it("never downgrades an excluded path, even a byte-identical rename of one", () => {
      const result = classify(compiled, rename({ path: "vendor/new.ts" }));
      expect(result).toEqual({
        kind: "excluded",
        reason: "third-party source, reviewed upstream",
      });
    });

    it("never downgrades a binary rename", () => {
      const result = classify(compiled, rename({ path: "src/logo.ts", binary: true }));
      expect(result).toEqual({ kind: "binary" });
    });

    it("never downgrades an unclassified rename", () => {
      const result = classify(compiled, rename({ path: "random/new.txt" }));
      expect(result).toEqual({ kind: "unclassified" });
    });

    // Deletions never carry a rename status in git's own model, so this pins that the deletion
    // branch of `classifyContent` is reached first and the downgrade never has a chance to run.
    it("never downgrades a review-critical deletion", () => {
      const result = classify(
        compiled,
        change({ path: "tests/pin.test.ts", status: "D", newMode: MODE_ABSENT }),
      );
      expect(result).toEqual({ kind: "reviewed-as-deletion" });
    });

    it("requires no engine coverage once downgraded", () => {
      const built = toItem(compiled, rename({ path: "src/new.ts" }));
      expect(built.classification).toEqual({ kind: "mechanically-clean", reason: "pure-rename" });
      expect(built.reviewable).toBe(false);
    });
  });
});

describe("toItem", () => {
  it("flags a mode change even when the content is unchanged", () => {
    const item = toItem(
      compiled,
      change({ path: "scripts/run.sh", oldMode: MODE_REGULAR, newMode: MODE_EXECUTABLE }),
    );
    expect(item.modeChanged).toBe(true);
    expect(item.reviewable).toBe(true);
  });

  it("does not report a mode change for an addition", () => {
    const item = toItem(
      compiled,
      change({ path: "src/new.ts", status: "A", oldMode: MODE_ABSENT }),
    );
    expect(item.modeChanged).toBe(false);
  });

  it("preserves the old path of a rename", () => {
    const item = toItem(compiled, {
      ...change({ path: "src/new.ts", status: "R" }),
      oldPath: repoPath("src/old.ts"),
    });
    expect(item.oldPath).toBe("src/old.ts");
  });

  it("does not require engine coverage for a submodule pointer", () => {
    // A gitlink has no blob to review; demanding coverage would report every bump as incomplete.
    const item = toItem(
      compiled,
      change({ path: "src/sub", oldMode: MODE_SUBMODULE, newMode: MODE_SUBMODULE }),
    );
    expect(item.reviewable).toBe(false);
  });

  // The companion to the test above, pinning the direction #37/#38 found untested: `critical`
  // stays `true` — the classification itself is unchanged — but `reviewable` stays `false`
  // regardless, unlike a critical symlink-pointer's identical-looking flag. A gitlink SHA is not a
  // blob this repository's object store holds, so making this `reviewable` the way `isReviewable`
  // already does for `symlink-pointer` would be architecturally wrong, not a fix — the signal
  // belongs in `criticalPointerCount` (inventory.ts) instead. Written out so a future change to
  // `isReviewable` cannot silently start requiring engine coverage of an unreadable gitlink
  // without a red test.
  it("still does not require engine coverage for a CRITICAL submodule pointer", () => {
    const item = toItem(
      compiled,
      change({ path: "tests/vendor", oldMode: MODE_SUBMODULE, newMode: MODE_SUBMODULE }),
    );
    expect(item.classification).toEqual({ kind: "submodule-pointer", critical: true });
    expect(item.reviewable).toBe(false);
  });

  it("requires engine coverage for a critical symlink change", () => {
    const item = toItem(compiled, change({ path: "src/a.ts", newMode: MODE_SYMLINK }));
    expect(item.reviewable).toBe(true);
  });

  /**
   * The review-cache key (v0.9.0) is computed from exactly these two fields. `RawChange` always
   * carries both — the all-zero id stands in for "no blob" on an addition — so `toItem` can copy
   * them through unconditionally rather than guessing which statuses have one.
   */
  describe("base and head blob", () => {
    it("carries the change's own blob ids onto the item, unchanged", () => {
      const item = toItem(compiled, change({ path: "src/a.ts" }));
      expect(item.baseBlob).toBe(OLD_BLOB);
      expect(item.headBlob).toBe(NEW_BLOB);
    });

    it("carries the all-zero base blob through for an addition", () => {
      const item = toItem(
        compiled,
        change({
          path: "src/new.ts",
          status: "A",
          oldMode: MODE_ABSENT,
          oldBlob: blobId("0".repeat(40)),
        }),
      );
      expect(item.baseBlob).toBe("0".repeat(40));
      expect(item.headBlob).toBe(NEW_BLOB);
    });
  });
});
