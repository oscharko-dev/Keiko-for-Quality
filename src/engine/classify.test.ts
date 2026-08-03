import { describe, expect, it } from "vitest";

import {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  auditClassification,
  needsClassification,
  repairClassification,
  type ClassifiableFinding,
} from "./classify.js";

interface CannedReply {
  readonly status: number;
  readonly content?: string;
  readonly tokens?: number;
}

interface RecordedCall {
  readonly url: string;
  readonly body: { model: string; messages: readonly { content: string }[] };
}

function chatBody(content: string, tokens: number): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { total_tokens: tokens },
  });
}

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

function finding(overrides: Partial<ClassifiableFinding> = {}): ClassifiableFinding {
  return {
    path: "src/db.ts",
    content: "Building the query out of caller-controlled text allows injection.",
    category: undefined,
    severity: undefined,
    ...overrides,
  };
}

const DEPS = { endpoint: "https://example.test/openai/v1", token: "t", model: "m" };

describe("needsClassification", () => {
  it("is false only when both fields carry vocabulary values", () => {
    expect(needsClassification(finding({ category: "security", severity: "critical" }))).toBe(
      false,
    );
    expect(needsClassification(finding())).toBe(true);
    expect(needsClassification(finding({ category: "security" }))).toBe(true);
    expect(needsClassification(finding({ severity: "critical" }))).toBe(true);
  });

  it("treats out-of-vocabulary values as unclassified rather than trusting them", () => {
    expect(needsClassification(finding({ category: "Bug", severity: "critical" }))).toBe(true);
    expect(needsClassification(finding({ category: "bug", severity: "blocker" }))).toBe(true);
  });
});

describe("repairClassification", () => {
  it("leaves classified findings untouched and never calls the model for them", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const input = [finding({ category: "bug", severity: "high" })];
    const outcome = await repairClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toBe(input[0]);
    expect(outcome).toMatchObject({ repaired: 0, failed: 0, tokens: 0 });
    expect(calls).toHaveLength(0);
  });

  it("repairs a missing classification from the first attempt and counts its tokens", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: '{"category":"security","severity":"critical"}', tokens: 180 },
    ]);
    const outcome = await repairClassification([finding()], { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "security", severity: "critical" });
    expect(outcome).toMatchObject({ repaired: 1, failed: 0, tokens: 180 });
    expect(calls[0]?.url).toBe("https://example.test/openai/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("m");
  });

  it("parses a reply that prefixes the JSON with a channel marker", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, content: 'final{"category":"bug","severity":"high"}', tokens: 90 },
    ]);
    const outcome = await repairClassification([finding()], { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "bug", severity: "high" });
    expect(outcome.repaired).toBe(1);
  });

  it("retries once with a sterner prompt and sums tokens across both attempts", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: "I would classify this as severe.", tokens: 40 },
      { status: 200, content: '{"category":"bug","severity":"medium"}', tokens: 60 },
    ]);
    const outcome = await repairClassification([finding()], { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "bug", severity: "medium" });
    expect(outcome).toMatchObject({ repaired: 1, failed: 0, tokens: 100 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.messages[0]?.content).toContain("previous reply");
  });

  it("rejects values outside the vocabularies instead of adopting them", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: '{"category":"style","severity":"critical"}' },
      { status: 200, content: '{"category":"maintainability","severity":"low"}' },
    ]);
    const outcome = await repairClassification([finding()], { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "maintainability", severity: "low" });
    expect(calls).toHaveLength(2);
  });

  it("leaves the finding untouched and visible in `failed` when both attempts miss", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, content: "no object here" }, { status: 500 }]);
    const input = [finding()];
    const outcome = await repairClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toBe(input[0]);
    expect(outcome).toMatchObject({ repaired: 0, failed: 1 });
  });

  it("treats a transport error as a failed attempt, never as a crash", async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error("boom"));
    const outcome = await repairClassification([finding()], { ...DEPS, fetchImpl });
    expect(outcome).toMatchObject({ repaired: 0, failed: 1, tokens: 0 });
  });

  it("repairs only the findings that need it in a mixed list", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: '{"category":"test","severity":"low"}', tokens: 50 },
    ]);
    const classified = finding({ category: "security", severity: "high", path: "a.ts" });
    const outcome = await repairClassification([classified, finding({ path: "b.ts" })], {
      ...DEPS,
      fetchImpl,
    });
    expect(outcome.findings[0]).toBe(classified);
    expect(outcome.findings[1]).toMatchObject({ category: "test", severity: "low", path: "b.ts" });
    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ repaired: 1, failed: 0, tokens: 50 });
  });

  it("keeps the vocabularies closed — every list value round-trips, nothing else does", () => {
    for (const category of FINDING_CATEGORIES) {
      for (const severity of FINDING_SEVERITIES) {
        expect(needsClassification(finding({ category, severity }))).toBe(false);
      }
    }
  });
});

describe("auditClassification", () => {
  it("adopts a moved classification in either direction and counts it", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: '{"category":"security","severity":"critical"}', tokens: 120 },
    ]);
    const input = [finding({ category: "security", severity: "high" })];
    const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "security", severity: "critical" });
    expect(outcome).toMatchObject({ changed: 1, tokens: 120 });
    expect(calls[0]?.body.messages[0]?.content).toContain("Audit the classification");
  });

  it("keeps the original untouched when the audit confirms it — a true high stays high", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, content: '{"category":"test","severity":"high"}', tokens: 80 },
    ]);
    const input = [finding({ category: "test", severity: "high" })];
    const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toBe(input[0]);
    expect(outcome).toMatchObject({ changed: 0, tokens: 80 });
  });

  it("keeps the original when the audit reply is invalid — the audit never destroys", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, content: "not json at all" }]);
    const input = [finding({ category: "bug", severity: "medium" })];
    const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toBe(input[0]);
    expect(outcome.changed).toBe(0);
  });

  it("skips unclassified findings — those belong to the repair pass", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const input = [finding()];
    const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toBe(input[0]);
    expect(calls).toHaveLength(0);
  });
});
