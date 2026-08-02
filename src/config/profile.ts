import { GlobSet } from "../core/glob.js";
import { ValidationError } from "../core/brands.js";
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
}

export interface CompiledProfile {
  readonly profile: ReviewProfile;
  readonly reviewRelevant: GlobSet;
  readonly deletionCritical: GlobSet;
  readonly generated: GlobSet;
  readonly excluded: readonly { readonly matcher: GlobSet; readonly reason: string }[];
  readonly benignWarnings: ReadonlyMap<string, string>;
}

const PROFILE_KEYS = [
  "version",
  "reviewRelevant",
  "deletionCritical",
  "generated",
  "excluded",
  "benignWarnings",
] as const;

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

export function parseReviewProfile(input: unknown, field = "profile"): ReviewProfile {
  const object = asObject(input, field);
  requireKeys(object, [...PROFILE_KEYS], field);
  rejectUnknownKeys(object, [...PROFILE_KEYS], field);
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
  };
}

export function loadReviewProfile(text: string, field = "profile"): CompiledProfile {
  return compileProfile(parseReviewProfile(parseJson(text, field), field));
}
