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

/** `X.Y.Z`, the only shape this project's tags have ever had. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;

export function parseVersion(raw) {
  if (typeof raw !== "string" || !VERSION.test(raw)) return undefined;
  return raw;
}

export function tagFor(version) {
  return `v${version}`;
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
  const seed = fileNames.find(
    (name) => name.startsWith("seed-gate-") && name.endsWith(`-v${version}.md`),
  );
  const completion = fileNames.find(
    (name) => name.startsWith("completion-") && name.endsWith(`-v${version}.md`),
  );
  return { seed, completion, complete: seed !== undefined && completion !== undefined };
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
