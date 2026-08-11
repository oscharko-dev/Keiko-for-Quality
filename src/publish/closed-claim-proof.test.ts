import { describe, expect, it } from "vitest";

import {
  bindTrustedHunkEvidence,
  closedClaimProof,
  closedClaimRefutation,
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
  options: {
    readonly changed?: boolean;
    readonly prior?: boolean;
    readonly before?: string;
    readonly setup?: readonly string[];
  } = {},
): TrustedHunkEvidence {
  const setup = options.setup ?? [];
  const sinkLine = setup.length + 4;
  const head = [
    ...setup,
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
  return evidence(head, options.changed === false ? [] : [sinkLine], base);
}

const DUPLICATE_CLAIM = finding(
  "Reject duplicate capability IDs instead of silently overwriting the previous entry.",
  5,
);

function mapEvidence(
  options: {
    readonly declaration?: string;
    readonly beforeWrite?: readonly string[];
    readonly afterWrite?: readonly string[];
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
    ...(options.afterWrite ?? []).map((line) => `    ${line}`),
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

function mapProof(
  options: Parameters<typeof mapEvidence>[0] = {},
): ReturnType<typeof closedClaimProof> {
  const beforeWrite = options.beforeWrite ?? [];
  const writeLine = 4 + (options.arrayGuard === false ? 0 : 1) + beforeWrite.length;
  return closedClaimProof(finding(DUPLICATE_CLAIM.content, writeLine), mapEvidence(options));
}

const FILE_READ_CLAIM = finding(
  "Add error handling because `file.text()` can reject and propagate an unhandled promise rejection.",
  5,
);

function fileReadEvidence(
  options: {
    readonly caught?: boolean;
    readonly caller?: string;
    readonly secondUse?: string;
    readonly changed?: boolean;
    readonly prior?: boolean;
    readonly inputBinding?: string;
    readonly read?: string;
  } = {},
): TrustedHunkEvidence {
  const caught = options.caught === true;
  const head = [
    "function Upload(): ReactNode {",
    "  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {",
    `    ${options.inputBinding ?? "const file = event.target.files?.[0];"}`,
    "    if (file === undefined) return;",
    ...(caught ? ["    try {"] : []),
    `    ${options.read ?? "const serialized = await file.text();"}`,
    ...(caught ? ["    } catch { showInvalid(); }"] : []),
    "    apply(serialized);",
    "  }",
    `  ${options.caller ?? "return <input onChange={(event) => void handleFile(event)} />;"}`,
    ...(options.secondUse === undefined ? [] : [`  ${options.secondUse}`]),
    "}",
  ];
  const readLine = caught ? 6 : 5;
  const callLine = caught ? 10 : 8;
  return evidence(
    head,
    options.changed === false ? [] : [readLine, callLine],
    options.prior ? head : undefined,
  );
}

interface DiagnosticContextOptions {
  readonly parameter?: string;
  readonly addedEntry?: string;
  readonly baseMessage?: string;
  readonly headMessage?: string;
  readonly setup?: readonly string[];
  readonly rethrow?: string;
  readonly extraHeadChange?: boolean;
}

function diagnosticContextEvidence(options: DiagnosticContextOptions = {}): TrustedHunkEvidence {
  const setup = options.setup ?? [];
  const parameter = options.parameter ?? "attempt: number";
  const baseMessage = options.baseMessage ?? '"push failed"';
  const headMessage = options.headMessage ?? baseMessage;
  const base = [
    `export async function push(client: Client, ${parameter}): Promise<void> {`,
    ...setup,
    "  try {",
    "    await client.push();",
    "  } catch (error) {",
    `    logger.error(${baseMessage}, { correlationId: client.id });`,
    `    ${options.rethrow ?? "throw error;"}`,
    "  }",
    "}",
  ];
  const head = [...base];
  const logLine = 5 + setup.length;
  head[logLine - 1] =
    `    logger.error(${headMessage}, { correlationId: client.id, ${options.addedEntry ?? "attempt"} });`;
  if (options.extraHeadChange === true)
    head[2 + setup.length] = "    await client.pushWithRetry();";
  const changed = [logLine, ...(options.extraHeadChange === true ? [3 + setup.length] : [])];
  return evidence(head, changed, base);
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

  it("rejects a source-visible replacement for the qualified error sink", () => {
    const setup = ["window.reportError = (failure) => send(redact(failure));"];
    const claim = finding(DISCLOSURE_CLAIM.content, 5);
    expect(
      closedClaimProof(claim, catchEvidence("window.reportError(error);", { setup })),
    ).toBeUndefined();
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
    expect(mapProof()).toEqual({
      evidenceRefs: ["D:H:5", "H:5"],
    });
  });

  it("proves an awaited file read whose sole event-handler caller discards the rejection", () => {
    expect(closedClaimProof(FILE_READ_CLAIM, fileReadEvidence())).toEqual({
      evidenceRefs: ["D:H:5", "H:5", "D:H:8", "H:8"],
    });
  });

  it.each([
    ["a caught read", { caught: true }],
    [
      "a same-line caught read",
      { read: "try { const serialized = await file.text(); } catch { showInvalid(); }" },
    ],
    [
      "a caller that observes rejection",
      {
        caller: "return <input onChange={(event) => void handleFile(event).catch(showInvalid)} />;",
      },
    ],
    [
      "an awaited caller",
      { caller: "return <input onChange={async (event) => await handleFile(event)} />;" },
    ],
    ["a call that can continue on the next line", { caller: "return void handleFile(event)" }],
    ["multiple callers", { secondUse: "void handleFile(retryEvent);" }],
    ["an unbound file-like receiver", { inputBinding: "const file = selected;" }],
    ["a locally handled read", { read: "const serialized = await file.text().catch(readFailed);" }],
    ["unchanged code", { changed: false }],
    ["behavior already present in BASE", { prior: true }],
  ])("does not license %s", (_name, options) => {
    expect(closedClaimProof(FILE_READ_CLAIM, fileReadEvidence(options))).toBeUndefined();
  });

  it("requires unhandled file-read semantics in the claim", () => {
    expect(
      closedClaimProof(
        finding("Rename the file upload handler for clarity.", 5),
        fileReadEvidence(),
      ),
    ).toBeUndefined();
  });

  it("refutes a finding about one stable non-secret primitive added to structured error context", () => {
    expect(
      closedClaimRefutation(
        finding("Remove the attempt field because logging it changes error handling.", 5),
        diagnosticContextEvidence(),
      ),
    ).toEqual({ evidenceRefs: ["D:H:5", "H:5", "B:5"] });
  });

  it("does not mistake a primitive comparison for reassignment", () => {
    expect(
      closedClaimRefutation(
        finding("Remove the attempt field because logging it changes error handling.", 6),
        diagnosticContextEvidence({ setup: ["  if (attempt === 0) return;"] }),
      ),
    ).toEqual({ evidenceRefs: ["D:H:6", "H:6", "B:6"] });
  });

  it("accepts a nested first log argument and a defaulted primitive parameter", () => {
    expect(
      closedClaimRefutation(
        finding("Remove the attempt field because logging it changes error handling.", 5),
        diagnosticContextEvidence({
          parameter: "attempt: number = 0",
          baseMessage: "formatMessage(error)",
        }),
      ),
    ).toEqual({ evidenceRefs: ["D:H:5", "H:5", "B:5"] });
  });

  const rejectedDiagnosticContextShapes: readonly (readonly [string, DiagnosticContextOptions])[] =
    [
      ["a sensitive field", { parameter: "token: string", addedEntry: "token" }],
      ["a non-primitive field", { parameter: "attempt: Attempt" }],
      ["a computed field", { addedEntry: "attempt: normalize(attempt)" }],
      ["a reassigned parameter", { setup: ["  attempt = normalize(attempt);"] }],
      ["a wrapped error", { rethrow: 'throw new Error("push failed", { cause: error });' }],
      ["a changed message", { headMessage: '"push failed permanently"' }],
      ["another source change", { extraHeadChange: true }],
    ];

  it.each(rejectedDiagnosticContextShapes)("does not refute %s", (_name, options) => {
    const logLine = 5 + (options.setup?.length ?? 0);
    expect(
      closedClaimRefutation(
        finding("Remove the added diagnostic context.", logLine),
        diagnosticContextEvidence(options),
      ),
    ).toBeUndefined();
  });

  it("requires the finding to be anchored on the proven transition", () => {
    expect(
      closedClaimRefutation(
        finding("Remove the added diagnostic context.", 2),
        diagnosticContextEvidence(),
      ),
    ).toBeUndefined();
  });

  it("requires the trusted brand to be an own property", () => {
    const inherited = Object.create(mapEvidence()) as TrustedHunkEvidence;
    expect(closedClaimProof(DUPLICATE_CLAIM, inherited)).toBeUndefined();
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
    [
      "a loop that can skip before the write",
      { beforeWrite: ["if (byId.has(id.value)) continue;"] },
    ],
    [
      "a separate collection that rejects duplicates",
      { beforeWrite: ["if (seenIds.has(id.value)) throw new Error('duplicate');"] },
    ],
    ["behavior already present in BASE", { prior: true }],
    ["a shadowed receiver", { beforeWrite: ["const byId = createCapabilityIndex();"] }],
    ["a reassigned receiver", { beforeWrite: ["byId = createCapabilityIndex();"] }],
    ["an overridden Map writer", { beforeWrite: ["byId.set = rejectDuplicateSet;"] }],
    [
      "a Map writer overridden after the first write",
      { afterWrite: ["byId.set = rejectDuplicateSet;"] },
    ],
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
    expect(mapProof(options)).toBeUndefined();
  });
});
