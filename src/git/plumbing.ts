import {
  blobId,
  commitSha,
  repoPath,
  ValidationError,
  type BlobId,
  type CommitSha,
  type RepoPath,
} from "../core/brands.js";
import { ExecFailure, gitEnvironment, run, type ExecOptions } from "./exec.js";

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
  /**
   * The blob on each side of the change, at full length (`--no-abbrev`).
   *
   * `oldBlob === newBlob` is the cryptographic proof that a rename moved a path without touching
   * its content — comparing abbreviated ids would only make that collision less likely, not
   * impossible, and this equality is load-bearing for a downgrade decision.
   */
  readonly oldBlob: BlobId;
  readonly newBlob: BlobId;
  readonly path: RepoPath;
  readonly oldPath?: RepoPath;
  /** Git's own binary determination, from numstat. */
  readonly binary: boolean;
  /** Added plus deleted lines, from numstat. Zero for a binary change or a record numstat omits. */
  readonly changedLines: number;
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

/**
 * Resolves an arbitrary ref expression — a branch name, a remote-tracking ref, `HEAD`, or an
 * explicit object id — to the full commit id it currently names.
 *
 * `verifyCommit` above answers "is this id a commit" once a caller already holds a `CommitSha`;
 * this is what a caller uses to get one in the first place from an operator-supplied name, which
 * is the local CLI's whole `--base`/`--head`/`--target-branch` surface (`cli.ts`). The ref comes
 * from the operator's own invocation, never from candidate diff content, so — like every other
 * function in this file — it is passed to git as its own argv element, never interpolated into a
 * shell string.
 */
export async function resolveRef(ctx: GitContext, ref: string, field = "ref"): Promise<CommitSha> {
  const output = await git(ctx, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 4096);
  return commitSha(output.trim(), field);
}

/**
 * The size past which `readTextAtCommit` stops pretending a file is reviewable text. Declared
 * contract counterparts are source files; anything this large is generated output or an asset,
 * and the deterministic shape gate reading through here must skip it rather than parse it.
 */
const MAX_TEXT_BLOB_BYTES = 1024 * 1024;

/**
 * Reads one path's content at a commit, as text — through plumbing, never a checkout, so candidate
 * content stays data exactly like everywhere else in this file.
 *
 * Returns `undefined` for anything the caller must not treat as source text: a path absent at that
 * commit, a blob past `MAX_TEXT_BLOB_BYTES`, malformed UTF-8, or binary content (a NUL byte
 * anywhere — git's own text heuristic, applied here because a declared counterpart that is
 * secretly binary is a configuration mistake, and the only safe response of a no-false-positives
 * gate is silence).
 * Absence is an expected outcome, not an error: a profile may declare a counterpart that a given
 * branch simply does not carry yet.
 */
export async function readTextAtCommit(
  ctx: GitContext,
  commit: CommitSha,
  path: string,
): Promise<string | undefined> {
  let bytes: Buffer;
  try {
    const result = await run(
      "git",
      ["cat-file", "blob", `${commit}:${path}`],
      options(ctx, MAX_TEXT_BLOB_BYTES),
    );
    bytes = result.stdout;
  } catch (error) {
    // Mirrors `engine/run.ts`'s own `failureReason` for the identical `ExecFailure` type: a timeout
    // is a systemic execution failure, not one of this function's own documented "absent" outcomes
    // (a missing path, an oversized blob, binary content), and swallowing it here would silently
    // disable every caller's own signal with no diagnostic at all. Every OTHER `ExecFailure` —
    // `cat-file blob` exits non-zero, untimed, for a path that simply does not exist at that commit
    // — still degrades to `undefined`, exactly as this function's own doc comment promises.
    if (error instanceof ExecFailure && error.timedOut) throw error;
    return undefined;
  }
  if (bytes.includes(0)) return undefined;
  const content = bytes.toString("utf8");
  // Buffer's UTF-8 decoder replaces malformed byte sequences with U+FFFD. Parsing that repaired
  // string would make a syntax tool inspect bytes that do not exist in the immutable Git blob
  // while still attributing its result to the original object. A byte-identical round trip is the
  // closed boundary: valid UTF-8 (including a real BOM or U+FFFD) survives; malformed input does
  // not become source text.
  if (!Buffer.from(content, "utf8").equals(bytes)) return undefined;
  return content;
}

export async function mergeBase(
  ctx: GitContext,
  base: CommitSha,
  head: CommitSha,
): Promise<CommitSha> {
  const output = await git(ctx, ["merge-base", base, head], 4096);
  return commitSha(output.trim(), "mergeBase");
}

/**
 * Resolves a target branch's tip, trying the local branch `name` first and its `origin` remote-
 * tracking ref second.
 *
 * The fallback exists because a shallow or partial clone — the common shape of a CI checkout, and
 * an unremarkable one for a developer's local clone too — often carries `origin/<name>` without
 * ever having created a local branch by that name. Local-first, not the reverse: a local branch a
 * developer actually checked out and is comparing against is the more specific, more current
 * answer whenever both exist.
 */
export async function resolveTargetBranchTip(ctx: GitContext, name: string): Promise<CommitSha> {
  try {
    return await resolveRef(ctx, name, "targetBranch");
  } catch {
    return await resolveRef(ctx, `origin/${name}`, "targetBranch");
  }
}

