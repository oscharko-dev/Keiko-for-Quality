import { describe, expect, it } from "vitest";

import { computeAllottedBudget } from "./review.js";

describe("computeAllottedBudget", () => {
  it("matches the worked example: 87 files, 3,175 changed lines", () => {
    // 1.3 * (87 * 40_000 + 3_175 * 60) = 1.3 * (3_480_000 + 190_500) = 1.3 * 3_670_500 = 4_771_650.
    expect(computeAllottedBudget(6_000_000, 87, 3_175)).toBe(4_771_650);
  });

  it("never exceeds the consumer's configured ceiling, however large the change", () => {
    expect(computeAllottedBudget(1_000_000, 87, 3_175)).toBe(1_000_000);
  });

  it("floors a tiny change rather than starving it", () => {
    // 1.3 * (1 * 40_000 + 5 * 60) = 1.3 * 40_300 = 52_390, below the 80_000 floor.
    expect(computeAllottedBudget(2_000_000, 1, 5)).toBe(80_000);
  });

  it("does not let the floor exceed a ceiling configured below it", () => {
    expect(computeAllottedBudget(50_000, 1, 5)).toBe(50_000);
  });

  it("caps a huge change at the ceiling rather than the raw estimate", () => {
    // 1.3 * (1000 * 40_000) = 52_000_000, far past the 6_000_000 ceiling.
    expect(computeAllottedBudget(100_000_000, 1000, 0)).toBe(6_000_000);
  });

  it("still applies the floor to a degenerate zero-file, zero-line input", () => {
    // `performReview` never calls this with an empty inventory — it short-circuits on
    // `reviewablePaths.size === 0` first — but the formula itself has no special case for it, and
    // the floor exists precisely so a small raw estimate never becomes a smaller allotment.
    expect(computeAllottedBudget(2_000_000, 0, 0)).toBe(80_000);
  });

  it("always returns an integer, guarding against floating-point residue from the 1.3 margin", () => {
    for (const [files, lines] of [
      [2, 1],
      [7, 13],
      [1, 0],
      [900, 12345],
    ] as const) {
      expect(Number.isInteger(computeAllottedBudget(6_000_000, files, lines))).toBe(true);
    }
  });

  it("scales with line count, but only as the weak secondary term the constant implies", () => {
    const withoutLines = computeAllottedBudget(6_000_000, 10, 0);
    const withLines = computeAllottedBudget(6_000_000, 10, 1000);
    // 60 tokens/line * 1000 lines * 1.3 margin = 78_000 — a small delta next to the 40_000/file term.
    expect(withLines - withoutLines).toBe(78_000);
  });
});
