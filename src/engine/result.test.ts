import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ValidationError } from "../core/brands.js";
import { SUPPORTED_MANIFEST_SCHEMA, parseEngineResult } from "./result.js";

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "success",
    summary: { total_tokens: 4200, budget_exceeded: false },
    comments: [
      {
        path: "src/a.ts",
        content: "This leaks the handle on the error path.",
        start_line: 10,
        end_line: 12,
        severity: "high",
        category: "bug",
      },
    ],
    warnings: [],
    manifest: {
      schema_version: SUPPORTED_MANIFEST_SCHEMA,
      run_id: "run-1",
      operation: "review",
      terminal_state: "complete",
      coverage: {
        selected: [{ item_id: "1", path: "src/a.ts" }],
        completed: [{ item_id: "1", path: "src/a.ts" }],
        reused: [],
        failed: [],
        waived: [],
      },
      elapsed_ms: 1000,
    },
    ...overrides,
  });
}

describe("parseEngineResult", () => {
  it("extracts the fields the completeness decision depends on", () => {
    const result = parseEngineResult(document());
    expect(result.terminalState).toBe("complete");
    expect(result.coverage.completed.map((c) => c.path)).toEqual(["src/a.ts"]);
    expect(result.findings).toHaveLength(1);
    expect(result.totalTokens).toBe(4200);
  });

  // An unfamiliar state must not be mistaken for a familiar one; `unknown` is preserved so
  // settlement can reject it while still reporting coverage.
  it("maps an unrecognised terminal state to unknown rather than guessing", () => {
    const result = parseEngineResult(
      document({
        manifest: {
          schema_version: SUPPORTED_MANIFEST_SCHEMA,
          terminal_state: "mostly_complete",
          coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
        },
      }),
    );
    expect(result.terminalState).toBe("unknown");
  });

  it("carries the schema version through so an unsupported one can be rejected", () => {
    const result = parseEngineResult(
      document({
        manifest: {
          schema_version: "ocr.run-manifest/v9",
          terminal_state: "complete",
          coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
        },
      }),
    );
    expect(result.schemaVersion).toBe("ocr.run-manifest/v9");
  });

  // This case originally asserted that a missing manifest throws. Running the real binary
  // disproved the assumption behind it: the engine legitimately omits `manifest` on a skipped run.
  // The invariant that mattered — a manifest-less result must never read as a clean review — is
  // preserved and tightened, because settlement now reports *why* rather than calling it malformed.
  it("reports a missing manifest instead of treating it as an empty clean run", () => {
    const result = parseEngineResult(JSON.stringify({ status: "success", comments: [] }));
    expect(result.manifestPresent).toBe(false);
    expect(result.terminalState).toBe("unknown");
  });

  it("still rejects a manifest that is present but not an object", () => {
    expect(() =>
      parseEngineResult(JSON.stringify({ status: "success", comments: [], manifest: "nope" })),
    ).toThrow(ValidationError);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseEngineResult("{not json")).toThrow(ValidationError);
  });

  it("rejects an empty document", () => {
    expect(() => parseEngineResult("")).toThrow(ValidationError);
  });

  describe("finding validation", () => {
    it("re-validates the path rather than trusting the engine echoed it", () => {
      const doc = document({
        comments: [
          { path: "../../etc/passwd", content: "x".repeat(20), start_line: 1, end_line: 1 },
        ],
      });
      expect(() => parseEngineResult(doc)).toThrow(ValidationError);
    });

    it("rejects an inverted line range", () => {
      const doc = document({
        comments: [{ path: "src/a.ts", content: "x".repeat(20), start_line: 9, end_line: 3 }],
      });
      expect(() => parseEngineResult(doc)).toThrow(ValidationError);
    });

    it("rejects a negative line number", () => {
      const doc = document({
        comments: [{ path: "src/a.ts", content: "x".repeat(20), start_line: -1, end_line: 1 }],
      });
      expect(() => parseEngineResult(doc)).toThrow(ValidationError);
    });

    it("tolerates absent optional classification fields", () => {
      const doc = document({
        comments: [{ path: "src/a.ts", content: "x".repeat(20), start_line: 1, end_line: 1 }],
      });
      const result = parseEngineResult(doc);
      expect(result.findings[0]?.severity).toBeUndefined();
      expect(result.findings[0]?.category).toBeUndefined();
    });

    it("accepts a document with no findings at all", () => {
      expect(parseEngineResult(document({ comments: [] })).findings).toEqual([]);
    });

    // A malformed classification token used to throw and, because `parseFindings` builds its list
    // with a single `.map()`, take every OTHER finding in the same result down with it — a model
    // answering `"severity": "high; drop table"` destroyed an otherwise-complete review. It now
    // parses as absent instead, the same as if the model had never sent it, so the finding routes
    // to the deterministic repair (`classify.ts`) instead of aborting the run.
    describe("a malformed severity or category degrades to absent rather than aborting the run", () => {
      it("parses a malformed severity token as undefined, keeping the rest of the finding", () => {
        const doc = document({
          comments: [
            {
              path: "src/a.ts",
              content: "x".repeat(20),
              start_line: 1,
              end_line: 1,
              severity: "high; drop table",
              category: "bug",
            },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.severity).toBeUndefined();
        expect(result.findings[0]?.category).toBe("bug");
        expect(result.findings[0]?.path).toBe("src/a.ts");
        expect(result.findings[0]?.content).toBe("x".repeat(20));
      });

      it("parses a malformed category token as undefined, keeping the rest of the finding", () => {
        const doc = document({
          comments: [
            {
              path: "src/a.ts",
              content: "x".repeat(20),
              start_line: 1,
              end_line: 1,
              severity: "high",
              category: "bug (logic)",
            },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.category).toBeUndefined();
        expect(result.findings[0]?.severity).toBe("high");
      });

      it("does not lose sibling findings when an earlier one carries a malformed category", () => {
        const doc = document({
          comments: [
            {
              path: "src/a.ts",
              content: "the first finding, malformed",
              start_line: 1,
              end_line: 1,
              category: "not a token!!",
              severity: "high",
            },
            {
              path: "src/b.ts",
              content: "the second finding, well-formed",
              start_line: 5,
              end_line: 6,
              category: "security",
              severity: "critical",
            },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings).toHaveLength(2);
        expect(result.findings[0]?.category).toBeUndefined();
        expect(result.findings[1]).toMatchObject({
          path: "src/b.ts",
          category: "security",
          severity: "critical",
        });
      });

      it("still rejects a structural violation on a finding that also carries a malformed category", () => {
        const doc = document({
          comments: [
            {
              path: "../../etc/passwd",
              content: "x".repeat(20),
              start_line: 1,
              end_line: 1,
              category: "not a token!!",
            },
          ],
        });
        expect(() => parseEngineResult(doc)).toThrow(ValidationError);
      });
    });
  });

  describe("budget signals", () => {
    it("surfaces the engine's own budget flag", () => {
      const result = parseEngineResult(
        document({ summary: { total_tokens: 10, budget_exceeded: true } }),
      );
      expect(result.budgetExceeded).toBe(true);
    });

    it("defaults to zero spend when the summary is absent", () => {
      const result = parseEngineResult(document({ summary: undefined }));
      expect(result.totalTokens).toBe(0);
      expect(result.budgetExceeded).toBe(false);
    });
  });

  it("reads warnings so settlement can compare them against the allowlist", () => {
    const result = parseEngineResult(
      document({ warnings: [{ type: "context_truncated", message: "m", file: "src/a.ts" }] }),
    );
    expect(result.warnings).toEqual([{ type: "context_truncated", file: "src/a.ts" }]);
  });
});

/**
 * Captured from the pinned engine binary itself, not written by hand.
 *
 * `opencodereview v1.8.4 review --from HEAD --to HEAD --format json` on a repository with no
 * changes. A hand-written fixture here would only have restated what this parser already assumed —
 * and the assumption was wrong: a skipped run carries no `manifest` key at all, which the original
 * parser rejected as malformed.
 */
describe("real engine output", () => {
  const captured = readFileSync(
    join(import.meta.dirname, "__fixtures__/real-skipped-run.json"),
    "utf8",
  );

  it("parses a skipped run that carries no manifest", () => {
    const result = parseEngineResult(captured);
    expect(result.manifestPresent).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("reports the absent manifest rather than guessing at a terminal state", () => {
    const result = parseEngineResult(captured);
    expect(result.terminalState).toBe("unknown");
    expect(result.schemaVersion).toBe("");
    expect(result.coverage.completed).toEqual([]);
  });
});

/**
 * The document a pinned v1.8.4 binary actually produced against a live model.
 *
 * Captured from a real review of a seeded authentication bypass, with the finding body replaced —
 * a fixture is committed, and model output is not ours to publish. Everything that settlement reads
 * is preserved verbatim.
 *
 * This fixture exists because the earlier ones did not: the adapter's contract was written from the
 * upstream default branch while the binary was pinned to a release, and the release emits no run
 * manifest at all. Every hand-written fixture agreed with the assumption instead of testing it.
 */
describe("real v1.8.4 release output", () => {
  const captured = readFileSync(
    join(import.meta.dirname, "__fixtures__/real-v1.8.4-success.json"),
    "utf8",
  );

  it("parses a successful review that carries no manifest", () => {
    const result = parseEngineResult(captured);
    expect(result.manifestPresent).toBe(false);
    expect(result.status).toBe("success");
    expect(result.findings).toHaveLength(1);
  });

  it("exposes the file count settlement needs when no manifest exists", () => {
    const result = parseEngineResult(captured);
    expect(result.filesReviewed).toBeGreaterThan(0);
  });

  it("carries the finding position through unchanged", () => {
    const finding = parseEngineResult(captured).findings[0];
    expect(finding?.path).toBe("auth.ts");
    expect(finding?.severity).toBe("critical");
    expect(finding?.category).toBe("security");
  });
});
