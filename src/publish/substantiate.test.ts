import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDossier,
  buildFalsifierPrompt,
  buildTruthPrompt,
  extractEvidenceVerdict,
  extractFalsifierDecision,
  extractReflectionDecision,
  extractTruthDecision,
  extractVerdict,
  needsJudging,
  resolveSubstantiationStrictness,
  substantiate,
  type EvidenceRetriever,
  type JudgeEndpoint,
  type JudgeableFinding,
  type RetrievedEvidence,
  type RetrievedEvidenceChunk,
} from "./substantiate.js";

const CHANGE_EVIDENCE = [
  "HEAD (proposed code):",
  "H:2| export async function wait(delay: number) {",
  "H:3|   await sleep(delay);",
  "H:4| }",
  "",
  "BASE (before change):",
  "B:2| export async function wait(delay: number) {",
  "B:3|   await sleep(delay * 1000);",
  "B:4| }",
  "",
  "CHANGE (merge-base to HEAD):",
  "D:B:3| -  await sleep(delay * 1000);",
  "D:H:3| +  await sleep(delay);",
].join("\n");

const ADDED_EVIDENCE = [
  "HEAD (proposed code):",
  "H:8| export const timeout = parseInt(value);",
  "D:H:8| +export const timeout = parseInt(value);",
].join("\n");

const DELETED_EVIDENCE = [
  "BASE (before change):",
  "B:7| if (!ready) return;",
  "D:B:7| -if (!ready) return;",
].join("\n");

function finding(content: string): JudgeableFinding {
  return { path: "src/backoff.ts", content, startLine: 3, endLine: 3 };
}

interface TruthEnvelope {
  readonly verdict: "confirmed" | "refuted" | "needs_context";
  readonly reason_code:
    | "direct_proof"
    | "contradicted"
    | "already_handled"
    | "not_introduced"
    | "missing_definition"
    | "missing_caller"
    | "missing_contract"
    | "missing_runtime"
    | "missing_change_context";
  readonly evidence_refs: readonly string[];
  readonly lookup_terms: readonly string[];
}

interface FalsifierEnvelope {
  readonly verdict: "survives" | "defeated" | "needs_context";
  readonly reason_code:
    | "no_defeater_found"
    | "counterexample"
    | "existing_guard"
    | "unchanged_base"
    | "causality_unproven"
    | "missing_definition"
    | "missing_caller"
    | "missing_contract"
    | "missing_runtime"
    | "missing_change_context";
  readonly evidence_refs: readonly string[];
  readonly lookup_terms: readonly string[];
}

function truth(overrides: Partial<TruthEnvelope> = {}): string {
  return JSON.stringify({
    verdict: "confirmed",
    reason_code: "direct_proof",
    evidence_refs: ["D:H:3", "H:3"],
    lookup_terms: [],
    ...overrides,
  });
}

function falsifier(overrides: Partial<FalsifierEnvelope> = {}): string {
  return JSON.stringify({
    verdict: "survives",
    reason_code: "no_defeater_found",
    evidence_refs: ["D:H:3", "H:3"],
    lookup_terms: [],
    ...overrides,
  });
}

const CONFIRMED = truth();
const SURVIVES = falsifier();
const REFUTED = truth({
  verdict: "refuted",
  reason_code: "contradicted",
  evidence_refs: ["H:3"],
});
const NOT_INTRODUCED = truth({
  verdict: "refuted",
  reason_code: "not_introduced",
  evidence_refs: ["H:3", "B:3"],
});
const NEEDS_CALLER = truth({
  verdict: "needs_context",
  reason_code: "missing_caller",
  evidence_refs: ["H:3"],
  lookup_terms: ["wait"],
});
const FALSIFIER_NEEDS_CALLER = falsifier({
  verdict: "needs_context",
  reason_code: "missing_caller",
  evidence_refs: ["H:3"],
  lookup_terms: ["wait"],
});

const STRICTNESS_ENV_VAR = "KFQ_SUBSTANTIATION_STRICTNESS";
let savedStrictnessEnv: string | undefined;

beforeEach(() => {
  savedStrictnessEnv = process.env[STRICTNESS_ENV_VAR];
  Reflect.deleteProperty(process.env, STRICTNESS_ENV_VAR);
});

