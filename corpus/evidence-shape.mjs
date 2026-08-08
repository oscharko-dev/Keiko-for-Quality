/**
 * Does a finding say WHEN the defect bites?
 *
 * Measured on production, 2026-08-05, over every inline finding the two bots left on
 * oscharko-dev/Keiko — 492 from this product, 358 from OpenAI's Codex connector. Over the same
 * window, 23% of our findings were followed by a change to the line they sat on, against 64% of
 * Codex's. Looking for what differs in the prose turned up one property that survives scrutiny:
 *
 *     states a triggering condition     ours 22.0%     Codex 65.4%
 *
 * Every Codex finding is written condition → mechanism → consequence → remedy; ours are written
 * remedy → description of the change. A reader can check whether a stated condition can occur. A
 * reader cannot check "this makes X depend on Y", so they resolve the thread and move on. Inside
 * our own history the same property decayed: 29.2% of v0.10.0 findings, 10.5% of v0.14.0's.
 *
 * ## Why only this one predicate
 *
 * A second predicate — "states the consequence" — was written, measured, and thrown away, and the
 * reason is worth keeping. It scored ours 23.0% against Codex's 40.5%, an apparently useful 17.5pp
 * gap. Widening it by one causal form (`, so <clause>`, which real findings plainly use) moved both
 * to 66.9% and 71.8%: a 4.9pp gap. A signal that collapses when a synonym is added was measuring
 * house style, not substance.
 *
 * The condition predicate was put through the same test and held:
 *
 *     sentence-anchored only            21.7% / 63.1%    41.4pp
 *     + the every-path forms (shipped)  22.0% / 65.4%    43.4pp
 *     only `When`/`If`                  17.9% / 56.4%    38.5pp
 *     plus `Given`/`Should`/`On`        25.4% / 65.4%    40.0pp
 *     no sentence anchor at all         66.1% / 84.4%    18.3pp
 *
 * The every-path forms ("on every call", "for all inputs") were added when the rule text grew a
 * branch for them: a defect that is wrong on all paths has no circumstance to name, and the rule
 * now asks for that to be SAID rather than left silent, so a predicate blind to it would score a
 * finding that followed the rule exactly as though it had ignored it. Adding them moved the
 * numbers by 0.3pp and 2.3pp and widened the gap, which is what a form being genuinely rare and
 * genuinely valid looks like — unlike the consequence predicate, which collapsed.
 *
 * Every variant keeps a large gap, so the property is structural rather than lexical. That is the
 * whole argument for grading on it, and the reason the consequence half is absent instead of
 * reported alongside as a weaker number — a number nobody should act on is not worth printing.
 *
 * ## What this does not claim
 *
 * The predicate asks whether the prose has the SHAPE of a claim about a circumstance. It cannot
 * tell whether the circumstance is real, reachable, or relevant, and no regex can. It is a floor
 * against assertion-without-circumstance, not a measure of correctness.
 *
 * This exact expression produced the numbers above. Changing it re-bases every figure in
 * corpus/evidence/ that cites them, so evidence-shape.test.mjs pins it against fixtures drawn from
 * both bots' real output.
 */

/** Comment furniture that is not the finding's argument: collapsed blocks, markers, fenced code. */
function prose(body) {
  return String(body ?? "")
    .replace(/<details>[\s\S]*?<\/details>/gu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/```[\s\S]*?```/gu, "");
}

/**
 * A condition word opening a sentence, or ending a bold title.
 *
 * The anchor is load-bearing: dropping it takes ours from 21.7% to 66.1%, because our findings do
 * mention circumstances — inside the fix they propose, not as the condition under which the code is
 * wrong. Those are different claims and only one is checkable.
 */
const ANCHORED_CONDITION =
  /(^|[.!?]\s|\*\*\s*)(When|If|Once|After|While|Whenever|Because)\s+[a-z`]/imu;

/** The every-path forms: a defect wrong on all paths has no circumstance to name, and the rule text
 *  asks for that to be SAID rather than left silent. */
const EVERY_PATH_CONDITION =
  /\b(on every (call|run|request|invocation)|for all inputs|on all paths|in every case)\b/imu;

/**
 * The circumstance under which the defect occurs, stated as a circumstance: "When the loopback peer
 * omits Content-Length…", "If the BFF stalls before returning headers…".
 *
 * Two literals rather than the one alternation that produced the numbers above, because that
 * expression scored 27 against Sonar's regex-complexity ceiling of 20 (S5843). The accepted set is
 * unchanged and the figures are not re-based: a top-level `|` is the union of its two sides, and a
 * union matches exactly when one of its sides does. Both halves must keep the same flags, `m` above
 * all — it is what makes `^` mean "a line start" rather than "the body's first character".
 */
export function statesTriggeringCondition(body) {
  const text = prose(body);
  return ANCHORED_CONDITION.test(text) || EVERY_PATH_CONDITION.test(text);
}

/** Counts over a set of bodies, for a run report or an offline sweep over real production output. */
export function evidenceShapeCounts(bodies) {
  const list = [...bodies];
  return {
    findings: list.length,
    withCondition: list.filter((body) => statesTriggeringCondition(body)).length,
  };
}
