import { resolve } from "node:path";

/**
 * Validates a CLI path argument before it reaches any filesystem API (Sonar S8707: raw argv into
 * `fs` lets a caller — human or LLM harness — smuggle constructs the script never meant to
 * accept). Rejection is a usage error: these are operator tools, and the correct response to a
 * malformed invocation is the usage line and exit 2, exactly as an absent argument already
 * behaves.
 *
 * Deliberately NOT a sandbox: the scripts legitimately read and write outside the repository
 * (CI hands fetch-engine a runner temp path), so containment would break the real callers. What
 * is enforced: the argument exists, is a plain non-empty string without NUL, optionally carries
 * the expected extension, and is normalized through `resolve` so later code never operates on a
 * relative surprise.
 */
export function cliPathArgument(raw, { usage, mustEndWith }) {
  if (typeof raw !== "string" || raw === "") {
    console.error(usage);
    process.exit(2);
  }
  if (raw.includes("\0")) {
    console.error(`path argument contains a NUL byte\n${usage}`);
    process.exit(2);
  }
  const resolved = resolve(raw);
  if (mustEndWith !== undefined && !resolved.endsWith(mustEndWith)) {
    console.error(`expected a ${mustEndWith} path, got: ${resolved}\n${usage}`);
    process.exit(2);
  }
  return resolved;
}