afterEach(() => {
  if (savedStrictnessEnv === undefined) Reflect.deleteProperty(process.env, STRICTNESS_ENV_VAR);
  else process.env[STRICTNESS_ENV_VAR] = savedStrictnessEnv;
});

const TRANSPORT_FAIL = Symbol("transport-fail");
interface ReplyWithUsage {
  readonly text: string;
  readonly totalTokens?: unknown;
  readonly omitUsage?: boolean;
  readonly finishReason?: unknown;
}
type ScriptedReply = string | typeof TRANSPORT_FAIL | ReplyWithUsage;

function endpointReplying(replies: readonly ScriptedReply[]): {
  readonly deps: JudgeEndpoint;
  readonly remaining: () => number;
  readonly completionLimits: () => readonly number[];
  readonly prompts: () => readonly string[];
} {
  const queue = [...replies];
  const limits: number[] = [];
  const capturedPrompts: string[] = [];
  const deps: JudgeEndpoint = {
    endpoint: "https://models.test/v1",
    token: "t",
    model: "gpt-oss-120b",
    fetchImpl: ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body !== "string") return Promise.reject(new Error("missing body"));
      const request = JSON.parse(init.body) as {
        readonly max_completion_tokens?: number;
        readonly messages?: readonly { readonly content?: string }[];
      };
      if (typeof request.max_completion_tokens === "number") {
        limits.push(request.max_completion_tokens);
      }
      const prompt = request.messages?.[0]?.content;
      if (typeof prompt === "string") capturedPrompts.push(prompt);

      const next = queue.shift();
      if (next === undefined || next === TRANSPORT_FAIL) {
        return Promise.reject(new Error("transport"));
      }
      const scripted = typeof next === "string" ? { text: next, totalTokens: 100 } : next;
      const usage =
        scripted.omitUsage === true ? {} : { usage: { total_tokens: scripted.totalTokens ?? 100 } };
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: scripted.text },
                finish_reason: scripted.finishReason ?? "stop",
              },
            ],
            ...usage,
          }),
      } as unknown as Response);
    }) as typeof fetch,
  };
  return {
    deps,
    remaining: () => queue.length,
    completionLimits: () => limits,
    prompts: () => capturedPrompts,
  };
}

function truthRequestUpperBound(candidate: JudgeableFinding, evidence = CHANGE_EVIDENCE): number {
  const prompt = buildTruthPrompt(candidate, evidence, buildDossier(candidate.content));
  return new TextEncoder().encode(prompt).byteLength + 2_304 + 512;
}

function retrievedCaller(): RetrievedEvidence {
  return {
    chunks: [
      {
        path: "src/caller.ts",
        side: "H",
        lines: [{ line: 9, text: "await wait(header.delay);" }],
      },
    ],
  };
}

describe("deterministic dossier", () => {
  it("recognises circumstances, locations, and pure diff echoes", () => {
    expect(buildDossier("When input is zero, `wait` throws.").namesCircumstance).toBe(true);
    expect(buildDossier("The guard in `wait` is gone.").namesLocation).toBe(true);
    expect(buildDossier("The route changed.").namesLocation).toBe(false);
    expect(needsJudging(buildDossier("+  const x = 1;\n-  const x = 2;"))).toBe(false);
  });
});

describe("role prompts", () => {
  it("separates truth from adversarial falsification and excludes importance/rewrite work", () => {
    const candidate = finding("When the header is numeric, the wait is 1000× short.");
    const truthPrompt = buildTruthPrompt(
      candidate,
      CHANGE_EVIDENCE,
      buildDossier(candidate.content),
    );
    const decision = extractTruthDecision(CONFIRMED, CHANGE_EVIDENCE);
    expect(decision).toBeDefined();
    const falsifierPrompt = buildFalsifierPrompt(candidate, CHANGE_EVIDENCE, decision!);

    expect(truthPrompt).toContain("A matching excerpt alone is not positive proof");
    expect(truthPrompt).toContain("D:H");
    expect(truthPrompt).toContain("needs_context");
    expect(falsifierPrompt).toContain("Adversarially falsify");
    expect(falsifierPrompt).toContain("existing guard");
    for (const prompt of [truthPrompt, falsifierPrompt]) {
      expect(prompt).toContain("Do not judge importance");
      expect(prompt).not.toContain("Rewrite one code-review finding");
      expect(prompt).not.toContain("nitpick");
    }
  });
});

