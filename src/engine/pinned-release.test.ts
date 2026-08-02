import { describe, expect, it } from "vitest";

import { ENGINE_PIN, currentPlatformDigest, platformKey } from "./pinned-release.js";

describe("currentPlatformDigest", () => {
  it("returns the pinned digest for a supported platform, read from the pin itself", () => {
    // Derived from `ENGINE_PIN` rather than a hand-copied hash, so a future pin bump cannot leave
    // this test silently checking a stale digest.
    const expected = ENGINE_PIN.platforms[platformKey("linux", "x64")]?.sha256;
    expect(expected).toBeDefined();
    expect(currentPlatformDigest(ENGINE_PIN, "linux", "x64")).toBe(expected);
  });

  it("returns a different digest for a different platform of the same pin", () => {
    const linux = currentPlatformDigest(ENGINE_PIN, "linux", "arm64");
    const darwin = currentPlatformDigest(ENGINE_PIN, "darwin", "arm64");
    expect(linux).not.toBe(darwin);
  });

  it("returns undefined on a platform this pin does not cover", () => {
    expect(currentPlatformDigest(ENGINE_PIN, "win32", "x64")).toBeUndefined();
  });

  it("defaults to the process's own platform and arch when none are supplied", () => {
    expect(currentPlatformDigest()).toBe(
      currentPlatformDigest(ENGINE_PIN, process.platform, process.arch),
    );
  });
});
