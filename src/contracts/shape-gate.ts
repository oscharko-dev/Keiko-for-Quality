/**
 * Deterministic structural-compatibility gate (issue #80, technique D).
 *
 * The sharpest sub-case of cross-artifact contract drift is also the most mechanical one: a
 * server's exported response type and a client's separately-declared twin of the same name are
 * supposed to describe the same shape, and when they silently stop agreeing, a value one side
 * produces has nowhere to land on the other. Keiko#2963 is the measured instance: a route gained
 * `unparseableScreenCount`; the UI's own `FigmaCodegenResponse` never learned about it, so a
 * proposal with dropped screens still rendered as complete. No model judgement is required to see
 * that — it is a question about NAMES, not about meaning, and a question about names can be
 * answered exactly.
 *
 * This module answers only that question, and only when it is certain. It extracts "flat"
 * interfaces (no generics, no `extends`, members that are plain property signatures) from two
 * source texts, and reports members present under the same interface name on one side and absent
 * on the other. Everything it cannot fully parse it skips rather than guesses about — skipping is
 * the mechanism, not a fallback, because a wrong claim from a deterministic gate is worse than a
 * missed one: nothing downstream expects to double-check a gate the way it double-checks a model.
 * This gate only ever speaks about shapes it fully understood.
 *
 * Deliberately opaque to type TEXT: two members with the same name but differently-written types
 * (`Array<string>` vs `string[]`, or a genuine incompatibility) are never compared for equality,
 * because that comparison needs real type semantics this module does not have — a hand-rolled
 * "are these types compatible" check would itself be a second source of wrong claims. Presence and
 * absence is the one question a name-based line scan can answer without guessing.
 *
 * No imports, by design: this gate is meant to be understandable, testable, and trustworthy in
 * isolation from the rest of the review pipeline that will eventually call it (that wiring is the
 * orchestrator's job, not this module's — see issue #80). It is not a TypeScript parser — the
 * product carries zero runtime dependencies, so there is no compiler API on hand, and a hand-rolled
 * one would be its own large surface to get wrong. A small brace/paren tracker, applied line- and
 * character-wise, is enough to find where a flat interface starts and ends; anything that does not
 * fit that shape is left for a human or a model to judge, never guessed at here.
 *
 * Known, accepted limitations (all fail toward skipping, never toward a wrong claim):
 * - a numeric literal property key (`0: string;`) is not recognised as a property signature;
 * - a member's type text may nest an inline object type one level deep (`{ a: string }`) but no
 *   deeper, and a semicolon-free (ASI-style) member list is not split reliably — both shapes are
 *   safely rejected whole rather than misread, per the two rules above;
 * - text that merely resembles `export interface Name { ... }` inside a string or a comment is not
 *   distinguished from the real thing. Real source files essentially never do this; a full tokenizer
 *   to rule it out would be exactly the parser this module deliberately does not carry.
 */

/** One property signature member of a flat interface. `typeText` is the raw, unparsed type text. */
export interface FlatMember {
  readonly name: string;
  readonly optional: boolean;
  readonly typeText: string;
}

/** An exported interface this gate fully understood: no generics, no `extends`, flat members only. */
export interface FlatInterface {
  readonly name: string;
  readonly members: readonly FlatMember[];
}

/** A member declared under the same interface name on one side of a comparison but not the other. */
export interface ShapeMismatch {
  readonly interfaceName: string;
  readonly member: string;
  readonly missingFrom: "left" | "right";
  /** Whether the member is optional on the side where it IS present. */
  readonly optionalOnPresentSide: boolean;
}

// -------------------------------------------------------------------------------------------
// Bounds. Each exists so a pathological or merely huge input costs a fixed, small amount of work
// rather than an amount proportional to how bad the input is — "beyond -> empty result" is a
// deliberate, simpler contract than "beyond -> best-effort partial result", because a partial
// extraction of 200-out-of-1000 interfaces invites exactly the false confidence this gate exists
// to avoid: a caller seeing 200 results has no way to tell "that is everything" from "that is a cap".
// -------------------------------------------------------------------------------------------

/** Exceeding this returns an empty result. Guards against a source with far more declarations than any real file. */
const MAX_INTERFACES = 200;

/** Exceeding this returns an empty result. */
const MAX_LINES = 4000;

