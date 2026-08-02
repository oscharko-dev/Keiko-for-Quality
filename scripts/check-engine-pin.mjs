#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

/**
 * Downloads every pinned engine asset and verifies its digest.
 *
 * The product tells consumers it executes a byte-identical, qualified binary. That claim is only
 * worth something if it is checked: an upstream release can be re-tagged, an asset replaced, or a
 * digest mistyped when the pin was advanced. Checking every platform — not just this runner's —
 * means a Linux CI run still catches a broken macOS pin.
 */
async function loadPin() {
  const dir = await mkdtemp(join(tmpdir(), "kfq-pin-"));
  try {
    const outfile = join(dir, "pin.mjs");
    await build({
      entryPoints: ["src/engine/pinned-release.ts"],
      outfile,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      logLevel: "silent",
    });
    const module = await import(`file://${outfile}`);
    return module.ENGINE_PIN;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const pin = await loadPin();
let failures = 0;

for (const [platform, target] of Object.entries(pin.platforms)) {
  const url = `https://github.com/${pin.engine}/releases/download/${pin.version}/${target.asset}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    console.error(`FAIL ${platform}: HTTP ${response.status}`);
    failures += 1;
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== target.sha256) {
    console.error(`FAIL ${platform}: expected ${target.sha256}, got ${actual}`);
    failures += 1;
    continue;
  }
  console.log(`ok   ${platform}  ${target.asset}  ${actual.slice(0, 16)}…`);
}

if (failures > 0) {
  console.error(`${failures} pinned asset(s) failed verification`);
  process.exit(1);
}
console.log(`all ${Object.keys(pin.platforms).length} pinned assets verified for ${pin.version}`);
