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

  it("treats a missing manifest as unparsable rather than as an empty clean run", () => {
    expect(() => parseEngineResult(JSON.stringify({ status: "success", comments: [] }))).toThrow(
      ValidationError,
    );
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

    it("rejects a severity token that is not a plain identifier", () => {
      const doc = document({
        comments: [
          {
            path: "src/a.ts",
            content: "x".repeat(20),
            start_line: 1,
            end_line: 1,
            severity: "high; drop table",
          },
        ],
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
