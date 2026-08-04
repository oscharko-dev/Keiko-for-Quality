#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * Proves the committed bundles are the ones this source produces, and that both actually run.
 *
 * Consumers execute `dist/index.js` (the action) and `dist/cli.js` (the local CLI — issue #98's
 * digest-verifiable release asset), never `src/`. A pinned action SHA, or a pinned CLI digest, is
 * only a meaningful trust anchor if the artifact at that SHA/digest is the source at that
 * SHA/digest — and if it starts at all.
 */

function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- 1. Reproducible from source -------------------------------------------------------------

const ARTIFACTS = ["dist/index.js", "dist/cli.js"];
const committed = new Map(ARTIFACTS.map((path) => [path, readFileSync(path)]));

execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "pipe" });

const rebuilt = new Map(ARTIFACTS.map((path) => [path, readFileSync(path)]));

for (const path of ARTIFACTS) {
  const before = digestOf(committed.get(path));
  const after = digestOf(rebuilt.get(path));
  if (before !== after) {
    console.error(`${path} is stale — run \`npm run build\` and commit the result.`);
    console.error(`  committed: ${before}`);
    console.error(`  rebuilt:   ${after}`);
    process.exit(1);
  }
}

// --- 2. dist/index.js loads and fails closed, the way a runner executes it --------------------

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

// --- 3. dist/cli.js runs standalone: --help succeeds, a usage error settles in one line ---------

/**
 * Issue #98's own acceptance criterion: `node dist/cli.js --help` must run on a machine with only
 * Node itself — no `scripts/register-ts-hooks.mjs`, no tsconfig, no node_modules, no network. The
 * child's environment is restricted to `PATH` alone, the same restriction the dist/index.js check
 * above already applies, so this proves the bundle does not secretly lean on this repository's own
 * dev environment (a `KFQ_*` variable, an ambient loader, ...) to reach its help text.
 */
const help = spawnSync(process.execPath, ["dist/cli.js", "--help"], {
  encoding: "utf8",
  env: { PATH: process.env.PATH ?? "" },
});

if (help.error) {
  console.error(`dist/cli.js could not be executed: ${help.error.message}`);
  process.exit(1);
}
if (help.status !== 0) {
  console.error(
    `dist/cli.js --help exited ${String(help.status)}; expected 0 (EXIT_CODE.completeClean).`,
  );
  process.exit(1);
}
if (help.stderr.trim() !== "") {
  console.error("dist/cli.js --help wrote to stderr; --help must be silent there.");
  console.error(help.stderr.trim().split("\n").slice(0, 5).join("\n"));
  process.exit(1);
}
if (!help.stdout.includes("Keiko for Quality") || !help.stdout.includes("Exit codes:")) {
  console.error("dist/cli.js --help did not print the expected help text.");
  process.exit(1);
}

/**
 * The same standalone run, down a usage-error path instead (issue #96's exit-code contract):
 * proves argument validation survives bundling too, and that a bad flag still settles as ONE line
 * on stderr — with stdout left clean for a report consumer — rather than a leaked stack trace.
 */
const badFormat = spawnSync(process.execPath, ["dist/cli.js", "--format", "nope"], {
  encoding: "utf8",
  env: { PATH: process.env.PATH ?? "" },
});

if (badFormat.error) {
  console.error(`dist/cli.js could not be executed: ${badFormat.error.message}`);
  process.exit(1);
}
if (badFormat.status !== 4) {
  console.error(
    `dist/cli.js --format nope exited ${String(badFormat.status)}; expected 4 (EXIT_CODE.usageError).`,
  );
  process.exit(1);
}
if (badFormat.stdout !== "") {
  console.error("dist/cli.js --format nope wrote to stdout; a usage error belongs on stderr only.");
  process.exit(1);
}
const badFormatLines = badFormat.stderr.split("\n").filter((line) => line !== "");
if (badFormatLines.length !== 1 || !badFormatLines[0].startsWith("error: --format")) {
  console.error("dist/cli.js --format nope did not fail with a single-line --format error.");
  console.error(`  got: ${JSON.stringify(badFormat.stderr)}`);
  process.exit(1);
}

console.log(
  `dist/index.js (sha256 ${digestOf(rebuilt.get("dist/index.js")).slice(0, 16)}…) and ` +
    `dist/cli.js (sha256 ${digestOf(rebuilt.get("dist/cli.js")).slice(0, 16)}…) match source ` +
    "and run standalone",
);
