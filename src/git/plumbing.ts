import {
  commitSha,
  repoPath,
  ValidationError,
  type CommitSha,
  type RepoPath,
} from "../core/brands.js";
import { gitEnvironment, run, type ExecOptions } from "./exec.js";

/**
 * Read-only access to the candidate change.
 *
 * Every call here is Git plumbing over object ids. Nothing in this module writes to the working
 * tree, resolves a symlink target, initializes a submodule, or runs a repository-provided command.
 * That is the whole point: the candidate is a data structure this process reads, never a program it
 * hosts.
 */

export type ChangeStatus = "A" | "C" | "D" | "M" | "R" | "T";

const STATUSES: ReadonlySet<string> = new Set<string>(["A", "C", "D", "M", "R", "T"]);

/** Git file modes, as they appear in raw diff output. */
export const MODE_ABSENT = "000000";
export const MODE_REGULAR = "100644";
export const MODE_EXECUTABLE = "100755";
export const MODE_SYMLINK = "120000";
export const MODE_SUBMODULE = "160000";

export interface RawChange {
  readonly status: ChangeStatus;
  readonly oldMode: string;
  readonly newMode: string;
  readonly path: RepoPath;
  readonly oldPath?: RepoPath;
  /** Git's own binary determination, from numstat. */
  readonly binary: boolean;
}

export interface GitContext {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly pathValue: string;
}

function options(ctx: GitContext, maxBuffer: number): ExecOptions {
  return {
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    maxBuffer,
    env: gitEnvironment(ctx.pathValue),
  };
}

async function git(
  ctx: GitContext,
  args: readonly string[],
  maxBuffer = 32 * 1024 * 1024,
): Promise<string> {
  const result = await run("git", args, options(ctx, maxBuffer));
  return result.stdout.toString("utf8");
}

/** Fails when the id is not a commit object present in this repository. */
export async function verifyCommit(ctx: GitContext, sha: CommitSha): Promise<void> {
  await git(ctx, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], 4096);
}

export async function mergeBase(
  ctx: GitContext,
  base: CommitSha,
  head: CommitSha,
): Promise<CommitSha> {
  const output = await git(ctx, ["merge-base", base, head], 4096);
  return commitSha(output.trim(), "mergeBase");
}

/** Parses one `:<oldmode> <newmode> <oldoid> <newoid> <status>` record. */
function parseMeta(meta: string): { status: ChangeStatus; oldMode: string; newMode: string } {
  if (!meta.startsWith(":")) throw new ValidationError("diff.record");
  const fields = meta.slice(1).split(" ");
  const [oldMode, newMode, , , statusToken] = fields;
  if (oldMode === undefined || newMode === undefined || statusToken === undefined) {
    throw new ValidationError("diff.record");
  }
  const status = statusToken.charAt(0);
  if (!STATUSES.has(status)) throw new ValidationError("diff.status");
  return { status: status as ChangeStatus, oldMode, newMode };
}

/**
 * Parses `git diff --raw -z` output.
 *
 * NUL separation is required rather than convenient: a path may legally contain spaces, quotes, and
 * newlines, and any line-oriented parse of a candidate-controlled path is a classification bug
 * waiting to be exploited.
 */
function parseRawDiff(text: string): Omit<RawChange, "binary">[] {
  const parts = text.split("\0");
  const changes: Omit<RawChange, "binary">[] = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i];
    if (meta === undefined || meta === "") break;
    const { status, oldMode, newMode } = parseMeta(meta);
    const renamed = status === "R" || status === "C";
    const first = parts[i + 1];
    if (first === undefined) throw new ValidationError("diff.path");
    if (renamed) {
      const second = parts[i + 2];
      if (second === undefined) throw new ValidationError("diff.path");
      changes.push({
        status,
        oldMode,
        newMode,
        oldPath: repoPath(first, "diff.oldPath"),
        path: repoPath(second, "diff.path"),
      });
      i += 3;
    } else {
      changes.push({ status, oldMode, newMode, path: repoPath(first, "diff.path") });
      i += 2;
    }
  }
  return changes;
}

/** Parses `git diff --numstat -z`; binary entries report `-` for both counts. */
function parseBinaryPaths(text: string): ReadonlySet<string> {
  const parts = text.split("\0");
  const binary = new Set<string>();
  let i = 0;
  while (i < parts.length) {
    const record = parts[i];
    if (record === undefined || record === "") break;
    const fields = record.split("\t");
    const [added, deleted] = fields;
    const isBinary = added === "-" && deleted === "-";
    // A renamed entry emits an empty path in the record and two following path fields.
    // Re-joining the tail preserves a path that legitimately contains a tab.
    const inlinePath = fields.slice(2).join("\t");
    if (inlinePath === "") {
      const target = parts[i + 2];
      if (isBinary && target !== undefined) binary.add(target);
      i += 3;
    } else {
      if (isBinary) binary.add(inlinePath);
      i += 1;
    }
  }
  return binary;
}

/**
 * Enumerates the change between the two commits of the immutable review pair.
 *
 * `--no-ext-diff` is load-bearing: it stops a configured external diff driver from executing.
 *
 * Submodules are deliberately *not* ignored. Comparing two commits reports a gitlink as a plain
 * mode-160000 entry with old and new object ids, which is exactly the pointer change that must be
 * classified — and reading it requires no submodule to be initialized. Suppressing them would hide
 * a real change class behind an apparently clean review. `--submodule=short` pins the presentation
 * so no configuration can turn this into an inner diff.
 */
export async function listChanges(
  ctx: GitContext,
  from: CommitSha,
  to: CommitSha,
  renamePercent: number,
): Promise<readonly RawChange[]> {
  const shared = [
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--submodule=short",
    `--find-renames=${String(renamePercent)}%`,
    "-z",
  ];
  const raw = await git(ctx, [...shared, "--raw", from, to]);
  const numstat = await git(ctx, [...shared, "--numstat", from, to]);
  const binary = parseBinaryPaths(numstat);
  return parseRawDiff(raw).map((change) => ({ ...change, binary: binary.has(change.path) }));
}
