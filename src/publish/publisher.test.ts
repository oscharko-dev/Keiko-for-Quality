import { beforeEach, describe, expect, it } from "vitest";

import { commitSha, repoPath } from "../core/brands.js";
import { createSilentDiagnostics } from "../diagnostics/sink.js";
import type { EngineFinding } from "../engine/result.js";
import {
  GitHubApiError,
  type RepoRef,
  type ReviewComment,
  type ReviewCommentApi,
  type ReviewCommentInput,
} from "../github/client.js";
import type { InventoryItem } from "../inventory/classify.js";
import { composeBody, fingerprint } from "./marker.js";
import { publishFindings, publishIncompleteNotice, type PublishContext } from "./publisher.js";

const HEAD = commitSha("b".repeat(40));
const REF: RepoRef = { owner: "acme", repo: "widget" };
const IDENTITY = "keiko-for-quality[bot]";
const BODY =
  "The retry loop never resets the attempt counter, so it spins forever after one failure.";

/**
 * A scriptable stand-in for the review-comment API.
 *
 * `rejectWith` lets a test make specific anchors fail the way GitHub does, which is how the
 * placement ladder gets exercised without a network.
 */
class FakeApi implements ReviewCommentApi {
  public existing: ReviewComment[] = [];
  public created: ReviewCommentInput[] = [];
  public rejectWith = new Map<string, number>();
  /**
   * Paths whose every placement attempt is rejected with 422, regardless of `rejectWith` — lets a
   * test give one finding's entire ladder no path to succeed while a different finding's placements
   * proceed normally (Keiko-for-Quality#63's "only some of several findings reject" scenario, which
   * `rejectWith` alone cannot express since it rejects by anchor kind across every finding).
   */
  public rejectPaths = new Set<string>();
  public readBackOverride: Partial<ReviewComment> | undefined;
  private nextId = 100;

  public listReviewComments(): Promise<ReviewComment[]> {
    return Promise.resolve(this.existing);
  }

  public createReviewComment(
    _ref: RepoRef,
    _number: number,
    input: ReviewCommentInput,
  ): Promise<ReviewComment> {
    if (this.rejectPaths.has(input.path)) return Promise.reject(new GitHubApiError(422));
    const key = input.line === undefined ? "file" : (input.side ?? "RIGHT");
    const status = this.rejectWith.get(key);
    if (status !== undefined) return Promise.reject(new GitHubApiError(status));
    this.created.push(input);
    const comment: ReviewComment = {
      id: (this.nextId += 1),
      body: input.body,
      path: input.path,
      authorLogin: IDENTITY,
      commitId: input.commitId,
      url: "https://example.test/c",
    };
    this.existing = [...this.existing, comment];
    return Promise.resolve(comment);
  }

  public getReviewComment(_ref: RepoRef, id: number): Promise<ReviewComment> {
    const found = this.existing.find((c) => c.id === id);
    if (found === undefined) return Promise.reject(new GitHubApiError(404));
    return Promise.resolve({ ...found, ...this.readBackOverride });
  }
}

function finding(overrides: Partial<EngineFinding> = {}): EngineFinding {
  return {
    path: repoPath("src/retry.ts"),
    content: BODY,
    startLine: 10,
    endLine: 12,
    severity: "high",
    category: "bug",
    ...overrides,
  };
}

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    path: repoPath("src/retry.ts"),
    status: "M",
    classification: { kind: "reviewed" },
    modeChanged: false,
    reviewable: true,
    changedLines: 0,
    ...overrides,
  };
}

let api: FakeApi;
let context: PublishContext;

beforeEach(() => {
  api = new FakeApi();
  context = {
    client: api,
    ref: REF,
    pullNumber: 7,
    headSha: HEAD,
    identity: IDENTITY,
    items: new Map([["src/retry.ts", item()]]),
  };
});

const diagnostics = createSilentDiagnostics();

