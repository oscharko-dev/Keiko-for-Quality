import { repoPath, type RepoPath } from "../core/brands.js";
import { FINDING_CATEGORIES, FINDING_SEVERITIES } from "../engine/classify.js";
import { LIMITS as ENGINE_RESULT_LIMITS, type EngineFinding } from "../engine/result.js";

/**
 * The change-level pass (issue #80, technique C): ONE bounded, cross-file model call per run.
 *
 * Per-file review cannot see a contract broken across files — the producer half of a change can
 * look correct in isolation while the separately-declared consumer half silently stops covering
 * it. Techniques A/B/D (counterpart retrieval, declared pairs, structural gates) all resolve a
 * SPECIFIC counterpart for a SPECIFIC file; this is the one technique that can catch a pair nobody
 * declared, by asking one question over a summary of every changed file's exported shape at once.
 *
 * This module is a PROTOTYPE. It ships dark: `RuntimeConfig.crossArtifactPass` defaults to
 * `false`, and wiring it into the actual review flow — deciding when in the run this call happens,
 * what "every changed file" means once the store replays some of them, folding its findings into
 * the published set — is the orchestrator's job, not this module's. What lives here is pure: build
 * a bounded summary, build the one prompt, make the one call, validate what comes back. Promotion
 * out of "dark" depends on a later qualification-corpus measurement (issue #80's technique E),
 * never on this module's own say-so.
 *
 * Redaction: the declaration summary is repository source text. It goes into the model request
 * body and nowhere else — this module never touches the diagnostics sink and never logs, so a
 * summary or a raw model reply can never reach an operator log or a thrown error message.
 */

/** One changed file, reduced to what this module needs: its path and its full source text. */
export interface ChangedFile {
  readonly path: string;
  readonly source: string;
}

// ---------------------------------------------------------------------------------------------
// Hard bounds. Every one of these exists for the same reason: this pass is ONE bounded model call,
// never a second unbounded context window standing next to the per-file review. Each is enforced
// deterministically, not best-effort, and each is commented individually below.
// ---------------------------------------------------------------------------------------------

/**
 * At most this many changed files are represented at all. A pull request touching more still gets
 * a bounded, honest partial summary — the files beyond this count are dropped from the END of the
 * given list, exactly like the char-budget drop below, and both drops are reported through the
 * same `[truncated: N more files]` note so the reader sees one number, not two.
 */
const MAX_FILES = 40;

/**
 * At most this many declarations are kept per file. Exceeding this does NOT drop the file — only
 * its trailing declarations, noted with `[truncated: N more declarations]` inside that file's own
 * block. A file with 40 exported declarations still contributes its first 30; it is not silently
 * dropped the way an entire file is under the two bounds above and below.
 */
const MAX_DECLARATIONS_PER_FILE = 30;

/**
 * The assembled summary text — every kept file block plus the truncation note, if any — never
 * exceeds this many characters. Enforced by dropping whole file blocks from the end of the list
 * until it fits, never by truncating one file's content mid-declaration: what survives is always a
 * set of COMPLETE file summaries, never a half-written one.
 */
const MAX_SUMMARY_CHARS = 6000;

/**
 * A type alias's right-hand side is kept only up to this many characters — long enough to show the
 * shape (a union's members, an object type's outline), short enough that one sprawling alias
 * cannot crowd out every other file's declarations under the summary-wide bound above.
 */
const MAX_TYPE_ALIAS_CHARS = 200;

/**
 * A cross-file pass surfacing more than this many contract breaks in one run is noise by
 * construction, not signal — ten genuine cross-file findings would already dwarf a typical
 * per-file review's own output for one pull request. The excess is capped, not trusted wholesale.
 */
const MAX_PASS_FINDINGS = 10;

/**
 * Safety valve for the line-scanning extractors below, distinct from the three product bounds
 * above: it bounds how far a single declaration's tolerant scan looks before giving up and
 * treating the declaration as unparseable, so a file with an unbalanced brace (or one that is not
 * TypeScript at all) can never make the scan run away across the rest of the file.
 */
