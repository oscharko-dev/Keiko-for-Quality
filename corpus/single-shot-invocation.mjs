import { join } from "node:path";

import { registerTsExtensionHooks } from "./rule-source.mjs";

export const CORPUS_REVIEW_TIMEOUT_SECONDS = 1_800;
const INVENTORY_TIMEOUT_MS = 30_000;

/** One absolute boundary per paid corpus case, matching production's shared-deadline contract. */
export function corpusReviewDeadlineMs(nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("corpus review clock must be a non-negative safe integer");
  }
  return nowMs + CORPUS_REVIEW_TIMEOUT_SECONDS * 1_000;
}

/**
 * The implementation whose judgment the qualification report binds.
 *
 * The scheduled workflow still fetches the classic engine so either mode can be selected without a
 * second setup step. That binary is not executed in staged mode and therefore must never win this
 * identity merely because `OCR_BINARY` happens to be present.
 */
export function qualificationEngineImplementation({ singleShot, binary, repositoryRoot }) {
  if (singleShot) return join(repositoryRoot, "src", "engine", "single-shot.ts");
  if (typeof binary !== "string" || binary === "") {
    throw new TypeError("classic qualification requires an engine binary");
  }
  return binary;
}

async function productionInventoryDependencies() {
  registerTsExtensionHooks();
  const inventory = await import("../src/inventory/inventory.ts");
  return {
    buildInventory: inventory.buildInventory,
    mechanicallyCleanPaths: inventory.mechanicallyCleanPaths,
  };
}

/**
 * Derives the staged dispatch contract through production Inventory, never through profile globs.
 *
 * This preserves structural decisions a second classifier cannot reconstruct: deletion-critical
 * paths remain reviewable outside `reviewRelevant`, while matching binary and submodule paths do
 * not become model input. An unclassified fixture is an instrument failure, not a smaller corpus.
 */
export async function singleShotCorpusDispatch({
  repositoryPath,
  pair,
  profile,
  pathValue,
  renameDetectionPercent,
  diagnostics,
  dependencies,
}) {
  const loaded = dependencies ?? (await productionInventoryDependencies());
  const inventory = await loaded.buildInventory(
    { cwd: repositoryPath, timeoutMs: INVENTORY_TIMEOUT_MS, pathValue },
    profile,
    pair,
    renameDetectionPercent,
    diagnostics,
  );
  if (inventory.unclassified.length > 0) {
    throw new Error("corpus fixture contains an unclassified changed path");
  }
  return {
    expectedReviewablePaths: [...inventory.reviewablePaths],
    mechanicallyCleanPaths: [...loaded.mechanicallyCleanPaths(inventory)],
  };
}
