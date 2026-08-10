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

/** Explicit roots for the staged review and its corpus-only production-input preparation. */
export const STAGED_QUALIFICATION_ENGINE_ENTRYPOINTS = Object.freeze([
  "src/engine/single-shot.ts",
  "corpus/single-shot-invocation.mjs",
]);

/**
 * The implementation identity whose judgment the qualification report binds.
 *
 * A staged identity is a transitive source closure, not the `single-shot.ts` facade alone. Its
 * second root is load-bearing: corpus Inventory/context-pack preparation changes the evidence the
 * staged prompts receive. The classic path stays byte-bound to the executable it actually spawns.
 * A fetched but unused classic binary can therefore never win the staged identity.
 */
export function qualificationEngineIdentity({ singleShot, binary, repositoryRoot }) {
  if (singleShot) {
    return {
      kind: "source-closure",
      repositoryRoot,
      entrypoints: STAGED_QUALIFICATION_ENGINE_ENTRYPOINTS,
    };
  }
  if (typeof binary !== "string" || binary === "") {
    throw new TypeError("classic qualification requires an engine binary");
  }
  return { kind: "file", path: binary };
}

async function productionInventoryDependencies() {
  registerTsExtensionHooks();
  const inventory = await import("../src/inventory/inventory.ts");
  return {
    buildInventory: inventory.buildInventory,
    mechanicallyCleanPaths: inventory.mechanicallyCleanPaths,
  };
}

async function productionContextPackDependencies() {
  registerTsExtensionHooks();
  const contextPack = await import("../src/engine/context-pack.ts");
  return { collectContextPacks: contextPack.collectContextPacks };
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

/**
 * Prepares the staged corpus runner's context-pack option through the production collector.
 *
 * This is the same selection `prepareContextPacks` makes in `src/review.ts`: every reviewable path
 * except the paths Inventory already proved mechanically clean. The collector retains ownership of
 * its measured 50-changed-line threshold and every rendering/failure bound; the corpus neither
 * lowers that threshold nor reimplements the search. Returning no key for an empty map also mirrors
 * `engineInvocationOptions`, so an ineligible tiny case reaches the engine exactly as it did before.
 */
export async function singleShotCorpusContextOptions({
  repositoryPath,
  pair,
  pathValue,
  expectedReviewablePaths,
  mechanicallyCleanPaths,
  dependencies,
}) {
  const loaded = dependencies ?? (await productionContextPackDependencies());
  const mechanicallyClean = new Set(mechanicallyCleanPaths);
  const paths = expectedReviewablePaths.filter((path) => !mechanicallyClean.has(path));
  const contextPacks = await loaded.collectContextPacks({
    repositoryPath,
    pair,
    paths,
    pathValue,
  });
  return contextPacks.size === 0 ? {} : { contextPacks };
}
