// The harness's rule generation, extracted from run.mjs so it is import-testable in-process:
// node --test's coverage only sees code the test process itself executes, and run.mjs is a script
// with top-level side effects (env checks, process.exit) that cannot be imported safely.
//
// Node strips types from a file it is told to load as `.ts`, but the product sources import each
// other by their compiled `.js` names (verbatimModuleSyntax) — under plain `node` that chain dies
// at the first internal import. Vitest resolves that mapping; node does not. The hook below maps a
// `.js` specifier that fails to resolve inside `src/` onto its `.ts` sibling. Registration is
// guarded so callers need not care whether another module already registered it.
import { registerHooks } from "node:module";

let hooksRegistered = false;

export function registerTsExtensionHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.endsWith(".js") && (context.parentURL ?? "").includes("/src/")) {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        }
        throw error;
      }
    },
  });
}

/**
 * Builds the serialized rule document from profile JSON text **through the production loader** —
 * the same `loadReviewProfile` entry point the action uses, validation and defaulting included.
 *
 * That routing is the point, not a convenience: the harness once parsed the profile with
 * `JSON.parse` and fed the raw object into `buildRuleFile`, whose input only ever resembled a
 * compiled profile by coincidence. #44 ended the coincidence (the loader defaults
 * `pathInstructions`; the raw shape lacks it) and the corpus crashed at startup while every
 * product path stayed green. Restating a production step instead of calling it is how a harness
 * silently diverges — same fixture rule as the sanitizer note in run.mjs.
 */
export async function generateRuleDocument(profileJsonText) {
  registerTsExtensionHooks();
  const { loadReviewProfile } = await import("../src/config/profile.ts");
  const { buildRuleFile, serializeRuleFile } = await import("../src/engine/rule-file.ts");
  return serializeRuleFile(buildRuleFile(loadReviewProfile(profileJsonText)));
}
