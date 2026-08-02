import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, resolvePrNumbers, splitRepo, USAGE } from "./arena.mjs";

/**
 * Tests for the arena CLI's own decision logic (issue #39): argument parsing, deciding which pull
 * requests to measure, and splitting `owner/name`. `main` itself — the part that actually fetches,
 * writes files, and calls `process.exit` — is intentionally not exercised here; that is the same
 * "thin and untested against the network" boundary `corpus/arena-fetch.mjs` documents, one level up.
 * `parseArgs` and `resolvePrNumbers` raise a plain `Error` instead of exiting, which is what makes
 * them safe to call from a test process at all.
 */

test("parseArgs defaults repo, state, and output directory when only pull request numbers are given", () => {
  const options = parseArgs(["2926"]);
  assert.equal(options.repo, "oscharko-dev/Keiko");
  assert.equal(options.state, "all");
  assert.equal(options.outDir, "corpus/evidence");
  assert.equal(options.since, null);
  assert.deepEqual(options.prNumbers, [2926]);
});

test("parseArgs collects every positional numeric argument as a pull request number", () => {
  const options = parseArgs(["2926", "2924", "17"]);
  assert.deepEqual(options.prNumbers, [2926, 2924, 17]);
});

test("parseArgs reads every named flag", () => {
  const options = parseArgs([
    "--repo",
    "owner/name",
    "--since",
    "2026-06-01",
    "--state",
    "open",
    "--generated-at",
    "2026-01-01T00:00:00Z",
    "--out-dir",
    "/tmp/out",
    "--out-json",
    "/tmp/out.json",
    "--out-md",
    "/tmp/out.md",
  ]);
  assert.equal(options.repo, "owner/name");
  assert.equal(options.since, "2026-06-01");
  assert.equal(options.state, "open");
  assert.equal(options.generatedAt, "2026-01-01T00:00:00Z");
  assert.equal(options.outDir, "/tmp/out");
  assert.equal(options.outJson, "/tmp/out.json");
  assert.equal(options.outMd, "/tmp/out.md");
});

test("parseArgs throws on an argument it does not recognize", () => {
  assert.throws(() => parseArgs(["--unknown-flag"]), /unrecognized argument: --unknown-flag/);
});

/**
 * Regression pin: a flag as the last argument with nothing after it used to store `undefined`
 * without a check, and the failure surfaced later in a confusing way — `--repo` fed `undefined`
 * into `splitRepo`'s `.split("/")` (an uncaught `TypeError`, not this module's own error message),
 * `--since` left `options.since` as `undefined`, which the `!== null` check downstream still
 * treats as "given", and `--generated-at` would have written the literal `undefined` into the
 * evidence document's timestamp. Every value-taking flag must fail at the point it is missing its
 * value, not somewhere downstream that has to guess why.
 */
test("parseArgs throws immediately when a flag is given with no value after it", () => {
  for (const flag of [
    "--repo",
    "--since",
    "--state",
    "--generated-at",
    "--out-dir",
    "--out-json",
    "--out-md",
  ]) {
    assert.throws(
      () => parseArgs([flag]),
      new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} requires a value`),
      `${flag} with no value must throw, not store undefined`,
    );
  }
});

test("resolvePrNumbers deduplicates and sorts explicit pull request numbers ascending", () => {
  const options = { since: null, prNumbers: [2926, 17, 2926, 3] };
  assert.deepEqual(resolvePrNumbers(options, "owner", "repo"), [3, 17, 2926]);
});

test("resolvePrNumbers rejects explicit pull request numbers combined with --since", () => {
  const options = { since: "2026-01-01", prNumbers: [1] };
  assert.throws(
    () => resolvePrNumbers(options, "owner", "repo"),
    /either explicit pull request numbers or --since/,
  );
});

test("resolvePrNumbers rejects neither explicit numbers nor --since with the usage string", () => {
  const options = { since: null, prNumbers: [] };
  assert.throws(
    () => resolvePrNumbers(options, "owner", "repo"),
    new RegExp(USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("resolvePrNumbers delegates to the injected discover function for --since, with the right arguments", () => {
  const options = { since: "2026-06-01", state: "open", prNumbers: [] };
  let captured;
  const discover = (...args) => {
    captured = args;
    return [5, 1, 3];
  };
  const result = resolvePrNumbers(options, "owner", "repo", discover);
  assert.deepEqual(captured, ["owner", "repo", "2026-06-01", "open"]);
  assert.deepEqual(result, [5, 1, 3], "resolvePrNumbers returns discover's result as-is, unsorted");
});

test("splitRepo splits owner/name into its parts", () => {
  assert.deepEqual(splitRepo("oscharko-dev/Keiko"), { owner: "oscharko-dev", repoName: "Keiko" });
});

test("splitRepo rejects a repo with no slash", () => {
  assert.throws(() => splitRepo("no-slash"), /--repo must be "owner\/name"/);
});

test("splitRepo rejects a repo with an empty owner or name", () => {
  assert.throws(() => splitRepo("/Keiko"));
  assert.throws(() => splitRepo("oscharko-dev/"));
});
