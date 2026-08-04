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

/**
 * One declared contract-pair entry — technique B ("declared-contract pairs") from epic #80: paths
 * whose review should also read one or more counterpart files, because a shape or protocol contract
 * between the two sides cannot be checked from either file alone. A repository declares, for example,
 * that its server route handlers and its client-side response types must be read together, so a
 * change to one that silently drifts from the other becomes checkable instead of invisible to a
 * reviewer that only ever sees one file at a time.
 *
 * This entry declares the pairing; its two consumers from epic #80 read it. The adapter's
 * deterministic shape gate compares flat same-named interfaces across each pair, and
 * `rule-file.ts`'s `contractPairsSection` renders the declaration into the rule so a matching
 * file's review is told to read the counterpart — both against this already-validated,
 * already-bounded shape, the same way this field itself follows the schema-and-compilation shape
 * `pathInstructions` established beside it.
 *
 * `counterparts` names FILES, deliberately never globs: a counterpart is something a consumer reads,
 * and a pattern does not name a file to open. Validation therefore follows the same repository-
 * relative path idiom `guidelines.ts`'s `parseGuidelinePaths` uses for its own document paths (reject
 * a leading `/`, a `..` segment, a backslash) plus one check that idiom does not need: a literal glob
 * metacharacter (`*`, `?`, `{`, `}`) is rejected too, because unlike a guideline path a counterpart
 * sits right beside a `paths` field that IS a glob list, and a stray metacharacter here would silently
 * change what a fixed string means instead of erroring loudly.
 *
 * Read from the trusted base checkout via the same `profile` input every other field here is, so
 * `counterparts` and `contract` carry the same trust level as `reviewRelevant`/`excluded`/
 * `pathInstructions` — configuration the consumer repository authored, never the untrusted candidate
 * content a review itself treats as hostile.
 */
