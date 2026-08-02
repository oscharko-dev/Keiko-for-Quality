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
      ["protocol-relative, indented", `${VALID}\n//sub-domain.example.test/x`],
      ["bare www", `${VALID} www.example.test`],
      ["custom scheme", `${VALID} data://payload`],
    ])("rejects %s", (_name, body) => {
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "link" });
    });

    /**
     * The rule file invites a short fenced code block showing the line at issue, and in this
     * language that block routinely contains a `//` comment. The `m` flag makes `^` match every
     * line start, so a bare `^//` alternative rejected the whole finding — a correct review lost,
     * and the run settled incomplete, because of a pattern meant to catch a URL.
     */
    it.each([
      ["a line comment", `${VALID}\n// no close on this path`],
      ["a comment inside a fence", `${VALID}\n\n\`\`\`js\n// ignore\nreturn x;\n\`\`\``],
      ["a divider of slashes", `${VALID}\n//////////`],
    ])("accepts %s, which is not a link", (_name, body) => {
      expect(sanitizeFindingBody(body).ok).toBe(true);
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

describe("code-region masking (the corpus-blocking html false positive)", () => {
  // Its own paragraph, so a case ending in a fence keeps that fence alone on its line.
  const PAD = "\n\nPadding so the body clears the minimum length check.";

  it.each([
    ["inline code containing generics", "Indexing a plain `Record<string, string>` resolves it."],
    ["markup inside a backtick fence", "It renders:\n\n```html\n<script>alert(1)</script>\n```"],
    ["an indented fence (three spaces are allowed)", "Shown as:\n\n   ```\n   <b>bold</b>\n   ```"],
    ["a tilde fence", "The template emits:\n\n~~~html\n<script>x()</script>\n~~~"],
    ["a double-backtick span holding a single backtick", "Escape it as `` `<td>` `` there."],
    ["an image inside inline code", "The diff adds `![alt](url)` handling."],
  ])("accepts %s", (_name, body) => {
    expect(sanitizeFindingBody(body + PAD).ok).toBe(true);
  });

  it.each([
    ["a bare tag outside any code region", "This body smuggles <b>markup</b> in the open.", "html"],
    ["an inline span that never closes", "Unbalanced `tick then <b>markup</b> after it.", "html"],
    ["a tilde fence that never closes", "~~~\n<b>markup</b> after an unclosed fence.", "html"],
    ["a closing fence shorter than its opening", "Broken:\n\n`````\n<b>markup</b>\n```", "html"],
    ["an image outside any code region", "Look: ![beacon](x)", "image"],
    ["a credential inside a fenced block", "```\nghp_abcdefghijklmnop1234\n```", "credential"],
    ["a suggestion fence", "```suggestion\nfixed()\n```", "suggestion_block"],
  ])("still rejects %s", (_name, body, reason) => {
    expect(sanitizeFindingBody(body + PAD)).toEqual({ ok: false, reason });
  });

  /**
   * A regression pin, not a benchmark. The first masking implementation paired inline spans with
   * `(?:[^`\n]|`+)+?`, which lets one backtick run decompose many ways and backtracks
   * exponentially — reachable denial of service, since every body here is model output produced
   * while reading attacker-influenced material. The bound is deliberately loose: the linear
   * implementation returns in single-digit milliseconds, so a second is only ever crossed by a
   * return to a backtracking construct.
   */
  it("does not backtrack catastrophically on a body of backticks", () => {
    const hostile = "`".repeat(2000) + "<b>x</b>" + "`".repeat(2000);
    const started = performance.now();
    sanitizeFindingBody(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
