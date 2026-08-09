import { execFile } from "node:child_process";

/**
 * The single point at which this product starts a subprocess.
 *
 * Arguments are always an array, so no candidate-derived string is ever parsed by a shell. The
 * environment is always explicit, so a repository cannot influence git through `GIT_*` variables
 * inherited from the runner. Output is capped, because a candidate controls how large a blob or a
 * diff is and an unbounded buffer is a denial-of-service primitive.
 */
export interface ExecResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Bounded trusted input written directly to the child's stdin; never parsed by a shell. */
  readonly input?: Buffer;
}

export class ExecFailure extends Error {
  public readonly code: number;
  /**
   * Set when `options.timeoutMs` killed the process rather than it exiting on its own. Node
   * reports no exit code for a timeout kill (`error.code` is `null`, not a number) and sets
   * `error.killed` instead — the one signal below distinguishes it from an ordinary non-zero exit,
   * which always carries a real numeric code.
   */
  public readonly timedOut: boolean;

  public constructor(command: string, code: number, timedOut = false) {
    // Deliberately excludes stderr: git echoes candidate paths and content into it.
    super(`${command} exited with ${String(code)}`);
    this.name = "ExecFailure";
    this.code = code;
    this.timedOut = timedOut;
  }
}

export function run(
  command: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: "buffer",
        env: options.env ?? {},
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
        const err = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr);
        if (error === null) {
          resolve({ stdout: out, stderr: err, code: 0 });
          return;
        }
        const code = typeof error.code === "number" ? error.code : 1;
        reject(new ExecFailure(command, code, error.killed === true));
      },
    );
    // `execFile` does not expose an `input` option. Writing to the returned child's pipe keeps the
    // same shell-free process boundary while allowing parsers such as ast-grep to inspect an exact
    // Git blob without materializing it as a candidate-controlled file. Ignore a late EPIPE here:
    // the callback above remains the single source of the process result.
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });
}

/**
 * A git environment stripped of everything the ambient runner might have set.
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` matter specifically: a global
 * config can define aliases, hooks paths, and `core.fsmonitor`, all of which turn a "read-only"
 * plumbing call into arbitrary code execution.
 */
export function gitEnvironment(pathValue: string): NodeJS.ProcessEnv {
  return {
    PATH: pathValue,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_OPTIONAL_LOCKS: "0",
    // Object replacement and pathspec magic are ambient Git behaviours, not properties of the
    // immutable commit/path pair a caller asked us to read.
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_ALLOW_PROTOCOL: "file:https",
    LC_ALL: "C",
  };
}