describe("strict truth envelope", () => {
  it("accepts positive state plus exact change proof, including added and deleted lines", () => {
    expect(extractTruthDecision(CONFIRMED, CHANGE_EVIDENCE)).toEqual({
      verdict: "confirmed",
      reasonCode: "direct_proof",
      evidenceRefs: ["D:H:3", "H:3"],
      lookupTerms: [],
    });
    expect(
      extractTruthDecision(truth({ evidence_refs: ["D:H:8", "H:8"] }), ADDED_EVIDENCE)?.verdict,
    ).toBe("confirmed");
    expect(
      extractTruthDecision(truth({ evidence_refs: ["D:B:7", "B:7"] }), DELETED_EVIDENCE)?.verdict,
    ).toBe("confirmed");
    expect(extractEvidenceVerdict(CONFIRMED, CHANGE_EVIDENCE)).toBe("confirmed");
    expect(extractReflectionDecision(CONFIRMED, CHANGE_EVIDENCE)).toBeDefined();
  });

  it("does not treat H+B consistency as PR-causality proof", () => {
    const noChangeRef = truth({ evidence_refs: ["H:3", "B:3"] });
    expect(extractTruthDecision(noChangeRef, CHANGE_EVIDENCE)).toBeUndefined();
    expect(
      extractTruthDecision(truth({ evidence_refs: ["D:H:3", "H:2"] }), CHANGE_EVIDENCE),
    ).toBeUndefined();
  });

  it("accepts refuted and bounded needs-context decisions", () => {
    expect(extractTruthDecision(REFUTED, CHANGE_EVIDENCE)?.verdict).toBe("refuted");
    expect(extractTruthDecision(NOT_INTRODUCED, CHANGE_EVIDENCE)?.reasonCode).toBe(
      "not_introduced",
    );
    expect(extractTruthDecision(NEEDS_CALLER, CHANGE_EVIDENCE)?.lookupTerms).toEqual(["wait"]);
  });

  it("rejects prose, repair, extra keys, fabricated refs, and unsafe/unbounded lookups", () => {
    const extra = JSON.stringify({ ...JSON.parse(CONFIRMED), explanation: "trust me" });
    const invalid = [
      `reasoning first\n${CONFIRMED}`,
      '{verdict:"confirmed"}',
      extra,
      CONFIRMED.replace('{"verdict":"confirmed",', '{"verdict":"refuted","verdict":"confirmed",'),
      truth({ evidence_refs: ["D:H:999", "H:3"] }),
      truth({ evidence_refs: ["D:H:3", "D:H:3", "H:3"] }),
      truth({
        verdict: "needs_context",
        reason_code: "missing_caller",
        evidence_refs: ["H:3"],
        lookup_terms: ["../secret", "a", "b", "c"],
      }),
      truth({
        verdict: "needs_context",
        reason_code: "missing_caller",
        evidence_refs: ["H:3"],
        lookup_terms: ["src/caller.ts"],
      }),
      truth({
        verdict: "needs_context",
        reason_code: "missing_caller",
        evidence_refs: ["H:3"],
        lookup_terms: ["value"],
      }),
      truth({
        verdict: "needs_context",
        reason_code: "missing_caller",
        evidence_refs: ["H:3"],
        lookup_terms: ["ab"],
      }),
      truth({
        verdict: "confirmed",
        reason_code: "direct_proof",
        lookup_terms: ["wait"],
      }),
    ];
    for (const reply of invalid) {
      expect(extractTruthDecision(reply, CHANGE_EVIDENCE)).toBeUndefined();
    }
  });

  it("keeps tolerant extraction outside the live trust boundary", () => {
    const reply = 'not {"verdict":"confirmed"}; final {"verdict":"needs_context"}';
    expect(extractVerdict(reply)).toBe("needs_context");
    expect(extractTruthDecision(reply, CHANGE_EVIDENCE)).toBeUndefined();
  });
});

