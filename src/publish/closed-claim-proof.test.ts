import { describe, expect, it } from "vitest";

import { closedClaimProof } from "./closed-claim-proof.js";
import type { JudgeableFinding } from "./substantiate.js";

function finding(content: string, startLine: number, endLine = startLine): JudgeableFinding {
  return { path: "src/parser.ts", content, startLine, endLine };
}

const DISCLOSURE_CLAIM = finding(
  "Sanitize parser errors before reporting them because the caught error may leak secrets.",
  80,
  84,
);

function catchEvidence(sink: string, changed = true): string {
  return [
    "H:78|   } catch (error) {",
    "H:79|     // Report the unexpected parser failure.",
    `H:80|     ${sink}`,
    "H:81|     result = undefined;",
    "H:82|   }",
    ...(changed ? [`D:H:80| +    ${sink}`] : []),
  ].join("\n");
}

const DUPLICATE_CLAIM = finding(
  "Reject duplicate capability IDs instead of silently overwriting the previous entry.",
  12,
);

function mapEvidence(
  declaration: string,
  beforeWrite: readonly string[] = [],
  changed = true,
): string {
  return [
    `H:8|   ${declaration}`,
    "H:9|   for (const entry of entries) {",
    "H:10|     const id = readId(entry);",
    ...beforeWrite.map((line, index) => `H:${String(11 + index)}|     ${line}`),
    `H:12|     byId.set(id.value, capability);`,
    ...(changed ? ["D:H:12| +    byId.set(id.value, capability);"] : []),
  ].join("\n");
}

describe("closed claim proof", () => {
  it("proves a changed caught binding passed directly to an error sink", () => {
    expect(closedClaimProof(DISCLOSURE_CLAIM, catchEvidence("window.reportError(error);"))).toEqual(
      {
        evidenceRefs: ["D:H:80", "H:80"],
      },
    );
  });

  it.each([
    ["a sanitized replacement", 'window.reportError(new Error("parse failed"));', true],
    ["a different value", "window.reportError(result);", true],
    ["an unchanged sink", "window.reportError(error);", false],
  ])("does not license %s", (_name, sink, changed) => {
    expect(closedClaimProof(DISCLOSURE_CLAIM, catchEvidence(sink, changed))).toBeUndefined();
  });

  it("requires disclosure semantics in the claim", () => {
    const unrelated = finding("Rename the parser error variable for readability.", 80, 84);
    expect(
      closedClaimProof(unrelated, catchEvidence("window.reportError(error);")),
    ).toBeUndefined();
  });

  it("proves a changed duplicate write on a shown native Map", () => {
    expect(
      closedClaimProof(DUPLICATE_CLAIM, mapEvidence("const byId = new Map<string, Capability>();")),
    ).toEqual({ evidenceRefs: ["D:H:12", "H:12"] });
  });

  it.each([
    [
      "a shown duplicate guard",
      "const byId = new Map<string, Capability>();",
      ["if (byId.has(id.value)) return undefined;"],
      true,
    ],
    ["a custom collection", "const byId = createCapabilityIndex();", [], true],
    ["an unchanged write", "const byId = new Map<string, Capability>();", [], false],
  ])("does not license %s", (_name, declaration, guard, changed) => {
    expect(
      closedClaimProof(DUPLICATE_CLAIM, mapEvidence(declaration, guard, changed)),
    ).toBeUndefined();
  });
});
