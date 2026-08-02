#!/usr/bin/env node
import { fetchVerified, loadPin } from "./engine-pin.mjs";

/**
 * Downloads every pinned engine asset and verifies its digest.
 *
 * The product tells consumers it executes a byte-identical, qualified binary. That claim is only
 * worth something if it is checked: an upstream release can be re-tagged, an asset replaced, or a
 * digest mistyped when the pin was advanced. Checking every platform — not just this runner's —
 * means a Linux CI run still catches a broken macOS pin.
 */
const pin = await loadPin();
let failures = 0;

for (const platform of Object.keys(pin.platforms)) {
  const result = await fetchVerified(pin, platform);
  if (!result.ok) {
    console.error(`FAIL ${platform}: ${result.reason}`);
    failures += 1;
    continue;
  }
  console.log(`ok   ${platform}  ${result.asset}  ${result.sha256.slice(0, 16)}…`);
}

if (failures > 0) {
  console.error(`${failures} pinned asset(s) failed verification`);
  process.exit(1);
}
console.log(`all ${Object.keys(pin.platforms).length} pinned assets verified for ${pin.version}`);
