/**
 * Exact, bounded merge-base-to-HEAD diff input for publication evidence.
 *
 * The evidence renderer is deliberately pure. This small adapter owns the only repository read it
 * needs: one shell-free `git diff` scoped to the reviewed path (and its old name for a rename).
 * Callers treat `undefined` as unavailable evidence, never as proof that the path did not change.
 */

import type { CommitSha } from "../core/brands.js";
import { gitEnvironment, run } from "../git/exec.js";

const DIFF_TIMEOUT_MS = 30_000;
const DIFF_MAX_BUFFER = 2 * 1024 * 1024;
const DIFF_CONTEXT_LINES = 24;

export interface ChangeDiffRequest {
  readonly repositoryPath: string;
  readonly pathValue: string;
  readonly base: CommitSha;
  readonly head: CommitSha;
  readonly path: string;
  readonly oldPath?: string;
  /** Must match Inventory's rename threshold so both stages describe the same change. */
  readonly renameDetectionPercent: number;
}

function safeRepositoryPath(path: string): boolean {
  if (path.length === 0 || path.length > 4096 || path.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex -- candidate paths containing controls are rejected.
  if (/[\u0000-\u001f\u007f-\u009f\\]/u.test(path) || /^[A-Za-z]:/u.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/**
 * Reads one complete file diff without consulting the checkout or ambient Git configuration.
 *
 * Supplying both names is load-bearing for renames: asking Git only for the new name can turn a
 * rename into an apparent addition, which would make the verifier reason from the wrong BASE.
 */
export async function readChangeUnifiedDiff(
  request: ChangeDiffRequest,
): Promise<string | undefined> {
  if (!safeRepositoryPath(request.path)) return undefined;
  if (request.oldPath !== undefined && !safeRepositoryPath(request.oldPath)) return undefined;
  if (
    !Number.isSafeInteger(request.renameDetectionPercent) ||
    request.renameDetectionPercent < 1 ||
    request.renameDetectionPercent > 100
  ) {
    return undefined;
  }
  const paths = [...new Set([request.oldPath, request.path].filter((path) => path !== undefined))];
  try {
    const result = await run(
      "git",
      [
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--submodule=short",
        `--find-renames=${String(request.renameDetectionPercent)}%`,
        `--unified=${String(DIFF_CONTEXT_LINES)}`,
        request.base,
        request.head,
        "--",
        ...paths,
      ],
      {
        cwd: request.repositoryPath,
        timeoutMs: DIFF_TIMEOUT_MS,
        maxBuffer: DIFF_MAX_BUFFER,
        env: { ...gitEnvironment(request.pathValue), GIT_LITERAL_PATHSPECS: "1" },
      },
    );
    const diff = result.stdout.toString("utf8");
    return diff === "" ? undefined : diff;
  } catch {
    return undefined;
  }
}
