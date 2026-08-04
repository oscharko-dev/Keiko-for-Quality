/**
 * Did a corpus run measure the reviewer, or only its own connection?
 *
 * This exists because the honest answer to a broken instrument is "I did not measure", never a
 * score. A misconfigured endpoint makes every case throw before the model is reached; each one
 * lands in the harness's error branch with zero tokens, and a scoreboard computed over those
 * results prints "recall 0/19, precision 0/4" — total collapse of review quality, and nothing of
 * the kind. That output cost a night of debugging on a run whose only fault was an endpoint path
 * shape, and it is the more expensive failure mode by far: a plausible catastrophe invites a hunt
 * for a regression that never existed, while a refusal to score invites a look at the connection.
 *
 * The rule is deliberately coarse. It does not try to distinguish a slow model from a dead one, or
 * a partial outage from a bad key; it answers only whether any case reached the model at all, and
 * how many were lost before they could. Anything finer would be a second instrument needing its
 * own trust.
 */

/**
 * @param {readonly {kind: string, tokens: number}[]} results one entry per attempted case
 * @param {number} tokens total tokens the run spent
 * @returns {{measured: boolean, reason: "measured"|"no_cases"|"model_unreached", errored: number, attempted: number}}
 */
export function classifyMeasurement(results, tokens) {
  const attempted = results.length;
  const errored = results.filter((r) => r.kind === "error").length;
  // `no_cases` is kept separate from `model_unreached` because they need different words in front
  // of a maintainer. An empty run is a mistyped `--only`, not a broken endpoint — and it must not
  // read as success either, which is the trap on this side: a typo that selects nothing would
  // otherwise exit zero and look like a clean run of everything.
  if (attempted === 0) return { measured: false, reason: "no_cases", errored, attempted };
  // Zero tokens means nothing reached the model even where cases ran; all-errored means the
  // harness never got far enough to ask, which zero tokens usually but not always also shows.
  if (tokens <= 0 || errored >= attempted) {
    return { measured: false, reason: "model_unreached", errored, attempted };
  }
  return { measured: true, reason: "measured", errored, attempted };
}
