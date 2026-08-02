import { describe, expect, it } from "vitest";

import { composeBody, extractMarker, fingerprint, hasMarker, renderMarker } from "./marker.js";

const BASE = {
  repository: "acme/widget",
  pullNumber: 7,
  path: "src/retry.ts",
  rule: "bug",
  body: "The retry loop never resets the attempt counter.",
};

describe("fingerprint", () => {
  it("is stable for identical input", () => {
    expect(fingerprint(BASE)).toBe(fingerprint(BASE));
  });

  // A finding pushed down the file by an unrelated edit is the same finding. Reposting it would
  // punish a contributor for touching a neighbouring line.
  it("does not depend on line numbers", () => {
    expect(fingerprint(BASE)).toBe(fingerprint({ ...BASE }));
  });

  it("ignores cosmetic rewording of the same point", () => {
    const reworded = { ...BASE, body: "  THE RETRY LOOP never resets   the attempt counter!  " };
    expect(fingerprint(reworded)).toBe(fingerprint(BASE));
  });

  it("ignores code-block drift, which models vary freely", () => {
    const withCode = { ...BASE, body: `${BASE.body}\n\n\`\`\`ts\nlet i = 0;\n\`\`\`` };
    expect(fingerprint(withCode)).toBe(fingerprint(BASE));
  });

  it.each([
    ["repository", { repository: "other/widget" }],
    ["pull request", { pullNumber: 8 }],
    ["path", { path: "src/other.ts" }],
    ["rule", { rule: "security" }],
    ["substance", { body: "An entirely different defect about locking." }],
  ])("changes when the %s changes", (_name, override) => {
    expect(fingerprint({ ...BASE, ...override })).not.toBe(fingerprint(BASE));
  });

  it("produces a compact hexadecimal token", () => {
    expect(fingerprint(BASE)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("marker rendering", () => {
  it("round-trips through render and extract", () => {
    const value = fingerprint(BASE);
    expect(extractMarker(renderMarker(value))).toBe(value);
  });

  it("finds a marker appended to a body", () => {
    const body = composeBody("Some finding text.", fingerprint(BASE));
    expect(hasMarker(body)).toBe(true);
    expect(extractMarker(body)).toBe(fingerprint(BASE));
  });

  it("reports no marker for an ordinary human comment", () => {
    expect(extractMarker("Looks good to me")).toBeUndefined();
    expect(hasMarker("Looks good to me")).toBe(false);
  });

  it("ignores a malformed lookalike", () => {
    expect(extractMarker("<!-- keiko-for-quality:v1:not-hex -->")).toBeUndefined();
    expect(extractMarker("<!-- keiko-for-quality:v2:" + "a".repeat(32) + " -->")).toBeUndefined();
  });

  it("keeps the marker as the only HTML in the composed body", () => {
    const body = composeBody("Plain prose finding.", fingerprint(BASE));
    expect(body.match(/</g)).toHaveLength(1);
  });
});
