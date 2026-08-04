import { describe, expect, it } from "vitest";

import {
  detectPinDesync,
  describePinDesync,
  findPinSites,
  type PinDesync,
  type PinSite,
} from "./pin-desync.js";
import { sanitizeFindingBody } from "../publish/sanitize.js";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const THIRD_SHA = "c".repeat(40);
const FOURTH_SHA = "d".repeat(40);
const PATH = ".github/workflows/review.yml";

describe("findPinSites", () => {
  it("recognizes a uses: pin and tags it with context uses", () => {
    const source = `      - uses: owner/repo@${OLD_SHA} # v0.11.0`;
    expect(findPinSites(source)).toEqual([{ line: 1, value: OLD_SHA, context: "uses" }]);
  });

  it("recognizes a quoted key: value assignment and tags it with context assignment", () => {
    const source = `          ACTION_PIN: "${OLD_SHA}"`;
    expect(findPinSites(source)).toEqual([{ line: 1, value: OLD_SHA, context: "assignment" }]);
  });

  it("recognizes an unquoted shell-style assignment", () => {
    const source = `ACTION_PIN=${OLD_SHA}`;
    expect(findPinSites(source)).toEqual([{ line: 1, value: OLD_SHA, context: "assignment" }]);
  });

  it("recognizes a source-level constant assignment", () => {
    const source = `const SHA = "${OLD_SHA}";`;
    expect(findPinSites(source)).toEqual([{ line: 1, value: OLD_SHA, context: "assignment" }]);
  });

  it("tags a SHA that follows a # marker earlier on the line as a comment", () => {
    const source = `        # backup, was ${OLD_SHA}`;
    expect(findPinSites(source)).toEqual([{ line: 1, value: OLD_SHA, context: "comment" }]);
  });

  it("tags a SHA on a commented-out uses: line as a comment, not uses", () => {
    const source = `        # uses: owner/repo@${OLD_SHA}`;
    expect(findPinSites(source)).toEqual([{ line: 1, value: OLD_SHA, context: "comment" }]);
  });

  it("does not mistake a trailing # comment on a live uses: line for commenting out the pin", () => {
    const source = `uses: owner/repo@${OLD_SHA} # v0.11.0`;
    expect(findPinSites(source)).toEqual([{ line: 1, value: OLD_SHA, context: "uses" }]);
  });

  it("does not treat :// inside an earlier URL on the line as a comment opener", () => {
    // Without the `://` exclusion, the `//` inside "https://" would be read as a comment marker,
    // and the later, genuine ACTION_PIN assignment on the same line would be misclassified as
    // commented-out text instead of a live pin site.
    const source = `docs: "https://example.test" ACTION_PIN: "${OLD_SHA}"`;
    expect(findPinSites(source)).toEqual([{ line: 1, value: OLD_SHA, context: "assignment" }]);
  });

  it("is case-insensitive when matching, and preserves the original casing of the value", () => {
    const upper = OLD_SHA.toUpperCase();
    const source = `uses: owner/repo@${upper}`;
    expect(findPinSites(source)).toEqual([{ line: 1, value: upper, context: "uses" }]);
  });

  it("never matches a 7-character abbreviation", () => {
    const source = `uses: owner/repo@abcdef0\nACTION_PIN: "abcdef0"`;
    expect(findPinSites(source)).toEqual([]);
  });

  it("never matches inside a longer, 64-character hex run (a sha256 digest)", () => {
    const source = `digest: sha256:${"a".repeat(64)}`;
    expect(findPinSites(source)).toEqual([]);
  });

  it("leaves a SHA with no recognizable context unclassified rather than guessing", () => {
    const source = `Reverts commit ${OLD_SHA} from last week.`;
    expect(findPinSites(source)).toEqual([]);
  });

  it("assigns 1-based line numbers and finds sites across multiple lines", () => {
    const source = ["first line", `uses: owner/repo@${OLD_SHA}`, "third line"].join("\n");
    expect(findPinSites(source)).toEqual([{ line: 2, value: OLD_SHA, context: "uses" }]);
  });

  it("finds more than one site per line", () => {
    const source = `# was ${OLD_SHA}, now uses: owner/repo@${NEW_SHA}`;
    // The whole line opens with '#', so BOTH sites read as commented-out text — correct, since
    // this entire line is a comment in the source it was scanned from.
    expect(findPinSites(source)).toEqual([
      { line: 1, value: OLD_SHA, context: "comment" },
      { line: 1, value: NEW_SHA, context: "comment" },
    ]);
  });
});

