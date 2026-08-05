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

    /**
     * A bare `scheme://` or `www.` URL used to be an unconditional rejection here. It is now
     * neutralized instead — see the "neutralization" describe block below — for every shape
     * except this protocol-relative one: out of scope on purpose (`LINK_NEUTRALIZE`'s own
     * comment), so it still rejects.
     */
    it.each([
      ["protocol-relative", `${VALID}\n//example.test/x`],
      ["protocol-relative, indented", `${VALID}\n//sub-domain.example.test/x`],
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

    // An @mention outside code used to be an unconditional rejection here too. It is now
    // neutralized instead — see the "neutralization" describe block below.

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

  /**
   * A body that is nothing but echoed diff lines is the model writing the hunk back instead of
   * reviewing it. Two of the 127 findings published on the consumer's Keiko#2970 were exactly this
   * shape, and both cleared every other check in this file. The fixtures below reproduce their
   * STRUCTURE (marker, two-space code indentation, one statement), never the consumer's code.
   */
  describe("diff echoes (the model writing the hunk back)", () => {
    it("rejects a single echoed removal line — the first real production shape", () => {
      expect(sanitizeFindingBody("-  const total = sumOfParts(stageRoot);")).toEqual({
        ok: false,
        reason: "diff_echo",
      });
    });

    it("rejects a single echoed addition line — the second real production shape", () => {
      expect(
        sanitizeFindingBody('+  const total = sumOfParts(joinPath(stageRoot, "payload"));'),
      ).toEqual({ ok: false, reason: "diff_echo" });
    });

    it("rejects a multi-line body when every line is an echoed diff line", () => {
      const body = [
        "-  const value = readSetting(name);",
        "+  const value = readSetting(name, fallback);",
      ].join("\n");
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "diff_echo" });
    });

    // The false-positive risk this check is written around: a Markdown bullet is `- ` — marker,
    // ONE space — while a diff line carrying indented code is marker plus the code's own leading
    // whitespace. A prose bullet list must stay publishable.
    it("never rejects a Markdown bullet list, which uses one space after the marker", () => {
      const body = [
        "- Restore the range check before dispatching the request.",
        "- Reject the request when the header is absent.",
      ].join("\n");
      expect(sanitizeFindingBody(body)).toEqual({ ok: true, body });
    });

    // Even a bullet list whose lines mention code (parentheses) is prose, not an echo — the
    // two-space requirement is what keeps it out, and this pins that boundary exactly.
    it("never rejects a bullet list that references code in every line", () => {
      const body = [
        "- Call validate() before dispatch.",
        "- Drop the fallback = null branch entirely.",
      ].join("\n");
      expect(sanitizeFindingBody(body)).toEqual({ ok: true, body });
    });

    it("never rejects a real finding that quotes a diff line inside prose", () => {
      const body = [
        "The staged inventory reads from the wrong directory after the rename.",
        "",
        "-  const actual = inventoryFiles(stageRoot);",
        "",
        "The replacement scans the payload root instead, so signing misses nothing.",
      ].join("\n");
      const result = sanitizeFindingBody(body);
      expect(result.ok).toBe(true);
    });

    // Column-zero code escapes the check BY DESIGN: the gate prefers missing an echo to ever
    // eating a real finding, and this pins that deliberate bound so a future "improvement" that
    // widens the pattern has to reckon with the bullet-list risk documented in sanitize.ts.
    it("does not reject column-zero code lines — the deliberate precision bound", () => {
      const body = "+const total = sumOfParts(stageRoot);";
      const result = sanitizeFindingBody(body);
      expect(result.ok).toBe(true);
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

describe("neutralization (turning a reversible formatting slip into inline code)", () => {
  describe("rewrites and publishes what is provably reversible", () => {
    it.each([
      ["a JSDoc-style mention", `${VALID} Document the @param tag.`, "@param"],
      ["a mention that looks like a real username", `${VALID} cc @octocat`, "@octocat"],
      ["a scoped-package mention", `${VALID} bump the @types/node version`, "@types/node"],
      ["a bare https URL", `${VALID} see https://example.test/docs`, "https://example.test/docs"],
      ["a bare www host", `${VALID} check www.example.test`, "www.example.test"],
      ["a non-http scheme", `${VALID} points at data://payload`, "data://payload"],
      [
        "an unbackticked generic",
        `${VALID} Indexing a plain Record<string, string> resolves it.`,
        "Record<string, string>",
      ],
    ])("neutralizes %s instead of discarding the finding", (_name, body, token) => {
      const result = sanitizeFindingBody(body);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body).toBe(body.replace(token, `\`${token}\``));
      expect(result.neutralized).toBe(1);
    });

    it("stops a neutralized URL before trailing sentence punctuation, not inside it", () => {
      const body = `${VALID} See https://example.test/docs, for details.`;
      expect(sanitizeFindingBody(body)).toEqual({
        ok: true,
        body: `${VALID} See \`https://example.test/docs\`, for details.`,
        neutralized: 1,
      });
    });

    it("wraps a nested generic as a single span, not two overlapping ones", () => {
      const body = `${VALID} Accepts a Map<string, Array<number>> today.`;
      expect(sanitizeFindingBody(body)).toEqual({
        ok: true,
        body: `${VALID} Accepts a \`Map<string, Array<number>>\` today.`,
        neutralized: 1,
      });
    });

    it("neutralizes more than one span in the same body, in one pass", () => {
      const body = `${VALID} cc @octocat, see https://example.test/docs.`;
      const result = sanitizeFindingBody(body);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body).toBe(`${VALID} cc \`@octocat\`, see \`https://example.test/docs\`.`);
        expect(result.neutralized).toBe(2);
      }
    });

    it("leaves `@` alone when not followed by a letter or digit — never a mention shape at all", () => {
      const body = `${VALID} an array literal like @-verbatim is not a mention.`;
      expect(sanitizeFindingBody(body)).toEqual({ ok: true, body });
    });
  });

  describe("still rejects what is not provably reversible", () => {
    it("does not neutralize a Markdown link's destination — the syntax itself must stay rejected", () => {
      const body = `${VALID} Documented at [the guide](https://example.test/docs).`;
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "link" });
    });

    it("does not neutralize a Markdown image's destination", () => {
      const body = `${VALID} See ![diagram](https://example.test/diagram.png) below.`;
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "image" });
    });

    it("still rejects a bare HTML tag — no identifier precedes it to read as a generic", () => {
      const body = `${VALID} This renders <div>content</div> inline.`;
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "html" });
    });

    it("still rejects a credential, evaluated before neutralization ever runs", () => {
      const body = `${VALID} cc @octocat ghp_abcdefghijklmnopqrstuvwxyz0123456789`;
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "credential" });
    });

    it("still rejects a suggestion fence, unaffected by neutralization", () => {
      const body = `${VALID}\n\n\`\`\`suggestion\nfixed()\n\`\`\``;
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "suggestion_block" });
    });

    it("still rejects a zero-width carrier, unaffected by neutralization", () => {
      expect(sanitizeFindingBody(`${VALID}${ch(0x200b)}hidden`)).toEqual({
        ok: false,
        reason: "zero_width",
      });
    });

    /**
     * Masking cannot tell code from prose once a fence never closes (see `maskFencedBlocks`), so
     * neutralization must not run at all there — not just skip the unclosed region, the whole
     * body. Pinned for both an inner `<` and an inner `@`, since the gate is meant to be uniform
     * across every neutralization category, not special-cased per check.
     */
    it("skips neutralization entirely inside an unclosed fence, so an inner generic still rejects", () => {
      const body = `${VALID}\n\n\`\`\`\nIndexing a plain Record<string, string> resolves it.`;
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "html" });
    });

    it("skips neutralization entirely inside an unclosed fence, so an inner mention still rejects", () => {
      const body = `${VALID}\n\n\`\`\`\ncc @octocat, see the diff.`;
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "mention" });
    });
  });

  describe("never rewrites what is already inside a code span", () => {
    it("leaves an @mention inside backticks untouched, with nothing neutralized", () => {
      const body = `${VALID} the tag \`@param\` is documented above.`;
      expect(sanitizeFindingBody(body)).toEqual({ ok: true, body });
    });

    it("leaves a generic already inside backticks untouched, with nothing neutralized", () => {
      const body = "Indexing a plain `Record<string, string>` resolves it.";
      expect(sanitizeFindingBody(body)).toEqual({ ok: true, body });
    });

    it("leaves a URL already inside a fenced block untouched, with nothing neutralized", () => {
      const body = "Configured via:\n\n```\nhttps://example.test/docs\n```";
      expect(sanitizeFindingBody(body)).toEqual({ ok: true, body });
    });
  });

  it("rewrites nothing on a second pass over an already-neutralized body", () => {
    const first = sanitizeFindingBody(`${VALID} cc @octocat, see https://example.test/docs.`);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.neutralized).toBe(2);
    const second = sanitizeFindingBody(first.body);
    expect(second).toEqual({ ok: true, body: first.body });
  });

  describe("bounds, checked after neutralization", () => {
    // A backtick pair adds two characters, so a body that only clears 8000 once its own rewrite
    // is undone must still be rejected — honesty about size outranks the convenience of a rewrite
    // that only fits by construction.
    it("rejects a body that only exceeds 8000 characters because neutralization added backticks", () => {
      const body = `${"x".repeat(7996)} @a`;
      expect(body).toHaveLength(7999);
      expect(sanitizeFindingBody(body)).toEqual({ ok: false, reason: "too_long" });
    });

    it("still neutralizes the identical shape comfortably under the bound", () => {
      const body = `${"x".repeat(100)} @a`;
      const result = sanitizeFindingBody(body);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.neutralized).toBe(1);
    });

    /**
     * The bound is ALSO checked before neutralization, and this is what that buys. A long run of
     * identifier characters is the worst case for `LINK_NEUTRALIZE` and `GENERIC_HEAD`, which are
     * quadratic in scan restarts (their doc comments record why every reformulation that removes
     * the restart also changes what they match). Every other pattern in the module runs against
     * input an earlier check has already bounded; without the early return these two ran at
     * whatever length the engine emitted, and this body would take minutes rather than the
     * milliseconds the reject-first path costs.
     *
     * The ceiling is a regression pin, not a benchmark — bounded work, not a millisecond figure —
     * and the assertion above it is the one that matters: the verdict is unchanged, because
     * neutralization only ever adds characters, so nothing over the bound can come back under it.
     */
    it("rejects an over-long body without letting the neutralization scan see it", () => {
      const hostile = "a".repeat(100_000);
      const started = performance.now();
      expect(sanitizeFindingBody(hostile)).toEqual({ ok: false, reason: "too_long" });
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  /**
   * Every candidate here is `identifier<`, immediately followed by another identifier character —
   * a shape `genericSpans` must consider and then reject as unbalanced, over and over, on a body
   * built entirely out of that shape. A regression pin, not a benchmark: bounded (polynomial, not
   * exponential) work on adversarial input is the property, not a specific millisecond figure.
   */
  it("does not blow up scanning many unbalanced identifier-then-`<` candidates", () => {
    const hostile = `${VALID} ${"a<".repeat(2000)}`;
    const started = performance.now();
    sanitizeFindingBody(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