describe("strict falsifier envelope", () => {
  it("accepts a surviving proof and a cited defeater", () => {
    expect(extractFalsifierDecision(SURVIVES, CHANGE_EVIDENCE)?.verdict).toBe("survives");
    const defeated = falsifier({
      verdict: "defeated",
      reason_code: "existing_guard",
      evidence_refs: ["H:2"],
    });
    expect(extractFalsifierDecision(defeated, CHANGE_EVIDENCE)?.verdict).toBe("defeated");
  });

  it("rejects a persuasive survives answer without exact change proof", () => {
    expect(
      extractFalsifierDecision(falsifier({ evidence_refs: ["H:3", "B:3"] }), CHANGE_EVIDENCE),
    ).toBeUndefined();
    expect(
      extractFalsifierDecision(
        falsifier({ verdict: "defeated", reason_code: "no_defeater_found" }),
        CHANGE_EVIDENCE,
      ),
    ).toBeUndefined();
  });
});

describe("truth then adversarial falsification", () => {
  it("publishes the unchanged original only after both independent roles agree", async () => {
    const candidate = finding("When the header is numeric, the wait is 1000× short.");
    const endpoint = endpointReplying([CONFIRMED, SURVIVES]);
    const out = await substantiate([candidate], () => CHANGE_EVIDENCE, endpoint.deps, "paranoid");

    expect(out.findings).toEqual([candidate]);
    expect(out.findings[0]).toBe(candidate);
    expect(out.confirmed).toBe(1);
    expect(out.repaired).toBe(0);
    expect(out.droppedNitpick).toBe(0);
    expect(out.tokens).toBe(200);
    expect(endpoint.completionLimits()).toEqual([2_304, 2_048]);
    expect(endpoint.prompts()).toHaveLength(2);
  });

  it("drops behavior proved unchanged between BASE and HEAD before falsification", async () => {
    const endpoint = endpointReplying([NOT_INTRODUCED, SURVIVES]);
    const out = await substantiate(
      [finding("When ready is true, this calls run().")],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
    );

    expect(out.findings).toHaveLength(0);
    expect(out.truthRefuted).toBe(1);
    expect(out.falsifierDefeated).toBe(0);
    expect(out.droppedRefuted).toBe(1);
    expect(out.droppedUnsupported).toBe(1);
    expect(endpoint.remaining()).toBe(1);
  });

  it("lets the adversarial role defeat a plausible high-impact claim", async () => {
    const defeated = falsifier({
      verdict: "defeated",
      reason_code: "existing_guard",
      evidence_refs: ["H:2"],
    });
    const endpoint = endpointReplying([CONFIRMED, defeated, "no third call"]);
    const out = await substantiate(
      [finding("When submitted is undefined, spreading it crashes every production request.")],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
    );

    expect(out.findings).toHaveLength(0);
    expect(out.truthRefuted).toBe(0);
    expect(out.falsifierDefeated).toBe(1);
    expect(out.droppedRefuted).toBe(1);
    expect(endpoint.remaining()).toBe(1);
    expect(endpoint.prompts()).toHaveLength(2);
  });

  it("does not call a rewrite or an importance scorer", async () => {
    const endpoint = endpointReplying([CONFIRMED, SURVIVES, "must remain unused"]);
    const out = await substantiate(
      [finding("When tracing is active, this records the wrong request id.")],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
    );

    expect(out.findings).toHaveLength(1);
    expect(out.repaired).toBe(0);
    expect(out.droppedNitpick).toBe(0);
    expect(endpoint.remaining()).toBe(1);
    expect(
      endpoint.prompts().every((prompt) => !/Rewrite one|importance score|nitpick/iu.test(prompt)),
    ).toBe(true);
  });
});

