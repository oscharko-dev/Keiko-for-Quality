#!/usr/bin/env node
// The release procedure, as a program rather than as something to remember.
//
//   node scripts/release.mjs prep    --version 0.21.3
//   node scripts/release.mjs release --version 0.21.3
//   node scripts/release.mjs publish --version 0.21.3 --sha <main-squash-sha>
//   node scripts/release.mjs repin   --version 0.21.3 --sha <main-squash-sha>
//   node scripts/release.mjs check
//
// Split into phases because two of them wait on a human-visible event — a pull request merging —
// and a script that polls for that is a script that lies about what it verified. Each phase
// refuses to run when its own preconditions are unmet, and `check` is the phase that would have
// caught the failure this file was written for: three consecutive releases whose tags were pushed
// and whose GitHub Releases were never created, because nothing fails when you skip that.
//
// `check` takes no arguments and is safe to run any time; every other phase writes.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bumpConsumerPin,
  bumpQuickstartPin,
  findGateEvidence,
  notesFromCommitMessage,
  parseVersion,
  reconcileTagsAndReleases,
  sortVersionTags,
  tagFor,
} from "./release-lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = "oscharko-dev/Keiko-for-Quality";

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.inherit === true ? "inherit" : "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requireVersion() {
  const version = parseVersion(argValue("--version"));
  if (version === undefined) fail("--version X.Y.Z is required");
  return version;
}

function requireSha() {
  const sha = argValue("--sha");
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/u.test(sha)) {
    fail("--sha must be a full 40-character commit SHA");
  }
  return sha;
}

function requireCleanWorktree() {
  if (run("git", ["status", "--porcelain"]).trim() !== "") {
    fail("the worktree has uncommitted changes — commit or stash them first");
  }
}

/**
 * `npm run verify`, never piped.
 *
 * A shell pipeline exits with its LAST command's status, so `npm run verify | tail` reads a red
 * chain as green. That is not hypothetical: it shipped a stale `dist/` on 2026-08-08, which the
 * reviewer then found in its own pull request. Here the status is the only thing consulted.
 */
function verifyOrDie() {
  try {
    run("npm", ["run", "verify"], { inherit: true });
  } catch {
    fail("npm run verify failed — nothing is released over a red chain");
  }
}

function requireGateEvidence(version) {
  const names = readdirSync(join(ROOT, "corpus", "evidence"));
  const found = findGateEvidence(names, version);
  if (!found.complete) {
    fail(
      `gate evidence for v${version} is missing (seed: ${found.seed ?? "—"}, completion: ` +
        `${found.completion ?? "—"}). Run both gates on this tree and commit their reports.`,
    );
  }
  return found;
}

function phasePrep() {
  const version = requireVersion();
  requireCleanWorktree();
  requireGateEvidence(version);

  run("npm", ["version", "--no-git-tag-version", version]);
  const readmePath = join(ROOT, "README.md");
  const bumped = bumpQuickstartPin(readFileSync(readmePath, "utf8"), version);
  if (bumped.changed === 0)
    fail("the README quickstart pin comment was not found — check its shape");
  writeFileSync(readmePath, bumped.text);
  run("npm", ["run", "build"], { inherit: true });
  verifyOrDie();

  run("git", ["add", "-A"]);
  run("git", [
    "commit",
    "-S",
    "-m",
    `release: v${version} prep — version, quickstart comment, release-shaped gate evidence`,
  ]);
  console.log(`prep committed for v${version}. Open the prep PR into dev, then run: release`);
}

function phaseRelease() {
  const version = requireVersion();
  requireCleanWorktree();
  run("git", ["fetch", "origin", "main", "dev"]);
  run("git", ["checkout", "-b", `release/v${version}`, "origin/main"]);
  run("git", ["rm", "-rq", "."]);
  run("git", ["checkout", "origin/dev", "--", "."]);
  run("git", ["add", "-A"]);
  run("git", ["commit", "-S", "-m", `release: v${version}`]);

  // dev's tree, whole — asserted, never assumed. A release that is not byte-identical to what the
  // gates ran against is a release with no evidence.
  const mine = run("git", ["rev-parse", "HEAD^{tree}"]).trim();
  const theirs = run("git", ["rev-parse", "origin/dev^{tree}"]).trim();
  if (mine !== theirs) fail(`release tree ${mine} does not match dev's ${theirs}`);

  run("git", ["push", "-u", "origin", `release/v${version}`]);
  console.log(
    `release/v${version} pushed, tree identical to dev. Open the PR into main, then: publish`,
  );
}