/**
 * Exceeding this returns an empty result, checked BEFORE the line count. A single pathological line
 * (no newlines at all) would sail through the line-count bound above while still being enormous, so
 * this is an independent character-count bound, not a restatement of it. Comfortably above what
 * 4,000 real source lines add up to, comfortably below the kind of input a fuzz test throws at it.
 */
const MAX_SOURCE_CHARS = 2_000_000;

// -------------------------------------------------------------------------------------------
// Shared character-level scanning helpers.
// -------------------------------------------------------------------------------------------

const WHITESPACE = /\s/;
const QUOTES = new Set(['"', "'", "`"]);
const OPENERS = new Set(["{", "(", "["]);
const CLOSERS = new Set(["}", ")", "]"]);
const SEPARATORS = new Set([";", ","]);

/** Index of the first non-whitespace character at or after `from`, or `source.length` if none. */
function skipWhitespace(source: string, from: number): number {
  let i = from;
  while (i < source.length && WHITESPACE.test(source.charAt(i))) i += 1;
  return i;
}

/**
 * When `i` starts a line comment, block comment, or quoted/template literal, returns the index just
 * past its end (or the end of `source`, for one that never closes). Otherwise returns `i` unchanged.
 *
 * This is what lets brace-counting elsewhere in this module ignore a stray `}` or `;` that is only
 * text inside a string or a comment, rather than real structure — the one piece of tokenizing this
 * gate does, because getting it wrong risks a wrong claim rather than merely a missed one.
 */
function skipLiteralOrComment(source: string, i: number): number {
  const ch = source.charAt(i);
  const next = source.charAt(i + 1);
  if (ch === "/" && next === "/") {
    const nl = source.indexOf("\n", i + 2);
    return nl === -1 ? source.length : nl;
  }
  if (ch === "/" && next === "*") {
    const close = source.indexOf("*/", i + 2);
    return close === -1 ? source.length : close + 2;
  }
  if (QUOTES.has(ch)) return skipQuoted(source, i, ch);
  return i;
}

/** Scans a quoted literal starting at `source[start]`, honoring backslash escapes. */
function skipQuoted(source: string, start: number, quote: string): number {
  let j = start + 1;
  while (j < source.length) {
    const ch = source.charAt(j);
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    j += 1;
  }
  return source.length;
}

/** Removes leading line comments and block comments (and the whitespace around them), left to right. */
function stripLeadingComments(text: string): string {
  let s = text;
  for (let guard = 0; guard < 1000; guard += 1) {
    const trimmed = s.replace(/^\s+/, "");
    if (trimmed.startsWith("//")) {
      const nl = trimmed.indexOf("\n");
      s = nl === -1 ? "" : trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      s = close === -1 ? "" : trimmed.slice(close + 2);
      continue;
    }
    return trimmed;
  }
  return s.trim();
}

// -------------------------------------------------------------------------------------------
// Interface header: name, then optionally `<...>` and/or `extends ...`, then the body's `{`.
// -------------------------------------------------------------------------------------------

const HEADER_PATTERN_SOURCE = String.raw`\bexport\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)`;
const EXTENDS_WORD = /\bextends\b/;

interface HeaderMatch {
  readonly name: string;
  readonly afterName: number;
}

interface HeaderInfo {
  readonly bodyStart: number;
  readonly hasTypeParams: boolean;
  readonly hasExtends: boolean;
}

/** Every `export interface Name` occurrence, capped one past `MAX_INTERFACES` so scanning a source with far too many stops early. */
function matchAllHeaders(source: string): readonly HeaderMatch[] {
  const pattern = new RegExp(HEADER_PATTERN_SOURCE, "g");
  const out: HeaderMatch[] = [];
  let match = pattern.exec(source);
  while (match !== null) {
    out.push({ name: match[1] ?? "", afterName: pattern.lastIndex });
    if (out.length > MAX_INTERFACES) return out;
    match = pattern.exec(source);
  }
  return out;
}

/**
 * Index of the `{` that opens the body following an interface name, tracking `<...>` nesting so a
 * generic parameter's own braces (`T = {}`) or an `extends Base<{ a: string }>` clause cannot be
 * mistaken for the body. Returns -1 when a top-level `;` or the end of `source` arrives first —
 * an ambient or forward declaration this gate does not describe, not a body to guess at.
 */
