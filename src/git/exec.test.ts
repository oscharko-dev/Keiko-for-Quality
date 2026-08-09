import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ExecFailure,
  gitEnvironment,
  run,
  runBoundedLineRecords,
  type ExecOptions,
} from "./exec.js";

/**
 * The product starts exactly one kind of subprocess, and it starts it here.
 *
 * `plumbing.test.ts` has always driven real git through this module, so every line below was
 * already *executed* before this file existed — which is precisely why the coverage number never
 * showed the gap. What was missing is assertions. Deleting `GIT_CONFIG_GLOBAL` and
 * `GIT_CONFIG_SYSTEM` from `gitEnvironment` left the whole suite green, and so did flipping the
 * timeout signal at the bottom of `run`, which silently relabels every engine timeout as an
 * ordinary non-zero exit one layer up (`engine/run.ts`). SECURITY.md states these as promises to
 * consumers — a constructed environment, neutralized global and system configuration, arguments
 * that no shell ever parses, and bounded output because "a candidate controls how large a blob or a
 * diff is". This file is where those promises stop being prose.
 *
 * Every child here is `process.execPath`, spawned by absolute path: the environments under test
 * carry either a curated `PATH` or none at all, so an interpreter looked up by name would make the
 * cases about how the runner's shell is configured instead of about `run`. The single exception is
 * the real-git case at the end, which resolves `git` through the curated `PATH` on purpose, because
 * that is exactly what `plumbing.ts` does in production.
 */
const NODE = process.execPath;

/** Prints the child's own arguments — everything after `-e <source>` — as JSON. */
const ECHO_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

/** Prints the environment the child actually received, as JSON. */
const ECHO_ENV = "process.stdout.write(JSON.stringify(process.env))";

/**
 * Set on this worker's own environment so the isolation cases can prove absence rather than assume
 * it: a child that cannot see these did not inherit anything.
 */
const SENTINEL = "KFQ_EXEC_TEST_SENTINEL";
const AMBIENT_GIT_VAR = "GIT_ALTERNATE_OBJECT_DIRECTORIES";

const OPTIONS: ExecOptions = { cwd: tmpdir(), timeoutMs: 10_000, maxBuffer: 256 * 1024 };

