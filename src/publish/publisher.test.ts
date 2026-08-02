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
import { publishFindings, type PublishContext } from "./publisher.js";

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
    const key = input.line === undefined ? "file" : (input.side ?? "RIGHT");
    const status = this.rejectWith.get(key);
    if (status !== undefined) return Promise.reject(new GitHubApiError(status));
    this.created.push(input);
    const comment: ReviewComment = {
      id: (this.nextId += 1),
      body: input.body,
      path: input.path,
      authorLogin: IDENTITY,
      commitId: HEAD,
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
      expect(outcome).toMatchObject({ published: 0, suppressed: 1 });
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
