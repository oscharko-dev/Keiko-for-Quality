import { describe, expect, it } from "vitest";

import {
  bindTrustedHunkEvidence,
  closedClaimProof,
  type TrustedHunkEvidence,
} from "./closed-claim-proof.js";
import type { JudgeableFinding } from "./substantiate.js";

function finding(content: string, startLine: number, endLine = startLine): JudgeableFinding {
  return { path: "src/parser.ts", content, startLine, endLine };
}

function evidence(
  headLines: readonly string[],
  changedLines: readonly number[],
  baseLines?: readonly string[],
): TrustedHunkEvidence {
  const rows = [
    ...headLines.map((line, index) => `H:${String(index + 1)}| ${line}`),
    ...(baseLines ?? []).map((line, index) => `B:${String(index + 1)}| ${line}`),
    ...changedLines.map((line) => `D:H:${String(line)}| +${headLines[line - 1] ?? ""}`),
  ].join("\n");
  const bound = bindTrustedHunkEvidence({
    text: rows,
    headSource: headLines.join("\n"),
    baseSource: baseLines?.join("\n"),
  });
  if (bound === undefined) throw new Error("test evidence must bind");
  return bound;
}

const DISCLOSURE_CLAIM = finding(
  "Sanitize parser errors before reporting them because the caught error may leak secrets.",
  4,
);

function catchEvidence(
  sink: string,
  options: { readonly changed?: boolean; readonly prior?: boolean; readonly before?: string } = {},
): TrustedHunkEvidence {
  const head = [
    "function parseUpload(): void {",
    "  try { parse(); } catch (error) {",
    `    ${options.before ?? "// Report the unexpected parser failure."}`,
    `    ${sink}`,
    "  }",
    "}",
  ];
  const base = options.prior
    ? [
        "function parseUpload(): void {",
        "  try { parse(); } catch (failure) {",
        "    // Existing behavior.",
        "    window.reportError(failure);",
        "  }",
        "}",
      ]
    : undefined;
  return evidence(head, options.changed === false ? [] : [4], base);
}

const DUPLICATE_CLAIM = finding(
  "Reject duplicate capability IDs instead of silently overwriting the previous entry.",
  5,
);

function mapEvidence(
  options: {
    readonly declaration?: string;
    readonly beforeWrite?: readonly string[];
    readonly changed?: boolean;
    readonly prior?: boolean;
    readonly loop?: boolean;
    readonly arrayGuard?: boolean;
  } = {},
): TrustedHunkEvidence {
  const before = options.beforeWrite ?? [];
  const guard = options.arrayGuard === false ? [] : ["  if (!Array.isArray(entries)) return byId;"];
  const writeLine = 4 + guard.length + before.length;
  const head = [
    "function readCapabilities(entries: readonly Entry[]): Map<string, Capability> {",
    `  ${options.declaration ?? "const byId = new Map<string, Capability>();"}`,
    ...guard,
    options.loop === false ? "  if (entries.length > 0) {" : "  for (const entry of entries) {",
    ...before.map((line) => `    ${line}`),
    "    byId.set(id.value, capability);",
    "  }",
    "  return byId;",
    "}",
  ];
  const base = options.prior
    ? [
        "function readCapabilities(entries: readonly Entry[]): Map<string, Capability> {",
        "  const index = new Map<string, Capability>();",
        "  for (const entry of entries) {",
        "    index.set(id.value, capability);",
        "  }",
        "  return index;",
        "}",
      ]
    : undefined;
  return evidence(head, options.changed === false ? [] : [writeLine], base);
}

