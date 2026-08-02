import { describe, expect, it } from "vitest";

import { GlobSet, globToRegExp } from "./glob.js";

describe("globToRegExp", () => {
  it("anchors the whole path", () => {
    expect(globToRegExp("src/a.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/a.ts").test("x/src/a.ts")).toBe(false);
    expect(globToRegExp("src/a.ts").test("src/a.ts.bak")).toBe(false);
  });

  it("keeps a single star inside one segment", () => {
    const matcher = globToRegExp("src/*.ts");
    expect(matcher.test("src/a.ts")).toBe(true);
    expect(matcher.test("src/nested/a.ts")).toBe(false);
  });

  it("lets a globstar cross segments and match zero of them", () => {
    const matcher = globToRegExp("src/**/*.ts");
    expect(matcher.test("src/a.ts")).toBe(true);
    expect(matcher.test("src/deep/nested/a.ts")).toBe(true);
    expect(matcher.test("other/a.ts")).toBe(false);
  });

  it("matches a whole subtree with a trailing globstar", () => {
    const matcher = globToRegExp("scripts/**");
    expect(matcher.test("scripts/run.mjs")).toBe(true);
    expect(matcher.test("scripts/deep/run.mjs")).toBe(true);
    expect(matcher.test("scripts")).toBe(false);
  });

  it("expands brace alternation", () => {
    const matcher = globToRegExp("**/*.{ts,tsx}");
    expect(matcher.test("src/a.ts")).toBe(true);
    expect(matcher.test("src/a.tsx")).toBe(true);
    expect(matcher.test("src/a.js")).toBe(false);
  });

  it("treats regular-expression metacharacters in a pattern as literals", () => {
    const matcher = globToRegExp("docs/a+b(c).md");
    expect(matcher.test("docs/a+b(c).md")).toBe(true);
    expect(matcher.test("docs/aab(c).md")).toBe(false);
  });

  it("matches exactly one character with a question mark", () => {
    const matcher = globToRegExp("v?.txt");
    expect(matcher.test("v1.txt")).toBe(true);
    expect(matcher.test("v12.txt")).toBe(false);
  });

  it("does not crash on an unterminated brace", () => {
    expect(globToRegExp("src/{ts").test("src/{ts")).toBe(true);
  });
});

describe("GlobSet", () => {
  it("matches when any pattern matches", () => {
    const set = new GlobSet(["src/**/*.ts", ".github/workflows/**"]);
    expect(set.matches("src/a.ts")).toBe(true);
    expect(set.matches(".github/workflows/ci.yml")).toBe(true);
    expect(set.matches("README.md")).toBe(false);
  });

  it("matches nothing when empty", () => {
    expect(new GlobSet([]).matches("anything")).toBe(false);
  });
});
