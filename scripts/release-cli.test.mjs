import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  formatPendingPublishInstruction,
  formatPostPrepInstruction,
  formatReleaseCommand,
  parseReleaseCli,
  releaseAutoMergeAction,
  releasePullRequestPlan,
} from "./release.mjs";

const SHA = "a".repeat(40);
const RECOVERY_REASON = "historical_holdout_fixed_retention_low";
const releaseSource = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");

test("release CLI admits only each phase's closed flag set", () => {
  assert.deepEqual(parseReleaseCli(["check"]), {
    valid: true,
    failures: [],
    phase: "check",
    arguments_: [],
  });
  assert.equal(parseReleaseCli(["check", "--version", "0.24.0"]).valid, false);
  assert.equal(parseReleaseCli(["prep", "--version", "0.24.0", "--sha", SHA]).valid, false);
  assert.equal(parseReleaseCli(["attest", "--version", "0.24.0", "--wat", "x"]).valid, false);
  assert.equal(
    parseReleaseCli(["release", "--version", "0.24.0", "--version", "0.24.0"]).valid,
    false,
  );
  assert.equal(parseReleaseCli(["publish", "--version", "0.24.0", "--sha"]).valid, false);
  assert.equal(
    parseReleaseCli(["repin", "--version", "0.24.0", "--sha", SHA, "extra"]).valid,
    false,
  );
});

test("release CLI makes recovery explicit and rejects channel/reason confusion", () => {
  assert.equal(parseReleaseCli(["attest", "--version", "0.24.0"]).valid, true);
  assert.equal(
    parseReleaseCli([
      "attest",
      "--version",
      "0.24.0",
      "--channel",
      "recovery",
      "--recovery-reason",
      RECOVERY_REASON,
    ]).valid,
    true,
  );
  assert.equal(
    parseReleaseCli(["attest", "--version", "0.24.0", "--channel", "recovery"]).valid,
    false,
  );
  assert.equal(
    parseReleaseCli([
      "publish",
      "--version",
      "0.24.0",
      "--sha",
      SHA,
      "--recovery-reason",
      RECOVERY_REASON,
    ]).valid,
    false,
  );
  assert.equal(
    parseReleaseCli([
      "repin",
      "--version",
      "0.24.0",
      "--sha",
      SHA,
      "--channel",
      "standard",
      "--recovery-reason",
      RECOVERY_REASON,
    ]).valid,
    false,
  );
});

test("release hand-offs preserve the exact recovery channel through every phase", () => {
  const releaseChannel = { channel: "recovery", recoveryReason: RECOVERY_REASON };
  assert.deepEqual(
    [
      formatReleaseCommand({ phase: "attest", version: "0.24.0", releaseChannel }),
      formatReleaseCommand({ phase: "release", version: "0.24.0", releaseChannel }),
      formatReleaseCommand({
        phase: "publish",
        version: "0.24.0",
        sha: SHA,
        releaseChannel,
      }),
      formatReleaseCommand({
        phase: "repin",
        version: "0.24.0",
        sha: SHA,
        releaseChannel,
      }),
    ],
    [
      `npm run release -- attest --version '0.24.0' --channel 'recovery' --recovery-reason '${RECOVERY_REASON}'`,
      `npm run release -- release --version '0.24.0' --channel 'recovery' --recovery-reason '${RECOVERY_REASON}'`,
      `npm run release -- publish --version '0.24.0' --sha '${SHA}' --channel 'recovery' --recovery-reason '${RECOVERY_REASON}'`,
      `npm run release -- repin --version '0.24.0' --sha '${SHA}' --channel 'recovery' --recovery-reason '${RECOVERY_REASON}'`,
    ],
  );
});

test("release hand-offs keep standard commands free of recovery flags", () => {
  const releaseChannel = { channel: "standard", recoveryReason: undefined };
  assert.deepEqual(
    [
      formatReleaseCommand({ phase: "attest", version: "0.24.0", releaseChannel }),
      formatReleaseCommand({ phase: "release", version: "0.24.0", releaseChannel }),
      formatReleaseCommand({
        phase: "publish",
        version: "0.24.0",
        sha: SHA,
        releaseChannel,
      }),
      formatReleaseCommand({
        phase: "repin",
        version: "0.24.0",
        sha: SHA,
        releaseChannel,
      }),
    ],
    [
      "npm run release -- attest --version '0.24.0'",
      "npm run release -- release --version '0.24.0'",
      `npm run release -- publish --version '0.24.0' --sha '${SHA}'`,
      `npm run release -- repin --version '0.24.0' --sha '${SHA}'`,
    ],
  );
});