function findHeaderBrace(source: string, from: number): number {
  let angleDepth = 0;
  let i = from;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "<") angleDepth += 1;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (angleDepth === 0 && ch === "{") return i;
    else if (angleDepth === 0 && ch === ";") return -1;
    i += 1;
  }
  return -1;
}

/**
 * Classifies the header between an interface name and its body: whether type parameters are
 * declared (legal only immediately after the name, so a bare whitespace skip decides it) and
 * whether an `extends` clause is present anywhere before the body.
 */
function locateHeader(source: string, from: number): HeaderInfo | null {
  const firstNonSpace = skipWhitespace(source, from);
  const hasTypeParams = source.charAt(firstNonSpace) === "<";
  const bodyStart = findHeaderBrace(source, from);
  if (bodyStart === -1) return null;
  const hasExtends = EXTENDS_WORD.test(source.slice(from, bodyStart));
  return { bodyStart, hasTypeParams, hasExtends };
}

/**
 * Index of the `}` balancing the `{` at `openIndex`, skipping string/template and comment content
 * so a brace quoted or commented inside the body cannot desynchronize the count. Returns -1 when
 * `source` ends before the brace closes.
 */
function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    } else {
      const skipped = skipLiteralOrComment(source, i);
      if (skipped > i) {
        i = skipped;
        continue;
      }
    }
    i += 1;
  }
  return -1;
}

// -------------------------------------------------------------------------------------------
// Member parsing.
// -------------------------------------------------------------------------------------------

/** A member candidate's type text, analyzed for the two shapes that disqualify its interface. */
interface TypeTextShape {
  readonly maxDepth: number;
  readonly ambiguous: boolean;
}

/** Matches (at the position `lastIndex` is set to) the start of what looks like another member. */
const ANOTHER_MEMBER_START = /[ \t]*(?:[A-Za-z_$][\w$]*|"[^"\n]*"|'[^'\n]*')[ \t]*\??[ \t]*:/y;

/**
 * Walks a member's type text once, tracking `{`/`}` nesting depth and testing every top-level
 * (depth 0) newline for a following name-then-colon shape — the signature of a second member this
 * gate's semicolon/comma-only splitting failed to separate out (an ASI-style member list). Depth is
 * tracked so a legitimate one-level inline object type (`{ a: string; b: number }`, however it is
 * line-wrapped) is never mistaken for that: a newline strictly INSIDE the one tolerated brace level
 * never triggers the ambiguity check.
 */
function analyzeTypeText(text: string): TypeTextShape {
  let depth = 0;
  let peak = 0;
  let ambiguous = false;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "{") {
      depth += 1;
      peak = Math.max(peak, depth);
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "\n" && depth === 0) {
      ANOTHER_MEMBER_START.lastIndex = i + 1;
      if (ANOTHER_MEMBER_START.test(text)) ambiguous = true;
    }
    const skipped = skipLiteralOrComment(text, i);
    i = skipped > i ? skipped : i + 1;
  }
  return { maxDepth: peak, ambiguous };
}

type MemberOutcome =
  | { readonly kind: "empty" }
  | { readonly kind: "reject" }
  | { readonly kind: "member"; readonly member: FlatMember };

const PROPERTY_SIGNATURE =
  /^(?:readonly\s+)?([A-Za-z_$][\w$]*|"[^"\n]*"|'[^'\n]*')(\??)\s*:\s*([\s\S]*)$/;
const NEW_SIGNATURE = /^new\b/;

function unquote(raw: string): string {
  const first = raw.charAt(0);
  return raw.length >= 2 && QUOTES.has(first) ? raw.slice(1, -1) : raw;
}

/** True for the member shapes this gate never treats as a property signature: index/computed, call, and construct signatures. */
function looksLikeNonProperty(stripped: string): boolean {
  return stripped.startsWith("[") || stripped.startsWith("(") || NEW_SIGNATURE.test(stripped);
}

/**
 * Classifies one already comment-stripped, trimmed member candidate. A method, a call signature, an
 * index/computed signature, a construct signature, or a shape this gate could not confidently
 * parse as a single property signature all resolve to "reject" — which the caller turns into
 * skipping the WHOLE interface, per this module's header comment: no per-member partial credit.
 */
