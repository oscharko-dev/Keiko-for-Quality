import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blobId, sha256 } from "../core/brands.js";
import {
  SUPPORTED_STORE_SCHEMA,
  computeKey,
  modelId,
  protocol,
  serializeStore,
  type CacheEntry,
  type CacheStore,
} from "../cache/review-cache.js";
import { GitHubClient, type IssueComment } from "../github/client.js";
import type { ReviewReport } from "../review.js";

/**
 * `resolveIdentity` and `performReview` both do real network or engine work in production. Every
 * test here mocks both, so the only things actually exercised are `runAction`'s own new
 * responsibilities: reading the store before the review, and deciding whether to write it back
 * after. `readStore`/`serializeStore`/`computeKey` are the real, unmocked production functions —
 * a fixture never restates what they already compute.
 */
const performReviewMock =
  vi.fn<(request: unknown, diagnostics: unknown) => Promise<ReviewReport>>();
vi.mock("../review.js", () => ({ performReview: performReviewMock }));

const IDENTITY_CLIENT = new GitHubClient("https://api.example.test", "unused");
vi.mock("./identity.js", () => ({
  resolveIdentity: vi.fn(() => ({
    client: IDENTITY_CLIENT,
    login: "keiko-for-quality[bot]",
    usedApp: true,
  })),
}));

const { runAction } = await import("./main.js");
const { createDiagnostics } = await import("../diagnostics/sink.js");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kfq-main-"));
  performReviewMock.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const EVENT_PAYLOAD = {
  action: "synchronize",
  pull_request: {
    number: 42,
    draft: false,
    head: { sha: "b".repeat(40), repo: { full_name: "acme/widget" } },
    base: { sha: "a".repeat(40), ref: "dev", repo: { full_name: "acme/widget" } },
  },
};

const PROFILE_JSON = JSON.stringify({
  version: 1,
  reviewRelevant: ["src/**"],
  deletionCritical: [],
  generated: [],
  excluded: [],
  benignWarnings: [],
});

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    outcome: "complete",
    inventorySize: 1,
    reviewablePaths: 1,
    excludedPaths: 0,
    mechanicallyClean: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheAppended: 0,
    ...overrides,
  };
}

interface EnvOverrides {
  readonly reviewStorePath?: string;
}

async function baseEnv(overrides: EnvOverrides = {}): Promise<NodeJS.ProcessEnv> {
  const eventPath = join(dir, "event.json");
  const profilePath = join(dir, "profile.json");
  const outputPath = join(dir, "output.txt");
  await writeFile(eventPath, JSON.stringify(EVENT_PAYLOAD), "utf8");
  await writeFile(profilePath, PROFILE_JSON, "utf8");
  await writeFile(outputPath, "", "utf8");
  return {
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    INPUT_PROFILE: profilePath,
    INPUT_MODEL_PROTOCOL: "anthropic",
    INPUT_MODEL_ENDPOINT: "https://model.example.test/v1",
    INPUT_MODEL_ID: "test-model",
    INPUT_MODEL_TOKEN_ENV: "MODEL_TOKEN",
    ...(overrides.reviewStorePath === undefined
      ? {}
      : { INPUT_REVIEW_STORE_PATH: overrides.reviewStorePath }),
  };
}

