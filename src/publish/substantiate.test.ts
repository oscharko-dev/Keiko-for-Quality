import { describe, expect, it } from "vitest";

import {
  buildDossier,
  extractVerdict,
  needsJudging,
  substantiate,
  type JudgeEndpoint,
  type JudgeableFinding,
} from "./substantiate.js";

const HUNK = "-  await sleep(delay * 1000);\n+  await sleep(delay);";

function finding(content: string): JudgeableFinding {
  return { path: "src/backoff.ts", content, startLine: 3, endLine: 3 };
}

/**
 * The judge is one `fetch` away, so every semantic branch is exercised by scripting replies. The
 * queue is asserted empty at the end of the cases that care, because "the stage stopped calling"
 * and "the stage called and ignored the answer" look identical in a counter otherwise.
 */
/** A scripted reply, or the sentinel that makes the call fail at the transport. */
const TRANSPORT_FAIL = Symbol("transport-fail");

function endpointReplying(replies: readonly (string | typeof TRANSPORT_FAIL)[]): {
  deps: JudgeEndpoint;
  remaining: () => number;
} {
  const queue = [...replies];
  const deps: JudgeEndpoint = {
    endpoint: "https://models.test/v1",
    token: "t",
    model: "gpt-oss-120b",
    fetchImpl: ((): Promise<Response> => {
      const next = queue.shift();
      if (next === undefined || next === TRANSPORT_FAIL) {
        return Promise.reject(new Error("transport"));
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: next } }],
            usage: { total_tokens: 100 },
          }),
      } as unknown as Response);
    }) as typeof fetch,
  };
  return { deps, remaining: () => queue.length };
}

const GROUNDED = '{"verdict":"grounded"}';
const VAGUE = '{"verdict":"vague"}';
const UNSUPPORTED = '{"verdict":"unsupported"}';

describe("buildDossier", () => {
  it("sees a circumstance stated at the opening of the prose", () => {
    const dossier = buildDossier(
      "**Convert to milliseconds.**\n\nWhen the header carries a bare number, the delay is 1000× short.",
    );
    expect(dossier.namesCircumstance).toBe(true);
  });

  /**
   * The distinction the production measurement rests on: a circumstance named inside the REMEDY is
   * not the claim opening on a circumstance. Ours read this way and the competitor's do not.
   */
  it("does not count a circumstance named inside the remedy", () => {
    const dossier = buildDossier(
      "**Restore the default construction when no port is present.** This change makes it depend on deps.",
    );
    expect(dossier.namesCircumstance).toBe(false);
  });

  it("counts a backticked symbol as a location a reader can open", () => {
    expect(buildDossier("The guard in `composeConnectors` is gone.").namesLocation).toBe(true);
    expect(buildDossier("The route's construction changed shape.").namesLocation).toBe(false);
  });

  it("recognises a body that is only the hunk written back", () => {
    expect(
      buildDossier("+  const x = compute(a, b);\n-  const x = compute(b, a);").isDiffEcho,
    ).toBe(true);
    expect(buildDossier("When x is zero, compute throws.").isDiffEcho).toBe(false);
  });

  /** Collapsed agent blocks and fenced code are furniture, never the claim. */
  it("ignores the collapsed prompt block and fenced code", () => {
    const body =
      "**Rename it.** This renames `foo`.\n\n```js\nif (x) { return }\n```\n" +
      "<details><summary>Prompt</summary>When acting on this, verify it.</details>";
    expect(buildDossier(body).namesCircumstance).toBe(false);
  });
});

describe("needsJudging", () => {
  it("spends no call on a body with no claim in it", () => {
    expect(needsJudging(buildDossier("+  const x = 1;\n-  const x = 2;"))).toBe(false);
  });

  /**
   * The asymmetry that keeps the shape check honest. A dossier that looks complete still goes to
   * the judge: "When the function is called, …" satisfies the regex and says nothing, and a rule
   * that shows the model a `When` example invites exactly that. Shape routes; it never decides.
   */
  it("still judges a finding whose shape already looks complete", () => {
    expect(
      needsJudging(buildDossier("When the header is numeric, `sleep` waits 1000× too little.")),
    ).toBe(true);
  });
});

describe("extractVerdict", () => {
  it("reads the closed vocabulary and nothing else", () => {
    expect(extractVerdict(GROUNDED)).toBe("grounded");
    expect(extractVerdict('prose then {"verdict":"unsupported"} after')).toBe("unsupported");
  });

  it("returns undefined rather than guessing at a word outside the vocabulary", () => {
    expect(extractVerdict('{"verdict":"probably"}')).toBeUndefined();
    expect(extractVerdict("grounded")).toBeUndefined();
    expect(extractVerdict(undefined)).toBeUndefined();
  });
});

