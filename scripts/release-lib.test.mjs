import assert from "node:assert/strict";
import { test } from "node:test";

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

/**
 * Hermetic coverage for every decision the release driver makes: no network, no git, no gh. The
 * reconciliation test below is the one that matters most — it is the check that would have caught
 * three consecutive releases shipping without a GitHub Release object.
 */

test("accepts X.Y.Z and nothing else", () => {
  assert.equal(parseVersion("0.21.3"), "0.21.3");
  assert.equal(tagFor("0.21.3"), "v0.21.3");
  for (const bad of ["v0.21.3", "0.21", "0.21.3-rc1", "", undefined, 1]) {
    assert.equal(parseVersion(bad), undefined, String(bad));
  }
});

test("rewrites the README quickstart pin comment and reports how many it touched", () => {
  const readme = [
    "         - uses: oscharko-dev/Keiko-for-Quality@<sha> # v0.21.2",
    "   Reference the action at a full 40-character commit SHA.",
  ].join("\n");
  const bumped = bumpQuickstartPin(readme, "0.21.3");
  assert.equal(bumped.changed, 1);
  assert.match(bumped.text, /@<sha> # v0\.21\.3/);
});

// A README whose shape drifted must stop the release rather than release silently unbumped.
test("reports zero when the quickstart comment is not where it was", () => {
  assert.equal(bumpQuickstartPin("no pin here", "0.21.3").changed, 0);
});

test("finds both gate reports for the version, and says which one is missing", () => {
  const names = [
    "seed-gate-2026-08-09-v0.21.2.md",
    "completion-2026-08-09-v0.21.2.md",
    "seed-gate-2026-08-08-v0.21.1.md",
  ];
  const found = findGateEvidence(names, "0.21.2");
  assert.equal(found.complete, true);
  assert.equal(found.seed, "seed-gate-2026-08-09-v0.21.2.md");

  const partial = findGateEvidence(names, "0.21.1");
  assert.equal(partial.complete, false);
  assert.equal(partial.completion, undefined);
});

// v0.21.2's evidence must not satisfy a v0.21.20 release, and vice versa.
test("does not confuse one version's evidence for another's", () => {
  const names = ["seed-gate-2026-08-09-v0.21.20.md", "completion-2026-08-09-v0.21.20.md"];
  assert.equal(findGateEvidence(names, "0.21.2").complete, false);
  assert.equal(findGateEvidence(names, "0.21.20").complete, true);
});

test("takes the release notes from the release commit rather than asking for them twice", () => {
  const message = "release: v0.21.2 — the precision wave\n\nWhat it does.\n\nEvidence: a.md.\n";
  const notes = notesFromCommitMessage(message);
  assert.equal(notes.title, "release: v0.21.2 — the precision wave");
  assert.equal(notes.body, "What it does.\n\nEvidence: a.md.");
});

test("names every tag that has no Release — the omission this script exists for", () => {
  const result = reconcileTagsAndReleases(
    ["v0.20.1", "v0.21.0", "v0.21.1", "v0.21.2"],
    ["v0.20.1"],
  );
  assert.deepEqual(result.tagsWithoutRelease, ["v0.21.0", "v0.21.1", "v0.21.2"]);
  assert.deepEqual(result.releasesWithoutTag, []);
  // The live defect, separated from the list: the newest tag is the one a reader is misled by.
  assert.equal(result.newest, "v0.21.2");
  assert.equal(result.newestUnreleased, "v0.21.2");
});

// A gate that goes red on history is a gate nobody reads — the historical gaps stay in
// `tagsWithoutRelease` for reporting, but `newestUnreleased` stays empty.
test("historical gaps are reported without being called a defect", () => {
  const result = reconcileTagsAndReleases(["v0.3.0", "v0.18.0", "v0.21.2"], ["v0.21.2"]);
  assert.deepEqual(result.tagsWithoutRelease, ["v0.3.0", "v0.18.0"]);
  assert.equal(result.newestUnreleased, undefined);
  assert.equal(result.newest, "v0.21.2");
});

test("orders by version, not by push order, before deciding which tag is newest", () => {
  const result = reconcileTagsAndReleases(["v0.21.10", "v0.21.2"], ["v0.21.10"]);
  assert.equal(result.newest, "v0.21.10");
  assert.equal(result.newestUnreleased, undefined);
});

test("names a Release whose tag does not exist", () => {
  const result = reconcileTagsAndReleases(["v0.21.2"], ["v0.21.2", "v0.99.0"]);
  assert.deepEqual(result.releasesWithoutTag, ["v0.99.0"]);
  assert.deepEqual(result.tagsWithoutRelease, []);
});

test("orders version tags numerically, not as strings", () => {
  assert.deepEqual(sortVersionTags(["v0.21.10", "v0.21.2", "v0.9.0", "kq-assets-v1"]), [
    "v0.9.0",
    "v0.21.2",
    "v0.21.10",
  ]);
});

test("moves the consumer's uses: and ACTION_PIN together, and counts both", () => {
  const sha = "a".repeat(40);
  const workflow = [
    '          ACTION_PIN: "' + "b".repeat(40) + "\" # v0.21.1 — keep in sync with Review's uses:",
    "        uses: oscharko-dev/Keiko-for-Quality@" + "b".repeat(40) + " # v0.21.1",
  ].join("\n");
  const bumped = bumpConsumerPin(workflow, sha, "0.21.2");
  assert.equal(bumped.uses, 1);
  assert.equal(bumped.actionPin, 1);
  assert.equal(bumped.text.includes("b".repeat(40)), false);
  assert.match(bumped.text, /# v0\.21\.2/);
});

// A workflow that carries only one of the two sites is the drift its own sync check fails on;
// the counts are what let the driver refuse before pushing it.
test("reports the counts separately so a half-rewrite is visible", () => {
  const bumped = bumpConsumerPin(
    "        uses: oscharko-dev/Keiko-for-Quality@" + "b".repeat(40) + " # v0.21.1",
    "c".repeat(40),
    "0.21.2",
  );
  assert.equal(bumped.uses, 1);
  assert.equal(bumped.actionPin, 0);
});
