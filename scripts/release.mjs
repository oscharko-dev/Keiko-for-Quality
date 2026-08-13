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
import { fileURLToPath, pathToFileURL } from "node:url";

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
  releaseChannelDispositionMessage,
  sortVersionTags,
  tagFor,
  validateCommittedEvidenceDelta,
  validateGateEvidence,
  validatePublishTarget,
  validatePrepEvidenceChanges,
  validateQualityEvidence,
  validateRecoveryQualityEvidence,
  validateReleaseChannel,
  validateReleaseChannelBinding,
  releaseChannelMessage,
  validateRepinTarget,
} from "./release-lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = "oscharko-dev/Keiko-for-Quality";
let releaseArguments = process.argv.slice(3);

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
  const index = releaseArguments.indexOf(name);
  return index === -1 ? undefined : releaseArguments[index + 1];
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

/**
 * Standard remains the default and keeps every quality floor. Recovery is deliberately opt-in and
 * carries the one closed historical reason it is allowed to withhold rather than misrepresent.
 */
function requireReleaseChannel() {
  const channel = argValue("--channel") ?? "standard";
  const recoveryReason = argValue("--recovery-reason");
  const validation = validateReleaseChannel({ channel, recoveryReason });
  if (!validation.valid) fail(`release channel is invalid: ${validation.failures.join(", ")}`);
  return { channel, recoveryReason };
}

/** A copy/pasteable shell argument whose exact value cannot be reparsed as syntax. */
const SHELL_SINGLE_QUOTE_ESCAPE = String.raw`'\''`;

function quoteReleaseArgument(value) {
  return `'${value.replaceAll("'", SHELL_SINGLE_QUOTE_ESCAPE)}'`;
}

const FORMATTED_RELEASE_PHASES = new Set(["attest", "release", "publish", "repin"]);
const SHA_RELEASE_PHASES = new Set(["publish", "repin"]);

function requireFormattableReleaseCommand({ phase, version, sha, releaseChannel }) {
  if (!FORMATTED_RELEASE_PHASES.has(phase)) {
    throw new Error("cannot format unsupported release phase");
  }
  if (parseVersion(version) === undefined) throw new Error("cannot format invalid release version");
  const requiresSha = SHA_RELEASE_PHASES.has(phase);
  if (requiresSha !== (typeof sha === "string")) {
    throw new TypeError("cannot format release command with phase-inappropriate SHA");
  }
  if (requiresSha && !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("cannot format invalid release SHA");
  }
  const validation = validateReleaseChannel(releaseChannel);
  if (!validation.valid) {
    throw new Error(`cannot format invalid release channel: ${validation.failures.join(", ")}`);
  }
}

function formattedChannelArguments(releaseChannel) {
  if (releaseChannel.channel !== "recovery") return [];
  return [
    "--channel",
    quoteReleaseArgument(releaseChannel.channel),
    "--recovery-reason",
    quoteReleaseArgument(releaseChannel.recoveryReason),
  ];
}

/**
 * One formatter owns every operator hand-off in the release chain. Recovery is never implicit:
 * both closed flags travel together to every following phase, while standard keeps the historical
 * command shape without redundant channel flags.
 */
export function formatReleaseCommand({ phase, version, sha, releaseChannel }) {
  requireFormattableReleaseCommand({ phase, version, sha, releaseChannel });
  const arguments_ = ["npm", "run", "release", "--", phase];
  arguments_.push("--version", quoteReleaseArgument(version));
  if (sha !== undefined) arguments_.push("--sha", quoteReleaseArgument(sha));
  arguments_.push(...formattedChannelArguments(releaseChannel));
  return arguments_.join(" ");
}

/** `prep` cannot choose a channel before the measurements have produced their verdict. */
export function formatPostPrepInstruction(version) {
  if (parseVersion(version) === undefined) throw new Error("cannot format invalid release version");
  return (
    `After all four measurements for v${version}, use their gate result to select standard or ` +
    "recovery. Invoke attestation only with that channel's complete required arguments."
  );
}

