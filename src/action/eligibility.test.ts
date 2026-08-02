import { describe, expect, it } from "vitest";

import { evaluateEligibility, type EventFacts } from "./eligibility.js";

const TARGETS = ["dev"];

function facts(overrides: Partial<EventFacts> = {}): EventFacts {
  return {
    eventName: "pull_request_target",
    action: "synchronize",
    draft: false,
    headRepoFullName: "acme/widget",
    baseRepoFullName: "acme/widget",
    baseRef: "dev",
    previousBaseRef: undefined,
    ...overrides,
  };
}

describe("evaluateEligibility", () => {
  it("accepts a ready same-repository pull request targeting the configured branch", () => {
    expect(evaluateEligibility(facts(), TARGETS)).toEqual({ eligible: true });
  });

  it("skips a draft", () => {
    expect(evaluateEligibility(facts({ draft: true }), TARGETS)).toEqual({
      eligible: false,
      reason: "eligibility.skipped.draft",
    });
  });

  // A fork head must not reach the secret-bearing execution path: per-review budgets bound one
  // review, not an attacker opening many pull requests.
  it("skips a fork head", () => {
    expect(evaluateEligibility(facts({ headRepoFullName: "attacker/widget" }), TARGETS)).toEqual({
      eligible: false,
      reason: "eligibility.skipped.fork",
    });
  });

  it("skips an event that names no head repository at all", () => {
    expect(evaluateEligibility(facts({ headRepoFullName: undefined }), TARGETS)).toEqual({
      eligible: false,
      reason: "eligibility.skipped.fork",
    });
  });

  it("compares repository ownership case-insensitively", () => {
    expect(evaluateEligibility(facts({ headRepoFullName: "ACME/Widget" }), TARGETS)).toEqual({
      eligible: true,
    });
  });

  it("skips a pull request aimed at another branch", () => {
    expect(evaluateEligibility(facts({ baseRef: "main" }), TARGETS)).toEqual({
      eligible: false,
      reason: "eligibility.skipped.base_branch",
    });
  });

  describe("edited events", () => {
    it("reviews a pull request retargeted onto the configured branch", () => {
      const result = evaluateEligibility(
        facts({ action: "edited", previousBaseRef: "main" }),
        TARGETS,
      );
      expect(result).toEqual({ eligible: true });
    });

    // `edited` also fires for title and body changes. Reviewing those would spend a full model
    // budget on a change that cannot affect the code.
    it("skips a metadata-only edit", () => {
      const result = evaluateEligibility(facts({ action: "edited" }), TARGETS);
      expect(result).toEqual({ eligible: false, reason: "eligibility.skipped.edit_not_retarget" });
    });
  });

  it("checks draft status before spending any other consideration", () => {
    // A draft fork PR should report the draft reason: the cheapest, least alarming explanation.
    const result = evaluateEligibility(
      facts({ draft: true, headRepoFullName: "attacker/widget" }),
      TARGETS,
    );
    expect(result).toEqual({ eligible: false, reason: "eligibility.skipped.draft" });
  });
});
