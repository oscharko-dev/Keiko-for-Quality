/**
 * Bounded staged review: a risk planner followed by one core examiner and, only when deterministic
 * change facts justify it, one integration examiner. Everything a stage may consult is assembled
 * before its call; no model response can spawn an unbounded conversation.
 *
 * Why it exists, in this repository's own numbers: the agentic engine's per-file tool loop spent
 * 2,171,343 tokens against a 1,268,982-token allotment on the nine reviewable files of this
 * product's OWN pull request (#173) and still settled `coverage_gap` — twice, on consecutive
 * heads. A conversation that may spend thirty to sixty rounds per file cannot be budgeted from
 * file size, so the size-scaled allotment is structurally either overrun (cost) or under-covered
 * (quality). This workflow inverts that: every prompt and completion ceiling is known before it is
 * sent, every request reserves from one shared hard ledger, and there is no free-form loop to die
 * mid-file. Hunks carry absolute new-file line numbers, so no relocation call is needed.
 *
 * What it deliberately does NOT replace: everything downstream. The runner emits byte-compatible
 * engine stdout — `status` / `summary` / `tool_calls` / `comments` / `warnings` in exactly the
 * shape `result.ts` already parses — so settlement (incomplete-never-clean), classification
 * repair, sanitization, placement, dedup, the review store, and the report formats neither know
 * nor care which runner produced the review. A file whose mandatory examiner fails after its one retry becomes
 * an honest `subtask_error` warning, which is what `settle.ts` already reads as a coverage gap.
 *
 * Trust boundaries are unchanged: the diff and the context pack are candidate-trust data and are
 * framed as such; the model's reply is parsed by reject-rather-than-repair rules (strict JSON,
 * bounded sizes, paths overridden with the file under review the same way the engine's own loop
 * overrides hallucinated paths); credentials go only into the Authorization header of the one
 * configured endpoint.
 *
 * Gated behind `KFQ_SINGLE_SHOT=1` (the `OCR_ALLOW_MODEL_DEVIATION` escape-hatch pattern):
 * this mode is a different reviewer under the qualification contract — engine, rule text, and
 * model are a qualified PAIRING — so it must earn corpus, seed-gate, and completion-gate evidence
 * before any default flips.
 */

import { createHash, randomUUID } from "node:crypto";

import { sha256 } from "../core/brands.js";
import type { Diagnostics } from "../diagnostics/sink.js";
import { gitEnvironment, run } from "../git/exec.js";
import { readTextAtCommit } from "../git/plumbing.js";
import { readModelToken } from "../config/runtime.js";
import { buildRuleFile, serializeRuleFile } from "./rule-file.js";
import { companionsByPath } from "./companions.js";
import { buildWholeFileBlock, WHOLE_FILE_PROMPT } from "./whole-file-view.js";
import {
  CORE_ROLE,
  INTEGRATION_ROLE,
  buildExaminerPrompt,
  buildRiskPlannerPrompt,
  createGenerationLedger,
  fallbackRiskMap,
  parseRiskMap,
  parseStructuredClaims,
  renderStructuredClaim,
  requestGeneration,
  shouldRunIntegrationExaminer,
  type GenerationCallResult,
  type GenerationContext,
  type GenerationRequestLedger,
  type RiskHypothesis,
  type StagePrompt,
} from "./generation-workflow.js";
import { EngineRunError, type EngineRunOptions, type EngineRunOutput } from "./run.js";
import { SUPPORTED_MANIFEST_SCHEMA } from "./result.js";

/** Sampling pin, identical in value and rationale to `run.ts`. */
const DEFAULT_SEED = 42;

/** One bounded retry per file on transport-shaped failures (429/5xx/network). A 4xx is the
 *  request's own fault and retrying it verbatim buys nothing — the file becomes a warning. */
const RETRIES_PER_FILE = 1;

/** Per-companion and whole-block character budgets for the `<companion_changes>` section. The
 *  block exists to kill the one-sided-pair false-positive class (37 of 52 findings on the first
 *  live release PR), and three bounded hunks do that; a whole package's diffs would just re-crowd
 *  each staged prompt this bounded mode exists to keep small. */
