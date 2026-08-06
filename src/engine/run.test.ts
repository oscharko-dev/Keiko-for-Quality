import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { compileProfile, type ReviewProfile } from "../config/profile.js";
import type { RuntimeConfig } from "../config/runtime.js";
import { commitSha } from "../core/brands.js";
import { createSilentDiagnostics } from "../diagnostics/sink.js";
import type { ExecOptions, ExecResult } from "../git/exec.js";
import type { ReviewPair } from "../inventory/inventory.js";
import { buildRuleFile, serializeRuleFile } from "./rule-file.js";
import type { EngineRunOptions } from "./run.js";

// `runEngine`'s only process-spawn boundary, mocked so the `model.usage` suite below can drive
// real HTTP through the real loopback proxy without a real engine binary — the same seam
// `review.test.ts` uses one layer up (there it mocks `runEngine` itself; here it mocks what
// `runEngine` calls). `reviewArguments` needs none of this: it is a pure function of its inputs.
//
// Only `import type` reaches "../git/exec.js" statically above — a value import of the same
// specifier would force this factory to run before `execRunMock` is initialized (a real TDZ
// failure, not a hypothetical one). `ExecFailure` is therefore fetched below through the same
// dynamic import as the module under test, exactly as `review.test.ts` fetches `EngineRunError`.
const execRunMock =
  vi.fn<(command: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>>();
vi.mock("../git/exec.js", async (importOriginal) => ({
  ...(await importOriginal()),
  run: execRunMock,
}));

const { EngineRunError, reviewArguments, runEngine } = await import("./run.js");
const { ExecFailure } = await import("../git/exec.js");

const PROFILE = compileProfile({
  version: 1,
  reviewRelevant: ["src/**"],
  deletionCritical: [],
  generated: [],
  excluded: [],
  benignWarnings: [],
  pathInstructions: [],
} satisfies ReviewProfile);

const CONFIG: RuntimeConfig = {
  protocol: "anthropic",
  endpoint: "https://example.test/v1",
  model: "test-model",
  tokenEnvName: "MODEL_TOKEN",
  language: "English",
  concurrency: 4,
  fileTimeoutSeconds: 300,
  reviewTimeoutSeconds: 1800,
  tokenBudget: 2_000_000,
  maxFindings: 50,
  renameDetectionPercent: 50,
};

const PAIR: ReviewPair = {
  base: commitSha("a".repeat(40)),
  head: commitSha("b".repeat(40)),
  mergeBase: commitSha("c".repeat(40)),
};

function options(overrides: Partial<EngineRunOptions> = {}): EngineRunOptions {
  return {
    binaryPath: "/opt/engine/ocr",
    repositoryPath: "/workspace/repo",
    pair: PAIR,
    config: CONFIG,
    profile: PROFILE,
    guidelines: { paths: [] },
    env: {},
    pathValue: "/usr/bin:/bin",
    allottedBudget: 123_456,
    mechanicallyCleanPaths: [],
    ...overrides,
  };
}

describe("reviewArguments", () => {
  it("carries the allotted budget as --max-tokens-budget, not the consumer's raw ceiling", () => {
    const args = reviewArguments(options({ allottedBudget: 987_654 }), "/home/keiko-rules.json");
    const flagIndex = args.indexOf("--max-tokens-budget");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe("987654");
    // Proves this is the size-scaled allotment threaded through options, not `config.tokenBudget`
    // read directly — the two are deliberately different values in this fixture.
    expect(args).not.toContain(String(CONFIG.tokenBudget));
  });

  it("threads a different allotment on a second call rather than a value baked into the function", () => {
    const small = reviewArguments(options({ allottedBudget: 80_000 }), "/home/keiko-rules.json");
    const large = reviewArguments(options({ allottedBudget: 4_771_650 }), "/home/keiko-rules.json");
    expect(small[small.indexOf("--max-tokens-budget") + 1]).toBe("80000");
    expect(large[large.indexOf("--max-tokens-budget") + 1]).toBe("4771650");
  });

  it("still carries the merge base, head, rule path, and concurrency", () => {
    const args = reviewArguments(options(), "/home/keiko-rules.json");
    expect(args).toEqual([
      "review",
      "--from",
      PAIR.mergeBase,
      "--to",
      PAIR.head,
      "--format",
      "json",
      "--rule",
      "/home/keiko-rules.json",
      "--concurrency",
      "4",
      "--max-tokens-budget",
      "123456",
    ]);
  });

  it("never consults the engine's own discovery paths for the rule file", () => {
    const args = reviewArguments(options(), "/home/keiko-rules.json");
    expect(args[args.indexOf("--rule") + 1]).toBe("/home/keiko-rules.json");
  });
});

describe("runEngine: model.usage telemetry", () => {
  beforeEach(() => {
    execRunMock.mockReset();
  });

  /**
   * A trivial hermetic upstream: always answers the same body, regardless of what arrives — but
   * still captures each request body verbatim, so a test can inspect what the proxy actually put
   * on the wire (the `prompt_cache_key` assertion below needs exactly this).
   */
  function startUsageUpstream(
    body: string,
  ): Promise<{ url: string; captured: string[]; close: () => Promise<void> }> {
    const captured: string[] = [];
    const server: Server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        captured.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no address");
        resolve({
          url: `http://127.0.0.1:${String(address.port)}`,
          captured,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => {
                done();
              });
            }),
        });
      });
    });
  }

  /**
   * Stands in for the engine binary. On the `review` call it makes exactly one request through
   * whatever proxy `runEngine` wired up via `OCR_LLM_URL`, then runs `afterFetch` — letting a test
   * simulate an engine that spends against the model before its own process fails. The `config
   * set` call `configureEngine` issues first carries `args[0] === "config"` and falls straight
   * through to the canned success below, untouched.
   */
  function respondThroughProxy(
    afterFetch: () => void = () => undefined,
  ): (command: string, args: readonly string[], execOptions: ExecOptions) => Promise<ExecResult> {
    return async (_command, args, execOptions) => {
      if (args[0] === "review") {
        const url = execOptions.env?.OCR_LLM_URL;
        // The proxy binds 127.0.0.1 only (model-proxy.ts's whole security posture depends on
        // it); the anthropic-path test below leaves `OCR_LLM_URL` at the raw, non-loopback
        // config endpoint, and that must never turn into a real outbound request.
        if (typeof url === "string" && url.startsWith("http://127.0.0.1:")) {
          await fetch(`${url}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "m", messages: [] }),
          });
        }
        afterFetch();
      }
      return { stdout: Buffer.from('{"status":"success","comments":[]}'), stderr: "", code: 0 };
    };
  }

  it("records the proxy's wire-observed counts once, keyed to the reviewed head", async () => {
    const upstream = await startUsageUpstream(
      JSON.stringify({
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
    );
    try {
      execRunMock.mockImplementation(respondThroughProxy());
      const diagnostics = createSilentDiagnostics();

      await runEngine(
        options({
          config: { ...CONFIG, protocol: "openai", endpoint: upstream.url },
          env: { MODEL_TOKEN: "secret" },
        }),
        diagnostics,
      );

      const records = diagnostics.drain().filter((record) => record.code === "model.usage");
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        headSha: PAIR.head,
        counts: { requests: 1, prompt: 120, completion: 30, cached: 40, cache_key_rejected: 0 },
      });

      // The proxy injects `prompt_cache_key` derived from the rule digest `runEngine` writes to
      // `keiko-rules.json` — recomputed here from the same profile/guidelines/mechanicallyClean
      // fixture `options()` defaults to, independently of `run.ts`, so this proves the wire value
      // rather than assuming it. Same rule content must produce the same key.
      const rule = buildRuleFile(PROFILE, { paths: [] }, []);
      const ruleDigest = createHash("sha256").update(serializeRuleFile(rule)).digest("hex");
      expect(upstream.captured).toHaveLength(1);
      const body = JSON.parse(upstream.captured[0] ?? "{}") as { prompt_cache_key?: string };
      expect(body.prompt_cache_key).toBe(`kfq-${ruleDigest.slice(0, 16)}`);
    } finally {
      await upstream.close();
    }
  });

  it("never records model.usage on the anthropic protocol path, where no proxy runs", async () => {
    execRunMock.mockImplementation(respondThroughProxy());
    const diagnostics = createSilentDiagnostics();

    // CONFIG defaults to protocol "anthropic" — runEngine never starts a proxy on this path.
    await runEngine(options({ env: { MODEL_TOKEN: "secret" } }), diagnostics);

    expect(diagnostics.drain().some((record) => record.code === "model.usage")).toBe(false);
  });

  it("still records model.usage exactly once when the engine process itself fails", async () => {
    const upstream = await startUsageUpstream(
      JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    );
    try {
      execRunMock.mockImplementation(
        respondThroughProxy(() => {
          throw new ExecFailure("ocr", 1);
        }),
      );
      const diagnostics = createSilentDiagnostics();

      await expect(
        runEngine(
          options({
            config: { ...CONFIG, protocol: "openai", endpoint: upstream.url },
            env: { MODEL_TOKEN: "secret" },
          }),
          diagnostics,
        ),
      ).rejects.toBeInstanceOf(EngineRunError);

      const records = diagnostics.drain().filter((record) => record.code === "model.usage");
      expect(records).toHaveLength(1);
      expect(records[0]?.counts).toEqual({
        requests: 1,
        prompt: 5,
        completion: 1,
        cached: 0,
        cache_key_rejected: 0,
        bad_request_persisted: 0,
      });
    } finally {
      await upstream.close();
    }
  });
});

/**
 * Which `engine.run.*` diagnostic a failed `review` invocation is classified under. `ExecFailure`
 * carries `timedOut` (git/exec.ts) precisely so this classification does not have to guess from a
 * bare exit code — a killed-by-timeout process and an ordinary non-zero exit both report `code`s
 * that mean nothing on their own (Node reports no real exit code for a timeout kill).
 */
describe("runEngine: exec failure classification", () => {
  beforeEach(() => {
    execRunMock.mockReset();
  });

  /** Succeeds the `config set` call unconditionally; only the `review` invocation fails. */
  function failReviewWith(
    error: unknown,
  ): (command: string, args: readonly string[]) => Promise<ExecResult> {
    return (_command, args) => {
      if (args[0] === "review") throw error;
      return Promise.resolve({ stdout: Buffer.from(""), stderr: "", code: 0 });
    };
  }

  it("classifies a timed-out exec failure as engine.run.timeout, not nonzero_exit", async () => {
    execRunMock.mockImplementation(failReviewWith(new ExecFailure("ocr", 1, true)));
    const diagnostics = createSilentDiagnostics();

    await expect(
      runEngine(options({ env: { MODEL_TOKEN: "secret" } }), diagnostics),
    ).rejects.toMatchObject({ reason: "engine.run.timeout" });

    const codes = diagnostics.drain().map((record) => record.code);
    expect(codes).toContain("engine.run.timeout");
    expect(codes).not.toContain("engine.run.nonzero_exit");
  });

  it("still classifies an ordinary non-zero exit as engine.run.nonzero_exit", async () => {
    execRunMock.mockImplementation(failReviewWith(new ExecFailure("ocr", 1, false)));
    const diagnostics = createSilentDiagnostics();

    await expect(
      runEngine(options({ env: { MODEL_TOKEN: "secret" } }), diagnostics),
    ).rejects.toMatchObject({ reason: "engine.run.nonzero_exit" });

    const codes = diagnostics.drain().map((record) => record.code);
    expect(codes).toContain("engine.run.nonzero_exit");
    expect(codes).not.toContain("engine.run.timeout");
  });

  it("classifies a non-ExecFailure error as engine.run.spawn_failed", async () => {
    execRunMock.mockImplementation(failReviewWith(new Error("boom")));
    const diagnostics = createSilentDiagnostics();

    await expect(
      runEngine(options({ env: { MODEL_TOKEN: "secret" } }), diagnostics),
    ).rejects.toMatchObject({ reason: "engine.run.spawn_failed" });

    const codes = diagnostics.drain().map((record) => record.code);
    expect(codes).toContain("engine.run.spawn_failed");
  });
});
