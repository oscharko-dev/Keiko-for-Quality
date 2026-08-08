/**
 * Single-shot review: one model call per file, everything the model may consult assembled BEFORE
 * the call — the architecture Qodo's PR-Agent (MIT) ships, grafted onto this product's own
 * hardened pipeline instead of replacing it.
 *
 * Why it exists, in this repository's own numbers: the agentic engine's per-file tool loop spent
 * 2,171,343 tokens against a 1,268,982-token allotment on the nine reviewable files of this
 * product's OWN pull request (#173) and still settled `coverage_gap` — twice, on consecutive
 * heads. A conversation that may spend thirty to sixty rounds per file cannot be budgeted from
 * file size, so the size-scaled allotment is structurally either overrun (cost) or under-covered
 * (quality). One call per file inverts that: the prompt is fully known before it is sent, so the
 * spend per file is bounded by construction, and there is no loop to die mid-file — completion
 * stops being a hoped-for property of a conversation and becomes an arithmetic property of a
 * request. The same shape also deletes two whole classes of paid calls the loop needed: search
 * rounds (the context pack IS the repository view) and the engine's `RE_LOCATION_TASK` (hunks are
 * rendered with absolute new-file line numbers, so the model cites real lines directly — the
 * PR-Agent technique, and their stated reason for it: "we always present __new hunk__ for
 * section, otherwise LLM gets confused").
 *
 * What it deliberately does NOT replace: everything downstream. The runner emits byte-compatible
 * engine stdout — `status` / `summary` / `tool_calls` / `comments` / `warnings` in exactly the
 * shape `result.ts` already parses — so settlement (incomplete-never-clean), classification
 * repair, sanitization, placement, dedup, the review store, and the report formats neither know
 * nor care which runner produced the review. A file whose call fails after its one retry becomes
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

import { sha256, type Sha256 } from "../core/brands.js";
import type { Diagnostics } from "../diagnostics/sink.js";
import { run } from "../git/exec.js";
import { readModelToken } from "../config/runtime.js";
import { buildRuleFile, serializeRuleFile } from "./rule-file.js";
import { companionsByPath } from "./companions.js";
import { sanitizeFindingBody } from "../publish/sanitize.js";
import { EngineRunError, type EngineRunOptions, type EngineRunOutput } from "./run.js";

/** Sampling pins, identical in value and rationale to `run.ts` — one reviewer, one temperature. */
const TEMPERATURE = 0;
const DEFAULT_SEED = 42;

/** Completion budget per reply: a findings array is small; a reply that needs more than this is
 *  not a findings array. */
const MAX_COMPLETION_TOKENS = 3000;

/**
 * One bounded repair call per file whose parsed findings carry publisher-rejectable bodies.
 *
 * Motivated by the first live day: two runs settled `publication_degraded` because exactly one
 * body each died at the sanitizer (class `html` — a bare angle-bracket token), meaning a correct
 * finding was found, paid for, and never reached a reader. The repair asks the model to fix the
 * FORMATTING of the flagged bodies only. A body that still fails after repair is passed through
 * UNCHANGED — the publisher rejects it and the settlement reports the degradation honestly.
 * Silently dropping it here would be the same reader-visible loss with the honesty removed.
 * Exactly one repair round per file, by construction of `repairRejectableBodies`.
 */

/** One bounded retry per file on transport-shaped failures (429/5xx/network). A 4xx is the
 *  request's own fault and retrying it verbatim buys nothing — the file becomes a warning. */
const RETRIES_PER_FILE = 1;

/** Per-companion and whole-block character budgets for the `<companion_changes>` section. The
 *  block exists to kill the one-sided-pair false-positive class (37 of 52 findings on the first
 *  live release PR), and three bounded hunks do that; a whole package's diffs would just re-crowd
 *  the prompt the single-shot mode exists to keep small. */
const COMPANION_HUNK_CHARS = 1200;
const COMPANION_BLOCK_CHARS = 4000;

/** Character budget for one file's rendered diff inside the prompt. Far above any reviewable
 *  hunk set, far below a generated-bundle flood; a diff past this bound is truncated with an
 *  explicit marker so the model knows it is not seeing the whole change. */
const MAX_DIFF_CHARS = 60_000;

/**
 * The categories and severities the rule text prescribes. The model is told these exact tokens;
 * a reply outside them still parses (classification repair downstream owns the fix), but the
 * prompt states the contract once, in one place.
 */
const CATEGORIES = "bug, security, performance, maintainability, test, documentation, other";
const SEVERITIES = "critical, high, medium, low";

