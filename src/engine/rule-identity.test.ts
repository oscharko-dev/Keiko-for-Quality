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
    pathInstructions: [],
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
   * Per-path instructions change what the model is asked, exactly as the catch-all guidance or a
   * guideline path does, so they must move this digest the same way `generated` does above — and
   * they must do so through nothing more than `profile` already being a parameter here (see
   * `rule-identity.ts`'s own doc comment on why that wiring needs no new plumbing).
   *
   * `mechanicallyClean` is the contrasting, per-run case this digest must *never* reflect: v0.8.0's
   * pure-rename downgrade and v0.9.0's cache hits differ on every head, so `promptIdentityDigest`
   * never receives that list at all (see "takes no per-run exclude list" below) — it can only ever
   * move `buildRuleFile`'s `exclude`, never the `rules` this digest actually hashes.
   */
  it("changes when a path instruction's text changes, but never when a mechanically-clean exclude is added", () => {
    const withInstruction = (text: string): CompiledProfile =>
      profile({ pathInstructions: [{ paths: ["**/*.sql"], instructions: text }] });

    const a = promptIdentityDigest(withInstruction("Use snake_case identifiers."), { paths: [] });
    const b = promptIdentityDigest(withInstruction("Prefer parameterized queries."), {
      paths: [],
    });
    expect(a).not.toBe(b);
    expect(a).toBe(expectedDigest(withInstruction("Use snake_case identifiers.")));

    const compiled = withInstruction("Use snake_case identifiers.");
    const withoutRename = buildRuleFile(compiled, { paths: [] });
    const withRename = buildRuleFile(compiled, { paths: [] }, ["src/renamed.sql"]);
    expect(withRename.rules).toEqual(withoutRename.rules);
    expect(withRename.exclude).not.toEqual(withoutRename.exclude);
  });

  /**
   * Declared contract pairs (`profile.contractPairs`, rendered by `rule-file.ts`'s
   * `contractPairsSection`) are rule identity for exactly the reason path instructions are above:
   * they change what the model is told to read alongside a matching file, so a cached finding
   * produced under one declared pairing must never be replayed as the answer under a different
   * one. They reach this digest the same way, too — through nothing more than `profile` already
   * being a parameter here.
   */
  it("changes when contractPairs changes, and produces equal digests for equal profiles", () => {
    const withCounterpart = (counterpart: string): CompiledProfile =>
      profile({ contractPairs: [{ paths: ["src/a.ts"], counterparts: [counterpart] }] });

    const a = promptIdentityDigest(withCounterpart("src/b.ts"), { paths: [] });
    const b = promptIdentityDigest(withCounterpart("src/c.ts"), { paths: [] });
    const aAgain = promptIdentityDigest(withCounterpart("src/b.ts"), { paths: [] });
    const baseline = promptIdentityDigest(profile(), { paths: [] });

    expect(a).not.toBe(b);
    expect(a).not.toBe(baseline);
    expect(a).toBe(aAgain);
    expect(a).toBe(expectedDigest(withCounterpart("src/b.ts")));
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
