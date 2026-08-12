import { describe, expect, it } from "vitest";

import { repoPath } from "../core/brands.js";
import type { EngineFinding } from "../engine/result.js";
import type { PlannedFinding } from "./publisher.js";
import {
  MAX_FRESH_MODEL_FINDINGS_PER_PR,
  MAX_FRESH_VERIFICATION_CANDIDATES_PER_PR,
  selectPrWideFindings,
  selectVerificationCandidates,
} from "./pr-wide-selection.js";

function finding(name: string, severity: string | undefined): EngineFinding {
  return {
    path: repoPath(`src/${name}.ts`),
    content: name,
    startLine: 1,
    endLine: 1,
    severity,
    category: "bug",
  };
}

function planned(value: EngineFinding): PlannedFinding {
  return { finding: value, sanitizedBody: `sanitized:${value.content}` };
}

describe("selectPrWideFindings", () => {
  it("caps fresh and cached model findings together while exempting deterministic findings", () => {
    const cached = finding("cached", "critical");
    const deterministic = finding("deterministic", undefined);
    const fresh = Array.from({ length: 10 }, (_, index) =>
      finding(`fresh-${String(index)}`, "medium"),
    );
    const originals = [cached, ...fresh.slice(0, 5), deterministic, ...fresh.slice(5)];
    const survivors = originals.map(planned);

    const selected = selectPrWideFindings(survivors, new Set([cached, ...fresh]), 50);

    expect(selected.kept).toEqual([
      survivors[0],
      ...survivors.slice(1, 6),
      survivors[6],
      ...survivors.slice(7, 9),
    ]);
    expect(selected.rankedOutOriginals).toEqual(fresh.slice(7));
    expect(selected.rankedOutCount).toBe(3);
    expect(selected.kept).toHaveLength(MAX_FRESH_MODEL_FINDINGS_PER_PR + 1);
  });

  it("ranks effective severity critical, high, medium, low, then unclassified", () => {
    const originals = [
      finding("unknown-first", "urgent"),
      finding("missing", undefined),
      finding("low-a", "low"),
      finding("medium-a", "medium"),
      finding("high-a", "high"),
      finding("critical-a", "critical"),
      finding("low-b", "LOW"),
      finding("medium-b", "MEDIUM"),
      finding("high-b", "HIGH"),
      finding("critical-b", "CRITICAL"),
    ];
    const survivors = originals.map(planned);

    const selected = selectPrWideFindings(survivors, new Set(originals), 50);

    expect(selected.kept).toEqual(survivors.slice(2));
    expect(selected.rankedOutOriginals).toEqual(originals.slice(0, 2));
  });

  it("uses stable input order to break equal-severity ties", () => {
    const originals = Array.from({ length: 11 }, (_, index) =>
      finding(`same-${String(index)}`, "high"),
    );
    const survivors = originals.map(planned);

    const selected = selectPrWideFindings(survivors, new Set(originals), 50);

    expect(selected.kept).toEqual(survivors.slice(0, 8));
    expect(selected.rankedOutOriginals).toEqual(originals.slice(8));
  });

  it("ranks with replacements, applies them, and reports ranked-out originals", () => {
    const promotedOriginal = finding("promoted-original", "low");
    const promotedReplacement = { ...promotedOriginal, severity: "critical", category: "security" };
    const high = Array.from({ length: 8 }, (_, index) => finding(`high-${String(index)}`, "high"));
    const originals = [...high, promotedOriginal];
    const survivors = originals.map(planned);

    const selected = selectPrWideFindings(
      survivors,
      new Set(originals),
      50,
      new Map([[promotedOriginal, promotedReplacement]]),
    );

    expect(selected.kept).toEqual([
      ...survivors.slice(0, 7),
      { ...survivors[8], finding: promotedReplacement },
    ]);
    expect(selected.kept[7]?.sanitizedBody).toBe(survivors[8]?.sanitizedBody);
    expect(selected.rankedOutOriginals).toEqual([high[7]]);
    expect(selected.rankedOutOriginals[0]).toBe(high[7]);
  });

  it("determines model authorship from originals even when replacements are different objects", () => {
    const deterministicOriginal = finding("deterministic-original", "low");
    const deterministicReplacement = { ...deterministicOriginal, severity: undefined };
    const fresh = Array.from({ length: 9 }, (_, index) =>
      finding(`fresh-${String(index)}`, "critical"),
    );
    const originals = [deterministicOriginal, ...fresh];
    const survivors = originals.map(planned);
    const replacements = new Map<EngineFinding, EngineFinding>([
      [deterministicOriginal, deterministicReplacement],
    ]);

    const selected = selectPrWideFindings(survivors, new Set(fresh), 50, replacements);

    expect(selected.kept).toEqual([
      { ...survivors[0], finding: deterministicReplacement },
      ...survivors.slice(1, 9),
    ]);
    expect(selected.rankedOutOriginals).toEqual([fresh[8]]);
  });

  it("preserves original publication order after severity chooses membership", () => {
    const originals = [
      finding("high-first", "high"),
      finding("low-ranked-out", "low"),
      finding("critical-later", "critical"),
      finding("medium-a", "medium"),
      finding("medium-b", "medium"),
      finding("medium-c", "medium"),
      finding("medium-d", "medium"),
      finding("medium-e", "medium"),
      finding("medium-f", "medium"),
    ];
    const survivors = originals.map(planned);

    const selected = selectPrWideFindings(survivors, new Set(originals), 50);

    expect(selected.kept).toEqual([
      survivors[0],
      survivors[2],
      survivors[3],
      survivors[4],
      survivors[5],
      survivors[6],
      survivors[7],
      survivors[8],
    ]);
    expect(selected.rankedOutOriginals).toEqual([originals[1]]);
  });

  it("keeps every effective survivor when the fresh cohort is within the ceiling", () => {
    const original = finding("original", "medium");
    const replacement = { ...original, content: "repaired" };
    const other = finding("other", "low");
    const survivors = [planned(original), planned(other)];

    const selected = selectPrWideFindings(
      survivors,
      new Set([original, other]),
      50,
      new Map([[original, replacement]]),
    );

    expect(selected).toEqual({
      kept: [{ ...survivors[0], finding: replacement }, survivors[1]],
      rankedOutOriginals: [],
      rankedOutCount: 0,
    });
  });
});

