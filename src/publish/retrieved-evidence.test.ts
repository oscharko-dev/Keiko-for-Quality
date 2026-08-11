import { describe, expect, it } from "vitest";

import { commitSha } from "../core/brands.js";
import {
  CLOSED_RUNTIME_FACT_CATALOG,
  CLOSED_RUNTIME_FACT_CATALOG_VERSION,
  type ClosedRuntimeFact,
} from "./runtime-fact-catalog.js";
import { requestsClosedRuntimeFacts, toRetrievedEvidence } from "./retrieved-evidence.js";
import { evidenceProvenanceKey, runtimeFactProvenanceKey } from "./substantiate.js";

const RUNTIME_FACT: ClosedRuntimeFact = {
  catalogVersion: CLOSED_RUNTIME_FACT_CATALOG_VERSION,
  id: "ecmascript.object_spread.nullish_source_is_noop",
  statement: CLOSED_RUNTIME_FACT_CATALOG["ecmascript.object_spread.nullish_source_is_noop"],
  source: { path: "src/runtime.ts", side: "H", line: 7 },
};

describe("toRetrievedEvidence", () => {
  it("groups exact-HEAD entries by stable path order", () => {
    expect(
      toRetrievedEvidence({
        sourceCommit: commitSha("a".repeat(40)),
        side: "H",
        entries: [
          { path: "src/a.ts", line: 2, content: "call();", kind: "callsite" },
          { path: "src/a.ts", line: 1, content: "function call() {}", kind: "definition" },
          { path: "src/b.test.ts", line: 4, content: "expect(call())", kind: "test" },
        ],
      }),
    ).toStrictEqual({
      chunks: [
        {
          path: "src/a.ts",
          side: "H",
          lines: [
            { line: 2, text: "call();" },
            { line: 1, text: "function call() {}" },
          ],
        },
        {
          path: "src/b.test.ts",
          side: "H",
          lines: [{ line: 4, text: "expect(call())" }],
        },
      ],
    });
  });

  it("caps the verifier boundary to three paths", () => {
    const entries = Array.from({ length: 5 }, (_value, index) => ({
      path: `src/${String(index)}.ts`,
      line: 1,
      content: "value",
      kind: "callsite" as const,
    }));
    expect(
      toRetrievedEvidence({ sourceCommit: commitSha("b".repeat(40)), side: "H", entries }).chunks,
    ).toHaveLength(3);
  });

  it("excludes known provenance before the three-path cap without conflating HEAD and BASE", () => {
    const entries = Array.from({ length: 5 }, (_value, index) => ({
      path: `src/${String(index)}.ts`,
      line: 1,
      content: `value${String(index)}`,
      kind: "callsite" as const,
    }));
    const known = new Set(
      entries.slice(0, 3).map((entry) => evidenceProvenanceKey(entry.path, "H", entry.line)),
    );

    expect(
      toRetrievedEvidence(
        { sourceCommit: commitSha("c".repeat(40)), side: "H", entries },
        known,
      ).chunks.map((chunk) => chunk.path),
    ).toEqual(["src/3.ts", "src/4.ts"]);
    expect(
      toRetrievedEvidence(
        { sourceCommit: commitSha("d".repeat(40)), side: "B", entries },
        known,
      ).chunks.map((chunk) => chunk.path),
    ).toEqual(["src/0.ts", "src/1.ts", "src/2.ts"]);
  });

  it("reserves the shared three-source cap for closed facts and filters their full identity", () => {
    const context = {
      sourceCommit: commitSha("e".repeat(40)),
      side: "H" as const,
      entries: [0, 1, 2].map((index) => ({
        path: `src/${String(index)}.ts`,
        line: 1,
        content: "value",
        kind: "callsite" as const,
      })),
    };
    const withFact = toRetrievedEvidence(context, new Set(), [RUNTIME_FACT]);

    expect(withFact.facts).toEqual([RUNTIME_FACT]);
    expect(withFact.chunks.map((chunk) => chunk.path)).toEqual(["src/0.ts", "src/1.ts"]);
    expect(
      toRetrievedEvidence(context, new Set([runtimeFactProvenanceKey(RUNTIME_FACT)]), [
        RUNTIME_FACT,
      ]),
    ).toEqual({
      chunks: [
        { path: "src/0.ts", side: "H", lines: [{ line: 1, text: "value" }] },
        { path: "src/1.ts", side: "H", lines: [{ line: 1, text: "value" }] },
        { path: "src/2.ts", side: "H", lines: [{ line: 1, text: "value" }] },
      ],
    });
  });

  it("gates runtime detection on a bounded nullish behavior signal or the closed runtime axis", () => {
    expect(
      requestsClosedRuntimeFacts(
        "Spreading an undefined source into this object throws before fallback.",
        "same_file_contract",
      ),
    ).toBe(true);
    expect(requestsClosedRuntimeFacts("The array spread can throw.", "same_file_contract")).toBe(
      false,
    );
    expect(requestsClosedRuntimeFacts("No semantic signal.", "runtime")).toBe(true);
  });
});
