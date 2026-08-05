import { describe, expect, it, vi } from "vitest";

import { commitSha } from "../core/brands.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import type { GitContext } from "./plumbing.js";

/**
 * `readTextAtCommit`'s one rethrow case (v0.13.0): a real execution failure — a timeout — must
 * surface, not degrade into the same "path absent" `undefined` every OTHER `ExecFailure` produces.
 * `plumbing.test.ts` drives real git throughout this whole file and has no way to make a real
 * `cat-file` time out deterministically, so this is its own file: mocking `git/exec.js`'s `run`
 * here cannot affect that file's real-git tests, which import the unmocked module.
 *
 * Only `import type` reaches "./exec.js" statically above — see `engine/run.test.ts`'s identical
 * comment for why a value import would force this factory to run before `execRunMock` is
 * initialized (a real TDZ failure, not a hypothetical one).
 */
const execRunMock =
  vi.fn<(command: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>>();
vi.mock("./exec.js", async (importOriginal) => ({
  ...(await importOriginal()),
  run: execRunMock,
}));

const { readTextAtCommit } = await import("./plumbing.js");
const { ExecFailure } = await import("./exec.js");

const CTX: GitContext = { cwd: "/repo", timeoutMs: 1000, pathValue: "/usr/bin:/bin" };
const COMMIT = commitSha("a".repeat(40));

describe("readTextAtCommit — a real execution failure vs. a legitimate absence", () => {
  it("rethrows a timeout rather than degrading it to undefined", async () => {
    execRunMock.mockRejectedValueOnce(new ExecFailure("git", 1, true));
    await expect(readTextAtCommit(CTX, COMMIT, "src/a.ts")).rejects.toThrow(ExecFailure);
  });

  // The control that makes the rethrow above meaningful: an ORDINARY non-zero exit (`cat-file
  // blob` for a path that simply does not exist at that commit) must still degrade to `undefined`,
  // exactly as this function's own doc comment promises — only `timedOut` changes the outcome.
  it("still degrades an ordinary non-zero exit to undefined", async () => {
    execRunMock.mockRejectedValueOnce(new ExecFailure("git", 128, false));
    expect(await readTextAtCommit(CTX, COMMIT, "src/never-existed.ts")).toBeUndefined();
  });
});
