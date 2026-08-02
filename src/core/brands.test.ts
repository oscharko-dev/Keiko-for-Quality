import { describe, expect, it } from "vitest";

import {
  ValidationError,
  commitSha,
  hasControlCharacters,
  repoPath,
  sha256,
  versionTag,
} from "./brands.js";

const ch = (code: number): string => String.fromCodePoint(code);

describe("commitSha", () => {
  it("accepts a full hexadecimal object id and normalizes case", () => {
    expect(commitSha("A".repeat(40))).toBe("a".repeat(40));
  });

  it.each([
    ["abbreviated", "abc1234"],
    ["over-long", "a".repeat(41)],
    ["non-hex", "z".repeat(40)],
    ["empty", ""],
  ])("rejects an %s id", (_name, value) => {
    expect(() => commitSha(value)).toThrow(ValidationError);
  });
});

describe("sha256 and versionTag", () => {
  it("accepts a 64-character digest", () => {
    expect(sha256("f".repeat(64))).toBe("f".repeat(64));
  });

  it("rejects a digest of the wrong length", () => {
    expect(() => sha256("f".repeat(63))).toThrow(ValidationError);
  });

  it.each(["v1.8.4", "1.8.4", "v1.8.4-rc.1"])("accepts version %s", (value) => {
    expect(versionTag(value)).toBe(value);
  });

  it.each(["latest", "v1.8", "", "v1.8.4; rm -rf /"])("rejects version %s", (value) => {
    expect(() => versionTag(value)).toThrow(ValidationError);
  });
});

describe("repoPath", () => {
  it("accepts an ordinary repository-relative path", () => {
    expect(repoPath("src/nested/file.ts")).toBe("src/nested/file.ts");
  });

  it("accepts a path containing spaces and unicode", () => {
    expect(repoPath("docs/Übersicht der Regeln.md")).toBe("docs/Übersicht der Regeln.md");
  });

  // A path is used to address the GitHub API and to key inventory reconciliation, and it comes
  // from a candidate-controlled diff.
  it.each([
    ["parent traversal", "../etc/passwd"],
    ["embedded traversal", "src/../../etc/passwd"],
    ["absolute posix", "/etc/passwd"],
    ["windows drive", "C:/windows"],
    ["backslash separator", "src\\file.ts"],
    ["empty segment", "src//file.ts"],
    ["current directory", "./file.ts"],
    ["empty", ""],
  ])("rejects %s", (_name, value) => {
    expect(() => repoPath(value)).toThrow(ValidationError);
  });

  it("rejects a path containing a NUL or other control character", () => {
    expect(() => repoPath(`src/a${ch(0)}.ts`)).toThrow(ValidationError);
    expect(() => repoPath(`src/a${ch(0x1b)}.ts`)).toThrow(ValidationError);
  });

  it("rejects an implausibly long path", () => {
    expect(() => repoPath("a".repeat(4097))).toThrow(ValidationError);
  });

  it("never repeats the offending value in the error, which may be attacker-controlled", () => {
    try {
      repoPath("../secret-value-should-not-appear");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value-should-not-appear");
    }
  });
});

describe("hasControlCharacters", () => {
  it("detects C0, DEL, and C1 ranges", () => {
    expect(hasControlCharacters(ch(0x00))).toBe(true);
    expect(hasControlCharacters(ch(0x7f))).toBe(true);
    expect(hasControlCharacters(ch(0x9f))).toBe(true);
    expect(hasControlCharacters("ordinary text")).toBe(false);
  });
});
