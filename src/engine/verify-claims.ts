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
 * The imperative openings and prose forms that assert something is NOT there.
 *
 * Taken from the refuted corpus rather than invented: every phrase below opened at least one
 * finding the reader then refuted by pointing at code the model had not been shown. "Add",
 * "Ensure", "Guard", "Reject", "Validate", "Clear", "Handle", "Remove" are the rule text's own
 * imperative style, so the match is on the CLAIM shape, not on wording the model chose freely.
 */
const ABSENCE_IMPERATIVE =
  /(^|\n)\s*\*\*\s*(Add|Ensure|Guard|Reject|Validate|Clear|Handle|Initialize|Reset|Remove|Prevent|Avoid|Restrict|Require|Check)\b/iu;

/** Prose that states absence outright, wherever it sits in the body. */
const ABSENCE_PROSE =
  /\b(is missing|are missing|does not|doesn't|do not|don't|never (?:clears|checks|validates|resets|removes|handles|guards)|no (?:guard|handling|validation|check|cleanup)|without (?:guard|validation|checking)|fails to|omits)\b/iu;

/** A backticked identifier the prose leans on as evidence. */
const BACKTICKED = /`([A-Za-z_$][\w$]*)`/gu;

/**
 * Whether a claim needs the whole file before it can be trusted.
 *
 * Two independent triggers, either of which means the hunk cannot settle the question:
 *
 * 1. **It asserts absence.** "Add X", "Ensure Y is cleared", "no validation for Z" — an excerpt
 *    can show that something is present, never that it is absent from the file.
 * 2. **It leans on a symbol the model was not shown.** When the prose cites `someHelper` and
 *    `someHelper` appears nowhere in the rendered diff, the model is reasoning about code outside
 *    its context — the exact posture that produced the semantics-level refutations.
 *
 * A claim that trips neither is grounded in what the model actually read, and is not sent.
 */
export function needsWholeFileEvidence(content: string, renderedDiff: string): boolean {
  if (ABSENCE_IMPERATIVE.test(content) || ABSENCE_PROSE.test(content)) return true;
  const symbols = [...content.matchAll(BACKTICKED)].map((m) => m[1]);
  return symbols.some((symbol) => symbol !== undefined && !renderedDiff.includes(symbol));
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
