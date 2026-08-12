// The release procedure's pure half: everything the driver decides, decided here where a test
// can reach it.
//
// Why this file exists at all. The release steps lived in one person's memory, and the step that
// nothing fails without — creating the GitHub Release for a pushed tag — was skipped three times
// in a row (v0.21.0, v0.21.1, v0.21.2) before anyone noticed the repository's front page still
// advertising v0.20.1. Consumers were never at risk, because they pin SHAs and every pin was
// correct; what went stale was the thing a human reads to decide WHAT to pin. A checklist would
// have had the same failure mode as the memory it replaced. A script that refuses to continue
// does not.
//
// So the rule this file encodes is: every step that can be checked is checked, and a check that
// fails stops the release rather than printing a warning nobody reads.

import { validateHistoricalReplayEvidence } from "../corpus/historical-replay-evidence-lib.mjs";
import { validateQualificationEvidence } from "./qualification-evidence-lib.mjs";

/** `X.Y.Z`, the only shape this project's tags have ever had. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/u;
const RELEASE_DEV_COMMIT_TRAILER = "Keiko-Release-Dev-Commit";
const RELEASE_DEV_TREE_TRAILER = "Keiko-Release-Dev-Tree";
const RELEASE_CHANNEL_TRAILER = "Keiko-Release-Channel";
const RECOVERY_QUALITY_REASON_TRAILER = "Keiko-Recovery-Quality-Reason";

/**
 * A recovery release is deliberately narrower than a normal quality promotion.  It exists to
 * ship an availability fix when all serving safety evidence is green while a known historical
 * quality floor remains red.  Adding a new exception is a product decision, not an operator flag:
 * unknown reasons therefore fail closed here.
 */
export const RECOVERY_QUALITY_REASONS = Object.freeze(["historical_holdout_fixed_retention_low"]);

export function validateReleaseChannel({ channel, recoveryReason }) {
  const failures = [];
  if (channel === "standard") {
    if (recoveryReason !== undefined) failures.push("standard_release_has_recovery_reason");
  } else if (channel === "recovery") {
    if (!RECOVERY_QUALITY_REASONS.includes(recoveryReason)) {
      failures.push("recovery_quality_reason_unrecognized");
    }
  } else {
    failures.push("release_channel_invalid");
  }
  return { valid: failures.length === 0, failures };
}

export function parseVersion(raw) {
  if (typeof raw !== "string" || !VERSION.test(raw)) return undefined;
  return raw;
}

export function tagFor(version) {
  return `v${version}`;
}

