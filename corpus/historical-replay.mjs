#!/usr/bin/env node
// Historical precision replay over the unredacted, local-only harvest.
//
// This is the paid half of `historical-replay-lib.mjs`. It deliberately keeps the two halves of
// the experiment apart:
//
//   1. labels and replies are read once to build the scorer's ground truth;
//   2. the verifier receives only path, anchor, reconstructed finding prose, exact change diff,
//      and bounded repository context from that immutable historical HEAD;
//   3. keep/drop/unmeasured decisions are joined back to the labels only after verification.
//
// Source HEAD comes from each root comment's immutable `originalCommit` in a local consumer
// checkout. GitHub's remappable `commit` field is retained by the harvest for auditing but is never
// accepted here. The harvest only carries the pull request's CURRENT target-ref oid, not the base at
// the time of that root. For each case Git therefore derives one unique merge-base between that
// target ref and the original comment commit. Production's evidence builder receives those exact
// sources, their exact single-change unified diff, and the same initial/follow-up repository
// retrieval path used by live reviews. This is reported as a derived merge-base, never as the
// unavailable PR-event base. No source comes from repository HEAD or the working tree. A missing
// or ambiguous historical object is `unmeasured`; substituting newer code would put findings after
// their fixes.
//
// No invocation is implicit. `--dry-run` performs every local binding check and prints the case and
// token plan without importing the model-facing verifier. A paid run requires the separate,
// conspicuous `--execute` flag. This process cannot prove that a dry run happened in an earlier
// shell, so it does not pretend to; both modes print the same plan before any possible model call.
//
// Example (the harvest must remain outside this repository):
//
//   OCR_LLM_MODEL=gpt-oss-120b node corpus/historical-replay.mjs --dry-run \
//     --harvest ~/kfq-harvest.json --repo ~/src/Keiko --holdout-from-pr 3037 \
//     --max-tokens 1100000
//
//   OCR_LLM_MODEL=gpt-oss-120b OCR_LLM_URL=https://gateway.example/v1 \
//     OCR_LLM_TOKEN=... node corpus/historical-replay.mjs --execute \
//     --harvest ~/kfq-harvest.json --repo ~/src/Keiko --holdout-from-pr 3037 \
//     --max-tokens 1100000 --out corpus/evidence/historical-replay-2026-08-09-v0.23.0.json

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { FIXED_PATH } from "./fixed-path.mjs";
import { escapesRepository, HARVEST_LABELS, realLocation } from "./harvest-lib.mjs";
import { buildHistoricalReplayDiagnostic } from "./historical-replay-diagnostic-lib.mjs";
import { HISTORICAL_REPLAY_EVIDENCE_ARTIFACT } from "./historical-replay-evidence-lib.mjs";
import { buildHistoricalReplayReport } from "./historical-replay-lib.mjs";
import { QUALIFICATION_MODEL } from "./qualification-model.mjs";
import { registerTsExtensionHooks } from "./rule-source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "..");
const CORROBORATED_LABELS = new Set(["fixed_confirmed", "refuted_confirmed"]);
const LABELS = new Set(HARVEST_LABELS);
const FULL_OBJECT_ID = /^[0-9a-f]{40}$/u;
const CURRENT_HEADER = /^`[A-Z]+ · [A-Z]+`[ \t]*\n+/u;
const BOLD_HEADER = /^\*\*[A-Z]+ · [A-Z]+\*\*[ \t]*\n+/u;
const LEGACY_HEADER = /^_[^_\n]+_ \| _[^_\n]+_[ \t]*\n+/u;
const TRAILING_MARKER = /\n*<!-- keiko-for-quality:v1:[0-9a-f]{32} -->[ \t\n]*$/u;
const TRAILING_DETAILS = /\n*<details>[\s\S]*?<\/details>[ \t\n]*$/u;

const MAX_HARVEST_BYTES = 128 * 1024 * 1024;
const MAX_FINDING_BODY_CHARS = 20_000;
const MAX_FINDING_CONTENT_CHARS = 8_000;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_TREE_OUTPUT_BYTES = 16 * 1024;
const MAX_DIFF_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ENDPOINT_REQUESTS_PER_CASE = 4;
const GIT_TIMEOUT_MS = 30_000;

/** Dry-run cost estimate only. The execute path enforces `--max-tokens` from actual accounting. */
export const HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE = 32_000;
export const HISTORICAL_REPLAY_STRICTNESS = "paranoid";

const USAGE =
  "usage: OCR_LLM_MODEL=gpt-oss-120b node corpus/historical-replay.mjs " +
  "(--dry-run | --execute) --harvest <outside-repo.json> --repo <local-consumer-git> " +
  "--holdout-from-pr <n> --max-tokens <n> [--out <redacted-report.json>] " +
  "[--diagnostic-trace-out <outside-repo-private.json>]";

function positiveInteger(raw, name) {
  if (typeof raw !== "string" || !/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is too large`);
  return value;
}

/** Strict CLI parsing: unknown, duplicate, missing, and positional arguments all fail closed. */
export function parseHistoricalReplayArgs(argv) {
  if (!Array.isArray(argv)) throw new Error("historical replay arguments must be an array");
  const switches = new Set();
  const values = new Map();
  const valueFlags = new Set([
    "--harvest",
    "--repo",
    "--holdout-from-pr",
    "--max-tokens",
    "--out",
    "--diagnostic-trace-out",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run" || token === "--execute") {
      if (switches.has(token)) throw new Error(`duplicate argument: ${token}`);
      switches.add(token);
      continue;
    }
    if (typeof token !== "string" || !valueFlags.has(token)) {
      throw new Error(`unknown argument: ${String(token)}`);
    }
    if (values.has(token)) throw new Error(`duplicate argument: ${token}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    values.set(token, value);
    index += 1;
  }

  if (switches.size !== 1) {
    throw new Error("pass exactly one of --dry-run or --execute");
  }
  for (const required of ["--harvest", "--repo", "--holdout-from-pr", "--max-tokens"]) {
    if (!values.has(required)) throw new Error(`${required} is required`);
  }
  const mode = switches.has("--dry-run") ? "dry-run" : "execute";
  const outPath = values.get("--out");
  const diagnosticTraceOutPath = values.get("--diagnostic-trace-out");
  if (mode === "execute" && outPath === undefined) {
    throw new Error("--out is required with --execute");
  }
  if (mode === "dry-run" && diagnosticTraceOutPath !== undefined) {
    throw new Error("--diagnostic-trace-out is available only with --execute");
  }
  return {
    mode,
    harvestPath: values.get("--harvest"),
    repoPath: values.get("--repo"),
    holdoutFromPullRequest: positiveInteger(values.get("--holdout-from-pr"), "--holdout-from-pr"),
    maxTokens: positiveInteger(values.get("--max-tokens"), "--max-tokens"),
    ...(outPath === undefined ? {} : { outPath }),
    ...(diagnosticTraceOutPath === undefined ? {} : { diagnosticTraceOutPath }),
  };
}