/** The main squash SHA does not exist until the release PR merges, so this stays non-executable. */
export function formatPendingPublishInstruction({ version, releaseChannel }) {
  requireFormattableReleaseCommand({
    phase: "release",
    version,
    sha: undefined,
    releaseChannel,
  });
  const channelArguments = formattedChannelArguments(releaseChannel);
  const channelClause =
    channelArguments.length === 0
      ? "the standard channel (no channel flags)"
      : `these channel arguments: ${channelArguments.join(" ")}`;
  return (
    `After the PR merges, invoke publish for v${version} with its full 40-character main squash ` +
    `SHA and ${channelClause}.`
  );
}

/** Exact bytes GitHub must use for the governed squash commit. */
export function releasePullRequestPlan({ version, number, commit, tree, releaseChannel }) {
  if (parseVersion(version) === undefined)
    throw new Error("cannot plan an invalid release version");
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("cannot plan an invalid release pull-request number");
  }
  const validation = validateReleaseChannel(releaseChannel);
  if (!validation.valid) throw new Error("cannot plan an invalid release channel");
  const title = `release: v${version}`;
  const body = [
    releaseDevBindingMessage({ commit, tree }),
    releaseChannelDispositionMessage(releaseChannel),
    releaseChannelMessage(releaseChannel),
  ].join("\n\n");
  return { title, body, mergeHeadline: `${title} (#${String(number)})` };
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

function requireQualityEvidence(reports, expectedHead, releaseChannel) {
  const expected = {
    version: packageVersion(),
    head: expectedHead,
    tree: run("git", ["rev-parse", `${expectedHead}^{tree}`]).trim(),
  };
  const qualification = readJsonEvidence(reports.qualificationPath, "qualification");
  const historical = readJsonEvidence(reports.historicalReplayPath, "historical replay");
  const validation =
    releaseChannel.channel === "recovery"
      ? validateRecoveryQualityEvidence(
          qualification,
          historical,
          expected,
          releaseChannel.recoveryReason,
        )
      : validateQualityEvidence(qualification, historical, expected);
  if (!validation.valid) {
    fail(`quality evidence is not releasable: ${validation.failures.join(", ")}`);
  }
  try {
    run("node", [join(ROOT, "scripts", "check-qualification.mjs"), reports.qualificationPath], {
      inherit: true,
    });
  } catch {
    fail("qualification safety-net thresholds are not green");
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
      `the four public reports uncommitted. ${formatPostPrepInstruction(version)}`,
  );
}

function phaseAttest() {
  const version = requireVersion();
  const releaseChannel = requireReleaseChannel();
  const candidateHead = run("git", ["rev-parse", "HEAD"]).trim();
  const reports = requireGateEvidence(version, candidateHead);
  requireQualityEvidence(reports, candidateHead, releaseChannel);
  requireOnlyReleaseEvidenceChanges(version);
  verifyOrDie();
  run("git", ["add", "-A"]);
  run("git", [
    "commit",
    "-S",
    "-m",
    `release: v${version} evidence — ${releaseChannel.channel} gates bind ${candidateHead.slice(0, 12)}`,
    "-m",
    releaseChannelDispositionMessage(releaseChannel),
    "-m",
    releaseChannelMessage(releaseChannel),
  ]);
  const nextCommand = formatReleaseCommand({ phase: "release", version, releaseChannel });
  console.log(
    `evidence committed for v${version}. Land this evidence-only PR on dev, then run: ${nextCommand}`,
  );
}

