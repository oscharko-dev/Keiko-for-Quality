import { GlobSet } from "../core/glob.js";
import { ValidationError, hasControlCharacters } from "../core/brands.js";
import {
  asArray,
  asObject,
  asString,
  asStringArray,
  parseJson,
  rejectUnknownKeys,
  requireKeys,
} from "../core/validate.js";

/**
 * The consumer-supplied answer to "what counts as review-relevant in this repository?".
 *
 * This is configuration rather than a built-in default on purpose. The engine's own defaults
 * exclude common test paths; a repository that treats tests and regression pins as review-critical
 * would otherwise inherit a coverage hole it never agreed to. Making the consumer state it also
 * makes the classification auditable in their own repository history.
 */
export interface ExclusionRule {
  readonly pattern: string;
  readonly reason: string;
}

export interface BenignWarning {
  readonly type: string;
  readonly justification: string;
}

/**
 * Short, natural-language review guidance scoped to one or more path patterns — the capability
 * CodeRabbit calls path instructions and Qodo calls extra instructions.
 *
 * This is additive to rule *text*, never to rule *selection*: `buildRuleFile` still emits the one
 * catch-all `rules[]` entry every run always has, and renders every declared entry into that same
 * document as guidance the model applies to a matching file on its own. Declaring an entry here
 * cannot add, remove, or reorder which paths are reviewed — that remains entirely the job of
 * `reviewRelevant`, `deletionCritical`, `generated`, and `excluded` above. It is also distinct from
 * `guidelines.ts`: a guideline is a whole document, named rather than inlined, and read on demand;
 * an instruction is a short string, inlined directly, scoped to specific globs rather than applied
 * everywhere.
 *
 * Read from the trusted base checkout via the same `profile` input every other field here is, so
 * this text carries the same trust level as `reviewRelevant`/`excluded` patterns — configuration the
 * consumer repository authored — never the untrusted candidate content `CATCH_ALL_RULE` warns the
 * model about. That is why validation here bounds length and rejects control characters rather than
 * screening for injection: the injection boundary this product defends is candidate content, and
 * this field is on the trusted side of it, same as the guideline paths beside it.
 */
export interface PathInstruction {
  /** Glob patterns this entry's guidance applies to. At least one, at most `MAX_PATHS_PER_INSTRUCTION`. */
  readonly paths: readonly string[];
  /** The guidance itself, rendered verbatim into the engine rule file's prompt text. */
  readonly instructions: string;
}

export interface ReviewProfile {
  readonly version: 1;
  /** Changed paths matching these are reviewed. */
  readonly reviewRelevant: readonly string[];
  /** Paths whose deletion is itself review content — tests, pins, workflows, governance. */
  readonly deletionCritical: readonly string[];
  /** Generated paths, excluded with an explicit `generated` classification. */
  readonly generated: readonly string[];
  /** Any other exclusion, each carrying its own justification. */
  readonly excluded: readonly ExclusionRule[];
  /** Engine warnings that do not make a run incomplete, each individually justified. */
  readonly benignWarnings: readonly BenignWarning[];
  /**
   * Per-path natural-language review guidance. Optional in the source JSON — an absent key parses
   * to `[]` so every profile written before this field existed still parses unchanged.
   */
  readonly pathInstructions: readonly PathInstruction[];
}

export interface CompiledProfile {
  readonly profile: ReviewProfile;
  readonly reviewRelevant: GlobSet;
  readonly deletionCritical: GlobSet;
  readonly generated: GlobSet;
  readonly excluded: readonly { readonly matcher: GlobSet; readonly reason: string }[];
  readonly benignWarnings: ReadonlyMap<string, string>;
  readonly pathInstructions: readonly {
    readonly matcher: GlobSet;
    readonly instructions: string;
  }[];
}

const PROFILE_KEYS = [
  "version",
  "reviewRelevant",
  "deletionCritical",
  "generated",
  "excluded",
  "benignWarnings",
] as const;

/** Keys accepted, but never required, on a profile — additive fields land here, not in `PROFILE_KEYS`. */
const OPTIONAL_PROFILE_KEYS = ["pathInstructions"] as const;

/**
 * Bounds on `pathInstructions`, deliberately tighter than `ExclusionRule`'s: every entry's text is
 * rendered into the one rule file the engine reads for *every* file it reviews, so the cost of an
 * oversized declaration here is paid on every reviewed path, every run — not once per exclusion.
 */
const MAX_PATH_INSTRUCTIONS = 32;
const MAX_PATHS_PER_INSTRUCTION = 16;
/** Matches `ExclusionRule.pattern`'s own bound — the same kind of value, the same limit. */
const MAX_INSTRUCTION_PATH_LENGTH = 512;
const MAX_INSTRUCTION_TEXT_LENGTH = 1024;
/** Ceiling on the sum of every entry's `instructions.length`, independent of the per-entry bound. */
const MAX_TOTAL_INSTRUCTION_TEXT_LENGTH = 8192;

/**
 * Newline is the only control character natural-language instruction text legitimately needs.
 * Tighter than `sanitize.ts`'s published-body check, which also allows tab: that check governs a
 * Markdown comment body, and this one governs text composed directly into the engine's rule prompt.
 */
// eslint-disable-next-line no-control-regex -- detecting control characters is this pattern's purpose
const CONTROL_EXCEPT_NEWLINE = new RegExp("[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F]");

