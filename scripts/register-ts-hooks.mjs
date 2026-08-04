import { registerHooks } from "node:module";

/**
 * Preload for `npm run review` (see the `review` script in `package.json`).
 *
 * Node strips types from a file it is told to run as `.ts`, but the product sources import each
 * other by their compiled `.js` names (`verbatimModuleSyntax`, `moduleResolution: NodeNext`) —
 * under plain `node` that chain dies at the first internal import, since Node's own resolver never
 * remaps a `.js` specifier onto a same-named `.ts` file. `corpus/rule-source.mjs` carries the
 * identical hook for the same reason, for the corpus harness's own in-process imports of `src/`;
 * this copy exists so `src/cli.ts` — the one file in `src/` Node ever loads directly, rather than
 * through `tsc`'s `build/` output or Vitest's own resolver — can run standalone.
 *
 * Loaded with `--import` rather than called from inside `cli.ts` itself: ES module imports resolve
 * before any of a module's own top-level code runs, so registering this hook from within `cli.ts`
 * would be too late to affect `cli.ts`'s own import statements. `--import` preloads this module
 * before `cli.ts`'s module graph is resolved at all.
 */
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
