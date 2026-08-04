import type { ReasonCode } from "../diagnostics/reason-codes.js";

/**
 * Whether this event should spend model budget on a review.
 *
 * Every rejection is recorded with its own reason code rather than silently filtered, because
 * "the reviewer said nothing" and "the reviewer decided not to look" are very different facts for
 * anyone deciding whether a pull request has been reviewed.
 */
export interface EventFacts {
  readonly eventName: string;
  readonly action: string | undefined;
  readonly draft: boolean;
  /** `owner/repo` of the head. Undefined when the event does not name one. */
  readonly headRepoFullName: string | undefined;
  readonly baseRepoFullName: string;
  readonly baseRef: string;
  /** For an `edited` event, the previous base ref if the base was changed. */
  readonly previousBaseRef: string | undefined;
}

export type EligibilityResult =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: ReasonCode };

export function evaluateEligibility(
  facts: EventFacts,
  targetBranches: readonly string[],
): EligibilityResult {
  if (facts.draft) {
    return { eligible: false, reason: "eligibility.skipped.draft" };
  }
  // A fork head must not reach the secret-bearing execution path. Per-review token budgets bound a
  // single review; they do not bound an attacker opening many pull requests.
  //
  // The optional chain keeps "no head repository named" a rejection rather than a hole: it yields
  // `undefined`, and `baseRepoFullName.toLowerCase()` is always a string, so the comparison is
  // unequal exactly as the explicit `=== undefined` test that stood here made it.
  if (facts.headRepoFullName?.toLowerCase() !== facts.baseRepoFullName.toLowerCase()) {
    return { eligible: false, reason: "eligibility.skipped.fork" };
  }
  if (!targetBranches.includes(facts.baseRef)) {
    return { eligible: false, reason: "eligibility.skipped.base_branch" };
  }
  // An `edited` event fires for title and body changes too. Reviewing those would spend a full
  // model budget on a change that cannot affect the code, so only a retarget qualifies.
  if (facts.action === "edited" && facts.previousBaseRef === undefined) {
    return { eligible: false, reason: "eligibility.skipped.edit_not_retarget" };
  }
  return { eligible: true };
}
