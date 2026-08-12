import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { releaseChannelMessage, releaseDevBindingMessage } from "./release-lib.mjs";
import {
  executeReleaseMainProvenanceCli,
  runReleaseMainProvenance,
} from "./release-main-provenance.mjs";

const GIT = "/usr/bin/git";

function git(root, arguments_) {
  return execFileSync(GIT, arguments_, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}

function provenanceExecutor({
  ancestor = true,
  boundTree = "b".repeat(40),
  headTree = boundTree,
  message,
}) {
  return (_command, arguments_) => {
    if (arguments_[0] === "log") return message;
    if (arguments_[0] === "fetch") return "";
    if (arguments_[0] === "merge-base") {
      if (!ancestor) throw new Error("not an ancestor");
      return "";
    }
    if (arguments_[0] === "rev-parse" && arguments_[1] === "HEAD^{tree}") return headTree;
    if (arguments_[0] === "rev-parse") return boundTree;
    assert.fail(`unexpected git arguments: ${arguments_.join(" ")}`);
  };
}

test("accepts the immutable governed dev tree after dev advances", () => {
  const temporary = mkdtempSync(join(tmpdir(), "kfq-release-provenance-"));
  const origin = join(temporary, "origin.git");
  const repository = join(temporary, "repository");
  try {
    git(temporary, ["init", "--bare", origin]);
    mkdirSync(repository);
    git(repository, ["init", "-b", "dev"]);
    git(repository, ["config", "user.name", "Release Test"]);
    git(repository, ["config", "user.email", "release@example.invalid"]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repository, "governed.txt"), "governed\n");
    git(repository, ["add", "governed.txt"]);
    git(repository, ["commit", "-m", "governed dev"]);
    const governedCommit = git(repository, ["rev-parse", "HEAD^{commit}"]);
    const governedTree = git(repository, ["rev-parse", "HEAD^{tree}"]);
    const binding = releaseDevBindingMessage({ commit: governedCommit, tree: governedTree });
    const channel = releaseChannelMessage({ channel: "standard" });
    git(repository, ["remote", "add", "origin", origin]);
    git(repository, ["push", "-u", "origin", "dev"]);

    git(repository, ["switch", "-c", "main"]);
    git(repository, [
      "commit",
      "--allow-empty",
      "-m",
      "release: v9.9.9",
      "-m",
      binding,
      "-m",
      channel,
    ]);
    git(repository, ["switch", "dev"]);
    writeFileSync(join(repository, "later.txt"), "dev advanced\n");
    git(repository, ["add", "later.txt"]);
    git(repository, ["commit", "-m", "later dev change"]);
    git(repository, ["push", "origin", "dev"]);
    assert.notEqual(git(repository, ["rev-parse", "HEAD^{tree}"]), governedTree);

    git(repository, ["switch", "main"]);
    const logs = [];
    assert.deepEqual(
      runReleaseMainProvenance({ log: (message) => logs.push(message), root: repository }),
      {
        commit: governedCommit,
        tree: governedTree,
        channel: "standard",
        recoveryReason: undefined,
      },
    );
    assert.match(logs[0], new RegExp(`matches governed dev ${governedCommit}`, "u"));

    writeFileSync(join(repository, "governed.txt"), "release tree drifted\n");
    git(repository, ["add", "governed.txt"]);
    git(repository, ["commit", "-m", "release: v9.9.10", "-m", binding, "-m", channel]);
    assert.throws(
      () => runReleaseMainProvenance({ log: () => undefined, root: repository }),
      /main tree does not match the immutable governed dev tree/u,
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("CLI reports an invalid binding without an uncaught stack", () => {
  const errors = [];
  const exits = [];
  executeReleaseMainProvenanceCli({
    error: (message) => errors.push(message),
    run: () => {
      throw new Error("release dev binding is invalid");
    },
    setExitCode: (value) => exits.push(value),
  });
  assert.deepEqual(errors, ["release-main-provenance: FAIL - release dev binding is invalid"]);
  assert.deepEqual(exits, [1]);
});

test("rejects unbound text, a non-dev commit, and a forged tree binding", () => {
  const binding = { commit: "a".repeat(40), tree: "b".repeat(40) };
  const message = `${releaseDevBindingMessage(binding)}\n${releaseChannelMessage({ channel: "standard" })}`;
  assert.throws(
    () =>
      runReleaseMainProvenance({
        execute: provenanceExecutor({ message: "release: v9.9.9" }),
        log: () => undefined,
      }),
    /release dev binding is invalid/u,
  );
  assert.throws(
    () =>
      runReleaseMainProvenance({
        execute: provenanceExecutor({ ancestor: false, message }),
        log: () => undefined,
      }),
    /bound release commit is not in governed dev history/u,
  );
  assert.throws(
    () =>
      runReleaseMainProvenance({
        execute: provenanceExecutor({ boundTree: "c".repeat(40), message }),
        log: () => undefined,
      }),
    /bound release tree does not match the bound dev commit/u,
  );
  assert.throws(
    () =>
      runReleaseMainProvenance({
        execute: provenanceExecutor({ message: releaseDevBindingMessage(binding) }),
        log: () => undefined,
      }),
    /release channel binding is invalid/u,
  );
});