const COMPANION_HUNK_CHARS = 1200;
const COMPANION_BLOCK_CHARS = 4000;

/** Distinct pinned seeds keep the two examiner roles reproducible without making them identical. */
const CORE_EXAMINER_SEED_OFFSET = 1000;
const INTEGRATION_EXAMINER_SEED_OFFSET = 2000;

/** Character budget for one file's rendered diff inside the prompt. Far above any reviewable
 *  hunk set, far below a generated-bundle flood; a diff past this bound is truncated with an
 *  explicit marker so the model knows it is not seeing the whole change. */
const MAX_DIFF_CHARS = 60_000;

interface FileDispatch {
  readonly path: string;
  readonly renderedDiff: string;
  /** Exact permitted claim end-lines, derived from the rendered patch rather than model output. */
  readonly allowedAnchors: readonly number[];
  /** Changed-line count of the raw fragment — the deterministic integration gate reads it. */
  readonly changedLines: number;
  /** The `<companion_changes>` block for this file, when it has companions — see `companions.ts`. */
  readonly companionBlock?: string;
  /**
   * The complete file with its changed lines marked — see `whole-file-view.ts` for why this is the
   * primary view and the hunks are the fallback.
   *
   * Absent means the file could not be shown whole (deleted, unreadable as a git object, or past
   * `MAX_REVIEW_FILE_CHARS`), and the examiners fall back to `renderedDiff`. Independent HEAD/BASE
   * truth verification runs after generation for every publication candidate either way.
   */
  readonly wholeFileBlock?: string;
}

interface EngineComment {
  readonly path: string;
  readonly content: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly category?: string;
  readonly severity?: string;
}

interface EngineWarningShape {
  readonly type: "subtask_error";
  readonly file: string;
  readonly message: string;
}

/**
 * One parsed unified-diff hunk, rendered PR-Agent style: `__new hunk__` carries every kept line
 * prefixed with its ABSOLUTE line number in the new file (additions marked `+`), `__old hunk__`
 * appears only when the hunk deletes anything and carries each removed line with its deletion
 * anchor. Mode and rename metadata is retained even when Git has no `+++` line or hunk. These
 * numbers are what let the model cite the publisher's exact anchor — no relocation or guessing.
 */
export function renderNumberedHunks(fileDiff: string): string {
  const lines = fileDiff.split("\n");
  const metadata = lines.filter((line) =>
    /^(?:old mode|new mode|deleted file mode|new file mode|similarity index|rename from|rename to)\b/u.test(
      line,
    ),
  );
  const out: string[] = metadata.length === 0 ? [] : ["__file metadata__", ...metadata];
  let newLine = 0;
  let oldLine = 0;
  let inHunk = false;
  let newBody: string[] = [];
  let oldBody: string[] = [];
  const flush = (): void => {
    if (newBody.length === 0 && oldBody.length === 0) return;
    out.push("__new hunk__", ...newBody);
    if (oldBody.length > 0) out.push("__old hunk__", ...oldBody);
    newBody = [];
    oldBody = [];
  };
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header !== null) {
      flush();
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // file header lines before the first hunk
    if (line.startsWith("+")) {
      newBody.push(`${String(newLine)} +${line.slice(1)}`);
      newLine += 1;
    } else if (line.startsWith("-")) {
      const anchor = newLine > 0 ? newLine : oldLine;
      oldBody.push(`${String(anchor)} -${line.slice(1)}`);
      oldLine += 1;
    } else if (line.startsWith(" ") || line === "") {
      newBody.push(`${String(newLine)}  ${line.slice(1)}`);
      newLine += 1;
      oldLine += 1;
    }
    // `\ No newline at end of file` and anything else: skipped, never counted.
  }
  flush();
  return out.join("\n");
}

function decodedGitPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  if (!trimmed.endsWith('"')) return undefined;
  const hasOctal = /\\[0-7]{3}/u.test(trimmed);
  const json = trimmed.replace(/\\([0-7]{3})/gu, (_match, octal: string) => {
    const hex = Number.parseInt(octal, 8).toString(16).padStart(2, "0");
    return `\\u00${hex}`;
  });
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "string") return undefined;
    return hasOctal ? Buffer.from(parsed, "latin1").toString("utf8") : parsed;
  } catch {
    return undefined;
  }
}

function withoutPatchPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function namedPath(part: string, marker: "---" | "+++" | "rename to"): string | undefined {
  const escaped = marker.replaceAll("+", "\\+");
  const raw = new RegExp(`^${escaped} (.+)$`, "mu").exec(part)?.[1];
  if (raw === undefined) return undefined;
  const decoded = decodedGitPath(raw);
  if (decoded === undefined) return undefined;
  return marker === "rename to" ? decoded : withoutPatchPrefix(decoded);
}

/** The same-path `diff --git a/x b/x` fallback used by hunkless mode changes. */
function samePathFromDiffHeader(part: string): string | undefined {
  const header = part.split("\n", 1)[0];
  if (header === undefined) return undefined;
  const quoted = /^("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")$/u.exec(header);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    const oldPath = decodedGitPath(quoted[1]);
    const newPath = decodedGitPath(quoted[2]);
    if (oldPath === undefined || newPath === undefined) return undefined;
    return withoutPatchPrefix(newPath);
  }
  let separator = header.indexOf(" b/");
  while (separator >= 0) {
    const oldPath = header.slice(2, separator);
    const newPath = header.slice(separator + 3);
    if (oldPath === newPath) return newPath;
    separator = header.indexOf(" b/", separator + 1);
  }
  return undefined;
}

function fragmentPath(part: string): string | undefined {
  const newPath = namedPath(part, "+++");
  if (newPath !== undefined && newPath !== "/dev/null") return newPath;
  const renamed = namedPath(part, "rename to");
  if (renamed !== undefined) return renamed;
  const oldPath = namedPath(part, "---");
  if (newPath === "/dev/null" && oldPath !== undefined) return oldPath;
  return samePathFromDiffHeader(part);
}

/** Splits one multi-file patch, retaining deletions and hunkless metadata changes. */
export function splitFileDiffs(diffText: string): ReadonlyMap<string, string> {
  const byPath = new Map<string, string>();
  const parts = diffText.split(/^diff --git /m).slice(1);
  for (const part of parts) {
    const path = fragmentPath(part);
    if (path === undefined) continue;
    byPath.set(path, part);
  }
  return byPath;
}

function renderedAnchors(renderedDiff: string): readonly number[] {
  const anchors = new Set<number>();
  for (const line of renderedDiff.split("\n")) {
    const anchor = /^(\d+) [+-]/u.exec(line)?.[1];
    if (anchor !== undefined) anchors.add(Number(anchor));
  }
  // A metadata-only change has no changed source line. Line 1 is an explicit, deterministic
  // metadata anchor; placement can fall back to a file comment when GitHub has no line-side rung.
  if (anchors.size === 0 && renderedDiff.includes("__file metadata__")) anchors.add(1);
  return [...anchors].sort((left, right) => left - right);
}

/** A positive integer, or `undefined` — the one numeric shape a line field may carry. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** A non-empty string, or `undefined` — `parseFindingEntry`'s one text shape. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** One reply entry as an engine comment, or `undefined` for any off-shape field — the per-entry
 *  half of `parseFindingsReply`, split out for its complexity budget. */
function parseFindingEntry(entry: unknown, path: string): EngineComment | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  const start = positiveInt(record.start_line);
  const end = positiveInt(record.end_line);
  const content = nonEmptyString(record.content);
  if (start === undefined || end === undefined || end < start || content === undefined) {
    return undefined;
  }
  const category = nonEmptyString(record.category);
  const severity = nonEmptyString(record.severity);
  return {
    // The reviewed path is authoritative, exactly as the engine's own loop overrides a
    // hallucinated `path` argument on `code_comment`.
    path,
    content,
    start_line: start,
    end_line: end,
    ...(category === undefined ? {} : { category }),
    ...(severity === undefined ? {} : { severity }),
  };
}

/** The fence a model wraps its JSON in when it cannot resist Markdown, and the language tag it
 *  most often puts on the opener. */
const FENCE = "```";
const FENCE_LANGUAGE = "json";