/** Parses one `:<oldmode> <newmode> <oldoid> <newoid> <status>` record. */
function parseMeta(meta: string): {
  status: ChangeStatus;
  oldMode: string;
  newMode: string;
  oldBlob: BlobId;
  newBlob: BlobId;
} {
  if (!meta.startsWith(":")) throw new ValidationError("diff.record");
  const fields = meta.slice(1).split(" ");
  const [oldMode, newMode, oldOid, newOid, statusToken] = fields;
  if (
    oldMode === undefined ||
    newMode === undefined ||
    oldOid === undefined ||
    newOid === undefined ||
    statusToken === undefined
  ) {
    throw new ValidationError("diff.record");
  }
  const status = statusToken.charAt(0);
  if (!STATUSES.has(status)) throw new ValidationError("diff.status");
  return {
    status: status as ChangeStatus,
    oldMode,
    newMode,
    // The caller invokes `diff --raw` with `--no-abbrev`, so these are full object ids — abbreviated
    // equality would only make a false match less likely, and the pure-rename downgrade this feeds
    // needs it impossible.
    oldBlob: blobId(oldOid, "diff.oldBlob"),
    newBlob: blobId(newOid, "diff.newBlob"),
  };
}

/**
 * Parses `git diff --raw -z` output.
 *
 * NUL separation is required rather than convenient: a path may legally contain spaces, quotes, and
 * newlines, and any line-oriented parse of a candidate-controlled path is a classification bug
 * waiting to be exploited.
 */
function parseRawDiff(text: string): Omit<RawChange, "binary" | "changedLines">[] {
  const parts = text.split("\0");
  const changes: Omit<RawChange, "binary" | "changedLines">[] = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i];
    if (meta === undefined || meta === "") break;
    const { status, oldMode, newMode, oldBlob, newBlob } = parseMeta(meta);
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
        oldBlob,
        newBlob,
        oldPath: repoPath(first, "diff.oldPath"),
        path: repoPath(second, "diff.path"),
      });
      i += 3;
    } else {
      changes.push({
        status,
        oldMode,
        newMode,
        oldBlob,
        newBlob,
        path: repoPath(first, "diff.path"),
      });
      i += 2;
    }
  }
  return changes;
}

export interface NumstatIndex {
  readonly binary: ReadonlySet<string>;
  /** Added plus deleted lines, keyed by the final (post-rename) path. */
  readonly changedLines: ReadonlyMap<string, number>;
}

/** Parses one numstat count field. Git's binary marker `-` and anything unparsable become zero. */
function parseNumstatCount(value: string | undefined): number {
  if (value === undefined || value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Files one numstat record's counts under the final (post-rename) path it names.
 *
 * `listChanges` looks both indexes up by `RawChange.path`, which is that same final path, so the
 * two record shapes `parseNumstat` walks — an ordinary one-field entry and a rename's three-field
 * one — differ only in where that path is read from, never in what gets recorded about it. Holding
 * the two writes here rather than once per branch leaves `parseNumstat` about the NUL framing
 * alone, which is the part that is easy to get wrong.
 */
function recordNumstatEntry(
  binary: Set<string>,
  changedLines: Map<string, number>,
  path: string,
  isBinary: boolean,
  lines: number,
): void {
  if (isBinary) binary.add(path);
  changedLines.set(path, lines);
}

/** Parses `git diff --numstat -z`; binary entries report `-` for both counts. */
function parseNumstat(text: string): NumstatIndex {
  const parts = text.split("\0");
  const binary = new Set<string>();
  const changedLines = new Map<string, number>();
  let i = 0;
  while (i < parts.length) {
    const record = parts[i];
    if (record === undefined || record === "") break;
    const fields = record.split("\t");
    const [added, deleted] = fields;
    const isBinary = added === "-" && deleted === "-";
    const lines = parseNumstatCount(added) + parseNumstatCount(deleted);
    // A renamed entry emits an empty path in the record and two following path fields.
    // Re-joining the tail preserves a path that legitimately contains a tab.
    const inlinePath = fields.slice(2).join("\t");
    if (inlinePath === "") {
      const target = parts[i + 2];
      if (target !== undefined) recordNumstatEntry(binary, changedLines, target, isBinary, lines);
      i += 3;
    } else {
      recordNumstatEntry(binary, changedLines, inlinePath, isBinary, lines);
      i += 1;
    }
  }
  return { binary, changedLines };
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
    // Raw object ids at full length: `classify()` proves a pure rename by comparing them, and an
    // abbreviated id only makes a false-positive collision less likely, not impossible.
    "--no-abbrev",
    "--submodule=short",
    `--find-renames=${String(renamePercent)}%`,
    "-z",
  ];
  const raw = await git(ctx, [...shared, "--raw", from, to]);
  const numstat = await git(ctx, [...shared, "--numstat", from, to]);
  const { binary, changedLines } = parseNumstat(numstat);
  return parseRawDiff(raw).map((change) => ({
    ...change,
    binary: binary.has(change.path),
    changedLines: changedLines.get(change.path) ?? 0,
  }));
}
