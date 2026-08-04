import { describe, expect, it } from "vitest";

import {
  compareContracts,
  compareDeclaredContracts,
  describeMismatch,
  describeUnionGap,
  extractFlatInterfaces,
  extractStringUnions,
  findUncoveredUnionMembers,
  type ShapeMismatch,
  type UnionGap,
} from "./shape-gate.js";
import { sanitizeFindingBody } from "../publish/sanitize.js";

describe("extractFlatInterfaces", () => {
  it("parses an exported flat interface's members, including an optional flag", () => {
    const source = `
      export interface Widget {
        id: string;
        name?: string;
        count: number;
      }
    `;
    const result = extractFlatInterfaces(source);
    expect([...result.keys()]).toEqual(["Widget"]);
    expect(result.get("Widget")?.members).toEqual([
      { name: "id", optional: false, typeText: "string" },
      { name: "name", optional: true, typeText: "string" },
      { name: "count", optional: false, typeText: "number" },
    ]);
  });

  it("skips a non-exported interface entirely", () => {
    const source = `
      interface Internal {
        id: string;
      }
    `;
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("skips a generic interface", () => {
    const source = `
      export interface Box<T> {
        value: T;
      }
    `;
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("skips an interface with an extends clause but keeps an unrelated flat one", () => {
    const source = `
      export interface Base {
        id: string;
      }
      export interface Derived extends Base {
        name: string;
      }
    `;
    const result = extractFlatInterfaces(source);
    expect([...result.keys()]).toEqual(["Base"]);
  });

  it("skips an interface with a method signature", () => {
    const source = `
      export interface HasMethod {
        id: string;
        doStuff(): void;
      }
    `;
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("skips an interface with a generic method signature", () => {
    const source = `
      export interface HasGenericMethod {
        id: string;
        doStuff<T>(arg: T): void;
      }
    `;
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("skips an interface with an index signature", () => {
    const source = `
      export interface Dict {
        [key: string]: string;
      }
    `;
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("skips an interface with a call signature", () => {
    const source = `
      export interface Callable {
        (arg: string): void;
      }
    `;
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("skips an interface with a construct signature", () => {
    const source = `
      export interface Constructable {
        new (arg: string): object;
      }
    `;
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("skips an interface whose member type text nests braces beyond one balanced level", () => {
    const source = `
      export interface Deep {
        config: { a: { b: string } };
      }
    `;
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("tolerates exactly one balanced level of brace nesting in a member's type text, single-line", () => {
    const source = `
      export interface OneLevel {
        config: { a: string; b: number };
      }
    `;
    const result = extractFlatInterfaces(source);
    expect(result.get("OneLevel")?.members).toEqual([
      { name: "config", optional: false, typeText: "{ a: string; b: number }" },
    ]);
  });

  it("parses multiple interfaces from one source", () => {
    const source = `
      export interface First {
        a: string;
      }
      export interface Second {
        b: number;
      }
    `;
    const result = extractFlatInterfaces(source);
    expect([...result.keys()].sort()).toEqual(["First", "Second"]);
  });

  it("carries a readonly member through as an ordinary flat member", () => {
    const source = `
      export interface Locked {
        readonly id: string;
      }
    `;
    const result = extractFlatInterfaces(source);
    expect(result.get("Locked")?.members).toEqual([
      { name: "id", optional: false, typeText: "string" },
    ]);
  });

  it("accepts the last member with no trailing semicolon", () => {
    const source = `
      export interface NoTrailingSemi {
        a: string;
        b: number
      }
    `;
    const result = extractFlatInterfaces(source);
    expect(result.get("NoTrailingSemi")?.members).toEqual([
      { name: "a", optional: false, typeText: "string" },
      { name: "b", optional: false, typeText: "number" },
    ]);
  });

  it("skips a semicolon-free, ASI-style multi-member body rather than merging members", () => {
    const source = `
      export interface AsiStyle {
        a: string
        b: number
      }
    `;
    // Merging "b" into "a"'s type text would silently drop a real member from the result, which
    // is exactly the false-positive shape this gate must never produce — so the whole interface
    // is rejected instead of guessed at.
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("pins type-text opacity: differently-written equivalent types are captured verbatim, never normalized", () => {
    const arraySyntax = `export interface List { items: Array<string>; }`;
    const bracketSyntax = `export interface List { items: string[]; }`;
    expect(extractFlatInterfaces(arraySyntax).get("List")?.members).toEqual([
      { name: "items", optional: false, typeText: "Array<string>" },
    ]);
    expect(extractFlatInterfaces(bracketSyntax).get("List")?.members).toEqual([
      { name: "items", optional: false, typeText: "string[]" },
    ]);
    // And because comparison never inspects type text, the two are never reported as differing.
    expect(compareContracts(arraySyntax, bracketSyntax)).toEqual([]);
  });

  it("accepts a quoted member name and unquotes it", () => {
    const source = `export interface Weird { "not-an-identifier": string; }`;
    const result = extractFlatInterfaces(source);
    expect(result.get("Weird")?.members).toEqual([
      { name: "not-an-identifier", optional: false, typeText: "string" },
    ]);
  });

  it("does not let a brace inside a string literal member desynchronize the body scan", () => {
    const source = `
      export interface WithStringBrace {
        marker: "}";
        after: number;
      }
    `;
    const result = extractFlatInterfaces(source);
    expect(result.get("WithStringBrace")?.members).toEqual([
      { name: "marker", optional: false, typeText: '"}"' },
      { name: "after", optional: false, typeText: "number" },
    ]);
  });
});

describe("extractFlatInterfaces bounds", () => {
  it("returns every interface within the 200-interface bound", () => {
    const source = Array.from(
      { length: 200 },
      (_, i) => `export interface I${String(i)} { a: string; }`,
    ).join("\n");
    expect(extractFlatInterfaces(source).size).toBe(200);
  });

  it("returns an empty result once a source declares more than 200 interfaces", () => {
    const source = Array.from(
      { length: 201 },
      (_, i) => `export interface I${String(i)} { a: string; }`,
    ).join("\n");
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("returns an empty result once a source exceeds 4,000 lines", () => {
    const flat = "export interface Foo {\n  a: string;\n}\n";
    expect(extractFlatInterfaces(flat).size).toBe(1); // control: within bounds
    const padded = "// pad\n".repeat(4001) + flat;
    expect(extractFlatInterfaces(padded).size).toBe(0);
  });
});

describe("extractFlatInterfaces never throws", () => {
  it("on deterministic binary-ish garbage", () => {
    const garbage = Array.from({ length: 5000 }, (_, i) =>
      String.fromCharCode((i * 37) % 256),
    ).join("");
    expect(() => extractFlatInterfaces(garbage)).not.toThrow();
    expect(extractFlatInterfaces(garbage)).toBeInstanceOf(Map);
  });

  it("on an interface whose body never closes", () => {
    const source = "export interface Unclosed {\n  a: string;\n";
    expect(() => extractFlatInterfaces(source)).not.toThrow();
    expect(extractFlatInterfaces(source).size).toBe(0);
  });

  it("on extra, unmatched closing braces after a real interface", () => {
    const source = "export interface Foo { a: string; } } } }";
    expect(() => extractFlatInterfaces(source)).not.toThrow();
    // The first balanced close still correctly bounds the real interface.
    expect(extractFlatInterfaces(source).get("Foo")?.members).toEqual([
      { name: "a", optional: false, typeText: "string" },
    ]);
  });

  it("on a single ~10MB line", () => {
    const huge = "export interface Foo { a: " + "x".repeat(10_000_000) + " }";
    expect(() => extractFlatInterfaces(huge)).not.toThrow();
    expect(extractFlatInterfaces(huge).size).toBe(0);
  });

  it("on an empty string", () => {
    expect(() => extractFlatInterfaces("")).not.toThrow();
    expect(extractFlatInterfaces("").size).toBe(0);
  });

  it("on non-TypeScript text", () => {
    const notCode = "the quick brown fox jumps over the lazy dog\n".repeat(50);
    expect(() => extractFlatInterfaces(notCode)).not.toThrow();
    expect(extractFlatInterfaces(notCode).size).toBe(0);
  });
});

describe("extractStringUnions", () => {
  it("parses an exported string-literal union's members, single line", () => {
    const source = `export type Status = "draft" | "approved" | "rejected";`;
    const result = extractStringUnions(source);
    expect([...result.keys()]).toEqual(["Status"]);
    expect(result.get("Status")?.members).toEqual(["draft", "approved", "rejected"]);
  });

  it("parses a multi-line union in Prettier's leading-pipe style", () => {
    const source = `
      export type CandidateStatus =
        | "draft"
        | "needs-review"
        | "approved"
        | "rejected";
    `;
    const result = extractStringUnions(source);
    expect(result.get("CandidateStatus")?.members).toEqual([
      "draft",
      "needs-review",
      "approved",
      "rejected",
    ]);
  });

  it("tolerates a comment before the first member in leading-pipe style", () => {
    const source = `
      export type Status =
        // the initial state
        | "draft"
        | "approved";
    `;
    const result = extractStringUnions(source);
    expect(result.get("Status")?.members).toEqual(["draft", "approved"]);
  });

  it("accepts single-quoted members exactly like double-quoted ones", () => {
    const source = `export type Status = 'draft' | 'approved';`;
    const result = extractStringUnions(source);
    expect(result.get("Status")?.members).toEqual(["draft", "approved"]);
  });

  it("accepts a union mixing both quote styles across members", () => {
    const source = `export type Status = "draft" | 'approved';`;
    const result = extractStringUnions(source);
    expect(result.get("Status")?.members).toEqual(["draft", "approved"]);
  });

  it("skips a non-exported type alias entirely", () => {
    const source = `type Status = "draft" | "approved";`;
    expect(extractStringUnions(source).size).toBe(0);
  });

  it("skips the whole alias when a member is a reference to another type, not a literal", () => {
    const source = `export type Status = "draft" | Approved;`;
    expect(extractStringUnions(source).size).toBe(0);
  });

  it("skips the whole alias when a member is a generic type", () => {
    const source = `export type Status = "draft" | Array<string>;`;
    expect(extractStringUnions(source).size).toBe(0);
  });

  it("skips the whole alias when a member is an object literal type", () => {
    const source = `export type Status = "draft" | { kind: "other" };`;
    expect(extractStringUnions(source).size).toBe(0);
  });

  it("skips the whole alias when a member is a template literal type", () => {
    const source = 'export type Status = "draft" | `prefix-${string}`;';
    expect(extractStringUnions(source).size).toBe(0);
  });

  it("skips an alias with no terminating semicolon before the source ends", () => {
    const source = `export type Status = "draft" | "approved"`;
    expect(extractStringUnions(source).size).toBe(0);
  });

  it("deduplicates a member repeated in the union, keeping first-appearance order", () => {
    const source = `export type Status = "draft" | "approved" | "draft";`;
    const result = extractStringUnions(source);
    expect(result.get("Status")?.members).toEqual(["draft", "approved"]);
  });

  it("parses multiple unions from one source", () => {
    const source = `
      export type First = "a" | "b";
      export type Second = "x" | "y";
    `;
    const result = extractStringUnions(source);
    expect([...result.keys()].sort()).toEqual(["First", "Second"]);
  });

  it("does not let a pipe inside a string literal's own text desynchronize the split", () => {
    const source = String.raw`export type Status = "a|b" | "c";`;
    const result = extractStringUnions(source);
    expect(result.get("Status")?.members).toEqual(["a|b", "c"]);
  });
});

describe("extractStringUnions bounds", () => {
  it("returns every union within the 200-union bound", () => {
    const source = Array.from({ length: 200 }, (_, i) => `export type U${String(i)} = "a";`).join(
      "\n",
    );
    expect(extractStringUnions(source).size).toBe(200);
  });

  it("returns an empty result once a source declares more than 200 unions", () => {
    const source = Array.from({ length: 201 }, (_, i) => `export type U${String(i)} = "a";`).join(
      "\n",
    );
    expect(extractStringUnions(source).size).toBe(0);
  });

  it("returns an empty result once a source exceeds 4,000 lines", () => {
    const flat = 'export type Foo = "a" | "b";\n';
    expect(extractStringUnions(flat).size).toBe(1); // control: within bounds
    const padded = "// pad\n".repeat(4001) + flat;
    expect(extractStringUnions(padded).size).toBe(0);
  });
});

describe("extractStringUnions never throws", () => {
  it("on deterministic binary-ish garbage", () => {
    const garbage = Array.from({ length: 5000 }, (_, i) =>
      String.fromCharCode((i * 41) % 256),
    ).join("");
    expect(() => extractStringUnions(garbage)).not.toThrow();
    expect(extractStringUnions(garbage)).toBeInstanceOf(Map);
  });

  it("on an alias whose right-hand side never terminates", () => {
    const source = `export type Foo = "a" | "b"`;
    expect(() => extractStringUnions(source)).not.toThrow();
    expect(extractStringUnions(source).size).toBe(0);
  });

  it("on a single ~10MB line", () => {
    const huge = 'export type Foo = "' + "x".repeat(10_000_000) + '";';
    expect(() => extractStringUnions(huge)).not.toThrow();
    expect(extractStringUnions(huge).size).toBe(0);
  });

  it("on an empty string", () => {
    expect(() => extractStringUnions("")).not.toThrow();
    expect(extractStringUnions("").size).toBe(0);
  });

  it("on non-TypeScript text", () => {
    const notCode = "the quick brown fox jumps over the lazy dog\n".repeat(50);
    expect(() => extractStringUnions(notCode)).not.toThrow();
    expect(extractStringUnions(notCode).size).toBe(0);
  });
});

describe("compareContracts", () => {
  it("reports a member missing from the right side, with the correct direction", () => {
    const left = `export interface Foo { a: string; b: number; }`;
    const right = `export interface Foo { a: string; }`;
    expect(compareContracts(left, right)).toEqual([
      { interfaceName: "Foo", member: "b", missingFrom: "right", optionalOnPresentSide: false },
    ]);
  });

  it("reports a member missing from the left side, with the correct direction", () => {
    const left = `export interface Foo { a: string; }`;
    const right = `export interface Foo { a: string; b: number; }`;
    expect(compareContracts(left, right)).toEqual([
      { interfaceName: "Foo", member: "b", missingFrom: "left", optionalOnPresentSide: false },
    ]);
  });

  it("carries the optional flag from the side where the member is present", () => {
    const left = `export interface Foo { a: string; b?: number; }`;
    const right = `export interface Foo { a: string; }`;
    expect(compareContracts(left, right)).toEqual([
      { interfaceName: "Foo", member: "b", missingFrom: "right", optionalOnPresentSide: true },
    ]);
  });

  it("never pairs across different interface names, even with identical member shapes", () => {
    const left = `export interface Foo { a: string; }`;
    const right = `export interface Bar { a: string; }`;
    expect(compareContracts(left, right)).toEqual([]);
  });

  it("reports nothing for two identical declarations", () => {
    const source = `export interface Foo { a: string; b?: number; }`;
    expect(compareContracts(source, source)).toEqual([]);
  });

  it("reports nothing when neither side extracts any flat interface", () => {
    expect(compareContracts("not typescript at all", "also not typescript")).toEqual([]);
  });

  describe("Keiko#2963-shaped fixture", () => {
    // The measured case from issue #80: a server route's response type gains
    // `unparseableScreenCount`; the UI's separately declared twin never learns about it, so a
    // proposal that silently dropped screens still renders as complete.
    const SERVER_RESPONSE = `
      export interface FigmaCodegenResponse {
        proposalId: string;
        screenCount: number;
        unparseableScreenCount: number;
        generatedAt: string;
      }
    `;
    const CLIENT_RESPONSE = `
      export interface FigmaCodegenResponse {
        proposalId: string;
        screenCount: number;
        generatedAt: string;
      }
    `;

    it("finds exactly one mismatch: the server-only unparseableScreenCount field", () => {
      expect(compareContracts(SERVER_RESPONSE, CLIENT_RESPONSE)).toEqual([
        {
          interfaceName: "FigmaCodegenResponse",
          member: "unparseableScreenCount",
          missingFrom: "right",
          optionalOnPresentSide: false,
        },
      ]);
    });
  });
});

describe("compareContracts never throws", () => {
  it("when either side is binary-ish garbage", () => {
    const garbage = Array.from({ length: 3000 }, (_, i) =>
      String.fromCharCode((i * 53) % 256),
    ).join("");
    const flat = `export interface Foo { a: string; }`;
    expect(() => compareContracts(garbage, flat)).not.toThrow();
    expect(() => compareContracts(flat, garbage)).not.toThrow();
    expect(() => compareContracts(garbage, garbage)).not.toThrow();
  });
});

describe("compareDeclaredContracts", () => {
  describe("contract-response-field-dropped-shaped fixture", () => {
    // The measured gap from the corpus port (issue #80): the server side declares `ImportResult`;
    // the client's separately-declared response type is named `ImportResponse`. Different names, so
    // plain `compareContracts` never pairs them (pinned below) — exactly the shape
    // `compareDeclaredContracts` exists to reach, for a pair the review profile has declared.
    const IMPORT_RESULT = `
      export interface ImportResult {
        imported: number;
        failed: number;
        skippedCount: number;
      }
    `;
    const IMPORT_RESPONSE = `
      export interface ImportResponse {
        imported: number;
        failed: number;
      }
    `;

    it("finds exactly one mismatch by falling back to positional pairing", () => {
      expect(compareDeclaredContracts(IMPORT_RESULT, IMPORT_RESPONSE)).toEqual([
        {
          interfaceName: "ImportResult vs ImportResponse",
          member: "skippedCount",
          missingFrom: "right",
          optionalOnPresentSide: false,
        },
      ]);
    });

    it("plain compareContracts still finds nothing for the same pair (the default stays strict)", () => {
      expect(compareContracts(IMPORT_RESULT, IMPORT_RESPONSE)).toEqual([]);
    });
  });

  it("refuses the positional fallback when either side declares more than one flat interface", () => {
    const left = `
      export interface Foo { a: string; }
      export interface Extra { x: string; }
    `;
    const right = `export interface Bar { a: string; }`;
    // Ambiguous which of the left's two interfaces the profile meant — silence, not a guess.
    expect(compareDeclaredContracts(left, right)).toEqual([]);
  });

  it("refuses the positional fallback when the right side declares more than one flat interface", () => {
    const left = `export interface Foo { a: string; }`;
    const right = `
      export interface Bar { a: string; }
      export interface Extra { x: string; }
    `;
    expect(compareDeclaredContracts(left, right)).toEqual([]);
  });

  it("never runs the positional fallback when a same-name match is already present", () => {
    const left = `export interface Foo { a: string; b: string; }`;
    const right = `export interface Foo { a: string; }`;
    const result = compareDeclaredContracts(left, right);
    expect(result).toEqual([
      { interfaceName: "Foo", member: "b", missingFrom: "right", optionalOnPresentSide: false },
    ]);
    // Confirms the label came from the same-name path, not positional pairing ("Foo vs Foo").
    expect(result[0]?.interfaceName).toBe("Foo");
  });

  it("reports nothing for two identical single interfaces (same-name and positional paths agree)", () => {
    const source = `export interface Foo { a: string; }`;
    expect(compareDeclaredContracts(source, source)).toEqual([]);
  });

  it("reports nothing when neither side declares any flat interface (audit-validator-drift shape)", () => {
    expect(compareDeclaredContracts("not typescript at all", "also not typescript")).toEqual([]);
  });
});

describe("compareDeclaredContracts never throws", () => {
  it("when either side is binary-ish garbage", () => {
    const garbage = Array.from({ length: 3000 }, (_, i) =>
      String.fromCharCode((i * 59) % 256),
    ).join("");
    const flat = `export interface Foo { a: string; }`;
    expect(() => compareDeclaredContracts(garbage, flat)).not.toThrow();
    expect(() => compareDeclaredContracts(flat, garbage)).not.toThrow();
    expect(() => compareDeclaredContracts(garbage, garbage)).not.toThrow();
  });
});

describe("findUncoveredUnionMembers", () => {
  describe("status-union-widened-consumer-missed-shaped fixture", () => {
    // The corpus port's measured gap (issue #80): the status module gains "rejected"; the
    // deliverability predicate that must handle every status value is untouched by the diff that
    // adds it, and never mentions "rejected" anywhere in its own text.
    const BASE_STATUS = `export type CandidateStatus = "draft" | "needs-review" | "approved";`;
    const HEAD_STATUS = `export type CandidateStatus = "draft" | "needs-review" | "approved" | "rejected";`;
    const CONSUMER = `
      import type { CandidateStatus } from "./candidate-status.js";

      export function isDeliverable(status: CandidateStatus): boolean {
        return status !== "needs-review";
      }
    `;

    it("finds exactly one gap: the added rejected member the consumer never mentions", () => {
      expect(findUncoveredUnionMembers(BASE_STATUS, HEAD_STATUS, CONSUMER)).toEqual([
        { unionName: "CandidateStatus", member: "rejected" },
      ]);
    });

    it("reports nothing once the counterpart mentions the literal anywhere, even in a comment", () => {
      const consumerWithComment = `
        import type { CandidateStatus } from "./candidate-status.js";

        // TODO: handle "rejected" once product decides what it should do.
        export function isDeliverable(status: CandidateStatus): boolean {
          return status !== "needs-review";
        }
      `;
      expect(findUncoveredUnionMembers(BASE_STATUS, HEAD_STATUS, consumerWithComment)).toEqual([]);
    });

    it("also recognizes a single-quoted mention as coverage", () => {
      const consumerWithSingleQuote = `
        import type { CandidateStatus } from "./candidate-status.js";

        const handled = ['draft', 'needs-review', 'approved', 'rejected'];
        export function isDeliverable(status: CandidateStatus): boolean {
          return handled.includes(status) && status !== "needs-review";
        }
      `;
      expect(findUncoveredUnionMembers(BASE_STATUS, HEAD_STATUS, consumerWithSingleQuote)).toEqual(
        [],
      );
    });
  });

  it("reports nothing for a brand-new union (absent from base entirely)", () => {
    const base = `export type Other = "x";`;
    const head = `
      export type Other = "x";
      export type CandidateStatus = "draft" | "rejected";
    `;
    expect(findUncoveredUnionMembers(base, head, "no mention here")).toEqual([]);
  });

  it("reports nothing when no member was added, only reordered", () => {
    const base = `export type CandidateStatus = "draft" | "approved";`;
    const head = `export type CandidateStatus = "approved" | "draft";`;
    expect(findUncoveredUnionMembers(base, head, "irrelevant")).toEqual([]);
  });

  it("treats a union with a non-literal member as entirely skipped, not partially covered", () => {
    const base = `export type CandidateStatus = "draft" | "approved";`;
    const head = `export type CandidateStatus = "draft" | "approved" | Legacy;`;
    // "Legacy" disqualifies the whole head union (see extractStringUnions), so there is no head
    // entry to compare against base at all — not a gap, and not a false "added: Legacy" either.
    expect(extractStringUnions(head).size).toBe(0);
    expect(findUncoveredUnionMembers(base, head, "irrelevant")).toEqual([]);
  });

  it("reports a gap per added member, independently", () => {
    const base = `export type CandidateStatus = "draft";`;
    const head = `export type CandidateStatus = "draft" | "approved" | "rejected";`;
    const counterpart = `if (status === "approved") return true;`; // mentions "approved" only
    expect(findUncoveredUnionMembers(base, head, counterpart)).toEqual([
      { unionName: "CandidateStatus", member: "rejected" },
    ]);
  });
});

describe("findUncoveredUnionMembers never throws", () => {
  it("when any argument is binary-ish garbage", () => {
    const garbage = Array.from({ length: 2000 }, (_, i) =>
      String.fromCharCode((i * 67) % 256),
    ).join("");
    const base = `export type Foo = "a";`;
    const head = `export type Foo = "a" | "b";`;
    expect(() => findUncoveredUnionMembers(garbage, head, "x")).not.toThrow();
    expect(() => findUncoveredUnionMembers(base, garbage, "x")).not.toThrow();
    expect(() => findUncoveredUnionMembers(base, head, garbage)).not.toThrow();
    expect(() => findUncoveredUnionMembers(garbage, garbage, garbage)).not.toThrow();
  });

  it("on an oversized counterpart source", () => {
    const base = `export type Foo = "a";`;
    const head = `export type Foo = "a" | "b";`;
    const hugeCounterpart = "x".repeat(2_000_001);
    expect(() => findUncoveredUnionMembers(base, head, hugeCounterpart)).not.toThrow();
    expect(findUncoveredUnionMembers(base, head, hugeCounterpart)).toEqual([]);
  });
});

describe("describeMismatch", () => {
  const MISMATCH: ShapeMismatch = {
    interfaceName: "FigmaCodegenResponse",
    member: "unparseableScreenCount",
    missingFrom: "right",
    optionalOnPresentSide: false,
  };
  const LEFT_PATH = "packages/keiko-server/src/routes/figmaCodegenRoutes.ts";
  const RIGHT_PATH = "packages/keiko-ui/src/lib/figma-codegen-api.ts";

  it("renders an imperative first line, a blank line, then prose", () => {
    const body = describeMismatch(MISMATCH, LEFT_PATH, RIGHT_PATH);
    const [firstLine, blank, ...rest] = body.split("\n");
    expect(firstLine).toMatch(/\.$/);
    expect(firstLine?.length).toBeLessThan(100);
    expect(blank).toBe("");
    expect(rest.join("\n").length).toBeGreaterThan(0);
  });

  it("names the interface, the member, and both files", () => {
    const body = describeMismatch(MISMATCH, LEFT_PATH, RIGHT_PATH);
    expect(body).toContain("unparseableScreenCount");
    expect(body).toContain("FigmaCodegenResponse");
    expect(body).toContain(LEFT_PATH);
    expect(body).toContain(RIGHT_PATH);
  });

  it("describes the opposite direction correctly when missingFrom is left", () => {
    const mismatch: ShapeMismatch = { ...MISMATCH, missingFrom: "left" };
    const body = describeMismatch(mismatch, LEFT_PATH, RIGHT_PATH);
    // The member is present on the right and absent on the left, so the left path is the one
    // named as lacking it — check both paths still appear; direction correctness is pinned by
    // the compareContracts direction tests above plus this round-trip.
    expect(body).toContain(LEFT_PATH);
    expect(body).toContain(RIGHT_PATH);
  });

  it("never emits the opaque type text, only presence and absence", () => {
    const body = describeMismatch(MISMATCH, LEFT_PATH, RIGHT_PATH);
    expect(body).not.toContain("number");
  });
});

describe("describeUnionGap", () => {
  const GAP: UnionGap = {
    unionName: "CandidateStatus",
    member: "rejected",
  };
  const CHANGED_PATH = "src/candidate-status.ts";
  const COUNTERPART_PATH = "src/candidate-deliverability.ts";

  it("renders an imperative first line, a blank line, then prose", () => {
    const body = describeUnionGap(GAP, CHANGED_PATH, COUNTERPART_PATH);
    const [firstLine, blank, ...rest] = body.split("\n");
    expect(firstLine).toMatch(/\.$/);
    expect(firstLine?.length).toBeLessThan(100);
    expect(blank).toBe("");
    expect(rest.join("\n").length).toBeGreaterThan(0);
  });

  it("names the union, the added member, and both files", () => {
    const body = describeUnionGap(GAP, CHANGED_PATH, COUNTERPART_PATH);
    expect(body).toContain("rejected");
    expect(body).toContain("CandidateStatus");
    expect(body).toContain(CHANGED_PATH);
    expect(body).toContain(COUNTERPART_PATH);
  });
});

describe("describeMismatch output is always publishable", () => {
  const PATHS = [
    "packages/keiko-server/src/routes/figmaCodegenRoutes.ts",
    "packages/keiko-ui/src/lib/figma-codegen-api.ts",
  ] as const;

  const CASES: readonly ShapeMismatch[] = [
    {
      interfaceName: "FigmaCodegenResponse",
      member: "unparseableScreenCount",
      missingFrom: "right",
      optionalOnPresentSide: false,
    },
    {
      interfaceName: "FigmaCodegenResponse",
      member: "unparseableScreenCount",
      missingFrom: "left",
      optionalOnPresentSide: false,
    },
    {
      interfaceName: "AccountSummary",
      member: "pendingBalance",
      missingFrom: "right",
      optionalOnPresentSide: true,
    },
    {
      interfaceName: "AccountSummary",
      member: "pendingBalance",
      missingFrom: "left",
      optionalOnPresentSide: true,
    },
  ];

  it.each(CASES.map((mismatch) => [mismatch] as const))(
    "round-trips %j through the real sanitizeFindingBody",
    (mismatch) => {
      const body = describeMismatch(mismatch, PATHS[0], PATHS[1]);
      expect(sanitizeFindingBody(body)).toEqual({ ok: true, body });
    },
  );

  it("stays publishable for every mismatch produced by the Keiko#2963 fixture", () => {
    const server = `
      export interface FigmaCodegenResponse {
        proposalId: string;
        screenCount: number;
        unparseableScreenCount: number;
      }
    `;
    const client = `
      export interface FigmaCodegenResponse {
        proposalId: string;
        screenCount: number;
      }
    `;
    const mismatches = compareContracts(server, client);
    expect(mismatches.length).toBeGreaterThan(0);
    for (const mismatch of mismatches) {
      const body = describeMismatch(mismatch, PATHS[0], PATHS[1]);
      expect(sanitizeFindingBody(body).ok).toBe(true);
    }
  });

  it("stays publishable even for an unusual, quoted member name", () => {
    const mismatch: ShapeMismatch = {
      interfaceName: "Weird",
      member: "not an identifier <script>",
      missingFrom: "right",
      optionalOnPresentSide: false,
    };
    const body = describeMismatch(mismatch, PATHS[0], PATHS[1]);
    expect(sanitizeFindingBody(body).ok).toBe(true);
  });
});

describe("describeUnionGap output is always publishable", () => {
  const PATHS = ["src/candidate-status.ts", "src/candidate-deliverability.ts"] as const;

  const CASES: readonly UnionGap[] = [
    { unionName: "CandidateStatus", member: "rejected" },
    { unionName: "CandidateStatus", member: "needs-review" },
    { unionName: "AccountTier", member: "enterprise-trial" },
  ];

  it.each(CASES.map((gap) => [gap] as const))(
    "round-trips %j through the real sanitizeFindingBody",
    (gap) => {
      const body = describeUnionGap(gap, PATHS[0], PATHS[1]);
      expect(sanitizeFindingBody(body)).toEqual({ ok: true, body });
    },
  );

  it("stays publishable for every gap produced by the status-union-widened fixture", () => {
    const base = `export type CandidateStatus = "draft" | "needs-review" | "approved";`;
    const head = `export type CandidateStatus = "draft" | "needs-review" | "approved" | "rejected";`;
    const consumer = `
      import type { CandidateStatus } from "./candidate-status.js";

      export function isDeliverable(status: CandidateStatus): boolean {
        return status !== "needs-review";
      }
    `;
    const gaps = findUncoveredUnionMembers(base, head, consumer);
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      const body = describeUnionGap(gap, PATHS[0], PATHS[1]);
      expect(sanitizeFindingBody(body).ok).toBe(true);
    }
  });

  it("stays publishable even for an unusual literal value", () => {
    const gap: UnionGap = {
      unionName: "Weird",
      member: "not an identifier <script>",
    };
    const body = describeUnionGap(gap, PATHS[0], PATHS[1]);
    expect(sanitizeFindingBody(body).ok).toBe(true);
  });
});