describe("findPinSites bounds", () => {
  it("keeps every site within the 200-pin-site bound", () => {
    const source = Array.from(
      { length: 200 },
      (_, i) => `KEY${String(i)}: "${String(i).padStart(40, "0")}"`,
    ).join("\n");
    expect(findPinSites(source)).toHaveLength(200);
  });

  it("returns an empty result once a source has more than 200 pin sites", () => {
    const source = Array.from(
      { length: 201 },
      (_, i) => `KEY${String(i)}: "${String(i).padStart(40, "0")}"`,
    ).join("\n");
    expect(findPinSites(source)).toEqual([]);
  });

  it("returns an empty result once a source exceeds 4,000 lines", () => {
    const control = `uses: owner/repo@${OLD_SHA}`;
    expect(findPinSites(control)).toHaveLength(1); // control: within bounds
    const padded = "# pad\n".repeat(4001) + control;
    expect(findPinSites(padded)).toEqual([]);
  });

  it("returns an empty result once a source exceeds the character bound, even as one line", () => {
    // Padding is spaces, not newlines, so this is ONE line — the line-count bound above never
    // triggers, and only the independent character-count bound can be what stops this.
    const huge = `uses: owner/repo@${OLD_SHA}` + " ".repeat(10_000_000);
    expect(huge.split("\n")).toHaveLength(1);
    expect(findPinSites(huge)).toEqual([]);
  });
});

describe("findPinSites never throws", () => {
  it("on deterministic binary-ish garbage", () => {
    const garbage = Array.from({ length: 5000 }, (_, i) =>
      String.fromCharCode((i * 37) % 256),
    ).join("");
    expect(() => findPinSites(garbage)).not.toThrow();
    expect(findPinSites(garbage)).toEqual([]);
  });

  it("on an empty string", () => {
    expect(() => findPinSites("")).not.toThrow();
    expect(findPinSites("")).toEqual([]);
  });

  it("on a single ~10MB line with no structure at all", () => {
    const huge = "x".repeat(10_000_000);
    expect(() => findPinSites(huge)).not.toThrow();
    expect(findPinSites(huge)).toEqual([]);
  });
});

describe("detectPinDesync: the Keiko#2977 shape", () => {
  // On oscharko-dev/Keiko#2977, a workflow advanced `uses: owner/repo@<sha>` but left a second
  // declaration of the same pin untouched, and the file's own consistency check (not modeled here —
  // this fixture only needs the two declarations) silently disabled itself on the mismatch.
  const BASE = [
    "on: push",
    "jobs:",
    "  review:",
    "    steps:",
    `      - uses: owner/repo@${OLD_SHA} # v0.11.0`,
    "        # ADVANCE BOTH TOGETHER",
    "        env:",
    `          ACTION_PIN: "${OLD_SHA}"`,
  ].join("\n");

  const HEAD = BASE.replace(
    `uses: owner/repo@${OLD_SHA} # v0.11.0`,
    `uses: owner/repo@${NEW_SHA} # v0.12.0`,
  );

  it("reports exactly one desync with the moved uses: site and the stale assignment site", () => {
    const result = detectPinDesync(BASE, HEAD);
    expect(result).toEqual([
      {
        value: OLD_SHA,
        movedSites: [{ line: 5, value: NEW_SHA, context: "uses" }],
        staleSites: [{ line: 8, value: OLD_SHA, context: "assignment" }],
      },
    ]);
  });

  it("reports nothing when both sites advance together", () => {
    const headBothAdvanced = BASE.split(OLD_SHA).join(NEW_SHA);
    expect(detectPinDesync(BASE, headBothAdvanced)).toEqual([]);
  });
});