describe("substantiate", () => {
  it("publishes a grounded finding on one call", async () => {
    const { deps, remaining } = endpointReplying([GROUNDED]);

    const out = await substantiate(
      [finding("When the header is numeric, the wait is 1000× short.")],
      () => HUNK,
      deps,
    );

    expect(out.findings).toHaveLength(1);
    expect(out.repaired).toBe(0);
    expect(out.tokens).toBe(100);
    expect(remaining()).toBe(0);
  });

  /**
   * The loop earning its place. Without it a strict judge buys precision with recall: the defect
   * was real and only its presentation failed, so the finding that reaches the reader is the
   * REWRITE, not the original.
   */
  it("repairs a vague finding and publishes the rewrite", async () => {
    const rewritten =
      "**Convert to milliseconds.**\n\nWhen the header is a bare number, the wait is 1000× short.";
    const { deps, remaining } = endpointReplying([VAGUE, rewritten, GROUNDED]);

    const out = await substantiate(
      [finding("This makes the delay depend on the parsed value.")],
      () => HUNK,
      deps,
    );

    expect(out.findings[0]?.content).toBe(rewritten);
    expect(out.repaired).toBe(1);
    expect(out.tokens).toBe(300);
    expect(remaining()).toBe(0);
  });

  it("drops a finding that is still vague after its one repair", async () => {
    const { deps } = endpointReplying([VAGUE, "still says nothing about when", VAGUE]);

    const out = await substantiate([finding("This changes the delay.")], () => HUNK, deps);

    expect(out.findings).toHaveLength(0);
    expect(out.droppedVague).toBe(1);
  });

  /** WITHDRAW is the model declining to invent a circumstance — the outcome the prompt asks for. */
  it("drops a finding the repair withdraws rather than fabricating a condition", async () => {
    const { deps, remaining } = endpointReplying([VAGUE, "WITHDRAW"]);

    const out = await substantiate([finding("This changes the delay.")], () => HUNK, deps);

    expect(out.findings).toHaveLength(0);
    expect(out.droppedVague).toBe(1);
    // No third call: a withdrawal is final, and re-judging nothing would be a wasted round trip.
    expect(remaining()).toBe(0);
  });

  /**
   * `unsupported` is never repaired. Rewording a claim the code contradicts makes it more
   * persuasive, not more true — the one way this stage could actively make the reviewer worse.
   */
  it("drops an unsupported finding without offering it a rewrite", async () => {
    const { deps, remaining } = endpointReplying([UNSUPPORTED]);

    const out = await substantiate(
      [finding("The call never awaits its promise.")],
      () => HUNK,
      deps,
    );

    expect(out.findings).toHaveLength(0);
    expect(out.droppedUnsupported).toBe(1);
    expect(remaining()).toBe(0);
  });

  /**
   * The direction every failure has to fall. This stage removes findings a reader cannot check; one
   * it FAILED to judge is not among them, and dropping it would let an outage read as a quality
   * improvement in the run summary.
   */
  it("keeps a finding when the judge cannot be reached", async () => {
    const { deps } = endpointReplying([TRANSPORT_FAIL]);

    const out = await substantiate([finding("When x is zero, compute throws.")], () => HUNK, deps);

    expect(out.findings).toHaveLength(1);
    expect(out.undecided).toBe(1);
  });

  it("keeps a finding when the reply is not one of the three words", async () => {
    const { deps } = endpointReplying(['{"verdict":"maybe"}']);

    const out = await substantiate([finding("When x is zero, compute throws.")], () => HUNK, deps);

    expect(out.findings).toHaveLength(1);
    expect(out.undecided).toBe(1);
  });

  /** An unreadable hunk is this module's own failure, and costs nothing and nobody a finding. */
  it("keeps a finding whose code could not be read, without calling the judge", async () => {
    const { deps, remaining } = endpointReplying([GROUNDED]);

    const out = await substantiate([finding("When x is zero, compute throws.")], () => "", deps);

    expect(out.findings).toHaveLength(1);
    expect(out.undecided).toBe(1);
    expect(out.tokens).toBe(0);
    expect(remaining()).toBe(1);
  });

  /**
   * An inconclusive RE-read keeps the original rather than the rewrite. The rewrite was never
   * confirmed, and publishing it anyway would be this stage inventing text under its own authority.
   */
  it("falls back to the original when the re-judge is inconclusive", async () => {
    const original = "This changes the delay.";
    const { deps } = endpointReplying([VAGUE, "a rewrite nobody confirmed", TRANSPORT_FAIL]);

    const out = await substantiate([finding(original)], () => HUNK, deps);

    expect(out.findings[0]?.content).toBe(original);
    expect(out.undecided).toBe(1);
    expect(out.repaired).toBe(0);
  });

  it("spends nothing on a diff echo and leaves it for the sanitizer", async () => {
    const { deps, remaining } = endpointReplying([GROUNDED]);

    const out = await substantiate([finding("+  const x = compute(a, b);")], () => HUNK, deps);

    expect(out.findings).toHaveLength(1);
    expect(out.tokens).toBe(0);
    expect(remaining()).toBe(1);
  });

  it("tallies a mixed batch without losing a finding to the accounting", async () => {
    const { deps } = endpointReplying([GROUNDED, UNSUPPORTED, VAGUE, "rewritten body", GROUNDED]);

    const out = await substantiate(
      [finding("When a, b."), finding("Never awaits."), finding("This changes things.")],
      () => HUNK,
      deps,
    );

    expect(out.findings).toHaveLength(2);
    expect(out.repaired).toBe(1);
    expect(out.droppedUnsupported).toBe(1);
    expect(out.droppedVague).toBe(0);
    expect(out.undecided).toBe(0);
    expect(out.tokens).toBe(500);
  });
});
