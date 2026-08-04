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
  readonly body: { model: string; messages: readonly { content: string }[]; seed: number };
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

  // Reasoning models often open with a `{` of their own before the real answer — quoting the
  // input, thinking aloud. Anchoring on the FIRST brace (as this parser once did) means every
  // candidate has to swallow that preamble AND the real object AND the prose between them, which
  // never parses, so the whole reply reads as unparseable even though a valid object is right
  // there at the end.
  it("finds the JSON object after brace-bearing reasoning prose, without needing the retry", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        status: 200,
        content:
          'The user says {ignore this brace} but here is the answer: {"category":"bug","severity":"high"}',
        tokens: 75,
      },
    ]);
    const outcome = await repairClassification([finding()], { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "bug", severity: "high" });
    expect(outcome).toMatchObject({ repaired: 1, failed: 0, tokens: 75 });
    // One call, not two: the fix finds the trailing object on the FIRST attempt, so the stern
    // retry this scenario used to force is never spent.
    expect(calls).toHaveLength(1);
  });

  it("still falls through to the stern retry when no candidate parses despite braces present", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: "{not valid json} still {not valid either}", tokens: 30 },
      { status: 200, content: '{"category":"bug","severity":"medium"}', tokens: 60 },
    ]);
    const outcome = await repairClassification([finding()], { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "bug", severity: "medium" });
    expect(outcome).toMatchObject({ repaired: 1, failed: 0, tokens: 90 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.messages[0]?.content).toContain("previous reply");
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
  it("adopts when two votes agree, without spending the third call", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: '{"category":"security","severity":"critical"}', tokens: 120 },
      { status: 200, content: '{"category":"security","severity":"critical"}', tokens: 110 },
    ]);
    const input = [finding({ category: "security", severity: "high" })];
    const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "security", severity: "critical" });
    expect(outcome).toMatchObject({ changed: 1, tokens: 230 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.messages[0]?.content).toContain("Audit the classification");
  });

  it("takes the fast path when vote 1 already matches the existing pair — a true high stays high on one call", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: '{"category":"test","severity":"high"}', tokens: 80 },
    ]);
    const input = [finding({ category: "test", severity: "high" })];
    const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toBe(input[0]);
    expect(outcome).toMatchObject({ changed: 0, tokens: 80 });
    // Exactly one call: vote 1 confirmed the existing pair, so votes 2 and 3 are never spent.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.seed).toBe(42);
  });

  it("adopts the pair two of three votes named on a 2-1 split", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: '{"category":"bug","severity":"high"}', tokens: 50 },
      { status: 200, content: '{"category":"bug","severity":"critical"}', tokens: 50 },
      { status: 200, content: '{"category":"bug","severity":"high"}', tokens: 50 },
    ]);
    const input = [finding({ category: "bug", severity: "medium" })];
    const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "bug", severity: "high" });
    expect(outcome).toMatchObject({ changed: 1, tokens: 150 });
    expect(calls).toHaveLength(3);
  });

  it("escalates past a disagreeing vote 1 and adopts the pair votes 2 and 3 agree on", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: '{"category":"security","severity":"critical"}', tokens: 40 },
      { status: 200, content: '{"category":"maintainability","severity":"low"}', tokens: 40 },
      { status: 200, content: '{"category":"maintainability","severity":"low"}', tokens: 40 },
    ]);
    const input = [finding({ category: "bug", severity: "medium" })];
    const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toMatchObject({ category: "maintainability", severity: "low" });
    expect(outcome).toMatchObject({ changed: 1, tokens: 120 });
    // All three seeds fire: vote 1 disagrees with both the existing pair and vote 2, so only
    // vote 3 — agreeing with vote 2 — settles the majority.
    expect(calls).toHaveLength(3);
    expect(calls[0]?.body.seed).toBe(42);
    expect(calls[1]?.body.seed).toBe(43);
    expect(calls[2]?.body.seed).toBe(44);
  });

  it("keeps the original when three votes disagree — that spread is a genuine close call", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, content: '{"category":"bug","severity":"high"}' },
      { status: 200, content: '{"category":"bug","severity":"medium"}' },
      { status: 200, content: '{"category":"maintainability","severity":"low"}' },
    ]);
    const input = [finding({ category: "bug", severity: "low" })];
    const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
    expect(outcome.findings[0]).toBe(input[0]);
    expect(outcome.changed).toBe(0);
    // Vote 1 ("high") disagrees with the existing pair ("low"), so it escalates all the way
    // through votes 2 and 3 before the three-way spread gives up on a verdict.
    expect(calls).toHaveLength(3);
  });

  it("keeps the original when the replies are invalid — the audit never destroys", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, content: "not json at all" },
      { status: 500 },
      { status: 200, content: "still nothing" },
    ]);
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

  describe("a lost vote is retried once, but only when the transport itself failed", () => {
    it("recovers a vote that fails transport once and then succeeds on the same-seed retry", async () => {
      const { fetchImpl, calls } = fakeFetch([
        { status: 500 },
        { status: 200, content: '{"category":"security","severity":"critical"}', tokens: 90 },
        { status: 200, content: '{"category":"security","severity":"critical"}', tokens: 90 },
      ]);
      const input = [finding({ category: "security", severity: "high" })];
      const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
      expect(outcome.findings[0]).toMatchObject({ category: "security", severity: "critical" });
      expect(outcome).toMatchObject({ changed: 1, tokens: 180 });
      // 3 calls, not 2: the first vote cost a failed attempt plus its retry before it landed.
      expect(calls).toHaveLength(3);
      expect(calls[0]?.body.seed).toBe(42);
      expect(calls[1]?.body.seed).toBe(42); // the retry recovers the SAME vote, same seed
      expect(calls[2]?.body.seed).toBe(43); // the next vote proceeds normally afterwards
    });

    it("takes the fast path after vote 1's transport retry recovers and agrees with the existing pair", async () => {
      const { fetchImpl, calls } = fakeFetch([
        { status: 500 },
        { status: 200, content: '{"category":"security","severity":"critical"}', tokens: 90 },
      ]);
      const input = [finding({ category: "security", severity: "critical" })];
      const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
      expect(outcome.findings[0]).toBe(input[0]);
      expect(outcome).toMatchObject({ changed: 0, tokens: 90 });
      // 2 calls total — the failed attempt plus its same-seed retry — and nothing beyond: the
      // recovered vote 1 still matches the existing pair, so the fast path still applies and
      // votes 2 and 3 are never spent.
      expect(calls).toHaveLength(2);
      expect(calls[0]?.body.seed).toBe(42);
      expect(calls[1]?.body.seed).toBe(42);
    });

    it("gives up on a vote after its retry also fails transport, without a third attempt", async () => {
      const { fetchImpl, calls } = fakeFetch([
        { status: 500 },
        { status: 500 },
        { status: 200, content: '{"category":"bug","severity":"high"}', tokens: 40 },
        { status: 200, content: '{"category":"bug","severity":"high"}', tokens: 40 },
      ]);
      const input = [finding({ category: "bug", severity: "medium" })];
      const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
      expect(outcome.findings[0]).toMatchObject({ category: "bug", severity: "high" });
      expect(outcome.changed).toBe(1);
      // 4 calls: 2 for the first (permanently lost) vote, 1 each for the two that decided it —
      // never a third attempt at the first vote.
      expect(calls).toHaveLength(4);
      expect(calls[0]?.body.seed).toBe(42);
      expect(calls[1]?.body.seed).toBe(42);
      expect(calls[2]?.body.seed).toBe(43);
      expect(calls[3]?.body.seed).toBe(44);
    });

    it("does not retry a vote whose transport succeeded but whose content was invalid", async () => {
      const { fetchImpl, calls } = fakeFetch([
        { status: 200, content: "not json at all" },
        { status: 200, content: '{"category":"bug","severity":"high"}', tokens: 50 },
        { status: 200, content: '{"category":"bug","severity":"high"}', tokens: 50 },
      ]);
      const input = [finding({ category: "bug", severity: "medium" })];
      const outcome = await auditClassification(input, { ...DEPS, fetchImpl });
      expect(outcome.findings[0]).toMatchObject({ category: "bug", severity: "high" });
      // 3 calls, one per vote: a content failure is the model's real (bad) answer, not a lost
      // call, so it is never retried — a 4th call here would mean the fix over-retried.
      expect(calls).toHaveLength(3);
      expect(calls[0]?.body.seed).toBe(42);
      expect(calls[1]?.body.seed).toBe(43);
      expect(calls[2]?.body.seed).toBe(44);
    });
  });
});
