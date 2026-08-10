#!/usr/bin/env node
// The release procedure, as a program rather than as something to remember.
//
//   node scripts/release.mjs prep    --version 0.21.3
//   node scripts/release.mjs attest  --version 0.21.3
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
  gateEvidenceIdentity,
  notesFromCommitMessage,
  parseVersion,
  planReleaseTag,
  reconcileTagsAndReleases,
  releaseDevBindingMessage,
  sortVersionTags,
  tagFor,
  validateCommittedEvidenceDelta,
  validateGateEvidence,
  validatePublishTarget,
  validatePrepEvidenceChanges,
  validateQualityEvidence,
  validateRepinTarget,
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

/**
 * The same call, but a failure is an answer rather than a stack trace.
 *
 * A release tool that dies with an uncaught `execFileSync` error tells its operator less than
 * nothing: the message names a spawn, not the step that could not be completed. Every place this
 * script reads something that might not be there uses this and then calls `fail` with what it was
 * actually looking for. Three of the reviewer's own findings on this file were this shape.
 */
function tryRun(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
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
 * `attest` is the one phase that deliberately starts with new evidence files present. All four
 * measurements run while HEAD is clean, then write only their public reports without changing
 * that HEAD. This guard permits only those new, version-scoped artifacts before attestation.
 */
function requireOnlyReleaseEvidenceChanges(version) {
  const changes = run("git", ["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter((line) => line !== "");
  const validation = validatePrepEvidenceChanges(changes, version);
  if (changes.length === 0) {
    fail("attest requires freshly generated, uncommitted release evidence from the current HEAD");
  }
  if (!validation.valid) {
    fail(
      `attest permits only new v${version} evidence files before its commit (found ` +
        `${validation.invalid.join(", ")})`,
    );
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

function gateReportTexts(version) {
  const names = readdirSync(join(ROOT, "corpus", "evidence"));
  const found = findGateEvidence(names, version);
  if (found.ambiguous.length > 0) {
    fail(`gate evidence for v${version} is ambiguous: ${found.ambiguous.join("; ")}`);
  }
  if (!found.complete) {
    fail(
      `gate evidence for v${version} is missing (seed: ${found.seed ?? "—"}, completion: ` +
        `${found.completion ?? "—"}, qualification: ${found.qualification ?? "—"}, historical: ` +
        `${found.historicalReplay ?? "—"}). Run all four measurements on this tree.`,
    );
  }
  return {
    found,
    seed: readFileSync(join(ROOT, "corpus", "evidence", found.seed), "utf8"),
    completion: readFileSync(join(ROOT, "corpus", "evidence", found.completion), "utf8"),
    qualificationPath: join(ROOT, "corpus", "evidence", found.qualification),
    historicalReplayPath: join(ROOT, "corpus", "evidence", found.historicalReplay),
  };
}

function packageVersion() {
  const packageVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  if (typeof packageVersion !== "string") fail("package.json has no valid version");
  return packageVersion;
}

/** The version recorded by the commit being released, read from Git rather than the worktree. */
function packageVersionAtCommit(sha) {
  const manifest = tryRun("git", ["show", `${sha}:package.json`]);
  if (manifest === undefined) return undefined;
  try {
    const version = JSON.parse(manifest).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function requireGateEvidence(version, expectedHead) {
  const reports = gateReportTexts(version);
  const validation = validateGateEvidence(reports.seed, reports.completion, {
    version: packageVersion(),
    head: expectedHead,
  });
  if (!validation.valid) {
    fail(`gate evidence for v${version} is not releasable: ${validation.failures.join(", ")}`);
  }
  return reports;
}

function readJsonEvidence(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} evidence is not valid JSON`);
  }
}

function requireQualityEvidence(reports, expectedHead) {
  const expected = {
    version: packageVersion(),
    head: expectedHead,
    tree: run("git", ["rev-parse", `${expectedHead}^{tree}`]).trim(),
  };
  const validation = validateQualityEvidence(
    readJsonEvidence(reports.qualificationPath, "qualification"),
    readJsonEvidence(reports.historicalReplayPath, "historical replay"),
    expected,
  );
  if (!validation.valid) {
    fail(`quality evidence is not releasable: ${validation.failures.join(", ")}`);
  }
  try {
    run("node", [join(ROOT, "scripts", "check-qualification.mjs"), reports.qualificationPath], {
      inherit: true,
    });
  } catch {
    fail("qualification promotion thresholds are not green");
  }
}

function phasePrep() {
  const version = requireVersion();
  requireCleanWorktree();

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
    `release: v${version} candidate — version, quickstart comment, verified bundle`,
  ]);
  console.log(
    `candidate committed for v${version}. Land it on dev, run all four measurements on that clean ` +
      "commit, redact the private qualification OCR_REPORT with qualification:evidence, leave " +
      "the four public reports uncommitted, then run: attest",
  );
}

function phaseAttest() {
  const version = requireVersion();
  const candidateHead = run("git", ["rev-parse", "HEAD"]).trim();
  const reports = requireGateEvidence(version, candidateHead);
  requireQualityEvidence(reports, candidateHead);
  requireOnlyReleaseEvidenceChanges(version);
  verifyOrDie();
  run("git", ["add", "-A"]);
  run("git", [
    "commit",
    "-S",
    "-m",
    `release: v${version} evidence — gates bind ${candidateHead.slice(0, 12)}`,
  ]);
  console.log(
    `evidence committed for v${version}. Land this evidence-only PR on dev, then run: release`,
  );
}

function requireCommittedGateEvidence(version, targetRef, candidateAncestorRef = targetRef) {
  const reports = gateReportTexts(version);
  const seed = gateEvidenceIdentity(reports.seed).reviewer;
  const completion = gateEvidenceIdentity(reports.completion).reviewer;
  if (seed === undefined || completion === undefined || seed !== completion) {
    fail("committed gate reports do not agree on one clean candidate commit");
  }
  const candidate = tryRun("git", ["rev-parse", "--verify", `${seed}^{commit}`])?.trim();
  if (candidate?.startsWith(seed) !== true) {
    fail(`gate candidate ${seed} is not an unambiguous commit in this repository`);
  }
  requireGateEvidence(version, candidate);
  requireQualityEvidence(reports, candidate);
  if (
    tryRun("git", ["merge-base", "--is-ancestor", candidate, candidateAncestorRef]) === undefined
  ) {
    fail(`gate candidate ${candidate} is not an ancestor of ${candidateAncestorRef}`);
  }
  const delta = run("git", ["diff", "--name-only", candidate, targetRef])
    .split("\n")
    .filter((path) => path !== "");
  const deltaValidation = validateCommittedEvidenceDelta(
    delta,
    [
      reports.found.seed,
      reports.found.completion,
      reports.found.qualification,
      reports.found.historicalReplay,
    ],
    version,
  );
  if (!deltaValidation.valid) {
    fail(
      `exactly the four selected v${version} evidence files may differ between gate candidate ` +
        `${candidate} and ${targetRef}`,
    );
  }
}

function phaseRelease() {
  const version = requireVersion();
  requireCleanWorktree();
  run("git", ["fetch", "origin", "main", "dev"]);
  const localTree = run("git", ["rev-parse", "HEAD^{tree}"]).trim();
  const devCommit = run("git", ["rev-parse", "origin/dev^{commit}"]).trim();
  const devTree = run("git", ["rev-parse", "origin/dev^{tree}"]).trim();
  if (localTree !== devTree) fail("run release from the exact current origin/dev tree");
  requireCommittedGateEvidence(version, "origin/dev");
  run("git", ["checkout", "-b", `release/v${version}`, "origin/main"]);
  run("git", ["rm", "-rq", "."]);
  run("git", ["checkout", "origin/dev", "--", "."]);
  run("git", ["add", "-A"]);
  run("git", [
    "commit",
    "-S",
    "-m",
    `release: v${version}`,
    "-m",
    releaseDevBindingMessage({ commit: devCommit, tree: devTree }),
  ]);

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

function localTagObject(tag) {
  return tryRun("git", ["rev-parse", "--verify", `refs/tags/${tag}`])?.trim();
}

/** The remote tag object and its peeled commit, without changing any local ref. */
function remoteTagIdentity(tag) {
  const output = tryRun("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  if (output === undefined) fail(`could not inspect ${tag} on origin`);
  let remoteTagObject;
  let remoteTagCommit;
  for (const line of output.split("\n")) {
    const [oid, ref] = line.split("\t");
    if (ref === `refs/tags/${tag}`) remoteTagObject = oid;
    if (ref === `refs/tags/${tag}^{}`) remoteTagCommit = oid;
  }
  return { remoteTagObject, remoteTagCommit };
}

function requireSignedReleaseTag(tag, version, sha) {
  const validation = validateRepinTarget({
    version,
    sha,
    packageVersion: packageVersionAtCommit(sha),
    tagType: tryRun("git", ["cat-file", "-t", `refs/tags/${tag}`])?.trim(),
    tagCommit: tryRun("git", ["rev-parse", "--verify", `${tag}^{commit}`])?.trim(),
    tagSignatureValid: tryRun("git", ["verify-tag", tag]) !== undefined,
  });
  if (!validation.valid) {
    fail(`${tag} is not the signed release requested: ${validation.failures.join(", ")}`);
  }
}

/**
 * Creates the tag once, or safely resumes after either local creation or the remote push.
 * A divergent/lightweight/unsigned tag is never repaired or replaced: it stops the release.
 */
function ensurePublishedTag(tag, version, sha) {
  const remoteBefore = remoteTagIdentity(tag);
  const localBefore = localTagObject(tag);
  const plan = planReleaseTag({ sha, localTagObject: localBefore, ...remoteBefore });
  if (!plan.valid) fail(`${tag} conflicts with the requested release: ${plan.failures.join(", ")}`);

  if (plan.action === "fetch_existing") {
    if (tryRun("git", ["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`]) === undefined) {
      fail(`could not fetch existing release tag ${tag}`);
    }
  } else if (plan.action === "create_and_push") {
    run("git", ["tag", "-s", tag, sha, "-m", `${tag} — see the release notes`]);
  }

  requireSignedReleaseTag(tag, version, sha);
  if (plan.action === "create_and_push" || plan.action === "push_existing") {
    run("git", ["push", "origin", tag]);
  }

  const localAfter = localTagObject(tag);
  const remoteAfter = remoteTagIdentity(tag);
  const confirmed = planReleaseTag({ sha, localTagObject: localAfter, ...remoteAfter });
  if (!confirmed.valid || confirmed.action !== "reuse_existing") {
    fail(`${tag} was not confirmed byte-for-byte on origin after publication`);
  }
}

function githubReleaseExists(tag) {
  const raw = tryRun("gh", ["release", "view", tag, `--repo=${REPO}`, "--json=tagName"]);
  if (raw === undefined) return false;
  try {
    return JSON.parse(raw).tagName === tag;
  } catch {
    fail(`gh returned malformed release metadata for ${tag}`);
  }
}

function phasePublish() {
  const version = requireVersion();
  const sha = requireSha();
  const tag = tagFor(version);
  requireCleanWorktree();
  run("git", ["fetch", "origin", "main", "dev"]);

  // Everything that can be checked is checked BEFORE the first write. The worktree may be the
  // release branch or main, but its complete tree must be the squash commit's exact tree so the
  // evidence read below comes from what is about to be tagged.
  if (tryRun("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) === undefined) {
    fail(`${sha} is not a commit this checkout can resolve — fetch it, or check the SHA`);
  }
  const targetValidation = validatePublishTarget({
    version,
    sha,
    originMainSha: run("git", ["rev-parse", "origin/main"]).trim(),
    packageVersion: packageVersionAtCommit(sha),
  });
  if (!targetValidation.valid) {
    fail(`publish target is not releasable: ${targetValidation.failures.join(", ")}`);
  }
  const localTree = run("git", ["rev-parse", "HEAD^{tree}"]).trim();
  const releaseTree = run("git", ["rev-parse", `${sha}^{tree}`]).trim();
  if (localTree !== releaseTree) fail("run publish from the exact release tree being tagged");
  requireCommittedGateEvidence(version, sha, "origin/dev");

  const message = tryRun("git", ["log", "-1", "--format=%B", sha]);
  if (message === undefined) fail(`could not read the commit message of ${sha}`);
  const notes = notesFromCommitMessage(message);
  if (notes.title === "") {
    fail(`the commit message of ${sha} has no subject line to title the release with`);
  }

  ensurePublishedTag(tag, version, sha);
  // The step nothing fails without. If tag publication succeeded and GitHub was transiently down,
  // the next invocation reuses the verified tag and resumes here rather than attempting to retag.
  if (!githubReleaseExists(tag)) {
    try {
      run("gh", [
        "release",
        "create",
        tag,
        `--repo=${REPO}`,
        "--verify-tag",
        "--latest",
        `--title=${notes.title}`,
        `--notes=${notes.body}`,
      ]);
    } catch {
      fail(
        `${tag} is safely published, but its GitHub Release could not be created; retry the same ` +
          "publish command",
      );
    }
  }
  phaseCheck();
  console.log(`${tag} tagged, released, and reconciled. Next: repin --sha ${sha}`);
}

function phaseRepin() {
  const version = requireVersion();
  const sha = requireSha();
  const tag = tagFor(version);
  requireCleanWorktree();
  const remote = remoteTagIdentity(tag);
  const plan = planReleaseTag({ sha, localTagObject: localTagObject(tag), ...remote });
  if (!plan.valid || !["fetch_existing", "reuse_existing"].includes(plan.action)) {
    fail(`${tag} is not the published remote release for ${sha}`);
  }
  if (
    plan.action === "fetch_existing" &&
    tryRun("git", ["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`]) === undefined
  ) {
    fail(`could not fetch the published ${tag} tag from origin`);
  }
  requireSignedReleaseTag(tag, version, sha);
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
  const releases = tryRun("gh", [
    "release",
    "list",
    `--repo=${REPO}`,
    "--limit=200",
    "--json=tagName",
  ]);
  if (releases === undefined) {
    fail("gh could not list this repository's releases — is gh authenticated for it?");
  }
  let released;
  try {
    released = JSON.parse(releases).map((entry) => entry.tagName);
  } catch {
    fail("gh returned something that is not a release list — refusing to guess what it meant");
  }
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
  attest: phaseAttest,
  release: phaseRelease,
  publish: phasePublish,
  repin: phaseRepin,
  check: phaseCheck,
};

const phase = PHASES[process.argv[2] ?? ""];
if (phase === undefined) {
  console.error(
    "usage: node scripts/release.mjs prep|attest|release|publish|repin|check " +
      "[--version X.Y.Z] [--sha <40-hex>]",
  );
  process.exit(2);
}
phase();