const SCAN_WINDOW = 400;

// ---------------------------------------------------------------------------------------------
// Tolerant line-scanning declaration extraction.
//
// This is deliberately NOT a TypeScript parser — the product carries zero runtime dependencies, so
// there is no compiler API on hand, and a hand-rolled parser would be its own large surface to get
// wrong. Instead this leans on the same tolerance the shape-gate applies: a small set of regexes
// recognise where an exported declaration STARTS, a bracket-depth scan finds where it ends, and
// anything that does not fit — an exotic export form, an unbalanced brace, a declaration the scan
// window cuts off — is skipped silently rather than guessed at. The worst case is a declaration
// missing from the summary, never a crash or an unbounded scan.
// ---------------------------------------------------------------------------------------------

const INTERFACE_START = /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/;
const TYPE_ALIAS_START = /^\s*export\s+type\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/;
const FUNCTION_START = /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const CONST_START = /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*:\s*(.+)$/;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

/** Joins a bounded window of lines back into one string, `\n`-separated, for character-level scans. */
function collapseForScan(lines: readonly string[], start: number, window: number): string {
  return lines.slice(start, Math.min(lines.length, start + window)).join("\n");
}

/** How many source lines a scanned span (as produced by `collapseForScan`) covers. */
function linesConsumed(text: string): number {
  return text.split("\n").length;
}

/**
 * Index of the `closeChar` that balances the `openChar` already consumed one position before
 * `fromIndex` (the caller has already seen depth reach 1). Returns `undefined` — unparseable,
 * skipped silently — if the text never rebalances within its (already window-bounded) length.
 */
function findMatchingClose(
  text: string,
  fromIndex: number,
  openChar: string,
  closeChar: string,
): number | undefined {
  let depth = 1;
  for (let i = fromIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) depth -= 1;
    if (depth === 0) return i;
  }
  return undefined;
}

/** First top-level `;` from `fromIndex` — nested `{}`/`()`/`[]` are skipped over, not stopped at. */
function findStatementEnd(text: string, fromIndex: number): number | undefined {
  let depth = 0;
  for (let i = fromIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === ";" && depth <= 0) return i;
  }
  return undefined;
}

/** First `{` or `;` from `fromIndex` — the start of a function body, or an ambient declaration's end. */
function findSignatureBodyStart(text: string, fromIndex: number): number | undefined {
  for (let i = fromIndex; i < text.length; i += 1) {
    if (text[i] === "{" || text[i] === ";") return i;
  }
  return undefined;
}

/** Strips comment-only lines from an interface body and collapses the rest to one flat line. */
function cleanDeclarationBody(body: string): string {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isCommentLine(line))
    .join(" ")
    .replace(/[;,]\s*$/, "");
}

interface Extracted {
  readonly text: string;
  readonly endIndex: number;
}

function tryExtractInterface(lines: readonly string[], i: number): Extracted | undefined {
  const line = lines[i] ?? "";
  const match = INTERFACE_START.exec(line);
  if (match === null || !line.includes("{")) return undefined;
  const name = match[1] ?? "";
  const window = collapseForScan(lines, i, SCAN_WINDOW);
  const openAt = window.indexOf("{");
  if (openAt === -1) return undefined;
  const closeAt = findMatchingClose(window, openAt + 1, "{", "}");
  if (closeAt === undefined) return undefined;
  const body = cleanDeclarationBody(window.slice(openAt + 1, closeAt));
  const endIndex = i + linesConsumed(window.slice(0, closeAt + 1));
  return { text: `interface ${name} { ${body} }`, endIndex };
}

function tryExtractTypeAlias(lines: readonly string[], i: number): Extracted | undefined {
  const line = lines[i] ?? "";
  const match = TYPE_ALIAS_START.exec(line);
  if (match === null) return undefined;
  const name = match[1] ?? "";
  const window = collapseForScan(lines, i, SCAN_WINDOW);
  const eqAt = window.indexOf("=");
  if (eqAt === -1) return undefined;
  const termAt = findStatementEnd(window, eqAt + 1);
  const rhsRaw = window.slice(eqAt + 1, termAt ?? window.length);
  const rhs = collapseWhitespace(rhsRaw).slice(0, MAX_TYPE_ALIAS_CHARS);
  const consumed = termAt === undefined ? window : window.slice(0, termAt + 1);
  return { text: `type ${name} = ${rhs}`, endIndex: i + linesConsumed(consumed) };
}

