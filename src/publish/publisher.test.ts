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
import { fingerprint, markerComment } from "./marker.js";
import { composeFindingBody } from "./presentation.js";
import {
  executePublication,
  planPublication,
  prefetchExistingConversations,
  publishFindings,
  publishIncompleteNotice,
  type PublicationPlan,
  type PublishContext,
} from "./publisher.js";

const HEAD = commitSha("b".repeat(40));
const BASE = commitSha("a".repeat(40));
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
  /**
   * Path → arbitrary status: like `rejectPaths`, but not fixed at 422 — lets a test make exactly one
   * finding's create call throw a real failure (a 403 that outlasted the client's own retries, say)
   * while a different finding in the same run publishes normally, which is what per-finding API
   * failure containment needs to exercise and `rejectWith` (shared by anchor kind across every
   * finding) cannot express alone.
   */
  public rejectPathWith = new Map<string, number>();
  /** Forces every `getReviewComment` call to throw, regardless of whether the id exists — a
   *  transient read-after-write failure on an otherwise-successful POST. */
  public failReadBack = false;
  public readBackOverride: Partial<ReviewComment> | undefined;
  /** Counts `listReviewComments` calls so a test can assert a supplied prefetch avoided one. */
  public listCalls = 0;
  /** Counts `getReviewComment` calls so a test can assert the plan phase never read anything back. */
  public getCalls = 0;
  private nextId = 100;

  public listReviewComments(): Promise<ReviewComment[]> {
    this.listCalls += 1;
    return Promise.resolve(this.existing);
  }

  public createReviewComment(
    _ref: RepoRef,
    _number: number,
    input: ReviewCommentInput,
  ): Promise<ReviewComment> {
    if (this.rejectPaths.has(input.path)) return Promise.reject(new GitHubApiError(422));
    const pathStatus = this.rejectPathWith.get(input.path);
    if (pathStatus !== undefined) return Promise.reject(new GitHubApiError(pathStatus));
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
    this.getCalls += 1;
    if (this.failReadBack) return Promise.reject(new GitHubApiError(404));
    const found = this.existing.find((c) => c.id === id);
    if (found === undefined) return Promise.reject(new GitHubApiError(404));
    return Promise.resolve({ ...found, ...this.readBackOverride });
  }

  /** Never exercised by this suite — the cleanup pass is a `review.ts`-level concern (`review.test.ts`
   *  covers it), never reached from anything `publisher.ts` itself calls. */
  public resolveSupersededOwnNotices(): Promise<{
    readonly attempted: number;
    readonly resolved: number;
  }> {
    return Promise.resolve({ attempted: 0, resolved: 0 });
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
    baseSha: BASE,
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
      const outcome = await publishFindings(context, [finding()], diagnostics);
      // Fix 1: contained as an API failure rather than left to reject the whole run — but the
      // ladder still must not have treated the 403 as a reason to try LEFT or file-level next, the
      // way it correctly does for a 422. `api.created` staying empty is what proves that: had the
      // ladder wrongly retried, the untouched LEFT/file anchors below would have succeeded.
      expect(outcome).toMatchObject({ published: 0, apiFailures: 1 });
      expect(api.created).toHaveLength(0);
    });
  });

  /**
   * The exact-marker stage's own eligibility (`ownMarkers`, `publisher.ts`) diverges from the
   * similarity stage's, deliberately: a marker fingerprints CONTENT, never a coordinate, so only a
   * GENUINELY RESOLVED thread excludes it — an outdated-but-unresolved thread's marker stays active
   * and keeps suppressing a repost. This is what stops a push that only moves a hunk, with nobody
   * ever answering the thread, from republishing an already-published, still-open finding as a new
   * conversation — measured as the dominant source of duplicate findings in the reviewer arena
   * before this split existed. The four `resolved`/`outdated` combinations below are the complete
   * eligibility matrix for this one stage; "similarity against an outdated-open thread" is pinned
   * separately, in "paraphrase deduplication (similarity stage)", where the opposite choice is
   * equally deliberate.
   */
  describe("deduplication", () => {
    function markedComment(
      author: string,
      body: string,
      overrides: Partial<ReviewComment> = {},
    ): ReviewComment {
      const marker = fingerprint({
        repository: "acme/widget",
        pullNumber: 7,
        path: "src/retry.ts",
        rule: "bug",
        body,
      });
      return {
        id: 1,
        // Built by the production composer, so this fixture cannot drift from the body a
        // publication really carries — which is the shape deduplication has to recognise.
        body: composeFindingBody(body, markerComment(marker), {
          path: "src/retry.ts",
          line: 1,
          severity: "medium",
          category: "bug",
        }),
        path: "src/retry.ts",
        authorLogin: author,
        commitId: HEAD,
        url: "https://example.test/existing",
        ...overrides,
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

    /**
     * The four-row eligibility matrix for `ownMarkers`, `resolved`/`outdated` independent as
     * `github/client.ts` now reports them.
     */
    describe("resolved/outdated eligibility", () => {
      it("suppresses when its own marker's thread is open (neither resolved nor outdated) — unchanged", async () => {
        api.existing = [markedComment(IDENTITY, BODY)];
        const outcome = await publishFindings(context, [finding()], diagnostics);
        expect(outcome).toMatchObject({
          published: 0,
          suppressed: 1,
          suppressedExactDuplicate: 1,
        });
      });

      it("republishes when its own marker's thread is genuinely resolved — unchanged (Keiko-for-Quality#38)", async () => {
        api.existing = [markedComment(IDENTITY, BODY, { resolved: true })];
        const outcome = await publishFindings(context, [finding()], diagnostics);
        expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
      });

      /**
       * THE FIX, and the regression pin for the dominant duplicate source measured in the reviewer
       * arena. Before `resolved`/`outdated` were reported as independent facts, an outdated thread
       * read as `resolved: true` here — indistinguishable from a genuine resolution — so this exact
       * marker would have been excluded from `ownMarkers` and the still-open finding it protects
       * would have republished as a brand-new conversation on every push that moved the hunk. The
       * marker fingerprints content, not a line number, so an outdated hunk must not by itself
       * unlock a repost.
       */
      it("NOW SUPPRESSES when its own marker's thread is outdated but not resolved (the fix)", async () => {
        api.existing = [markedComment(IDENTITY, BODY, { outdated: true })];
        const outcome = await publishFindings(context, [finding()], diagnostics);
        expect(outcome).toMatchObject({
          published: 0,
          suppressed: 1,
          suppressedExactDuplicate: 1,
        });
      });

      it("republishes when its own marker's thread is both outdated and genuinely resolved — resolved wins", async () => {
        api.existing = [markedComment(IDENTITY, BODY, { resolved: true, outdated: true })];
        const outcome = await publishFindings(context, [finding()], diagnostics);
        expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
      });
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

    /**
     * The outdated thread stays ineligible for THIS stage — precision choice, not an oversight, and
     * pinned separately from the exact-marker stage's own eligibility (see "resolved/outdated
     * eligibility" above, where the same `outdated: true` shape suppresses instead). An outdated
     * thread's line anchor is GitHub's `original_line`/`original_start_line` fallback (`client.ts`'s
     * `toReviewComment`): a stale coordinate from before the push moved the hunk, and this stage's
     * whole job is judging line overlap plus body similarity, so matching against it would be noise.
     *
     * What changed is that the repost no longer publishes anyway: the recurrence stage
     * (`findsOutdatedRecurrence`) claims it instead, on a body match alone at a deliberately higher
     * bar, with no coordinate involved. The two counts stay distinguishable precisely so this
     * distinction survives — `suppressedSimilar` is still 0 here.
     */
    it("routes a rephrased repost against an outdated, unresolved thread to the recurrence stage", async () => {
      api.existing = [openComment(REPHRASED_SAME_DEFECT, { outdated: true })];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({
        published: 0,
        suppressed: 1,
        suppressedSimilar: 0,
        suppressedRecurrence: 1,
      });
      expect(api.created).toHaveLength(0);
    });

    /**
     * The #38 contract the recurrence stage must not erode: someone looked at this thread and
     * resolved it, so a defect that comes back has to be able to speak again. `outdated` alongside
     * `resolved` changes nothing — resolution wins, and `outdatedOnly` is false by construction.
     */
    it("still publishes a recurrence against a thread that is both resolved and outdated", async () => {
      api.existing = [openComment(REPHRASED_SAME_DEFECT, { outdated: true, resolved: true })];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    /**
     * And the precision half: without a line anchor to narrow on, the body carries the whole
     * decision, so a genuinely different defect in the same file must still publish. This is the
     * shape that would fail first if `RECURRENCE_THRESHOLD` were relaxed toward the ordinary
     * similarity threshold.
     */
    it("still publishes a different defect in the same file against an outdated thread", async () => {
      api.existing = [openComment(UNRELATED_DEFECT, { outdated: true })];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("does not suppress a recurrence against an outdated thread someone else authored", async () => {
      api.existing = [
        openComment(REPHRASED_SAME_DEFECT, { outdated: true, authorLogin: "contributor" }),
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("does not suppress a rephrasing authored by someone else", async () => {
      api.existing = [openComment(REPHRASED_SAME_DEFECT, { authorLogin: "contributor" })];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    /** A file-level comment: no `line`/`startLine` key at all, distinct from setting either to
     *  `undefined` (which `exactOptionalPropertyTypes` would reject as a caller error anyway). */
    function fileLevelComment(body: string, overrides: Partial<ReviewComment> = {}): ReviewComment {
      return {
        id: 1,
        body,
        path: "src/retry.ts",
        authorLogin: IDENTITY,
        commitId: HEAD,
        url: "https://example.test/existing",
        ...overrides,
      };
    }

    /**
     * Until 2026-08-06 this exact shape PUBLISHED (`published: 1`) — the audit finding this pins:
     * a finding that landed as a file-level comment (deleted file, unknown path, `(0, 0)` anchor,
     * 422 fallback) read back with no line anchor and no `original_*` either, so the similarity
     * stage's range check refused it, and — because GitHub can never mark an anchor-less thread
     * outdated — the recurrence stage's `outdatedOnly` gate refused it too. Every rewording
     * republished the still-open finding as a brand-new conversation. The recurrence stage now
     * claims it, on the same raised coordinate-free bar it already holds for outdated threads;
     * `suppressedSimilar` stays 0 so the anchored stage's own precision choice remains visible.
     */
    it("routes a rephrased repost against a file-level (anchor-less) thread to the recurrence stage", async () => {
      api.existing = [fileLevelComment(REPHRASED_SAME_DEFECT)];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({
        published: 0,
        suppressed: 1,
        suppressedSimilar: 0,
        suppressedRecurrence: 1,
      });
      expect(api.created).toHaveLength(0);
    });

    /**
     * The precision half, same as for outdated threads: without an anchor the body carries the
     * whole decision, so a genuinely different defect in the same file must still publish —
     * over-suppression here would swallow a NEW finding, which is worse than a duplicate.
     */
    it("still publishes a different defect in the same file against a file-level thread", async () => {
      api.existing = [fileLevelComment(UNRELATED_DEFECT)];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    /**
     * The #38 contract, unchanged by the anchor-less clause: someone resolved the file-level
     * thread, so a defect that comes back has to be able to speak again.
     */
    it("still publishes a recurrence once the file-level thread is resolved", async () => {
      api.existing = [fileLevelComment(REPHRASED_SAME_DEFECT, { resolved: true })];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    });

    it("does not suppress against a file-level thread someone else authored", async () => {
      api.existing = [fileLevelComment(REPHRASED_SAME_DEFECT, { authorLogin: "contributor" })];
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

    // Unchanged by the resolved/outdated split: `resolved` is set directly (`true`) on this fixture
    // regardless of `outdated`, and this stage's own eligibility (`thread.resolved && thread.dispositioned`)
    // never looked at `outdated` in the first place — a resolved thread's disposition does not become
    // less considered just because a later push also moved its hunk.
    it("still suppresses a dispositioned recurrence when the resolved thread is also outdated", async () => {
      api.existing = [
        resolvedComment({
          outdated: true,
          lastReply: { authorLogin: "a-contributor", body: REAL_DISPOSITION },
        }),
      ];
      const outcome = await publishFindings(context, [finding()], diagnostics);
      expect(outcome).toMatchObject({ published: 0, suppressedDispositioned: 1 });
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

    // A GET that throws (a transient network fault, a 403 secondary rate limit that exhausted its
    // own retries) must settle exactly like a GET that succeeds but reports a mismatch: the POST may
    // have landed on GitHub even though this run could not confirm it, so it is unconfirmed, not a
    // reason to abandon the run. Two findings prove the loop keeps going past the first one, too.
    it("treats a thrown read-back GET as unconfirmed, not fatal, and keeps publishing later findings", async () => {
      context = {
        ...context,
        items: new Map([
          ["src/retry.ts", item()],
          ["src/other.ts", item({ path: repoPath("src/other.ts") })],
        ]),
      };
      api.failReadBack = true;
      const outcome = await publishFindings(
        context,
        [finding(), finding({ path: repoPath("src/other.ts"), startLine: 40, endLine: 42 })],
        diagnostics,
      );
      expect(outcome).toMatchObject({ published: 0, readbackFailures: 2, apiFailures: 0 });
      // Both creates were attempted — only the read-back after each one failed.
      expect(api.created).toHaveLength(2);
    });
  });

  describe("per-finding API failure containment (Fix 1)", () => {
    it("contains a thrown non-422 create failure to the one finding and still attempts the rest", async () => {
      context = {
        ...context,
        items: new Map([
          ["src/retry.ts", item()],
          ["src/second.ts", item({ path: repoPath("src/second.ts") })],
          ["src/third.ts", item({ path: repoPath("src/third.ts") })],
        ]),
      };
      // Every attempt on src/second.ts's ladder throws a 403 — the shape of a secondary rate limit
      // that has already exhausted the client's own retries — while the other two findings' paths
      // are untouched by it.
      api.rejectPathWith.set("src/second.ts", 403);
      const localDiagnostics = createSilentDiagnostics();
      const outcome = await publishFindings(
        context,
        [
          finding(),
          finding({ path: repoPath("src/second.ts"), startLine: 20, endLine: 22 }),
          finding({ path: repoPath("src/third.ts"), startLine: 30, endLine: 32 }),
        ],
        localDiagnostics,
      );

      // The run resolved instead of rejecting (awaiting it above would itself have thrown
      // otherwise), the doomed finding counted as an API failure rather than a placement rejection,
      // and the finding queued behind it was still attempted and published.
      expect(outcome).toMatchObject({ published: 2, rejectedPlacement: 0, apiFailures: 1 });
      expect(api.created.map((c) => c.path)).toEqual(["src/retry.ts", "src/third.ts"]);
      expect(
        localDiagnostics.drain().filter((record) => record.code === "publish.api_failed"),
      ).toHaveLength(1);
    });
  });
});

/**
 * v0.12.0 — the intra-run deduplication stage: `planPublication` now clusters this run's own
 * sanitized candidates against EACH OTHER, between sanitization and the cross-run checks, so a model
 * that describes one defect several times in a single pass no longer publishes every retelling.
 * Named for the shape Arena v0.11.0 measured in production (29 duplicate variants across 95
 * published findings, 31%, one production location carrying one finding plus three variants) and for
 * the fixture already in this codebase's own history: the three real, textually different paraphrases
 * from oscharko-dev/Keiko#2926 (see `similarity.test.ts`'s `findsSimilarOpenConversation` suite,
 * where the same three sentences are pinned as mutually similar under the identical token-overlap
 * core `areIntraRunDuplicates` shares). This suite pins the REVIEWER's own production behaviour for
 * that shape; `corpus/arena-lib.test.mjs` pins only the arena's separate measurement of it.
 */
describe("intra-run deduplication (v0.12.0)", () => {
  const VARIANT_A =
    "Restore the route's fallback connector construction when the primary endpoint is unset.";
  const VARIANT_B =
    "Restore the route's default connector construction when the primary endpoint is missing.";
  const VARIANT_C =
    "Keep the fallback port construction for route requests when no primary endpoint exists.";

  function variant(body: string, overrides: Partial<EngineFinding> = {}): EngineFinding {
    return finding({ content: body, ...overrides });
  }

  it("collapses three same-location variants into one published finding and two intra-run suppressions (the Keiko-for-Quality#2926 shape)", async () => {
    const outcome = await publishFindings(
      context,
      [variant(VARIANT_A), variant(VARIANT_B), variant(VARIANT_C)],
      diagnostics,
    );
    expect(outcome).toMatchObject({
      published: 1,
      suppressed: 2,
      suppressedIntraRun: 2,
      suppressedExactDuplicate: 0,
      suppressedSimilar: 0,
      suppressedDispositioned: 0,
    });
    expect(api.created).toHaveLength(1);
  });

  it("publishes only one of the two exact-line Keiko#3089 baseline retellings", async () => {
    const first = variant(
      "Adjust uncoveredFiles to match new files count. When files reduced from 421 to 415 but " +
        "uncoveredFiles remains 3, coverage metrics become inconsistent, inflating reported " +
        "coverage percentage. CI coverage checks may report false positives, hiding uncovered files.",
      { startLine: 261, endLine: 261, category: "test" },
    );
    const second = variant(
      "Adjust uncoveredFiles after reducing files count. When files changed from 421 to 415 but " +
        "uncoveredFiles stayed 3, package-coverage-baseline.json now has inconsistent file metrics, " +
        "potentially referencing non-existent files. CI coverage validation may report inflated " +
        "coverage or break downstream scripts that assume consistency.",
      { startLine: 261, endLine: 261, category: "bug" },
    );

    const outcome = await publishFindings(context, [first, second], diagnostics);

    expect(outcome).toMatchObject({ published: 1, suppressed: 1, suppressedIntraRun: 1 });
    expect(api.created).toHaveLength(1);
  });

  /**
   * The bug this pins: clustering used to compare a new candidate only against a cluster's CURRENT
   * representative, not every member. Three candidates arriving in a chain — A~B share vocabulary,
   * B~C share a different code snippet, but A and C share neither — must still collapse into one
   * cluster, because B is real evidence C belongs with A even though C no longer resembles A
   * directly. Comparing only against the representative (A, which outranks B on severity and so
   * stays representative) would find no match for C and let it publish as a spurious "new" finding.
   */
  it("still clusters a candidate that matches a non-representative member, not only the current representative", async () => {
    const sharedSnippetAB =
      "```\nexpect(retryCount).toBe(3);\nexpect(counter.attempts).toBe(3);\n```";
    const sharedSnippetBC = "```\nbackoff = Math.min(backoff * 2, MAX_BACKOFF_MS);\n```";
    const bodyA = `This is a critical concern about the connector fallback logic. ${sharedSnippetAB}`;
    const bodyB =
      `This is a critical concern about the connector fallback logic, and also about ` +
      `counters. ${sharedSnippetAB} ${sharedSnippetBC}`;
    const bodyC =
      `This is a totally different observation about something else entirely unrelated. ` +
      sharedSnippetBC;

    const outcome = await publishFindings(
      context,
      [
        // A outranks B on severity, so A — not B — stays this cluster's representative once B
        // joins, which is exactly what makes the old (representative-only) comparison miss C.
        variant(bodyA, { severity: "critical" }),
        variant(bodyB),
        variant(bodyC),
      ],
      diagnostics,
    );

    expect(outcome).toMatchObject({
      published: 1,
      suppressed: 2,
      suppressedIntraRun: 2,
    });
    expect(api.created).toHaveLength(1);
  });

  it("records publish.finding_suppressed_intra_run once per suppressed variant, headSha only", async () => {
    const localDiagnostics = createSilentDiagnostics();
    await publishFindings(
      context,
      [variant(VARIANT_A), variant(VARIANT_B), variant(VARIANT_C)],
      localDiagnostics,
    );
    const records = localDiagnostics
      .drain()
      .filter((record) => record.code === "publish.finding_suppressed_intra_run");
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toStrictEqual({ code: "publish.finding_suppressed_intra_run", headSha: HEAD });
    }
  });

  it("leaves distinct findings at distinct locations untouched", async () => {
    context = {
      ...context,
      items: new Map([
        ["src/retry.ts", item()],
        ["src/other.ts", item({ path: repoPath("src/other.ts") })],
      ]),
    };
    const outcome = await publishFindings(
      context,
      [
        finding(),
        finding({
          path: repoPath("src/other.ts"),
          content:
            "This endpoint never validates that the request payload size stays under the " +
            "configured limit before buffering it into memory.",
          startLine: 40,
          endLine: 42,
        }),
      ],
      diagnostics,
    );
    expect(outcome).toMatchObject({ published: 2, suppressed: 0, suppressedIntraRun: 0 });
    expect(api.created).toHaveLength(2);
  });

  /**
   * `areIntraRunDuplicates`'s own suite (`similarity.test.ts`) pins the comparison in isolation; this
   * proves the same guarantee end to end — a suppressed member's content and category never drive an
   * API call or a diagnostic, because `planCrossRun` (`publisher.ts`) is only ever invoked on a
   * cluster's representative.
   */
  it("suppresses a variant before it ever reaches the marker, similarity, or dispositioned stages", async () => {
    // Keyed to VARIANT_B's own exact fingerprint. If `classifySuppression` ever ran on the
    // VARIANT_B finding, it would report an exact-duplicate suppression instead of an intra-run one
    // — VARIANT_B must never become this cluster's representative for that to stay untested, which
    // is exactly why VARIANT_A is seeded at "critical" below.
    const bMarker = fingerprint({
      repository: "acme/widget",
      pullNumber: 7,
      path: "src/retry.ts",
      rule: "bug",
      body: VARIANT_B,
    });
    api.existing = [
      {
        id: 1,
        body: composeFindingBody(VARIANT_B, markerComment(bMarker), {
          path: "src/retry.ts",
          line: 1,
          severity: "medium",
          category: "bug",
        }),
        path: "src/retry.ts",
        authorLogin: IDENTITY,
        commitId: HEAD,
        url: "https://example.test/existing",
      },
    ];
    const localDiagnostics = createSilentDiagnostics();
    const outcome = await publishFindings(
      context,
      [variant(VARIANT_A, { severity: "critical" }), variant(VARIANT_B), variant(VARIANT_C)],
      localDiagnostics,
    );

    // VARIANT_A (critical) is this cluster's representative throughout — see "representative
    // selection" below for the severity tie-break this depends on — so VARIANT_B and VARIANT_C are
    // the two suppressed members, and VARIANT_B's marker collision above is never evaluated.
    expect(outcome).toMatchObject({
      published: 1,
      suppressed: 2,
      suppressedIntraRun: 2,
      suppressedExactDuplicate: 0,
      suppressedSimilar: 0,
      suppressedDispositioned: 0,
    });
    expect(api.created).toHaveLength(1);
    expect(api.getCalls).toBe(1);

    const codes = localDiagnostics.drain().map((record) => record.code);
    expect(codes.filter((code) => code === "publish.finding_suppressed_intra_run")).toHaveLength(2);
    expect(codes).not.toContain("publish.finding_suppressed_duplicate");
    expect(codes).not.toContain("publish.finding_suppressed_similar");
    expect(codes).not.toContain("dedup.dispositioned");
  });

  /**
   * `clusterIntraRunDuplicates`'s (`publisher.ts`) own tie-break chain: severity first, sanitized
   * body length second. Both variants below share enough vocabulary to cluster (VARIANT_A/VARIANT_B,
   * pinned mutually similar in `similarity.test.ts`) but are distinguishable by a word unique to each
   * — "fallback"/"unset" only in A, "default"/"missing" only in B — so asserting on the published
   * body's own content, rather than on hand-counted string lengths, is what proves which one won.
   */
  describe("representative selection", () => {
    it("prefers the higher-severity variant even when its body is the shorter of the two", async () => {
      const longButLowSeverity =
        `${VARIANT_B} This additional sentence exists purely to make this candidate's sanitized ` +
        "body noticeably longer than the other one, so a length-only tie-break would wrongly " +
        "prefer it over the higher-severity candidate it is compared against.";
      const outcome = await publishFindings(
        context,
        [
          variant(longButLowSeverity, { severity: "low" }),
          variant(VARIANT_A, { severity: "critical" }),
        ],
        diagnostics,
      );
      expect(outcome.published).toBe(1);
      expect(api.created).toHaveLength(1);
      const body = api.created[0]?.body ?? "";
      expect(body).toContain("fallback");
      expect(body).not.toContain("default");
    });

    it("prefers the longer sanitized body when severities tie", async () => {
      const longerAtEqualSeverity =
        `${VARIANT_B} This additional sentence exists purely to make this candidate's sanitized ` +
        "body noticeably longer than the other, equally severe, candidate it is compared against.";
      const outcome = await publishFindings(
        context,
        [
          variant(VARIANT_A, { severity: "high" }),
          variant(longerAtEqualSeverity, { severity: "high" }),
        ],
        diagnostics,
      );
      expect(outcome.published).toBe(1);
      expect(api.created).toHaveLength(1);
      const body = api.created[0]?.body ?? "";
      expect(body).toContain("default");
      expect(body).not.toContain("fallback");
    });
  });

  /**
   * Keiko-for-Quality#2926's shape again, but with the cluster's own representative ALSO an
   * exact-marker duplicate of a conversation this reviewer already published. The two suppression
   * mechanisms are independent stages over independent findings within the same run (two members
   * suppressed intra-run, one representative separately suppressed at the exact-marker stage), so
   * their counts must land in their own buckets and the total must be their plain sum — never a
   * finding counted twice, and never one stage's suppression masking the other's.
   */
  it("still suppresses at the exact-marker stage after surviving intra-run clustering as the representative — separate buckets, no double count", async () => {
    const existingMarker = fingerprint({
      repository: "acme/widget",
      pullNumber: 7,
      path: "src/retry.ts",
      rule: "bug",
      body: VARIANT_A,
    });
    api.existing = [
      {
        id: 1,
        body: composeFindingBody(VARIANT_A, markerComment(existingMarker), {
          path: "src/retry.ts",
          line: 1,
          severity: "critical",
          category: "bug",
        }),
        path: "src/retry.ts",
        authorLogin: IDENTITY,
        commitId: HEAD,
        url: "https://example.test/existing",
      },
    ];

    const outcome = await publishFindings(
      context,
      [variant(VARIANT_A, { severity: "critical" }), variant(VARIANT_B), variant(VARIANT_C)],
      diagnostics,
    );

    expect(outcome).toMatchObject({
      published: 0,
      suppressed: 3,
      suppressedIntraRun: 2,
      suppressedExactDuplicate: 1,
      suppressedSimilar: 0,
      suppressedDispositioned: 0,
    });
    expect(api.created).toHaveLength(0);
  });
});

/**
 * `publishFindings` is now `planPublication` followed by `executePublication` (see `publisher.ts`),
 * a pure structural split made so a future caller can act on a survivor — the classification audit a
 * follow-up change adds — before any API call is made for it. These exercise the two phases directly
 * rather than only through `publishFindings`, which the suite above already covers end to end.
 */
describe("planPublication and executePublication", () => {
  /**
   * An existing IDENTITY-authored, unresolved comment whose marker is keyed on `rule` — lets a
   * test seed a marker for a category a finding has not been given yet, which is exactly what the
   * execute-time re-check below needs to exercise. Anchored FAR from `finding()`'s lines (beyond
   * `LINE_TOLERANCE`) so it can never match the similarity/dispositioned stages, which this
   * describe block does not exercise. It used to isolate itself by being file-level (no
   * `line`/`startLine`) instead — that stopped working on 2026-08-06, when the recurrence stage's
   * anchor-less clause made an open, own-authored, same-path, same-body FILE-level thread
   * suppress at plan time (correct product behaviour, but it would swallow the survivor this
   * block needs to reach the execute phase). Distance keeps every stage refusing it: the marker
   * stage never reads coordinates, the anchored stages fail the overlap check, and the
   * coordinate-free clauses only admit outdated or anchor-less threads.
   */
  function existingMarkedComment(rule: string, body: string): ReviewComment {
    const marker = fingerprint({
      repository: "acme/widget",
      pullNumber: 7,
      path: "src/retry.ts",
      rule,
      body,
    });
    return {
      id: 1,
      body: composeFindingBody(body, markerComment(marker), {
        path: "src/retry.ts",
        line: 1,
        severity: "medium",
        category: rule,
      }),
      path: "src/retry.ts",
      authorLogin: IDENTITY,
      commitId: HEAD,
      url: "https://example.test/existing",
      line: 500,
      startLine: 500,
    };
  }

  it("planPublication alone produces the same suppression counters and diagnostics as a full publishFindings run, with zero create/read API calls", async () => {
    // One finding suppressed as an exact duplicate, one rejected by sanitization — a mix that
    // exercises both plan-phase counters at once rather than only the all-zero case.
    const findings = [
      finding(),
      finding({
        path: repoPath("src/other.ts"),
        content: `${BODY} <script>x</script>`,
        startLine: 20,
        endLine: 22,
      }),
    ];

    const baselineApi = new FakeApi();
    baselineApi.existing = [existingMarkedComment("bug", BODY)];
    const baselineContext: PublishContext = { ...context, client: baselineApi };
    const baselineDiagnostics = createSilentDiagnostics();
    const baselineOutcome = await publishFindings(baselineContext, findings, baselineDiagnostics);

    api.existing = [existingMarkedComment("bug", BODY)];
    const planDiagnostics = createSilentDiagnostics();
    const plan = await planPublication(context, findings, planDiagnostics);

    expect(plan.survivors).toHaveLength(0);
    expect(plan.counters).toStrictEqual({
      suppressed: 1,
      suppressedIntraRun: 0,
      suppressedExactDuplicate: 1,
      suppressedSimilar: 0,
      suppressedDispositioned: 0,
      suppressedRecurrence: 0,
      rejectedSanitization: 1,
      neutralized: 0,
    });
    // The property the split depends on being behavior-identical: the plan phase alone reproduces
    // exactly the suppression/rejection half of what a full publishFindings run reports.
    expect(plan.counters).toStrictEqual({
      suppressed: baselineOutcome.suppressed,
      suppressedIntraRun: baselineOutcome.suppressedIntraRun ?? 0,
      suppressedExactDuplicate: baselineOutcome.suppressedExactDuplicate,
      suppressedSimilar: baselineOutcome.suppressedSimilar,
      suppressedDispositioned: baselineOutcome.suppressedDispositioned,
      suppressedRecurrence: baselineOutcome.suppressedRecurrence ?? 0,
      rejectedSanitization: baselineOutcome.rejectedSanitization,
      // Not on `PublishOutcome` — the neutralization count is a plan-phase measurement of what the
      // sanitizer SAVED, and the run-level outcome has no field for it.
      neutralized: 0,
    });
    expect(planDiagnostics.drain()).toStrictEqual(baselineDiagnostics.drain());

    expect(api.created).toHaveLength(0);
    expect(api.getCalls).toBe(0);
  });

  it("suppresses at the execute-time re-check when a survivor is reclassified to a category whose fingerprint matches an existing marker", async () => {
    // Seeded for "security" — the category the survivor below is reclassified to AFTER planning,
    // simulating the follow-up's classification audit running between plan and execute.
    api.existing = [existingMarkedComment("security", BODY)];

    const plan = await planPublication(context, [finding()], diagnostics);
    // The finding's own category at plan time is still "bug", which does not match the
    // security-keyed marker above, so it survives planning as an ordinary candidate.
    expect(plan.survivors).toHaveLength(1);
    expect(plan.counters).toMatchObject({ suppressed: 0, suppressedExactDuplicate: 0 });

    const survivor = plan.survivors[0]!;
    const reclassifiedPlan: PublicationPlan = {
      ...plan,
      survivors: [{ ...survivor, finding: { ...survivor.finding, category: "security" } }],
    };

    const outcome = await executePublication(context, reclassifiedPlan, diagnostics);
    // Suppressed before any placement was attempted — never posted as a duplicate under the new
    // category, and counted/diagnosed exactly like a plan-stage exact-marker suppression.
    expect(outcome).toMatchObject({ published: 0, suppressed: 1, suppressedExactDuplicate: 1 });
    expect(api.created).toHaveLength(0);
  });

  it("still publishes a survivor normally when the execute-time re-check finds no marker collision", async () => {
    const plan = await planPublication(context, [finding()], diagnostics);
    expect(plan.survivors).toHaveLength(1);

    const outcome = await executePublication(context, plan, diagnostics);
    expect(outcome).toMatchObject({ published: 1, suppressed: 0 });
    expect(api.created).toHaveLength(1);
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

  /**
   * A prefetch a caller already ran moments ago in the same settlement path (`publishFindings` did,
   * immediately before this, in production) must let this function skip its own list call entirely
   * — otherwise the two functions still pay for the same list-and-walk twice, the exact duplication
   * this parameter exists to remove. Absent, behaviour must stay byte-for-byte what every existing
   * caller above already exercises.
   */
  describe("prefetch parameter", () => {
    it("performs zero list calls when given a prefetched value", async () => {
      const prefetch = await prefetchExistingConversations(context);
      const callsBeforePrefetchedNotice = api.listCalls;

      const verified = await publishIncompleteNotice(
        context,
        REASON,
        ANCHOR,
        diagnostics,
        prefetch,
      );

      expect(api.listCalls).toBe(callsBeforePrefetchedNotice);
      expect(verified).toBe(true);
      expect(api.created).toHaveLength(1);
    });

    it("fetches its own conversations, exactly as before, when no prefetch is supplied", async () => {
      const verified = await publishIncompleteNotice(context, REASON, ANCHOR, diagnostics);

      expect(api.listCalls).toBe(1);
      expect(verified).toBe(true);
      expect(api.created).toHaveLength(1);
    });

    it("still suppresses a repost of the identical (anchor, reason, head) via a supplied prefetch", async () => {
      await publishIncompleteNotice(context, REASON, ANCHOR, diagnostics);
      const prefetch = await prefetchExistingConversations(context);
      const callsBeforePrefetchedNotice = api.listCalls;

      const verified = await publishIncompleteNotice(
        context,
        REASON,
        ANCHOR,
        diagnostics,
        prefetch,
      );

      expect(api.listCalls).toBe(callsBeforePrefetchedNotice);
      expect(verified).toBe(true);
      expect(api.created).toHaveLength(1);
    });
  });
});
