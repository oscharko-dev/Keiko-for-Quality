/**
 * Deterministic pin-desynchronization detector for the measured miss `pinned-reference-duplicate-
 * desync`.
 *
 * On oscharko-dev/Keiko#2977 the reviewer published nothing while both CodeRabbit and Codex flagged
 * the same real defect: a workflow advanced `uses: owner/repo@<sha>` but left a second declaration
 * of the identical pin (`ACTION_PIN: "<old-sha>"`) untouched — and the file's own consistency check
 * silently disabled the review store on mismatch. The file even said "ADVANCE BOTH TOGETHER". A
 * per-file diff review misses this shape by construction: the changed line, read on its own, is
 * completely correct. The defect is legible only by noticing what did NOT change alongside it — an
 * absence — which is exactly the kind of fact a line-by-line diff read never surfaces and a
 * deterministic, whole-file-aware pass can state with certainty.
 *
 * This module answers one narrow, purely textual question about ONE file's base and head text: did
 * two sites that used to name the identical 40-character commit SHA stop agreeing? It never asks
 * whether that agreement was semantically load-bearing — a file can legitimately mention the same
 * commit in two places that were never meant to move together — so it does not report "a SHA appears
 * more than once." It reports only the conjunction this module's mission is built on: the SAME value
 * at 2+ sites in BASE (proof the sites were meant to agree — they held the identical value before
 * this change), and in HEAD at least one of those sites changed while at least one still carries the
 * old value (proof they no longer do). Either half alone is a guess; both together is a fact about
 * what this specific change did to this specific file.
 *
 * Sites are correlated between base and head by LINE NUMBER — the simplest positional identity two
 * plain-text snapshots of the same file share, and a deliberately conservative one: this module ships
 * with no diff or line-alignment algorithm (zero imports, no runtime dependencies, like every module
 * in `contracts/`), so a line inserted or removed above a pin site shifts every line number below it
 * and makes that site silently uncorrelated rather than wrongly paired with an unrelated neighbor.
 * The failure mode that creates is a missed desync, never a fabricated one — the same asymmetry
 * `shape-gate.ts` accepts by pairing interfaces solely by name.
 *
 * Never throws, and never returns a partial result once an input exceeds this module's bounds (4,000
 * lines, 200 pin sites, 2,000,000 characters) — "beyond -> empty", not "beyond -> best effort", for
 * the same reason `shape-gate.ts` gives: a partial scan invites exactly the false confidence ("that
 * is everything found") a caller cannot tell apart from a genuine, complete negative result.
 *
 * Known, accepted limitations (all fail toward silence, never toward a wrong claim):
 * - a line carrying two or more pin sites can be correlated only when context alone disambiguates
 *   which head-side site continues which base-side site; an unresolvable line is left uncorrelated;
 * - `//` is treated as a comment opener except directly after `:` (to admit a URL scheme such as
 *   `https://`), so a SHA embedded in a URL that itself follows an earlier, genuine `//` comment on
 *   the same line can be misread as commented-out. Real workflow and config files essentially never
 *   nest these two shapes on one line;
 * - this is a text scanner, not a YAML or source parser: a SHA that is syntactically a pin site only
 *   by virtue of surrounding structure this module does not model (a folded YAML scalar, a template
 *   literal spanning lines) is run through the same three shallow prefix checks as everything else,
 *   which means it is left unclassified — and therefore invisible to this gate — rather than guessed.
 */

/** One occurrence of a full commit SHA, classified by the shape of the text immediately before it. */
export interface PinSite {
  readonly line: number;
  readonly value: string;
  readonly context: "uses" | "assignment" | "comment";
}

/** Two or more sites that named the same commit in BASE and no longer agree in HEAD. */
export interface PinDesync {
  readonly value: string;
  readonly movedSites: readonly PinSite[];
  readonly staleSites: readonly PinSite[];
}

// -------------------------------------------------------------------------------------------
// Bounds. Each exists so a pathological or merely huge input costs a fixed, small amount of work
// rather than an amount proportional to how bad the input is — see this module's header comment for
// why "beyond -> empty result" is the whole contract, not a fallback.
// -------------------------------------------------------------------------------------------