function parseExclusions(value: unknown, field: string): ExclusionRule[] {
  return asArray(value, field, 512).map((entry, i) => {
    const scope = `${field}[${String(i)}]`;
    const object = asObject(entry, scope);
    requireKeys(object, ["pattern", "reason"], scope);
    rejectUnknownKeys(object, ["pattern", "reason"], scope);
    return {
      pattern: asString(object.pattern, `${scope}.pattern`, 512),
      // An exclusion without a stated reason is how coverage quietly disappears.
      reason: asString(object.reason, `${scope}.reason`, 512),
    };
  });
}

function parseBenignWarnings(value: unknown, field: string): BenignWarning[] {
  return asArray(value, field, 128).map((entry, i) => {
    const scope = `${field}[${String(i)}]`;
    const object = asObject(entry, scope);
    requireKeys(object, ["type", "justification"], scope);
    rejectUnknownKeys(object, ["type", "justification"], scope);
    return {
      type: asString(object.type, `${scope}.type`, 200),
      justification: asString(object.justification, `${scope}.justification`, 512),
    };
  });
}

/**
 * Parses one entry's `paths`, rejecting a glob this reviewer has already seen anywhere in the
 * profile's `pathInstructions` — within this entry or a previous one. `seen` is threaded in by the
 * caller rather than started fresh per entry, which is what makes the check span the whole array: a
 * duplicate is either a copy-paste mistake or two guidance blocks quietly competing for the same
 * path, and a consumer who genuinely wants several sentences on one glob can write them as one
 * entry's `instructions` instead of two entries that both claim the same pattern.
 */
function parseInstructionPaths(value: unknown, field: string, seen: Set<string>): string[] {
  const paths = asArray(value, field, MAX_PATHS_PER_INSTRUCTION).map((entry, i) => {
    const scope = `${field}[${String(i)}]`;
    const path = asString(entry, scope, MAX_INSTRUCTION_PATH_LENGTH);
    if (hasControlCharacters(path)) throw new ValidationError(scope);
    if (seen.has(path)) throw new ValidationError(scope);
    seen.add(path);
    return path;
  });
  if (paths.length === 0) throw new ValidationError(field);
  return paths;
}

function parsePathInstructionEntry(
  entry: unknown,
  field: string,
  seenPaths: Set<string>,
): PathInstruction {
  const object = asObject(entry, field);
  requireKeys(object, ["paths", "instructions"], field);
  rejectUnknownKeys(object, ["paths", "instructions"], field);

  const instructions = asString(
    object.instructions,
    `${field}.instructions`,
    MAX_INSTRUCTION_TEXT_LENGTH,
  );
  if (CONTROL_EXCEPT_NEWLINE.test(instructions)) {
    throw new ValidationError(`${field}.instructions`);
  }

  return {
    paths: parseInstructionPaths(object.paths, `${field}.paths`, seenPaths),
    instructions,
  };
}

/** The aggregate cap runs after every entry parses, so one oversized entry is reported on itself. */
function parsePathInstructions(value: unknown, field: string): PathInstruction[] {
  const seenPaths = new Set<string>();
  const entries = asArray(value, field, MAX_PATH_INSTRUCTIONS).map((entry, i) =>
    parsePathInstructionEntry(entry, `${field}[${String(i)}]`, seenPaths),
  );
  const totalLength = entries.reduce((sum, entry) => sum + entry.instructions.length, 0);
  if (totalLength > MAX_TOTAL_INSTRUCTION_TEXT_LENGTH) throw new ValidationError(field);
  return entries;
}

export function parseReviewProfile(input: unknown, field = "profile"): ReviewProfile {
  const object = asObject(input, field);
  requireKeys(object, [...PROFILE_KEYS], field);
  rejectUnknownKeys(object, [...PROFILE_KEYS, ...OPTIONAL_PROFILE_KEYS], field);
  if (object.version !== 1) throw new ValidationError(`${field}.version`);

  const reviewRelevant = asStringArray(object.reviewRelevant, `${field}.reviewRelevant`, 1024);
  if (reviewRelevant.length === 0) throw new ValidationError(`${field}.reviewRelevant`);

  return {
    version: 1,
    reviewRelevant,
    deletionCritical: asStringArray(object.deletionCritical, `${field}.deletionCritical`, 1024),
    generated: asStringArray(object.generated, `${field}.generated`, 1024),
    excluded: parseExclusions(object.excluded, `${field}.excluded`),
    benignWarnings: parseBenignWarnings(object.benignWarnings, `${field}.benignWarnings`),
    // Absent, not merely empty: a profile written before this field existed has no key at all, and
    // that must parse exactly as it did before this field was added.
    pathInstructions:
      object.pathInstructions === undefined
        ? []
        : parsePathInstructions(object.pathInstructions, `${field}.pathInstructions`),
  };
}

export function compileProfile(profile: ReviewProfile): CompiledProfile {
  return {
    profile,
    reviewRelevant: new GlobSet(profile.reviewRelevant),
    deletionCritical: new GlobSet(profile.deletionCritical),
    generated: new GlobSet(profile.generated),
    excluded: profile.excluded.map((rule) => ({
      matcher: new GlobSet([rule.pattern]),
      reason: rule.reason,
    })),
    benignWarnings: new Map(profile.benignWarnings.map((w) => [w.type, w.justification])),
    pathInstructions: profile.pathInstructions.map((entry) => ({
      matcher: new GlobSet(entry.paths),
      instructions: entry.instructions,
    })),
  };
}

export function loadReviewProfile(text: string, field = "profile"): CompiledProfile {
  return compileProfile(parseReviewProfile(parseJson(text, field), field));
}