describe("one shared deterministic retrieval loop", () => {
  it("treats a merely consistent claim as insufficient when no follow-up source exists", async () => {
    const endpoint = endpointReplying([NEEDS_CALLER, "must not become a rewrite"]);
    const out = await substantiate(
      [finding("This looks consistent with a caller contract that is not shown.")],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
    );

    expect(out.findings).toHaveLength(0);
    expect(out.droppedInsufficientEvidence).toBe(1);
    expect(out.retrievalRequested).toBe(1);
    expect(out.retrievalPerformed).toBe(0);
    expect(endpoint.remaining()).toBe(1);
  });

  it("retrieves truth context once, restarts truth, then runs the falsifier", async () => {
    const candidate = finding("When a caller passes seconds, the wait is 1000× short.");
    const endpoint = endpointReplying([
      NEEDS_CALLER,
      truth({ evidence_refs: ["D:H:3", "H:3", "R1:H:9"] }),
      falsifier({ evidence_refs: ["D:H:3", "H:3", "R1:H:9"] }),
    ]);
    const requests: unknown[] = [];
    const retrieve: EvidenceRetriever = (request) => {
      requests.push(request);
      return retrievedCaller();
    };

    const out = await substantiate(
      [candidate],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
      undefined,
      retrieve,
    );

    expect(out.findings).toEqual([candidate]);
    expect(out.retrievalRequested).toBe(1);
    expect(out.retrievalPerformed).toBe(1);
    expect(out.retrievalExpanded).toBe(1);
    expect(out.retrievalNoMatches).toBe(0);
    expect(out.retrievalFailed).toBe(0);
    expect(requests).toHaveLength(1);
    expect(endpoint.prompts()[1]).toContain("R1:H:9| await wait(header.delay);");
    expect(endpoint.completionLimits()).toEqual([2_304, 2_304, 2_048]);
  });

  it("shares the same allowance when the falsifier asks for context", async () => {
    const endpoint = endpointReplying([
      CONFIRMED,
      FALSIFIER_NEEDS_CALLER,
      truth({ evidence_refs: ["D:H:3", "H:3", "R1:H:9"] }),
      falsifier({ evidence_refs: ["D:H:3", "H:3", "R1:H:9"] }),
    ]);
    let retrievalCalls = 0;
    const out = await substantiate(
      [finding("When a caller passes seconds, the wait is 1000× short.")],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
      undefined,
      () => {
        retrievalCalls += 1;
        return retrievedCaller();
      },
    );

    expect(out.findings).toHaveLength(1);
    expect(retrievalCalls).toBe(1);
    expect(out.retrievalRequested).toBe(1);
    expect(endpoint.completionLimits()).toEqual([2_304, 2_048, 2_304, 2_048]);
  });

  it("turns a second context request into insufficient evidence without another lookup", async () => {
    const endpoint = endpointReplying([NEEDS_CALLER, NEEDS_CALLER, SURVIVES]);
    let retrievalCalls = 0;
    const out = await substantiate(
      [finding("When an unseen caller passes seconds, the wait is short.")],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
      undefined,
      () => {
        retrievalCalls += 1;
        return retrievedCaller();
      },
    );

    expect(out.findings).toHaveLength(0);
    expect(out.droppedInsufficientEvidence).toBe(1);
    expect(out.droppedVague).toBe(1);
    expect(out.retrievalRequested).toBe(2);
    expect(out.retrievalPerformed).toBe(1);
    expect(retrievalCalls).toBe(1);
    expect(endpoint.remaining()).toBe(1);
  });

  it("drops valid no-match results as insufficient, but callback failures are undecided", async () => {
    const noMatch = await substantiate(
      [finding("When an unseen caller passes seconds, the wait is short.")],
      () => CHANGE_EVIDENCE,
      endpointReplying([NEEDS_CALLER]).deps,
      "paranoid",
      undefined,
      () => ({ chunks: [] }),
    );
    const failed = await substantiate(
      [finding("When an unseen caller passes seconds, the wait is short.")],
      () => CHANGE_EVIDENCE,
      endpointReplying([NEEDS_CALLER]).deps,
      "paranoid",
      undefined,
      () => {
        throw new Error("git unavailable");
      },
    );

    expect(noMatch.droppedInsufficientEvidence).toBe(1);
    expect(noMatch.retrievalNoMatches).toBe(1);
    expect(noMatch.undecided).toBe(0);
    expect(failed.findings).toHaveLength(0);
    expect(failed.undecided).toBe(1);
    expect(failed.retrievalFailed).toBe(1);
  });

  it("rejects malformed or over-broad retrieval output fail-closed", async () => {
    for (const path of [
      "../outside.ts",
      "C:\\outside.ts",
      "src\\outside.ts",
      "src//x.ts",
      "src/./x.ts",
    ]) {
      const invalid = {
        chunks: [{ path, side: "H", lines: [{ line: 1, text: "x" }] }],
      } as unknown as RetrievedEvidence;
      const out = await substantiate(
        [finding("When an unseen caller passes seconds, the wait is short.")],
        () => CHANGE_EVIDENCE,
        endpointReplying([NEEDS_CALLER]).deps,
        "paranoid",
        undefined,
        () => invalid,
      );

      expect(out.undecided).toBe(1);
      expect(out.retrievalFailed).toBe(1);
      expect(out.droppedInsufficientEvidence).toBe(0);
    }
  });

  it("enforces chunk, line-count, line-size, and exact-object bounds", async () => {
    const chunk = (
      path: string,
      lines: readonly { line: number; text: string }[],
    ): RetrievedEvidenceChunk => ({ path, side: "H", lines });
    const invalidResults = [
      {
        chunks: [1, 2, 3, 4].map((index) =>
          chunk(`src/${String(index)}.ts`, [{ line: 1, text: "x" }]),
        ),
      },
      {
        chunks: [
          chunk(
            "src/many.ts",
            Array.from({ length: 201 }, (_unused, index) => ({ line: index + 1, text: "x" })),
          ),
        ],
      },
      { chunks: [chunk("src/long.ts", [{ line: 1, text: "x".repeat(501) }])] },
      {
        chunks: [
          chunk("src/duplicate.ts", [
            { line: 1, text: "x" },
            { line: 1, text: "y" },
          ]),
        ],
      },
      { chunks: [], extra: true },
    ] as unknown as readonly RetrievedEvidence[];

    for (const retrieved of invalidResults) {
      const out = await substantiate(
        [finding("When an unseen caller passes seconds, the wait is short.")],
        () => CHANGE_EVIDENCE,
        endpointReplying([NEEDS_CALLER]).deps,
        "paranoid",
        undefined,
        () => retrieved,
      );
      expect(out.undecided).toBe(1);
      expect(out.retrievalFailed).toBe(1);
    }
  });
});