/**
 * The text inside a fence that wraps the WHOLE reply, or the trimmed reply when there is none.
 * Staged structured claims accept no fence; this remains only for the exported legacy-envelope
 * compatibility parser.
 *
 * A walk rather than the `^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$` it replaces, which Sonar reports
 * as super-linear (S8786): three whitespace-capable quantifiers in a row let one run of whitespace
 * decompose many ways, and the lazy middle re-scanned to the end of the reply once per candidate
 * closing run. Neither the accepted language nor the returned text changes, for two reasons worth
 * writing down. A closing run is admissible only when nothing but whitespace follows it to the end
 * of the reply, and at most one position in a string can satisfy that — a second would have to put
 * a backtick inside the first one's trailing whitespace — so the lazy scan's FIRST admissible run
 * and this trim-from-the-end's LAST one are the same run. And both callers trimmed the capture,
 * which is what makes the two `\s*` around it nothing this has to reproduce.
 */
function unfenceJson(reply: string): string {
  const opened = reply.trimStart();
  if (!opened.startsWith(FENCE)) return reply.trim();
  const afterFence = opened.slice(FENCE.length);
  const body = afterFence.startsWith(FENCE_LANGUAGE)
    ? afterFence.slice(FENCE_LANGUAGE.length)
    : afterFence;
  const closed = body.trimEnd();
  if (!closed.endsWith(FENCE)) return reply.trim();
  return closed.slice(0, -FENCE.length).trim();
}

/** Strict reply parsing: fences tolerated, everything else reject-rather-than-repair. */
export function parseFindingsReply(
  reply: string,
  path: string,
): readonly EngineComment[] | undefined {
  const text = unfenceJson(reply);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const comments: EngineComment[] = [];
  for (const entry of parsed) {
    const comment = parseFindingEntry(entry, path);
    if (comment === undefined) return undefined;
    comments.push(comment);
  }
  return comments;
}

/**
 * Intersects the inventory-owned dispatch contract with the fragments Git actually returned.
 *
 * This deliberately contains no profile/glob logic. `Inventory` already decided structural
 * cases that path matching alone cannot recover: deletion-critical paths are reviewable even
 * outside `reviewRelevant`, while matching binaries and submodule pointers are not. A second
 * classifier here silently substituted one changed path for another while preserving the weak
 * `files_reviewed` count. The manifest below records the identities as a second invariant; this
 * function only decides which expected paths have evidence available to send to a model.
 */
function dispatchPaths(options: EngineRunOptions, changedPaths: readonly string[]): string[] {
  const changed = new Set(changedPaths);
  return [...new Set(options.expectedReviewablePaths)].filter((path) => changed.has(path));
}

/** Same absolute review boundary the first attempt and every resume share. */
function remainingInvocationMs(options: EngineRunOptions, maximumMs: number): number {
  const remaining = Math.max(0, Math.trunc(options.reviewDeadlineMs - Date.now()));
  if (remaining === 0) throw new EngineRunError("engine.run.timeout");
  return Math.min(remaining, maximumMs);
}

async function gitDiff(options: EngineRunOptions): Promise<string | undefined> {
  const timeoutMs = remainingInvocationMs(options, 30_000);
  try {
    const result = await run(
      "git",
      [
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--submodule=short",
        `--find-renames=${String(options.config.renameDetectionPercent)}%`,
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=3",
        options.pair.mergeBase,
        options.pair.head,
      ],
      {
        cwd: options.repositoryPath,
        timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: gitEnvironment(options.pathValue),
      },
    );
    return result.stdout.toString("utf8");
  } catch {
    if (Date.now() >= options.reviewDeadlineMs) {
      throw new EngineRunError("engine.run.timeout");
    }
    return undefined;
  }
}

/** Bounded concurrency without a dependency: a worker pool over a shared cursor. */
async function inPool<T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

/** Everything the per-file workers share, assembled once per invocation. */
interface RunState {
  readonly options: EngineRunOptions;
  readonly token: string;
  readonly rule: string;
  readonly seed: number;
  readonly fetchImpl: typeof fetch;
  readonly ledger: GenerationRequestLedger;
  /** Absolute wall-clock deadline inherited from `reviewTimeoutSeconds`. */
  readonly reviewDeadlineMs: number;
  readonly comments: EngineComment[];
  readonly warnings: EngineWarningShape[];
  plannerFallbacks: number;
  coreExaminations: number;
  integrationExaminations: number;
}

