#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { cliPathArgument } from "./cli-args.mjs";

/**
 * Stages the CLI release assets (issue #98, epic #94's release-asset child).
 *
 * `dist/cli.js` is already a committed, reproducibility-checked artifact (build.mjs /
 * check-bundle.mjs). This script turns it into the two files a GitHub release attaches:
 *
 * - `keiko-cli.js` — a version-free copy (the tag carries the version; the digest carries
 *   identity — the engine pin's own naming discipline, see `src/engine/pinned-release.ts`).
 * - `sha256sum.txt` — `sha256sum`'s own two-space record format, so both this workflow's own
 *   recomputation step (`sha256sum -c`) and a consumer verifying a download later accept it
 *   without a bespoke parser.
 *
 * Deliberately not a downloader or an uploader: attaching the staged files to a release is the
 * calling workflow's job (`gh release upload`), kept out of this script so the staging logic —
 * the part worth testing hermetically — never needs a GitHub token or network access to run.
 *
 * Usage: node scripts/release-assets.mjs <bundle-path> <out-dir>
 */

export const ASSET_NAME = "keiko-cli.js";
export const DIGEST_FILE_NAME = "sha256sum.txt";

export function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The exact line `sha256sum -c` (and `shasum -a 256 -c`) expects: hex digest, two spaces, the
 * asset name relative to the digest file — never an absolute path, so the digest file stays valid
 * however it is unpacked.
 */
export function sha256sumLine(digest, assetName) {
  return `${digest}  ${assetName}\n`;
}

/**
 * Pure staging step: bundle bytes in, both release files out — keyed by the name they are written
 * under, alongside the digest itself so a caller (or a test) never has to re-derive it. No
 * filesystem access here, so a test can assert on exact bytes without a temp directory.
 */
export function stageReleaseAssets(bundleBytes) {
  const digest = digestOf(bundleBytes);
  return {
    digest,
    files: {
      [ASSET_NAME]: bundleBytes,
      [DIGEST_FILE_NAME]: Buffer.from(sha256sumLine(digest, ASSET_NAME), "utf8"),
    },
  };
}

async function main() {
  const usage = "usage: release-assets.mjs <bundle-path> <out-dir>";
  const bundlePath = cliPathArgument(process.argv[2], { usage, mustEndWith: ".js" });
  const outDir = cliPathArgument(process.argv[3], { usage });

  const bundleBytes = await readFile(bundlePath);
  const staged = stageReleaseAssets(bundleBytes);

  await mkdir(outDir, { recursive: true });
  for (const [name, contents] of Object.entries(staged.files)) {
    await writeFile(join(outDir, name), contents);
  }

  console.log(`${ASSET_NAME}  sha256:${staged.digest}`);
  console.log(`wrote ${join(outDir, ASSET_NAME)} and ${join(outDir, DIGEST_FILE_NAME)}`);
}

// Only runs when executed directly, mirroring src/cli.ts's own bootstrap guard — a test imports
// the pure functions above without triggering filesystem access or a process exit.
function isEntryModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryModule()) {
  await main();
}