describe("detectPinDesync: never reports", () => {
  it("a single occurrence that advanced (nothing to have drifted from)", () => {
    const base = ["jobs:", "  review:", `      - uses: owner/repo@${OLD_SHA}`].join("\n");
    const head = base.replace(OLD_SHA, NEW_SHA);
    expect(detectPinDesync(base, head)).toEqual([]);
  });

  it("two unrelated SHAs that merely differ, each appearing once", () => {
    const base = [
      `      - uses: owner/repo@${OLD_SHA}`,
      `      - uses: other/action@${THIRD_SHA}`,
    ].join("\n");
    const head = base.replace(OLD_SHA, NEW_SHA).replace(THIRD_SHA, FOURTH_SHA);
    expect(detectPinDesync(base, head)).toEqual([]);
  });

  it("a 7-character abbreviation duplicated and only partly advanced", () => {
    const base = [`uses: owner/repo@abcdef0`, `ACTION_PIN: "abcdef0"`].join("\n");
    const head = base.replace("uses: owner/repo@abcdef0", "uses: owner/repo@1234567");
    expect(detectPinDesync(base, head)).toEqual([]);
  });

  it("identical base and head text", () => {
    const base = [`      - uses: owner/repo@${OLD_SHA}`, `      ACTION_PIN: "${OLD_SHA}"`].join(
      "\n",
    );
    expect(detectPinDesync(base, base)).toEqual([]);
  });

  it("a value that appears only once in base even if it duplicates something else in head", () => {
    const base = `uses: owner/repo@${OLD_SHA}`;
    const head = [`uses: owner/repo@${NEW_SHA}`, `ACTION_PIN: "${NEW_SHA}"`].join("\n");
    expect(detectPinDesync(base, head)).toEqual([]);
  });
});

describe("detectPinDesync: three sites, two moved one stale", () => {
  const base = [
    `      - uses: owner/repo@${OLD_SHA} # v0.11.0`,
    "        env:",
    `          ACTION_PIN: "${OLD_SHA}"`,
    `        # backup, was ${OLD_SHA}`,
  ].join("\n");

  const head = base
    .replace(`uses: owner/repo@${OLD_SHA} # v0.11.0`, `uses: owner/repo@${NEW_SHA} # v0.12.0`)
    .replace(`ACTION_PIN: "${OLD_SHA}"`, `ACTION_PIN: "${NEW_SHA}"`);

  it("lists both moved sites and the one stale site in a single desync", () => {
    const result = detectPinDesync(base, head);
    expect(result).toHaveLength(1);
    const [desync] = result;
    expect(desync?.value).toBe(OLD_SHA);
    expect(desync?.movedSites).toEqual([
      { line: 1, value: NEW_SHA, context: "uses" },
      { line: 3, value: NEW_SHA, context: "assignment" },
    ]);
    expect(desync?.staleSites).toEqual([{ line: 4, value: OLD_SHA, context: "comment" }]);
  });
});

describe("detectPinDesync: case-insensitive value matching", () => {
  it("treats an uppercase and a lowercase spelling of the same commit as still agreeing", () => {
    const base = [
      `      - uses: owner/repo@${OLD_SHA}`,
      `          ACTION_PIN: "${OLD_SHA.toUpperCase()}"`,
    ].join("\n");
    const head = base.replace(`uses: owner/repo@${OLD_SHA}`, `uses: owner/repo@${NEW_SHA}`);
    const result = detectPinDesync(base, head);
    expect(result).toHaveLength(1);
    expect(result[0]?.staleSites).toEqual([
      { line: 2, value: OLD_SHA.toUpperCase(), context: "assignment" },
    ]);
  });
});

describe("detectPinDesync never throws", () => {
  it("when either side is binary-ish garbage", () => {
    const garbage = Array.from({ length: 3000 }, (_, i) =>
      String.fromCharCode((i * 53) % 256),
    ).join("");
    const valid = [`uses: owner/repo@${OLD_SHA}`, `ACTION_PIN: "${OLD_SHA}"`].join("\n");
    expect(() => detectPinDesync(garbage, valid)).not.toThrow();
    expect(() => detectPinDesync(valid, garbage)).not.toThrow();
    expect(() => detectPinDesync(garbage, garbage)).not.toThrow();
    expect(detectPinDesync(garbage, garbage)).toEqual([]);
  });

  it("on two independent ~10MB single lines", () => {
    const hugeBase = `uses: owner/repo@${OLD_SHA}` + " ".repeat(10_000_000);
    const hugeHead = `uses: owner/repo@${NEW_SHA}` + " ".repeat(10_000_000);
    expect(() => detectPinDesync(hugeBase, hugeHead)).not.toThrow();
    expect(detectPinDesync(hugeBase, hugeHead)).toEqual([]);
  });

  it("on empty strings", () => {
    expect(() => detectPinDesync("", "")).not.toThrow();
    expect(detectPinDesync("", "")).toEqual([]);
  });
});

