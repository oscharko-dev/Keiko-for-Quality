import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CommitSha } from "./core/brands.js";
import {
  SUPPORTED_STORE_SCHEMA,
  readStore,
  serializeStore,
  type CacheStore,
} from "./cache/review-cache.js";
import { parseGuidelinePaths } from "./config/guidelines.js";
import { loadReviewProfile, type CompiledProfile } from "./config/profile.js";
import { parseRuntimeConfig, type RuntimeConfig } from "./config/runtime.js";
import { verdictsSurviveIncompleteness } from "./engine/settle.js";
import { mergeBase, resolveRef, resolveTargetBranchTip, type GitContext } from "./git/plumbing.js";
import { splitTitle } from "./publish/presentation.js";
import { sanitizeFindingBody } from "./publish/sanitize.js";
import {
  performLocalReview,
  type LocalReviewFinding,
  type LocalReviewReport,
  type LocalReviewRequest,
} from "./review.js";
import { createDiagnostics } from "./diagnostics/sink.js";
import { renderJsonReport } from "./report/json.js";
import { renderSarifReport } from "./report/sarif.js";
import {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  type FindingCategory,
  type FindingSeverity,
  type ReportFinding,
  type ReportInput,
} from "./report/types.js";

/**
 * The one-shot local CLI entry point (issue #96) — `npm run review`.
 *
 * This turns the same orchestrator the GitHub Action drives (`performReview` /
 * `src/review.ts`) into a tool a developer can run against their own working copy: no GitHub
 * token, nothing written into the reviewed repository, and an exit code that carries the
 * settlement outcome distinctly from "no findings" (epic #94's own invariants).
 *
 * ---
 *
 * ## Local orchestrator contract
 *
 * `LocalReviewRequest`, `LocalReviewFinding`, and `LocalReviewReport` are `src/review.ts`'s own
 * exported contract (epic #94, issue #95 — the publication-free decomposition of `performReview`),
 * re-exported here so `src/cli.test.ts` and any CLI-facing consumer keep one import site.
 *
 * The whole rest of this file is written against that contract through exactly one seam:
 * `runLocalReview` (see `MainDeps`), a plain function of `LocalReviewRequest => Promise<
 * LocalReviewReport>`. The bootstrap at the bottom of this file binds `performLocalReview` to it,
 * with diagnostics on stderr — stdout belongs to the report (`--out` defaults there).
 */
export type { LocalReviewRequest, LocalReviewFinding, LocalReviewReport } from "./review.js";

/** Local aliases for the report's nested shapes, derived — never re-declared — from the contract. */
type LocalReviewSpend = LocalReviewReport["spend"];
type LocalReviewInventory = LocalReviewReport["inventory"];

export type RunLocalReview = (request: LocalReviewRequest) => Promise<LocalReviewReport>;

/**
 * Exit-code contract (issue #96) — the settlement outcome, never conflated with "no findings"
 * (epic #94). `--help` and a successful run share no code with a failure: `0` is reserved for a
 * genuinely clean review, not merely for "the process did not crash".
 */
export const EXIT_CODE = {
  completeClean: 0,
  completeWithFindings: 1,
  incomplete: 2,
  abandoned: 3,
  usageError: 4,
  internalError: 5,
} as const;

const MIN_NODE_MAJOR = 24;

