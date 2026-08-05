/**
 * The one model every live run this project makes is measured against (AGENTS.md, "Every live run
 * this project makes uses `gpt-oss-120b`").
 *
 * Scope, precisely: this binds what WE measure and what WE deploy. It is not a claim about the
 * product's reach — `model_id` is a consumer input, the protocol adapter speaks openai and
 * anthropic, and what any other consumer configures is their decision. A qualification, though, is
 * a property of the *pairing* (engine + rule + model), so recall and precision measured against a
 * model this project does not run say nothing about the reviewer that ships.
 *
 * This exists as an executable check rather than a line in a document because a document did not
 * stop it: on 2026-08-05 a full 32-case qualification was run against a different chat model, at
 * real cost, purely because that model was listed first in a consumer's gateway config. The model
 * that should have been used was already named in the previous release's own evidence file.
 */
export const QUALIFICATION_MODEL = "gpt-oss-120b";

/**
 * The escape hatch, and why it is one rather than a silent default: a deliberate cross-model
 * experiment is a legitimate thing to run, and refusing it outright would push the next person to
 * edit this constant instead — which is exactly how a pin stops meaning anything. Setting it is a
 * decision the operator makes once, in the open, and the binding line records the model either way.
 */
export const DEVIATION_ENV = "OCR_ALLOW_MODEL_DEVIATION";

/**
 * Decides whether a run may proceed with the configured model.
 *
 * Returns `{ ok: true }` when the model is the pinned one, or when deviation is explicitly allowed
 * (`allowed: true` marks the second case so a caller can say so in its output). Returns
 * `{ ok: false, reason }` otherwise, with a reason written for whoever is about to spend money.
 *
 * Takes the environment as a parameter rather than reading `process.env` directly, so the refusal
 * can be tested without a live endpoint or a mutated global.
 */
export function checkQualificationModel(env = process.env) {
  const model = (env.OCR_LLM_MODEL ?? "").trim();
  if (model === QUALIFICATION_MODEL) return { ok: true, allowed: false };
  if (env[DEVIATION_ENV] === "1") return { ok: true, allowed: true };
  const named = model === "" ? "(unset)" : model;
  return {
    ok: false,
    reason:
      `OCR_LLM_MODEL is ${named}, but this project measures only against ${QUALIFICATION_MODEL}.\n` +
      `  A qualification is a property of the pairing (engine + rule + model), so a run against\n` +
      `  another model measures nothing about the reviewer that ships — see AGENTS.md.\n` +
      `  Set OCR_LLM_MODEL=${QUALIFICATION_MODEL}, or ${DEVIATION_ENV}=1 for a deliberate\n` +
      `  cross-model experiment.`,
  };
}
