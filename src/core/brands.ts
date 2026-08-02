/**
 * Validated string types.
 *
 * Every string that leaves this process — into a log line, a diagnostic record, a GitHub API path,
 * or an engine argument — passes through one of these constructors first. Branding them makes the
 * validation impossible to skip by accident: a plain `string` will not type-check where a
 * `CommitSha` is required, so a forgotten check is a compile error rather than a runtime leak.
 */

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A full 40-character hexadecimal Git object id. Abbreviated ids are rejected. */
export type CommitSha = Brand<string, "CommitSha">;

/** A 64-character lowercase hexadecimal SHA-256 digest. */
export type Sha256 = Brand<string, "Sha256">;

/** A release version tag such as `v1.8.4`. */
export type VersionTag = Brand<string, "VersionTag">;

/** A repository-relative path that cannot escape the repository root. */
export type RepoPath = Brand<string, "RepoPath">;

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** C0 controls, DEL, and C1 controls. */
// eslint-disable-next-line no-control-regex -- detecting control characters is this pattern's purpose
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]");

export class ValidationError extends Error {
  public readonly field: string;

  public constructor(field: string) {
    // The offending value is deliberately absent: this message can reach an operator log, and the
    // value may be candidate-controlled. The field name is enough to act on.
    super(`invalid value for ${field}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

export function commitSha(value: string, field = "commitSha"): CommitSha {
  const normalized = value.trim().toLowerCase();
  if (!FULL_SHA.test(normalized)) throw new ValidationError(field);
  return normalized as CommitSha;
}

export function sha256(value: string, field = "sha256"): Sha256 {
  const normalized = value.trim().toLowerCase();
  if (!SHA256.test(normalized)) throw new ValidationError(field);
  return normalized as Sha256;
}

export function versionTag(value: string, field = "versionTag"): VersionTag {
  const normalized = value.trim();
  if (!VERSION.test(normalized)) throw new ValidationError(field);
  return normalized as VersionTag;
}

/**
 * Accepts a repository-relative path.
 *
 * Rejects absolute paths, `..` traversal, control characters, backslash separators, and paths with
 * empty segments. Candidate diffs are an untrusted source of path strings, and a path is used both
 * to address the GitHub API and to key inventory reconciliation.
 */
export function repoPath(value: string, field = "path"): RepoPath {
  if (value.length === 0 || value.length > 4096) throw new ValidationError(field);
  if (CONTROL_CHARACTERS.test(value)) throw new ValidationError(field);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new ValidationError(field);
  if (value.includes("\\")) throw new ValidationError(field);
  const segments = value.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) throw new ValidationError(field);
  return value as RepoPath;
}

export function isCommitSha(value: string): boolean {
  return FULL_SHA.test(value.trim().toLowerCase());
}

export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}