function classifyMemberText(stripped: string): MemberOutcome {
  if (stripped.length === 0) return { kind: "empty" };
  if (looksLikeNonProperty(stripped)) return { kind: "reject" };
  const match = PROPERTY_SIGNATURE.exec(stripped);
  if (match === null) return { kind: "reject" };
  const rawType = match[3] ?? "";
  const typeText = rawType.trim();
  if (typeText.length === 0) return { kind: "reject" };
  const shape = analyzeTypeText(rawType);
  if (shape.ambiguous || shape.maxDepth > 1) return { kind: "reject" };
  const name = unquote(match[1] ?? "");
  return { kind: "member", member: { name, optional: match[2] === "?", typeText } };
}

/** Classifies one raw candidate and folds an accepted member into `members`; false disqualifies the whole interface. */
function recordMember(members: Map<string, FlatMember>, raw: string): boolean {
  const outcome = classifyMemberText(stripLeadingComments(raw).trim());
  if (outcome.kind === "reject") return false;
  if (outcome.kind === "member") members.set(outcome.member.name, outcome.member);
  return true;
}

/**
 * Splits an interface body into member candidates on top-level (depth 0) `;`/`,`, tracking combined
 * `{}`/`()`/`[]` nesting so a separator inside a nested type or a function-typed member's parameter
 * list never splits early. The trailing fragment after the last separator (or the whole body, if it
 * has none) is tried as one final candidate, so a last member with no trailing punctuation — legal
 * TypeScript — is not lost. Returns null the moment any candidate disqualifies the interface.
 */
function parseMembers(body: string): readonly FlatMember[] | null {
  const members = new Map<string, FlatMember>();
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (OPENERS.has(ch)) {
      depth += 1;
    } else if (CLOSERS.has(ch)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && SEPARATORS.has(ch)) {
      if (!recordMember(members, body.slice(start, i))) return null;
      start = i + 1;
    }
    const skipped = skipLiteralOrComment(body, i);
    i = skipped > i ? skipped : i + 1;
  }
  if (!recordMember(members, body.slice(start))) return null;
  return [...members.values()];
}

// -------------------------------------------------------------------------------------------
// Public API.
// -------------------------------------------------------------------------------------------

function extractOneInterface(source: string, header: HeaderMatch): FlatInterface | null {
  const info = locateHeader(source, header.afterName);
  if (info === null || info.hasTypeParams || info.hasExtends) return null;
  const bodyEnd = matchingBrace(source, info.bodyStart);
  if (bodyEnd === -1) return null;
  const members = parseMembers(source.slice(info.bodyStart + 1, bodyEnd));
  return members === null ? null : { name: header.name, members };
}

/**
 * Extracts every exported, flat interface from TypeScript source text. "Flat" means: no type
 * parameters, no `extends`, and a body of only plain property signatures (see this module's header
 * comment for the exact, deliberately conservative rules). Anything else — a non-exported
 * interface, a generic or `extends`-ing one, one with a method, index signature, call signature, or
 * a member whose type text nests more than one brace deep — is silently absent from the result,
 * because that absence is what makes this gate's "no false positives" guarantee true: it never
 * reports on a shape it was not certain it parsed correctly.
 *
 * Never throws, and returns an empty map rather than a partial one once `source` exceeds this
 * module's bounds (see `MAX_SOURCE_CHARS`/`MAX_LINES`/`MAX_INTERFACES` above) — including on input
 * that is not TypeScript at all.
 */
export function extractFlatInterfaces(source: string): ReadonlyMap<string, FlatInterface> {
  const empty: ReadonlyMap<string, FlatInterface> = new Map();
  if (source.length > MAX_SOURCE_CHARS || source.split("\n").length > MAX_LINES) return empty;
  const headers = matchAllHeaders(source);
  if (headers.length > MAX_INTERFACES) return empty;

  const result = new Map<string, FlatInterface>();
  for (const header of headers) {
    const flat = extractOneInterface(source, header);
    if (flat !== null) result.set(header.name, flat);
  }
  return result;
}

