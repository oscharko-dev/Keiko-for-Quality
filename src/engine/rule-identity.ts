import { createHash } from "node:crypto";

import { sha256, type Sha256 } from "../core/brands.js";
import type { CompiledProfile } from "../config/profile.js";
import type { GuidelineIndex } from "../config/guidelines.js";
import { buildRuleFile, serializeRuleFile } from "./rule-file.js";

/**
 * A stable digest of the rule document's *static* shape — the catch-all guidance, the consumer's
 * `include`/`generated` lists, the profile's per-path instructions, and the guideline paths —
 * computed by calling `buildRuleFile` with no per-run exclude list at all.
 *
 * Per-path instructions (`profile.pathInstructions`, rendered by `rule-file.ts`'s
 * `pathInstructionsSection`) are rule identity, not per-run state: they change what the model is
 * asked, the same way the catch-all guidance or a guideline path does, so a cached finding produced
 * under one instruction text must never be replayed as an answer to a different one. They reach
 * this digest through nothing more than `profile` already being a parameter — there is no separate
 * plumbing to keep in sync, and none to forget the next time this file changes.
 *
 * **Why this must not be `writeRuleFile`'s `ruleDigest`.** That digest is recorded with a run
 * because it covers the *executed* rule file, which also carries the run's dynamic exclude list:
 * v0.8.0's mechanically-clean paths and, from v0.9.0, this run's cache hits — both of which differ
 * on every head. A review-cache lookup needs a digest *before* that list exists (the lookup is what
 * decides part of it), so keying on the executed digest would be circular: whether a path hits the
 * cache would depend on a digest that itself depends on which paths hit the cache. This function
 * answers a different, stable question — "what guidance was this file reviewed under?" — so two
 * runs that applied identical rules but excluded different paths still key identically, and a
 * cache entry written under one run's exclude shape is still replayable under another's.
 *
 * The two digests are expected to differ on almost every run, and that is not a bug in either one:
 * `ruleDigest` (this function) identifies the guidance; `writeRuleFile`'s digest identifies the
 * exact bytes the engine actually read for one specific invocation.
 */
export function promptIdentityDigest(profile: CompiledProfile, guidelines: GuidelineIndex): Sha256 {
  const body = serializeRuleFile(buildRuleFile(profile, guidelines));
  return sha256(createHash("sha256").update(body).digest("hex"));
}
