import type { BlobId, RepoPath } from "../core/brands.js";
import type { CompiledProfile } from "../config/profile.js";
import {
  MODE_ABSENT,
  MODE_SUBMODULE,
  MODE_SYMLINK,
  type ChangeStatus,
  type RawChange,
} from "../git/plumbing.js";

/**
 * Exactly one terminal state per changed path.
 *
 * `unclassified` is a real state rather than a fallback to "ignore": a path the profile does not
 * describe is a gap in the consumer's own coverage statement, and silently dropping it is precisely
 * the failure this inventory exists to detect.
 */
export type Classification =
  | { readonly kind: "reviewed" }
  | { readonly kind: "reviewed-as-deletion" }
  | { readonly kind: "binary" }
  | { readonly kind: "symlink-pointer"; readonly critical: boolean }
  | { readonly kind: "submodule-pointer"; readonly critical: boolean }
  | { readonly kind: "generated" }
  | { readonly kind: "excluded"; readonly reason: string }
  /**
   * A change with nothing in it for a reviewer to read.
   *
   * `pure-rename` is the only reason today: a path move where the blob and the mode are both
   * unchanged, proved by comparing full-length object ids rather than inferred from a similarity
   * score. It is a downgrade of what would otherwise be `reviewed`, not a new way to hide content —
   * see `downgradeToMechanicallyClean` for the exact condition and what it must never intercept.
   */
  | { readonly kind: "mechanically-clean"; readonly reason: "pure-rename" }
  | { readonly kind: "unclassified" };

export interface InventoryItem {
  readonly path: RepoPath;
  readonly oldPath?: RepoPath;
  readonly status: ChangeStatus;
  readonly classification: Classification;
  /** True when the file mode changed, including a transition to an executable mode. */
  readonly modeChanged: boolean;
  /** True when this item must appear in the engine's completed or reused coverage. */
  readonly reviewable: boolean;
  /**
   * Added plus deleted lines, as git's own numstat reports them, regardless of classification.
   * Zero for a binary change, where numstat reports `-` rather than a count. Note that a submodule
   * pointer bump is *not* zero here — numstat counts the gitlink line itself — but that has no
   * effect on the token-allotment formula, which sums this field only across reviewable items, and
   * a submodule pointer is never reviewable.
   */
  readonly changedLines: number;
  /**
   * The Git blob on each side of the change, carried through from `RawChange` for the review-cache
   * key (v0.9.0) — the exact base and head content addresses a cached finding list is replayable
   * against. Optional so a hand-built fixture never has to supply either; `toItem` always sets both,
   * because `RawChange` always carries them (the all-zero id stands in for "no blob" on an addition
   * or a deletion, and is itself a valid, meaningful `BlobId`).
   */
  readonly baseBlob?: BlobId;
  readonly headBlob?: BlobId;
}

function isMode(change: RawChange, mode: string): boolean {
  return change.oldMode === mode || change.newMode === mode;
}

function isCritical(profile: CompiledProfile, path: string): boolean {
  return profile.deletionCritical.matches(path) || profile.reviewRelevant.matches(path);
}

function findExclusion(profile: CompiledProfile, path: string): string | undefined {
  for (const rule of profile.excluded) {
    if (rule.matcher.matches(path)) return rule.reason;
  }
  return undefined;
}

/**
 * Structural classifications are tested before any profile rule.
 *
 * A symlink retarget or a submodule pointer move is exactly the kind of change an attacker would
 * place inside a directory the profile excludes as uninteresting, so the structural question is
 * asked first and the exclusion cannot answer it.
 */
function classifyStructural(
  profile: CompiledProfile,
  change: RawChange,
): Classification | undefined {
  const path = change.path;
  if (isMode(change, MODE_SUBMODULE)) {
    return { kind: "submodule-pointer", critical: isCritical(profile, path) };
  }
  if (isMode(change, MODE_SYMLINK)) {
    return { kind: "symlink-pointer", critical: isCritical(profile, path) };
  }
  return undefined;
}