/**
 * The `<companion_changes>` block for one file: its companions' numbered hunks, each and the whole
 * block bounded. Companions come from the FULL changed-path set (not just the rule-selected one) —
 * a version twin is a twin whether or not the profile reviews it — but only fragments the diff
 * actually carries can render.
 */
function companionBlockFor(
  companions: readonly string[],
  fragments: ReadonlyMap<string, string>,
): string | undefined {
  const sections: string[] = [];
  let used = 0;
  for (const companion of companions) {
    const fragment = fragments.get(companion);
    if (fragment === undefined) continue;
    const rendered = renderNumberedHunks(fragment);
    if (rendered === "") continue;
    const bounded =
      rendered.length > COMPANION_HUNK_CHARS
        ? `${rendered.slice(0, COMPANION_HUNK_CHARS)}\n(truncated)`
        : rendered;
    const section = `## ${companion}\n${bounded}`;
    if (used + section.length > COMPANION_BLOCK_CHARS) break;
    used += section.length;
    sections.push(section);
  }
  if (sections.length === 0) return undefined;
  return [
    "<companion_changes>",
    "Changes to related files from the SAME pull request, same numbered-hunk format. Consistency",
    "claims about these files are permitted exactly as far as these hunks show.",
    "",
    sections.join("\n\n"),
    "</companion_changes>",
  ].join("\n");
}

/**
 * The dispatch list: the rule-selected changed files, each with the complete file where that fits
 * and its bounded hunks either way.
 *
 * The file read is one hardened `cat-file blob` through `readTextAtCommit` per dispatched file —
 * no checkout and no model call. See `whole-file-view.ts` for the measurement that made the whole
 * file the primary examiner view.
 */
interface PreparedDispatches {
  readonly dispatches: readonly FileDispatch[];
  /** Expected inventory paths for which the exact base-to-head diff produced no fragment. */
  readonly missingPaths: readonly string[];
}

async function prepareDispatches(options: EngineRunOptions): Promise<PreparedDispatches> {
  const diffText = await gitDiff(options);
  if (diffText === undefined) throw new EngineRunError("engine.run.spawn_failed");
  const fragments = splitFileDiffs(diffText);
  const companions = companionsByPath([...fragments.keys()]);
  const paths = dispatchPaths(options, [...fragments.keys()]);
  const missingPaths = [...new Set(options.expectedReviewablePaths)].filter(
    (path) => !fragments.has(path),
  );
  const dispatches: FileDispatch[] = [];
  for (const path of paths) {
    const fragment = fragments.get(path) ?? "";
    const rendered = renderNumberedHunks(fragment);
    const bounded =
      rendered.length > MAX_DIFF_CHARS
        ? `${rendered.slice(0, MAX_DIFF_CHARS)}\n(truncated: diff exceeds the prompt budget)`
        : rendered;
    const companionBlock = companionBlockFor(companions.get(path) ?? [], fragments);
    const changedLines = fragment
      .split("\n")
      .filter((line) => /^[+-][^+-]/.test(line) || line === "+" || line === "-").length;
    const text = await headFileText(options, path);
    const whole = text === undefined ? undefined : buildWholeFileBlock(text, fragment);
    const anchorSource = whole === undefined ? bounded : rendered;
    dispatches.push({
      path,
      renderedDiff: bounded,
      allowedAnchors: renderedAnchors(anchorSource),
      changedLines,
      ...(companionBlock === undefined ? {} : { companionBlock }),
      ...(whole === undefined ? {} : { wholeFileBlock: whole.block }),
    });
  }
  return { dispatches, missingPaths };
}