test("release command formatter rejects syntactically invalid phase arguments", () => {
  const releaseChannel = { channel: "standard", recoveryReason: undefined };
  for (const input of [
    { phase: "prep", version: "0.24.0", releaseChannel },
    { phase: "release", version: "0.24", releaseChannel },
    { phase: "release", version: "0.24.0", sha: SHA, releaseChannel },
    { phase: "publish", version: "0.24.0", releaseChannel },
    { phase: "publish", version: "0.24.0", sha: "<main-squash-sha>", releaseChannel },
  ]) {
    assert.throws(() => formatReleaseCommand(input), /cannot format/u);
  }
  assert.throws(
    () =>
      formatReleaseCommand({
        phase: "release",
        version: "0.24.0",
        releaseChannel: { channel: "recovery", recoveryReason: undefined },
      }),
    /cannot format invalid release channel/u,
  );
});

test("prep waits for gate selection and pending publish keeps recovery explicit", () => {
  const prep = formatPostPrepInstruction("0.24.0");
  assert.equal(
    prep,
    "After all four measurements for v0.24.0, use their gate result to select standard or recovery. Invoke attestation only with that channel's complete required arguments.",
  );
  assert.doesNotMatch(prep, /npm run release|then run:\s*attest/u);
  const recovery = formatPendingPublishInstruction({
    version: "0.24.0",
    releaseChannel: { channel: "recovery", recoveryReason: RECOVERY_REASON },
  });
  assert.equal(
    recovery,
    `After the PR merges, invoke publish for v0.24.0 with its full 40-character main squash SHA and these channel arguments: --channel 'recovery' --recovery-reason '${RECOVERY_REASON}'.`,
  );
  assert.doesNotMatch(recovery, /npm run release/u);
  const standard = formatPendingPublishInstruction({
    version: "0.24.0",
    releaseChannel: { channel: "standard", recoveryReason: undefined },
  });
  assert.equal(
    standard,
    "After the PR merges, invoke publish for v0.24.0 with its full 40-character main squash SHA and the standard channel (no channel flags).",
  );
  assert.doesNotMatch(standard, /npm run release|--channel|--recovery-reason/u);
});

test("release pull requests pin the exact GitHub squash headline and body", () => {
  const commit = "c".repeat(40);
  const tree = "d".repeat(40);
  assert.deepEqual(
    releasePullRequestPlan({
      version: "0.25.0",
      number: 268,
      commit,
      tree,
      releaseChannel: { channel: "standard", recoveryReason: undefined },
    }),
    {
      title: "release: v0.25.0",
      mergeHeadline: "release: v0.25.0 (#268)",
      body:
        `Keiko-Release-Dev-Commit: ${commit}\nKeiko-Release-Dev-Tree: ${tree}\n\n` +
        "Quality promotion: green\n\nKeiko-Release-Channel: standard",
    },
  );
  assert.throws(
    () =>
      releasePullRequestPlan({
        version: "0.25.0",
        number: 0,
        commit,
        tree,
        releaseChannel: { channel: "standard", recoveryReason: undefined },
      }),
    /invalid release pull-request number/u,
  );
  assert.throws(
    () =>
      releasePullRequestPlan({
        version: "0.25.0",
        number: 268,
        commit: "not-a-commit",
        tree,
        releaseChannel: { channel: "standard", recoveryReason: undefined },
      }),
    /full lowercase Git ids/u,
  );
  assert.match(releaseSource, /"--auto",\s+"--squash",\s+"--match-head-commit",/u);
  assert.match(releaseSource, /"--subject",\s+plan\.mergeHeadline,/u);
  assert.match(releaseSource, /"--body",\s+plan\.body,/u);
});

test("release auto-merge resumes or replaces only the exact stored message", () => {
  const plan = { mergeHeadline: "release: v0.25.0 (#268)", body: "bound body" };
  assert.equal(releaseAutoMergeAction({ autoMergeRequest: null }, plan), "enable");
  assert.equal(
    releaseAutoMergeAction(
      {
        autoMergeRequest: {
          mergeMethod: "SQUASH",
          commitHeadline: plan.mergeHeadline,
          commitBody: plan.body,
        },
      },
      plan,
    ),
    "ready",
  );
  assert.equal(
    releaseAutoMergeAction(
      {
        autoMergeRequest: {
          mergeMethod: "SQUASH",
          commitHeadline: plan.mergeHeadline,
          commitBody: "stale body",
        },
      },
      plan,
    ),
    "replace",
  );
});
