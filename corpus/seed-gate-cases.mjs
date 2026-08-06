// The consumer-seed case set — real defects planted into real files of the consumer repository
// the gate is pointed at (today: oscharko-dev/Keiko, via --repo).
//
// These are NOT corpus cases. corpus/cases.mjs is the frozen qualification corpus over synthetic
// fixtures; this set exists because a reviewer that aces synthetic fixtures can still miss a
// defect sitting in a 50-line production file with its own comments, style, and context. Each
// case pins an exact `find` string against the consumer's current `dev`: when the consumer
// refactors that code, `applySeed` refuses with "seed stale" and the case must be recalibrated
// deliberately — never silently skipped.
//
// Tier vocabulary (and the calibration promise behind `required`):
// - tier 1 — blatant: a removed guard or swallowed error a competent human reviewer would flag
//   on every read. A tier-1 miss is a release blocker by definition.
// - tier 2 — subtle: plausible-looking, type-correct, wrong. Expected to be harder; a tier-2
//   case starts `required: true` and may be demoted to advisory ONLY with a dated note naming
//   the run evidence that showed it rotating, mirroring how corpus rotation is handled.

export const SEED_CASES = [
  {
    id: "auth-default-flip",
    tier: 1,
    required: true,
    file: "packages/keiko-server/src/qualityIntelligence/connectorAuthorization.ts",
    find: "const isExplicitTrue = (value: unknown): boolean => value === true;",
    replace: "const isExplicitTrue = (value: unknown): boolean => value !== undefined;",
    rationale:
      "Flips the file's stated default-deny contract (header: authorisation 'DEFAULTS TO FALSE; " +
      "only flips on an explicit boolean `true`') into 'any present value authorises' — " +
      "including `false`. Every authorisation predicate in the file routes through this helper, " +
      "so the one-line change silently authorises both connectors for any config that mentions " +
      "the flag at all.",
  },
  {
    id: "capabilities-crossover",
    tier: 2,
    required: true,
    file: "packages/keiko-server/src/qualityIntelligence/connectorAuthorization.ts",
    find:
      "  figma: isFigmaConnectorAuthorized(config),\n" +
      "  jira: isJiraConnectorAuthorized(config),",
    replace:
      "  figma: isJiraConnectorAuthorized(config),\n" +
      "  jira: isFigmaConnectorAuthorized(config),",
    rationale:
      "Classic copy-paste crossover in summariseQiConnectorCapabilities: each capability now " +
      "reports the OTHER connector's authorisation. Type-correct, symmetric-looking, and wrong " +
      "for every config where the two flags differ — the capabilities route then advertises a " +
      "connector the config never authorised.",
  },
];
