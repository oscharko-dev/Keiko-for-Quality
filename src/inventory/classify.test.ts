import { describe, expect, it } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import { repoPath } from "../core/brands.js";
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
};

const compiled = compileProfile(PROFILE);

function change(overrides: Omit<Partial<RawChange>, "path"> & { path: string }): RawChange {
  return {
    status: "M",
    oldMode: MODE_REGULAR,
    newMode: MODE_REGULAR,
    binary: false,
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

  it("requires engine coverage for a critical symlink change", () => {
    const item = toItem(compiled, change({ path: "src/a.ts", newMode: MODE_SYMLINK }));
    expect(item.reviewable).toBe(true);
  });
});