function generationContext(state: RunState, dispatch: FileDispatch): GenerationContext {
  const pack = state.options.contextPacks?.get(dispatch.path);
  const applicablePathRules = state.options.profile.pathInstructions
    .filter((entry) => entry.matcher.matches(dispatch.path))
    .map((entry) => entry.instructions);
  return {
    path: dispatch.path,
    renderedDiff: dispatch.renderedDiff,
    allowedAnchors: dispatch.allowedAnchors,
    changedLines: dispatch.changedLines,
    ...(dispatch.companionBlock === undefined ? {} : { companionBlock: dispatch.companionBlock }),
    ...(pack === undefined ? {} : { contextPack: pack }),
    ...(applicablePathRules.length === 0 ? {} : { applicablePathRules }),
    ...(state.options.changeIntent === undefined
      ? {}
      : { changeIntent: state.options.changeIntent }),
    ...(state.options.trustedGuidance === undefined
      ? {}
      : { trustedGuidance: state.options.trustedGuidance }),
  };
}

function metadataEvidence(renderedDiff: string): string | undefined {
  if (!renderedDiff.startsWith("__file metadata__")) return undefined;
  const hunkStart = renderedDiff.indexOf("\n__new hunk__");
  return hunkStart < 0 ? renderedDiff : renderedDiff.slice(0, hunkStart);
}

function evidenceView(dispatch: FileDispatch): string {
  if (dispatch.wholeFileBlock !== undefined) {
    const metadata = metadataEvidence(dispatch.renderedDiff);
    return [
      dispatch.wholeFileBlock,
      ...(metadata === undefined
        ? []
        : ["", "<current_file_metadata>", metadata, "</current_file_metadata>"]),
      "",
      WHOLE_FILE_PROMPT,
    ].join("\n");
  }
  return ["<current_file_diff>", dispatch.renderedDiff, "</current_file_diff>"].join("\n");
}

/** One transport retry at most. Every attempt performs its own atomic ledger preflight. */
async function callStage(
  state: RunState,
  prompt: StagePrompt,
  seed: number,
): Promise<GenerationCallResult> {
  let result: GenerationCallResult = { kind: "invalid_response" };
  for (let attempt = 0; attempt <= RETRIES_PER_FILE; attempt += 1) {
    const remainingReviewMs = state.reviewDeadlineMs - Date.now();
    if (remainingReviewMs <= 0) return { kind: "transport_failure" };
    result = await requestGeneration(
      {
        endpoint: state.options.config.endpoint,
        token: state.token,
        model: state.options.config.model,
        seed,
        system: prompt.system,
        user: prompt.user,
        timeoutMs: Math.min(state.options.config.fileTimeoutSeconds * 1_000, remainingReviewMs),
      },
      state.ledger,
      state.fetchImpl,
    );
    if (result.kind !== "transport_failure") return result;
  }
  return result;
}

function warnExaminer(state: RunState, path: string, role: string): void {
  state.warnings.push({
    type: "subtask_error",
    file: path,
    message: `single_shot ${role} examiner failed`,
  });
}

async function planRisks(
  state: RunState,
  context: GenerationContext,
): Promise<readonly RiskHypothesis[]> {
  const result = await callStage(state, buildRiskPlannerPrompt(state.rule, context), state.seed);
  if (result.kind === "success") {
    const parsed = parseRiskMap(result.content, new Set(context.allowedAnchors));
    if (parsed !== undefined) return parsed;
  }
  state.plannerFallbacks += 1;
  return fallbackRiskMap(context.renderedDiff);
}

async function examine(
  state: RunState,
  dispatch: FileDispatch,
  context: GenerationContext,
  risks: readonly RiskHypothesis[],
  role: typeof CORE_ROLE | typeof INTEGRATION_ROLE,
  seedOffset: number,
): Promise<readonly EngineComment[] | undefined> {
  const prompt = buildExaminerPrompt(role, context, risks, { view: evidenceView(dispatch) });
  const result = await callStage(state, prompt, state.seed + seedOffset);
  if (result.kind !== "success") return undefined;
  const claims = parseStructuredClaims(result.content, new Set(dispatch.allowedAnchors));
  if (claims === undefined) return undefined;
  return claims.map((claim) => renderStructuredClaim(dispatch.path, claim));
}

/**
 * One file's bounded workflow. Planner failure falls back to fixed lenses; a mandatory examiner
 * failure names the file and makes settlement incomplete. No model response can spawn a fourth
 * generation role.
 */
