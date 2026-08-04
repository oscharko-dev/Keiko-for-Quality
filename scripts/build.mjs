#!/usr/bin/env node
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/**
 * Shared discipline for every committed bundle this script produces: one file, reproducible from
 * source, runnable under nothing but Node itself. ESM throughout, because package.json declares
 * "type": "module" — Node resolves the nearest package.json for each outfile below and would
 * reject a CommonJS bundle there with "require is not defined".
 */
const SHARED_OPTIONS = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
};

function banner(subject) {
  return {
    js: `// Keiko for Quality ${subject}${pkg.version} — generated bundle, do not edit.\n// Source: https://github.com/oscharko-dev/Keiko-for-Quality`,
  };
}

/**
 * Bundles the action to a single committed artifact.
 *
 * A GitHub Action runs from the repository it is referenced from, with no install step, so the
 * executable form has to be committed. Bundling to one file keeps that artifact reviewable and
 * makes the reproducibility check in check-bundle.mjs a meaningful statement about the source.
 */
await build({
  ...SHARED_OPTIONS,
  entryPoints: ["src/action/entry.ts"],
  outfile: "dist/index.js",
  banner: banner(""),
});

console.log("built dist/index.js");

/**
 * Bundles the local CLI (`src/cli.ts`, issue #96) to the same discipline, and for the same reason:
 * epic #94's release-asset child (issue #98) makes this the file IDE extensions download, digest-
 * verify, and execute — pinned exactly the way this repository pins the review engine
 * (`src/engine/pinned-release.ts`). That only works if the artifact needs nothing this repository
 * has locally: no `scripts/register-ts-hooks.mjs`, no tsconfig, no node_modules. Bundling is what
 * makes that true, not merely convenient — `npm run review` runs the unbundled source through the
 * type-stripping loader today, but a consumer outside this repository has neither the loader nor
 * the source tree.
 */
await build({
  ...SHARED_OPTIONS,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: banner("CLI "),
});

console.log("built dist/cli.js");
