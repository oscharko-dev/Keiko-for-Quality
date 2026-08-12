import assert from "node:assert/strict";
import { test } from "node:test";

import { parseReleaseCli } from "./release.mjs";

const SHA = "a".repeat(40);
const RECOVERY_REASON = "historical_holdout_fixed_retention_low";

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