/** `undefined` when `versionString` satisfies the minimum; otherwise the one-line message to print. */
export function checkNodeVersion(versionString: string): string | undefined {
  const major = Number(/^v?(\d+)\./.exec(versionString)?.[1]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return undefined;
  return (
    `keiko-for-quality requires Node ${String(MIN_NODE_MAJOR)} or newer (found ${versionString}). ` +
    "Install a newer Node and try again."
  );
}

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

interface RawArgs {
  repo?: string;
  profile?: string;
  targetBranch?: string;
  base?: string;
  head?: string;
  guidelines?: string;
  store?: string;
  out?: string;
  format?: string;
  fileTimeoutSeconds?: string;
  reviewTimeoutSeconds?: string;
  tokenBudget?: string;
  maxFindings?: string;
  concurrency?: string;
  help: boolean;
}

type StringFlagField = Exclude<keyof RawArgs, "help">;

/**
 * Every `--flag <value>` this CLI accepts, mapped to the `RawArgs` field it fills.
 *
 * Exported for one reason. `--help` is this tool's authoritative flag reference — AGENTS.md defers
 * to `npm run review -- --help` and forbids restating the list anywhere else — so a flag that is
 * registered here but missing from `HELP_TEXT` has no listing a user can reach at all. That already
 * happened to `--format`: registered below, vocabulary-checked in `validateParsedArgs`, defaulted in
 * `resolveCliArgs` and dispatched in `renderReport`, yet absent from the help for the whole of its
 * first release, while docs/cli-asset-pin.md named it part of the process contract IDE extensions
 * pin by digest. `src/cli.test.ts` now walks these keys and demands an Options row for each, which
 * turns "add a flag, forget the help row" from an invisible documentation hole into a red test.
 */
export const STRING_FLAGS: Readonly<Record<string, StringFlagField>> = {
  "--repo": "repo",
  "--profile": "profile",
  "--target-branch": "targetBranch",
  "--base": "base",
  "--head": "head",
  "--guidelines": "guidelines",
  "--store": "store",
  "--out": "out",
  "--format": "format",
  "--file-timeout-seconds": "fileTimeoutSeconds",
  "--review-timeout-seconds": "reviewTimeoutSeconds",
  "--token-budget": "tokenBudget",
  "--max-findings": "maxFindings",
  "--concurrency": "concurrency",
};

export type ParseArgsResult =
  | { readonly ok: true; readonly values: RawArgs }
  | { readonly ok: false; readonly message: string };

/**
 * Hand-rolled, zero dependencies: `--flag <value>` pairs only, matching every example in issue
 * #96. Purely syntactic — a numeric-looking flag's actual bounds are enforced once, by
 * `parseRuntimeConfig`, not restated here (see `buildRuntimeConfig`).
 */
export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const values: RawArgs = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) break;
    if (token === "--help" || token === "-h") {
      values.help = true;
      continue;
    }
    const field = STRING_FLAGS[token];
    if (field === undefined) return { ok: false, message: `unknown option: ${token}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `${token} requires a value` };
    }
    values[field] = value;
    i += 1;
  }
  return validateParsedArgs(values);
}

/** Cross-flag checks that need the whole parse, split from `parseArgs` to stay under the
 *  complexity ceiling: mutual exclusion and the `--format` vocabulary. */
function validateParsedArgs(values: RawArgs): ParseArgsResult {
  if (values.base !== undefined && values.targetBranch !== undefined) {
    return { ok: false, message: "--base and --target-branch are mutually exclusive" };
  }
  if (values.format !== undefined && !REPORT_FORMATS.includes(values.format as ReportFormat)) {
    return { ok: false, message: `--format must be one of: ${REPORT_FORMATS.join(", ")}` };
  }
  return { ok: true, values };
}

/** Which ref names the base: an explicit override, or the target-branch auto-resolution policy. */
export type BaseSelection =
  | { readonly kind: "explicit"; readonly ref: string }
  | { readonly kind: "targetBranch"; readonly name: string };

/** Output format for the final report. `human` is the default; the other two delegate to
 *  `src/report/` (issue #97's renderers) over the shared 0-anchor and optional-classification
 *  conventions documented in docs/local-report-schema.md. */
export type ReportFormat = "human" | "json" | "sarif";

const REPORT_FORMATS: readonly ReportFormat[] = ["human", "json", "sarif"];

export interface CliArgs {
  readonly repositoryPath: string;
  readonly profilePath: string;
  readonly baseSelection: BaseSelection;
  readonly head: string;
  readonly guidelines: string;
  readonly store?: string;
  readonly out?: string;
  readonly format: ReportFormat;
  /** Resolved with defaults already applied — see `RUNTIME_FLAG_DEFAULTS`. Bounds (min/max,
   *  integer-ness) are deliberately NOT checked here; `parseRuntimeConfig` checks them once,
   *  reused rather than restated (see `buildRuntimeConfig`). */
  readonly fileTimeoutSeconds: number;
  readonly reviewTimeoutSeconds: number;
  readonly tokenBudget: number;
  readonly maxFindings: number;
  readonly concurrency: number;
}

const DEFAULT_TARGET_BRANCH = "dev";
const DEFAULT_PROFILE_RELATIVE_PATH = ".github/keiko-for-quality.json";

/** Mirrors `action.yml`'s own defaults exactly. */
const RUNTIME_FLAG_DEFAULTS = {
  concurrency: 4,
  fileTimeoutSeconds: 300,
  reviewTimeoutSeconds: 1800,
  tokenBudget: 2_000_000,
  maxFindings: 50,
} as const;

function resolveBaseSelection(raw: RawArgs): BaseSelection {
  if (raw.base !== undefined) return { kind: "explicit", ref: raw.base };
  return { kind: "targetBranch", name: raw.targetBranch ?? DEFAULT_TARGET_BRANCH };
}

/**
 * Leaves an unparseable value as `NaN` rather than substituting the fallback: `NaN` fails
 * `parseRuntimeConfig`'s own `Number.isInteger` check the same way any other malformed value
 * does, so a garbled `--token-budget` is reported through that one existing validator, not a
 * second, ad hoc one here.
 */
function toNumber(raw: string | undefined, fallback: number): number {
  return raw === undefined ? fallback : Number(raw);
}

/**
 * Applies defaults that need runtime context (`cwd`) — kept apart from `parseArgs` so parsing
 * itself stays a pure function of `argv` alone, which is what makes "each flag, defaults, bad
 * values" independently testable per the flag rather than only through a full `runCli` pass.
 */
export function resolveCliArgs(raw: RawArgs, cwd: string): CliArgs {
  const repositoryPath = resolve(cwd, raw.repo ?? ".");
  const profilePath = resolve(repositoryPath, raw.profile ?? DEFAULT_PROFILE_RELATIVE_PATH);
  return {
    repositoryPath,
    profilePath,
    baseSelection: resolveBaseSelection(raw),
    head: raw.head ?? "HEAD",
    guidelines: raw.guidelines ?? "",
    ...(raw.store === undefined ? {} : { store: raw.store }),
    ...(raw.out === undefined ? {} : { out: raw.out }),
    // Already vetted by `parseArgs` against REPORT_FORMATS; the cast never widens beyond it.
    format: (raw.format as ReportFormat | undefined) ?? "human",
    fileTimeoutSeconds: toNumber(raw.fileTimeoutSeconds, RUNTIME_FLAG_DEFAULTS.fileTimeoutSeconds),
    reviewTimeoutSeconds: toNumber(
      raw.reviewTimeoutSeconds,
      RUNTIME_FLAG_DEFAULTS.reviewTimeoutSeconds,
    ),
    tokenBudget: toNumber(raw.tokenBudget, RUNTIME_FLAG_DEFAULTS.tokenBudget),
    maxFindings: toNumber(raw.maxFindings, RUNTIME_FLAG_DEFAULTS.maxFindings),
    concurrency: toNumber(raw.concurrency, RUNTIME_FLAG_DEFAULTS.concurrency),
  };
}

// ---------------------------------------------------------------------------------------------
// Runtime configuration, profile, guidelines
// ---------------------------------------------------------------------------------------------

/** Mirrors `action.yml`'s own defaults exactly — this issue exposes no flag for these three. */
const FIXED_RUNTIME_DEFAULTS = {
  language: "English",
  renameDetectionPercent: 50,
  crossArtifactPass: false,
} as const;

/**
 * Builds `RuntimeConfig` from the `KFQ_MODEL_*` environment contract (issue #96) plus the CLI's
 * own timeout/budget/concurrency flags, then hands the whole candidate to `parseRuntimeConfig`
 * (`src/config/runtime.ts`) unchanged. Every bound — endpoint scheme, token env name shape, every
 * numeric range — is enforced there, once, exactly as it is for the action's own
 * `runtimeConfigFromInputs` (`src/action/inputs.ts`): this reuses that SAME validator rather than
 * that function itself, because `runtimeConfigFromInputs` is coupled to the action's `INPUT_*`
 * env-key convention, not to this CLI's `KFQ_*` one — see this file's own header comment.
 */
export function buildRuntimeConfig(env: NodeJS.ProcessEnv, args: CliArgs): RuntimeConfig {
  return parseRuntimeConfig(
    {
      protocol: env.KFQ_MODEL_PROTOCOL,
      endpoint: env.KFQ_MODEL_ENDPOINT,
      model: env.KFQ_MODEL_ID,
      tokenEnvName: env.KFQ_MODEL_TOKEN_ENV,
      language: FIXED_RUNTIME_DEFAULTS.language,
      concurrency: args.concurrency,
      fileTimeoutSeconds: args.fileTimeoutSeconds,
      reviewTimeoutSeconds: args.reviewTimeoutSeconds,
      tokenBudget: args.tokenBudget,
      maxFindings: args.maxFindings,
      renameDetectionPercent: FIXED_RUNTIME_DEFAULTS.renameDetectionPercent,
      crossArtifactPass: FIXED_RUNTIME_DEFAULTS.crossArtifactPass,
    },
    "config",
  );
}

/**
 * Reads the profile from the reviewed repository's own filesystem — the same place
 * `corpus/real-diffs.mjs` and the action's `runAction` (`src/action/main.ts`) both read it from,
 * never a specific commit read through git plumbing: `performReview` itself never loads a
 * profile, and every existing loader treats it as an ordinary file in the checkout the process
 * happens to be pointed at. For the action that checkout is the base ref by virtue of the
 * workflow's own checkout step; for this CLI it is simply `--repo`'s working tree.
 */
async function loadProfile(profilePath: string): Promise<CompiledProfile> {
  let text: string;
  try {
    text = await readFile(profilePath, "utf8");
  } catch {
    throw new Error(`cannot read profile at ${profilePath}`);
  }
  try {
    return loadReviewProfile(text);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`profile at ${profilePath} is invalid${detail}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Base/head resolution
// ---------------------------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 120_000;
const DEFAULT_PATH_VALUE = "/usr/local/bin:/usr/bin:/bin";

function gitContextFor(args: CliArgs, env: NodeJS.ProcessEnv): GitContext {
  return {
    cwd: args.repositoryPath,
    timeoutMs: GIT_TIMEOUT_MS,
    pathValue: env.PATH ?? DEFAULT_PATH_VALUE,
  };
}

/**
 * `--base` is used exactly as given; the target-branch policy composes the existing, independently
 * tested `resolveTargetBranchTip` and `mergeBase` primitives (`src/git/plumbing.ts`) rather than
 * re-deriving merge-base resolution here.
 */
async function resolveBaseHead(
  ctx: GitContext,
  args: CliArgs,
): Promise<{ readonly base: CommitSha; readonly head: CommitSha }> {
  const head = await resolveRef(ctx, args.head, "head");
  if (args.baseSelection.kind === "explicit") {
    return { base: await resolveRef(ctx, args.baseSelection.ref, "base"), head };
  }
  const targetTip = await resolveTargetBranchTip(ctx, args.baseSelection.name);
  return { base: await mergeBase(ctx, targetTip, head), head };
}

// ---------------------------------------------------------------------------------------------
// Review-cache store — reuses `readStore`/`serializeStore` (`src/cache/review-cache.ts`) and
// `verdictsSurviveIncompleteness` (`src/engine/settle.ts`) exactly as `src/action/main.ts` does;
// see that file's `loadCacheStore`/`maybeSaveCacheStore` for the semantics this mirrors.
// ---------------------------------------------------------------------------------------------

const EMPTY_STORE: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };

