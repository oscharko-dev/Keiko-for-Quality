// The pure half of the rule A/B instrument. Zero model calls, zero git, zero filesystem — the same
// split every harness here uses, so the logic that decides what "moved" means is testable without
// spending a token.
//
// The whole design rests on one admission: this corpus's per-case outcomes are not deterministic.
// Two cases are documented rotators, the deployment's sampling has been shown to roam under a
// byte-identical prompt, and a full wave's headline numbers routinely differ by one case for no
// reason at all. An instrument that reports a difference without accounting for that is not
// measuring the rule; it is measuring the coin.
//
// So nothing here averages. A pairing settles to MOVED only under unanimity on both sides, and
// every case that flipped within an arm is named as a ROTATOR rather than folded into a rate. The
// output is deliberately harder to read than a percentage, because a percentage would be easier to
// believe than the data supports.

/** Per case, per arm, per repetition. Measured across the 2026-08-06 waves. */
export const MEASURED_BAND = { low: 20_000, high: 140_000 };

/**
 * What a pair of observation lists says, and — more often — what it refuses to say.
 *
 * `undefined` entries are runs that never reached the model. They are dropped rather than counted
 * as failures: `corpus/run.mjs` already separates a miss from a connection fault, and collapsing
 * the two here would let a flaky endpoint read as a rule effect. A pairing whose arms end up with
 * different observation counts is still settled — on what was actually observed — and the counts
 * are carried so a reader can see the asymmetry rather than infer it.
 */
export function settlePairing(id, aRaw, bRaw) {
  const a = aRaw.filter((o) => o !== undefined);
  const b = bRaw.filter((o) => o !== undefined);
  const aPassed = a.filter((o) => o.pass).length;
  const bPassed = b.filter((o) => o.pass).length;
  const pairing = {
    id,
    aObserved: a.length,
    bObserved: b.length,
    aPassed,
    bPassed,
    aTokens: meanOf(a.map((o) => o.tokens)),
    bTokens: meanOf(b.map((o) => o.tokens)),
    unreached: aRaw.length - a.length + (bRaw.length - b.length),
    verdict: verdictOf(a, b, aPassed, bPassed),
  };
  return pairing;
}

/**
 * The four things a pairing can be, in the order they are checked.
 *
 * UNMEASURED before anything else: an arm with no observation cannot be compared, and calling that
 * "SAME" would turn a dead endpoint into evidence of no effect. ROTATOR before MOVED, because a
 * case that disagrees with ITSELF cannot be evidence about the rule no matter how the arms line up.
 */
function verdictOf(a, b, aPassed, bPassed) {
  if (a.length === 0 || b.length === 0) return "UNMEASURED";
  const aUnanimous = aPassed === 0 || aPassed === a.length;
  const bUnanimous = bPassed === 0 || bPassed === b.length;
  if (!aUnanimous || !bUnanimous) return "ROTATOR";
  if (aPassed > 0 === bPassed > 0) return "SAME";
  return "MOVED";
}

function meanOf(values) {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/**
 * The run as a whole: what moved, what refused to hold still, and what it cost.
 *
 * `netMoved` is a signed count and nothing more. It is deliberately not a rate: with a handful of
 * cases and a corpus that roams, a percentage would imply a precision the design cannot deliver.
 */
export function summarizeAb(pairings) {
  const movedToB = pairings.filter((p) => p.verdict === "MOVED" && p.bPassed > 0);
  const movedToA = pairings.filter((p) => p.verdict === "MOVED" && p.aPassed > 0);
  const rotators = pairings.filter((p) => p.verdict === "ROTATOR");
  const unmeasured = pairings.filter((p) => p.verdict === "UNMEASURED");
  const aTokens = pairings.reduce((sum, p) => sum + p.aTokens, 0);
  const bTokens = pairings.reduce((sum, p) => sum + p.bTokens, 0);
  return {
    cases: pairings.length,
    movedToB: movedToB.map((p) => p.id),
    movedToA: movedToA.map((p) => p.id),
    rotators: rotators.map((p) => p.id),
    unmeasured: unmeasured.map((p) => p.id),
    netMoved: movedToB.length - movedToA.length,
    aTokens,
    bTokens,
    tokenDelta: aTokens === 0 ? null : (bTokens - aTokens) / aTokens,
  };
}

function percent(fraction) {
  if (fraction === null) return "n/a";
  const sign = fraction > 0 ? "+" : "";
  return `${sign}${(fraction * 100).toFixed(1)}%`;
}

/** A paragraph a reader can act on, and cannot mistake for a qualification. */
export function renderAbEvidence({ armA, armB, reps, pairings, summary }) {
  const lines = [
    "# Rule A/B — paired, repeated, interleaved",
    "",
    "Not a qualification: this measures ONE change against ONE baseline on the cases named below,",
    "and says nothing about the reviewer's absolute recall. See corpus/rule-ab.mjs's header for why",
    "a wave-to-wave delta could not have answered the same question.",
    "",
    `- Arm A: \`${armA.path}\` — rule \`${armA.ruleDigest}\``,
    `- Arm B: \`${armB.path}\` — rule \`${armB.ruleDigest}\``,
    `- ${String(summary.cases)} case(s), ${String(reps)} repetition(s) per arm, arms interleaved`,
    "",
    "| case | A | B | verdict | tokens A | tokens B |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const p of pairings) {
    lines.push(
      `| ${p.id} | ${String(p.aPassed)}/${String(p.aObserved)} | ${String(p.bPassed)}/${String(p.bObserved)} ` +
        `| ${p.verdict} | ${p.aTokens.toLocaleString("en-US")} | ${p.bTokens.toLocaleString("en-US")} |`,
    );
  }
  lines.push("", "## What this says", "");
  lines.push(
    summary.netMoved === 0
      ? "**No case moved.** Every pairing was unanimous on both sides and agreed, or refused to hold still."
      : `**Net ${summary.netMoved > 0 ? "+" : ""}${String(summary.netMoved)} case(s) to arm B.**`,
  );
  if (summary.movedToB.length > 0) lines.push(`- Gained under B: ${summary.movedToB.join(", ")}`);
  if (summary.movedToA.length > 0) lines.push(`- Lost under B: ${summary.movedToA.join(", ")}`);
  if (summary.rotators.length > 0) {
    lines.push(
      `- **Rotators, excluded from the count**: ${summary.rotators.join(", ")} — these disagreed`,
      "  with themselves across repetitions of the SAME arm, so they are evidence about the",
      "  deployment, not about the rule.",
    );
  }
  if (summary.unmeasured.length > 0) {
    lines.push(
      `- **Never reached the model**: ${summary.unmeasured.join(", ")} — no observation, not a miss.`,
    );
  }
  lines.push(
    "",
    `Spend: A ${summary.aTokens.toLocaleString("en-US")} tokens, B ${summary.bTokens.toLocaleString("en-US")} ` +
      `(${percent(summary.tokenDelta)}). A rule that buys a case at a large enough cost has not`,
    "obviously won; the token column is here so that trade is visible rather than argued.",
    "",
  );
  return lines.join("\n");
}