function phasePublish() {
  const version = requireVersion();
  const sha = requireSha();
  const tag = tagFor(version);
  run("git", ["fetch", "origin", "main"]);
  run("git", ["tag", "-s", tag, sha, "-m", `${tag} — see the release notes`]);
  run("git", ["push", "origin", tag]);

  const message = run("git", ["log", "-1", "--format=%B", sha]);
  const notes = notesFromCommitMessage(message);
  // The step nothing fails without, which is exactly why it is here and not in a checklist.
  run("gh", [
    "release",
    "create",
    tag,
    "--repo",
    REPO,
    "--verify-tag",
    "--latest",
    "--title",
    notes.title,
    "--notes",
    notes.body,
  ]);
  phaseCheck();
  console.log(`${tag} tagged, released, and reconciled. Next: repin --sha ${sha}`);
}

function phaseRepin() {
  const version = requireVersion();
  const sha = requireSha();
  requireCleanWorktree();
  const workflowPath = join(ROOT, ".github", "workflows", "self-review.yml");
  const bumped = bumpConsumerPin(readFileSync(workflowPath, "utf8"), sha, version);
  if (bumped.uses === 0) fail("no pinned uses: line found in self-review.yml");
  writeFileSync(workflowPath, bumped.text);
  run("git", ["add", workflowPath]);
  run("git", ["commit", "-S", "-m", `ci(self-review): advance the pin to v${version}`]);
  console.log(
    `self-review repinned to ${sha}. The CONSUMER repo is a separate step: rewrite its ` +
      "workflow's uses: AND ACTION_PIN together — its own sync check fails the run otherwise.",
  );
}

/**
 * Every pushed version tag has a GitHub Release, and every Release has a tag.
 *
 * The whole point of this file in one function: run it any time, and a silent omission becomes a
 * loud one.
 */
function phaseCheck() {
  // An annotated tag appears twice in ls-remote — once as the tag object, once as `^{}`
  // dereferenced to its commit — so the names are de-duplicated before anything counts them.
  const tags = sortVersionTags([
    ...new Set(
      run("git", ["ls-remote", "--tags", "origin"])
        .split("\n")
        .map((line) => line.split("refs/tags/")[1]?.replace(/\^\{\}$/u, ""))
        .filter((tag) => typeof tag === "string" && tag !== ""),
    ),
  ]);
  const releases = run("gh", [
    "release",
    "list",
    "--repo",
    REPO,
    "--limit",
    "200",
    "--json",
    "tagName",
  ]);
  const released = JSON.parse(releases).map((entry) => entry.tagName);
  const result = reconcileTagsAndReleases(tags, released);
  if (result.releasesWithoutTag.length > 0) {
    fail(`these Releases name a tag that does not exist: ${result.releasesWithoutTag.join(", ")}`);
  }
  if (result.newestUnreleased !== undefined) {
    fail(
      `${result.newestUnreleased} is the newest version tag and has no GitHub Release — the ` +
        "repository's front page advertises an older version than it ships",
    );
  }
  // Historical gaps are reported, never failed on: see reconcileTagsAndReleases for why a gate
  // that is red every time is a gate nobody reads.
  const historical = result.tagsWithoutRelease.filter((tag) => tag !== result.newestUnreleased);
  if (historical.length > 0) {
    console.log(
      `note: ${String(historical.length)} older tag(s) predate the Release practice: ${historical.join(", ")}`,
    );
  }
  console.log(`release check: newest tag ${result.newest ?? "—"} has a Release. OK`);
}

const PHASES = {
  prep: phasePrep,
  release: phaseRelease,
  publish: phasePublish,
  repin: phaseRepin,
  check: phaseCheck,
};

const phase = PHASES[process.argv[2] ?? ""];
if (phase === undefined) {
  console.error(
    "usage: node scripts/release.mjs prep|release|publish|repin|check [--version X.Y.Z] [--sha <40-hex>]",
  );
  process.exit(2);
}
phase();