function requireCommittedGateEvidence(
  version,
  targetRef,
  releaseChannel,
  candidateAncestorRef = targetRef,
) {
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
  requireQualityEvidence(reports, candidate, releaseChannel);
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
  const evidencePaths = deltaValidation.expected;
  const commits = run("git", [
    "log",
    "--format=%H",
    "--reverse",
    `${candidate}..${targetRef}`,
    "--",
    ...evidencePaths,
  ])
    .split("\n")
    .filter((commit) => commit !== "");
  if (commits.length !== 1) {
    fail("release evidence must be introduced by exactly one attest commit");
  }
  const evidenceMessage = tryRun("git", ["log", "-1", "--format=%B", commits[0]]);
  if (evidenceMessage === undefined) fail("could not read the signed attest commit message");
  const evidenceBinding = validateReleaseChannelBinding(evidenceMessage, releaseChannel);
  if (!evidenceBinding.valid) {
    fail(
      `attest commit channel does not bind this release: ${evidenceBinding.failures.join(", ")}`,
    );
  }
}

function releaseMessages({ devCommit, devTree, releaseChannel }) {
  return [
    releaseDevBindingMessage({ commit: devCommit, tree: devTree }),
    releaseChannelDispositionMessage(releaseChannel),
    releaseChannelMessage(releaseChannel),
  ];
}