describe("trusted closed claim proof", () => {
  it("rejects dossier rows that do not match the bound source", () => {
    expect(
      bindTrustedHunkEvidence({
        text: "H:1| reportError(error);\nD:H:1| +reportError(error);",
        headSource: "reportError(safe);",
        baseSource: undefined,
      }),
    ).toBeUndefined();
  });

  it("binds a dossier that contains only an exact changed-source row", () => {
    expect(
      bindTrustedHunkEvidence({
        text: "D:H:1| +window.reportError(error);",
        headSource: "window.reportError(error);",
        baseSource: undefined,
      }),
    ).toBeDefined();
  });

  it("proves a changed caught binding passed directly to an error sink", () => {
    expect(closedClaimProof(DISCLOSURE_CLAIM, catchEvidence("window.reportError(error);"))).toEqual(
      { evidenceRefs: ["D:H:4", "H:4"] },
    );
  });

  it("masks a regex that starts inside a call before matching the catch scope", () => {
    expect(
      closedClaimProof(
        DISCLOSURE_CLAIM,
        catchEvidence("window.reportError(error);", { before: "consume(/\\{/u);" }),
      ),
    ).toEqual({ evidenceRefs: ["D:H:4", "H:4"] });
  });

  it.each([
    ["a sanitized replacement", 'window.reportError(new Error("parse failed"));', {}],
    ["a different value", "window.reportError(result);", {}],
    ["an unchanged sink", "window.reportError(error);", { changed: false }],
    [
      "a reassigned catch binding",
      "window.reportError(error);",
      { before: 'error = new Error("safe");' },
    ],
    [
      "a shadowed catch binding",
      "window.reportError(error);",
      { before: "for (const error of fallbackErrors) { reportError(error); }" },
    ],
    [
      "a caught value sanitized in place",
      "window.reportError(error);",
      { before: 'error.message = "parse failed";' },
    ],
    ["an unqualified local helper", "reportError(error);", {}],
    ["an unreachable sink after return", "window.reportError(error);", { before: "return;" }],
    [
      "an unreachable sink after throw",
      "window.reportError(error);",
      { before: 'throw new Error("stop");' },
    ],
    ["behavior already present in BASE", "window.reportError(error);", { prior: true }],
    ["a comment", "// window.reportError(error);", {}],
    ["a string", 'const example = "window.reportError(error);";', {}],
  ])("does not license %s", (_name, sink, options) => {
    expect(closedClaimProof(DISCLOSURE_CLAIM, catchEvidence(sink, options))).toBeUndefined();
  });

  it("requires disclosure semantics in the claim", () => {
    const unrelated = finding("Rename the parser error variable for readability.", 4);
    expect(
      closedClaimProof(unrelated, catchEvidence("window.reportError(error);")),
    ).toBeUndefined();
  });

  it("proves a changed duplicate write on a stable native Map inside an input loop", () => {
    expect(closedClaimProof(DUPLICATE_CLAIM, mapEvidence())).toEqual({
      evidenceRefs: ["D:H:5", "H:5"],
    });
  });

  it.each([
    ["a shown duplicate guard", { beforeWrite: ["if (byId.has(id.value)) return byId;"] }],
    [
      "a shown duplicate guard using get",
      { beforeWrite: ["if (byId.get(id.value) !== undefined) throw new Error('duplicate');"] },
    ],
    [
      "a distant shown duplicate guard",
      { beforeWrite: Array(30).fill("work();").concat("if (byId.has(id.value)) return byId;") },
    ],
    ["a custom collection", { declaration: "const byId = createCapabilityIndex();" }],
    ["an unchanged write", { changed: false }],
    ["a non-repeated write", { loop: false }],
    ["an iterable not proven to be an array", { arrayGuard: false }],
    ["a loop that can break before the write", { beforeWrite: ["if (byId.size !== 0) break;"] }],
    ["behavior already present in BASE", { prior: true }],
    ["a shadowed receiver", { beforeWrite: ["const byId = createCapabilityIndex();"] }],
    ["a reassigned receiver", { beforeWrite: ["byId = createCapabilityIndex();"] }],
    ["an overridden Map writer", { beforeWrite: ["byId.set = rejectDuplicateSet;"] }],
    [
      "a shadowed Map constructor",
      { beforeWrite: [], declaration: "const byId = new Map();", mapShadow: true },
    ],
    [
      "a destructured Map constructor",
      { beforeWrite: [], declaration: "const byId = new Map();", destructuredMap: true },
    ],
    ["a comment", { beforeWrite: [], changed: true, write: "// byId.set(id.value, capability);" }],
    [
      "a string",
      {
        beforeWrite: [],
        changed: true,
        write: 'const example = "byId.set(id.value, capability);";',
      },
    ],
  ])("does not license %s", (_name, rawOptions) => {
    const options = rawOptions as typeof rawOptions & {
      readonly mapShadow?: boolean;
      readonly destructuredMap?: boolean;
      readonly write?: string;
      readonly arrayGuard?: boolean;
    };
    if (options.mapShadow || options.destructuredMap || options.write !== undefined) {
      const head = [
        ...(options.mapShadow ? ["const Map = CustomMap;"] : []),
        ...(options.destructuredMap ? ["const { Map } = strictCollections;"] : []),
        "function readCapabilities(entries: readonly Entry[]): unknown {",
        "  const byId = new Map();",
        "  if (!Array.isArray(entries)) return byId;",
        "  for (const entry of entries) {",
        `    ${options.write ?? "byId.set(id.value, capability);"}`,
        "  }",
        "  return byId;",
        "}",
      ];
      const line = options.mapShadow || options.destructuredMap ? 6 : 5;
      expect(
        closedClaimProof(finding(DUPLICATE_CLAIM.content, line), evidence(head, [line])),
      ).toBeUndefined();
      return;
    }
    expect(closedClaimProof(DUPLICATE_CLAIM, mapEvidence(options))).toBeUndefined();
  });
});
