#!/usr/bin/env node
import { chmod, writeFile } from "node:fs/promises";

import { fetchVerified, loadPin, loadPlatformKey } from "./engine-pin.mjs";
import { cliPathArgument } from "./cli-args.mjs";

/**
 * Writes this platform's pinned engine binary to a path, or exits non-zero.
 *
 * The qualification corpus has to run the same bytes a consumer runs, and "the same bytes" is only
 * meaningful if the digest is checked before the file becomes executable. `fetchVerified` returns
 * bytes rather than a path precisely so that an unverified download cannot reach disk here.
 *
 * Usage: node scripts/fetch-engine.mjs <destination>
 */
const destination = cliPathArgument(process.argv[2], {
  usage: "usage: fetch-engine.mjs <destination>",
});

const platformKey = await loadPlatformKey();
const platform = platformKey(process.platform, process.arch);
const pin = await loadPin();
const result = await fetchVerified(pin, platform);
if (!result.ok) {
  console.error(`failed to fetch pinned engine for ${platform}: ${result.reason}`);
  process.exit(1);
}

await writeFile(destination, result.bytes);
await chmod(destination, 0o755);
console.log(`${pin.version} ${platform} ${result.sha256.slice(0, 16)}… -> ${destination}`);
