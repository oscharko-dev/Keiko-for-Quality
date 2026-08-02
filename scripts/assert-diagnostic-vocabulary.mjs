#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { cliPathArgument } from "./cli-args.mjs";

/**
 * Asserts that emitted diagnostics stay inside the closed vocabulary.
 *
 * The redaction contract is a claim about what can reach a consumer's job log. The type system
 * enforces it at compile time, but this checks the actual bytes a real run produced — which is the
 * only form of the claim a consumer can verify for themselves.
 */
const ALLOWED_FIELDS = new Set(["code", "headSha", "digest", "version", "counts", "durationMs"]);

const path = cliPathArgument(process.argv[2], {
  usage: "usage: assert-diagnostic-vocabulary.mjs <diagnostics-file>",
});

const lines = readFileSync(path, "utf8")
  .trim()
  .split("\n")
  .filter((line) => line !== "");

if (lines.length === 0) {
  console.error("no diagnostics emitted; a silent run cannot be audited");
  process.exit(1);
}

let failures = 0;
for (const [index, line] of lines.entries()) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    console.error(`line ${String(index + 1)} is not JSON — free-form output reached the log`);
    failures += 1;
    continue;
  }
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      console.error(`line ${String(index + 1)} carries an unexpected field: ${key}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`${String(failures)} diagnostic violation(s)`);
  process.exit(1);
}

console.log(`${String(lines.length)} diagnostic line(s), all within the closed vocabulary`);
