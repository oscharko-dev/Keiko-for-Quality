import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ValidationError } from "../core/brands.js";
import {
  SUPPORTED_MANIFEST_SCHEMA,
  parseEngineResult,
  type EngineResult,
  type EngineWarning,
} from "./result.js";

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

  // Every case below pairs the malformed finding with a healthy one, and asserts BOTH halves of
  // the 2026-08-06 fix (Keiko#3011): the malformed finding never becomes a finding, and it never
  // takes its neighbours — or the nineteen-file, 1.76M-token review around them — down with it.
  // Asserting only the rejection would pass just as well under the old all-or-nothing parser,
  // which is exactly how this defect survived.
  describe("finding validation: refuse the element, keep the run", () => {
    const HEALTHY = {
      path: "src/a.ts",
      content: "This leaks the handle on the error path.",
      start_line: 10,
      end_line: 12,
    };

    function parseWithMalformed(malformed: Record<string, unknown>): EngineResult {
      return parseEngineResult(document({ comments: [malformed, HEALTHY] }));
    }

    it("re-validates the path rather than trusting the engine echoed it", () => {
      const result = parseWithMalformed({
        path: "../../etc/passwd",
        content: "x".repeat(20),
        start_line: 1,
        end_line: 1,
      });
      // The traversal path is gone, not merely unpublished — nothing downstream can address it.
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.path).toBe("src/a.ts");
      expect(result.rejectedFindings).toBe(1);
    });

    it("rejects an inverted line range without discarding the healthy finding", () => {
      const result = parseWithMalformed({
        path: "src/a.ts",
        content: "x".repeat(20),
        start_line: 9,
        end_line: 3,
      });
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.startLine).toBe(10);
      expect(result.rejectedFindings).toBe(1);
    });

    it("rejects a negative line number without discarding the healthy finding", () => {
      const result = parseWithMalformed({
        path: "src/a.ts",
        content: "x".repeat(20),
        start_line: -1,
        end_line: 1,
      });
      expect(result.findings).toHaveLength(1);
      expect(result.rejectedFindings).toBe(1);
    });

    // report/types.ts's `isFileLevel` sentinel is `startLine: 0, endLine: 0` TOGETHER, and it is
    // only ever constructed directly by deterministic code in review.ts — never by this parser.
    // Before this bound, `start_line: 0, end_line: 5` parsed successfully: `end < start` (the only
    // cross-field check) is false whenever `start` is 0, producing a finding neither renderer's
    // file-level sentinel nor SARIF's spec can represent. This is the exact shape the pinned model
    // emits, and the one that cost Keiko#3011 its entire review.
    it("rejects a start_line of 0, which the inverted-range check alone cannot catch", () => {
      const result = parseWithMalformed({
        path: "src/a.ts",
        content: "x".repeat(20),
        start_line: 0,
        end_line: 5,
      });
      expect(result.findings).toHaveLength(1);
      expect(result.rejectedFindings).toBe(1);
    });

    it("keeps a run whose findings are ALL malformed, reporting zero findings and the count", () => {
      const result = parseEngineResult(
        document({
          comments: [
            { path: "src/a.ts", content: "x".repeat(20), start_line: 0, end_line: 5 },
            { path: "../../etc/passwd", content: "x".repeat(20), start_line: 1, end_line: 1 },
          ],
        }),
      );
      // Zero findings is a fact about the findings, never about the run: `status` survives so
      // settlement still judges coverage on its own terms rather than inheriting a parse failure.
      expect(result.findings).toEqual([]);
      expect(result.rejectedFindings).toBe(2);
      expect(result.status).toBe("success");
    });

    it("still throws when the comments field itself is not an array", () => {
      // An element-scoped refusal needs an element boundary. A `comments` that is not a list has
      // none, so this stays a malformed RESULT — the distinction the fix rests on.
      expect(() => parseEngineResult(document({ comments: "nope" }))).toThrow(ValidationError);
    });

    it("reports zero rejections for a clean document", () => {
      expect(parseEngineResult(document()).rejectedFindings).toBe(0);
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
        // Leniency toward a vocabulary slip never extends to the structure around it: the
        // traversal path still costs this finding its existence. What changed on 2026-08-06 is
        // only the blast radius — the finding dies, the run does not.
        const result = parseEngineResult(doc);
        expect(result.findings).toEqual([]);
        expect(result.rejectedFindings).toBe(1);
      });
    });

    // Measured on a same-day 32-case qualification run over gpt-oss-120b: six findings across two
    // arms carried a `content` field that was itself JSON carrying the finding envelope's own
    // keys. This is the same recoverable-format-error family as the malformed-token case above —
    // see `unwrapEnvelopeContent` in result.ts for the full rationale and the measured evidence.
    describe("a finding whose content is itself a nested finding envelope", () => {
      it("unwraps the exact shape measured in the qualification run", () => {
        const inner = {
          path: "src/candidate-deliverability.ts",
          start_line: 4,
          end_line: 4,
          category: "bug",
          severity: "high",
          content:
            "The predicate excludes only needs-review, so a rejected candidate still reads as " +
            "deliverable.",
        };
        const doc = document({
          comments: [
            {
              path: "src/changed-file.ts",
              content: JSON.stringify(inner),
              start_line: 100,
              end_line: 100,
              category: "maintainability",
              severity: "low",
            },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
          path: "src/candidate-deliverability.ts",
          content: inner.content,
          startLine: 4,
          endLine: 4,
          category: "bug",
          severity: "high",
        });
      });

      it("does not unwrap when the inner object has no content field", () => {
        const rawContent = JSON.stringify({ path: "src/other.ts", category: "bug" });
        const doc = document({
          comments: [
            {
              path: "src/a.ts",
              content: rawContent,
              start_line: 1,
              end_line: 1,
              category: "test",
            },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]).toMatchObject({
          path: "src/a.ts",
          content: rawContent,
          startLine: 1,
          endLine: 1,
          category: "test",
        });
      });

      it("unwraps the body but keeps the outer path when the inner envelope omits path", () => {
        const inner = { category: "bug", severity: "high", content: "inner sentence body text" };
        const doc = document({
          comments: [
            { path: "src/outer.ts", content: JSON.stringify(inner), start_line: 5, end_line: 5 },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]).toMatchObject({
          path: "src/outer.ts",
          content: "inner sentence body text",
          category: "bug",
          severity: "high",
        });
      });

      it("unwraps the body but falls back to undefined when the inner category is invalid", () => {
        // The outer envelope carries no category of its own, so the fallback this exercises
        // resolves to `undefined` rather than to some other outer value — asserting the actual
        // behaviour rather than assuming which "fallback" the reader might expect.
        const inner = {
          path: "src/inner.ts",
          category: "bug (logic)",
          content: "inner sentence body text",
        };
        const doc = document({
          comments: [
            { path: "src/outer.ts", content: JSON.stringify(inner), start_line: 5, end_line: 5 },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]?.content).toBe("inner sentence body text");
        expect(result.findings[0]?.path).toBe("src/inner.ts");
        expect(result.findings[0]?.category).toBeUndefined();
      });

      // Mirrors the invalid-inner-category case above: `unwrapInnerLines` catches its own
      // `parseLine` throw and returns `undefined`, so an invalid inner line range falls back to
      // the OUTER pair rather than taking the whole finding down — the same "one bad field
      // degrades gracefully" posture as `unwrapInnerPath`/category, now that `parseLine` itself
      // rejects `0`.
      it("unwraps the body but falls back to the outer line range when the inner start_line is 0", () => {
        const inner = {
          path: "src/inner.ts",
          start_line: 0,
          end_line: 5,
          content: "inner sentence body text",
        };
        const doc = document({
          comments: [
            { path: "src/outer.ts", content: JSON.stringify(inner), start_line: 9, end_line: 9 },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]?.content).toBe("inner sentence body text");
        expect(result.findings[0]?.startLine).toBe(9);
        expect(result.findings[0]?.endLine).toBe(9);
      });

      it("unwraps exactly one level when the envelope is nested twice", () => {
        const innermost = {
          path: "src/deepest.ts",
          start_line: 9,
          end_line: 9,
          category: "bug",
          severity: "high",
          content: "the actual sentence, two levels down",
        };
        const middle = {
          path: "src/middle.ts",
          start_line: 7,
          end_line: 7,
          category: "security",
          severity: "critical",
          content: JSON.stringify(innermost),
        };
        const doc = document({
          comments: [
            { path: "src/outer.ts", content: JSON.stringify(middle), start_line: 1, end_line: 1 },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
          path: "src/middle.ts",
          startLine: 7,
          endLine: 7,
          category: "security",
          severity: "critical",
        });
        // Exactly one level: the body is the literal (still-JSON) text of the second envelope,
        // not the sentence buried two levels down inside it.
        expect(result.findings[0]?.content).toBe(JSON.stringify(innermost));
      });

      it("falls back to the outer line pair together when the inner range is only half present", () => {
        const inner = { start_line: 4, category: "bug", content: "inner sentence" };
        const doc = document({
          comments: [
            {
              path: "src/outer.ts",
              content: JSON.stringify(inner),
              start_line: 10,
              end_line: 12,
            },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]?.startLine).toBe(10);
        expect(result.findings[0]?.endLine).toBe(12);
        expect(result.findings[0]?.content).toBe("inner sentence");
      });

      it("does not unwrap ordinary prose that merely contains a brace", () => {
        const prose = "See config: { debug: true } for details, though it is not valid JSON.";
        const doc = document({
          comments: [
            { path: "src/a.ts", content: prose, start_line: 1, end_line: 1, category: "bug" },
          ],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]?.content).toBe(prose);
        expect(result.findings[0]?.path).toBe("src/a.ts");
        expect(result.findings[0]?.category).toBe("bug");
      });

      it("does not unwrap prose that starts with a brace but is not valid JSON", () => {
        const prose = "{this is not json, just a sentence that happens to start with a brace}";
        const doc = document({
          comments: [{ path: "src/a.ts", content: prose, start_line: 1, end_line: 1 }],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]?.content).toBe(prose);
      });

      it("does not unwrap a body that is valid JSON but an array", () => {
        const raw = JSON.stringify(["path", "start_line", "not an envelope"]);
        const doc = document({
          comments: [{ path: "src/a.ts", content: raw, start_line: 1, end_line: 1 }],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]?.content).toBe(raw);
      });

      it("does not unwrap a body that is a valid JSON object without a content field", () => {
        const raw = JSON.stringify({ path: "src/other.ts", category: "bug", severity: "high" });
        const doc = document({
          comments: [{ path: "src/a.ts", content: raw, start_line: 1, end_line: 1 }],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]?.content).toBe(raw);
        expect(result.findings[0]?.path).toBe("src/a.ts");
      });

      it("does not unwrap a JSON object that carries only a content field", () => {
        const raw = JSON.stringify({ content: "just a note with no sibling envelope keys" });
        const doc = document({
          comments: [{ path: "src/a.ts", content: raw, start_line: 1, end_line: 1 }],
        });
        const result = parseEngineResult(doc);
        expect(result.findings[0]?.content).toBe(raw);
      });

      it("still rejects a structural violation on a finding whose content also looks like a nested envelope", () => {
        const inner = { path: "src/inner.ts", content: "inner sentence" };
        const doc = document({
          comments: [
            {
              path: "../../etc/passwd",
              content: JSON.stringify(inner),
              start_line: 1,
              end_line: 1,
            },
          ],
        });
        // The outer envelope's path is validated before unwrapping is ever considered, so a
        // nested envelope cannot smuggle a traversal path past it. Scoped to the element since
        // 2026-08-06 (Keiko#3011), never widened to the run.
        const result = parseEngineResult(doc);
        expect(result.findings).toEqual([]);
        expect(result.rejectedFindings).toBe(1);
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

  // `subtask_error` is the engine's catch-all for a per-file review that did not finish, and it
  // covers two failures with opposite answers: a tool-round ceiling reached (give the file more
  // rounds) and a model call that failed (do not). The engine distinguishes them only in the
  // message text, which is never carried anywhere — so the class is derived here, once.
  describe("subtask_error cause", () => {
    function warningWith(type: string, message: unknown): EngineWarning | undefined {
      return parseEngineResult(document({ warnings: [{ type, message, file: "src/a.ts" }] }))
        .warnings[0];
    }

    it("names tool-budget exhaustion from the engine's own wording", () => {
      // Verbatim from agent.executeSubtask (v1.8.4).
      const warning = warningWith("subtask_error", "main_task did not complete before stopping");
      expect(warning?.cause).toBe("tool_budget");
    });

    it("classifies any other subtask failure as other, never as tool budget", () => {
      expect(warningWith("subtask_error", "LLM completion error: 503")?.cause).toBe("other");
      expect(warningWith("scan_subtask_error", "panic: nil map")?.cause).toBe("other");
      // A missing message is still a subtask failure — just not one we can name.
      expect(warningWith("subtask_error", undefined)?.cause).toBe("other");
    });

    it("leaves every other warning type unclassified rather than guessing at one", () => {
      expect(
        warningWith("token_threshold_exceeded", "prompt tokens exceed")?.cause,
      ).toBeUndefined();
      expect(warningWith("context_truncated", "m")?.cause).toBeUndefined();
    });

    it("never carries the engine's message anywhere in the parsed warning", () => {
      const warning = warningWith("subtask_error", "main_task did not complete: /secret/path");
      expect(JSON.stringify(warning)).not.toContain("secret");
    });
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

/**
 * Captured from a real v1.8.4 review of the oscharko-dev/Keiko#3002 diff (2026-08-06), with
 * finding bodies and repository paths replaced — the shape, statuses, warnings, and summary are
 * verbatim. This is the run shape that eight production settlements misread as an engine failure:
 * a FINISHED review whose reservations live in typed, file-naming warnings.
 */
describe("real v1.8.4 completed_with_errors output", () => {
  const captured = readFileSync(
    join(import.meta.dirname, "__fixtures__/real-v1.8.4-completed-with-errors.json"),
    "utf8",
  );

  it("parses the status as its own value, not as unknown", () => {
    const result = parseEngineResult(captured);
    expect(result.status).toBe("completed_with_errors");
    expect(result.manifestPresent).toBe(false);
  });

  it("carries every warning's type and file for the settlement to attribute", () => {
    const result = parseEngineResult(captured);
    expect(result.warnings).toHaveLength(5);
    for (const warning of result.warnings) {
      expect(warning.type).toBe("subtask_error");
      expect(warning.file).not.toBe("");
    }
  });

  it("keeps the findings a finished-with-errors run earned", () => {
    const result = parseEngineResult(captured);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.filesReviewed).toBe(33);
    expect(result.budgetExceeded).toBe(false);
  });
});

describe("run status vocabulary", () => {
  it.each(["completed_with_warnings", "completed_with_errors", "budget_exceeded"] as const)(
    "parses %s as itself",
    (status) => {
      const parsed = parseEngineResult(JSON.stringify({ status, comments: [] }));
      expect(parsed.status).toBe(status);
    },
  );

  it("still folds a value the pinned release cannot say into unknown", () => {
    const parsed = parseEngineResult(JSON.stringify({ status: "partial", comments: [] }));
    expect(parsed.status).toBe("unknown");
  });
});

// Rounds are spent on tool calls, so the engine's own tally is the only thing that can answer why
// a file exhausted its ceiling. It has emitted this since v1.8.4 and this adapter never read it.
describe("tool-call tally", () => {
  it("reads the engine's total and per-tool breakdown", () => {
    const result = parseEngineResult(
      document({ tool_calls: { total: 47, by_tool: { search_repo: 31, read_file: 16 } } }),
    );
    expect(result.toolCalls.total).toBe(47);
    expect(result.toolCalls.byTool).toEqual({ search_repo: 31, read_file: 16 });
  });

  it("reports zeroes rather than throwing when the engine sends no tally", () => {
    expect(parseEngineResult(document()).toolCalls).toEqual({ total: 0, byTool: {} });
    expect(parseEngineResult(document({ tool_calls: null })).toolCalls.total).toBe(0);
  });

  it("never lets a malformed tally cost a run its verdict", () => {
    const result = parseEngineResult(
      document({ tool_calls: { total: "many", by_tool: { read_file: "lots" } } }),
    );
    expect(result.toolCalls.total).toBe(0);
    expect(result.toolCalls.byTool).toEqual({});
    expect(result.status).toBe("success");
  });

  it("drops a tool name that could not be a diagnostic key", () => {
    // Names come from the engine's fixed tool set, not from candidate content — but a key lands in
    // a log the consumer's whole organization reads, so the shape is enforced rather than trusted.
    const result = parseEngineResult(
      document({
        tool_calls: { total: 3, by_tool: { read_file: 2, "../../etc/passwd": 1, "no spaces": 1 } },
      }),
    );
    expect(result.toolCalls.byTool).toEqual({ read_file: 2 });
  });
});
