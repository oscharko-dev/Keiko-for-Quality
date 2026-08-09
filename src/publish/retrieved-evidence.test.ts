import { describe, expect, it } from "vitest";

import { toRetrievedEvidence } from "./retrieved-evidence.js";

describe("toRetrievedEvidence", () => {
  it("groups exact-HEAD entries by stable path order", () => {
    expect(
      toRetrievedEvidence({
        headCommit: "a".repeat(40),
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
    expect(toRetrievedEvidence({ headCommit: "b".repeat(40), entries }).chunks).toHaveLength(3);
  });
});