/** No cross-model escape hatch exists for this measurement. */
export function requireHistoricalReplayModel(env = process.env) {
  const configured = (env.OCR_LLM_MODEL ?? "").trim();
  if (configured !== QUALIFICATION_MODEL) {
    const shown = configured === "" ? "(unset)" : configured;
    throw new Error(
      `OCR_LLM_MODEL is ${shown}; historical replay requires exactly ${QUALIFICATION_MODEL}. ` +
        "OCR_ALLOW_MODEL_DEVIATION does not apply to this measurement.",
    );
  }
  return configured;
}

/** Model-facing configuration is validated only for `--execute`; dry-run needs no credential. */
export function historicalReplayJudgeEndpoint(env = process.env) {
  const model = requireHistoricalReplayModel(env);
  if ((env.OCR_USE_ANTHROPIC ?? "").trim().toLowerCase() === "true") {
    throw new Error("historical replay requires the OpenAI-compatible substantiation path");
  }
  const endpoint = (env.OCR_LLM_URL ?? "").trim();
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("OCR_LLM_URL must be an absolute HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("OCR_LLM_URL must be an HTTPS URL without credentials, query, or fragment");
  }
  const token = env.OCR_LLM_TOKEN ?? "";
  if (token.trim() === "") throw new Error("OCR_LLM_TOKEN is required with --execute");
  return { endpoint, token, model };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readBoundedFile(path, maximum) {
  const value = readFileSync(path);
  if (value.length > maximum) throw new Error("input artifact exceeds its size limit");
  return value;
}

/** Loads and hashes the raw harvest without ever copying it into this repository. */
export function readHistoricalHarvest(path, repositoryRoot = REPOSITORY_ROOT) {
  const location = realLocation(resolve(path));
  if (!escapesRepository(repositoryRoot, location)) {
    throw new Error("the unredacted --harvest must be outside this repository");
  }
  const bytes = readBoundedFile(location, MAX_HARVEST_BYTES);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("the harvest is not valid UTF-8");
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("the harvest is not valid JSON");
  }
  return { document, sha256: sha256(bytes), location };
}

/**
 * Reconstructs the sanitized model prose from the product-authored publication wrapper.
 *
 * Tight parsing is intentional. A body whose header/details/marker shape is unknown is not repaired
 * heuristically and is not sent to the verifier: wrapper boilerplate contains instructions and
 * would make both evidence retrieval and judging measure a different finding from the one a reader
 * saw.
 */
