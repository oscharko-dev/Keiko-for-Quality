import { FINDING_SEVERITIES } from "../engine/classify.js";
import type { EngineFinding } from "../engine/result.js";
import type { PlannedFinding } from "./publisher.js";

/**
 * Maximum model-authored findings that one pull request may publish in one run.
 *
 * Eight is deliberately conservative. A replay of the historical review board retained 16 of the
 * 17 findings maintainers subsequently fixed at this ceiling; a top-three ceiling retained only
 * three and therefore destroyed recall before verification had a chance to improve precision. The
 * cap is a noise brake, not a substitute for evidence verification, so it must leave enough room
 * for a genuinely defect-dense pull request.
 */
export const MAX_FRESH_MODEL_FINDINGS_PER_PR = 8;

/** Bounded first-stage shortlist for evidence verification, twice the publication ceiling. */
export const MAX_FRESH_VERIFICATION_CANDIDATES_PER_PR = MAX_FRESH_MODEL_FINDINGS_PER_PR * 2;

export interface PrWideSelection {
  /** Survivors in their original order, with audited/repaired replacements applied. */
  readonly kept: readonly PlannedFinding[];
  /** Originals removed by the cap, in their original order and identity. */
  readonly rankedOutOriginals: readonly EngineFinding[];
  readonly rankedOutCount: number;
}

/**
 * Applies the pull-request-wide cap to every model-authored candidate in this run, including
 * replayed generation-cache findings. Deterministic gate findings stay outside the cohort.
 *
 * `modelOriginals` and `replacements` are deliberately keyed by object identity. Audit and repair
 * produce new objects, but authorship belongs to the finding that entered the publication pipeline;
 * looking it up after replacement would silently exempt every changed finding. Cache hits consume
 * the same slots as fresh model output because both must pass the same current-run verifier and
 * ranking decision; only deterministic findings are exempt.
 *
 * Ranking chooses the best eight using the effective (replacement) severity. Both returned lists
 * then follow input order: severity decides membership, never publication order. An equal-severity
 * tie is therefore resolved by the earliest input position and stays deterministic.
 */
export function selectPrWideFindings(
  survivors: readonly PlannedFinding[],
  modelOriginals: ReadonlySet<EngineFinding>,
  replacements: ReadonlyMap<EngineFinding, EngineFinding> = new Map(),
): PrWideSelection {
  return selectModelWithLimit(
    survivors,
    modelOriginals,
    MAX_FRESH_MODEL_FINDINGS_PER_PR,
    replacements,
  );
}

/** Shortlists model candidates before verification; only deterministic findings remain exempt. */
export function selectVerificationCandidates(
  survivors: readonly PlannedFinding[],
  modelOriginals: ReadonlySet<EngineFinding>,
): PrWideSelection {
  return selectModelWithLimit(survivors, modelOriginals, MAX_FRESH_VERIFICATION_CANDIDATES_PER_PR);
}

function selectModelWithLimit(
  survivors: readonly PlannedFinding[],
  modelOriginals: ReadonlySet<EngineFinding>,
  limit: number,
  replacements: ReadonlyMap<EngineFinding, EngineFinding> = new Map(),
): PrWideSelection {
  const entries = survivors.map((survivor, index) => {
    const original = survivor.finding;
    const replacement = replacements.get(original);
    return {
      original,
      effective: replacement === undefined ? survivor : { ...survivor, finding: replacement },
      effectiveFinding: replacement ?? original,
      index,
      modelAuthored: modelOriginals.has(original),
    };
  });

  const selectedModelIndexes = new Set(
    entries
      .filter((entry) => entry.modelAuthored)
      .sort((left, right) => {
        const rankDifference =
          severityRank(right.effectiveFinding.severity) -
          severityRank(left.effectiveFinding.severity);
        return rankDifference === 0 ? left.index - right.index : rankDifference;
      })
      .slice(0, limit)
      .map((entry) => entry.index),
  );

  const kept: PlannedFinding[] = [];
  const rankedOutOriginals: EngineFinding[] = [];
  for (const entry of entries) {
    if (!entry.modelAuthored || selectedModelIndexes.has(entry.index)) {
      kept.push(entry.effective);
    } else {
      rankedOutOriginals.push(entry.original);
    }
  }

  return {
    kept,
    rankedOutOriginals,
    rankedOutCount: rankedOutOriginals.length,
  };
}

/** Unknown or absent severities are the single lowest, unclassified tier. */
function severityRank(severity: string | undefined): number {
  const index = (FINDING_SEVERITIES as readonly string[]).indexOf(severity?.toLowerCase() ?? "");
  return index === -1 ? 0 : FINDING_SEVERITIES.length - index;
}
