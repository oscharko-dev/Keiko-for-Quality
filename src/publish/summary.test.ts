import { beforeEach, describe, expect, it } from "vitest";

import { commitSha, versionTag } from "../core/brands.js";
import { createDiagnostics, createSilentDiagnostics } from "../diagnostics/sink.js";
import type { IssueComment, IssueCommentApi, RepoRef } from "../github/client.js";
import type { ReviewReport } from "../review.js";
import { renderMarker, summaryMarker } from "./marker.js";
import {
  buildSummaryReport,
  maintainRunSummary,
  type SummaryPublishContext,
  type SummaryRunInput,
} from "./summary.js";

const REF: RepoRef = { owner: "acme", repo: "widget" };
const IDENTITY = "keiko-for-quality[bot]";
const HEAD = commitSha("a".repeat(40));
const MARKER = summaryMarker(`${REF.owner}/${REF.repo}`, 7);

/** A scriptable stand-in for the issue-comment API, mirroring `publisher.test.ts`'s `FakeApi`. */
class FakeIssueApi implements IssueCommentApi {
  public existing: IssueComment[] = [];
  public created: string[] = [];
  public updated: { id: number; body: string }[] = [];
  public failList = false;
  public failCreate = false;
  public failUpdate = false;
  private nextId = 100;

  public listIssueComments(): Promise<IssueComment[]> {
    if (this.failList) return Promise.reject(new Error("listing failed"));
    return Promise.resolve(this.existing);
  }

  public createIssueComment(_ref: RepoRef, _number: number, body: string): Promise<IssueComment> {
    if (this.failCreate) return Promise.reject(new Error("create failed"));
    this.created.push(body);
    this.nextId += 1;
    const comment: IssueComment = {
      id: this.nextId,
      body,
      authorLogin: IDENTITY,
      url: `https://example.test/issues/comments/${String(this.nextId)}`,
    };
    this.existing = [...this.existing, comment];
    return Promise.resolve(comment);
  }

  public updateIssueComment(_ref: RepoRef, id: number, body: string): Promise<IssueComment> {
    if (this.failUpdate) return Promise.reject(new Error("update failed"));
    this.updated.push({ id, body });
    const previous = this.existing.find((comment) => comment.id === id);
    const updated: IssueComment = {
      id,
      body,
      authorLogin: previous?.authorLogin ?? IDENTITY,
      url: `https://example.test/issues/comments/${String(id)}`,
    };
    this.existing = this.existing.map((comment) => (comment.id === id ? updated : comment));
    return Promise.resolve(updated);
  }
}

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    outcome: "complete",
    inventorySize: 10,
    reviewablePaths: 6,
    excludedPaths: 3,
    mechanicallyClean: 1,
    cacheHits: 2,
    cacheMisses: 4,
    cacheAppended: 0,
    publish: {
      published: 2,
      suppressed: 1,
      suppressedExactDuplicate: 1,
      suppressedSimilar: 0,
      suppressedDispositioned: 0,
      rejectedSanitization: 0,
      rejectedPlacement: 0,
      readbackFailures: 0,
    },
    ...overrides,
  };
}

function runInput(overrides: Partial<SummaryRunInput> = {}): SummaryRunInput {
  return {
    report: report(),
    headSha: HEAD,
    eventTimestamp: "2026-08-02T10:15:00Z",
    engineVersion: versionTag("v1.8.4"),
    actionVersion: "abc1234",
    durationMs: 12_345,
    ...overrides,
  };
}

let api: FakeIssueApi;
let context: SummaryPublishContext;

beforeEach(() => {
  api = new FakeIssueApi();
  context = { client: api, ref: REF, pullNumber: 7, identity: IDENTITY };
});