function tryExtractFunction(lines: readonly string[], i: number): Extracted | undefined {
  const line = lines[i] ?? "";
  const match = FUNCTION_START.exec(line);
  if (match === null || !line.includes("(")) return undefined;
  const window = collapseForScan(lines, i, SCAN_WINDOW);
  const openAt = window.indexOf("(");
  const paramCloseAt = findMatchingClose(window, openAt + 1, "(", ")");
  if (paramCloseAt === undefined) return undefined;
  const bodyAt = findSignatureBodyStart(window, paramCloseAt + 1);
  if (bodyAt === undefined) return undefined;
  const raw = window.slice(0, bodyAt).replace(/^\s*export\s+/, "");
  const endIndex = i + linesConsumed(window.slice(0, bodyAt + 1));
  return { text: collapseWhitespace(raw), endIndex };
}

function tryExtractConst(lines: readonly string[], i: number): Extracted | undefined {
  const line = lines[i] ?? "";
  const match = CONST_START.exec(line);
  if (match === null) return undefined;
  const name = match[1] ?? "";
  const rest = match[2] ?? "";
  const eqAt = rest.indexOf("=");
  const typeText = collapseWhitespace(eqAt === -1 ? rest : rest.slice(0, eqAt));
  if (typeText.length === 0) return undefined;
  return { text: `const ${name}: ${typeText}`, endIndex: i + 1 };
}

function tryExtractOne(lines: readonly string[], i: number): Extracted | undefined {
  return (
    tryExtractInterface(lines, i) ??
    tryExtractTypeAlias(lines, i) ??
    tryExtractFunction(lines, i) ??
    tryExtractConst(lines, i)
  );
}

/** One file's exported declaration signatures, capped at `MAX_DECLARATIONS_PER_FILE`. */
function extractDeclarations(source: string): { texts: string[]; overflow: number } {
  const lines = source.split("\n");
  const found: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const result = tryExtractOne(lines, i);
    if (result === undefined) {
      i += 1;
      continue;
    }
    found.push(result.text);
    i = result.endIndex;
  }
  return {
    texts: found.slice(0, MAX_DECLARATIONS_PER_FILE),
    overflow: Math.max(0, found.length - MAX_DECLARATIONS_PER_FILE),
  };
}

function buildFileBlock(path: string, texts: readonly string[], overflow: number): string {
  const declLines = texts.map((t) => `  ${t}`);
  if (overflow > 0) declLines.push(`  [truncated: ${String(overflow)} more declarations]`);
  return `${path}\n${declLines.join("\n")}`;
}

function assembleSummary(blocks: readonly string[], dropped: number): string {
  const note = dropped > 0 ? `\n\n[truncated: ${String(dropped)} more files]` : "";
  return blocks.join("\n\n") + note;
}

/** Drops whole file blocks from the end until the assembled text fits `MAX_SUMMARY_CHARS`. */
function trimToCharBudget(blocks: string[], alreadyDropped: number): string {
  let dropped = alreadyDropped;
  let text = assembleSummary(blocks, dropped);
  while (text.length > MAX_SUMMARY_CHARS && blocks.length > 0) {
    blocks.pop();
    dropped += 1;
    text = assembleSummary(blocks, dropped);
  }
  return text;
}

/**
 * Summarizes every changed file's exported declaration signatures into one bounded block of text,
 * suitable for embedding directly in `buildChangePassPrompt`. Empty input (or input that yields no
 * recognisable exported declaration anywhere) returns `""` exactly — the empty string is
 * `runChangePass`'s signal to skip the model call entirely rather than send an empty question.
 */