async function reviewOneFile(state: RunState, dispatch: FileDispatch): Promise<void> {
  const context = generationContext(state, dispatch);
  const risks = await planRisks(state, context);
  const core = await examine(state, dispatch, context, risks, CORE_ROLE, CORE_EXAMINER_SEED_OFFSET);
  if (core === undefined) {
    warnExaminer(state, dispatch.path, CORE_ROLE);
    return;
  }
  state.coreExaminations += 1;

  let combined = core;
  if (shouldRunIntegrationExaminer(context)) {
    const integration = await examine(
      state,
      dispatch,
      context,
      risks,
      INTEGRATION_ROLE,
      INTEGRATION_EXAMINER_SEED_OFFSET,
    );
    if (integration === undefined) {
      warnExaminer(state, dispatch.path, INTEGRATION_ROLE);
    } else {
      state.integrationExaminations += 1;
      combined = unionComments(core, integration);
    }
  }
  state.comments.push(...combined);
}

/** The file at the reviewed head, read as a Git object — never from a checkout. */
async function headFileText(options: EngineRunOptions, path: string): Promise<string | undefined> {
  const timeoutMs = remainingInvocationMs(options, 30_000);
  try {
    return await readTextAtCommit(
      {
        cwd: options.repositoryPath,
        timeoutMs,
        pathValue: options.pathValue,
      },
      options.pair.head,
      path,
    );
  } catch {
    if (Date.now() >= options.reviewDeadlineMs) {
      throw new EngineRunError("engine.run.timeout");
    }
    return undefined;
  }
}

/** First-pass findings win; an integration finding joins only when no core finding already
 *  sits on the same lines saying effectively the same thing. */