/** Awaits a call that must reject, and hands back the `ExecFailure` it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<ExecFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExecFailure) return error;
    throw error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

beforeAll(() => {
  process.env[SENTINEL] = "ambient";
  process.env[AMBIENT_GIT_VAR] = "/tmp/kfq-should-never-be-inherited";
});

afterAll(() => {
  // `Reflect.deleteProperty` rather than `delete`, which lint rejects on a computed key. Assigning
  // `undefined` is not the alternative it looks like: node coerces it and leaves the literal string
  // "undefined" behind, which would then be inherited by anything spawned afterwards.
  Reflect.deleteProperty(process.env, SENTINEL);
  Reflect.deleteProperty(process.env, AMBIENT_GIT_VAR);
});

describe("run — arguments", () => {
  it("delivers every argument verbatim as its own argv element, never through a shell", async () => {
    // The claim "candidate content is data" rests here at this layer. Paths, refs and rule
    // arguments are attacker-shaped strings, and `shell: false` plus the array form is the only
    // thing standing between them and a command line. Each of these would be split, expanded or
    // executed by any shell that saw it.
    const hostile = ["; echo pwned", "$(id)", "`id`", "a b | c", "x\ny", "*", "~", "&& id"];
    const result = await run(NODE, ["-e", ECHO_ARGV, ...hostile], OPTIONS);
    expect(JSON.parse(result.stdout.toString("utf8"))).toEqual(hostile);
  });
});

describe("run — environment", () => {
  it("hands the child nothing at all when the caller supplies no environment", async () => {
    // `options.env ?? {}` is why a runner's proxy, credential or `GIT_*` variables cannot reach a
    // spawned process by accident — the environment is built from nothing, not filtered.
    expect(process.env[SENTINEL]).toBe("ambient");
    const result = await run(NODE, ["-e", ECHO_ENV], OPTIONS);
    const childEnv = JSON.parse(result.stdout.toString("utf8"));
    // Absence of the sentinel rather than "no keys at all": macOS injects
    // `__CF_USER_TEXT_ENCODING` into every child regardless, and pinning emptiness would fail
    // there for a reason that has nothing to do with this module.
    expect(childEnv).not.toHaveProperty(SENTINEL);
    expect(childEnv).not.toHaveProperty("PATH");
  });

  it("passes exactly the supplied environment, overriding an ambient variable of the same name", async () => {
    const result = await run(NODE, ["-e", ECHO_ENV], {
      ...OPTIONS,
      env: { [SENTINEL]: "supplied" },
    });
    expect(JSON.parse(result.stdout.toString("utf8"))[SENTINEL]).toBe("supplied");
  });

  it("carries gitEnvironment's neutralisation into the child and nothing the runner set", async () => {
    const result = await run(NODE, ["-e", ECHO_ENV], {
      ...OPTIONS,
      env: gitEnvironment("/usr/bin:/bin"),
    });
    const childEnv = JSON.parse(result.stdout.toString("utf8"));
    expect(childEnv.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(childEnv.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    // The fixed PATH posture: git is found through the value the caller named, never the one the
    // job happened to export.
    expect(childEnv.PATH).toBe("/usr/bin:/bin");
    expect(childEnv).not.toHaveProperty(SENTINEL);
    expect(childEnv).not.toHaveProperty(AMBIENT_GIT_VAR);
  });
});

describe("run — output", () => {
  it("returns stdout as bytes, so NUL-framed plumbing output survives intact", async () => {
    // `listChanges` splits git's `-z` output on NUL. A decode anywhere in this path would corrupt
    // the framing that exists specifically so candidate-controlled paths cannot be misparsed.
    const result = await run(
      NODE,
      ["-e", "process.stdout.write(Buffer.from([0, 65, 0, 255, 66]))"],
      OPTIONS,
    );
    expect([...result.stdout]).toEqual([0, 65, 0, 255, 66]);
  });

  it("returns stderr as text alongside a zero code when the child succeeds", async () => {
    const result = await run(
      NODE,
      ["-e", "process.stderr.write('warning: something'); process.stdout.write('ok')"],
      OPTIONS,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("warning: something");
  });

  it("rejects an over-cap child rather than resolving with a truncated prefix", async () => {
    // The bound is the denial-of-service defence: a candidate chooses how large a blob or diff is.
    // Truncating instead of failing would be worse than either — a caller would parse a prefix as
    // though it were the whole file.
    const failure = await rejection(
      run(NODE, ["-e", "process.stdout.write('x'.repeat(200_000))"], {
        ...OPTIONS,
        maxBuffer: 1024,
      }),
    );
    // `timedOut` is the half worth pinning, and pinning it is what tells the two bounds apart: a
    // caller that retries a timeout must not retry an over-cap child, because the output is over
    // the cap every time. The exit code is deliberately NOT pinned — node reports this one with a
    // *string* `code` that `run`'s numeric fallback maps to 1, and freezing that incidental 1 as a
    // contract would pin an implementation detail rather than the bound.
    expect(failure.timedOut).toBe(false);
  });
});

describe("run — failure classification", () => {
  it("reports an ordinary non-zero exit with the child's own code and no timeout flag", async () => {
    const failure = await rejection(run(NODE, ["-e", "process.exit(3)"], OPTIONS));
    expect(failure.code).toBe(3);
    expect(failure.timedOut).toBe(false);
  });

  it("flags a timeout kill, which carries no exit code of its own", async () => {
    // `engine/run.ts` settles a timeout under its own reason code, so the two failure shapes must
    // stay distinguishable here — node reports `code: null` and `killed: true` for a kill, and the
    // `killed` flag is the only signal that separates it from an exit the child chose. The margin
    // is deliberate: a 250ms cap against a child that would sleep ten seconds can never race, not
    // even on the instrumented coverage runner vitest.config.ts's own comment records.
    const failure = await rejection(
      run(NODE, ["-e", "setTimeout(() => {}, 10_000)"], { ...OPTIONS, timeoutMs: 250 }),
    );
    expect(failure.timedOut).toBe(true);
  });

  it("keeps stderr out of the failure message, because git echoes candidate content into it", async () => {
    // A thrown Error's message travels further than any other string in this codebase — into
    // diagnostics, into aggregation. Candidate paths and content must not ride along.
    const leak = "src/secret-path.ts: some candidate content";
    const failure = await rejection(
      run(NODE, ["-e", `process.stderr.write(${JSON.stringify(leak)}); process.exit(2)`], OPTIONS),
    );
    expect(failure.message).toBe(`${NODE} exited with 2`);
    expect(failure.message).not.toContain("secret-path");
  });
});

describe("runBoundedLineRecords", () => {
  it("rejects invalid ceilings before spawning the child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kfq-bounded-options-"));
    const marker = join(directory, "spawned");
    const invalid = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    try {
      for (const value of invalid) {
        for (const field of ["timeoutMs", "maximumBytes", "maximumRecords"] as const) {
          const options = {
            cwd: directory,
            timeoutMs: 10_000,
            maximumBytes: 1024,
            maximumRecords: 2,
            [field]: value,
          };
          const failure = await rejection(
            runBoundedLineRecords(
              NODE,
              ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes")`],
              options,
            ),
          );
          expect(failure.timedOut).toBe(false);
          await expect(access(marker)).rejects.toThrow();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains only complete bounded records and marks later stdout truncated", async () => {
    const result = await runBoundedLineRecords(
      NODE,
      ["-e", "for (let i = 0; i < 100; i += 1) process.stdout.write(`row${i}\\n`);"],
      { cwd: tmpdir(), timeoutMs: 10_000, maximumBytes: 1024, maximumRecords: 2 },
    );

    expect(result.status).toBe("stdout_truncated");
    expect(result.records.map((record) => record.toString("utf8"))).toEqual(["row0\n", "row1\n"]);
  });

  it("applies the byte ceiling without retaining a partial record", async () => {
    const result = await runBoundedLineRecords(
      NODE,
      ["-e", "process.stdout.write('one\\ntoolong\\n')"],
      { cwd: tmpdir(), timeoutMs: 10_000, maximumBytes: 5, maximumRecords: 10 },
    );

    expect(result.status).toBe("stdout_truncated");
    expect(result.records.map((record) => record.toString("utf8"))).toEqual(["one\n"]);
  });

  it("preserves shell-free argument boundaries", async () => {
    const hostile = "$(touch should-not-run)";
    const result = await runBoundedLineRecords(
      NODE,
      ["-e", "process.stdout.write(`${process.argv[1]}\\n`)", hostile],
      { cwd: tmpdir(), timeoutMs: 10_000, maximumBytes: 1024, maximumRecords: 2 },
    );

    expect(result.records[0]?.toString("utf8")).toBe(`${hostile}\n`);
  });

  it("rejects a real non-zero exit even after stdout crossed the cap", async () => {
    const failure = await rejection(
      runBoundedLineRecords(
        NODE,
        [
          "-e",
          "for (let i = 0; i < 20; i += 1) process.stdout.write(`secret${i}\\n`); process.exit(2);",
        ],
        { cwd: tmpdir(), timeoutMs: 10_000, maximumBytes: 1024, maximumRecords: 2 },
      ),
    );

    expect(failure.code).toBe(2);
    expect(failure.message).not.toContain("secret");
  });

  it("rejects timeout and unterminated output without exposing content", async () => {
    const timeout = await rejection(
      runBoundedLineRecords(NODE, ["-e", "setTimeout(() => {}, 10_000)"], {
        cwd: tmpdir(),
        timeoutMs: 250,
        maximumBytes: 1024,
        maximumRecords: 2,
      }),
    );
    expect(timeout.timedOut).toBe(true);

    const malformed = await rejection(
      runBoundedLineRecords(NODE, ["-e", "process.stdout.write('candidate-secret')"], {
        cwd: tmpdir(),
        timeoutMs: 10_000,
        maximumBytes: 1024,
        maximumRecords: 2,
      }),
    );
    expect(malformed.message).not.toContain("candidate-secret");
  });
});

describe("gitEnvironment", () => {
  it("declares exactly the variables git is permitted to see", () => {
    // Deep equality rather than spot checks: a variable quietly added here is a new channel into
    // git's behaviour, and one quietly removed is a neutralisation that stopped happening. Both
    // must break this.
    expect(gitEnvironment("/usr/bin:/bin")).toStrictEqual({
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_ALLOW_PROTOCOL: "file:https",
      LC_ALL: "C",
    });
  });

  describe("against real git", () => {
    let home: string;

    beforeAll(async () => {
      home = await mkdtemp(join(tmpdir(), "kfq-exec-home-"));
      // A global config that redefines what a bare `git <word>` invocation runs. This one aliases a
      // harmless subcommand; the dangerous form carries a leading `!`, which makes the alias a
      // shell command and turns a read-only plumbing call into arbitrary execution. That is the
      // exact sentence SECURITY.md promises against.
      await writeFile(join(home, ".gitconfig"), "[alias]\n\tkfq-pwn = version\n");
    });

    afterAll(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it("stops a global config from redefining what a plumbing call runs", async () => {
      // `gitEnvironment` sets no HOME at all, so a case built on it alone would pass whether or not
      // `GIT_CONFIG_GLOBAL` survived — git would find no global config either way, and the
      // assertion would be inert. Supplying a HOME that genuinely holds one is what makes this
      // sensitive to the entry it guards.
      // Annotated rather than inferred: a spread of `ProcessEnv` loses its index signature, and the
      // control below reads one key back off this object by name.
      const env: NodeJS.ProcessEnv = {
        ...gitEnvironment(process.env.PATH ?? "/usr/bin:/bin"),
        HOME: home,
      };
      const failure = await rejection(run("git", ["kfq-pwn"], { ...OPTIONS, cwd: home, env }));
      // It exited on its own — git rejected an unknown subcommand — rather than being killed.
      expect(failure.timedOut).toBe(false);

      // The control that makes the assertion above falsifiable: the identical call with only the
      // neutralisation dropped does resolve the alias. If this half ever stops resolving it, the
      // fixture has gone inert and the half above is proving nothing.
      const { GIT_CONFIG_GLOBAL: _dropped, ...exposed } = env;
      const control = await run("git", ["kfq-pwn"], { ...OPTIONS, cwd: home, env: exposed });
      expect(control.stdout.toString("utf8")).toContain("git version");
    });
  });
});