describe("selectVerificationCandidates", () => {
  it("keeps an unresolved classification behind sixteen model-labelled critical hypotheses", () => {
    const labelled = Array.from({ length: 16 }, (_, index) =>
      finding(`labelled-${String(index)}`, "critical"),
    );
    const unresolved = finding("unresolved-real-defect", undefined);
    const survivors = [...labelled, unresolved].map(planned);

    const selected = selectVerificationCandidates(
      survivors,
      new Set([...labelled, unresolved]),
      50,
    );

    expect(selected.kept).toHaveLength(MAX_FRESH_VERIFICATION_CANDIDATES_PER_PR);
    expect(selected.kept.some((entry) => entry.finding === unresolved)).toBe(true);
    expect(selected.rankedOutOriginals).toHaveLength(1);
    expect(labelled).toContain(selected.rankedOutOriginals[0]);
  });

  it("bounds verifier work across cached and fresh model claims after deterministic priority", () => {
    const cached = finding("cached-before-verification", "critical");
    const deterministic = finding("deterministic-before-verification", undefined);
    const fresh = Array.from({ length: 20 }, (_, index) =>
      finding(`candidate-${String(index)}`, "medium"),
    );
    const survivors = [cached, deterministic, ...fresh].map(planned);

    const selected = selectVerificationCandidates(survivors, new Set([cached, ...fresh]), 50);

    expect(selected.kept[0]).toBe(survivors[0]);
    expect(selected.kept[1]).toBe(survivors[1]);
    expect(selected.kept).toHaveLength(MAX_FRESH_VERIFICATION_CANDIDATES_PER_PR + 1);
    expect(selected.rankedOutOriginals).toEqual(
      fresh.slice(MAX_FRESH_VERIFICATION_CANDIDATES_PER_PR - 1),
    );
  });

  it.each([1, 3, 50])(
    "reduces the verifier cohort to the consumer's total limit %i after deterministic priority",
    (maxFindings) => {
      const deterministic = finding("deterministic", "low");
      const model = Array.from({ length: 60 }, (_, index) =>
        finding(`model-${String(index)}`, "high"),
      );
      const survivors = [model[0]!, deterministic, ...model.slice(1)].map(planned);

      const selected = selectVerificationCandidates(survivors, new Set(model), maxFindings);

      expect(selected.kept).toHaveLength(1 + Math.min(16, maxFindings - 1));
      expect(selected.kept.some((entry) => entry.finding === deterministic)).toBe(true);
      expect(selected.kept.filter((entry) => model.includes(entry.finding))).toHaveLength(
        Math.max(0, Math.min(16, maxFindings - 1)),
      );
    },
  );
});

describe("consumer publication limit", () => {
  it.each([1, 3, 50])(
    "never keeps more than maxFindings=%i and gives deterministic findings priority",
    (maxFindings) => {
      const deterministic = Array.from({ length: 2 }, (_, index) =>
        finding(`deterministic-${String(index)}`, "low"),
      );
      const model = Array.from({ length: 60 }, (_, index) =>
        finding(`model-${String(index)}`, "critical"),
      );
      const survivors = [...model.slice(0, 1), ...deterministic, ...model.slice(1)].map(planned);

      const selected = selectPrWideFindings(survivors, new Set(model), maxFindings);

      expect(selected.kept.length).toBeLessThanOrEqual(maxFindings);
      expect(
        selected.kept.filter((entry) => model.includes(entry.finding)).length,
      ).toBeLessThanOrEqual(
        Math.min(8, Math.max(0, maxFindings - Math.min(deterministic.length, maxFindings))),
      );
      expect(selected.kept.filter((entry) => deterministic.includes(entry.finding))).toEqual(
        deterministic.slice(0, maxFindings).map(planned),
      );
    },
  );
});