describe("maintainRunSummary: upsert rules", () => {
  it("creates a new comment when none exists", async () => {
    const url = await maintainRunSummary(context, runInput(), createSilentDiagnostics());
    expect(api.created).toHaveLength(1);
    expect(api.updated).toHaveLength(0);
    expect(url).toBeDefined();
  });

  it("updates the existing App-authored marker comment in place — same id, never a second create", async () => {
    await maintainRunSummary(context, runInput(), createSilentDiagnostics());
    expect(api.existing).toHaveLength(1);
    const originalId = api.existing[0]?.id;

    await maintainRunSummary(
      context,
      runInput({ headSha: commitSha("c".repeat(40)) }),
      createSilentDiagnostics(),
    );

    expect(api.created).toHaveLength(1);
    expect(api.updated).toHaveLength(1);
    expect(api.updated[0]?.id).toBe(originalId);
    expect(api.existing).toHaveLength(1);
  });

  it("replaces the head SHA in the updated comment rather than appending it", async () => {
    await maintainRunSummary(context, runInput(), createSilentDiagnostics());
    const newHead = commitSha("c".repeat(40));
    await maintainRunSummary(context, runInput({ headSha: newHead }), createSilentDiagnostics());

    const body = api.existing[0]?.body ?? "";
    expect(body).toContain(newHead.slice(0, 7));
    expect(body).not.toContain(HEAD.slice(0, 7));
  });

  it("ignores a foreign-authored comment carrying the marker and creates a fresh one", async () => {
    api.existing = [
      {
        id: 1,
        body: `Someone else's comment.\n\n${renderMarker(MARKER)}`,
        authorLogin: "an-imposter",
        url: "https://example.test/1",
      },
    ];

    await maintainRunSummary(context, runInput(), createSilentDiagnostics());

    expect(api.created).toHaveLength(1);
    expect(api.updated).toHaveLength(0);
    expect(api.existing).toHaveLength(2);
    expect(api.existing[0]?.authorLogin).toBe("an-imposter");
  });

  it("updates the newest of several stale own-authored marker comments and leaves the other untouched", async () => {
    api.existing = [
      { id: 10, body: `old\n\n${renderMarker(MARKER)}`, authorLogin: IDENTITY, url: "u1" },
      { id: 20, body: `newer\n\n${renderMarker(MARKER)}`, authorLogin: IDENTITY, url: "u2" },
    ];

    await maintainRunSummary(context, runInput(), createSilentDiagnostics());

    expect(api.created).toHaveLength(0);
    expect(api.updated).toHaveLength(1);
    expect(api.updated[0]?.id).toBe(20);
    expect(api.existing.find((c) => c.id === 10)?.body).toBe(`old\n\n${renderMarker(MARKER)}`);
  });

  it("does not match a comment authored by this identity that carries no marker at all", async () => {
    api.existing = [{ id: 1, body: "An ordinary reply.", authorLogin: IDENTITY, url: "u1" }];

    await maintainRunSummary(context, runInput(), createSilentDiagnostics());

    expect(api.created).toHaveLength(1);
    expect(api.updated).toHaveLength(0);
  });

  it("records publish.summary_published on create and publish.summary_updated on update", async () => {
    const diagnostics = createDiagnostics(() => undefined);
    await maintainRunSummary(context, runInput(), diagnostics);
    expect(diagnostics.drain().map((r) => r.code)).toContain("publish.summary_published");

    const second = createDiagnostics(() => undefined);
    await maintainRunSummary(context, runInput(), second);
    expect(second.drain().map((r) => r.code)).toContain("publish.summary_updated");
  });
});

describe("maintainRunSummary: failure posture", () => {
  it("does not throw when listing fails, and records a redacted diagnostic instead", async () => {
    api.failList = true;
    const diagnostics = createDiagnostics(() => undefined);
    const url = await maintainRunSummary(context, runInput(), diagnostics);
    expect(url).toBeUndefined();
    expect(diagnostics.drain().map((r) => r.code)).toContain("publish.summary_upsert_failed");
    expect(diagnostics.drain().map((r) => r.code)).not.toContain("publish.summary_published");
  });

  it("does not throw when create fails, and records a redacted diagnostic instead", async () => {
    api.failCreate = true;
    const diagnostics = createDiagnostics(() => undefined);
    const url = await maintainRunSummary(context, runInput(), diagnostics);
    expect(url).toBeUndefined();
    expect(diagnostics.drain().map((r) => r.code)).toContain("publish.summary_upsert_failed");
  });

  it("does not throw when update fails, and records a redacted diagnostic instead", async () => {
    await maintainRunSummary(context, runInput(), createSilentDiagnostics());
    api.failUpdate = true;
    const diagnostics = createDiagnostics(() => undefined);
    const url = await maintainRunSummary(context, runInput(), diagnostics);
    expect(url).toBeUndefined();
    expect(diagnostics.drain().map((r) => r.code)).toContain("publish.summary_upsert_failed");
  });

  it("never carries the failure's own error text into the diagnostic", async () => {
    api.failCreate = true;
    const lines: string[] = [];
    const diagnostics = createDiagnostics((line) => lines.push(line));
    await maintainRunSummary(context, runInput(), diagnostics);
    expect(lines.join("\n")).not.toContain("create failed");
  });
});

/**
 * `buildSummaryReport` is the projection from the production `ReviewReport` — the same object
 * `main.ts`'s action outputs are built from — into `SummaryReport`. Every assertion below reads a
 * count straight off the same `ReviewReport` value the test constructs, rather than restating the
 * expectation as an independently computed number.
 */
