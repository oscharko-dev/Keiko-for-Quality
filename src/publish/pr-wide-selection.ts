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
  /** Originals removed by either the total or model-authored cap, in input order and identity. */
  readonly rankedOutOriginals: readonly EngineFinding[];
  readonly rankedOutCount: number;
}

interface SelectionEntry {
  readonly original: EngineFinding;
  readonly effective: PlannedFinding;
  readonly effectiveFinding: EngineFinding;
  readonly index: number;
  readonly modelAuthored: boolean;
}

/**
 * Applies one pull-request-wide total cap to every candidate in this run. Deterministic gate
 * findings consume that total first; model-authored candidates use the remaining capacity and are
 * additionally subject to the smaller model ceiling.
 *
 * `modelOriginals` and `replacements` are deliberately keyed by object identity. Audit and repair
 * produce new objects, but authorship belongs to the finding that entered the publication pipeline;
 * looking it up after replacement would silently exempt every changed finding. Cache hits consume
 * the same model slots as fresh output because both must pass the same current-run verifier and
 * ranking decision. Deterministic findings have priority, not exemption from the consumer's total.
 *
 * Ranking chooses the best eight using the effective (replacement) severity. Both returned lists
 * then follow input order: severity decides membership, never publication order. An equal-severity
 * tie is therefore resolved by the earliest input position and stays deterministic.
 */
export function selectPrWideFindings(
  survivors: readonly PlannedFinding[],
  modelOriginals: ReadonlySet<EngineFinding>,
  maxFindings: number,
  replacements: ReadonlyMap<EngineFinding, EngineFinding> = new Map(),
): PrWideSelection {
  return selectWithLimits(
    survivors,
    modelOriginals,
    maxFindings,
    Math.min(MAX_FRESH_MODEL_FINDINGS_PER_PR, maxFindings),
    replacements,
  );
}

/** Shortlists a total-bounded cohort before verification, giving deterministic findings priority. */
export function selectVerificationCandidates(
  survivors: readonly PlannedFinding[],
  modelOriginals: ReadonlySet<EngineFinding>,
  maxFindings: number,
): PrWideSelection {
  return selectWithLimits(
    survivors,
    modelOriginals,
    maxFindings,
    Math.min(MAX_FRESH_VERIFICATION_CANDIDATES_PER_PR, maxFindings),
  );
}

function selectWithLimits(
  survivors: readonly PlannedFinding[],
  modelOriginals: ReadonlySet<EngineFinding>,
  totalLimit: number,
  modelLimit: number,
  replacements: ReadonlyMap<EngineFinding, EngineFinding> = new Map(),
): PrWideSelection {
  const entries: readonly SelectionEntry[] = survivors.map((survivor, index) => {
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
  const selectedDeterministicIndexes = new Set(
    entries
      .filter((entry) => !entry.modelAuthored)
      .slice(0, totalLimit)
      .map((entry) => entry.index),
  );
  const remainingTotal = Math.max(0, totalLimit - selectedDeterministicIndexes.size);
  const selectedModelIndexes = selectedModels(entries, Math.min(modelLimit, remainingTotal));
  return partitionSelection(entries, selectedDeterministicIndexes, selectedModelIndexes);
}

function selectedModels(entries: readonly SelectionEntry[], limit: number): ReadonlySet<number> {
  return new Set(
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
}

function partitionSelection(
  entries: readonly SelectionEntry[],
  deterministicIndexes: ReadonlySet<number>,
  modelIndexes: ReadonlySet<number>,
): PrWideSelection {
  const kept: PlannedFinding[] = [];
  const rankedOutOriginals: EngineFinding[] = [];
  for (const entry of entries) {
    if (
      (entry.modelAuthored && modelIndexes.has(entry.index)) ||
      (!entry.modelAuthored && deterministicIndexes.has(entry.index))
    ) {
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
