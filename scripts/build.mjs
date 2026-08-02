#!/usr/bin/env node
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/**
 * Bundles the action to a single committed artifact.
 *
 * A GitHub Action runs from the repository it is referenced from, with no install step, so the
 * executable form has to be committed. Bundling to one file keeps that artifact reviewable and
 * makes the reproducibility check in check-bundle.mjs a meaningful statement about the source.
 */
await build({
  entryPoints: ["src/action/entry.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node24",
  // ESM, because package.json declares "type": "module": Node resolves the nearest package.json
  // for dist/index.js and would reject a CommonJS bundle there with "require is not defined".
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: `// Keiko for Quality ${pkg.version} — generated bundle, do not edit.\n// Source: https://github.com/oscharko-dev/Keiko-for-Quality`,
  },
});

console.log("built dist/index.js");