export function summarizeDeclarations(files: readonly ChangedFile[]): string {
  if (files.length === 0) return "";
  const considered = files.slice(0, MAX_FILES);
  const droppedForFileCap = files.length - considered.length;

  const blocks: string[] = [];
  for (const file of considered) {
    const { texts, overflow } = extractDeclarations(file.source);
    if (texts.length === 0) continue;
    blocks.push(buildFileBlock(file.path, texts, overflow));
  }

  return trimToCharBudget(blocks, droppedForFileCap);
}

// ---------------------------------------------------------------------------------------------
// Prompt.
// ---------------------------------------------------------------------------------------------

/**
 * The fixed instructional text — everything in the prompt EXCEPT the summary itself, which varies
 * per run. This is what "≤ 1,200 chars" bounds: the summary already carries its own 6,000-char
 * bound above, so the combined prompt is bounded by the sum of the two, not by this constant
 * alone. Kept short because it rides on every single pass invocation.
 */
const INSTRUCTIONS = [
  "You see only declaration summaries of every file changed in one pull request. Report ONLY",
  "cross-file contract breaks visible at declaration level: a producer shape a separately-",
  "declared consumer twin no longer covers, a union member no consumer branch mentions, mirrored",
  "declarations that drifted.",
  `For each: JSON object per line {"path": consumer-file, "start_line": 0, "end_line": 0,`,
  `"category": "bug", "severity": "high", "content": ...} — content: imperative first line under`,
  "100 chars ending in a period, blank line, 2-4 sentences naming BOTH files and the exact",
  "member/case.",
  "If nothing qualifies, reply exactly []. Never report style, speculation, or anything",
  "decidable inside a single file.",
].join("\n");

export function buildChangePassPrompt(summary: string): string {
  return `${INSTRUCTIONS}\n\n${summary}`;
}

// ---------------------------------------------------------------------------------------------
// Transport — mirrors `classify.ts`'s `requestPair` shape exactly: same endpoint join, same
// pinned temperature/seed, same generous completion budget, same try/catch-to-empty-result
// failure handling. `classify.ts` has no timeout/abort logic to mirror, so neither does this.
// ---------------------------------------------------------------------------------------------

export interface ChangePassDeps {
  readonly endpoint: string;
  readonly token: string;
  readonly model: string;
  /** Injection point for tests; production uses the platform fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface ChangePassOutcome {
  readonly findings: readonly EngineFinding[];
  readonly tokens: number;
}

interface TransportResult {
  readonly content: string;
  readonly tokens: number;
}

async function postChangePassRequest(
  prompt: string,
  deps: ChangePassDeps,
): Promise<TransportResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${deps.endpoint.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.token}`,
      },
      body: JSON.stringify({
        model: deps.model,
        messages: [{ role: "user", content: prompt }],
        // Pinned exactly like classify.ts's own requestPair: reproducible run to run, and a
        // completion budget generous enough that a reasoning model's pre-answer tokens never
        // starve the actual JSON reply.
        temperature: 0,
        seed: 42,
        max_completion_tokens: 4000,
      }),
    });
    if (!response.ok) return { content: "", tokens: 0 };
    const body = (await response.json()) as {
      choices?: readonly { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    return {
      content: body.choices?.[0]?.message?.content ?? "",
      tokens: body.usage?.total_tokens ?? 0,
    };
  } catch {
    // A thrown fetch is a failed call, not a crash: the review this pass rides on top of already
    // has its own findings in hand, and this pass contributing nothing must never take it down.
    return { content: "", tokens: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// Reply parsing and candidate validation.
// ---------------------------------------------------------------------------------------------

function tryParseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function flattenCandidate(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Mirrors `classify.ts`'s `extractObject`: search from the LAST `{` backward, expand `}` forward,
 * first valid parse wins. `classify.ts`'s version is private, so this is the same technique
 * re-implemented here rather than imported — restricted to one line, since the outer caller
 * already scans line by line.
 */
function extractEmbeddedObject(line: string): unknown {
  let start = line.lastIndexOf("{");
  while (start !== -1) {
    for (let end = line.indexOf("}", start); end !== -1; end = line.indexOf("}", end + 1)) {
      const parsed = tryParseJsonValue(line.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
    }
    if (start === 0) break;
    start = line.lastIndexOf("{", start - 1);
  }
  return undefined;
}

/**
 * Tolerant parse of the pass's reply. The prompt asks for one JSON object per line, or the literal
 * `[]`, but nothing enforces a model actually complies. This tries the whole reply as one JSON
 * value first (a model that answers with a single compact array instead of one-per-line is still
 * read correctly, and `[]` is simply the empty-array case of this same path). Failing that, it
 * falls back to a per-line scan so leading prose or interspersed commentary does not take the real
 * findings down with it: a line that parses on its own contributes directly, and a line that does
 * not is searched for one embedded object before being given up on as prose.
 */
function extractJsonCandidates(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const whole = tryParseJsonValue(trimmed);
  if (whole !== undefined) return flattenCandidate(whole);

  const out: unknown[] = [];
  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parsed = tryParseJsonValue(line);
    if (parsed !== undefined) {
      out.push(...flattenCandidate(parsed));
      continue;
    }
    const embedded = extractEmbeddedObject(line);
    if (embedded !== undefined) out.push(embedded);
  }
  return out;
}

function validatePath(value: unknown): RepoPath | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return repoPath(value, "change-pass.path");
  } catch {
    return undefined;
  }
}

