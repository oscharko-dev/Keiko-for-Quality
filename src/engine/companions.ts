/**
 * Companion files: the small set of same-package changed files whose hunks travel WITH a file's
 * single-shot review — and whose head blobs define that file's cache context.
 *
 * One module for both jobs on purpose, because the two must never disagree. The first live audit
 * of v0.20.0 (2026-08-08, twelve hours of consumer pull requests) measured the two failure modes
 * this module removes, and they are two faces of the same missing definition of "context":
 *
 * - **37 of 52 findings on the release pull request were false**, and the dominant pattern was
 *   one-sided reading of a pair that moved together in the SAME diff — `package.json` bumped to
 *   0.3.0 next to a `version.ts` bumped to 0.3.0, the reviewer seeing only one side and alleging
 *   inconsistency with the other. The model was never shown its companions, only their names.
 * - **89% of the window's entire spend (3.68M of 4.12M tokens) went into whole-store cache
 *   invalidations**: the replay key treated "the pull request's changed-path set moved" as
 *   context loss for EVERY file, so one added test file re-reviewed eleven, and three pushes on
 *   the release branch re-reviewed 113–116 files each within twenty-five minutes.
 *
 * With companions in the prompt, a file's verdict measurably depends on exactly: its own blob,
 * its companions' blobs, the rule, the runner, and the model. So the companion set IS the cache
 * context — a new unrelated file changes neither, and a changed companion invalidates exactly its
 * group. The agentic path keeps the conservative whole-set digest it always had: it can search
 * the repository at will, so its verdicts legitimately depend on more than any fixed neighbour
 * set names.
 *
 * Selection is heuristic and bounded, and both properties are load-bearing: heuristic, because a
 * dependency-true closure is exactly the "sound dependency-closure invalidation" review-cache.ts
 * already defers, and bounded (MAX_COMPANIONS), because every companion hunk rides the prompt.
 * A missed companion costs one file's context, never correctness — the reviewer is told (mode
 * preamble, `single-shot.ts`) to stay silent about cross-file consistency it cannot see.
 */

import { createHash } from "node:crypto";

import { sha256, type Sha256 } from "../core/brands.js";

/** Companions per file. Three focused neighbours orient; a whole package pads every prompt. */
export const MAX_COMPANIONS = 3;

/**
 * Lockfiles are never companions and never receive any: they are generated, enormous, and their
 * "consistency" with anything is the package manager's business, not a reviewer's.
 */
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|[^/]+\.lock)$/;

export function isLockfilePath(path: string): boolean {
  return LOCKFILE.test(path);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** `foo` for `foo.ts`, `foo.test.ts`, `foo.spec.mjs` — the stem that ties a file to its tests. */
function stem(path: string): string {
  return basename(path)
    .replace(/\.(test|spec)(?=\.)/, "")
    .replace(/\.[^.]+$/, "");
}

/**
 * The package root governing `path`: the longest directory among `roots` that prefixes it, or ""
 * (the repository root) when none does. `roots` are the directories of changed `package.json`
 * files — the one boundary marker every consumer this action reviews already maintains.
 */
function packageRoot(path: string, roots: readonly string[]): string {
  let best = "";
  for (const root of roots) {
    if (root === "") continue;
    if ((path.startsWith(`${root}/`) || dirname(path) === root) && root.length > best.length) {
      best = root;
    }
  }
  return best;
}

/**
 * A candidate's binding strength to the file being reviewed, most binding first: the package's own
 * `package.json` (the file every version twin pairs with), then same-stem siblings (`foo.ts` ↔
 * `foo.test.ts`), then `version` files (the audit's exact false-positive class), then
 * nearest-by-directory alphabetical rest. Ties break on the path, so the order is total.
 *
 * The file's own stem and directory are parameters rather than a closure over the caller's loop
 * (Sonar S7721): the rank of a candidate depends on nothing else, and a function re-created once
 * per path said otherwise.
 */
function rank(candidate: string, ownStem: string, ownDir: string): number {
  if (basename(candidate) === "package.json") return 0;
  if (stem(candidate) === ownStem) return 1;
  if (/(^|\/)version(s)?\./.test(candidate) || stem(candidate) === "version") return 2;
  return dirname(candidate) === ownDir ? 3 : 4;
}

/**
 * The companion selection for every path at once — computed together so the grouping is one
 * consistent view of the change, not N independent guesses.
 */
export function companionsByPath(paths: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const roots = [
    ...new Set(paths.filter((p) => basename(p) === "package.json").map((p) => dirname(p))),
  ];
  const byRoot = new Map<string, string[]>();
  for (const path of paths) {
    const root = packageRoot(path, roots);
    const group = byRoot.get(root) ?? [];
    group.push(path);
    byRoot.set(root, group);
  }

  const result = new Map<string, readonly string[]>();
  for (const path of paths) {
    if (isLockfilePath(path)) {
      result.set(path, []);
      continue;
    }
    const group = (byRoot.get(packageRoot(path, roots)) ?? []).filter(
      (candidate) => candidate !== path && !isLockfilePath(candidate),
    );
    const ownStem = stem(path);
    const ownDir = dirname(path);
    const ranked = [...group].sort(
      (a, b) => rank(a, ownStem, ownDir) - rank(b, ownStem, ownDir) || a.localeCompare(b),
    );
    result.set(path, ranked.slice(0, MAX_COMPANIONS));
  }
  return result;
}

/**
 * The context digest a single-shot cache entry carries in place of the whole-set digest: a sha256
 * over the sorted `path NUL identity` lines of the file's companions, where `identity` is whatever
 * material the caller says a companion's PROMPT CONTRIBUTION depends on — in production the
 * `base→head` blob pair, because the companion hunks shown to the model are exactly the diff
 * between those two blobs. Empty companion set hashes the empty string — a real, stable value,
 * deliberately distinct from "unknown".
 *
 * The file's OWN blobs are deliberately absent: they are already two of the six fields in
 * `computeKey`, and repeating them here would let the two disagree about what "same content" means.
 */
export function companionContextDigest(
  companions: readonly string[],
  blobOf: (path: string) => string | undefined,
): Sha256 {
  const lines = companions
    .map((path) => `${path}\0${blobOf(path) ?? ""}`)
    .sort((a, b) => a.localeCompare(b));
  return sha256(createHash("sha256").update(lines.join("\n")).digest("hex"));
}

/**
 * Complete single-shot prompt-context identity for one reviewed path.
 *
 * Companion hunks are not the only cross-file input to the one-shot prompt: the pull request's
 * stated purpose is repeated for every file too. Hashing the already-rendered, bounded block here
 * means a cache hit can never replay a verdict produced for different stated requirements, while
 * two raw descriptions that render identically retain the same key. The companion digest is fixed
 * width, so the NUL separator is unambiguous even when candidate-authored intent contains control
 * characters.
 */
export function singleShotContextDigest(
  companions: readonly string[],
  blobOf: (path: string) => string | undefined,
  identity: {
    readonly renderedChangeIntent: string;
    readonly contextPack: string;
    readonly guidelineContextIdentity: string;
    readonly workflowIdentity: string;
  },
): Sha256 {
  const companionDigest = companionContextDigest(companions, blobOf);
  return sha256(
    createHash("sha256")
      .update(
        JSON.stringify([
          companionDigest,
          identity.renderedChangeIntent,
          identity.contextPack,
          identity.guidelineContextIdentity,
          identity.workflowIdentity,
        ]),
      )
      .digest("hex"),
  );
}