describe("strict failure policy", () => {
  it("under paranoid publishes neither malformed replies, budget failures, nor unreadable evidence", async () => {
    const malformed = await substantiate(
      [finding("When x is zero, compute throws.")],
      () => CHANGE_EVIDENCE,
      endpointReplying(['{"verdict":"maybe"}']).deps,
      "paranoid",
    );
    const unreadableEndpoint = endpointReplying([CONFIRMED]);
    const unreadable = await substantiate(
      [finding("When x is zero, compute throws.")],
      () => "",
      unreadableEndpoint.deps,
      "paranoid",
    );

    expect(malformed.findings).toHaveLength(0);
    expect(malformed.undecided).toBe(1);
    expect(unreadable.findings).toHaveLength(0);
    expect(unreadable.undecided).toBe(1);
    expect(unreadable.tokens).toBe(0);
    expect(unreadableEndpoint.remaining()).toBe(1);
  });

  it("retains only legacy operating points for transport failures", async () => {
    const candidate = finding("When x is zero, compute throws.");
    const ordinary = await substantiate(
      [candidate],
      () => CHANGE_EVIDENCE,
      endpointReplying([TRANSPORT_FAIL]).deps,
    );
    const paranoid = await substantiate(
      [candidate],
      () => CHANGE_EVIDENCE,
      endpointReplying([TRANSPORT_FAIL]).deps,
      "paranoid",
    );

    expect(ordinary.findings).toEqual([candidate]);
    expect(ordinary.undecided).toBe(1);
    expect(paranoid.findings).toHaveLength(0);
    expect(paranoid.undecided).toBe(1);
  });

  it("rejects a syntactically complete envelope from a truncated endpoint completion", async () => {
    const endpoint = endpointReplying([
      { text: CONFIRMED, totalTokens: 100, finishReason: "length" },
      SURVIVES,
    ]);
    const out = await substantiate(
      [finding("When x is zero, compute throws.")],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
    );

    expect(out.findings).toHaveLength(0);
    expect(out.undecided).toBe(1);
    expect(out.tokens).toBe(100);
    expect(endpoint.remaining()).toBe(1);
  });
});

