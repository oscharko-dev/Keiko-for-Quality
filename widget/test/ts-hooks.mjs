import { registerHooks } from "node:module";

/**
 * Preload for the widget test suites (`npm run test:widget`), the same `.js`→`.ts` resolve hook
 * `scripts/register-ts-hooks.mjs` carries for `src/` — see that file for the full rationale.
 * Scoped to `/widget/` parents so it can never shadow the product hook's behaviour.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.endsWith(".js") && (context.parentURL ?? "").includes("/widget/")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
