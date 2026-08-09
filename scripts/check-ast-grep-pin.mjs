#!/usr/bin/env node
import { loadAstGrepPinModule } from "./ast-grep-pin.mjs";

/** Downloads every supported archive and verifies archive, ZIP, CRC, size, and binary digests. */
const { AST_GREP_PIN, fetchVerifiedAstGrepAsset } = await loadAstGrepPinModule();
let failures = 0;

for (const [platform, target] of Object.entries(AST_GREP_PIN.platforms)) {
  try {
    const verified = await fetchVerifiedAstGrepAsset(AST_GREP_PIN, target);
    console.log(
      `ok   ${platform}  ${target.asset}  ${String(verified.archiveBytes)} archive bytes  ${String(verified.binaryBytes)} binary bytes`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown failure";
    console.error(`FAIL ${platform}: ${reason}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`${String(failures)} ast-grep pinned asset(s) failed verification`);
  process.exit(1);
}
console.log(
  `all ${String(Object.keys(AST_GREP_PIN.platforms).length)} ast-grep assets verified for ${AST_GREP_PIN.version}`,
);