interface FileDispatch {
  readonly path: string;
  readonly renderedDiff: string;
  /** The `<companion_changes>` block for this file, when it has companions — see `companions.ts`. */
  readonly companionBlock?: string;
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

interface UsageTotals {
  prompt: number;
  completion: number;
  requests: number;
}

/**
 * One parsed unified-diff hunk, rendered PR-Agent style: `__new hunk__` carries every kept line
 * prefixed with its ABSOLUTE line number in the new file (additions marked `+`), `__old hunk__`
 * appears only when the hunk deletes anything and carries the removed lines unnumbered. Line
 * numbers are what let the model cite `start_line`/`end_line` directly against the file the
 * publisher will anchor on — no relocation pass, no guessing.
 */
export function renderNumberedHunks(fileDiff: string): string {
  const lines = fileDiff.split("\n");
  const out: string[] = [];
  let newLine = 0;
  let newBody: string[] = [];
  let oldBody: string[] = [];
  const flush = (): void => {
    if (newBody.length === 0 && oldBody.length === 0) return;
    out.push("__new hunk__");
    out.push(...newBody);
    if (oldBody.length > 0) {
      out.push("__old hunk__");
      out.push(...oldBody);
    }
    newBody = [];
    oldBody = [];
  };
  for (const line of lines) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header !== null) {
      flush();
      newLine = Number(header[1]);
      continue;
    }
    if (newLine === 0) continue; // file header lines before the first hunk
    if (line.startsWith("+")) {
      newBody.push(`${String(newLine)} +${line.slice(1)}`);
      newLine += 1;
    } else if (line.startsWith("-")) {
      oldBody.push(`-${line.slice(1)}`);
    } else if (line.startsWith(" ") || line === "") {
      newBody.push(`${String(newLine)}  ${line.slice(1)}`);
      newLine += 1;
    }
    // `\ No newline at end of file` and anything else: skipped, never counted.
  }
  flush();
  return out.join("\n");
}

/** Splits one multi-file `git diff` into per-path fragments, keyed by the new-side path. */
export function splitFileDiffs(diffText: string): ReadonlyMap<string, string> {
  const byPath = new Map<string, string>();
  const parts = diffText.split(/^diff --git /m).slice(1);
  for (const part of parts) {
    const newName = /^\+\+\+ (?:b\/)?(.+)$/m.exec(part);
    if (newName === null) continue;
    const path = newName[1]?.trim();
    if (path === undefined || path === "/dev/null") continue;
    byPath.set(path, part);
  }
  return byPath;
}

/**
 * The mode preamble: what is different about this call, stated where the model reads it. The
 * qualified rule text follows verbatim — guidance is product identity — but two of its premises
 * are false in this mode (it describes a searchable repository and tool-call budgeting), so the
 * preamble overrides exactly those and nothing else, and scopes claims to the provided context.
 */
function systemPrompt(rule: string): string {
  return [
    "You are reviewing one file's change in a single reply. There are NO tools in this mode: you",
    "cannot search or read the repository, and everything you may consult is already in this",
    "prompt — the numbered diff, and a `<repository_context>` block of precomputed lookups when",
    "present. Where the review guidance below speaks of searching the repository or spending tool",
    "calls, read it as: consult the provided context. Scope every claim to what the diff and that",
    'context substantiate; state a negative ("no caller", "unreachable") only as far as the',
    "provided context shows it, and say so.",
    "",
    "Diff format: `__new hunk__` lines carry the ABSOLUTE line number in the new file, additions",
    "marked `+`; `__old hunk__` shows removed lines. Cite `start_line`/`end_line` from the",
    "numbered lines only.",
    "",
    "A `<companion_changes>` block may follow the diff: the hunks of RELATED files changed in the",
    "SAME pull request (its package manifest, same-stem siblings, version files). Cross-file",
    "consistency claims — versions matching, exports existing, counterparts updated — are",
    "permitted ONLY when a companion hunk shown here proves them. When a counterpart file is part",
    "of this change but its hunk is not shown, DO NOT allege any mismatch with it: the pair may",
    "have moved together, and a claim about an unseen file is a guess wearing a finding's clothes.",
    "Files listed as changed but not shown are not yours to reason about at all.",
    "",
    "Reply with ONLY a JSON array, no prose around it. Each element:",
    `{"start_line": N, "end_line": N, "category": one of ${CATEGORIES},`,
    ` "severity": one of ${SEVERITIES}, "content": "the finding body"}.`,
    "An empty array [] is the correct reply for a clean change — silence is a valid review.",
    "",
    "--- review guidance begins ---",
    rule,
    "--- review guidance ends ---",
  ].join("\n");
}

