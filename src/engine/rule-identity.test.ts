import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { sha256, type Sha256 } from "../core/brands.js";
import { compileProfile, type CompiledProfile, type ReviewProfile } from "../config/profile.js";
import { promptIdentityDigest } from "./rule-identity.js";
import { buildRuleFile, serializeRuleFile } from "./rule-file.js";

function profile(overrides: Partial<ReviewProfile> = {}): CompiledProfile {
  return compileProfile({
    version: 1,
    reviewRelevant: ["src/**/*.ts"],
    deletionCritical: [],
    generated: [],
    excluded: [],
    benignWarnings: [],
    ...overrides,
  } satisfies ReviewProfile);
}

/** The independent expectation: the same production pieces this function itself calls. */
function expectedDigest(compiled: CompiledProfile, guidelines = { paths: [] }): Sha256 {
  const body = serializeRuleFile(buildRuleFile(compiled, guidelines));
  return sha256(createHash("sha256").update(body).digest("hex"));
}

describe("promptIdentityDigest", () => {
  it("matches sha256(serializeRuleFile(buildRuleFile(profile, guidelines))) exactly", () => {
    const compiled = profile();
    expect(promptIdentityDigest(compiled, { paths: [] })).toBe(expectedDigest(compiled));
  });

  it("is stable across repeated calls with the same inputs", () => {
    const compiled = profile();
    expect(promptIdentityDigest(compiled, { paths: [] })).toBe(
      promptIdentityDigest(compiled, { paths: [] }),
    );
  });

  it("changes when the guideline paths change", () => {
    const compiled = profile();
    const a = promptIdentityDigest(compiled, { paths: [] });
    const b = promptIdentityDigest(compiled, { paths: ["AGENTS.md"] });
    expect(a).not.toBe(b);
  });

  it("changes when the profile's generated list changes", () => {
    const a = promptIdentityDigest(profile(), { paths: [] });
    const b = promptIdentityDigest(profile({ generated: ["**/dist/**"] }), { paths: [] });
    expect(a).not.toBe(b);
  });

  /**
   * The whole point of this function: it never receives a per-run exclude list, so nothing about
   * this run's mechanically-clean paths or cache hits can reach it. There is no dynamic-exclude
   * parameter to vary here — that absence from the signature *is* the guarantee.
   */
  it("takes no per-run exclude list — the identity digest has no parameter for one", () => {
    expect(promptIdentityDigest).toHaveLength(2);
  });
});