function validateContent(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > ENGINE_RESULT_LIMITS.maxBodyChars) return undefined;
  return value;
}

function validateVocabulary(value: unknown, vocabulary: readonly string[]): string | undefined {
  return typeof value === "string" && vocabulary.includes(value) ? value : undefined;
}

/**
 * Validates one candidate through the same bounds `result.ts` applies to every engine finding:
 * `repoPath`'s path shape, `maxBodyChars`' content length, and `classify.ts`'s closed category
 * and severity vocabularies — imported, never restated. An invalid candidate is dropped, not
 * repaired: reject-rather-than-repair applies to this pass exactly as it does to the engine's own
 * output.
 */
function validateCandidate(candidate: unknown): EngineFinding | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const raw = candidate as Record<string, unknown>;
  const path = validatePath(raw.path);
  const content = validateContent(raw.content);
  const category = validateVocabulary(raw.category, FINDING_CATEGORIES);
  const severity = validateVocabulary(raw.severity, FINDING_SEVERITIES);
  if (
    path === undefined ||
    content === undefined ||
    category === undefined ||
    severity === undefined
  ) {
    return undefined;
  }
  // Anchored at (0, 0) deliberately: a cross-file contract break has no single "the" line inside
  // the consumer file, so this pass never claims one. Downstream, the publisher's file-level
  // placement rung — not this module's concern — is what turns an anchorless finding into a real
  // review comment.
  return { path, content, startLine: 0, endLine: 0, category, severity };
}

/**
 * Runs the one bounded cross-file pass for a run: summarizes every given file's exported
 * declarations, asks the one question, and returns validated findings plus the tokens spent.
 *
 * Never throws. A summary that ends up empty (no files, or no file with a recognisable exported
 * declaration) short-circuits before any call is made — the zero-transport path a caller can rely
 * on when deciding whether this pass is worth invoking at all. Every other failure — a thrown
 * fetch, a non-OK response, a reply that never parses — settles as zero findings rather than a
 * rejected promise, so this pass can never take down the review it rides on top of.
 */
export async function runChangePass(
  files: readonly ChangedFile[],
  deps: ChangePassDeps,
): Promise<ChangePassOutcome> {
  const summary = summarizeDeclarations(files);
  if (summary === "") return { findings: [], tokens: 0 };

  const result = await postChangePassRequest(buildChangePassPrompt(summary), deps);
  const findings = extractJsonCandidates(result.content)
    .map(validateCandidate)
    .filter((f): f is EngineFinding => f !== undefined)
    .slice(0, MAX_PASS_FINDINGS);
  return { findings, tokens: result.tokens };
}