/** Exceeding this returns an empty result. A real workflow or config file is nowhere near this long. */
const MAX_LINES = 4000;

/** Exceeding this returns an empty result — enforced both while scanning and once more on exit. */
const MAX_PIN_SITES = 200;

/**
 * Exceeding this returns an empty result, checked BEFORE the line count. A single pathological line
 * (no newlines at all) would sail through the line-count bound above while still being enormous, so
 * this is an independent character-count bound, not a restatement of it — the same reasoning
 * `shape-gate.ts` documents for its own identically-valued constant.
 */
const MAX_SOURCE_CHARS = 2_000_000;

// -------------------------------------------------------------------------------------------
// Pin-site recognition: a 40-hex-character SHA literal, word-bounded so it can never match inside a
// longer hex run (a sha256 digest, for instance) or a shorter one, classified by the shape of the
// text immediately before it on its own line.
// -------------------------------------------------------------------------------------------

/**
 * Exactly 40 hex characters, case-insensitive, both boundaries word-bounded. Nothing shorter: a
 * 7-character abbreviation is common and human-friendly, and ALSO a collision waiting to happen — far
 * too many unrelated commits share a 7-hex prefix to found a "these two sites agree" claim on one, so
 * this module never treats an abbreviation as a pin site, rather than guessing when a short match is
 * trustworthy. The trailing `\b` also rejects a longer hex run (a 64-hex sha256 digest): the 41st hex
 * character is itself a word character, so no boundary exists there and the match never starts.
 */
const SHA_SOURCE = String.raw`\b[0-9a-f]{40}\b`;

/**
 * Matches when the text immediately before a candidate SHA is `uses:`, optionally quoted, followed by
 * an action reference ending in a bare `@` — the exact shape GitHub Actions requires for a pinned
 * step (`uses: owner/repo@<sha>`). Requiring the `@` immediately adjacent (not merely "uses: appears
 * somewhere earlier on this line") is what keeps this from also matching a SHA that merely follows a
 * `uses:` line in some unrelated position.
 */