function exactTrailerValues(message, name) {
  if (typeof message !== "string") return [];
  const prefix = `${name}: `;
  return message
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/**
 * The immutable dev revision whose tree a release branch copied.
 *
 * The binding rides in the signed release-branch commit and, with the repository's configured
 * squash-message policy, into the main squash. The main-push verifier never trusts the text by
 * itself: it resolves the named commit from dev history and recomputes both trees.
 */
export function parseReleaseDevBinding(message) {
  const commitValues = exactTrailerValues(message, RELEASE_DEV_COMMIT_TRAILER);
  const treeValues = exactTrailerValues(message, RELEASE_DEV_TREE_TRAILER);
  const failures = [];
  if (commitValues.length !== 1 || !GIT_OBJECT_ID.test(commitValues[0] ?? "")) {
    failures.push("release_dev_commit_binding_invalid");
  }
  if (treeValues.length !== 1 || !GIT_OBJECT_ID.test(treeValues[0] ?? "")) {
    failures.push("release_dev_tree_binding_invalid");
  }
  return {
    valid: failures.length === 0,
    failures,
    binding: failures.length === 0 ? { commit: commitValues[0], tree: treeValues[0] } : undefined,
  };
}

/** Emits only the strict, round-trippable trailer shape the main-push verifier accepts. */
export function releaseDevBindingMessage(binding) {
  const message =
    `${RELEASE_DEV_COMMIT_TRAILER}: ${String(binding?.commit ?? "")}\n` +
    `${RELEASE_DEV_TREE_TRAILER}: ${String(binding?.tree ?? "")}`;
  const parsed = parseReleaseDevBinding(message);
  if (!parsed.valid) throw new TypeError("release dev binding requires full lowercase Git ids");
  return message;
}

/** The signed release commit records whether it is a normal promotion or a narrow recovery. */
export function releaseChannelMessage({ channel, recoveryReason }) {
  const validation = validateReleaseChannel({ channel, recoveryReason });
  if (!validation.valid) throw new TypeError("release channel is invalid");
  const reason =
    channel === "recovery" ? `\n${RECOVERY_QUALITY_REASON_TRAILER}: ${recoveryReason}` : "";
  return `${RELEASE_CHANNEL_TRAILER}: ${channel}${reason}`;
}

/** Human-visible release text mirrors the closed trailer without turning recovery into promotion. */
export function releaseChannelDispositionMessage({ channel, recoveryReason }) {
  const validation = validateReleaseChannel({ channel, recoveryReason });
  if (!validation.valid) throw new TypeError("release channel is invalid");
  return channel === "recovery"
    ? `Quality promotion withheld: ${recoveryReason}`
    : "Quality promotion: green";
}

export function parseReleaseChannelMessage(message) {
  const channel = exactTrailerValues(message, RELEASE_CHANNEL_TRAILER);
  const reason = exactTrailerValues(message, RECOVERY_QUALITY_REASON_TRAILER);
  if (channel.length !== 1 || reason.length > 1) {
    return { valid: false, failures: ["release_channel_binding_invalid"] };
  }
  const recoveryReason = reason.length === 1 ? reason[0] : undefined;
  const validation = validateReleaseChannel({ channel: channel[0], recoveryReason });
  return validation.valid
    ? { valid: true, failures: [], channel: channel[0], recoveryReason }
    : { valid: false, failures: validation.failures };
}

/** The CLI may not relabel an already-merged release commit after its evidence was reviewed. */
export function validateReleaseChannelBinding(message, expected) {
  const parsed = parseReleaseChannelMessage(message);
  if (!parsed.valid) return { valid: false, failures: parsed.failures };
  const failures = [];
  if (parsed.channel !== expected.channel) failures.push("release_channel_binding_mismatch");
  if (parsed.recoveryReason !== expected.recoveryReason) {
    failures.push("recovery_quality_reason_binding_mismatch");
  }
  return { valid: failures.length === 0, failures };
}

/**
 * The README quickstart's pin comment, rewritten.
 *
 * The comment is the one place a reader learns which version the SHA above it belongs to, and it
 * is the easiest line in the repository to leave behind — it carries no code and breaks no test.
 * Returns the new text and how many comments changed, so the driver can refuse a release whose
 * README it did not actually touch.
 */
export function bumpQuickstartPin(readme, version) {
  const pattern = /(uses: oscharko-dev\/Keiko-for-Quality@\S+ # v)\d+\.\d+\.\d+/gu;
  let changed = 0;
  const text = readme.replace(pattern, (_match, prefix) => {
    changed += 1;
    return `${prefix}${version}`;
  });
  return { text, changed };
}

/**
 * The evidence this release must already carry, found among the file names in
 * `corpus/evidence/`.
 *
 * The gates are paid, slow, and run against a consumer, so this library never runs them — it
 * refuses to release without their recorded reports. A release whose evidence is missing is a
 * release whose gates either never ran or were not written down, and the two are
 * indistinguishable afterwards, which is the whole reason the evidence exists.
 */
export function findGateEvidence(fileNames, version) {
  const seedMatches = fileNames.filter(
    (name) => name.startsWith("seed-gate-") && name.endsWith(`-v${version}.md`),
  );
  const completionMatches = fileNames.filter(
    (name) => name.startsWith("completion-") && name.endsWith(`-v${version}.md`),
  );
  const qualificationMatches = fileNames.filter(
    (name) => name.startsWith("qualification-") && name.endsWith(`-v${version}.json`),
  );
  const historicalReplayMatches = fileNames.filter(
    (name) => name.startsWith("historical-replay-") && name.endsWith(`-v${version}.json`),
  );
  const matches = {
    seed: seedMatches,
    completion: completionMatches,
    qualification: qualificationMatches,
    historicalReplay: historicalReplayMatches,
  };
  const ambiguous = Object.entries(matches)
    .filter(([, names]) => names.length > 1)
    .map(([kind, names]) => `${kind}: ${names.join(", ")}`);
  const exactlyOne = (names) => (names.length === 1 ? names[0] : undefined);
  const seed = exactlyOne(seedMatches);
  const completion = exactlyOne(completionMatches);
  const qualification = exactlyOne(qualificationMatches);
  const historicalReplay = exactlyOne(historicalReplayMatches);
  return {
    seed,
    completion,
    qualification,
    historicalReplay,
    ambiguous,
    complete:
      ambiguous.length === 0 &&
      seed !== undefined &&
      completion !== undefined &&
      qualification !== undefined &&
      historicalReplay !== undefined,
  };
}

const CLEAN_REVIEWER_TREE = /^- Reviewer tree: ([0-9a-f]{12,40}) \(clean\)$/mu;
const REVIEWER_VERSION = /^- Reviewer under test: keiko-for-quality (\d+\.\d+\.\d+)$/mu;
const PINNED_MODEL = /^- Model: gpt-oss-120b \(openai\)$/mu;
const GREEN_SEED = /^- Verdict: GREEN \(required failures: none\)$/mu;
const GREEN_COMPLETION =
  /^- \*\*Completion rate: (\d+(?:\.\d+)?)%\*\* \(([1-9]\d*)\/([1-9]\d*) graded attempts, threshold (\d+(?:\.\d+)?)%\) — GREEN$/mu;
const MINIMUM_COMPLETION_GRADED_ATTEMPTS = 3;
const MINIMUM_COMPLETION_THRESHOLD_PERCENT = 80;

function completionEvidence(report) {
  const match = GREEN_COMPLETION.exec(report);
  if (match === null) return undefined;
  const [, reportedRateRaw, completeRaw, gradedRaw, thresholdRaw] = match;
  const reportedRate = Number(reportedRateRaw);
  const complete = Number(completeRaw);
  const graded = Number(gradedRaw);
  const threshold = Number(thresholdRaw);
  if (
    !Number.isFinite(reportedRate) ||
    !Number.isSafeInteger(complete) ||
    !Number.isSafeInteger(graded) ||
    !Number.isFinite(threshold)
  ) {
    return undefined;
  }
  return { reportedRate, complete, graded, threshold };
}

/** Commit/version binding rendered by both paid gate harnesses. */
export function gateEvidenceIdentity(report) {
  return {
    reviewer: CLEAN_REVIEWER_TREE.exec(report)?.[1],
    version: REVIEWER_VERSION.exec(report)?.[1],
  };
}

function completionRateIsConsistent(completion) {
  const computedRate = Number(((completion.complete / completion.graded) * 100).toFixed(1));
  return (
    completion.complete <= completion.graded &&
    completion.reportedRate >= 0 &&
    completion.reportedRate <= 100 &&
    completion.reportedRate === computedRate
  );
}

function validateCompletionEvidence(report, failures) {
  const completion = completionEvidence(report);
  if (completion === undefined) {
    failures.push("completion_not_green");
    return;
  }
  if (!completionRateIsConsistent(completion)) failures.push("completion_rate_inconsistent");
  if (completion.graded < MINIMUM_COMPLETION_GRADED_ATTEMPTS) {
    failures.push("completion_sample_too_small");
  }
  if (completion.threshold < MINIMUM_COMPLETION_THRESHOLD_PERCENT || completion.threshold > 100) {
    failures.push("completion_threshold_too_low");
  }
  if (completion.reportedRate < completion.threshold) failures.push("completion_below_threshold");
}

function validateGateReportHeaders(seedReport, completionReport, identities, failures) {
  if (identities.seed.reviewer === undefined) failures.push("seed_reviewer_not_clean");
  if (!PINNED_MODEL.test(seedReport)) failures.push("seed_model_mismatch");
  if (!GREEN_SEED.test(seedReport)) failures.push("seed_not_green");
  if (identities.completion.reviewer === undefined) {
    failures.push("completion_reviewer_not_clean");
  }
  if (!PINNED_MODEL.test(completionReport)) failures.push("completion_model_mismatch");
  validateCompletionEvidence(completionReport, failures);
}

function validateGateReportBindings(identities, expected, failures) {
  const seedTree = identities.seed.reviewer;
  const completionTree = identities.completion.reviewer;
  if (identities.seed.version !== expected.version) failures.push("seed_version_mismatch");
  if (identities.completion.version !== expected.version) {
    failures.push("completion_version_mismatch");
  }
  if (seedTree !== undefined && !expected.head.startsWith(seedTree)) {
    failures.push("seed_reviewer_mismatch");
  }
  if (completionTree !== undefined && !expected.head.startsWith(completionTree)) {
    failures.push("completion_reviewer_mismatch");
  }
  if (
    seedTree !== undefined &&
    completionTree !== undefined &&
    !seedTree.startsWith(completionTree) &&
    !completionTree.startsWith(seedTree)
  ) {
    failures.push("gate_reviewer_disagreement");
  }
}

function validateGateReportDisqualifiers(seedReport, completionReport, failures) {
  if (/DIRTY|not release evidence/iu.test(seedReport)) failures.push("seed_disqualified");
  if (/DIRTY|not release evidence/iu.test(completionReport)) {
    failures.push("completion_disqualified");
  }
}

/**
 * Validates the facts inside the two release reports, not merely their filenames.
 *
 * A red or dirty report with the right suffix is evidence that the gate did NOT pass. Treating it
 * as the opposite shipped v0.22.0 over a seed report that literally said "DIRTY — not release
 * evidence". The release driver calls this before changing a version or writing a commit.
 */
export function validateGateEvidence(seedReport, completionReport, expected) {
  const failures = [];
  const identities = {
    seed: gateEvidenceIdentity(seedReport),
    completion: gateEvidenceIdentity(completionReport),
  };
  validateGateReportHeaders(seedReport, completionReport, identities, failures);
  validateGateReportBindings(identities, expected, failures);
  validateGateReportDisqualifiers(seedReport, completionReport, failures);
  return { valid: failures.length === 0, failures };
}

/** Facts `publish` must prove before it creates the first local or remote release object. */
export function validatePublishTarget({ version, sha, originMainSha, packageVersion }) {
  const failures = [];
  if (sha !== originMainSha) failures.push("publish_sha_not_origin_main");
  if (packageVersion !== version) failures.push("publish_package_version_mismatch");
  return { valid: failures.length === 0, failures };
}

/** Facts `repin` must prove about the already-published tag before rewriting a consumer pin. */
export function validateRepinTarget({
  version,
  sha,
  packageVersion,
  tagType,
  tagCommit,
  tagSignatureValid,
}) {
  const failures = [];
  if (tagType !== "tag") failures.push("repin_tag_not_annotated");
  if (tagSignatureValid !== true) failures.push("repin_tag_signature_invalid");
  if (tagCommit !== sha) failures.push("repin_tag_sha_mismatch");
  if (packageVersion !== version) failures.push("repin_package_version_mismatch");
  return { valid: failures.length === 0, failures };
}

/** Decides whether `publish` creates, pushes, fetches, or reuses a release tag. */
export function planReleaseTag({ sha, localTagObject, remoteTagObject, remoteTagCommit }) {
  const failures = [];
  if (remoteTagObject !== undefined) {
    if (remoteTagCommit === undefined) failures.push("release_tag_remote_not_annotated");
    else if (remoteTagCommit !== sha) failures.push("release_tag_remote_sha_mismatch");
    if (localTagObject !== undefined && localTagObject !== remoteTagObject) {
      failures.push("release_tag_local_remote_disagreement");
    }
  } else if (remoteTagCommit !== undefined) {
    failures.push("release_tag_remote_shape_invalid");
  }
  if (failures.length > 0) return { valid: false, failures };
  if (remoteTagObject !== undefined) {
    return {
      valid: true,
      failures: [],
      action: localTagObject === undefined ? "fetch_existing" : "reuse_existing",
    };
  }
  return {
    valid: true,
    failures: [],
    action: localTagObject === undefined ? "create_and_push" : "push_existing",
  };
}

export function isVersionedReleaseEvidencePath(path, version) {
  const escaped = version.replaceAll(".", String.raw`\.`);
  return new RegExp(
    String.raw`^corpus/evidence/(?:(?:seed-gate|completion)-[^/]+-v${escaped}\.md|` +
      String.raw`(?:qualification|historical-replay)-[^/]+-v${escaped}\.json)$`,
    "u",
  ).test(path);
}

/** Only new, target-version evidence may be dirty when `attest` commits the public reports. */
export function validatePrepEvidenceChanges(changes, version) {
  const invalid = changes.filter((change) => {
    const status = change.slice(0, 2);
    const path = change.slice(3);
    return status !== "??" || !isVersionedReleaseEvidencePath(path, version);
  });
  const escaped = version.replaceAll(".", String.raw`\.`);
  const kinds = {
    seed: new RegExp(String.raw`^corpus/evidence/seed-gate-[^/]+-v${escaped}\.md$`, "u"),
    completion: new RegExp(String.raw`^corpus/evidence/completion-[^/]+-v${escaped}\.md$`, "u"),
    qualification: new RegExp(
      String.raw`^corpus/evidence/qualification-[^/]+-v${escaped}\.json$`,
      "u",
    ),
    historicalReplay: new RegExp(
      String.raw`^corpus/evidence/historical-replay-[^/]+-v${escaped}\.json$`,
      "u",
    ),
  };
  for (const [kind, pattern] of Object.entries(kinds)) {
    const count = changes.filter(
      (change) => change.startsWith("?? ") && pattern.test(change.slice(3)),
    ).length;
    if (count !== 1) invalid.push(`${kind}:${String(count)}`);
  }
  return { valid: changes.length === 4 && invalid.length === 0, invalid };
}

/** The committed delta from the measured RC must be the same four files selected for release. */
export function validateCommittedEvidenceDelta(paths, selectedFileNames, version) {
  const expected = selectedFileNames
    .map((name) => `corpus/evidence/${name}`)
    .sort((left, right) => left.localeCompare(right, "en"));
  const actual = [...paths].sort((left, right) => left.localeCompare(right, "en"));
  const valid =
    expected.length === 4 &&
    new Set(expected).size === 4 &&
    expected.every((path) => isVersionedReleaseEvidencePath(path, version)) &&
    actual.length === expected.length &&
    actual.every((path, index) => path === expected[index]);
  return { valid, expected, actual };
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function metric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function replayMetrics(report, cohort, phase) {
  const score = record(record(report).score);
  const selected =
    cohort === "all"
      ? record(record(score.all)[phase])
      : record(record(record(score.chronological).holdout)[phase]);
  return record(selected.metrics);
}

// The calibrated all-history cohort contains seventeen fixed-confirmed findings. At this floor,
// retaining thirteen (76.5%) is green and retaining twelve (70.6%) is red. The former 80% floor
// admitted only fourteen of seventeen (82.4%) because no observation lands exactly on 80%.
const MINIMUM_HISTORICAL_FIXED_RETENTION = 0.75;

function validateQualificationQualityEvidence(qualificationRoot, expected, failures) {
  const schema = validateQualificationEvidence(qualificationRoot);
  if (!schema.valid) failures.push("qualification_schema_mismatch");
  if (!schema.complete) failures.push("qualification_case_coverage_mismatch");
  const binding = record(qualificationRoot.binding);
  const adapter = record(binding.adapter);
  const model = record(binding.model);
  if (qualificationRoot.measured !== true) failures.push("qualification_not_measured");
  if (adapter.version !== expected.version) failures.push("qualification_version_mismatch");
  if (adapter.commit !== expected.head) failures.push("qualification_reviewer_mismatch");
  if (model.id !== "gpt-oss-120b" || model.protocol !== "openai") {
    failures.push("qualification_model_mismatch");
  }
  if (binding.strictness !== "paranoid") {
    failures.push("qualification_strictness_mismatch");
  }
}

function validateHistoricalBinding(historicalRoot, expected, failures) {
  const binding = record(historicalRoot.binding);
  const schema = validateHistoricalReplayEvidence(historicalRoot);
  if (!schema.valid) failures.push("historical_schema_mismatch");
  if (binding.reviewerTree !== expected.tree) failures.push("historical_reviewer_mismatch");
  if (binding.model !== "gpt-oss-120b" || binding.protocol !== "openai") {
    failures.push("historical_model_mismatch");
  }
}

function validateReplayCohort(historicalRoot, cohort, failures) {
  const before = replayMetrics(historicalRoot, cohort, "before");
  const after = replayMetrics(historicalRoot, cohort, "after");
  const beforePrecision = metric(before.precision);
  const afterPrecision = metric(after.precision);
  const retention = metric(after.fixedRetention);
  const coverage = metric(after.decisionCoverage);
  const minimumGain = cohort === "all" ? 0.1 : 0.05;
  if (
    beforePrecision === undefined ||
    afterPrecision === undefined ||
    afterPrecision < beforePrecision + minimumGain
  ) {
    failures.push(`historical_${cohort}_precision_gain_missing`);
  }
  if (retention === undefined || retention < MINIMUM_HISTORICAL_FIXED_RETENTION) {
    failures.push(`historical_${cohort}_fixed_retention_low`);
  }
  if (coverage === undefined || coverage < 0.75) {
    failures.push(`historical_${cohort}_decision_coverage_low`);
  }
}

/** Machine-checkable provenance for the two quality measurements, without a promotion claim. */
export function validateQualityEvidenceBinding(qualification, historicalReplay, expected) {
  const failures = [];
  const qualificationRoot = record(qualification);
  const historicalRoot = record(historicalReplay);
  validateQualificationQualityEvidence(qualificationRoot, expected, failures);
  validateHistoricalBinding(historicalRoot, expected, failures);
  return { valid: failures.length === 0, failures };
}

/** Machine-checkable provenance and normal-promotion floor for the two quality measurements. */
export function validateQualityEvidence(qualification, historicalReplay, expected) {
  const binding = validateQualityEvidenceBinding(qualification, historicalReplay, expected);
  const failures = [...binding.failures];
  const historicalRoot = record(historicalReplay);
  for (const cohort of ["all", "holdout"]) {
    validateReplayCohort(historicalRoot, cohort, failures);
  }
  return { valid: failures.length === 0, failures };
}

/**
 * Recovery never turns a failed quality promotion green. It accepts only a fully valid, exactly
 * bound evidence set whose *only* quality-promotion failure is the explicitly recorded reason.
 */
export function validateRecoveryQualityEvidence(qualification, historicalReplay, expected, reason) {
  const channel = validateReleaseChannel({ channel: "recovery", recoveryReason: reason });
  const binding = validateQualityEvidenceBinding(qualification, historicalReplay, expected);
  const quality = validateQualityEvidence(qualification, historicalReplay, expected);
  const unexpected = quality.failures.filter((failure) => failure !== reason);
  const failures = [...channel.failures, ...binding.failures];
  if (quality.failures.length === 0) failures.push("recovery_quality_reason_not_observed");
  if (quality.failures.length > 0 && !quality.failures.includes(reason)) {
    failures.push("recovery_quality_reason_mismatch");
  }
  if (unexpected.length > 0) failures.push(...unexpected.map((failure) => `recovery_${failure}`));
  return { valid: failures.length === 0, failures, withheldReason: reason };
}

/**
 * Release notes from the release commit's own message: its subject becomes the title, its body
 * the notes.
 *
 * Deliberately not a second, hand-written description. The release commit already argues what the
 * wave does and cites its evidence; writing that twice is how the two drift, and the one on the
 * public page is the copy nobody re-reads.
 */
export function notesFromCommitMessage(message) {
  const [subject, ...rest] = message.split("\n");
  const body = rest.join("\n").trim();
  return { title: subject?.trim() ?? "", body };
}

/**
 * Tags that have no GitHub Release, and Releases that have no tag — with the newest missing tag
 * called out separately, because only that one is a live defect.
 *
 * The severity split is the difference between a check people run and a check people mute. This
 * repository carries historical tags from before Releases were the practice (v0.3.0 through
 * v0.9.0, and a v0.18–v0.19 stretch), and a gate that goes red on those every single time teaches
 * everyone to ignore it — the same lesson the precision gate's threshold records. What actually
 * broke, and what breaks a reader, is the NEWEST tag having no Release: then the front page names
 * an older version than the one consumers should pin. `releasesWithoutTag` is the mirror image —
 * a Release pointing at a tag nobody can check out.
 */
export function reconcileTagsAndReleases(tags, releases) {
  const released = new Set(releases);
  const tagged = new Set(tags);
  const ordered = sortVersionTags(tags);
  const newest = ordered[ordered.length - 1];
  const tagsWithoutRelease = ordered.filter((tag) => !released.has(tag));
  return {
    tagsWithoutRelease,
    releasesWithoutTag: releases.filter((release) => !tagged.has(release)),
    newest,
    newestUnreleased: newest !== undefined && !released.has(newest) ? newest : undefined,
  };
}

/** Version tags only, newest last, so a caller can reason about "the current one". */
export function sortVersionTags(tags) {
  return tags
    .filter((tag) => VERSION.test(tag.replace(/^v/u, "")))
    .sort((a, b) => {
      const left = a.replace(/^v/u, "").split(".").map(Number);
      const right = b.replace(/^v/u, "").split(".").map(Number);
      for (let i = 0; i < 3; i += 1) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
}

/**
 * The consumer workflow's two pin sites, rewritten together.
 *
 * `uses:` and `ACTION_PIN` are one fact written twice, and the consumer's own workflow fails the
 * run when they disagree. Returns the count of each so the driver can refuse a rewrite that
 * touched one and not the other — the failure that check exists to catch, caught one step earlier.
 */
export function bumpConsumerPin(workflow, sha, version) {
  let uses = 0;
  let actionPin = 0;
  let text = workflow.replace(
    /(uses: oscharko-dev\/Keiko-for-Quality@)[0-9a-f]{40}( # v)\d+\.\d+\.\d+/gu,
    (_m, a, b) => {
      uses += 1;
      return `${a}${sha}${b}${version}`;
    },
  );
  text = text.replace(/(ACTION_PIN: ")[0-9a-f]{40}(" # v)\d+\.\d+\.\d+/gu, (_m, a, b) => {
    actionPin += 1;
    return `${a}${sha}${b}${version}`;
  });
  return { text, uses, actionPin };
}
