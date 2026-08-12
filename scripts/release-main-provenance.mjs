#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { parseReleaseChannelMessage, parseReleaseDevBinding } from "./release-lib.mjs";

const SYSTEM_GIT = "/usr/bin/git";

function git(execute, root, arguments_) {
  return execute(SYSTEM_GIT, arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
  }).trim();
}

/**
 * Proves a main squash has the tree of the immutable dev revision named by the release commit.
 * The current dev tip is deliberately not the comparison target: dev may advance after the
 * release branch is cut, while the bound revision remains in its protected linear history.
 */
export function runReleaseMainProvenance({
  execute = execFileSync,
  log = console.log,
  root = process.cwd(),
} = {}) {
  const message = git(execute, root, ["log", "-1", "--format=%B", "HEAD"]);
  const parsed = parseReleaseDevBinding(message);
  if (!parsed.valid || parsed.binding === undefined) {
    throw new Error(`release dev binding is invalid: ${parsed.failures.join(", ")}`);
  }
  const channel = parseReleaseChannelMessage(message);
  if (!channel.valid) {
    throw new Error(`release channel binding is invalid: ${channel.failures.join(", ")}`);
  }

  git(execute, root, ["fetch", "--no-tags", "origin", "refs/heads/dev:refs/remotes/origin/dev"]);
  try {
    git(execute, root, ["merge-base", "--is-ancestor", parsed.binding.commit, "origin/dev"]);
  } catch {
    throw new Error("bound release commit is not in governed dev history");
  }

  const boundTree = git(execute, root, ["rev-parse", `${parsed.binding.commit}^{tree}`]);
  if (boundTree !== parsed.binding.tree) {
    throw new Error("bound release tree does not match the bound dev commit");
  }
  const mainTree = git(execute, root, ["rev-parse", "HEAD^{tree}"]);
  if (mainTree !== boundTree) {
    throw new Error("main tree does not match the immutable governed dev tree");
  }
  log(
    `release-main-provenance: PASS - main tree ${mainTree} matches governed dev ` +
      `${parsed.binding.commit}.`,
  );
  return { ...parsed.binding, channel: channel.channel, recoveryReason: channel.recoveryReason };
}

export function executeReleaseMainProvenanceCli(input = {}) {
  try {
    (input.run ?? runReleaseMainProvenance)();
  } catch (error) {
    (input.error ?? console.error)(
      `release-main-provenance: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  executeReleaseMainProvenanceCli();
}
