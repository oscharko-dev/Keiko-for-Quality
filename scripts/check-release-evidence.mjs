#!/usr/bin/env node

// Zero-token validation for the four public artifacts produced by `release-gates.yml`.
//
// The paid jobs upload independently, so a green job list is not enough: the downloaded files
// still have to agree on one immutable candidate and meet the same release floors `attest` will
// enforce later. This command performs that proof before anyone copies the artifacts into the
// repository. It never calls a model or the network.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  findGateEvidence,
  parseVersion,
  validateGateEvidence,
  validateQualityEvidence,
} from "./release-lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/u;
const USAGE =
  "usage: node scripts/check-release-evidence.mjs " +
  "--version X.Y.Z --head <40-hex> --tree <40-hex> " +
  "--seed <report.md> --completion <report.md> " +
  "--qualification <report.json> --historical <report.json>";
const PATH_FLAGS = new Map([
  ["--seed", { key: "seed", suffix: ".md" }],
  ["--completion", { key: "completion", suffix: ".md" }],
  ["--qualification", { key: "qualification", suffix: ".json" }],
  ["--historical", { key: "historicalReplay", suffix: ".json" }],
]);
const VALUE_FLAGS = new Set(["--version", "--head", "--tree", ...PATH_FLAGS.keys()]);

function evidencePath(raw, suffix, flag) {
  if (typeof raw !== "string" || raw === "" || raw.includes("\0") || !raw.endsWith(suffix)) {
    throw new Error(`${flag} must name a ${suffix} evidence file`);
  }
  return resolve(raw);
}

/** Strict parsing: unknown, positional, duplicate, and valueless arguments all fail closed. */
export function parseReleaseEvidenceArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown argument: ${String(flag)}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${String(flag)}`);
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      throw new Error(`missing value for ${String(flag)}`);
    }
    values.set(flag, value);
  }

  for (const flag of VALUE_FLAGS) {
    if (!values.has(flag)) throw new Error(`missing required argument: ${flag}`);
  }

  const version = parseVersion(values.get("--version"));
  if (version === undefined) throw new Error("--version must be X.Y.Z");
  const head = values.get("--head");
  const tree = values.get("--tree");
  if (!GIT_OBJECT_ID.test(head ?? "")) throw new Error("--head must be a full lowercase Git id");
  if (!GIT_OBJECT_ID.test(tree ?? "")) throw new Error("--tree must be a full lowercase Git id");

  const paths = {};
  for (const [flag, { key, suffix }] of PATH_FLAGS) {
    paths[key] = evidencePath(values.get(flag), suffix, flag);
  }
  if (new Set(Object.values(paths)).size !== PATH_FLAGS.size) {
    throw new Error("each evidence argument must name a different file");
  }
  return { expected: { version, head, tree }, paths };
}

function readJson(path, label, read) {
  try {
    return JSON.parse(read(path, "utf8"));
  } catch {
    throw new Error(`${label} evidence is not valid JSON`);
  }
}

function readText(path, label, read) {
  try {
    return read(path, "utf8");
  } catch {
    throw new Error(`${label} evidence could not be read`);
  }
}

function requireVersionedEvidenceNames(paths, version) {
  const names = Object.values(paths).map((path) => basename(path));
  const found = findGateEvidence(names, version);
  if (!found.complete) {
    const detail = found.ambiguous.length > 0 ? found.ambiguous.join("; ") : "missing or misnamed";
    throw new Error(`expected exactly four version-scoped v${version} evidence files: ${detail}`);
  }
  for (const [key, selectedName] of Object.entries({
    seed: found.seed,
    completion: found.completion,
    qualification: found.qualification,
    historicalReplay: found.historicalReplay,
  })) {
    if (basename(paths[key]) !== selectedName) {
      throw new Error(`${key} argument names the wrong evidence kind`);
    }
  }
}

function defaultQualificationCheck(path) {
  execFileSync(process.execPath, [resolve(ROOT, "scripts", "check-qualification.mjs"), path], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
  });
}

/** Same content, provenance, and promotion checks that `release -- attest` performs later. */
export function checkDownloadedReleaseEvidence({
  expected,
  paths,
  read = readFileSync,
  checkQualification = defaultQualificationCheck,
}) {
  requireVersionedEvidenceNames(paths, expected.version);
  const seed = readText(paths.seed, "seed", read);
  const completion = readText(paths.completion, "completion", read);
  const qualification = readJson(paths.qualification, "qualification", read);
  const historicalReplay = readJson(paths.historicalReplay, "historical replay", read);

  const gate = validateGateEvidence(seed, completion, expected);
  const quality = validateQualityEvidence(qualification, historicalReplay, expected);
  const failures = [
    ...gate.failures.map((failure) => `gate:${failure}`),
    ...quality.failures.map((failure) => `quality:${failure}`),
  ];
  if (failures.length > 0) {
    throw new Error(`release evidence is not releasable: ${failures.join(", ")}`);
  }
  try {
    checkQualification(paths.qualification);
  } catch {
    throw new Error("qualification promotion thresholds are not green");
  }
  return expected;
}

export function executeReleaseEvidenceCli({
  argv = process.argv.slice(2),
  check = checkDownloadedReleaseEvidence,
  error = console.error,
  log = console.log,
  setExitCode = (value) => (process.exitCode = value),
} = {}) {
  try {
    const input = parseReleaseEvidenceArgs(argv);
    const expected = check(input);
    log(
      `check-release-evidence: PASS - v${expected.version} binds ` +
        `${expected.head} / ${expected.tree}`,
    );
  } catch (caught) {
    error(
      `check-release-evidence: FAIL - ${caught instanceof Error ? caught.message : String(caught)}`,
    );
    error(USAGE);
    setExitCode(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  executeReleaseEvidenceCli();
}