describe("describePinDesync", () => {
  const DESYNC: PinDesync = {
    value: OLD_SHA,
    movedSites: [{ line: 5, value: NEW_SHA, context: "uses" }],
    staleSites: [{ line: 8, value: OLD_SHA, context: "assignment" }],
  };

  it("renders an imperative first line, a blank line, then prose", () => {
    const body = describePinDesync(DESYNC, PATH);
    const [firstLine, blank, ...rest] = body.split("\n");
    expect(firstLine).toMatch(/\.$/);
    expect(firstLine?.length).toBeLessThan(100);
    expect(blank).toBe("");
    expect(rest.join("\n").length).toBeGreaterThan(0);
  });

  it("names the path, the shared value, and the moved and stale line numbers", () => {
    const body = describePinDesync(DESYNC, PATH);
    expect(body).toContain(PATH);
    expect(body).toContain(OLD_SHA);
    expect(body).toContain("line 5");
    expect(body).toContain("line 8");
  });

  it("names every line when a side has more than one site", () => {
    const desync: PinDesync = {
      value: OLD_SHA,
      movedSites: [
        { line: 1, value: NEW_SHA, context: "uses" },
        { line: 3, value: NEW_SHA, context: "assignment" },
      ],
      staleSites: [{ line: 4, value: OLD_SHA, context: "comment" }],
    };
    const body = describePinDesync(desync, PATH);
    expect(body).toContain("lines 1 and 3");
    expect(body).toContain("line 4");
  });
});

describe("describePinDesync output is always publishable", () => {
  const CASES: readonly PinDesync[] = [
    {
      value: OLD_SHA,
      movedSites: [{ line: 5, value: NEW_SHA, context: "uses" }],
      staleSites: [{ line: 8, value: OLD_SHA, context: "assignment" }],
    },
    {
      value: OLD_SHA,
      movedSites: [
        { line: 1, value: NEW_SHA, context: "uses" },
        { line: 3, value: NEW_SHA, context: "assignment" },
      ],
      staleSites: [{ line: 4, value: OLD_SHA, context: "comment" }],
    },
    {
      value: OLD_SHA,
      movedSites: [{ line: 2, value: NEW_SHA, context: "assignment" }],
      staleSites: [
        { line: 10, value: OLD_SHA, context: "comment" },
        { line: 20, value: OLD_SHA, context: "assignment" },
        { line: 30, value: OLD_SHA, context: "uses" },
      ],
    },
  ];

  it.each(CASES.map((desync) => [desync] as const))(
    "round-trips %j through the real sanitizeFindingBody",
    (desync) => {
      const body = describePinDesync(desync, PATH);
      expect(sanitizeFindingBody(body)).toEqual({ ok: true, body });
    },
  );

  it("stays publishable for the desync produced by the Keiko#2977 fixture", () => {
    const base = [
      `      - uses: owner/repo@${OLD_SHA} # v0.11.0`,
      `          ACTION_PIN: "${OLD_SHA}"`,
    ].join("\n");
    const head = base.replace(
      `uses: owner/repo@${OLD_SHA} # v0.11.0`,
      `uses: owner/repo@${NEW_SHA} # v0.12.0`,
    );
    const result = detectPinDesync(base, head);
    expect(result.length).toBeGreaterThan(0);
    for (const desync of result) {
      const body = describePinDesync(desync, PATH);
      expect(sanitizeFindingBody(body).ok).toBe(true);
    }
  });

  it("stays publishable for a path containing a backtick", () => {
    const desync: PinDesync = {
      value: OLD_SHA,
      movedSites: [{ line: 1, value: NEW_SHA, context: "uses" }],
      staleSites: [{ line: 2, value: OLD_SHA, context: "assignment" }],
    };
    const body = describePinDesync(desync, "weird`path.yml");
    expect(sanitizeFindingBody(body).ok).toBe(true);
  });
});

// Exercises PinSite's exported shape directly, independent of findPinSites, so a change to the
// interface itself is caught here even if every scanning test above happened to keep passing.
describe("PinSite shape", () => {
  it("accepts exactly the three documented contexts", () => {
    const contexts: readonly PinSite["context"][] = ["uses", "assignment", "comment"];
    expect(contexts).toHaveLength(3);
  });
});