/** Fail-open: memoization is a pure optimization layer, so a missing or rejected store never gates
 *  the review that follows — it only costs this run whatever re-review a hit would have saved. */
async function loadCacheStore(path: string | undefined): Promise<CacheStore | undefined> {
  if (path === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return EMPTY_STORE;
  }
  const result = readStore(text);
  return result.ok ? result.store : EMPTY_STORE;
}

/**
 * Writes the store back only when `report` allows it: always for `complete`, and for `incomplete`
 * only when the reason leaves the reviewed files' verdicts intact (`verdictsSurviveIncompleteness`)
 * — the identical "written back only on complete, gated on survives-incompleteness" rule
 * `action/main.ts`'s `maybeSaveCacheStore` enforces. A write failure is fail-open, the same
 * direction as a read failure.
 */
async function maybeWriteStore(path: string | undefined, report: LocalReviewReport): Promise<void> {
  if (path === undefined || report.updatedCacheStore === undefined) return;
  if (report.outcome === "incomplete") {
    if (report.reason === undefined || !verdictsSurviveIncompleteness(report.reason)) return;
  } else if (report.outcome !== "complete") {
    return;
  }
  try {
    await writeFile(path, serializeStore(report.updatedCacheStore), "utf8");
  } catch {
    // Lost optimization, not a run failure — see this function's own doc comment.
  }
}

