import { describe, expect, it } from "vitest";

import { sanitizeFindingBody } from "./sanitize.js";

const VALID = "This call can throw when the buffer is empty, which leaves the lock held.";

const ch = (code: number): string => String.fromCodePoint(code);

describe("sanitizeFindingBody", () => {
  it("accepts an ordinary finding body", () => {
    const result = sanitizeFindingBody(VALID);
    expect(result).toEqual({ ok: true, body: VALID });
  });

  it("normalizes line endings and collapses blank-line runs without changing meaning", () => {
    const result = sanitizeFindingBody(`${VALID}\r\n\r\n\r\n\r\nSecond paragraph.`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe(`${VALID}\n\nSecond paragraph.`);
  });

  describe("rendering-deception carriers", () => {
    // Each of these can make a rendered comment say something different from what it stores.
    it.each([
      ["right-to-left override", 0x202e, "bidirectional_override"],
      ["left-to-right embedding", 0x202a, "bidirectional_override"],
      ["first strong isolate", 0x2068, "bidirectional_override"],
      ["pop directional isolate", 0x2069, "bidirectional_override"],
      ["zero-width space", 0x200b, "zero_width"],
      ["zero-width joiner", 0x200d, "zero_width"],
      ["word joiner", 0x2060, "zero_width"],
      ["byte order mark", 0xfeff, "zero_width"],
    ])("rejects %s", (_name, code, reason) => {
      const result = sanitizeFindingBody(`${VALID}${ch(code)}hidden`);
      expect(result).toEqual({ ok: false, reason });
    });

    it("rejects C0 control characters but keeps newline and tab usable", () => {
      expect(sanitizeFindingBody(`${VALID}${ch(0x07)}`)).toEqual({
        ok: false,
        reason: "control_characters",
      });
      expect(sanitizeFindingBody(`${VALID}\n\tindented`).ok).toBe(true);
    });
  });

  describe("active content", () => {
    it("rejects a suggestion block, which would be one-click applicable code", () => {
      const body = `${VALID}\n\n\`\`\`suggestion\nrm -rf /\n\`\`\``;
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "suggestion_block" });
    });

    it("rejects a suggestion block regardless of case or fence length", () => {
      const body = `${VALID}\n\n\`\`\`\`  SUGGESTION\ncode\n\`\`\`\``;
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "suggestion_block" });
    });

    it.each([
      ["script tag", `${VALID} <script>alert(1)</script>`],
      ["img tag", `${VALID} <img src=x>`],
      ["comment", `${VALID} <!-- injected -->`],
    ])("rejects %s", (_name, body) => {
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "html" });
    });

    it("rejects markdown images, which auto-load and can beacon", () => {
      expect(sanitizeFindingBody(`${VALID} ![x](https://example.test/x.png)`)).toEqual({
        ok: false,
        reason: "image",
      });
    });

    it.each([
      ["https url", `${VALID} see https://example.test/docs`],
      ["protocol-relative", `${VALID}\n//example.test/x`],
      ["bare www", `${VALID} www.example.test`],
      ["custom scheme", `${VALID} data://payload`],
    ])("rejects %s", (_name, body) => {
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "link" });
    });

    it("rejects an @mention, which would notify a real person on the model's behalf", () => {
      expect(sanitizeFindingBody(`${VALID} cc @octocat`)).toEqual({ ok: false, reason: "mention" });
    });

    it("does not treat an email-like token inside code as a mention", () => {
      expect(sanitizeFindingBody(`${VALID} the value \`user@host\` is unvalidated`).ok).toBe(true);
    });
  });

  describe("credential shapes", () => {
    it.each([
      ["classic PAT", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["fine-grained PAT", "github_pat_11ABCDEFG0abcdefghijklmnop"],
      ["provider key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
      ["AWS access key", "AKIAIOSFODNN7EXAMPLE"],
      ["private key header", "-----BEGIN RSA PRIVATE KEY-----"],
    ])("rejects a body echoing a %s", (_name, secret) => {
      expect(sanitizeFindingBody(`${VALID} ${secret}`)).toEqual({
        ok: false,
        reason: "credential",
      });
    });
  });

  describe("bounds", () => {
    it("rejects an empty or near-empty body", () => {
      expect(sanitizeFindingBody("   ")).toEqual({ ok: false, reason: "empty" });
      expect(sanitizeFindingBody("too short")).toEqual({ ok: false, reason: "empty" });
    });

    it("rejects a body large enough to flood a pull request", () => {
      expect(sanitizeFindingBody("a".repeat(8001))).toEqual({ ok: false, reason: "too_long" });
    });
  });
});
