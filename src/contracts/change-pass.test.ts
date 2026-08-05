import { describe, expect, it } from "vitest";

import { LIMITS as ENGINE_RESULT_LIMITS } from "../engine/result.js";
import {
  buildChangePassPrompt,
  runChangePass,
  summarizeDeclarations,
  type ChangedFile,
  type ChangePassDeps,
} from "./change-pass.js";

interface CannedReply {
  readonly status: number;
  readonly content?: string;
  readonly tokens?: number;
}

interface RecordedCall {
  readonly url: string;
  readonly body: { model: string; messages: readonly { content: string }[]; seed: number };
}

function chatBody(content: string, tokens: number): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { total_tokens: tokens },
  });
}

// Mirrors engine/classify.test.ts's own fakeFetch exactly, so the two hermetic transport-stub
// suites read the same way.
function fakeFetch(replies: readonly CannedReply[]): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const reply = replies[calls.length] ?? { status: 500 };
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    calls.push({ url, body: JSON.parse(rawBody) as RecordedCall["body"] });
    const payload = reply.content === undefined ? "{}" : chatBody(reply.content, reply.tokens ?? 0);
    return Promise.resolve(new Response(payload, { status: reply.status }));
  };
  return { fetchImpl, calls };
}

const DEPS: ChangePassDeps = { endpoint: "https://example.test/openai/v1", token: "t", model: "m" };

function findingLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    path: "src/consumer.ts",
    start_line: 0,
    end_line: 0,
    category: "bug",
    severity: "high",
    content: "Cover the producer's new field.\n\nThe consumer twin no longer covers it.",
    ...overrides,
  });
}