function prepareReleaseBranch({ version, branch, devCommit, devTree, releaseChannel }) {
  const existing = tryRun("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  const messages = releaseMessages({ devCommit, devTree, releaseChannel });
  if (existing === undefined) {
    run("git", ["checkout", "-b", branch, "origin/main"]);
    run("git", ["rm", "-rq", "."]);
    run("git", ["checkout", "origin/dev", "--", "."]);
    run("git", ["add", "-A"]);
    run("git", [
      "commit",
      "-S",
      "-m",
      `release: v${version}`,
      "-m",
      messages[0],
      "-m",
      messages[1],
      "-m",
      messages[2],
    ]);
  } else {
    run("git", ["checkout", branch]);
  }
  const expectedMessage = `release: v${version}\n\n${messages.join("\n\n")}`;
  const actualMessage = run("git", ["log", "-1", "--format=%B"]).trimEnd();
  const parent = run("git", ["rev-parse", "HEAD^1"]).trim();
  const main = run("git", ["rev-parse", "origin/main^{commit}"]).trim();
  if (actualMessage !== expectedMessage || parent !== main) {
    fail("existing release branch does not exactly match this release plan");
  }
  if (tryRun("git", ["verify-commit", "HEAD"]) === undefined) {
    fail("release commit is not signed and verifiable");
  }
  const tree = run("git", ["rev-parse", "HEAD^{tree}"]).trim();
  if (tree !== devTree) fail(`release tree ${tree} does not match dev's ${devTree}`);
  return { messages, releaseCommit: run("git", ["rev-parse", "HEAD^{commit}"]).trim() };
}

function readReleasePullRequest(branch) {
  const output = tryRun("gh", [
    "pr",
    "view",
    branch,
    "--repo",
    REPO,
    "--json",
    "number,url,state,baseRefName,headRefName,headRefOid,title,autoMergeRequest",
  ]);
  if (output === undefined) return undefined;
  try {
    return JSON.parse(output);
  } catch {
    fail("GitHub returned an invalid release pull-request record");
  }
}

function requireReleasePullRequest(record, { version, branch, releaseCommit }) {
  if (
    record === undefined ||
    record.state !== "OPEN" ||
    record.baseRefName !== "main" ||
    record.headRefName !== branch ||
    record.headRefOid !== releaseCommit ||
    record.title !== `release: v${version}` ||
    !Number.isSafeInteger(record.number) ||
    typeof record.url !== "string"
  ) {
    fail("existing release pull request does not exactly match this release plan");
  }
  return record;
}

function ensureReleasePullRequest({ version, branch, messages, releaseCommit }) {
  let record = readReleasePullRequest(branch);
  if (record === undefined) {
    run("gh", [
      "pr",
      "create",
      "--repo",
      REPO,
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      `release: v${version}`,
      "--body",
      messages.join("\n\n"),
    ]);
    record = readReleasePullRequest(branch);
  }
  return requireReleasePullRequest(record, { version, branch, releaseCommit });
}

function autoMergeMatches(record, plan) {
  return (
    record.autoMergeRequest?.mergeMethod === "SQUASH" &&
    record.autoMergeRequest.commitHeadline === plan.mergeHeadline &&
    record.autoMergeRequest.commitBody === plan.body
  );
}

export function releaseAutoMergeAction(record, plan) {
  if (autoMergeMatches(record, plan)) return "ready";
  return record.autoMergeRequest == null ? "enable" : "replace";
}

function armExactReleaseAutoMerge({ record, plan, releaseCommit, branch, version }) {
  const action = releaseAutoMergeAction(record, plan);
  if (action === "replace") {
    run("gh", ["pr", "merge", record.url, "--repo", REPO, "--disable-auto"]);
  }
  if (action !== "ready") {
    run("gh", [
      "pr",
      "merge",
      record.url,
      "--repo",
      REPO,
      "--auto",
      "--squash",
      "--match-head-commit",
      releaseCommit,
      "--subject",
      plan.mergeHeadline,
      "--body",
      plan.body,
    ]);
  }
  const armed = requireReleasePullRequest(readReleasePullRequest(branch), {
    version,
    branch,
    releaseCommit,
  });
  if (!autoMergeMatches(armed, plan)) fail("release auto-merge did not retain the exact message");
  return armed.url;
}

function phaseRelease() {
  const version = requireVersion();
  const releaseChannel = requireReleaseChannel();
  requireCleanWorktree();
  run("git", ["fetch", "origin", "main", "dev"]);
  const localTree = run("git", ["rev-parse", "HEAD^{tree}"]).trim();
  const devCommit = run("git", ["rev-parse", "origin/dev^{commit}"]).trim();
  const devTree = run("git", ["rev-parse", "origin/dev^{tree}"]).trim();
  if (localTree !== devTree) fail("run release from the exact current origin/dev tree");
  requireCommittedGateEvidence(version, "origin/dev", releaseChannel);
  const branch = `release/v${version}`;
  const { messages, releaseCommit } = prepareReleaseBranch({
    version,
    branch,
    devCommit,
    devTree,
    releaseChannel,
  });
  run("git", ["push", "-u", "origin", branch]);
  const pullRequest = ensureReleasePullRequest({ version, branch, messages, releaseCommit });
  const pullRequestPlan = releasePullRequestPlan({
    version,
    number: pullRequest.number,
    commit: devCommit,
    tree: devTree,
    releaseChannel,
  });
  const pullRequestUrl = armExactReleaseAutoMerge({
    record: pullRequest,
    plan: pullRequestPlan,
    releaseCommit,
    branch,
    version,
  });
  const nextInstruction = formatPendingPublishInstruction({ version, releaseChannel });
  console.log(
    `${pullRequestUrl} opened with exact squash auto-merge, tree identical to dev. ${nextInstruction}`,
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
  const releaseChannel = requireReleaseChannel();
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
  requireCommittedGateEvidence(version, sha, releaseChannel, "origin/dev");

  const message = tryRun("git", ["log", "-1", "--format=%B", sha]);
  if (message === undefined) fail(`could not read the commit message of ${sha}`);
  const channelBinding = validateReleaseChannelBinding(message, releaseChannel);
  if (!channelBinding.valid) {
    fail(
      `release commit channel does not bind this publish request: ${channelBinding.failures.join(", ")}`,
    );
  }
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
  const nextCommand = formatReleaseCommand({
    phase: "repin",
    version,
    sha,
    releaseChannel,
  });
  console.log(`${tag} tagged, released, and reconciled. Next: ${nextCommand}`);
}

function phaseRepin() {
  const version = requireVersion();
  const sha = requireSha();
  const releaseChannel = requireReleaseChannel();
  const tag = tagFor(version);
  requireCleanWorktree();
  run("git", ["fetch", "origin", "main"]);
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
  const mainValidation = validatePublishTarget({
    version,
    sha,
    originMainSha: run("git", ["rev-parse", "origin/main"]).trim(),
    packageVersion: packageVersionAtCommit(sha),
  });
  if (!mainValidation.valid) {
    fail(`repin target is not the released main commit: ${mainValidation.failures.join(", ")}`);
  }
  const message = tryRun("git", ["log", "-1", "--format=%B", sha]);
  if (message === undefined) fail(`could not read the release commit message for ${sha}`);
  const channelBinding = validateReleaseChannelBinding(message, releaseChannel);
  if (!channelBinding.valid) {
    fail(`release commit channel does not bind this repin: ${channelBinding.failures.join(", ")}`);
  }
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

const PHASE_FLAGS = {
  prep: new Set(["--version"]),
  attest: new Set(["--version", "--channel", "--recovery-reason"]),
  release: new Set(["--version", "--channel", "--recovery-reason"]),
  publish: new Set(["--version", "--sha", "--channel", "--recovery-reason"]),
  repin: new Set(["--version", "--sha", "--channel", "--recovery-reason"]),
  check: new Set(),
};
const REQUIRED_PHASE_FLAGS = {
  prep: ["--version"],
  attest: ["--version"],
  release: ["--version"],
  publish: ["--version", "--sha"],
  repin: ["--version", "--sha"],
  check: [],
};

/**
 * Release commands are a security boundary, not a convenience CLI.  A typo must not silently
 * select the standard channel, and a flag meaningful in one phase must not leak into another.
 */
function invalidReleaseCli(failure) {
  return { valid: false, failures: [failure] };
}

function releasePhase(argv) {
  const phase = argv[0];
  return typeof phase === "string" && Object.hasOwn(PHASES, phase) ? phase : undefined;
}

function parsePhaseValues(phase, arguments_) {
  if (arguments_.length % 2 !== 0) return invalidReleaseCli("release_argument_missing");
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (typeof flag !== "string" || !PHASE_FLAGS[phase].has(flag)) {
      return invalidReleaseCli("release_flag_unknown_or_phase_forbidden");
    }
    if (values.has(flag)) return invalidReleaseCli("release_flag_duplicate");
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      return invalidReleaseCli("release_argument_missing");
    }
    values.set(flag, value);
  }
  return { valid: true, failures: [], values };
}

function validatePhaseValues(phase, values) {
  for (const flag of REQUIRED_PHASE_FLAGS[phase]) {
    if (!values.has(flag)) return invalidReleaseCli("release_required_flag_missing");
  }
  if (values.has("--version") && parseVersion(values.get("--version")) === undefined) {
    return invalidReleaseCli("release_version_invalid");
  }
  if (values.has("--sha") && !/^[0-9a-f]{40}$/u.test(values.get("--sha"))) {
    return invalidReleaseCli("release_sha_invalid");
  }
  const channel = values.get("--channel") ?? "standard";
  const recoveryReason = values.get("--recovery-reason");
  const channelValidation = validateReleaseChannel({ channel, recoveryReason });
  return channelValidation.valid
    ? { valid: true, failures: [] }
    : { valid: false, failures: channelValidation.failures };
}

export function parseReleaseCli(argv) {
  const phase = releasePhase(argv);
  if (phase === undefined) return invalidReleaseCli("release_phase_invalid");
  const arguments_ = argv.slice(1);
  const parsed = parsePhaseValues(phase, arguments_);
  if (!parsed.valid || parsed.values === undefined) return parsed;
  const validation = validatePhaseValues(phase, parsed.values);
  if (!validation.valid) return validation;
  return { valid: true, failures: [], phase, arguments_ };
}

function releaseUsage() {
  return (
    "usage: node scripts/release.mjs prep|attest|release|publish|repin|check " +
    "[--version X.Y.Z] [--sha <40-hex>] " +
    "[--channel standard|recovery] [--recovery-reason historical_holdout_fixed_retention_low]"
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const parsed = parseReleaseCli(process.argv.slice(2));
  if (!parsed.valid || parsed.phase === undefined) {
    console.error(`release: invalid command: ${parsed.failures.join(", ")}`);
    console.error(releaseUsage());
    process.exit(2);
  }
  releaseArguments = parsed.arguments_;
  PHASES[parsed.phase]();
}