// ---------------------------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------------------------

export interface MainDeps {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly nodeVersion: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly runLocalReview: RunLocalReview;
}

type PrepareResult =
  | { readonly ok: true; readonly request: LocalReviewRequest }
  | { readonly ok: false; readonly message: string };

/**
 * Everything between "arguments are syntactically valid" and "the orchestrator can run": runtime
 * config, profile, guidelines, base/head resolution, and the optional cache store. Every failure
 * here is a usage or configuration error (exit `4`) — never the orchestrator's own `incomplete`,
 * which can only be decided once it actually runs.
 */
async function prepareRequest(deps: MainDeps, args: CliArgs): Promise<PrepareResult> {
  try {
    const config = buildRuntimeConfig(deps.env, args);
    const profile = await loadProfile(args.profilePath);
    const guidelines = parseGuidelinePaths(args.guidelines);
    const ctx = gitContextFor(args, deps.env);
    const { base, head } = await resolveBaseHead(ctx, args);
    const cacheStore = await loadCacheStore(args.store);
    const request: LocalReviewRequest = {
      base,
      head,
      repositoryPath: args.repositoryPath,
      config,
      profile,
      guidelines,
      env: deps.env,
      pathValue: ctx.pathValue,
      ...(cacheStore === undefined ? {} : { cacheStore }),
    };
    return { ok: true, request };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "invalid configuration" };
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering (human) — `--format json|sarif` is issue #97's scope (out of scope here per issue
// #96); this still structures rendering behind one function keyed on a format so a future format
// plugs in without reshaping `runCli` itself.
// ---------------------------------------------------------------------------------------------

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Renders one finding, running `sanitizeFindingBody` again at the terminal boundary rather than
 * trusting the report's own `body` field — the same discipline `publish/` applies before a
 * finding reaches GitHub (AGENTS.md: the rule text and the sanitizer move together). A body the
 * sanitizer rejects is a dropped finding, and per issue #96 that must surface in the output, not
 * vanish silently.
 */
function formatFinding(finding: LocalReviewFinding, index: number): string {
  const location = `${finding.path}:${String(finding.startLine)}-${String(finding.endLine)}`;
  const classification = [finding.category, finding.severity].filter(Boolean).join("/");
  // Named rather than nested inside the header template — the same string either way, but the
  // "no classification means no parenthetical at all" branch reads as its own expression instead of
  // as a template inside a template.
  const classificationSuffix = classification === "" ? "" : ` (${classification})`;
  const header = `[${String(index + 1)}] ${location}${classificationSuffix}`;

  const sanitized = sanitizeFindingBody(finding.body);
  if (!sanitized.ok) {
    return `${header}\n    omitted — failed the publication safety check (${sanitized.reason})`;
  }
  const { title, body } = splitTitle(sanitized.body);
  const lines = title === "" ? [] : [`    ${title}`, ""];
  for (const line of body.split("\n")) lines.push(line === "" ? "" : `    ${line}`);
  return [header, ...lines].join("\n");
}

function renderFindingsSection(findings: readonly LocalReviewFinding[]): string {
  if (findings.length === 0) return "Findings: none.";
  const rendered = findings.map((finding, index) => formatFinding(finding, index));
  return [`Findings (${String(findings.length)}):`, "", ...rendered].join("\n\n");
}

function renderSpend(spend: LocalReviewSpend): string {
  return (
    `Spend: engine ${String(spend.engine)}, classify ${String(spend.classify)}, ` +
    `total ${String(spend.total)} (allotted ${String(spend.allotted)})`
  );
}

function renderInventory(inventory: LocalReviewInventory): string {
  return (
    `Inventory: ${String(inventory.total)} total, ${String(inventory.reviewable)} reviewable, ` +
    `${String(inventory.reviewed)} reviewed`
  );
}

function renderSettlement(report: LocalReviewReport): string {
  if (report.outcome === "complete") {
    return `Settlement: complete — ${String(report.findings.length)} finding(s)`;
  }
  if (report.outcome === "incomplete") {
    return `Settlement: incomplete — reason: ${report.reason ?? "unknown"}`;
  }
  return "Settlement: abandoned — the reviewed head was superseded before the run completed.";
}

interface RunContext {
  readonly repositoryPath: string;
  readonly base: CommitSha;
  readonly head: CommitSha;
}

/** Human-readable rendering (issue #96's only in-scope format). Composed, not templated, so a
 *  `json`/`sarif` sibling can be added later behind the same call site — see this section's
 *  header comment. */
export function renderHuman(report: LocalReviewReport, context: RunContext): string {
  const lines = [
    "Keiko for Quality — local review",
    "",
    `Repository: ${context.repositoryPath}`,
    `Base: ${shortSha(context.base)}  Head: ${shortSha(context.head)}`,
    `Rule digest: ${report.ruleDigest}   Engine: ${report.engineVersion}`,
    "",
    renderFindingsSection(report.findings),
    "",
    renderInventory(report.inventory),
    // Always present since the contract made the counts required: 0/0 is a fact (nothing was
    // cache-eligible), not an absence.
    `Cache: ${String(report.cacheHits)} hits, ${String(report.cacheMisses)} misses`,
    renderSpend(report.spend),
    "",
    renderSettlement(report),
  ];
  return lines.join("\n");
}

/**
 * Writes the rendered report to `outPath` when given, else to `stdout`. A write failure falls
 * back to `stdout` with a warning rather than losing the report: this flag is a convenience, and
 * the settlement-carrying exit code (`exitCodeForReport`) must never be affected by it.
 */
async function emitReport(
  outPath: string | undefined,
  rendered: string,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<void> {
  if (outPath === undefined) {
    stdout(`${rendered}\n`);
    return;
  }
  try {
    await writeFile(outPath, `${rendered}\n`, "utf8");
  } catch {
    stderr(`warning: could not write report to ${outPath}; printing to stdout instead\n`);
    stdout(`${rendered}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// Exit code mapping
// ---------------------------------------------------------------------------------------------

/**
 * The settlement outcome, never conflated with "no findings" (epic #94's own invariant): a
 * `complete` review with findings and an `incomplete` review both leave the pull request — or
 * here, the working copy — effectively unreviewed-by-default from an exit-code consumer's point
 * of view, but only the first is `1`; the second is `2`. An outcome this CLI does not recognise
 * fails closed to `internalError` rather than `completeClean` (CONTRIBUTING.md: "incomplete may
 * never read as clean… a state the settlement logic does not know must fail closed by default").
 */
export function exitCodeForReport(report: LocalReviewReport): number {
  // Widened to `string` deliberately: `report` crosses the orchestrator integration boundary
  // (see this file's header comment) rather than originating from code this function itself
  // controls, and the fail-closed fallback below must stay a REAL runtime check — not one
  // TypeScript's own exhaustiveness analysis would optimise away as unreachable given today's
  // three-member `outcome` type — so a future outcome this CLI does not yet know about still
  // maps to a nonzero, non-clean exit code instead of silently falling through to `undefined`.
  const outcome: string = report.outcome;
  if (outcome === "complete") {
    return report.findings.length === 0 ? EXIT_CODE.completeClean : EXIT_CODE.completeWithFindings;
  }
  if (outcome === "incomplete") return EXIT_CODE.incomplete;
  if (outcome === "abandoned") return EXIT_CODE.abandoned;
  return EXIT_CODE.internalError;
}

// ---------------------------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------------------------

export const HELP_TEXT = `Keiko for Quality — local review CLI

Reviews a local repository's working tree against an auto-resolved (or explicit) base commit,
using the same review engine, rule text, and settlement semantics as the GitHub Action. Nothing
is published anywhere: findings, spend, and the settlement outcome are printed to this terminal
(or written to --out) only. No GitHub token is ever read.

Usage:
  npm run review -- [options]

Options:
  --repo <path>                 Repository to review. Default: current working directory.
  --profile <path>               Review profile JSON. Default: <repo>/.github/keiko-for-quality.json
  --target-branch <name>         Resolve base as merge-base(HEAD, <name>), trying the local branch
                                  then origin/<name>. Default: dev. Mutually exclusive with --base.
  --base <ref>                   Explicit base ref or commit. Mutually exclusive with --target-branch.
  --head <ref>                   Head ref or commit. Default: HEAD.
  --guidelines <paths>           Comma- or newline-separated repository-relative guideline paths.
  --store <path>                 Review-cache store file, read before the run and written back only
                                  on a settlement whose verdicts survive it.
  --out <path>                   Write the report here instead of stdout.
  --format <human|json|sarif>    Report format. Default: human. json and sarif emit the versioned
                                  wire contract (docs/local-report-schema.md).
  --file-timeout-seconds <n>     Per-file engine timeout. Default: 300.
  --review-timeout-seconds <n>   Whole-review wall-clock ceiling. Default: 1800.
  --token-budget <n>             Hard token ceiling for one review. Default: 2000000.
  --max-findings <n>             Findings above this count are treated as implausible. Default: 50.
  --concurrency <n>              Engine review concurrency. Default: 4.
  --help, -h                     Print this help and exit 0.

Environment (model configuration only; no GitHub credential is ever read or forwarded):
  KFQ_MODEL_ENDPOINT   HTTPS endpoint of the model provider.
  KFQ_MODEL_ID         Model identifier.
  KFQ_MODEL_PROTOCOL   Wire protocol: openai or anthropic.
  KFQ_MODEL_TOKEN_ENV  NAME of the environment variable holding the model credential (not the
                       credential itself).

Exit codes:
  0   complete, zero findings
  1   complete, one or more findings
  2   incomplete — treat the change as unreviewed
  3   abandoned — the reviewed head was superseded before the run completed
  4   usage or configuration error
  5   internal error
`;

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

/**
 * Runs the CLI end to end and returns the process exit code — never calls `process.exit` itself,
 * so every caller (the bottom-of-file bootstrap, or a test) controls its own process lifecycle.
 */
export async function runCli(deps: MainDeps): Promise<number> {
  const versionIssue = checkNodeVersion(deps.nodeVersion);
  if (versionIssue !== undefined) {
    deps.stderr(`error: ${versionIssue}\n`);
    return EXIT_CODE.usageError;
  }

  const parsed = parseArgs(deps.argv);
  if (!parsed.ok) {
    deps.stderr(`error: ${parsed.message}\n`);
    return EXIT_CODE.usageError;
  }
  if (parsed.values.help) {
    deps.stdout(HELP_TEXT);
    return EXIT_CODE.completeClean;
  }

  const args = resolveCliArgs(parsed.values, deps.cwd);
  const prepared = await prepareRequest(deps, args);
  if (!prepared.ok) {
    deps.stderr(`error: ${prepared.message}\n`);
    return EXIT_CODE.usageError;
  }

  let report: LocalReviewReport;
  try {
    report = await deps.runLocalReview(prepared.request);
  } catch {
    // The error itself is never printed (mirrors `action/main.ts`'s `main()`): unlike a
    // `prepareRequest` failure, which is always about the operator's own configuration, a thrown
    // review can in principle carry engine output or other content this process should not echo.
    deps.stderr("error: internal error — the review did not complete\n");
    return EXIT_CODE.internalError;
  }

  await maybeWriteStore(args.store, report);
  const context: RunContext = {
    repositoryPath: args.repositoryPath,
    base: prepared.request.base,
    head: prepared.request.head,
  };
  await emitReport(args.out, renderReport(args.format, report, context), deps.stdout, deps.stderr);
  return exitCodeForReport(report);
}

/**
 * Bridges the orchestrator's report to `src/report/`'s renderer input. A pure pass-through today —
 * the two shapes deliberately share field names and the 0-anchor / optional-classification
 * conventions (docs/local-report-schema.md) — kept as a named seam so a future report field lands
 * here once, not in both renderers.
 */
function toReportInput(report: LocalReviewReport): ReportInput {
  return {
    outcome: report.outcome,
    findings: report.findings.map(toReportFinding),
    spend: report.spend,
    inventory: report.inventory,
    ruleDigest: report.ruleDigest,
    engineVersion: report.engineVersion,
    ...(report.reason === undefined ? {} : { reason: report.reason }),
  };
}

/**
 * Narrows the orchestrator's `string`-typed classification onto the renderers' closed vocabulary.
 * A value outside the vocabulary is dropped to "unclassified" rather than passed through or
 * repaired — the renderers' guarantees (fixed SARIF rule set, schema-stable JSON values) only hold
 * over the vocabulary, and a fabricated nearest-match would be exactly the repair this pipeline
 * refuses elsewhere.
 */
function toReportFinding(finding: LocalReviewFinding): ReportFinding {
  const category = (FINDING_CATEGORIES as readonly string[]).includes(finding.category ?? "")
    ? (finding.category as FindingCategory)
    : undefined;
  const severity = (FINDING_SEVERITIES as readonly string[]).includes(finding.severity ?? "")
    ? (finding.severity as FindingSeverity)
    : undefined;
  return {
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    ...(category === undefined ? {} : { category }),
    ...(severity === undefined ? {} : { severity }),
    body: finding.body,
  };
}

/** One switch, exhaustive over `ReportFormat`; `human` keeps its existing renderer untouched. */
function renderReport(
  format: ReportFormat,
  report: LocalReviewReport,
  context: RunContext,
): string {
  if (format === "json") return renderJsonReport(toReportInput(report));
  if (format === "sarif") return renderSarifReport(toReportInput(report));
  return renderHuman(report, context);
}

// ---------------------------------------------------------------------------------------------
// Bootstrap — only runs when this file is executed directly (`npm run review`), never on import
// (`src/cli.test.ts` imports the exports above without triggering any of this).
// ---------------------------------------------------------------------------------------------

/**
 * Binds `performLocalReview` to the CLI's one-argument seam. Diagnostics go to stderr, line by
 * line, exactly as the action writes them to the workflow log — stdout stays reserved for the
 * report itself (`--out` defaults there, and a JSON/SARIF consumer must never have to strip
 * diagnostic lines out of it).
 */
function boundRunLocalReview(request: LocalReviewRequest): Promise<LocalReviewReport> {
  const diagnostics = createDiagnostics((line) => process.stderr.write(`${line}\n`));
  return performLocalReview(request, diagnostics);
}

function isEntryModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryModule()) {
  const exitCode = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    nodeVersion: process.version,
    stdout: (text: string): void => {
      process.stdout.write(text);
    },
    stderr: (text: string): void => {
      process.stderr.write(text);
    },
    runLocalReview: boundRunLocalReview,
  });
  process.exitCode = exitCode;
}