function userPrompt(
  dispatch: FileDispatch,
  pack: string | undefined,
  totalChangedFiles: number,
): string {
  return [
    `This file is part of a change touching ${String(totalChangedFiles)} file(s) in total.`,
    "",
    `<current_file_path>${dispatch.path}</current_file_path>`,
    "",
    "<current_file_diff>",
    dispatch.renderedDiff,
    "</current_file_diff>",
    ...(dispatch.companionBlock === undefined ? [] : ["", dispatch.companionBlock]),
    ...(pack === undefined ? [] : ["", pack]),
    "",
    "Review the change in <current_file_diff> now and reply with the JSON array.",
  ].join("\n");
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

/** Strict reply parsing: fences tolerated, everything else reject-rather-than-repair. */
export function parseFindingsReply(
  reply: string,
  path: string,
): readonly EngineComment[] | undefined {
  const unfenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(reply);
  const text = (unfenced?.[1] ?? reply).trim();
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

/** The reviewable dispatch list under exactly `buildRuleFile`'s include/exclude semantics:
 *  review-relevant, not generated, not in this run's mechanically-clean union — so this runner
 *  reviews precisely the set the engine would have been sent. */
function dispatchPaths(options: EngineRunOptions, changedPaths: readonly string[]): string[] {
  const mechanicallyClean = new Set(options.mechanicallyCleanPaths);
  return changedPaths.filter(
    (path) =>
      options.profile.reviewRelevant.matches(path) &&
      !options.profile.generated.matches(path) &&
      !mechanicallyClean.has(path),
  );
}

async function gitDiff(options: EngineRunOptions): Promise<string | undefined> {
  try {
    const result = await run(
      "git",
      [
        "--no-pager",
        "diff",
        "--no-color",
        "--unified=3",
        options.pair.mergeBase,
        options.pair.head,
      ],
      {
        cwd: options.repositoryPath,
        timeoutMs: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { PATH: options.pathValue, LC_ALL: "C" },
      },
    );
    return result.stdout.toString("utf8");
  } catch {
    return undefined;
  }
}

interface ModelReply {
  readonly content: string | undefined;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly transportFailure: boolean;
}

const FAILED_REPLY: ModelReply = {
  content: undefined,
  promptTokens: 0,
  completionTokens: 0,
  transportFailure: true,
};

/** A successful response body as a `ModelReply` — usage read per-field, absent fields count 0,
 *  the same per-field tolerance `model-proxy.ts`'s own accounting applies. */
function parseModelResponse(text: string): ModelReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return FAILED_REPLY;
  }
  const record = parsed as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const content = record.choices?.[0]?.message?.content;
  return {
    content: typeof content === "string" ? content : undefined,
    promptTokens: typeof record.usage?.prompt_tokens === "number" ? record.usage.prompt_tokens : 0,
    completionTokens:
      typeof record.usage?.completion_tokens === "number" ? record.usage.completion_tokens : 0,
    transportFailure: false,
  };
}

