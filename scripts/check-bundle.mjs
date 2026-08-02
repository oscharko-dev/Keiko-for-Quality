#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * Proves the committed bundle is the one this source produces, and that it actually runs.
 *
 * Consumers execute `dist/index.js`, not `src/`. A pinned action SHA is only a meaningful trust
 * anchor if the artifact at that SHA is the source at that SHA — and if it starts at all.
 */

// --- 1. Reproducible from source -------------------------------------------------------------

const committed = readFileSync("dist/index.js");
const before = createHash("sha256").update(committed).digest("hex");

execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "pipe" });

const rebuilt = readFileSync("dist/index.js");
const after = createHash("sha256").update(rebuilt).digest("hex");

if (before !== after) {
  console.error("dist/index.js is stale — run `npm run build` and commit the result.");
  console.error(`  committed: ${before}`);
  console.error(`  rebuilt:   ${after}`);
  process.exit(1);
}

// --- 2. Loads and fails closed, the way a runner executes it ----------------------------------

/**
 * Executed as its own process, exactly as the action runtime does.
 *
 * This is not paranoia about the bundler. v0.1.0 shipped a CommonJS bundle into a package declaring
 * `"type": "module"`, so every consumer would have hit "require is not defined" — and it was invisible
 * locally because the only check was `require('./dist/index.js')` from a CommonJS context, which
 * loads under entirely different rules. The artifact has to be started the way it is really started.
 *
 * With no event payload the entrypoint must fail closed: exit non-zero, emit exactly the redacted
 * `run.failed` diagnostic, and leak nothing about why.
 */
const run = spawnSync(process.execPath, ["dist/index.js"], {
  encoding: "utf8",
  env: { PATH: process.env.PATH ?? "" },
});

if (run.error) {
  console.error(`dist/index.js could not be executed: ${run.error.message}`);
  process.exit(1);
}

const stdout = run.stdout.trim();
const stderr = run.stderr.trim();

if (stderr !== "") {
  console.error("dist/index.js wrote to stderr; the diagnostics sink is the only output path.");
  console.error(stderr.split("\n").slice(0, 5).join("\n"));
  process.exit(1);
}

if (run.status !== 1) {
  console.error(`dist/index.js exited ${String(run.status)} without an event; expected 1.`);
  process.exit(1);
}

if (stdout !== '{"code":"run.failed"}') {
  console.error("dist/index.js did not fail closed with the expected redacted diagnostic.");
  console.error(`  got: ${stdout.split("\n").slice(0, 3).join(" | ")}`);
  process.exit(1);
}

console.log(
  `dist/index.js matches source (sha256 ${after.slice(0, 16)}…) and fails closed on load`,
);