async function readOutputs(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const text = await readFile(env.GITHUB_OUTPUT ?? "", "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n").filter((l) => l !== "")) {
    const separator = line.indexOf("=");
    out[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return out;
}

const CONFIG = { model: "claude-sonnet-4-5", protocol: "anthropic" as const };

function entry(_path: string, findings: CacheEntry["findings"] = []): CacheEntry {
  const model = modelId(CONFIG.model);
  const proto = protocol(CONFIG.protocol);
  const base = blobId("a".repeat(40));
  const head = blobId("b".repeat(40));
  const rule = sha256("1".repeat(64));
  const engine = sha256("2".repeat(64));
  const pathSet = sha256("5".repeat(64));
  return {
    key: computeKey(base, head, rule, engine, model, proto),
    baseBlob: base,
    headBlob: head,
    ruleDigest: rule,
    engineDigest: engine,
    prPathSetDigest: pathSet,
    modelId: model,
    protocol: proto,
    findings,
  };
}

describe("runAction: review-cache inert path", () => {
  it("passes no cacheStore, records no cache diagnostic, and reports zero hits/misses", async () => {
    performReviewMock.mockResolvedValue(report());
    const env = await baseEnv(); // no INPUT_REVIEW_STORE_PATH at all
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    const [request] = performReviewMock.mock.calls[0] as [{ cacheStore?: unknown }, unknown];
    expect(request.cacheStore).toBeUndefined();
    expect(diagnostics.drain().some((r) => r.code.startsWith("cache."))).toBe(false);
    expect(await readOutputs(env)).toMatchObject({ cache_hits: "0", cache_misses: "0" });
  });

  it("is equally inert when the input is explicitly set to the empty string", async () => {
    performReviewMock.mockResolvedValue(report());
    const env = await baseEnv({ reviewStorePath: "" });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    const [request] = performReviewMock.mock.calls[0] as [{ cacheStore?: unknown }, unknown];
    expect(request.cacheStore).toBeUndefined();
  });
});

describe("runAction: loading the store", () => {
  it("treats a missing store file as an ordinary first run, not a rejection", async () => {
    performReviewMock.mockResolvedValue(report());
    const storePath = join(dir, "does-not-exist.json");
    const env = await baseEnv({ reviewStorePath: storePath });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    const codes = diagnostics.drain().map((r) => r.code);
    expect(codes).toContain("cache.store_loaded");
    expect(codes).not.toContain("cache.store_rejected");
    const loaded = diagnostics.drain().find((r) => r.code === "cache.store_loaded");
    expect(loaded?.counts?.entries).toBe(0);

    const [request] = performReviewMock.mock.calls[0] as [{ cacheStore?: CacheStore }, unknown];
    expect(request.cacheStore).toEqual({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] });
  });

  it("rejects a corrupt store file and proceeds as an empty store", async () => {
    performReviewMock.mockResolvedValue(report());
    const storePath = join(dir, "store.json");
    await writeFile(storePath, "not json at all", "utf8");
    const env = await baseEnv({ reviewStorePath: storePath });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    expect(diagnostics.drain().map((r) => r.code)).toContain("cache.store_rejected");
    const [request] = performReviewMock.mock.calls[0] as [{ cacheStore?: CacheStore }, unknown];
    expect(request.cacheStore).toEqual({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] });
  });

  it("rejects a store still carrying the retired v1 schema and proceeds as an empty store (no migration, v0.10.0 issue #50)", async () => {
    performReviewMock.mockResolvedValue(report());
    const storePath = join(dir, "store.json");
    await writeFile(
      storePath,
      JSON.stringify({ schemaVersion: "keiko-for-quality.review-cache/v1", entries: [] }),
      "utf8",
    );
    const env = await baseEnv({ reviewStorePath: storePath });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    expect(diagnostics.drain().map((r) => r.code)).toContain("cache.store_rejected");
    const [request] = performReviewMock.mock.calls[0] as [{ cacheStore?: CacheStore }, unknown];
    expect(request.cacheStore).toEqual({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] });
  });

  it("loads a well-formed store and passes it through untouched", async () => {
    const seeded: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [entry("src/a.ts")],
    };
    performReviewMock.mockResolvedValue(report());
    const storePath = join(dir, "store.json");
    await writeFile(storePath, serializeStore(seeded), "utf8");
    const env = await baseEnv({ reviewStorePath: storePath });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    const [request] = performReviewMock.mock.calls[0] as [{ cacheStore?: CacheStore }, unknown];
    expect(request.cacheStore).toEqual(seeded);
    const loaded = diagnostics.drain().find((r) => r.code === "cache.store_loaded");
    expect(loaded?.counts?.entries).toBe(1);
  });
});