const USES_PREFIX = /\buses\s*:\s*["']?[^\s"'@]+@$/;

/**
 * Matches an identifier bound via `:` or `=`, with an optional opening quote immediately before the
 * value — one shape that covers a YAML scalar (`ACTION_PIN: "<sha>"`), a shell/env-file line
 * (`ACTION_PIN=<sha>`), and a source-level constant (`const SHA = "<sha>"`). Checked only after the
 * `uses:` shape above and the comment check below both fail, so a real `uses:` pin is never
 * reclassified as a generic assignment merely because it also happens to look like one.
 */
const ASSIGNMENT_PREFIX = /[A-Za-z_$][\w$.-]*\s*[:=]\s*["'`]?$/;

/**
 * Index of the earliest comment-opening marker (`#` or `//`) in `prefix`, or -1 when none precedes
 * the pin site. A `//` immediately after `:` is treated as part of a URL scheme (`https://…`), not a
 * comment opener — see this module's header comment for the trade-off that exclusion accepts.
 */
function commentMarkerIndex(prefix: string): number {
  const hash = prefix.indexOf("#");
  let slashes = prefix.indexOf("//");
  while (slashes !== -1 && prefix.charAt(slashes - 1) === ":") {
    slashes = prefix.indexOf("//", slashes + 2);
  }
  if (hash === -1) return slashes;
  if (slashes === -1) return hash;
  return Math.min(hash, slashes);
}

/**
 * Classifies a pin site by the text immediately before it on its line. Order matters: a comment
 * marker anywhere earlier on the line wins even over a `uses:`/assignment shape, because a commented-
 * out reference is not a live pin site. A prefix matching none of the three shapes yields `null`,
 * which the caller treats as "not a pin site at all" rather than forcing it into one of the three —
 * see this module's header comment on never guessing a classification.
 */
function classifyContext(prefix: string): PinSite["context"] | null {
  if (commentMarkerIndex(prefix) !== -1) return "comment";
  if (USES_PREFIX.test(prefix)) return "uses";
  if (ASSIGNMENT_PREFIX.test(prefix)) return "assignment";
  return null;
}

/**
 * Scans one line for every recognizable pin site, appending each to `out`. Returns `true` the moment
 * `out` exceeds `MAX_PIN_SITES`, so the caller can stop scanning further lines immediately — bounded
 * work even against a single pathological line packed with SHA-shaped substrings.
 */
function scanLine(shaPattern: RegExp, line: string, lineNumber: number, out: PinSite[]): boolean {
  shaPattern.lastIndex = 0;
  let match = shaPattern.exec(line);
  while (match !== null) {
    const context = classifyContext(line.slice(0, match.index));
    if (context !== null) {
      out.push({ line: lineNumber, value: match[0], context });
      if (out.length > MAX_PIN_SITES) return true;
    }
    match = shaPattern.exec(line);
  }
  return false;
}

function collectPinSites(lines: readonly string[]): readonly PinSite[] {
  const shaPattern = new RegExp(SHA_SOURCE, "gi");
  const out: PinSite[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (scanLine(shaPattern, lines[i] ?? "", i + 1, out)) return out;
  }
  return out;
}

/**
 * Extracts every pin site from TypeScript, YAML, or similar text. Never throws, and returns an empty
 * array rather than a partial one once `source` exceeds this module's bounds — including on input
 * that is not structured text at all. See this module's header comment for what "pin site" means and
 * why an unclassifiable SHA occurrence is silently absent from the result.
 */
export function findPinSites(source: string): readonly PinSite[] {
  if (source.length > MAX_SOURCE_CHARS) return [];
  const lines = source.split("\n");
  if (lines.length > MAX_LINES) return [];
  const sites = collectPinSites(lines);
  return sites.length > MAX_PIN_SITES ? [] : sites;
}

// -------------------------------------------------------------------------------------------
// Desync detection: the conjunction described in this module's header comment, applied per distinct
// base-side value.
// -------------------------------------------------------------------------------------------

/**
 * Case-insensitive equality for two SHA values. Git treats a commit SHA as case-insensitive, and this
 * module's own matching already accepts either case (see `SHA_SOURCE`), so two spellings of the
 * identical commit must never register as a "moved" pair just because their letters differ in case.
 */
function sameValue(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function groupByValue(sites: readonly PinSite[]): Map<string, PinSite[]> {
  const groups = new Map<string, PinSite[]>();
  for (const site of sites) {
    const key = site.value.toLowerCase();
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [site]);
    else group.push(site);
  }
  return groups;
}

function groupByLine(sites: readonly PinSite[]): Map<number, PinSite[]> {
  const groups = new Map<number, PinSite[]>();
  for (const site of sites) {
    const group = groups.get(site.line);
    if (group === undefined) groups.set(site.line, [site]);
    else group.push(site);
  }
  return groups;
}

/**
 * The head-side site that corresponds to a given base-side site, keyed by line number (see this
 * module's header comment for why). When a line carries more than one pin site (rare — two SHAs
 * mentioned on one line), the context tag is the tie-breaker; when even that does not resolve to
 * exactly one candidate, the site is left uncorrelated rather than guessed at.
 */
function correlateSite(
  baseSite: PinSite,
  headByLine: ReadonlyMap<number, readonly PinSite[]>,
): PinSite | undefined {
  const candidates = headByLine.get(baseSite.line) ?? [];
  if (candidates.length === 1) return candidates[0];
  return candidates.find((candidate) => candidate.context === baseSite.context);
}

/**
 * Applies the conjunction rule to one base-side value group: correlate every site into HEAD, and
 * report only when at least one correlated site changed value (moved) AND at least one correlated
 * site still carries the original value (stale). A site that vanished from HEAD (no correlated
 * candidate) contributes to neither list — it is simply not evidence either way, never treated as
 * proof of anything.
 */
function desyncForGroup(
  sites: readonly PinSite[],
  headByLine: ReadonlyMap<number, readonly PinSite[]>,
): PinDesync | null {
  const moved: PinSite[] = [];
  const stale: PinSite[] = [];
  for (const site of sites) {
    const match = correlateSite(site, headByLine);
    if (match === undefined) continue;
    if (sameValue(match.value, site.value)) stale.push(match);
    else moved.push(match);
  }
  if (moved.length === 0 || stale.length === 0) return null;
  const [first] = sites;
  return first === undefined ? null : { value: first.value, movedSites: moved, staleSites: stale };
}

/**
 * Detects every pin desynchronization between one file's base and head text. Reports a value only
 * when it named 2+ sites in `base` AND, correlated into `head`, at least one of those sites changed
 * while at least one still carries the original value — see this module's header comment for why that
 * conjunction, and only that conjunction, is published. Never throws; bounded entirely by
 * `findPinSites`' own bounds on each side.
 */
export function detectPinDesync(base: string, head: string): readonly PinDesync[] {
  // Identical text cannot disagree with itself; this also makes the common "nothing changed" case
  // free of any scanning at all.
  if (base === head) return [];

  const baseSites = findPinSites(base);
  const headSites = findPinSites(head);
  if (baseSites.length === 0 || headSites.length === 0) return [];

  const headByLine = groupByLine(headSites);
  const results: PinDesync[] = [];
  for (const sites of groupByValue(baseSites).values()) {
    // A single site has no counterpart to have drifted from — see this module's header comment.
    if (sites.length < 2) continue;
    const desync = desyncForGroup(sites, headByLine);
    if (desync !== null) results.push(desync);
  }
  return results;
}

// -------------------------------------------------------------------------------------------
// Rendering: a finding body in the shape `src/engine/rule-file.ts`'s `CATCH_ALL_RULE` prescribes.
// -------------------------------------------------------------------------------------------

/**
 * Neutralizes a backtick or backslash so text can be embedded inside a Markdown code span without
 * prematurely closing it. Duplicated from `publish/sanitize.ts`'s `escapeInline` in miniature rather
 * than imported — this module stays import-free by design, like `shape-gate.ts` (see this module's
 * header comment) — and this is the one place it composes text a human, not this gate, will read.
 */
function escapeForCodeSpan(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}

/**
 * Renders a sorted, deduplicated list of a site group's line numbers as "line N" or "lines N and M"
 * (or "lines N, M and P" for three or more). Grammar dodges singular/plural verb agreement entirely
 * by never pairing this phrase with a present-tense verb in `describePinDesync` below — the caller
 * only ever uses it as a noun phrase, so "line" vs "lines" is the only agreement this needs to get
 * right, and it is decided directly from the count.
 */
function formatLineList(sites: readonly PinSite[]): string {
  const lines = [...new Set(sites.map((site) => site.line))].sort((a, b) => a - b);
  const label = lines.length === 1 ? "line" : "lines";
  if (lines.length <= 1) return `${label} ${String(lines[0] ?? "?")}`;
  const last = lines[lines.length - 1] ?? "?";
  return `${label} ${lines.slice(0, -1).join(", ")} and ${String(last)}`;
}

/**
 * Renders one desync as a finding-body paragraph in the shape `CATCH_ALL_RULE` prescribes (see
 * `src/engine/rule-file.test.ts`'s own examples): an imperative first line under 100 characters ending
 * in a period, a blank line, then two to four sentences of prose naming which sites moved, which sites
 * stayed behind, and the concrete cost of the split.
 *
 * Every dynamic value here is a 40-character hex string or a repository path — never markup, never a
 * mention, never a link — so backtick-wrapping each (after escaping any literal backtick or backslash
 * the path could contain) is always enough to keep it inert; nothing here needs the fuller escaping a
 * free-form identifier would.
 */
export function describePinDesync(desync: PinDesync, path: string): string {
  const movedText = formatLineList(desync.movedSites);
  const staleText = formatLineList(desync.staleSites);
  const safePath = escapeForCodeSpan(path);
  const safeValue = escapeForCodeSpan(desync.value);
  return [
    `Advance the pin this change left behind, so every site names the same commit again.`,
    "",
    `\`${safePath}\` names commit \`${safeValue}\` at more than one site, and this change moved ` +
      `the pin at ${movedText} to a new value while the pin at ${staleText} still carried the old ` +
      `one. Whichever site actually governs behavior at runtime, the reviewed commit and the ` +
      `executed commit are no longer guaranteed to be the same commit, and nothing in the diff ` +
      `makes that drift visible. Advance ${staleText} to match, or explain why it intentionally ` +
      `still pins the earlier commit.`,
  ].join("\n");
}