describe("publishFindings", () => {
  it("publishes a finding as a line-anchored conversation bound to the reviewed head", async () => {
    const outcome = await publishFindings(context, [finding()], diagnostics);
    expect(outcome.published).toBe(1);
    expect(api.created[0]).toMatchObject({
      path: "src/retry.ts",
      line: 12,
      startLine: 10,
      side: "RIGHT",
      commitId: HEAD,
    });
  });

  it("rejects a finding whose body fails sanitization instead of publishing it", async () => {
    const outcome = await publishFindings(
      context,
      [finding({ content: `${BODY} <script>x</script>` })],
      diagnostics,
    );
    expect(outcome).toMatchObject({ published: 0, rejectedSanitization: 1 });
    expect(api.created).toHaveLength(0);
  });

  describe("placement ladder", () => {
    it("falls back to the deletion side when the head line is not on the diff", async () => {
      api.rejectWith.set("RIGHT", 422);
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome.published).toBe(1);
      expect(api.created[0]).toMatchObject({ side: "LEFT", line: 12 });
    });

    it("falls back to a file-level conversation when no line anchor is accepted", async () => {
      api.rejectWith.set("RIGHT", 422);
      api.rejectWith.set("LEFT", 422);
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome.published).toBe(1);
      expect(api.created[0]?.line).toBeUndefined();
    });

    it("anchors a finding about a deleted file at file level without trying a line", async () => {
      context = {
        ...context,
        items: new Map([
          [
            "tests/pin.test.ts",
            item({
              path: repoPath("tests/pin.test.ts"),
              status: "D",
              classification: { kind: "reviewed-as-deletion" },
            }),
          ],
        ]),
      };
      const outcome = await publishFindings(
        context,
        [finding({ path: repoPath("tests/pin.test.ts") })],
        diagnostics,
      );
      expect(outcome.published).toBe(1);
      expect(api.created).toHaveLength(1);
      expect(api.created[0]?.line).toBeUndefined();
    });

    it("records a placement rejection when every anchor is refused", async () => {
      api.rejectWith.set("RIGHT", 422);
      api.rejectWith.set("LEFT", 422);
      api.rejectWith.set("file", 422);
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 0, rejectedPlacement: 1 });
    });

    /**
     * Keiko-for-Quality#63: production evidence was a run that settled incomplete with reason
     * `publish.finding_rejected_placement` and nothing else — an operator reading the diagnostic
     * could not tell "only a line anchor was ever tried" apart from "the file-level retry ran too,
     * and GitHub refused that as well". The ladder above already retries at file level before
     * `publishComposedFinding` gives up (see the "falls back to a file-level conversation" and
     * "anchors a finding about a deleted file" cases above), so the fix is not adding that retry —
     * it is making the diagnostic honest about which attempts, plural, actually happened. Against
     * unmodified source this fails: today's `diagnostics.record` call for this code carries no
     * `counts` field at all, so `record?.counts` is `undefined`.
     */
    it("carries both attempt outcomes — line-anchored and file-level — in the rejection diagnostic", async () => {
      api.rejectWith.set("RIGHT", 422);
      api.rejectWith.set("LEFT", 422);
      api.rejectWith.set("file", 422);
      const localDiagnostics = createSilentDiagnostics();
      const outcome = await publishFindings(context, [finding()], localDiagnostics);
      expect(outcome).toMatchObject({ published: 0, rejectedPlacement: 1 });

      const record = localDiagnostics
        .drain()
        .find((entry) => entry.code === "publish.finding_rejected_placement");
      // One rejected RIGHT attempt, one rejected LEFT (deletion-side) attempt, one rejected
      // file-level attempt — the complete tally of every anchor kind this finding tried.
      expect(record?.counts).toStrictEqual({ line: 1, deletion: 1, file: 1 });
    });

    it("tallies a deleted-file rejection as the single file-level attempt it actually made", async () => {
      context = {
        ...context,
        items: new Map([
          [
            "tests/pin.test.ts",
            item({
              path: repoPath("tests/pin.test.ts"),
              status: "D",
              classification: { kind: "reviewed-as-deletion" },
            }),
          ],
        ]),
      };
      api.rejectWith.set("file", 422);
      const localDiagnostics = createSilentDiagnostics();
      const outcome = await publishFindings(
        context,
        [finding({ path: repoPath("tests/pin.test.ts") })],
        localDiagnostics,
      );
      expect(outcome).toMatchObject({ published: 0, rejectedPlacement: 1 });

      const record = localDiagnostics
        .drain()
        .find((entry) => entry.code === "publish.finding_rejected_placement");
      // A deletion never had a line-anchored attempt to make — the ladder is file-only from the
      // start, so the honest tally is one attempt, not a fabricated line/deletion pair.
      expect(record?.counts).toStrictEqual({ file: 1 });
    });

    it("tallies each finding's rejection independently when only some of several findings are rejected", async () => {
      context = {
        ...context,
        items: new Map([
          ["src/retry.ts", item()],
          ["src/other.ts", item({ path: repoPath("src/other.ts") })],
        ]),
      };
      // Only src/other.ts is doomed — src/retry.ts's ladder is untouched and succeeds on RIGHT.
      api.rejectPaths.add("src/other.ts");
      const localDiagnostics = createSilentDiagnostics();
      const outcome = await publishFindings(
        context,
        [finding(), finding({ path: repoPath("src/other.ts"), startLine: 40, endLine: 42 })],
        localDiagnostics,
      );
      expect(outcome).toMatchObject({ published: 1, rejectedPlacement: 1 });
      expect(api.created).toHaveLength(1);
      expect(api.created[0]?.path).toBe("src/retry.ts");

      // Exactly one rejection event, carrying only the rejected finding's own tally — the
      // successfully-published finding must not leak into or dilute it.
      const rejections = localDiagnostics
        .drain()
        .filter((entry) => entry.code === "publish.finding_rejected_placement");
      expect(rejections).toHaveLength(1);
      expect(rejections[0]?.counts).toStrictEqual({ line: 1, deletion: 1, file: 1 });
    });

    /**
     * Keiko-for-Quality#63's explicit acceptance shape: "A file-level-published finding is a
     * published finding: it counts in published, carries its marker, participates in dedup." This
     * already holds on unmodified source — placement is not part of a finding's identity — but it
     * is exactly the property the fallback above would be worthless without, so it is pinned here
     * rather than left to accident.
     */
    it("suppresses a repost of a finding that was previously published at file level", async () => {
      api.rejectWith.set("RIGHT", 422);
      api.rejectWith.set("LEFT", 422);
      const firstRun = await publishFindings(context, [finding()], diagnostics);
      expect(firstRun).toMatchObject({ published: 1 });
      expect(api.created).toHaveLength(1);
      expect(api.created[0]?.line).toBeUndefined();

      // A second run would succeed if it ever tried a line anchor — proving the suppression below
      // is genuine deduplication, not an artifact of every placement still failing.
      api.rejectWith.clear();
      const secondRun = await publishFindings(context, [finding()], diagnostics);
      expect(secondRun).toMatchObject({
        published: 0,
        suppressed: 1,
        suppressedExactDuplicate: 1,
      });
      expect(api.created).toHaveLength(1);
    });

    it("does not treat a non-422 failure as a reason to try a different anchor", async () => {
      api.rejectWith.set("RIGHT", 403);
      await expect(publishFindings(context, [finding()], diagnostics)).rejects.toThrow(
        GitHubApiError,
      );
      expect(api.created).toHaveLength(0);
    });
  });

  describe("deduplication", () => {
    function markedComment(author: string, body: string): ReviewComment {
      const marker = fingerprint({
        repository: "acme/widget",
        pullNumber: 7,
        path: "src/retry.ts",
        rule: "bug",
        body,
      });
      return {
        id: 1,
        body: composeBody(body, marker),
        path: "src/retry.ts",
        authorLogin: author,
        commitId: HEAD,
        url: "https://example.test/existing",
      };
    }

    it("suppresses a repost of its own still-open finding", async () => {
      api.existing = [markedComment(IDENTITY, BODY)];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      // The exact-marker stage claims this one, not the similarity stage — see the run summary's
      // (Keiko-for-Quality#31/#50) two-stage visibility requirement, which depends on this split.
      expect(outcome).toMatchObject({
        published: 0,
        suppressed: 1,
        suppressedExactDuplicate: 1,
        suppressedSimilar: 0,
      });
    });

    // A marker is a public string in a public comment. Without the author check, anyone who can
    // comment could pre-post the fingerprint of a finding they expect and silence it permanently.
    it("ignores an identical marker authored by anyone else", async () => {
      api.existing = [markedComment("contributor", BODY)];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("still publishes when the marker belongs to a different finding", async () => {
      api.existing = [
        markedComment(IDENTITY, "An unrelated earlier finding about something else."),
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome.published).toBe(1);
    });

    it("treats cosmetic rewording of the same finding as the same finding", async () => {
      api.existing = [markedComment(IDENTITY, BODY.toUpperCase())];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 0, suppressed: 1 });
    });
  });

  /**
   * Keiko-for-Quality#38: the exact-marker stage above hashes normalized finding text, so a model
   * that words the same defect differently on a re-run produces a new marker and the stage above
   * never fires. These prove the second, phrasing-independent stage catches exactly that case
   * without swallowing a genuinely different finding at the same or an adjacent line.
   */
  describe("paraphrase deduplication (similarity stage)", () => {
    const REPHRASED_SAME_DEFECT =
      "The retry loop keeps spinning forever because it never resets its attempt counter after a failure.";
    const UNRELATED_DEFECT =
      "This endpoint never validates that the request payload size stays under the configured " +
      "limit before buffering it into memory.";

    function openComment(body: string, overrides: Partial<ReviewComment> = {}): ReviewComment {
      return {
        id: 1,
        body,
        path: "src/retry.ts",
        authorLogin: IDENTITY,
        commitId: HEAD,
        url: "https://example.test/existing",
        line: 12,
        startLine: 10,
        ...overrides,
      };
    }

    it("suppresses a rephrased repost of the same finding at the same location", async () => {
      api.existing = [openComment(REPHRASED_SAME_DEFECT)];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      // The similarity stage claims this one, not the exact-marker stage — the two counts must stay
      // distinguishable so an operator (or the run summary) can tell the mechanisms apart.
      expect(outcome).toMatchObject({
        published: 0,
        suppressed: 1,
        suppressedExactDuplicate: 0,
        suppressedSimilar: 1,
      });
      expect(api.created).toHaveLength(0);
    });

    it("still publishes a genuinely different finding at the same line", async () => {
      api.existing = [openComment(UNRELATED_DEFECT)];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("still publishes a genuinely different finding on an adjacent line", async () => {
      api.existing = [openComment(UNRELATED_DEFECT, { line: 13, startLine: 13 })];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("does not suppress once the matching conversation is resolved", async () => {
      api.existing = [openComment(REPHRASED_SAME_DEFECT, { resolved: true })];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("does not suppress a rephrasing authored by someone else", async () => {
      api.existing = [openComment(REPHRASED_SAME_DEFECT, { authorLogin: "contributor" })];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("does not suppress against a conversation with no usable line anchor", async () => {
      // A file-level comment: no `line`/`startLine` key at all, distinct from setting either to
      // `undefined` (which `exactOptionalPropertyTypes` would reject as a caller error anyway).
      api.existing = [
        {
          id: 1,
          body: REPHRASED_SAME_DEFECT,
          path: "src/retry.ts",
          authorLogin: IDENTITY,
          commitId: HEAD,
          url: "https://example.test/existing",
        },
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("does not suppress anything against an empty existing-conversation list", async () => {
      api.existing = [];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });
  });

  /**
   * Keiko-for-Quality#64: the similarity stage above deliberately excludes every resolved
   * conversation, so a genuinely recurred defect stays publishable (Keiko-for-Quality#38's
   * contract). Observed live on a long-lived pull request (oscharko-dev/Keiko#2931, rounds 6-10): a
   * dispositioned finding — reasoned reply, thread resolved — reappeared as a "fresh" finding on
   * every later run, because that exclusion has no memory of *why* a thread was resolved. These
   * prove the narrower, additive case end to end — from the raw `ReviewComment.lastReply` this
   * reviewer's own GraphQL lookup would report through `toExistingConversation` and
   * `isSubstantiveDisposition` to the counters and diagnostics a run actually reports — while
   * pinning that a resolved conversation with no considered reply still republishes exactly as
   * before.
   */
  describe("dispositioned deduplication (Keiko-for-Quality#64)", () => {
    const REPHRASED_SAME_DEFECT =
      "The retry loop keeps spinning forever because it never resets its attempt counter after a failure.";
    const REAL_DISPOSITION =
      "Fixed in commit abc1234 - the retry loop now resets its counter on every failure path. See " +
      "the follow-up pull request for the full explanation of the change.";

    function resolvedComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
      return {
        id: 1,
        body: BODY,
        path: "src/retry.ts",
        authorLogin: IDENTITY,
        commitId: HEAD,
        url: "https://example.test/existing",
        line: 12,
        startLine: 10,
        resolved: true,
        ...overrides,
      };
    }

    it("suppresses a recurrence at a resolved, dispositioned location and counts it distinctly", async () => {
      api.existing = [
        resolvedComment({ lastReply: { authorLogin: "a-contributor", body: REAL_DISPOSITION } }),
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({
        published: 0,
        suppressed: 1,
        suppressedExactDuplicate: 0,
        suppressedSimilar: 0,
        suppressedDispositioned: 1,
      });
      expect(api.created).toHaveLength(0);
    });

    it("suppresses a paraphrase, not just an exact repeat, at a dispositioned location", async () => {
      api.existing = [
        resolvedComment({
          body: REPHRASED_SAME_DEFECT,
          lastReply: { authorLogin: "a-contributor", body: REAL_DISPOSITION },
        }),
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 0, suppressedDispositioned: 1 });
    });

    it("records the dedup.dispositioned diagnostic on suppression", async () => {
      api.existing = [
        resolvedComment({ lastReply: { authorLogin: "a-contributor", body: REAL_DISPOSITION } }),
      ];
      const localDiagnostics = createSilentDiagnostics();
      await publishFindings(context, [finding()], localDiagnostics);
      const codes = localDiagnostics.drain().map((record) => record.code);
      expect(codes).toContain("dedup.dispositioned");
    });

    // The exact case Keiko-for-Quality#38 protects and #64 must not regress: a resolved thread with
    // no reply at all republishes a genuine recurrence exactly as it did before this feature existed.
    it("still republishes when the thread is resolved but carries no reply at all (a bare resolve)", async () => {
      api.existing = [resolvedComment()]; // no `lastReply` — the GraphQL lookup found nothing to report
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0, suppressedDispositioned: 0 });
    });

    it("still republishes when the thread's only reply is a short, non-substantive acknowledgement", async () => {
      api.existing = [
        resolvedComment({ lastReply: { authorLogin: "a-contributor", body: "Resolved, thanks." } }),
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0, suppressedDispositioned: 0 });
    });

    // The scenario `disposition.ts` exists to exclude: a thread whose only comment is its own root
    // finding reports that same comment back as `lastReply` — there is no reply from anyone else.
    it("still republishes when the reported 'last reply' is this reviewer's own root comment", async () => {
      api.existing = [
        resolvedComment({ lastReply: { authorLogin: IDENTITY, body: REAL_DISPOSITION } }),
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0, suppressedDispositioned: 0 });
    });

    it("does not suppress a genuinely different defect at the same dispositioned location", async () => {
      api.existing = [
        resolvedComment({
          body: "An unrelated earlier finding about something else entirely.",
          lastReply: { authorLogin: "a-contributor", body: REAL_DISPOSITION },
        }),
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("does not suppress a dispositioned conversation authored by someone else", async () => {
      api.existing = [
        resolvedComment({
          authorLogin: "contributor",
          lastReply: { authorLogin: "another-contributor", body: REAL_DISPOSITION },
        }),
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });
  });

  describe("read-back confirmation", () => {
    it("does not count a comment as published when it comes back bound to another head", async () => {
      api.readBackOverride = { commitId: "c".repeat(40) };
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 0, readbackFailures: 1 });
    });

    it("does not count a comment as published when it comes back under another author", async () => {
      api.readBackOverride = { authorLogin: "someone-else" };
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 0, readbackFailures: 1 });
    });
  });
});

/**
 * Keiko-for-Quality#38's secondary defect: two byte-identical incomplete-review notices were
 * published against the same head, which the marker mechanism should already have suppressed.
 * These pin the two contributing fixes: the notice marker now keys on `head` (so a stale head's
 * notice can never alias a fresh head's), and a resolved notice conversation does not block a
 * recurrence — the same contract markers already hold for findings.
 */
describe("publishIncompleteNotice", () => {
  const ANCHOR = "docs/adr/ADR-0117-something.md";
  const REASON = "settlement.incomplete.engine_error";

  it("suppresses a repost of the identical (anchor, reason, head)", async () => {
    await publishIncompleteNotice(context, REASON, ANCHOR, diagnostics);
    await publishIncompleteNotice(context, REASON, ANCHOR, diagnostics);
    expect(api.created).toHaveLength(1);
  });

  it("publishes independently for a fresh head even when the reason and anchor repeat", async () => {
    await publishIncompleteNotice(context, REASON, ANCHOR, diagnostics);
    const freshContext: PublishContext = { ...context, headSha: commitSha("c".repeat(40)) };
    const secondVerified = await publishIncompleteNotice(freshContext, REASON, ANCHOR, diagnostics);
    expect(api.created).toHaveLength(2);
    expect(secondVerified).toBe(true);
  });

  it("does not suppress once the earlier notice's conversation is resolved", async () => {
    await publishIncompleteNotice(context, REASON, ANCHOR, diagnostics);
    expect(api.existing).toHaveLength(1);
    api.existing = api.existing.map((comment) => ({ ...comment, resolved: true }));

    await publishIncompleteNotice(context, REASON, ANCHOR, diagnostics);
    expect(api.created).toHaveLength(2);
  });

  it("ignores an identical marker authored by anyone else", async () => {
    await publishIncompleteNotice(context, REASON, ANCHOR, diagnostics);
    api.existing = api.existing.map((comment) => ({ ...comment, authorLogin: "contributor" }));

    await publishIncompleteNotice(context, REASON, ANCHOR, diagnostics);
    expect(api.created).toHaveLength(2);
  });
});
