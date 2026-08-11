#!/usr/bin/env node

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  redactQualificationReport,
  validateQualificationEvidence,
} from "./qualification-evidence-lib.mjs";

const ROOT = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const EVIDENCE_DIR = realpathSync(join(ROOT, "corpus", "evidence"));
const USAGE =
  "usage: qualification-evidence.mjs --raw /private/report.json " +
  "--out corpus/evidence/qualification-YYYY-MM-DD-vX.Y.Z.json";

function fail(message) {
  console.error(`qualification-evidence: ${message}\n${USAGE}`);
  process.exit(2);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (typeof value !== "string" || value === "" || value.includes("\0"))
    fail(`${name} is required`);
  return resolve(value);
}

function inside(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

const rawArgument = arg("--raw");
const outArgument = arg("--out");
let rawPath;
try {
  rawPath = realpathSync(rawArgument);
} catch {
  fail("the raw report does not exist");
}
if (inside(ROOT, rawPath)) {
  fail("the raw OCR_REPORT must stay outside the repository");
}
let outDirectory;
try {
  outDirectory = realpathSync(dirname(outArgument));
} catch {
  fail("the output directory does not exist");
}
if (outDirectory !== EVIDENCE_DIR) {
  fail("--out must point directly into corpus/evidence");
}
if (
  !isAbsolute(outArgument) ||
  !/^qualification-\d{4}-\d{2}-\d{2}-v\d+\.\d+\.\d+\.json$/u.test(basename(outArgument))
) {
  fail("--out must use the versioned qualification evidence filename");
}

let raw;
try {
  raw = JSON.parse(readFileSync(rawPath, "utf8"));
} catch {
  fail("the raw report is not valid JSON");
}

let evidence;
try {
  evidence = redactQualificationReport(raw);
} catch {
  fail("the raw report does not satisfy the qualification report contract");
}
const validation = validateQualificationEvidence(evidence);
if (!validation.valid) fail("the redacted evidence failed its own schema validation");
const expectedSuffix = `-v${evidence.binding.adapter.version}.json`;
if (!basename(outArgument).endsWith(expectedSuffix)) {
  fail("the output version does not match the measured adapter version");
}

try {
  // A release measurement is immutable evidence. Refusing an overwrite prevents a second run from
  // silently replacing the record whose filename a reviewer has already inspected.
  writeFileSync(outArgument, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
} catch {
  fail("the output already exists or could not be written");
}
console.log(
  `wrote redacted qualification evidence: ${outArgument} ` +
    `(${String(evidence.results.length)} cases, ${String(evidence.tokens)} tokens)`,
);