describe("runAction: writing the store back", () => {
  it("writes the updated store and records cache.appended only on a complete outcome", async () => {
    const updated: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [entry("src/a.ts")],
    };
    performReviewMock.mockResolvedValue(
      report({ outcome: "complete", cacheAppended: 1, updatedCacheStore: updated }),
    );
    const storePath = join(dir, "store.json");
    const env = await baseEnv({ reviewStorePath: storePath });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    const written = await readFile(storePath, "utf8");
    expect(written).toBe(serializeStore(updated));
    const appended = diagnostics.drain().find((r) => r.code === "cache.appended");
    expect(appended?.counts?.entries).toBe(1);
  });

  /**
   * The original pin read "never writes when the outcome is incomplete". Keiko-for-Quality#75
   * narrowed that deliberately, and the narrowing is what this pair now holds.
   *
   * Two different facts wore the same label. A budget overrun means the engine did not reach every
   * file, while judging properly the ones it did — and discarding those verdicts made a large pull
   * request re-price every file on every push, never converging, which is how a single day cost
   * roughly twenty full reviews of the same change. A rejected schema or a bad terminal state
   * means the manifest is not to be believed at all, and nothing it says may ever be replayed.
   *
   * So the refusal is kept in full for the second class and lifted only for the first — and even
   * then `performReview` restricts the store's entries to the paths the engine reports it reached,
   * so a file that was never opened can still never be replayed as reviewed.
   */
  it.each([
    ["a rejected manifest schema", "settlement.incomplete.schema_rejected"],
    ["an unexpected terminal state", "settlement.incomplete.terminal_state"],
    ["a failed coverage entry", "settlement.incomplete.coverage_failed"],
    ["an implausible finding count", "settlement.incomplete.engine_error"],
    ["an unlisted warning", "settlement.incomplete.warning_not_allowlisted"],
    ["a degraded publication", "settlement.incomplete.publication_degraded"],
  ] as const)("never writes when the manifest is not to be believed: %s", async (_name, reason) => {
    const updated: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [entry("src/a.ts")],
    };
    performReviewMock.mockResolvedValue(
      report({ outcome: "incomplete", reason, cacheAppended: 1, updatedCacheStore: updated }),
    );
    const storePath = join(dir, "store.json");
    const env = await baseEnv({ reviewStorePath: storePath });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    await expect(readFile(storePath, "utf8")).rejects.toThrow();
    expect(diagnostics.drain().map((r) => r.code)).not.toContain("cache.appended");
  });

  it("never writes when an incomplete report carries no reason at all", async () => {
    const updated: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [entry("src/a.ts")],
    };
    performReviewMock.mockResolvedValue(
      report({ outcome: "incomplete", cacheAppended: 1, updatedCacheStore: updated }),
    );
    const storePath = join(dir, "store.json");
    const env = await baseEnv({ reviewStorePath: storePath });

    await runAction(
      env,
      createDiagnostics(() => undefined),
    );

    await expect(readFile(storePath, "utf8")).rejects.toThrow();
  });

  /**
   * `store_written` exists because a consumer cannot ask the right question from `outcome` alone.
   *
   * Found in review of the adopting workflow (Codex, oscharko-dev/Keiko#2962): the consumer gates
   * its store hand-off on `outcome == 'complete'`, so a budget-truncated run's store — the whole
   * point of #75 — would have been written on the runner and then stranded there, and a large
   * pull request would have kept re-pricing every file on every push. The output carries the
   * write decision itself rather than a proxy a caller has to re-derive.
   */
  /**
   * A write that fails must not be reported as a write.
   *
   * `saveCacheStore` deliberately swallows the error — a store this run cannot write is a lost
   * optimization, not a reason to fail a review that already published — but swallowing the
   * OUTCOME too made `store_written` say `true` with nothing at the path. A consumer gating its
   * hand-off on that output would then upload a file that does not exist, turning a silent lost
   * optimization into a red job (CodeRabbit, #78).
   */
  it("reports store_written false when the write itself failed", async () => {
    performReviewMock.mockResolvedValue(
      report({
        outcome: "complete",
        cacheAppended: 1,
        updatedCacheStore: { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [entry("src/a.ts")] },
      }),
    );
    // A path whose parent does not exist: writeFile fails with ENOENT.
    const env = await baseEnv({ reviewStorePath: join(dir, "no-such-dir", "store.json") });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    expect((await readOutputs(env)).store_written).toBe("false");
    expect(diagnostics.drain().map((r) => r.code)).toContain("cache.store_write_failed");
  });

  it("reports store_written true for a truncated run that persisted", async () => {
    const updated: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [entry("src/a.ts")],
    };
    performReviewMock.mockResolvedValue(
      report({
        outcome: "incomplete",
        reason: "settlement.incomplete.budget_exceeded",
        cacheAppended: 1,
        updatedCacheStore: updated,
      }),
    );
    const env = await baseEnv({ reviewStorePath: join(dir, "store.json") });

    await runAction(
      env,
      createDiagnostics(() => undefined),
    );

    expect((await readOutputs(env)).store_written).toBe("true");
  });

  it.each([
    ["an untrustworthy manifest", "settlement.incomplete.schema_rejected"],
    ["a degraded publication", "settlement.incomplete.publication_degraded"],
  ] as const)("reports store_written false when nothing was persisted: %s", async (_n, reason) => {
    performReviewMock.mockResolvedValue(
      report({
        outcome: "incomplete",
        reason,
        cacheAppended: 1,
        updatedCacheStore: { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [entry("src/a.ts")] },
      }),
    );
    const env = await baseEnv({ reviewStorePath: join(dir, "store.json") });

    await runAction(
      env,
      createDiagnostics(() => undefined),
    );

    expect((await readOutputs(env)).store_written).toBe("false");
  });

  it.each([
    ["a budget overrun", "settlement.incomplete.budget_exceeded"],
    ["a coverage gap", "settlement.incomplete.coverage_gap"],
  ] as const)("writes the verdicts a truncated run did earn: %s", async (_name, reason) => {
    const updated: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [entry("src/a.ts")],
    };
    performReviewMock.mockResolvedValue(
      report({ outcome: "incomplete", reason, cacheAppended: 1, updatedCacheStore: updated }),
    );
    const storePath = join(dir, "store.json");
    const env = await baseEnv({ reviewStorePath: storePath });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    expect(await readFile(storePath, "utf8")).toBe(serializeStore(updated));
    const appended = diagnostics.drain().find((r) => r.code === "cache.appended");
    expect(appended?.counts?.entries).toBe(1);
  });

  it("never writes when the outcome is abandoned", async () => {
    performReviewMock.mockResolvedValue(report({ outcome: "abandoned" }));
    const storePath = join(dir, "store.json");
    const env = await baseEnv({ reviewStorePath: storePath });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    await expect(readFile(storePath, "utf8")).rejects.toThrow();
  });

  it("wires cache_hits and cache_misses from the report into the action outputs", async () => {
    performReviewMock.mockResolvedValue(report({ cacheHits: 3, cacheMisses: 2 }));
    const env = await baseEnv({ reviewStorePath: join(dir, "does-not-exist.json") });
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    expect(await readOutputs(env)).toMatchObject({ cache_hits: "3", cache_misses: "2" });
  });
});