/** The presence/absence mismatches between two same-named flat interfaces' member sets. */
function compareMembers(name: string, left: FlatInterface, right: FlatInterface): ShapeMismatch[] {
  const leftByName = new Map(left.members.map((member) => [member.name, member]));
  const rightByName = new Map(right.members.map((member) => [member.name, member]));
  const out: ShapeMismatch[] = [];
  for (const member of left.members) {
    if (!rightByName.has(member.name)) {
      out.push({
        interfaceName: name,
        member: member.name,
        missingFrom: "right",
        optionalOnPresentSide: member.optional,
      });
    }
  }
  for (const member of right.members) {
    if (!leftByName.has(member.name)) {
      out.push({
        interfaceName: name,
        member: member.name,
        missingFrom: "left",
        optionalOnPresentSide: member.optional,
      });
    }
  }
  return out;
}

/**
 * Compares every flat interface this gate can extract from `left` and `right`, pairing them SOLELY
 * by interface name — the only heuristic this module uses to decide two declarations describe "the
 * same" shape. Two interfaces with different names are never compared even when their members are
 * identical: guessing that two differently-named declarations are meant to mirror each other is
 * exactly the kind of judgement call this deterministic gate exists to avoid, not perform.
 *
 * For every name present in both, reports members present on one side and absent on the other.
 * Never reports a mismatch for a member whose TYPE TEXT differs between the two sides — see this
 * module's header comment for why type text is opaque by design.
 */
export function compareContracts(left: string, right: string): readonly ShapeMismatch[] {
  const leftInterfaces = extractFlatInterfaces(left);
  const rightInterfaces = extractFlatInterfaces(right);
  const mismatches: ShapeMismatch[] = [];
  for (const [name, leftInterface] of leftInterfaces) {
    const rightInterface = rightInterfaces.get(name);
    if (rightInterface === undefined) continue;
    mismatches.push(...compareMembers(name, leftInterface, rightInterface));
  }
  return mismatches;
}

/**
 * Neutralizes a backtick or backslash so a name or path can be embedded inside a Markdown code span
 * without prematurely closing it. This duplicates `publish/sanitize.ts`'s `escapeInline` in
 * miniature rather than importing it — this module stays import-free by design (see the file
 * header) — and it is the one place this gate composes text a human, not this gate, will read.
 */
function escapeForCodeSpan(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}

/**
 * Renders one mismatch as a finding-body paragraph in the shape `src/engine/rule-file.ts`'s
 * `CATCH_ALL_RULE` prescribes for a finding body (see `src/engine/rule-file.test.ts`'s own
 * examples): an imperative first line ending in a period, a blank line, then plain prose naming
 * which declared interface, which member, which file has it, which file lacks it, and the concrete
 * consequence — a value the producing side sets has no field to occupy on the consuming side.
 *
 * Deliberately omits the opaque type text: it is exactly the content this gate never interpreted,
 * so stating it here would claim a precision this gate does not have. Every value is escaped before
 * it is wrapped in backticks, exactly as `presentation.ts` escapes product-composed text that
 * embeds candidate-controlled values — an interface or member name is read out of source text, not
 * authored by this product, and a quoted TypeScript property name can contain almost anything.
 */
export function describeMismatch(
  mismatch: ShapeMismatch,
  leftPath: string,
  rightPath: string,
): string {
  const presentPath = mismatch.missingFrom === "right" ? leftPath : rightPath;
  const absentPath = mismatch.missingFrom === "right" ? rightPath : leftPath;
  const member = escapeForCodeSpan(mismatch.member);
  const interfaceName = escapeForCodeSpan(mismatch.interfaceName);
  const present = escapeForCodeSpan(presentPath);
  const absent = escapeForCodeSpan(absentPath);
  const drift = mismatch.optionalOnPresentSide
    ? ` It is declared optional even there, so nothing forces the two declarations back into agreement.`
    : ` Nothing ties the two declarations together, so a type check on either file alone stays clean.`;
  return [
    `Add the missing \`${member}\` member to \`${interfaceName}\`.`,
    "",
    `\`${interfaceName}\` is declared separately in \`${present}\` and in \`${absent}\`, and only ` +
      `the declaration in \`${present}\` includes \`${member}\`.${drift} A value the producing side ` +
      `writes into \`${member}\` therefore has no field to occupy on the consuming side: it is ` +
      `silently dropped in transit, or read back as undefined, wherever code trusts the two ` +
      `declarations to describe the same shape.`,
  ].join("\n");
}