async function callModel(
  endpoint: string,
  token: string,
  model: string,
  seed: number,
  system: string,
  user: string,
  fetchImpl: typeof fetch,
): Promise<ModelReply> {
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "api-key": token,
      },
      body: JSON.stringify({
        model,
        temperature: TEMPERATURE,
        seed,
        max_tokens: MAX_COMPLETION_TOKENS,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ...FAILED_REPLY,
        transportFailure: response.status === 429 || response.status >= 500,
      };
    }
    return parseModelResponse(text);
  } catch {
    return FAILED_REPLY;
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

/** The exact digest `writeRuleFile` records for the engine path, computed without a file: the
 *  rule text is part of the qualified configuration either way. */
function ruleDigestFor(options: EngineRunOptions): Sha256 {
  const rule = buildRuleFile(options.profile, options.guidelines, options.mechanicallyCleanPaths);
  return sha256(createHash("sha256").update(serializeRuleFile(rule)).digest("hex"));
}

/** Everything the per-file workers share, assembled once per invocation. */
interface RunState {
  readonly options: EngineRunOptions;
  readonly token: string;
  readonly system: string;
  readonly paths: readonly string[];
  readonly seed: number;
  readonly fetchImpl: typeof fetch;
  readonly usage: UsageTotals;
  readonly comments: EngineComment[];
  readonly warnings: EngineWarningShape[];
  spendStopped: boolean;
  /** Bodies the repair call actually saved — surfaced in `model.usage` so a silent repair
   *  pipeline failure reads as the regression it is, mirroring `context_pack_injected`. */
  repairedBodies: number;
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

/** The dispatch list: the rule-selected changed files, each with its bounded rendered diff. */
async function prepareDispatches(options: EngineRunOptions): Promise<FileDispatch[]> {
  const diffText = await gitDiff(options);
  if (diffText === undefined) throw new EngineRunError("engine.run.spawn_failed");
  const fragments = splitFileDiffs(diffText);
  const companions = companionsByPath([...fragments.keys()]);
  return dispatchPaths(options, [...fragments.keys()]).map((path) => {
    const rendered = renderNumberedHunks(fragments.get(path) ?? "");
    const bounded =
      rendered.length > MAX_DIFF_CHARS
        ? `${rendered.slice(0, MAX_DIFF_CHARS)}\n(truncated: diff exceeds the prompt budget)`
        : rendered;
    const companionBlock = companionBlockFor(companions.get(path) ?? [], fragments);
    return {
      path,
      renderedDiff: bounded,
      ...(companionBlock === undefined ? {} : { companionBlock }),
    };
  });
}

/**
 * The allotment gate, enforced BEFORE each file's call on wire-observed spend — the one place the
 * agentic loop could only estimate, this runner can simply check. Files past the stop become
 * warnings, never silent omissions.
 */
function budgetStopped(state: RunState, dispatch: FileDispatch): boolean {
  if (
    !state.spendStopped &&
    state.usage.prompt + state.usage.completion < state.options.allottedBudget
  ) {
    return false;
  }
  state.spendStopped = true;
  state.warnings.push({
    type: "subtask_error",
    file: dispatch.path,
    message: "single_shot budget stop before dispatch",
  });
  return true;
}

/** One file's whole review: budget gate, one call plus its bounded retry, strict parse. Every
 *  failure shape lands as an honest `subtask_error` — settlement's coverage gap, never silence. */
async function reviewOneFile(state: RunState, dispatch: FileDispatch): Promise<void> {
  if (budgetStopped(state, dispatch)) return;
  const pack = state.options.contextPacks?.get(dispatch.path);
  const user = userPrompt(dispatch, pack, state.paths.length);
  let reply: ModelReply | undefined;
  for (let attempt = 0; attempt <= RETRIES_PER_FILE; attempt += 1) {
    reply = await callModel(
      state.options.config.endpoint,
      state.token,
      state.options.config.model,
      state.seed,
      state.system,
      user,
      state.fetchImpl,
    );
    state.usage.requests += 1;
    state.usage.prompt += reply.promptTokens;
    state.usage.completion += reply.completionTokens;
    if (reply.content !== undefined || !reply.transportFailure) break;
  }
  const content = reply?.content;
  if (content === undefined) {
    state.warnings.push({
      type: "subtask_error",
      file: dispatch.path,
      message: "single_shot model call failed",
    });
    return;
  }
  const parsed = parseFindingsReply(content, dispatch.path);
  if (parsed === undefined) {
    state.warnings.push({
      type: "subtask_error",
      file: dispatch.path,
      message: "single_shot reply was not a findings array",
    });
    return;
  }
  state.comments.push(...(await repairRejectableBodies(state, parsed)));
}

/** The publisher's verdict on a body, reduced to what the repair loop needs. */
function bodyRejected(content: string): boolean {
  return !sanitizeFindingBody(content).ok;
}

/**
 * Sends the flagged bodies back to the model once, formatting-repair only, and keeps a repaired
 * body only when the REAL sanitizer now accepts it and the model returned the same count. Any
 * other shape — call failed, wrong count, still rejected — keeps the original: the loss then
 * surfaces downstream as the honest `publication_degraded` it is. See `REPAIR_CALLS_PER_FILE`.
 */
async function repairRejectableBodies(
  state: RunState,
  comments: readonly EngineComment[],
): Promise<readonly EngineComment[]> {
  const flagged = comments
    .map((comment, index) => ({ comment, index }))
    .filter(({ comment }) => bodyRejected(comment.content));
  if (flagged.length === 0) return comments;

  const system = [
    "You repair the FORMATTING of code-review finding bodies so a strict publisher accepts them.",
    "Never change meaning, evidence, or tone. Rules the publisher enforces: no HTML — wrap any",
    "angle-bracket token in backticks (`LIKE_THIS`); no links, images, or URLs — describe them in",
    "plain words; no @mentions; no `suggestion` fences (plain `diff` fences are fine); the body",
    "ends after its last sentence, its closing fence, or a `Source:` line.",
    "",
    "Reply with ONLY a JSON array of strings: the repaired bodies, in the exact order given, same",
    "count as given.",
  ].join("\n");
  const user = JSON.stringify(flagged.map(({ comment }) => comment.content));

  const reply = await callModel(
    state.options.config.endpoint,
    state.token,
    state.options.config.model,
    state.seed,
    system,
    user,
    state.fetchImpl,
  );
  state.usage.requests += 1;
  state.usage.prompt += reply.promptTokens;
  state.usage.completion += reply.completionTokens;
  if (reply.content === undefined) return comments;

  let repaired: unknown;
  try {
    const unfenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(reply.content);
    repaired = JSON.parse((unfenced?.[1] ?? reply.content).trim());
  } catch {
    return comments;
  }
  if (!Array.isArray(repaired) || repaired.length !== flagged.length) return comments;
  const repairedList: readonly unknown[] = repaired as readonly unknown[];

  const result = [...comments];
  flagged.forEach(({ comment, index }, i) => {
    const candidate = repairedList[i];
    if (typeof candidate !== "string" || candidate === "" || bodyRejected(candidate)) return;
    result[index] = { ...comment, content: candidate };
    state.repairedBodies += 1;
  });
  return result;
}

/** The engine-shaped stdout — byte-compatible with what `result.ts` parses from the binary. */
function assembleStdout(state: RunState, dispatched: number, startedMs: number): string {
  const totalTokens = state.usage.prompt + state.usage.completion;
  return JSON.stringify({
    status: state.warnings.length === 0 ? "success" : "completed_with_errors",
    summary: {
      files_reviewed: dispatched,
      comments: state.comments.length,
      total_tokens: totalTokens,
      input_tokens: state.usage.prompt,
      output_tokens: state.usage.completion,
      elapsed: `${String(Math.max(1, Math.round((Date.now() - startedMs) / 1000)))}s`,
    },
    tool_calls: { total: 0, by_tool: {} },
    comments: state.comments,
    warnings: state.warnings,
    session_id: randomUUID(),
  });
}

/** The shared per-invocation state, assembled once — split from the runner for its line budget. */
function initialRunState(
  options: EngineRunOptions,
  rule: string,
  dispatches: readonly FileDispatch[],
  fetchImpl: typeof fetch,
  token: string,
): RunState {
  return {
    options,
    token,
    system: systemPrompt(rule),
    paths: dispatches.map((dispatch) => dispatch.path),
    seed: options.samplingSeed ?? DEFAULT_SEED,
    fetchImpl,
    usage: { prompt: 0, completion: 0, requests: 0 },
    comments: [],
    warnings: [],
    spendStopped: false,
    repairedBodies: 0,
  };
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
  const token = readModelToken(options.config, options.env);
  if (token === undefined) throw new EngineRunError("engine.run.spawn_failed");
  const started = Date.now();
  const ruleDigest = ruleDigestFor(options);
  const rule = buildRuleFile(options.profile, options.guidelines, options.mechanicallyCleanPaths)
    .rules[0]?.rule;
  if (rule === undefined) throw new EngineRunError("engine.run.spawn_failed");

  const dispatches = await prepareDispatches(options);
  const state = initialRunState(options, rule, dispatches, fetchImpl, token);
  await inPool(dispatches, options.config.concurrency, (dispatch) =>
    reviewOneFile(state, dispatch),
  );

  const stdout = assembleStdout(state, dispatches.length, started);
  diagnostics.record("engine.run.completed", {
    headSha: options.pair.head,
    digest: ruleDigest,
    durationMs: Date.now() - started,
    counts: { bytes: Buffer.byteLength(stdout, "utf8"), budget: options.allottedBudget },
  });
  diagnostics.record("model.usage", {
    headSha: options.pair.head,
    counts: {
      requests: state.usage.requests,
      prompt: state.usage.prompt,
      completion: state.usage.completion,
      cached: 0,
      context_pack_injected: options.contextPacks === undefined ? 0 : dispatches.length,
      bodies_repaired: state.repairedBodies,
      cache_key_rejected: 0,
      bad_request_persisted: 0,
    },
  });
  const totalTokens = state.usage.prompt + state.usage.completion;
  return { stdout, ruleDigest, wireTokens: totalTokens };
}