describe("hard shared request budget", () => {
  it("starts no request when the first conservative upper bound does not fit", async () => {
    const candidate = finding("When x is zero, compute throws.");
    const endpoint = endpointReplying([REFUTED]);
    const bound = truthRequestUpperBound(candidate);
    const out = await substantiate(
      [candidate],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
      bound - 1,
    );

    expect(endpoint.remaining()).toBe(1);
    expect(out.undecided).toBe(1);
    expect(out.budgetBlocked).toBe(1);
    expect(out.tokens).toBe(0);
  });

  it("honours the exact first-call boundary", async () => {
    const candidate = finding("When x is zero, compute throws.");
    const bound = truthRequestUpperBound(candidate);
    const endpoint = endpointReplying([REFUTED]);
    const out = await substantiate(
      [candidate],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
      bound,
    );

    expect(endpoint.remaining()).toBe(0);
    expect(out.truthRefuted).toBe(1);
    expect(out.budgetBlocked).toBe(0);
    expect(out.tokens).toBeLessThanOrEqual(bound);
  });

  it("blocks the falsifier before its request and never crosses the hard ceiling", async () => {
    const candidate = finding("When x is zero, compute throws.");
    const bound = truthRequestUpperBound(candidate);
    const endpoint = endpointReplying([{ text: CONFIRMED, totalTokens: bound }, SURVIVES]);
    const out = await substantiate(
      [candidate],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
      bound,
    );

    expect(endpoint.remaining()).toBe(1);
    expect(endpoint.completionLimits()).toEqual([2_304]);
    expect(out.findings).toHaveLength(0);
    expect(out.undecided).toBe(1);
    expect(out.budgetBlocked).toBe(1);
    expect(out.tokens).toBe(bound);
  });

  it("shares the same hard ceiling across later findings", async () => {
    const candidate = finding("When x is zero, compute throws.");
    const bound = truthRequestUpperBound(candidate);
    const endpoint = endpointReplying([{ text: REFUTED, totalTokens: bound }, REFUTED]);
    const out = await substantiate(
      [candidate, candidate],
      () => CHANGE_EVIDENCE,
      endpoint.deps,
      "paranoid",
      bound,
    );

    expect(endpoint.remaining()).toBe(1);
    expect(out.truthRefuted).toBe(1);
    expect(out.undecided).toBe(1);
    expect(out.budgetBlocked).toBe(1);
    expect(out.tokens).toBe(bound);
  });

  it("fails closed and conservatively charges missing or invalid provider usage", async () => {
    const candidate = finding("When x is zero, compute throws.");
    const bound = truthRequestUpperBound(candidate);
    for (const reply of [
      { text: CONFIRMED, omitUsage: true },
      { text: CONFIRMED, totalTokens: bound + 1 },
      { text: CONFIRMED, totalTokens: -1 },
    ] satisfies readonly ReplyWithUsage[]) {
      const out = await substantiate(
        [candidate],
        () => CHANGE_EVIDENCE,
        endpointReplying([reply]).deps,
        "paranoid",
        bound,
      );

      expect(out.findings).toHaveLength(0);
      expect(out.undecided).toBe(1);
      expect(out.budgetBlocked).toBe(0);
      expect(out.tokens).toBe(bound);
    }
  });
});

describe("resolveSubstantiationStrictness", () => {
  it("defaults silently and reads every closed level", () => {
    expect(resolveSubstantiationStrictness({})).toBe("default");
    expect(resolveSubstantiationStrictness({ KFQ_SUBSTANTIATION_STRICTNESS: "strictt" })).toBe(
      "default",
    );
    expect(resolveSubstantiationStrictness({ KFQ_SUBSTANTIATION_STRICTNESS: " Paranoid \n" })).toBe(
      "paranoid",
    );
    expect(resolveSubstantiationStrictness({ KFQ_SUBSTANTIATION_STRICTNESS: "LENIENT" })).toBe(
      "lenient",
    );
  });
});
