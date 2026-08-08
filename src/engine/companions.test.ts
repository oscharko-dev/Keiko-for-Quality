import { describe, expect, it } from "vitest";

import { companionContextDigest, companionsByPath, MAX_COMPANIONS } from "./companions.js";

describe("companionsByPath", () => {
  it("groups a version twin with its package manifest and same-stem sibling first", () => {
    const paths = [
      "packages/keiko-contracts/package.json",
      "packages/keiko-contracts/src/version.ts",
      "packages/keiko-contracts/src/version.test.ts",
      "packages/keiko-contracts/src/unrelated.ts",
      "packages/keiko-server/package.json",
      "packages/keiko-server/src/index.ts",
    ];
    const companions = companionsByPath(paths);
    const forVersion = companions.get("packages/keiko-contracts/src/version.ts") ?? [];
    // The exact false-positive class from the live audit: the version file's first companions are
    // its own package's manifest and its same-stem test — never another package's files.
    expect(forVersion[0]).toBe("packages/keiko-contracts/package.json");
    expect(forVersion).toContain("packages/keiko-contracts/src/version.test.ts");
    expect(forVersion.every((c) => !c.startsWith("packages/keiko-server/"))).toBe(true);
    expect(forVersion.length).toBeLessThanOrEqual(MAX_COMPANIONS);
  });

  it("keeps root files in the root group and never crosses into packages", () => {
    const paths = [
      "package.json",
      "release-impact.catalog.json",
      "packages/x/package.json",
      "packages/x/src/a.ts",
    ];
    const companions = companionsByPath(paths);
    expect(companions.get("release-impact.catalog.json")).toEqual(["package.json"]);
    expect(companions.get("packages/x/src/a.ts")).toEqual(["packages/x/package.json"]);
  });

  it("gives lockfiles no companions and lets no file adopt one", () => {
    const paths = ["package.json", "package-lock.json", "yarn.lock", "src/a.ts"];
    const companions = companionsByPath(paths);
    expect(companions.get("package-lock.json")).toEqual([]);
    for (const [, group] of companions) {
      expect(group).not.toContain("package-lock.json");
      expect(group).not.toContain("yarn.lock");
    }
  });
});

describe("companionContextDigest", () => {
  const blobOf = (path: string): string | undefined =>
    ({ "a.ts": "blobA>headA", "b.ts": "blobB>headB" })[path];

  it("is order-independent and blob-sensitive", () => {
    const forward = companionContextDigest(["a.ts", "b.ts"], blobOf);
    const reversed = companionContextDigest(["b.ts", "a.ts"], blobOf);
    expect(forward).toBe(reversed);
    const moved = companionContextDigest(["a.ts", "b.ts"], (p) =>
      p === "a.ts" ? "blobA>headA2" : blobOf(p),
    );
    expect(moved).not.toBe(forward);
  });

  it("hashes the empty set to a stable value distinct from any non-empty set", () => {
    expect(companionContextDigest([], blobOf)).toBe(companionContextDigest([], blobOf));
    expect(companionContextDigest([], blobOf)).not.toBe(companionContextDigest(["a.ts"], blobOf));
  });
});