/** Falls back to an explicit exclusion, or reports the path as undescribed. */
function excludedOrUnclassified(profile: CompiledProfile, path: string): Classification {
  const reason = findExclusion(profile, path);
  return reason !== undefined ? { kind: "excluded", reason } : { kind: "unclassified" };
}

/**
 * Inclusion is tested before exclusion, and that order is load-bearing.
 *
 * A complete profile ends with a catch-all exclusion so that no path can be left undescribed. If
 * exclusions were consulted first, that catch-all would match everything and the reviewer would
 * quietly review nothing while reporting a clean run. Specific intent wins over the fallback.
 */
function classifyContent(profile: CompiledProfile, change: RawChange): Classification {
  const path = change.path;
  if (profile.generated.matches(path)) return { kind: "generated" };

  if (change.status === "D") {
    // A removed test, regression pin, workflow, or governance file is review content in its own
    // right. Reporting it as a bare deletion is how a weakened suite passes review unnoticed.
    return isCritical(profile, path)
      ? { kind: "reviewed-as-deletion" }
      : excludedOrUnclassified(profile, path);
  }

  if (change.binary) return { kind: "binary" };
  if (profile.reviewRelevant.matches(path)) return { kind: "reviewed" };
  return excludedOrUnclassified(profile, path);
}

/**
 * Whether a rename moved a path without touching its content or its mode.
 *
 * All three legs are required. A rename with any content edit has a real diff for the engine to
 * read even though the path also moved. An exec-bit flip is a behavioural change — the file now
 * runs, or stops running, as a program — so it must reach full review even when the bytes are
 * identical.
 */
function isPureRename(change: RawChange): boolean {
  return (
    change.status === "R" && change.oldBlob === change.newBlob && change.oldMode === change.newMode
  );
}

/**
 * Downgrades a `reviewed` verdict to `mechanically-clean` when the change is a pure rename.
 *
 * Applied strictly after `classifyContent` has already decided, and it looks at nothing but its
 * result: a deletion, a binary, a generated path, an exclusion, or an unclassified path is returned
 * unchanged. Widening this to intercept those would quietly drop coverage `classify` exists to
 * guarantee — a renamed deletion is still review-critical content, not nothing.
 */
function downgradeToMechanicallyClean(
  change: RawChange,
  classification: Classification,
): Classification {
  if (classification.kind === "reviewed" && isPureRename(change)) {
    return { kind: "mechanically-clean", reason: "pure-rename" };
  }
  return classification;
}

export function classify(profile: CompiledProfile, change: RawChange): Classification {
  const structural = classifyStructural(profile, change);
  if (structural !== undefined) return structural;
  return downgradeToMechanicallyClean(change, classifyContent(profile, change));
}

/**
 * Whether the engine must account for this item.
 *
 * A submodule gitlink carries no reviewable content — there is no blob for the engine to read — so
 * requiring it in coverage would report every submodule bump as an incomplete review. The pointer
 * move is still classified and counted; it is simply not the engine's to review.
 */
function isReviewable(classification: Classification): boolean {
  switch (classification.kind) {
    case "reviewed":
    case "reviewed-as-deletion":
      return true;
    case "symlink-pointer":
      return classification.critical;
    default:
      return false;
  }
}

export function toItem(profile: CompiledProfile, change: RawChange): InventoryItem {
  const classification = classify(profile, change);
  const modeChanged =
    change.oldMode !== change.newMode &&
    change.oldMode !== MODE_ABSENT &&
    change.newMode !== MODE_ABSENT;
  return {
    path: change.path,
    ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
    status: change.status,
    classification,
    modeChanged,
    reviewable: isReviewable(classification),
    changedLines: change.changedLines,
    baseBlob: change.oldBlob,
    headBlob: change.newBlob,
  };
}
