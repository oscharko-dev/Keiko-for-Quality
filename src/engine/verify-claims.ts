/**
 * Whole-file verification for the claims hunks cannot ground.
 *
 * Measured motivation (2026-08-08, twelve live hours on the consumer): of 82 published findings,
 * 55 were refuted by the reader after verification and 14 led to a fix — a 17% actionable rate.
 * Reading every refutation back gives one dominant mechanism, and it is structural rather than a
 * model deficiency: single-shot shows the model the changed hunks, and the model then makes
 * claims about what the FILE does or does not do. "Reject voice provider records that include
 * `voiceProfiles`" was published against a file whose guard for exactly that sits at line 655 of
 * 1129; "Add handling for the new `imageInputModelIdsConfigured` flag" was published about a flag
 * the file never puts on the wire. Neither claim is checkable from a hunk, and both were argued
 * confidently — because absence is invisible in an excerpt.
 *
 * So this module does not ask the model to be more careful. It gives the missing evidence and
 * asks one bounded question per file: for each claim that needs the whole file, is the claim
 * SUPPORTED by the file, or CONTRADICTED by a line in it? Contradicted claims are dropped before
 * publication; everything else passes through untouched.
 *
 * Three properties keep this honest rather than merely quieter:
 * - **Only claims that need it are asked.** A claim grounded in the hunk (`this added line
 *   dereferences x`) is never sent — see `needsWholeFileEvidence`.
 * - **Failure keeps the finding.** An unreachable endpoint, an unparseable reply, a file too
 *   large to send: every one of them publishes the finding unchanged. A verifier that cannot
 *   answer must not become a silent filter — the same posture `repairRejectableBodies` takes.
 * - **The verdict is per claim, with a line.** The model must cite the line that contradicts, so
 *   a wrong drop is visible in the diagnostics rather than indistinguishable from a quiet run.
 */

import type { Sha256 } from "../core/brands.js";

/** A claim the verifier can be asked about — the shape single-shot's parsed findings satisfy. */
export interface VerifiableClaim {
  readonly content: string;
  readonly start_line: number;
  readonly end_line: number;
}

/**
 * The imperative openings a finding's claim is written with.
 *
 * Every verb below opened at least one finding in the audited window that the reader then
 * refuted, and the list was widened once, against measurement rather than intuition. The first
 * draft carried only the ABSENCE verbs (Add, Ensure, Guard, Reject, Validate, Clear, Handle,
 * Remove …) on the argument that an excerpt can show presence but never absence. Re-grading the
 * window's 55 refutations against that draft showed it selecting 36: the missing 19 were all
 * CHANGE imperatives — "Adjust the header-name expectation to match the parser's normalization",
 * "Replace the use of `import.meta.dirname`", "Restore the original top-level coverage fields" —
 * claims that the code does something it does not do. That is the same question in the other
 * direction, and an excerpt settles it no better: what the file actually does lives in the file.
 * With the change verbs in, the selector covers all 55.
 */
const CLAIM_VERBS = new Set([
  // absence: the file does not do this
  "add",
  "ensure",
  "guard",
  "reject",
  "validate",
  "clear",
  "handle",
  "initialize",
  "reset",
  "remove",
  "prevent",
  "avoid",
  "restrict",
  "require",
  "check",
  // change: the file does this, and does it wrong
  "adjust",
  "update",
  "replace",
  "restore",
  "reinstate",
  "delete",
  "move",
  "propagate",
  "load",
  "exclude",
  "cancel",
  "correct",
  "fix",
  "rename",
  "align",
  "switch",
  "use",
  "make",
  "treat",
  "accept",
]);

/**
 * The first word of the bold imperative title. A word list behind one small pattern rather than a
 * thirty-branch alternation: same language, linear scan, and a reader can see the two groups the
 * measurement above separates.
 */
const TITLE_VERB = /(?:^|\n)\s*\*\*\s*([A-Za-z]+)/u;

/** Prose that states absence or wrongness outright, wherever it sits in the body. */
const CLAIM_PHRASES = [
  "is missing",
  "are missing",
  "does not",
  "doesn't",
  "do not",
  "don't",
  "never clears",
  "never checks",
  "never validates",
  "never resets",
  "never removes",
  "never handles",
  "never guards",
  "no guard",
  "no handling",
  "no validation",
  "no check",
  "no cleanup",
  "without guard",
  "without validation",
  "without checking",
  "fails to",
  "omits",
  "incorrectly",
  "instead of",
];

function opensWithClaimVerb(content: string): boolean {
  const verb = TITLE_VERB.exec(content)?.[1];
  return verb !== undefined && CLAIM_VERBS.has(verb.toLowerCase());
}

function statesClaimInProse(content: string): boolean {
  const text = content.toLowerCase();
  return CLAIM_PHRASES.some((phrase) => text.includes(phrase));
}

/** A backticked identifier the prose leans on as evidence. */
const BACKTICKED = /`([A-Za-z_$][\w$]*)`/gu;