describe("buildSummaryReport", () => {
  it("wires every path and finding count straight from the production ReviewReport", () => {
    const r = report({
      inventorySize: 97,
      reviewablePaths: 50,
      excludedPaths: 30,
      mechanicallyClean: 10,
      cacheHits: 12,
      publish: {
        published: 2,
        suppressed: 4,
        suppressedIntraRun: 3,
        suppressedExactDuplicate: 1,
        suppressedSimilar: 2,
        suppressedDispositioned: 1,
        rejectedSanitization: 0,
        rejectedPlacement: 0,
        readbackFailures: 0,
      },
    });
    const summary = buildSummaryReport(runInput({ report: r }), []);

    expect(summary.counts.totalPaths).toBe(r.inventorySize);
    expect(summary.counts.reviewablePaths).toBe(r.reviewablePaths);
    expect(summary.counts.excludedPaths).toBe(r.excludedPaths);
    expect(summary.counts.mechanicallyClean).toBe(r.mechanicallyClean);
    expect(summary.counts.cacheHits).toBe(r.cacheHits);
    expect(summary.counts.findingsPublished).toBe(r.publish?.published);
    expect(summary.counts.suppressedIntraRun).toBe(r.publish?.suppressedIntraRun);
    expect(summary.counts.suppressedExactDuplicate).toBe(r.publish?.suppressedExactDuplicate);
    expect(summary.counts.suppressedSimilar).toBe(r.publish?.suppressedSimilar);
    expect(summary.counts.suppressedDispositioned).toBe(r.publish?.suppressedDispositioned);
  });

  it("derives freshlyReviewed as the one arithmetic step: reviewablePaths minus cacheHits", () => {
    const r = report({ reviewablePaths: 50, cacheHits: 12 });
    const summary = buildSummaryReport(runInput({ report: r }), []);
    expect(summary.counts.freshlyReviewed).toBe(r.reviewablePaths - r.cacheHits);
  });

  it("defaults every finding count to zero when the report never reached publication", () => {
    // `publish` is optional on `ReviewReport` and genuinely absent on this path (the
    // zero-reviewable-paths shortcut, an early unclassified-path incomplete, or an abandoned run) —
    // built directly rather than through `report()`'s override spread, since `exactOptionalPropertyTypes`
    // correctly refuses to let a `Partial<ReviewReport>` override assign `undefined` to an optional key.
    const { publish: _publish, ...withoutPublish } = report();
    const r: ReviewReport = withoutPublish;
    const summary = buildSummaryReport(runInput({ report: r }), []);
    expect(summary.counts.findingsPublished).toBe(0);
    expect(summary.counts.suppressedIntraRun).toBe(0);
    expect(summary.counts.suppressedExactDuplicate).toBe(0);
    expect(summary.counts.suppressedSimilar).toBe(0);
    expect(summary.counts.suppressedDispositioned).toBe(0);
  });

  /**
   * `PublishOutcome.suppressedIntraRun` (v0.12.0) is optional even when `publish` itself is
   * present — see its doc comment in `publisher.ts` — for the same compile-time backward-
   * compatibility reason `apiFailures` already was: a `PublishOutcome` literal written before the
   * field existed (every fixture in this file's own `report()` helper, among others) must keep
   * satisfying the type. This is the narrower case the test above does not cover: `publish` present,
   * but this one field genuinely absent from it, rather than `publish` missing altogether.
   */
  it("defaults suppressedIntraRun to zero when publish is present but omits the optional field", () => {
    const summary = buildSummaryReport(runInput(), []);
    expect(summary.counts.suppressedIntraRun).toBe(0);
  });

  it("carries the reason code only for an incomplete outcome", () => {
    const r = report({ outcome: "incomplete", reason: "settlement.incomplete.coverage_gap" });
    const summary = buildSummaryReport(runInput({ report: r }), []);
    expect(summary.reason).toBe(r.reason);
  });

  it("drops a reason code present on a non-incomplete report rather than misrepresenting the outcome", () => {
    // Not a realistic production shape (only `settleIncomplete` ever sets `reason`), but this is the
    // exact defensive case the outcome-line contract depends on: only `incomplete` may show a reason.
    const r: ReviewReport = {
      ...report({ outcome: "complete" }),
      reason: "settlement.incomplete.coverage_gap",
    };
    const summary = buildSummaryReport(runInput({ report: r }), []);
    expect(summary.reason).toBeUndefined();
  });

  it("carries the head SHA, timestamp, and version identifiers supplied by the caller", () => {
    const summary = buildSummaryReport(runInput(), []);
    expect(summary.headSha).toBe(HEAD);
    expect(summary.eventTimestamp).toBe("2026-08-02T10:15:00Z");
    expect(summary.engineVersion).toBe("v1.8.4");
    expect(summary.actionVersion).toBe("abc1234");
  });

  describe("budget extraction from the diagnostics stream", () => {
    it("reads the allotted budget from engine.run.completed's own counts field", () => {
      const diagnostics = createDiagnostics(() => undefined);
      diagnostics.record("engine.run.completed", { counts: { bytes: 500, budget: 1_200_000 } });
      const summary = buildSummaryReport(runInput(), diagnostics.drain());
      expect(summary.budget).toEqual({ allotted: 1_200_000, spent: undefined });
    });

    /**
     * A resumed run emits `engine.run.completed` once per attempt, and the second attempt's budget
     * is the remainder carved out of the first's. Reading the last one reported that remainder as
     * the whole run's ceiling next to a cumulative `spent`, which is how production came to publish
     * "80000 allotted, 3562109 reported" for a run whose real allotment was 2.97M
     * (`corpus/evidence/live-telemetry-2026-08-04-keiko-2981-double-run.md`).
     */
    it("reports the first attempt's allotment, not a resume's carved-out remainder", () => {
      const diagnostics = createDiagnostics(() => undefined);
      diagnostics.record("engine.run.completed", { counts: { bytes: 500, budget: 2_970_000 } });
      diagnostics.record("engine.resumed_once", { counts: { remaining: 80_000 } });
      diagnostics.record("engine.run.completed", { counts: { bytes: 400, budget: 80_000 } });
      diagnostics.record("run.spend", {
        counts: { engine: 3_562_109, classify: 0, total: 3_562_109 },
      });
      const summary = buildSummaryReport(runInput(), diagnostics.drain());
      expect(summary.budget).toEqual({ allotted: 2_970_000, spent: 3_562_109 });
    });

    it("reads the reported spend from run.spend's own counts.total field", () => {
      const diagnostics = createDiagnostics(() => undefined);
      diagnostics.record("engine.run.completed", { counts: { bytes: 500, budget: 1_200_000 } });
      diagnostics.record("run.spend", {
        counts: { engine: 1_100_000, classify: 150_000, total: 1_250_000 },
      });
      const summary = buildSummaryReport(runInput(), diagnostics.drain());
      expect(summary.budget).toEqual({ allotted: 1_200_000, spent: 1_250_000 });
    });

    /**
     * The regression this guards: `spent` used to be whichever diagnostic's `counts.tokens` happened
     * to fire last in the stream, and in the ordinary case that was `classify.audited` — the
     * classification self-audit's own bill, an order of magnitude below what the engine itself
     * spent. `classify.audited` still carries its own `tokens` field for its own purpose (see
     * `review.ts`'s `repairFindingClassification`), so this proves it specifically is never read as
     * run spend even when it is the very last record in the stream, not merely that something else
     * happens to win a tie.
     */
    it("never reads spend from classify.audited's counts.tokens, even as the last record", () => {
      const diagnostics = createDiagnostics(() => undefined);
      diagnostics.record("engine.run.completed", { counts: { bytes: 500, budget: 1_200_000 } });
      diagnostics.record("run.spend", {
        counts: { engine: 1_100_000, classify: 150_000, total: 1_250_000 },
      });
      // Recorded after run.spend and carrying an unrelated, much smaller tokens count — if
      // extractBudget still scanned for any counts.tokens field, this would silently overwrite the
      // real total above with the classification audit's own bill.
      diagnostics.record("classify.audited", { counts: { changed: 1, tokens: 400 } });
      const summary = buildSummaryReport(runInput(), diagnostics.drain());
      expect(summary.budget).toEqual({ allotted: 1_200_000, spent: 1_250_000 });
    });

    it("leaves spent undefined when only unrelated diagnostics carry a tokens count", () => {
      const diagnostics = createDiagnostics(() => undefined);
      diagnostics.record("engine.run.completed", { counts: { bytes: 500, budget: 1_200_000 } });
      diagnostics.record("classify.repaired", { counts: { repaired: 1, failed: 0, tokens: 300 } });
      diagnostics.record("classify.audited", { counts: { changed: 0, tokens: 400 } });
      const summary = buildSummaryReport(runInput(), diagnostics.drain());
      expect(summary.budget).toEqual({ allotted: 1_200_000, spent: undefined });
    });

    it("leaves both undefined when the engine never completed this run", () => {
      const summary = buildSummaryReport(runInput(), []);
      expect(summary.budget).toEqual({ allotted: undefined, spent: undefined });
    });
  });

  it("carries the caller-measured duration straight through, unmodified", () => {
    const summary = buildSummaryReport(runInput({ durationMs: 7_531 }), []);
    expect(summary.durationMs).toBe(7_531);
  });
});