function unionComments(
  first: readonly EngineComment[],
  second: readonly EngineComment[],
): readonly EngineComment[] {
  const normalize = (text: string): string =>
    text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
  const seen = new Set(
    first.map((c) => `${String(c.start_line)}:${String(c.end_line)}:${normalize(c.content)}`),
  );
  const merged = [...first];
  for (const comment of second) {
    const key = `${String(comment.start_line)}:${String(comment.end_line)}:${normalize(comment.content)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(comment);
  }
  return merged;
}

/** One exact-path coverage partition for the staged runner's v1 run manifest. */
function coverageEntries(paths: Iterable<string>): readonly { readonly path: string }[] {
  return [...paths].map((path) => ({ path }));
}

/**
 * The engine-shaped stdout plus an exact v1 coverage manifest.
 *
 * Unlike the released agentic engine, this runner owns every dispatch and can name it. Publishing
 * only `files_reviewed` here would throw that stronger evidence away and let an unexpected extra
 * path mask an expected missing path by cardinality. `selected` is the inventory contract;
 * `completed` and `failed` are disjoint identities measured by this invocation.
 */
function assembleStdout(
  state: RunState,
  dispatches: readonly FileDispatch[],
  startedMs: number,
): string {
  const selected = [...new Set(state.options.expectedReviewablePaths)];
  const failed = new Set(state.warnings.map((warning) => warning.file));
  const completed = dispatches.map((dispatch) => dispatch.path).filter((path) => !failed.has(path));
  return JSON.stringify({
    status: state.warnings.length === 0 ? "success" : "completed_with_errors",
    summary: {
      files_reviewed: dispatches.length,
      comments: state.comments.length,
      total_tokens: state.ledger.spent,
      input_tokens: state.ledger.prompt,
      output_tokens: state.ledger.completion,
      elapsed: `${String(Math.max(1, Math.round((Date.now() - startedMs) / 1000)))}s`,
    },
    tool_calls: { total: 0, by_tool: {} },
    comments: state.comments,
    warnings: state.warnings,
    manifest: {
      schema_version: SUPPORTED_MANIFEST_SCHEMA,
      terminal_state: failed.size === 0 ? "complete" : "partial",
      coverage: {
        selected: coverageEntries(selected),
        completed: coverageEntries(completed),
        reused: [],
        failed: coverageEntries(failed),
        waived: [],
      },
    },
    session_id: randomUUID(),
  });
}

/** The shared per-invocation state, assembled once — split from the runner for its line budget. */
function initialRunState(
  options: EngineRunOptions,
  rule: string,
  fetchImpl: typeof fetch,
  token: string,
): RunState {
  return {
    options,
    token,
    rule,
    seed: options.samplingSeed ?? DEFAULT_SEED,
    fetchImpl,
    ledger: createGenerationLedger(options.allottedBudget),
    reviewDeadlineMs: options.reviewDeadlineMs,
    comments: [],
    warnings: [],
    plannerFallbacks: 0,
    coreExaminations: 0,
    integrationExaminations: 0,
  };
}

/** Missing diff fragments are named failures, never silently omitted from the run's manifest. */
function warnMissingDispatches(state: RunState, paths: readonly string[]): void {
  for (const path of paths) {
    state.warnings.push({
      type: "subtask_error",
      file: path,
      message: "single_shot expected diff fragment missing",
    });
  }
}

function requireCompletedBeforeDeadline(
  options: EngineRunOptions,
  state: RunState,
  diagnostics: Diagnostics,
  started: number,
): void {
  if (Date.now() < options.reviewDeadlineMs) return;
  diagnostics.record("engine.run.timeout", {
    headSha: options.pair.head,
    durationMs: Date.now() - started,
  });
  throw new EngineRunError("engine.run.timeout", state.ledger.spent);
}

async function reviewDispatchPool(
  state: RunState,
  dispatches: readonly FileDispatch[],
): Promise<void> {
  await inPool(dispatches, state.options.config.concurrency, (dispatch) =>
    reviewOneFile(state, dispatch),
  );
}

/**
 * Runs one single-shot review over the same contract as `runEngine`: identical options, identical
 * output shape (engine-compatible stdout JSON plus wire-counted spend), identical failure
 * vocabulary — a missing token is the same `spawn_failed` it is on the engine path, and a file
 * that fails its call plus retry is an honest `subtask_error` the settlement already knows how to
 * read as a coverage gap. `fetchImpl` exists for the tests; production callers pass nothing.
 */
export async function runSingleShotEngine(
  options: EngineRunOptions,
  diagnostics: Diagnostics,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineRunOutput> {
  remainingInvocationMs(options, options.config.reviewTimeoutSeconds * 1_000);
  const token = readModelToken(options.config, options.env);
  if (token === undefined) throw new EngineRunError("engine.run.spawn_failed");
  const started = Date.now();
  const ruleFile = buildRuleFile(
    options.profile,
    options.guidelines,
    options.mechanicallyCleanPaths,
  );
  const ruleDocument = serializeRuleFile(ruleFile);
  const ruleDigest = sha256(createHash("sha256").update(ruleDocument).digest("hex"));

  const prepared = await prepareDispatches(options);
  const dispatches = prepared.dispatches;
  const state = initialRunState(options, ruleDocument, fetchImpl, token);
  warnMissingDispatches(state, prepared.missingPaths);
  await reviewDispatchPool(state, dispatches);

  requireCompletedBeforeDeadline(options, state, diagnostics, started);

  const stdout = assembleStdout(state, dispatches, started);
  diagnostics.record("engine.run.completed", {
    headSha: options.pair.head,
    digest: ruleDigest,
    durationMs: Date.now() - started,
    counts: { bytes: Buffer.byteLength(stdout, "utf8"), budget: options.allottedBudget },
  });
  diagnostics.record("model.usage", {
    headSha: options.pair.head,
    counts: {
      requests: state.ledger.requests,
      prompt: state.ledger.prompt,
      completion: state.ledger.completion,
      unreported_usage: state.ledger.unreported,
      budget_blocked: state.ledger.budgetBlocked,
      cached: 0,
      context_pack_injected: dispatches.filter((dispatch) =>
        options.contextPacks?.has(dispatch.path),
      ).length,
      planner_fallbacks: state.plannerFallbacks,
      core_examinations: state.coreExaminations,
      integration_examinations: state.integrationExaminations,
      cache_key_rejected: 0,
      bad_request_persisted: 0,
    },
  });
  return { stdout, ruleDigest, wireTokens: state.ledger.spent };
}