describe("summarizeDeclarations", () => {
  it("extracts a flat interface, a type alias, a function signature, and a typed const", () => {
    const source = [
      "export interface Widget {",
      "  readonly id: string;",
      "  readonly count: number;",
      "}",
      "",
      'export type WidgetStatus = "active" | "retired";',
      "",
      "export function describeWidget(widget: Widget, verbose: boolean): string {",
      '  return verbose ? widget.id : "";',
      "}",
      "",
      'export const DEFAULT_STATUS: WidgetStatus = "active";',
      "",
    ].join("\n");

    const summary = summarizeDeclarations([{ path: "src/widget.ts", source }]);

    expect(summary).toContain("src/widget.ts");
    expect(summary).toContain("interface Widget { readonly id: string; readonly count: number }");
    expect(summary).toContain('type WidgetStatus = "active" | "retired"');
    expect(summary).toContain("function describeWidget(widget: Widget, verbose: boolean): string");
    expect(summary).toContain("const DEFAULT_STATUS: WidgetStatus");
  });

  it("skips an interface that never closes, without losing declarations around it", () => {
    const source = [
      "export interface Broken {",
      "  readonly id: string;",
      "",
      'export type StillValid = "ok";',
      "",
    ].join("\n");

    const summary = summarizeDeclarations([{ path: "src/broken.ts", source }]);

    expect(summary).not.toContain("Broken");
    expect(summary).toContain('type StillValid = "ok"');
  });

  it("skips a non-exported declaration and an export-default declaration", () => {
    const source = [
      "interface NotExported {",
      "  readonly x: string;",
      "}",
      "",
      "export default function anonymous(): void {}",
      "",
      'export type Reachable = "yes";',
    ].join("\n");

    const summary = summarizeDeclarations([{ path: "src/mixed.ts", source }]);

    expect(summary).not.toContain("NotExported");
    expect(summary).not.toContain("anonymous");
    expect(summary).toContain('type Reachable = "yes"');
  });

  describe("bounds", () => {
    it("caps at 40 files, dropping the rest from the end with a marker", () => {
      const files: ChangedFile[] = Array.from({ length: 45 }, (_, i) => ({
        path: `src/f${String(i).padStart(2, "0")}.ts`,
        source: `export type T = "x";`,
      }));

      const summary = summarizeDeclarations(files);

      expect(summary).toContain("src/f00.ts");
      expect(summary).toContain("src/f39.ts");
      expect(summary).not.toContain("src/f40.ts");
      expect(summary).not.toContain("src/f44.ts");
      expect(summary).toContain("[truncated: 5 more files]");
    });

    it("caps at 30 declarations per file, noting the overflow inside that file's block", () => {
      const lines = Array.from({ length: 35 }, (_, i) => `export type T${String(i)} = "x";`);
      const summary = summarizeDeclarations([{ path: "src/many.ts", source: lines.join("\n") }]);

      expect(summary).toContain("type T0 = ");
      expect(summary).toContain("type T29 = ");
      expect(summary).not.toContain("type T30 = ");
      expect(summary).not.toContain("type T34 = ");
      expect(summary).toContain("[truncated: 5 more declarations]");
    });

    /**
     * The bound `shape-gate.ts` and `pin-desync.ts` already enforce against the same trust boundary
     * (candidate-controlled diff content) — this pins that `extractDeclarations` closes the one gap
     * where it had not: a source past either limit degrades to no declarations rather than forcing
     * the per-declaration scan to repeat its own bounded search across an effectively unbounded file.
     */
    it("degrades to no declarations for a source past the line-count bound, instead of scanning it unbounded", () => {
      const lines = Array.from({ length: 4001 }, (_, i) => `export type T${String(i)} = "x";`);
      // A file contributing zero declarations is dropped from the summary entirely — the same
      // treatment a file with no exported declarations at all already gets — so the whole-summary
      // shape (empty here, since this is the only file) is the observable proof of the degradation.
      const summary = summarizeDeclarations([{ path: "src/huge.ts", source: lines.join("\n") }]);

      expect(summary).toBe("");
    });

    it("degrades to no declarations for a source past the char-count bound, instead of scanning it unbounded", () => {
      const source = `export type T = "${"a".repeat(2_000_001)}";`;
      const summary = summarizeDeclarations([{ path: "src/huge.ts", source }]);

      expect(summary).toBe("");
    });

    it("still contributes its declarations normally when a huge file sits alongside an ordinary one", () => {
      const lines = Array.from({ length: 4001 }, (_, i) => `export type T${String(i)} = "x";`);
      const summary = summarizeDeclarations([
        { path: "src/huge.ts", source: lines.join("\n") },
        { path: "src/normal.ts", source: 'export type Status = "active" | "retired";' },
      ]);

      expect(summary).not.toContain("src/huge.ts");
      expect(summary).toContain("src/normal.ts");
      expect(summary).toContain("type Status");
    });

    it("truncates a type alias's right-hand side at 200 characters", () => {
      const rhs = `"${"a".repeat(400)}"`;
      const summary = summarizeDeclarations([
        { path: "src/long.ts", source: `export type Long = ${rhs};` },
      ]);
      const match = /type Long = (.*)$/m.exec(summary);
      expect(match?.[1]).toBeDefined();
      expect(match?.[1]?.length).toBeLessThanOrEqual(200);
    });

    it("caps the total summary at 6000 characters, dropping whole files from the end", () => {
      // 40 files (already at the file cap) with a large-but-not-alias-truncated declaration each,
      // so the total comfortably exceeds 6000 and only the char bound is under test here.
      const bigRhs = `"${"a".repeat(148)}"`; // 150 chars, under the 200-char alias cap
      const files: ChangedFile[] = Array.from({ length: 40 }, (_, i) => ({
        path: `src/big${String(i).padStart(2, "0")}.ts`,
        source: `export type X = ${bigRhs};`,
      }));

      const summary = summarizeDeclarations(files);

      expect(summary.length).toBeLessThanOrEqual(6000);
      expect(summary).toContain("src/big00.ts");
      expect(summary).not.toContain("src/big39.ts");
      const match = /\[truncated: (\d+) more files]/.exec(summary);
      expect(match).not.toBeNull();
      expect(Number(match?.[1] ?? "0")).toBeGreaterThan(0);
    });
  });

  it("returns the empty string for zero files", () => {
    expect(summarizeDeclarations([])).toBe("");
  });

  it("returns the empty string when no file yields a recognisable exported declaration", () => {
    const summary = summarizeDeclarations([
      { path: "src/empty.ts", source: "const internal = 1;\nfunction helper() {}\n" },
    ]);
    expect(summary).toBe("");
  });
});

describe("buildChangePassPrompt", () => {
  it("embeds the summary alongside the fixed instructions", () => {
    const prompt = buildChangePassPrompt("src/a.ts\n  interface Foo { x: string }");
    expect(prompt).toContain("Report ONLY");
    expect(prompt).toContain('"path": consumer-file');
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("interface Foo { x: string }");
  });

  it("keeps the fixed instructional text at or under 1200 characters", () => {
    expect(buildChangePassPrompt("").trimEnd().length).toBeLessThanOrEqual(1200);
  });
});