export interface ContractPair {
  /**
   * Glob patterns naming the side whose review should also read `counterparts`. Same glob dialect,
   * per-glob length bound, and control-character check as `pathInstructions.paths` — reused, never
   * restated. At least one, at most `MAX_CONTRACT_PAIR_PATHS`.
   */
  readonly paths: readonly string[];
  /**
   * Repository-relative FILE paths to read alongside a match on `paths`. At least one, at most
   * `MAX_CONTRACT_PAIR_COUNTERPARTS`.
   */
  readonly counterparts: readonly string[];
  /** Optional one-line note on what must agree between the two sides. Absent when not declared. */
  readonly contract?: string;
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
  /**
   * Declared contract pairs — see `ContractPair`'s own doc comment for what this field is for and
   * which two consumers read it: `rule-file.ts`'s `contractPairsSection` renders this raw form into
   * the rule, and `review.ts`'s deterministic contract gate matches on the compiled form
   * `compileProfile` derives from it below. Optional in the source JSON —
   * an absent key parses to `[]`, the same additive contract `pathInstructions` above has, so every
   * profile written before this field existed still parses unchanged.
   *
   * Optional here on the TYPE too, which is where this field deliberately diverges from
   * `pathInstructions` above (a required array defaulting to `[]`): this interface is a construction
   * target for hand-written `ReviewProfile` object literals scattered across this codebase's own test
   * suites, every one of which predates `contractPairs` and would otherwise need to be touched just to
   * keep compiling. A required-with-default field forces every existing literal to change the moment
   * it is declared; an optional one lets every literal that has never heard of `contractPairs` keep
   * type-checking unchanged, which is what "additive" has to mean at the type level, not only at the
   * JSON-parsing level. `compileProfile` still treats an absent property exactly like an explicit
   * `[]` — nothing about a caller's choice to omit this key changes the compiled result.
   */
  readonly contractPairs?: readonly ContractPair[];
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
  /**
   * Compiled form of `contractPairs`: a matcher for `paths`, `counterparts` carried verbatim, and the
   * optional `contract` note carried through unchanged. Optional on the type for the same reason
   * `ReviewProfile.contractPairs` is — see that field's own doc comment; `compileProfile` always
   * populates this with a real (possibly empty) array of its own, so the property is absent only on a
   * `CompiledProfile` some other caller assembled without going through `compileProfile` at all.
   */
  readonly contractPairs?: readonly {
    readonly matcher: GlobSet;
    readonly counterparts: readonly string[];
    readonly contract?: string;
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
const OPTIONAL_PROFILE_KEYS = ["pathInstructions", "contractPairs"] as const;

/**
 * Bounds on `pathInstructions`, deliberately tighter than `ExclusionRule`'s: every entry's text is
 * rendered into the one rule file the engine reads for *every* file it reviews, so the cost of an
 * oversized declaration here is paid on every reviewed path, every run — not once per exclusion.
 */
const MAX_PATH_INSTRUCTIONS = 32;
const MAX_PATHS_PER_INSTRUCTION = 16;
/**
 * Matches `ExclusionRule.pattern`'s own bound — the same kind of value, the same limit.
 * `contractPairs[].paths` reuses this exact constant too (see `parseGlobPaths` below), rather than
 * restating the same number under a second name for what is, there as well, the same kind of value.
 */
const MAX_INSTRUCTION_PATH_LENGTH = 512;
const MAX_INSTRUCTION_TEXT_LENGTH = 1024;
/** Ceiling on the sum of every entry's `instructions.length`, independent of the per-entry bound. */
const MAX_TOTAL_INSTRUCTION_TEXT_LENGTH = 8192;

/**
 * Newline is the only control character natural-language instruction text legitimately needs.
 * Tighter than `sanitize.ts`'s published-body check, which also allows tab: that check governs a
 * Markdown comment body, and this one governs text composed directly into the engine's rule prompt.
 *
 * A literal rather than `new RegExp("…")`, for the reason `brands.ts`'s `CONTROL_CHARACTERS` gives:
 * the string form's doubled backslash is a single one by the time the pattern is parsed, so the two
 * compile to the same `source` with the same (empty) flags. The one gap in the ranges is still
 * U+000A, the newline this check exists to let through.
 */
// eslint-disable-next-line no-control-regex -- detecting control characters is this pattern's purpose
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

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
 * Parses one entry's glob list, rejecting a glob already present in `seen` and enforcing `max`
 * entries at `MAX_INSTRUCTION_PATH_LENGTH` per glob — the dialect and per-glob bound every profile
 * glob list shares, validated here once rather than restated per caller.
 *
 * Whether a duplicate spans just this entry or the whole declaring array is entirely `seen`'s
 * caller's choice, not this function's. `pathInstructions` threads one `Set` across every entry, so a
 * glob claimed once anywhere in its array is rejected everywhere else in it: there, a duplicate is
 * either a copy-paste mistake or two guidance blocks quietly competing for the same path, and a
 * consumer who wants several sentences on one glob can write them as one entry's `instructions`
 * instead of two entries that both claim the same pattern. `contractPairs` instead passes a fresh
 * `Set` per entry (see `parseContractPairEntry`), so the same glob is free to recur across its
 * entries — that divergence is deliberate there, not a gap here.
 */
function parseGlobPaths(value: unknown, field: string, seen: Set<string>, max: number): string[] {
  const paths = asArray(value, field, max).map((entry, i) => {
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
    paths: parseGlobPaths(object.paths, `${field}.paths`, seenPaths, MAX_PATHS_PER_INSTRUCTION),
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

/**
 * Bounds on `contractPairs` — epic #80's technique B groundwork ("declared-contract pairs"). Sized
 * independently of `pathInstructions`'s own bounds, even though nothing renders this field into the
 * rule prompt yet: the rule-text consumer epic #80 describes will render a declared pair the same way
 * `pathInstructionsSection` renders `pathInstructions` today, so bounding the input now is what keeps
 * that consumer's eventual cost bounded from the day it lands, instead of retrofitting a limit onto an
 * already-shipped, already-authored field. There is deliberately no aggregate cap to match
 * `MAX_TOTAL_INSTRUCTION_TEXT_LENGTH`: the worst case here (`MAX_CONTRACT_PAIRS` entries, each at
 * `MAX_CONTRACT_NOTE_LENGTH`) is 4096 characters, well under half of that aggregate ceiling, so a
 * second cap would bound nothing a reader could actually reach.
 */
const MAX_CONTRACT_PAIRS = 16;
const MAX_CONTRACT_PAIR_PATHS = 8;
const MAX_CONTRACT_PAIR_COUNTERPARTS = 8;
/**
 * A counterpart names one file — the same kind of value as an instruction-list glob string — so it
 * reuses `MAX_INSTRUCTION_PATH_LENGTH` by reference rather than restating 512 under a second name.
 */
const MAX_COUNTERPART_PATH_LENGTH = MAX_INSTRUCTION_PATH_LENGTH;
/**
 * Far tighter than `MAX_INSTRUCTION_TEXT_LENGTH`: `contract` is a one-line note naming an agreement,
 * never prose rendered to the model today, so it does not need `pathInstructions.instructions`'s much
 * larger ceiling.
 */
const MAX_CONTRACT_NOTE_LENGTH = 256;

/**
 * Glob metacharacters in this repository's dialect (`core/glob.ts`'s `globToRegExp`): `*` and `?`
 * within a segment, and `{`/`}` for `{a,b}` alternation (`**` is two of the `*` already covered). A
 * counterpart names one file to read, never a pattern to match several, so any of these would
 * silently change what the string means instead of erroring — rejected here for that reason alone.
 */
const COUNTERPART_GLOB_METACHARACTERS = /[*?{}]/;

/**
 * Parses one entry's `counterparts`: repository-relative FILE paths, never globs. Follows the same
 * path-escape idiom `guidelines.ts`'s `parseGuidelinePaths` uses on its own document paths, for the
 * same reason — a leading `/` or a `..` segment would let a declared counterpart name a file outside
 * the checkout this profile itself is read from. A backslash is rejected alongside `..` for the same
 * reason `guidelines.ts` rejects it: a `..\` traversal has no `/`-delimited `..` segment for the
 * split-based check below to catch on its own.
 *
 * `seen` starts fresh on every call — there is exactly one call per entry, from
 * `parseContractPairEntry` — so repetition is only ever checked within one entry's own list; see that
 * function's own comment for why cross-entry repetition of a `paths` glob is deliberately allowed,
 * which extends to `counterparts` the same way: nothing about a shared counterpart makes two entries
 * compete.
 */
function parseCounterpartPaths(value: unknown, field: string): string[] {
  const seen = new Set<string>();
  const paths = asArray(value, field, MAX_CONTRACT_PAIR_COUNTERPARTS).map((entry, i) => {
    const scope = `${field}[${String(i)}]`;
    const path = asString(entry, scope, MAX_COUNTERPART_PATH_LENGTH);
    if (COUNTERPART_GLOB_METACHARACTERS.test(path)) throw new ValidationError(scope);
    if (path.startsWith("/") || path.includes("\\")) throw new ValidationError(scope);
    if (path.split("/").includes("..")) throw new ValidationError(scope);
    if (seen.has(path)) throw new ValidationError(scope);
    seen.add(path);
    return path;
  });
  if (paths.length === 0) throw new ValidationError(field);
  return paths;
}

/**
 * Parses the optional `contract` note. Absent stays absent — the key is omitted from the returned
 * object entirely rather than set to `undefined` (see `parseContractPairEntry`'s return) — so
 * `exactOptionalPropertyTypes` makes "never declared" and "declared empty" stay distinguishable at
 * the type level, not just by convention.
 *
 * Rejects every control character, including newline — tighter than `pathInstructions.instructions`'s
 * own `CONTROL_EXCEPT_NEWLINE`, and deliberately so: this note is documented as a single line, and
 * reusing `hasControlCharacters` (the same whole-string check `repoPath` itself uses) is what makes a
 * newline inside it a rejection instead of a silently accepted second line.
 */
function parseContractNote(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const text = asString(value, field, MAX_CONTRACT_NOTE_LENGTH);
  if (hasControlCharacters(text)) throw new ValidationError(field);
  return text;
}

/**
 * Parses one `contractPairs` entry.
 *
 * Duplicate handling deliberately diverges from `pathInstructions.paths` in one direction: `paths`
 * below gets a fresh `Set` per entry, so a glob may not repeat within this entry's own `paths` but IS
 * accepted again in a later entry — unlike `pathInstructions`, which threads one `Set` across its
 * whole array and rejects the same glob anywhere else in it. That global rule exists there to stop two
 * guidance blocks from quietly competing for the same path; it does not apply here, because two
 * `contractPairs` entries sharing a glob are not competing for anything — a later consumer reads every
 * entry whose `paths` matches, and a repository legitimately wants two different counterpart sets
 * scoped to the same paths (say, a response-shape counterpart in one entry and a migration-file
 * counterpart in another, both scoped to `src/server/routes/**`). The same reasoning is why
 * `parseCounterpartPaths` above never threads `seen` across entries either.
 */
function parseContractPairEntry(entry: unknown, field: string): ContractPair {
  const object = asObject(entry, field);
  requireKeys(object, ["paths", "counterparts"], field);
  rejectUnknownKeys(object, ["paths", "counterparts", "contract"], field);

  const paths = parseGlobPaths(
    object.paths,
    `${field}.paths`,
    new Set<string>(),
    MAX_CONTRACT_PAIR_PATHS,
  );
  const counterparts = parseCounterpartPaths(object.counterparts, `${field}.counterparts`);
  const contract = parseContractNote(object.contract, `${field}.contract`);

  return {
    paths,
    counterparts,
    ...(contract === undefined ? {} : { contract }),
  };
}

function parseContractPairs(value: unknown, field: string): ContractPair[] {
  return asArray(value, field, MAX_CONTRACT_PAIRS).map((entry, i) =>
    parseContractPairEntry(entry, `${field}[${String(i)}]`),
  );
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
    // Same additive contract as pathInstructions immediately above.
    contractPairs:
      object.contractPairs === undefined
        ? []
        : parseContractPairs(object.contractPairs, `${field}.contractPairs`),
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
    // `?? []`, not a required field with a default: `profile.contractPairs` is optional on
    // `ReviewProfile` itself (see that field's doc comment), so a caller-assembled profile that never
    // heard of this field reaches here as `undefined`, and compiles to the same `[]` an explicit
    // empty list would.
    contractPairs: (profile.contractPairs ?? []).map((entry) => ({
      matcher: new GlobSet(entry.paths),
      counterparts: entry.counterparts,
      ...(entry.contract === undefined ? {} : { contract: entry.contract }),
    })),
  };
}

export function loadReviewProfile(text: string, field = "profile"): CompiledProfile {
  return compileProfile(parseReviewProfile(parseJson(text, field), field));
}
