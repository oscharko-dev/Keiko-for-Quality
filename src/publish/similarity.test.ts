import { describe, expect, it } from "vitest";

import {
  findsSimilarOpenConversation,
  type ExistingConversation,
  type SimilarityCandidate,
} from "./similarity.js";

const IDENTITY = "keiko-for-quality[bot]";
const PATH = "src/connectors/codingContextRoutes.ts";

function candidate(overrides: Partial<SimilarityCandidate> = {}): SimilarityCandidate {
  return {
    path: PATH,
    startLine: 236,
    endLine: 236,
    body: "Restore the route's fallback connector construction when the primary endpoint is unset.",
    ...overrides,
  };
}

function thread(overrides: Partial<ExistingConversation> = {}): ExistingConversation {
  return {
    path: PATH,
    authorLogin: IDENTITY,
    resolved: false,
    body: "Restore the route's fallback connector construction when the primary endpoint is unset.",
    startLine: 236,
    endLine: 236,
    ...overrides,
  };
}

describe("findsSimilarOpenConversation", () => {
  it("returns false for an empty existing-thread list", () => {
    expect(findsSimilarOpenConversation(candidate(), [], IDENTITY)).toBe(false);
  });

  it("suppresses a real paraphrase of the same defect at the same location", () => {
    // The three real production paraphrases from Keiko-for-Quality#38 (oscharko-dev/Keiko#2926),
    // truncated in the issue but reconstructed here in full for a self-contained fixture.
    const paraphrases = [
      "Restore the route's fallback connector construction when the primary endpoint is unset.",
      "Restore the route's default connector construction when the primary endpoint is missing.",
      "Keep the fallback port construction for route requests when no primary endpoint exists.",
    ];
    for (const first of paraphrases) {
      for (const second of paraphrases) {
        const found = findsSimilarOpenConversation(
          candidate({ body: second }),
          [thread({ body: first })],
          IDENTITY,
        );
        expect(found).toBe(true);
      }
    }
  });

  it("does not suppress a genuinely different defect at the identical line", () => {
    const found = findsSimilarOpenConversation(
      candidate({
        body: "This handler never validates that the uploaded file size is below the configured limit.",
      }),
      [thread({ body: "Restore the route's fallback connector construction." })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress a genuinely different defect on an adjacent line", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 237, endLine: 237, body: "The retry loop never resets its counter." }),
      [thread({ body: "The response body is never closed on the error branch." })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("suppresses when the anchor drifted by up to the line tolerance", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 238, endLine: 238 }),
      [thread({ startLine: 236, endLine: 236 })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });

  it("does not suppress once the drift exceeds the line tolerance", () => {
    const found = findsSimilarOpenConversation(
      candidate({ startLine: 239, endLine: 239 }),
      [thread({ startLine: 236, endLine: 236 })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress a similar body on a different file", () => {
    const found = findsSimilarOpenConversation(
      candidate({ path: "src/other.ts" }),
      [thread({ path: PATH })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress a conversation authored by someone else", () => {
    const found = findsSimilarOpenConversation(
      candidate(),
      [thread({ authorLogin: "contributor" })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("does not suppress once the conversation is resolved", () => {
    const found = findsSimilarOpenConversation(candidate(), [thread({ resolved: true })], IDENTITY);
    expect(found).toBe(false);
  });

  it("does not suppress against a conversation with no usable line anchor", () => {
    const found = findsSimilarOpenConversation(
      candidate(),
      [thread({ startLine: undefined, endLine: undefined })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("suppresses on an identical quoted code snippet even when the prose framing is unrelated", () => {
    const snippet = "```ts\nconst port = fallback ?? DEFAULT_PORT;\n```";
    const found = findsSimilarOpenConversation(
      candidate({ body: `Something entirely different is wrong here.\n\n${snippet}` }),
      [thread({ body: `A completely unrelated sentence follows.\n\n${snippet}` })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });

  it("ignores incidental whitespace differences inside a quoted code snippet", () => {
    const found = findsSimilarOpenConversation(
      candidate({ body: "See below.\n\n```ts\nconst  port = fallback ?? DEFAULT_PORT;\n```" }),
      [thread({ body: "See below.\n\n```ts\nconst port =\nfallback ?? DEFAULT_PORT;\n```" })],
      IDENTITY,
    );
    expect(found).toBe(true);
  });

  it("does not let a short, generic body false-trigger on stopwords alone", () => {
    const found = findsSimilarOpenConversation(
      candidate({ body: "This is not correct for this case here." }),
      [thread({ body: "This is not correct for that case there." })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });

  it("survives a very long, hostile body without throwing or hanging", () => {
    const hostile = `${"A".repeat(200_000)} 建設 construction fallback connector`;
    expect(() =>
      findsSimilarOpenConversation(
        candidate({ body: hostile }),
        [thread({ body: hostile })],
        IDENTITY,
      ),
    ).not.toThrow();
  });

  it("survives unicode and markdown-heavy content without throwing", () => {
    const unicode =
      "# Überschrift 🔥\n\n- 一つ目の欠陥\n- **重要**: `restore` 함수가 실패합니다\n\n> quoted text\n\n```js\nconst x = 1;\n```";
    expect(() =>
      findsSimilarOpenConversation(
        candidate({ body: unicode }),
        [thread({ body: unicode })],
        IDENTITY,
      ),
    ).not.toThrow();
    // Two identical hostile bodies at the same location are the same finding by any reasonable
    // reading, and the shared-code-block path alone is enough to catch this pair.
    expect(
      findsSimilarOpenConversation(
        candidate({ body: unicode }),
        [thread({ body: unicode })],
        IDENTITY,
      ),
    ).toBe(true);
  });

  it("does not falsely suppress two different non-Latin bodies with no shared code", () => {
    const found = findsSimilarOpenConversation(
      candidate({ body: "これは最初の欠陥に関する説明です。" }),
      [thread({ body: "これは二番目の全く異なる欠陥に関する説明です。" })],
      IDENTITY,
    );
    expect(found).toBe(false);
  });
});