describe("runChangePass", () => {
  const FILES: ChangedFile[] = [
    {
      path: "src/producer.ts",
      source: "export interface Shape {\n  readonly kind: string;\n}\n",
    },
  ];

  it("short-circuits without any fetch call for an empty file list", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const outcome = await runChangePass([], { ...DEPS, fetchImpl });
    expect(outcome).toEqual({ findings: [], tokens: 0 });
    expect(calls).toHaveLength(0);
  });

  it("short-circuits without any fetch call when nothing summarizable is given", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const outcome = await runChangePass([{ path: "src/empty.ts", source: "const x = 1;" }], {
      ...DEPS,
      fetchImpl,
    });
    expect(outcome).toEqual({ findings: [], tokens: 0 });
    expect(calls).toHaveLength(0);
  });

  it("parses, validates, and returns findings from a clean JSONL reply, counting tokens", async () => {
    const reply = [
      findingLine({ path: "src/consumer.ts" }),
      findingLine({ path: "src/other.ts", category: "maintainability", severity: "medium" }),
    ].join("\n");
    const { fetchImpl, calls } = fakeFetch([{ status: 200, content: reply, tokens: 456 }]);

    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });

    expect(outcome.tokens).toBe(456);
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.findings[0]).toMatchObject({
      path: "src/consumer.ts",
      startLine: 0,
      endLine: 0,
      category: "bug",
      severity: "high",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.test/openai/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("m");
    expect(calls[0]?.body.seed).toBe(42);
  });

  it("recovers a finding after leading prose the model was not asked to add", async () => {
    const reply = `I reviewed the summary and found one cross-file issue.\n${findingLine()}`;
    const { fetchImpl } = fakeFetch([{ status: 200, content: reply, tokens: 200 }]);

    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.tokens).toBe(200);
  });

  it("reads a single compact JSON array reply, not just one-object-per-line", async () => {
    const reply = `[${findingLine({ path: "src/a.ts" })},${findingLine({ path: "src/b.ts" })}]`;
    const { fetchImpl } = fakeFetch([{ status: 200, content: reply, tokens: 300 }]);

    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });

    expect(outcome.findings).toHaveLength(2);
  });

  it("treats the literal [] reply as no findings", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, content: "[]", tokens: 50 }]);
    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });
    expect(outcome).toEqual({ findings: [], tokens: 50 });
  });

  it("returns no findings but still counts tokens for a garbage reply", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, content: "This is not JSON in any shape.", tokens: 123 },
    ]);
    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });
    expect(outcome).toEqual({ findings: [], tokens: 123 });
  });

  it("never throws on a non-OK response, returning zero findings and zero tokens", async () => {
    const { fetchImpl } = fakeFetch([{ status: 500 }]);
    await expect(runChangePass(FILES, { ...DEPS, fetchImpl })).resolves.toEqual({
      findings: [],
      tokens: 0,
    });
  });

  it("never throws when the fetch implementation itself throws", async () => {
    const throwingFetch: typeof fetch = () => {
      throw new Error("network is down");
    };
    await expect(runChangePass(FILES, { ...DEPS, fetchImpl: throwingFetch })).resolves.toEqual({
      findings: [],
      tokens: 0,
    });
  });

  it("caps at 10 findings when the reply reports 11", async () => {
    const lines = Array.from({ length: 11 }, (_, i) =>
      findingLine({ path: `src/f${String(i)}.ts` }),
    );
    const { fetchImpl } = fakeFetch([{ status: 200, content: lines.join("\n"), tokens: 999 }]);

    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });

    expect(outcome.findings).toHaveLength(10);
    expect(outcome.tokens).toBe(999);
  });

  it("drops a candidate with a category outside the closed vocabulary", async () => {
    const reply = [
      findingLine({ path: "src/valid.ts" }),
      findingLine({ path: "src/invalid.ts", category: "nonsense" }),
    ].join("\n");
    const { fetchImpl } = fakeFetch([{ status: 200, content: reply, tokens: 10 }]);

    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.path).toBe("src/valid.ts");
  });

  it("drops a candidate with a severity outside the closed vocabulary", async () => {
    const reply = findingLine({ severity: "catastrophic" });
    const { fetchImpl } = fakeFetch([{ status: 200, content: reply, tokens: 10 }]);
    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });
    expect(outcome.findings).toHaveLength(0);
  });

  it("drops a candidate whose content exceeds the shared engine finding bound", async () => {
    const reply = findingLine({ content: "a".repeat(ENGINE_RESULT_LIMITS.maxBodyChars + 1) });
    const { fetchImpl } = fakeFetch([{ status: 200, content: reply, tokens: 10 }]);
    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });
    expect(outcome.findings).toHaveLength(0);
  });

  it("drops a candidate whose path fails repository-path validation", async () => {
    const reply = findingLine({ path: "/etc/passwd" });
    const { fetchImpl } = fakeFetch([{ status: 200, content: reply, tokens: 10 }]);
    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });
    expect(outcome.findings).toHaveLength(0);
  });

  it("anchors every published finding at (0, 0) regardless of what the model sent", async () => {
    const reply = findingLine({ start_line: 47, end_line: 52 });
    const { fetchImpl } = fakeFetch([{ status: 200, content: reply, tokens: 10 }]);
    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ startLine: 0, endLine: 0 });
  });

  it("ignores non-object entries in an array reply instead of throwing", async () => {
    const reply = JSON.stringify(["just a string", 42, null, JSON.parse(findingLine())]);
    const { fetchImpl } = fakeFetch([{ status: 200, content: reply, tokens: 10 }]);
    const outcome = await runChangePass(FILES, { ...DEPS, fetchImpl });
    expect(outcome.findings).toHaveLength(1);
  });
});