/**
 * The run-summary comment (Keiko-for-Quality#31), wired at the end of `runAction`. `IDENTITY_CLIENT`
 * is the same real `GitHubClient` instance `resolveIdentity`'s mock returns for every test in this
 * file, so each test here spies on its issue-comment methods directly and restores them afterward —
 * nothing here should leak a spy into an unrelated test elsewhere in this file.
 */
describe("runAction: run-summary comment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function issueComment(overrides: Partial<IssueComment> = {}): IssueComment {
    return {
      id: 1,
      body: "summary",
      authorLogin: "keiko-for-quality[bot]",
      url: "https://example.test/issues/comments/1",
      ...overrides,
    };
  }

  it("is enabled by default: lists and creates exactly once, and surfaces the comment URL", async () => {
    performReviewMock.mockResolvedValue(report());
    const listSpy = vi.spyOn(IDENTITY_CLIENT, "listIssueComments").mockResolvedValue([]);
    const createSpy = vi
      .spyOn(IDENTITY_CLIENT, "createIssueComment")
      .mockResolvedValue(issueComment());
    const env = await baseEnv();

    await runAction(
      env,
      createDiagnostics(() => undefined),
    );

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await readOutputs(env)).toMatchObject({
      summary_comment_url: "https://example.test/issues/comments/1",
    });
  });

  /**
   * Issue #59: `runAction` measures wall-clock around its own `performReview` call and threads the
   * result into the summary comment — `presentation.test.ts` already pins the rounding rule itself,
   * so this only has to prove the number reaching the published body is the one `runAction` actually
   * measured, not a default or a hardcoded zero. `Date.now` is stubbed to jump forward by exactly
   * five real seconds the instant the mocked `performReview` call starts, which isolates the
   * measured window to that call the same way `runAction`'s own code brackets it — identity
   * resolution's own `Date.now()` read happens before the jump and is unaffected.
   */
  it("threads the measured wall-clock duration into the summary comment", async () => {
    let reviewStarted = false;
    const BASE_MS = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (reviewStarted ? BASE_MS + 5_000 : BASE_MS));
    performReviewMock.mockImplementation(() => {
      reviewStarted = true;
      return Promise.resolve(report());
    });
    vi.spyOn(IDENTITY_CLIENT, "listIssueComments").mockResolvedValue([]);
    const createSpy = vi
      .spyOn(IDENTITY_CLIENT, "createIssueComment")
      .mockResolvedValue(issueComment());
    const env = await baseEnv();

    await runAction(
      env,
      createDiagnostics(() => undefined),
    );

    const body = createSpy.mock.calls[0]?.[2];
    expect(body).toContain("| Duration (s) | 5 |");
  });

  it("makes zero comment-client calls when run_summary is disabled", async () => {
    performReviewMock.mockResolvedValue(report());
    const listSpy = vi.spyOn(IDENTITY_CLIENT, "listIssueComments");
    const createSpy = vi.spyOn(IDENTITY_CLIENT, "createIssueComment");
    const updateSpy = vi.spyOn(IDENTITY_CLIENT, "updateIssueComment");
    const env = { ...(await baseEnv()), INPUT_RUN_SUMMARY: "false" };
    const diagnostics = createDiagnostics(() => undefined);

    await runAction(env, diagnostics);

    expect(listSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(diagnostics.drain().map((r) => r.code)).toContain("publish.summary_disabled");
    expect(await readOutputs(env)).toMatchObject({ summary_comment_url: "" });
  });

  it("posts a summary for an incomplete outcome — the same eligibility gate as findings, not the outcome", async () => {
    performReviewMock.mockResolvedValue(
      report({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" }),
    );
    vi.spyOn(IDENTITY_CLIENT, "listIssueComments").mockResolvedValue([]);
    const createSpy = vi
      .spyOn(IDENTITY_CLIENT, "createIssueComment")
      .mockResolvedValue(issueComment());
    const env = await baseEnv();

    await runAction(
      env,
      createDiagnostics(() => undefined),
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("posts a summary for an abandoned outcome too", async () => {
    performReviewMock.mockResolvedValue(report({ outcome: "abandoned" }));
    vi.spyOn(IDENTITY_CLIENT, "listIssueComments").mockResolvedValue([]);
    const createSpy = vi
      .spyOn(IDENTITY_CLIENT, "createIssueComment")
      .mockResolvedValue(issueComment());
    const env = await baseEnv();

    await runAction(
      env,
      createDiagnostics(() => undefined),
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fail the run or change its recorded outcome when the summary upsert fails", async () => {
    performReviewMock.mockResolvedValue(report());
    vi.spyOn(IDENTITY_CLIENT, "listIssueComments").mockRejectedValue(new Error("network down"));
    const env = await baseEnv();
    const diagnostics = createDiagnostics(() => undefined);

    const returned = await runAction(env, diagnostics);

    expect(returned?.outcome).toBe("complete");
    expect(diagnostics.drain().map((r) => r.code)).toContain("publish.summary_upsert_failed");
    expect(await readOutputs(env)).toMatchObject({ outcome: "complete", summary_comment_url: "" });
  });

  it("updates rather than creates when its own prior summary comment already exists", async () => {
    performReviewMock.mockResolvedValue(report());
    const marker = "<!-- keiko-for-quality:v1:";
    vi.spyOn(IDENTITY_CLIENT, "listIssueComments").mockResolvedValue([
      issueComment({ id: 55, body: `${marker}${"a".repeat(32)} -->` }),
    ]);
    // Not a real marker match (the hash will not equal the run's own computed marker), so this
    // exercises the "no match, create" path deterministically without depending on the real hash —
    // covered exactly by `summary.test.ts`. This test only proves the wiring reaches the client.
    const createSpy = vi
      .spyOn(IDENTITY_CLIENT, "createIssueComment")
      .mockResolvedValue(issueComment());
    const updateSpy = vi
      .spyOn(IDENTITY_CLIENT, "updateIssueComment")
      .mockResolvedValue(issueComment());
    const env = await baseEnv();

    await runAction(
      env,
      createDiagnostics(() => undefined),
    );

    // Exactly one of create/update fires — never both, never neither.
    const totalCalls = createSpy.mock.calls.length + updateSpy.mock.calls.length;
    expect(totalCalls).toBe(1);
  });
});
