import { execFile, spawn } from "node:child_process";

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

export interface BoundedLineOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maximumBytes: number;
  readonly maximumRecords: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface BoundedLineResult {
  readonly records: readonly Buffer[];
  readonly status: "complete" | "stdout_truncated";
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

interface LineAccumulator {
  readonly records: Buffer[];
  pending: Buffer;
  completeBytes: number;
  endedOnNewline: boolean;
  status: "complete" | "stdout_truncated";
}

interface LineProcessState {
  readonly accumulator: LineAccumulator;
  settled: boolean;
  timedOut: boolean;
  parseFailed: boolean;
  timer?: NodeJS.Timeout;
}

function truncateAccumulator(accumulator: LineAccumulator): void {
  accumulator.pending = Buffer.alloc(0);
  accumulator.status = "stdout_truncated";
}

function appendCompleteRecord(
  accumulator: LineAccumulator,
  record: Buffer,
  options: BoundedLineOptions,
): boolean {
  if (
    accumulator.records.length === options.maximumRecords ||
    accumulator.completeBytes + record.length > options.maximumBytes
  ) {
    truncateAccumulator(accumulator);
    return false;
  }
  accumulator.records.push(Buffer.from(record));
  accumulator.completeBytes += record.length;
  return true;
}

function appendLineChunk(
  accumulator: LineAccumulator,
  chunk: Buffer,
  options: BoundedLineOptions,
): void {
  if (chunk.length > 0) accumulator.endedOnNewline = chunk.at(-1) === 0x0a;
  if (accumulator.status === "stdout_truncated") return;
  const combined =
    accumulator.pending.length === 0
      ? chunk
      : Buffer.concat([accumulator.pending, chunk], accumulator.pending.length + chunk.length);
  let cursor = 0;
  while (cursor < combined.length) {
    const newline = combined.indexOf(0x0a, cursor);
    if (newline < 0) break;
    if (!appendCompleteRecord(accumulator, combined.subarray(cursor, newline + 1), options)) return;
    cursor = newline + 1;
  }
  const pending = combined.subarray(cursor);
  if (
    pending.length > 0 &&
    (accumulator.records.length === options.maximumRecords ||
      accumulator.completeBytes + pending.length > options.maximumBytes)
  ) {
    truncateAccumulator(accumulator);
    return;
  }
  accumulator.pending = Buffer.from(pending);
}

function validBoundedLineOptions(options: BoundedLineOptions): boolean {
  return (
    Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs > 0 &&
    Number.isSafeInteger(options.maximumBytes) &&
    options.maximumBytes > 0 &&
    Number.isSafeInteger(options.maximumRecords) &&
    options.maximumRecords > 0
  );
}

function stopTimer(state: LineProcessState): void {
  if (state.timer !== undefined) clearTimeout(state.timer);
}

function acceptLineData(
  state: LineProcessState,
  value: Buffer | string,
  options: BoundedLineOptions,
  kill: () => void,
): void {
  if (state.parseFailed) return;
  try {
    appendLineChunk(
      state.accumulator,
      Buffer.isBuffer(value) ? value : Buffer.from(value),
      options,
    );
  } catch {
    state.parseFailed = true;
    kill();
  }
}

function rejectLineProcess(
  state: LineProcessState,
  command: string,
  reject: (reason: ExecFailure) => void,
): void {
  if (state.settled) return;
  state.settled = true;
  stopTimer(state);
  reject(new ExecFailure(command, 1, state.timedOut));
}

function finishLineProcess(
  state: LineProcessState,
  command: string,
  code: number | null,
  resolve: (result: BoundedLineResult) => void,
  reject: (reason: ExecFailure) => void,
): void {
  if (state.settled) return;
  state.settled = true;
  stopTimer(state);
  const incomplete = !state.accumulator.endedOnNewline;
  if (state.timedOut || state.parseFailed || code !== 0 || incomplete) {
    const failureCode = state.timedOut ? 1 : typeof code === "number" ? code : 1;
    reject(new ExecFailure(command, failureCode, state.timedOut));
    return;
  }
  resolve({ records: state.accumulator.records, status: state.accumulator.status });
}

/**
 * Shell-free subprocess execution for line-framed output whose producer must run to a real exit.
 *
 * Complete newline records are retained only up to both caller-supplied ceilings. Once either
 * ceiling is crossed, stdout continues to be drained but is discarded: this keeps memory bounded
 * while preserving a later exit 2 or timeout instead of mislabelling it as successful truncation.
 * Stderr is never retained because Git may echo candidate-controlled paths and content there.
 */
export function runBoundedLineRecords(
  command: string,
  args: readonly string[],
  options: BoundedLineOptions,
): Promise<BoundedLineResult> {
  if (!validBoundedLineOptions(options)) {
    return Promise.reject(new ExecFailure(command, 1));
  }
  return new Promise((resolve, reject) => {
    const state: LineProcessState = {
      accumulator: {
        records: [],
        pending: Buffer.alloc(0),
        completeBytes: 0,
        endedOnNewline: true,
        status: "complete",
      },
      settled: false,
      timedOut: false,
      parseFailed: false,
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? {},
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    state.timer = setTimeout(() => {
      state.timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (value: Buffer | string) => {
      acceptLineData(state, value, options, () => {
        child.kill("SIGKILL");
      });
    });
    child.once("error", () => {
      rejectLineProcess(state, command, reject);
    });
    child.once("close", (code) => {
      finishLineProcess(state, command, code, resolve, reject);
    });
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