export function extractPublishedFindingContent(body) {
  if (
    typeof body !== "string" ||
    body.length === 0 ||
    body.length > MAX_FINDING_BODY_CHARS ||
    body.includes("\r")
  ) {
    return undefined;
  }
  if (!TRAILING_MARKER.test(body)) return undefined;
  let content = body.replace(TRAILING_MARKER, "").trimEnd();
  const withoutHeader = content
    .replace(CURRENT_HEADER, "")
    .replace(BOLD_HEADER, "")
    .replace(LEGACY_HEADER, "");
  if (withoutHeader === content) return undefined;
  content = withoutHeader.replace(TRAILING_DETAILS, "").trim();
  const proseOutsideCode = content
    .replace(/```[^\n]*\n[\s\S]*?\n```/gu, "")
    .replace(/`[^`\n]+`/gu, "");
  if (content === withoutHeader.trim() || /<\/?[A-Za-z!]/u.test(proseOutsideCode)) return undefined;

  const title = /^\*\*([^*\n]+)\*\*(?:\n\n|$)/u.exec(content);
  if (title?.[1] !== undefined) {
    const remainder = content.slice(title[0].length).trim();
    content = remainder === "" ? title[1] : `${title[1]}\n\n${remainder}`;
  }
  content = content.trim();
  if (content === "" || content.length > MAX_FINDING_CONTENT_CHARS) return undefined;
  return content;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validatedCommitOid(value, binding = "root") {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !FULL_OBJECT_ID.test(value)) {
    throw new Error(`a historical record carries a malformed ${binding} commitOid`);
  }
  return value;
}

/**
 * Builds the deliberate anti-leak boundary. `records` carry labels for the scorer; `cases` carry
 * verifier inputs and contain no label, reply, reply verdict, or composed body field.
 */
export function extractHistoricalReplayDataset(document) {
  if (
    document === null ||
    typeof document !== "object" ||
    document.schemaVersion !== 2 ||
    document.unredacted !== true ||
    !Array.isArray(document.pullRequests)
  ) {
    throw new Error("historical replay requires an unredacted schemaVersion 2 harvest");
  }

  const records = [];
  const cases = [];
  const ids = new Set();
  for (const pullRequest of document.pullRequests) {
    if (
      pullRequest === null ||
      typeof pullRequest !== "object" ||
      !isPositiveInteger(pullRequest.number) ||
      !Array.isArray(pullRequest.findings)
    ) {
      throw new Error("every harvested pull request needs a positive number and findings array");
    }
    const harvestedBaseRefOid = validatedCommitOid(pullRequest.baseCommitOid, "harvested base-ref");
    for (const finding of pullRequest.findings) {
      if (finding?.arenaId !== "kfq") continue;
      if (!isPositiveInteger(finding.databaseId)) {
        throw new Error("every Keiko historical finding needs a positive databaseId");
      }
      if (ids.has(finding.databaseId)) {
        throw new Error(`duplicate Keiko historical databaseId: ${String(finding.databaseId)}`);
      }
      ids.add(finding.databaseId);
      if (typeof finding.label !== "string" || !LABELS.has(finding.label)) {
        throw new Error(`unknown historical label for ${String(finding.databaseId)}`);
      }
      records.push({
        pullRequest: pullRequest.number,
        databaseId: finding.databaseId,
        label: finding.label,
      });
      if (!CORROBORATED_LABELS.has(finding.label)) continue;
      cases.push({
        databaseId: finding.databaseId,
        harvestedBaseRefOid,
        // Deliberately no fallback to `finding.commitOid`: GitHub may remap that field after the
        // review, which can make a true finding appear false by showing the verifier its own fix.
        originalCommitOid: validatedCommitOid(finding.originalCommitOid, "original root"),
        path: typeof finding.path === "string" ? finding.path : null,
        startLine: isPositiveInteger(finding.startLine) ? finding.startLine : null,
        endLine: isPositiveInteger(finding.endLine) ? finding.endLine : null,
        content: extractPublishedFindingContent(finding.body) ?? null,
      });
    }
  }
  if (records.length === 0) throw new Error("the harvest contains no Keiko findings");
  if (cases.length === 0) throw new Error("the harvest contains no corroborated Keiko findings");
  return { records, cases };
}

/** A git path can be exact without being allowed to become an option, pathspec, or prompt control. */
export function isSafeHistoricalGitPath(path) {
  if (
    typeof path !== "string" ||
    path === "" ||
    path.length > 4096 ||
    isAbsolute(path) ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    [...path].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  ) {
    return false;
  }
  const parts = path.split("/");
  return !parts.includes("") && !parts.includes(".") && !parts.includes("..");
}

let gitBinary;

function resolveGitBinary() {
  if (gitBinary !== undefined) return gitBinary;
  for (const directory of FIXED_PATH.split(":")) {
    const candidate = join(directory, "git");
    if (existsSync(candidate)) {
      gitBinary = candidate;
      return candidate;
    }
  }
  throw new Error("git is unavailable on the fixed corpus PATH");
}

function gitEnvironment() {
  return {
    PATH: FIXED_PATH,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_ALLOW_PROTOCOL: "file:https",
  };
}

function runGit(repo, args, options = {}) {
  return execFileSync(resolveGitBinary(), args, {
    cwd: repo,
    env: gitEnvironment(),
    maxBuffer: options.maxBuffer ?? MAX_TREE_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    ...(options.encoding === undefined ? {} : { encoding: options.encoding }),
    stdio: options.encoding === undefined ? ["ignore", "pipe", "ignore"] : undefined,
  });
}

/** Refuses a subdirectory or a non-repository so every later git call has one unambiguous root. */
export function resolveConsumerGitRoot(path) {
  let requested;
  try {
    requested = realpathSync(resolve(path));
  } catch {
    throw new Error("--repo must name an existing local consumer checkout");
  }
  let reported;
  try {
    reported = String(
      runGit(requested, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }),
    ).trim();
  } catch {
    throw new Error("--repo must name a local git worktree");
  }
  if (realpathSync(reported) !== requested) {
    throw new Error("--repo must name the consumer worktree root, not a subdirectory");
  }
  return requested;
}

class ReplayCaseError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function structuralCaseReason(replayCase) {
  if (replayCase.harvestedBaseRefOid === null || replayCase.originalCommitOid === null) {
    return "missingHistoricalBinding";
  }
  if (
    !FULL_OBJECT_ID.test(replayCase.harvestedBaseRefOid) ||
    !FULL_OBJECT_ID.test(replayCase.originalCommitOid) ||
    !isSafeHistoricalGitPath(replayCase.path) ||
    !isPositiveInteger(replayCase.startLine) ||
    !isPositiveInteger(replayCase.endLine) ||
    replayCase.endLine < replayCase.startLine
  ) {
    return "invalidHistoricalBinding";
  }
  if (typeof replayCase.content !== "string" || replayCase.content === "") {
    return "findingBodyUnavailable";
  }
  return undefined;
}

/**
 * Reads one regular file at the exact historical tree. `ls-tree` resolves the path literally and
 * yields a blob id; `cat-file` then reads that object without checkout, hooks, filters, or consumer
 * code execution.
 */
export function readFileAtHistoricalCommit(repo, commitOid, path) {
  if (!FULL_OBJECT_ID.test(commitOid) || !isSafeHistoricalGitPath(path)) {
    throw new ReplayCaseError("invalidHistoricalBinding");
  }
  let listing;
  try {
    listing = String(
      runGit(repo, ["ls-tree", "-z", "--full-tree", commitOid, "--", path], {
        encoding: "utf8",
      }),
    );
  } catch {
    throw new ReplayCaseError("sourceUnavailable");
  }
  const rows = listing.split("\0").filter((row) => row !== "");
  if (rows.length !== 1) throw new ReplayCaseError("sourceUnavailable");
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\n]+)$/u.exec(rows[0]);
  if (match?.[2] === undefined || match[3] !== path) {
    throw new ReplayCaseError("sourceUnavailable");
  }
  let bytes;
  try {
    bytes = runGit(repo, ["cat-file", "blob", match[2]], {
      maxBuffer: MAX_SOURCE_BYTES + 1,
    });
  } catch {
    throw new ReplayCaseError("sourceUnavailable");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SOURCE_BYTES || bytes.includes(0)) {
    throw new ReplayCaseError("sourceUnavailable");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReplayCaseError("sourceUnavailable");
  }
}

function comparisonBase(repo, harvestedBaseRefOid, originalCommitOid) {
  let raw;
  try {
    raw = String(
      runGit(repo, ["merge-base", "--all", harvestedBaseRefOid, originalCommitOid], {
        encoding: "utf8",
      }),
    );
  } catch {
    throw new ReplayCaseError("sourceUnavailable");
  }
  const candidates = raw
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (candidates.length !== 1 || !FULL_OBJECT_ID.test(candidates[0])) {
    throw new ReplayCaseError("sourceUnavailable");
  }
  return candidates[0];
}

function parseHistoricalNameStatus(raw) {
  if (raw === "") return [];
  if (!raw.endsWith("\0")) throw new ReplayCaseError("sourceUnavailable");
  const fields = raw.split("\0");
  fields.pop();
  const entries = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    index += 1;
    if (/^[AMDT]$/u.test(status ?? "")) {
      const path = fields[index];
      index += 1;
      if (!isSafeHistoricalGitPath(path)) throw new ReplayCaseError("sourceUnavailable");
      entries.push({ status, oldPath: path, newPath: path });
      continue;
    }
    const renameOrCopy = /^([RC])(\d{1,3})$/u.exec(status ?? "");
    if (renameOrCopy !== null && Number(renameOrCopy[2]) <= 100) {
      const oldPath = fields[index];
      const newPath = fields[index + 1];
      index += 2;
      if (!isSafeHistoricalGitPath(oldPath) || !isSafeHistoricalGitPath(newPath)) {
        throw new ReplayCaseError("sourceUnavailable");
      }
      entries.push({ status, oldPath, newPath });
      continue;
    }
    throw new ReplayCaseError("sourceUnavailable");
  }
  return entries;
}

/** Resolves the original review source plus a unique merge-base-derived comparison source. */
export function readHistoricalChangeAtCommits(repo, replayCase) {
  if (
    !FULL_OBJECT_ID.test(replayCase.harvestedBaseRefOid) ||
    !FULL_OBJECT_ID.test(replayCase.originalCommitOid) ||
    !isSafeHistoricalGitPath(replayCase.path)
  ) {
    throw new ReplayCaseError("invalidHistoricalBinding");
  }
  const baseCommitOid = comparisonBase(
    repo,
    replayCase.harvestedBaseRefOid,
    replayCase.originalCommitOid,
  );
  let raw;
  try {
    raw = String(
      runGit(
        repo,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--submodule=short",
          "--name-status",
          "--find-renames=50",
          "-z",
          baseCommitOid,
          replayCase.originalCommitOid,
        ],
        { encoding: "utf8", maxBuffer: MAX_TREE_OUTPUT_BYTES },
      ),
    );
  } catch {
    throw new ReplayCaseError("sourceUnavailable");
  }
  const matching = parseHistoricalNameStatus(raw).filter(
    (entry) => entry.newPath === replayCase.path,
  );
  if (matching.length !== 1) throw new ReplayCaseError("sourceUnavailable");
  const change = matching[0];
  const diffPaths = [...new Set([change.oldPath, change.newPath])];
  let unifiedDiff;
  try {
    unifiedDiff = String(
      runGit(
        repo,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--submodule=short",
          "--find-renames=50",
          "--unified=24",
          baseCommitOid,
          replayCase.originalCommitOid,
          "--",
          ...diffPaths,
        ],
        { encoding: "utf8", maxBuffer: MAX_DIFF_OUTPUT_BYTES },
      ),
    );
  } catch {
    throw new ReplayCaseError("sourceUnavailable");
  }
  if (unifiedDiff === "") throw new ReplayCaseError("sourceUnavailable");
  const binding = {
    headCommitOid: replayCase.originalCommitOid,
    baseCommitOid,
    oldPath: change.oldPath,
    unifiedDiff,
  };
  if (change.status === "A") {
    return {
      ...binding,
      headSource: readFileAtHistoricalCommit(repo, replayCase.originalCommitOid, replayCase.path),
      baseSource: undefined,
    };
  }
  if (change.status === "D") {
    return {
      ...binding,
      headSource: undefined,
      baseSource: readFileAtHistoricalCommit(repo, baseCommitOid, replayCase.path),
    };
  }
  if (change.status === "M" || change.status === "T") {
    return {
      ...binding,
      headSource: readFileAtHistoricalCommit(repo, replayCase.originalCommitOid, replayCase.path),
      baseSource: readFileAtHistoricalCommit(repo, baseCommitOid, replayCase.path),
    };
  }
  if (/^[RC]\d+$/u.test(change.status)) {
    return {
      ...binding,
      headSource: readFileAtHistoricalCommit(repo, replayCase.originalCommitOid, replayCase.path),
      baseSource: readFileAtHistoricalCommit(repo, baseCommitOid, change.oldPath),
    };
  }
  throw new ReplayCaseError("sourceUnavailable");
}

function fixedReasonCounts() {
  return {
    outsideCorroboratedPopulation: 0,
    missingHistoricalBinding: 0,
    invalidHistoricalBinding: 0,
    findingBodyUnavailable: 0,
    sourceUnavailable: 0,
    evidenceUnavailable: 0,
    budget: 0,
    verificationUndecided: 0,
    verificationError: 0,
  };
}

function validHistoricalChangeBinding(replayCase, sources) {
  return (
    sources !== null &&
    typeof sources === "object" &&
    sources.headCommitOid === replayCase.originalCommitOid &&
    typeof sources.baseCommitOid === "string" &&
    FULL_OBJECT_ID.test(sources.baseCommitOid) &&
    typeof sources.oldPath === "string" &&
    isSafeHistoricalGitPath(sources.oldPath) &&
    typeof sources.unifiedDiff === "string" &&
    sources.unifiedDiff !== "" &&
    ((typeof sources.headSource === "string" && sources.headSource !== "") ||
      (typeof sources.baseSource === "string" && sources.baseSource !== ""))
  );
}

/** Exact source slice used by production's deterministic repository-retrieval planner. */
function sourceLines(source, startLine, endLine) {
  if (
    typeof source !== "string" ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return undefined;
  }
  const text = source.endsWith("\n") ? source.slice(0, -1) : source;
  const lines = text.split("\n");
  if (endLine > lines.length) return undefined;
  return lines.slice(startLine - 1, endLine).join("\n");
}

async function inspectCase(replayCase, repo, readChangeAtCommits) {
  const structural = structuralCaseReason(replayCase);
  if (structural !== undefined) return structural;
  try {
    const sources = await readChangeAtCommits(repo, replayCase);
    return validHistoricalChangeBinding(replayCase, sources) ? undefined : "sourceUnavailable";
  } catch (error) {
    return error instanceof ReplayCaseError ? error.reason : "sourceUnavailable";
  }
}

/** Local-only plan used by both modes before the verifier can possibly be imported or called. */
export async function buildHistoricalReplayPlan({
  records,
  cases,
  repo,
  maxTokens,
  readChangeAtCommits = readHistoricalChangeAtCommits,
}) {
  const localUnmeasured = fixedReasonCounts();
  let locallyBoundCases = 0;
  for (const replayCase of cases) {
    const reason = await inspectCase(replayCase, repo, readChangeAtCommits);
    if (reason === undefined) locallyBoundCases += 1;
    else localUnmeasured[reason] += 1;
  }
  const estimatedAffordableCases = Math.min(
    locallyBoundCases,
    Math.floor(maxTokens / HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE),
  );
  return {
    populationRecords: records.length,
    corroboratedCases: cases.length,
    locallyBoundCases,
    structurallyUnmeasuredCases: cases.length - locallyBoundCases,
    estimatedAffordableCases,
    estimatedCostExcessCases: locallyBoundCases - estimatedAffordableCases,
    estimatedStartWorkTokens: locallyBoundCases * HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE,
    configuredMaxTokens: maxTokens,
    estimatedMaximumEndpointRequests: estimatedAffordableCases * MAX_ENDPOINT_REQUESTS_PER_CASE,
    localUnmeasured,
  };
}

function assertDecisionInputs(databaseIds, cases) {
  if (!Array.isArray(databaseIds) || databaseIds.length === 0) {
    throw new Error("historical replay needs population database ids");
  }
  const population = new Set(databaseIds);
  if (population.size !== databaseIds.length || databaseIds.some((id) => !isPositiveInteger(id))) {
    throw new Error("historical replay population database ids must be unique positive integers");
  }
  const caseIds = new Set();
  for (const replayCase of cases) {
    if (!population.has(replayCase.databaseId) || caseIds.has(replayCase.databaseId)) {
      throw new Error("historical replay cases must map one-to-one into the population");
    }
    caseIds.add(replayCase.databaseId);
  }
  return { population, caseIds };
}

function nonnegativeIntegerField(outcome, field) {
  return Number.isSafeInteger(outcome[field]) && outcome[field] >= 0;
}

const STAGE_COUNTER_FIELDS = [
  "confirmed",
  "truthRefuted",
  "falsifierDefeated",
  "droppedInsufficientEvidence",
  "retrievalRequested",
  "retrievalPerformed",
  "retrievalExpanded",
  "retrievalNoMatches",
  "retrievalFailed",
  "challengePlanned",
  "challengeRetrievalPerformed",
  "challengeExpanded",
  "challengeNoMatches",
  "challengeFailed",
  "undecided",
  "budgetBlocked",
];

function emptyStageCounters() {
  return Object.fromEntries(STAGE_COUNTER_FIELDS.map((field) => [field, 0]));
}

function validSubstantiationOutcome(outcome, finding) {
  const countFields = [
    "confirmed",
    "droppedRefuted",
    "droppedInsufficientEvidence",
    "truthRefuted",
    "falsifierDefeated",
    "retrievalRequested",
    "retrievalPerformed",
    "retrievalExpanded",
    "retrievalNoMatches",
    "retrievalFailed",
    "challengePlanned",
    "challengeRetrievalPerformed",
    "challengeExpanded",
    "challengeNoMatches",
    "challengeFailed",
    "repaired",
    "droppedVague",
    "droppedUnsupported",
    "droppedNitpick",
    "undecided",
    "budgetBlocked",
    "tokens",
  ];
  if (
    !(
      outcome !== null &&
      typeof outcome === "object" &&
      outcome.strictness === HISTORICAL_REPLAY_STRICTNESS &&
      Array.isArray(outcome.findings) &&
      outcome.findings.length <= 1 &&
      (outcome.findings.length === 0 || outcome.findings[0] === finding) &&
      countFields.every((field) => nonnegativeIntegerField(outcome, field)) &&
      outcome.undecided <= 1 &&
      outcome.budgetBlocked <= 1 &&
      outcome.repaired === 0 &&
      outcome.droppedNitpick === 0
    )
  ) {
    return false;
  }

  const terminalDecisions =
    outcome.confirmed +
    outcome.truthRefuted +
    outcome.falsifierDefeated +
    outcome.droppedInsufficientEvidence +
    outcome.undecided;
  return (
    terminalDecisions === 1 &&
    outcome.confirmed === outcome.findings.length &&
    outcome.droppedRefuted === outcome.truthRefuted + outcome.falsifierDefeated &&
    outcome.droppedUnsupported === outcome.droppedRefuted &&
    outcome.droppedVague === outcome.droppedInsufficientEvidence &&
    outcome.budgetBlocked <= outcome.undecided &&
    outcome.retrievalRequested <= 2 &&
    outcome.retrievalPerformed <= 1 &&
    outcome.retrievalPerformed <= outcome.retrievalRequested &&
    outcome.retrievalExpanded + outcome.retrievalNoMatches + outcome.retrievalFailed ===
      outcome.retrievalPerformed &&
    outcome.retrievalFailed <= outcome.undecided &&
    outcome.retrievalNoMatches <= outcome.droppedInsufficientEvidence &&
    outcome.retrievalRequested - outcome.retrievalPerformed <=
      outcome.droppedInsufficientEvidence &&
    outcome.challengePlanned <= 1 &&
    outcome.challengeRetrievalPerformed <= outcome.challengePlanned &&
    outcome.challengeExpanded + outcome.challengeNoMatches <= outcome.challengeRetrievalPerformed &&
    outcome.challengePlanned ===
      outcome.challengeExpanded + outcome.challengeNoMatches + outcome.challengeFailed &&
    outcome.challengeRetrievalPerformed - outcome.challengeExpanded - outcome.challengeNoMatches <=
      outcome.challengeFailed &&
    outcome.challengeFailed <= outcome.undecided &&
    outcome.challengeNoMatches <= outcome.droppedInsufficientEvidence &&
    outcome.challengeExpanded >= outcome.confirmed + outcome.falsifierDefeated
  );
}

function tallyStageCounters(stageCounters, outcome) {
  for (const field of STAGE_COUNTER_FIELDS) stageCounters[field] += outcome[field];
}

function terminalDisposition(outcome) {
  if (outcome.undecided === 1) return "undecided";
  if (outcome.confirmed === 1) return "kept";
  if (outcome.droppedRefuted === 1) return "refuted";
  return "insufficient_evidence";
}

const HISTORICAL_TRACE_TERMINALS = {
  outsideCorroboratedPopulation: {
    stage: "population",
    reasonCode: "outside_corroborated_population",
  },
  missingHistoricalBinding: { stage: "binding", reasonCode: "missing_historical_binding" },
  invalidHistoricalBinding: { stage: "binding", reasonCode: "invalid_historical_binding" },
  findingBodyUnavailable: { stage: "binding", reasonCode: "finding_body_unavailable" },
  sourceUnavailable: { stage: "source", reasonCode: "source_unavailable" },
  evidenceUnavailable: { stage: "evidence", reasonCode: "evidence_unavailable" },
  budget: { stage: "budget", reasonCode: "budget" },
  verificationError: { stage: "verification", reasonCode: "verification_error" },
};

function historicalTraceEntry(databaseId, reason, usage = { callCount: 0, tokens: 0 }) {
  const terminal = HISTORICAL_TRACE_TERMINALS[reason];
  if (terminal === undefined) throw new Error("unknown historical diagnostic terminal");
  return {
    databaseId,
    stage: terminal.stage,
    disposition: "unmeasured",
    reasonCode: terminal.reasonCode,
    usage: { callCount: usage.callCount, tokens: usage.tokens },
  };
}

/**
 * Runs one finding per substantiation call so `undecided` can never be attributed to the wrong id.
 * The function itself receives no labels or replies. They cannot leak through an accidental spread
 * because they do not exist at this boundary.
 */
export async function runHistoricalReplayVerification({
  databaseIds,
  cases,
  repo,
  maxTokens,
  judgeEndpoint,
  readChangeAtCommits = readHistoricalChangeAtCommits,
  buildChangeEvidence,
  mappedBaseRangeFromUnifiedDiff,
  collectInitialRepositoryContext,
  collectRepositoryContextFollowUp,
  toRetrievedEvidence,
  substantiate,
  captureDiagnosticTrace = false,
}) {
  const { caseIds } = assertDecisionInputs(databaseIds, cases);
  if (
    typeof buildChangeEvidence !== "function" ||
    typeof mappedBaseRangeFromUnifiedDiff !== "function" ||
    typeof collectInitialRepositoryContext !== "function" ||
    typeof collectRepositoryContextFollowUp !== "function" ||
    typeof toRetrievedEvidence !== "function" ||
    typeof substantiate !== "function"
  ) {
    throw new Error("historical replay verification dependencies are required");
  }
  const decisionById = new Map(databaseIds.map((databaseId) => [databaseId, "unmeasured"]));
  const reasons = fixedReasonCounts();
  reasons.outsideCorroboratedPopulation = databaseIds.length - caseIds.size;
  const corroboratedDecisions = { keep: 0, drop: 0, unmeasured: 0 };
  const stageCounters = emptyStageCounters();
  const diagnosticById = new Map();
  if (captureDiagnosticTrace) {
    for (const databaseId of databaseIds) {
      if (!caseIds.has(databaseId)) {
        diagnosticById.set(
          databaseId,
          historicalTraceEntry(databaseId, "outsideCorroboratedPopulation"),
        );
      }
    }
  }
  let attemptedCases = 0;
  let accountedTokens = 0;

  for (const replayCase of cases) {
    const structural = structuralCaseReason(replayCase);
    if (structural !== undefined) {
      reasons[structural] += 1;
      corroboratedDecisions.unmeasured += 1;
      if (captureDiagnosticTrace) {
        diagnosticById.set(
          replayCase.databaseId,
          historicalTraceEntry(replayCase.databaseId, structural),
        );
      }
      continue;
    }
    let sources;
    try {
      sources = await readChangeAtCommits(repo, replayCase);
    } catch (error) {
      const reason = error instanceof ReplayCaseError ? error.reason : "sourceUnavailable";
      reasons[reason] += 1;
      corroboratedDecisions.unmeasured += 1;
      if (captureDiagnosticTrace) {
        diagnosticById.set(
          replayCase.databaseId,
          historicalTraceEntry(replayCase.databaseId, reason),
        );
      }
      continue;
    }
    if (!validHistoricalChangeBinding(replayCase, sources)) {
      reasons.sourceUnavailable += 1;
      corroboratedDecisions.unmeasured += 1;
      if (captureDiagnosticTrace) {
        diagnosticById.set(
          replayCase.databaseId,
          historicalTraceEntry(replayCase.databaseId, "sourceUnavailable"),
        );
      }
      continue;
    }
    const judgeable = {
      path: replayCase.path,
      basePath: sources.oldPath,
      content: replayCase.content,
      startLine: replayCase.startLine,
      endLine: replayCase.endLine,
    };
    const anchorText = sourceLines(
      sources.headSource ?? sources.baseSource,
      replayCase.startLine,
      replayCase.endLine,
    );
    if (anchorText === undefined) {
      reasons.evidenceUnavailable += 1;
      corroboratedDecisions.unmeasured += 1;
      if (captureDiagnosticTrace) {
        diagnosticById.set(
          replayCase.databaseId,
          historicalTraceEntry(replayCase.databaseId, "evidenceUnavailable"),
        );
      }
      continue;
    }
    const findingAnchor = { startLine: replayCase.startLine, endLine: replayCase.endLine };
    const baseFindingAnchor =
      sources.headSource === undefined
        ? findingAnchor
        : mappedBaseRangeFromUnifiedDiff(sources.unifiedDiff, findingAnchor);
    const repositoryRequest = {
      repositoryPath: repo,
      pathValue: FIXED_PATH,
      head: sources.headCommitOid,
      base: sources.baseCommitOid,
      reviewPath: replayCase.path,
      baseReviewPath: sources.oldPath,
      findingAnchor,
      ...(baseFindingAnchor === undefined ? {} : { baseFindingAnchor }),
      findingContent: replayCase.content,
      anchorText,
      unifiedDiff: sources.unifiedDiff,
    };
    let repositoryContext;
    try {
      repositoryContext = await collectInitialRepositoryContext(repositoryRequest);
    } catch {
      reasons.evidenceUnavailable += 1;
      corroboratedDecisions.unmeasured += 1;
      if (captureDiagnosticTrace) {
        diagnosticById.set(
          replayCase.databaseId,
          historicalTraceEntry(replayCase.databaseId, "evidenceUnavailable"),
        );
      }
      continue;
    }
    let evidence;
    try {
      evidence = buildChangeEvidence(sources.headSource, sources.baseSource, judgeable, {
        unifiedDiff: sources.unifiedDiff,
        repositoryContext,
      }).text;
    } catch {
      evidence = "";
    }
    if (typeof evidence !== "string" || evidence === "") {
      reasons.evidenceUnavailable += 1;
      corroboratedDecisions.unmeasured += 1;
      if (captureDiagnosticTrace) {
        diagnosticById.set(
          replayCase.databaseId,
          historicalTraceEntry(replayCase.databaseId, "evidenceUnavailable"),
        );
      }
      continue;
    }
    const remainingTokens = maxTokens - accountedTokens;
    if (remainingTokens <= 0) {
      reasons.budget += 1;
      corroboratedDecisions.unmeasured += 1;
      if (captureDiagnosticTrace) {
        diagnosticById.set(
          replayCase.databaseId,
          historicalTraceEntry(replayCase.databaseId, "budget"),
        );
      }
      continue;
    }

    attemptedCases += 1;
    let outcome;
    let candidateTrace;
    try {
      outcome = await substantiate(
        [judgeable],
        () => evidence,
        judgeEndpoint,
        HISTORICAL_REPLAY_STRICTNESS,
        remainingTokens,
        async ({ terms, challengeAxis, knownProvenance }) => {
          const sourceSide =
            challengeAxis === "base" ||
            (challengeAxis === "same_file_contract" && sources.headSource === undefined)
              ? "B"
              : "H";
          const followUp = await collectRepositoryContextFollowUp(repositoryRequest, terms, {
            sourceSide,
          });
          return toRetrievedEvidence(followUp, knownProvenance);
        },
        captureDiagnosticTrace
          ? (trace) => {
              if (candidateTrace !== undefined) {
                throw new Error("historical diagnostic emitted more than one terminal trace");
              }
              candidateTrace = {
                databaseId: replayCase.databaseId,
                stage: trace.stage,
                disposition: trace.disposition,
                reasonCode: trace.reasonCode,
                usage: {
                  callCount: trace.usage?.callCount,
                  tokens: trace.usage?.tokens,
                },
              };
            }
          : undefined,
      );
    } catch {
      // A thrown verifier cannot report what it spent. It received the complete remaining hard
      // allowance, so conservatively retire that allowance before considering another case.
      accountedTokens = maxTokens;
      reasons.verificationError += 1;
      corroboratedDecisions.unmeasured += 1;
      if (captureDiagnosticTrace) {
        diagnosticById.set(
          replayCase.databaseId,
          historicalTraceEntry(replayCase.databaseId, "verificationError", {
            callCount: 0,
            tokens: remainingTokens,
          }),
        );
      }
      continue;
    }
    if (!validSubstantiationOutcome(outcome, judgeable)) {
      reasons.verificationError += 1;
      corroboratedDecisions.unmeasured += 1;
      // The outcome cannot be trusted for accounting. The verifier was nevertheless capped at the
      // remaining allowance, so exhausting the local ledger prevents a second spend of it.
      accountedTokens = maxTokens;
      if (captureDiagnosticTrace) {
        diagnosticById.set(
          replayCase.databaseId,
          historicalTraceEntry(replayCase.databaseId, "verificationError", {
            callCount: 0,
            tokens: remainingTokens,
          }),
        );
      }
      continue;
    }
    if (outcome.tokens > remainingTokens) {
      throw new Error("substantiation exceeded the historical replay token allowance");
    }
    accountedTokens += outcome.tokens;
    if (captureDiagnosticTrace) {
      if (
        candidateTrace === undefined ||
        candidateTrace.usage.tokens !== outcome.tokens ||
        candidateTrace.disposition !== terminalDisposition(outcome) ||
        diagnosticById.has(replayCase.databaseId)
      ) {
        throw new Error("historical diagnostic terminal trace is missing or inconsistent");
      }
      diagnosticById.set(replayCase.databaseId, candidateTrace);
    }
    tallyStageCounters(stageCounters, outcome);
    if (outcome.budgetBlocked > 0) {
      reasons.budget += 1;
      corroboratedDecisions.unmeasured += 1;
      continue;
    }
    if (outcome.undecided > 0) {
      reasons.verificationUndecided += 1;
      corroboratedDecisions.unmeasured += 1;
      continue;
    }
    const decision = outcome.findings.length === 1 ? "keep" : "drop";
    decisionById.set(replayCase.databaseId, decision);
    corroboratedDecisions[decision] += 1;
  }

  const populationDecisions = { keep: 0, drop: 0, unmeasured: 0 };
  const decisions = databaseIds.map((databaseId) => {
    const decision = decisionById.get(databaseId);
    populationDecisions[decision] += 1;
    return { databaseId, decision };
  });
  return {
    decisions,
    ...(captureDiagnosticTrace
      ? { diagnosticCases: databaseIds.map((databaseId) => diagnosticById.get(databaseId)) }
      : {}),
    report: {
      populationRecords: databaseIds.length,
      corroboratedCases: cases.length,
      attemptedCases,
      estimatedAttemptedTokens: attemptedCases * HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE,
      accountedTokens,
      configuredMaxTokens: maxTokens,
      populationDecisions,
      corroboratedDecisions,
      stageCounters,
      unmeasuredByReason: reasons,
    },
  };
}

/** Only aggregate data enters the durable report; ids, paths, commits, bodies, and replies do not. */
export function buildRedactedHistoricalReplayEvidence({
  generatedAt,
  harvestSha256,
  holdoutFromPullRequest,
  endpoint,
  implementation,
  plan,
  execution,
  score,
}) {
  if (
    !FULL_OBJECT_ID.test(implementation.reviewerTree) &&
    implementation.reviewerTree !== "unknown"
  ) {
    throw new Error("reviewer tree binding is malformed");
  }
  return {
    schemaVersion: 5,
    artifact: HISTORICAL_REPLAY_EVIDENCE_ARTIFACT,
    generatedAt,
    scope: {
      measuredStage: "post-generation-truth-contract-challenge-falsifier-workflow",
      historicalHeadSource: "immutable GitHub originalCommit for the review comment",
      historicalBaseSource:
        "unique merge-base of harvested current target ref and original review commit",
      historicalDiffSource:
        "exact single-change unified diff from derived merge-base to immutable originalCommit",
      repositoryContextSource:
        "bounded exact originalCommit and derived-merge-base trees with optional truth retrieval and mandatory contract challenge retrieval",
      verificationWorkflow:
        "truth judge, optional truth retrieval and rerun, mandatory independent contract challenge, adversarial falsifier",
      pullRequestEventBase: "not available in harvest; not measured",
      candidateGeneration: "not measured",
      classificationAndPrWideRanking: "not measured",
      endToEndRecall: "not measured",
    },
    binding: {
      model: QUALIFICATION_MODEL,
      protocol: "openai",
      strictness: HISTORICAL_REPLAY_STRICTNESS,
      harvestSha256,
      endpointSha256: sha256(endpoint),
      reviewerTree: implementation.reviewerTree,
      sourceSha256: implementation.sourceSha256,
    },
    budget: {
      estimatedTokensPerCase: HISTORICAL_REPLAY_ESTIMATED_TOKENS_PER_CASE,
      configuredMaxTokens: plan.configuredMaxTokens,
      estimatedStartWorkTokens: plan.estimatedStartWorkTokens,
      estimatedMaximumEndpointRequests: plan.estimatedMaximumEndpointRequests,
    },
    plan,
    execution,
    holdoutFromPullRequest,
    score,
  };
}

function cleanReviewerTree() {
  try {
    const dirty = String(
      runGit(REPOSITORY_ROOT, ["status", "--porcelain=v1", "--untracked-files=normal"], {
        encoding: "utf8",
      }),
    ).trim();
    // A paid replay is release evidence. Per-file digests are useful inspection aids, but only the
    // clean Git tree closes over every transitive runtime dependency (including retrieval tools).
    // Refuse before loading the model client rather than attach results to mutable source bytes.
    if (dirty !== "") {
      throw new Error("historical replay execute requires a clean reviewer worktree");
    }
    const tree = String(
      runGit(REPOSITORY_ROOT, ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }),
    ).trim();
    if (!FULL_OBJECT_ID.test(tree)) {
      throw new Error("historical replay could not bind the reviewer tree");
    }
    return tree;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("historical replay")) throw error;
    throw new Error("historical replay could not bind a clean reviewer tree", { cause: error });
  }
}

function sourceDigests() {
  const files = {
    driver: join(HERE, "historical-replay.mjs"),
    scorer: join(HERE, "historical-replay-lib.mjs"),
    evidenceBuilder: join(REPOSITORY_ROOT, "src", "publish", "evidence.ts"),
    repositoryContext: join(REPOSITORY_ROOT, "src", "publish", "repository-context.ts"),
    retrievedEvidence: join(REPOSITORY_ROOT, "src", "publish", "retrieved-evidence.ts"),
    substantiation: join(REPOSITORY_ROOT, "src", "publish", "substantiate.ts"),
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, path]) => [name, sha256(readFileSync(path))]),
  );
}

async function productionVerificationDependencies() {
  registerTsExtensionHooks();
  const [
    { buildChangeEvidence, mappedBaseRangeFromUnifiedDiff },
    { collectInitialRepositoryContext, collectRepositoryContextFollowUp },
    { toRetrievedEvidence },
    { substantiate },
  ] = await Promise.all([
    import("../src/publish/evidence.ts"),
    import("../src/publish/repository-context.ts"),
    import("../src/publish/retrieved-evidence.ts"),
    import("../src/publish/substantiate.ts"),
  ]);
  return {
    buildChangeEvidence,
    mappedBaseRangeFromUnifiedDiff,
    collectInitialRepositoryContext,
    collectRepositoryContextFollowUp,
    toRetrievedEvidence,
    substantiate,
  };
}

function formatPlan(plan, writeLine) {
  writeLine("historical replay plan (no model call has run)");
  writeLine(`  population records:          ${String(plan.populationRecords)}`);
  writeLine(`  corroborated cases:          ${String(plan.corroboratedCases)}`);
  writeLine(`  original/derived-base/path bound: ${String(plan.locallyBoundCases)}`);
  writeLine(`  estimated affordable cases:  ${String(plan.estimatedAffordableCases)}`);
  writeLine(`  estimated cost excess cases: ${String(plan.estimatedCostExcessCases)}`);
  writeLine(`  estimated start-work tokens: ${String(plan.estimatedStartWorkTokens)}`);
  writeLine(`  configured max tokens:       ${String(plan.configuredMaxTokens)}`);
  writeLine(`  estimated max requests:      ${String(plan.estimatedMaximumEndpointRequests)}`);
  writeLine(`  model / strictness:          ${QUALIFICATION_MODEL} / paranoid`);
}

function percentage(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/**
 * Claims the final report path before a paid request can run, then writes through that exact open
 * file rather than resolving the path again. A failed run deliberately leaves its private empty
 * reservation behind: unlinking by path after closing the descriptor could delete a file another
 * process placed there in the meantime.
 */
function reserveHistoricalReplayOutput(output, argumentName = "--out") {
  const descriptor = openSync(output, "wx", 0o600);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeSync(descriptor);
  };
  const assertOwnsPath = () => {
    let pathStats;
    try {
      pathStats = lstatSync(output);
    } catch (error) {
      throw new Error(`historical replay output reservation no longer owns ${argumentName}`, {
        cause: error,
      });
    }
    const descriptorStats = fstatSync(descriptor);
    if (pathStats.dev !== descriptorStats.dev || pathStats.ino !== descriptorStats.ino) {
      throw new Error(`historical replay output reservation no longer owns ${argumentName}`);
    }
  };
  try {
    // `mode` is filtered through the process umask at creation. Set the promised final mode on the
    // already-open file, without reopening a pathname that another process could replace.
    fchmodSync(descriptor, 0o600);
  } catch (error) {
    close();
    throw error;
  }
  return {
    write(text) {
      if (closed) throw new Error("historical replay output reservation is already closed");
      try {
        assertOwnsPath();
        writeFileSync(descriptor, text, { encoding: "utf8" });
        fchmodSync(descriptor, 0o600);
        fsyncSync(descriptor);
        assertOwnsPath();
      } finally {
        close();
      }
    },
    close,
  };
}

/** Importable command entry point; dependencies are injectable so its dry path is hermetic. */
export async function runHistoricalReplayCommand(argv, env = process.env, dependencies = {}) {
  const args = parseHistoricalReplayArgs(argv);
  requireHistoricalReplayModel(env);
  const repositoryRoot = dependencies.repositoryRoot ?? REPOSITORY_ROOT;
  const harvest = readHistoricalHarvest(args.harvestPath, repositoryRoot);
  const dataset = extractHistoricalReplayDataset(harvest.document);
  // Validate the chronological boundary before a paid dependency is imported. An empty holdout
  // discovered after verification would spend the whole budget to produce no transfer check.
  buildHistoricalReplayReport({
    records: dataset.records,
    decisions: dataset.records.map((record) => ({
      databaseId: record.databaseId,
      decision: "unmeasured",
    })),
    holdoutFromPullRequest: args.holdoutFromPullRequest,
  });
  const repo = (dependencies.resolveRepo ?? resolveConsumerGitRoot)(args.repoPath);
  const readChangeAtCommits = dependencies.readChangeAtCommits ?? readHistoricalChangeAtCommits;
  const plan = await buildHistoricalReplayPlan({
    ...dataset,
    repo,
    maxTokens: args.maxTokens,
    readChangeAtCommits,
  });
  const lines = [];
  formatPlan(plan, (line) => lines.push(line));
  if (args.mode === "dry-run") return { mode: "dry-run", plan, lines };
  // Resolve the complete implementation binding before endpoint credentials or model-facing code
  // are touched. Tests may inject an equivalent immutable binding; production must prove HEAD is
  // clean so one tree id covers the entire transitive verifier and retrieval closure.
  const implementation =
    dependencies.implementation ??
    (
      dependencies.resolveImplementation ??
      (() => ({
        reviewerTree: cleanReviewerTree(),
        sourceSha256: sourceDigests(),
      }))
    )();
  if (!FULL_OBJECT_ID.test(implementation.reviewerTree)) {
    throw new Error("historical replay requires a 40-hex clean reviewer tree binding");
  }
  const judgeEndpoint = historicalReplayJudgeEndpoint(env);
  const output = realLocation(resolve(args.outPath));
  if (output === harvest.location) throw new Error("--out must not overwrite the raw harvest");
  let diagnosticOutput;
  if (args.diagnosticTraceOutPath !== undefined) {
    diagnosticOutput = realLocation(resolve(args.diagnosticTraceOutPath));
    if (!escapesRepository(repositoryRoot, diagnosticOutput)) {
      throw new Error("--diagnostic-trace-out must be outside this repository");
    }
    if (diagnosticOutput === harvest.location || diagnosticOutput === output) {
      throw new Error("--diagnostic-trace-out must not overwrite another replay input or output");
    }
  }
  const diagnosticReservation =
    diagnosticOutput === undefined
      ? undefined
      : reserveHistoricalReplayOutput(diagnosticOutput, "--diagnostic-trace-out");
  let reservation;
  try {
    reservation = reserveHistoricalReplayOutput(output);
  } catch (error) {
    diagnosticReservation?.close();
    throw error;
  }
  try {
    // The exact final path is now ours. Nothing model-facing is even imported before that atomic
    // claim succeeds, so an existing artifact cannot consume endpoint requests and fail at write.
    const loaded = await (
      dependencies.loadVerificationDependencies ?? productionVerificationDependencies
    )();
    const verification = await runHistoricalReplayVerification({
      databaseIds: dataset.records.map((record) => record.databaseId),
      cases: dataset.cases,
      repo,
      maxTokens: args.maxTokens,
      judgeEndpoint,
      readChangeAtCommits,
      buildChangeEvidence: loaded.buildChangeEvidence,
      mappedBaseRangeFromUnifiedDiff: loaded.mappedBaseRangeFromUnifiedDiff,
      collectInitialRepositoryContext: loaded.collectInitialRepositoryContext,
      collectRepositoryContextFollowUp: loaded.collectRepositoryContextFollowUp,
      toRetrievedEvidence: loaded.toRetrievedEvidence,
      substantiate: loaded.substantiate,
      captureDiagnosticTrace: diagnosticReservation !== undefined,
    });
    const score = buildHistoricalReplayReport({
      records: dataset.records,
      decisions: verification.decisions,
      holdoutFromPullRequest: args.holdoutFromPullRequest,
    });
    const report = buildRedactedHistoricalReplayEvidence({
      generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      harvestSha256: harvest.sha256,
      holdoutFromPullRequest: args.holdoutFromPullRequest,
      endpoint: judgeEndpoint.endpoint,
      implementation,
      plan,
      execution: verification.report,
      score,
    });
    const diagnostic =
      diagnosticReservation === undefined
        ? undefined
        : buildHistoricalReplayDiagnostic({
            databaseIds: dataset.records.map((record) => record.databaseId),
            cases: verification.diagnosticCases,
            attemptedCases: verification.report.attemptedCases,
            accountedTokens: verification.report.accountedTokens,
          });
    if (diagnostic !== undefined) {
      diagnosticReservation.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    }
    reservation.write(`${JSON.stringify(report, null, 2)}\n`);
    lines.push(`  redacted report: ${output}`);
    lines.push(`  after precision: ${percentage(score.all.after.metrics.precision)}`);
    lines.push(
      `  holdout precision: ${percentage(score.chronological.holdout.after.metrics.precision)}`,
    );
    return {
      mode: "execute",
      plan,
      report,
      output,
      lines,
      ...(diagnostic === undefined ? {} : { diagnostic, diagnosticOutput }),
    };
  } catch (error) {
    reservation.close();
    diagnosticReservation?.close();
    throw error;
  }
}

async function main() {
  try {
    const result = await runHistoricalReplayCommand(process.argv.slice(2));
    for (const line of result.lines) console.log(line);
    if (result.mode === "dry-run") {
      console.log("dry-run complete: zero endpoint requests, zero model tokens spent");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "historical replay failed");
    console.error(USAGE);
    process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