/**
 * Whether a claim needs the whole file before it can be trusted.
 *
 * Two independent triggers, either of which means the hunk cannot settle the question:
 *
 * 1. **It claims the file does, or fails to do, something.** "Add X", "no validation for Z",
 *    "Adjust Y to match the parser's normalization" — every one of those is a statement about the
 *    file, and an excerpt is not a file.
 * 2. **It leans on a symbol the model was not shown.** When the prose cites `someHelper` and
 *    `someHelper` appears nowhere in the rendered diff, the model is reasoning about code outside
 *    its context — the exact posture that produced the semantics-level refutations.
 *
 * A claim that trips neither is grounded in what the model actually read, and is not sent. The
 * cost of the wider net is bounded by construction: verification is ONE call per file, batched
 * over that file's claims, so a file whose findings all qualify costs exactly what a file with a
 * single qualifying claim costs.
 */
export function needsWholeFileEvidence(content: string, renderedDiff: string): boolean {
  if (opensWithClaimVerb(content) || statesClaimInProse(content)) return true;
  const symbols = [...content.matchAll(BACKTICKED)].map((m) => m[1]);
  return symbols.some((symbol) => symbol !== undefined && !shownWholeWord(symbol, renderedDiff));
}

/**
 * Whether the diff actually shows this identifier, rather than merely containing its letters.
 *
 * A substring test reads `cat` as shown by `concatenate`, which is the wrong direction to be
 * wrong in: it would mark a claim as grounded when the model never saw the symbol, and the claim
 * would skip verification. Found by this reviewer, reviewing this very change (#201).
 */
function shownWholeWord(symbol: string, renderedDiff: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return new RegExp(String.raw`(?<![\w$])${escaped}(?![\w$])`, "u").test(renderedDiff);
}

/** The file, numbered the same way the hunks are, so an evidence line means the same thing in
 *  both. Truncated only at the ceiling the caller enforces — never silently. */
export function numberFileLines(text: string): string {
  return text
    .split("\n")
    .map((line, index) => `${String(index + 1)} ${line}`)
    .join("\n");
}

export const VERIFY_SYSTEM_PROMPT = [
  "You verify review claims against the complete file they were written about.",
  "",
  "For each numbered claim decide exactly one verdict:",
  '- "supported": the file does NOT already handle what the claim says is missing or wrong, so the claim stands.',
  '- "contradicted": the file already does the thing the claim asks for, or the claim rests on a false premise about the code or the language. Cite the line number that shows it.',
  "",
  "Judge only what the file shows. A claim you cannot settle from the file is `supported` —",
  "you are removing claims the file itself refutes, not claims you find unconvincing.",
  "",
  'Answer with a JSON array and nothing else: [{"claim": 1, "verdict": "contradicted", "line": 655}]',
  "Every claim must appear exactly once. `line` is required for `contradicted`, omitted otherwise.",
].join("\n");

export function buildVerifyPrompt(
  path: string,
  numberedFile: string,
  claims: readonly VerifiableClaim[],
): string {
  const listed = claims.map((claim, index) => {
    const where =
      claim.start_line > 0 ? ` (anchored at line ${String(claim.start_line)})` : " (file level)";
    return `claim ${String(index + 1)}${where}:\n${claim.content}`;
  });
  return [
    `<file path="${path}">`,
    numberedFile,
    "</file>",
    "",
    "<claims>",
    listed.join("\n\n"),
    "</claims>",
  ].join("\n");
}

export interface ClaimVerdict {
  readonly claim: number;
  readonly contradicted: boolean;
  readonly line: number | undefined;
}

/**
 * The reply, parsed by the same reject-rather-than-repair rules the findings parser uses: a shape
 * that does not match returns `undefined`, and the caller then keeps every claim. A verdict for a
 * claim index outside the asked range is dropped rather than mapped onto a neighbour.
 */
export function parseVerdicts(
  reply: string,
  claimCount: number,
): readonly ClaimVerdict[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed
    .map((entry) => oneVerdict(entry, claimCount))
    .filter((verdict): verdict is ClaimVerdict => verdict !== undefined);
}

/** A claim index inside the asked range, or `undefined`. */
function claimIndex(value: unknown, claimCount: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 1 && value <= claimCount ? value : undefined;
}

/** A cited evidence line, or `undefined` — a line number is a courtesy, never a requirement. */
function evidenceLine(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/** One entry of the verdict array, or `undefined` when its shape says nothing usable. */
function oneVerdict(entry: unknown, claimCount: number): ClaimVerdict | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { claim, verdict, line } = entry as Record<string, unknown>;
  const index = claimIndex(claim, claimCount);
  if (index === undefined || typeof verdict !== "string") return undefined;
  return {
    claim: index,
    contradicted: verdict.toLowerCase() === "contradicted",
    line: evidenceLine(line),
  };
}

/** The digest of a verification, for the diagnostics sink: counts only, never claim text. */
export interface VerificationTally {
  readonly asked: number;
  readonly dropped: number;
}

export function tallyOf(
  verdicts: readonly ClaimVerdict[] | undefined,
  asked: number,
): VerificationTally {
  if (verdicts === undefined) return { asked, dropped: 0 };
  return { asked, dropped: verdicts.filter((v) => v.contradicted).length };
}

/** Identity of a verified file, so a cache entry can record that verification already ran. */
export function verificationDigest(pathDigest: Sha256, asked: number): string {
  return `${pathDigest}:${String(asked)}`;
}
