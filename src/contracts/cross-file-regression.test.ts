import { describe, expect, it } from "vitest";

import { sanitizeFindingBody } from "../publish/sanitize.js";
import { detectCrossFileRegressions, type SourceTransition } from "./cross-file-regression.js";

const TARGET: SourceTransition = {
  path: "src/batch.ts",
  base: `export function splitIntoBatches<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError("batch size must be positive");
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}`,
  head: `export function splitIntoBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}`,
};

const CALLER: SourceTransition = {
  path: "src/digest.ts",
  base: `return splitIntoBatches(items, configuredSize ?? 20);`,
  head: `return splitIntoBatches(items, configuredSize ?? 0);`,
};

describe("detectCrossFileRegressions", () => {
  it("finds a removed positive-step guard contradicted by a shown zero caller", () => {
    const findings = detectCrossFileRegressions([TARGET, CALLER]);

    expect(findings).toMatchObject([
      { path: "src/batch.ts", line: 3, category: "bug", severity: "high" },
    ]);
    expect(sanitizeFindingBody(findings[0]!.content).ok).toBe(true);
  });

  it.each([
    [
      "an unrelated upper-bound throw",
      TARGET.head.replace(
        "  const batches",
        '  if (size > 100) throw new RangeError("too large");\n  const batches',
      ),
    ],
    [
      "the same guard retained by another function",
      `${TARGET.head}\nfunction other(size: number): void {\n  if (size <= 0) throw new RangeError("positive");\n}`,
    ],
    [
      "a return type containing a later parenthesized expression",
      TARGET.head.replace("): T[][] {", "): ReturnType<typeof buildResult()> {"),
    ],
  ])("still finds the regression with %s", (_name, head) => {
    expect(detectCrossFileRegressions([{ ...TARGET, head }, CALLER])).toHaveLength(1);
  });

  it.each([
    ["no shown caller", [TARGET]],
    ["safe caller", [TARGET, { ...CALLER, head: CALLER.base }]],
    [
      "zero fallback in a different argument",
      [TARGET, { ...CALLER, head: "return splitIntoBatches(items ?? 0, 20);" }],
    ],
    [
      "lookalike caller",
      [
        TARGET,
        { ...CALLER, head: CALLER.head.replace("splitIntoBatches(", "mySplitIntoBatches(") },
      ],
    ],
    ["retained guard", [{ ...TARGET, head: TARGET.base }, CALLER]],
    [
      "non-advancing parameter is unrelated",
      [{ ...TARGET, head: TARGET.head.replace("i += size", "i += 1") }, CALLER],
    ],
  ])("stays silent for %s", (_name, files) => {
    expect(detectCrossFileRegressions(files)).toEqual([]);
  });
});
