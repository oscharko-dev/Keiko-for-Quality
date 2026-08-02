#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Proves the committed bundle is the one this source produces.
 *
 * Consumers execute `dist/index.js`, not `src/`. Without this check the reviewed source and the
 * executed artifact could drift — accidentally, when someone forgets to rebuild, or deliberately.
 * A pinned action SHA is only a meaningful trust anchor if the artifact at that SHA is the source
 * at that SHA.
 */
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

console.log(`dist/index.js matches source (sha256 ${after.slice(0, 16)}…)`);
