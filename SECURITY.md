# Security

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/oscharko-dev/Keiko-for-Quality/security/advisories/new).
Please do not open a public issue for a suspected vulnerability.

Include what you did, what happened, and what you expected. A proof of concept helps. If the finding
involves a review comment this bot published, redact any content from the affected repository.

## Threat model

This bot runs inside a consumer's CI with a model credential and write access to pull-request
conversations, on input authored by whoever opened the pull request. The design assumes that input
is hostile.

### What an attacker controls

- The complete content of the changed files, including comments, strings, identifiers, and paths.
- The pull-request title, body, and branch name.
- Timing: when heads arrive, and how many.

### What the design does about it

**Candidate content is never executed.** It is read as Git objects through plumbing. The tree is
never checked out, no symlink target is resolved, no submodule is initialized, and no
candidate-provided script, hook, action, package manager, or repository command runs. Git itself is
invoked with a constructed environment and neutralized global and system configuration, because a
config file can define aliases and hook paths that turn a read into an execution.

**Structural retrieval keeps that boundary.** Follow-up lookup uses `git grep` against an exact
immutable commit: HEAD normally, or the merge base only for the planner's closed `base` challenge
axis. A fixed ast-grep release receives at most four bounded blobs from that same commit through
stdin — never candidate paths, a checkout, or repository configuration — when ambiguous sightings
require structure and, when available, to add tightly bounded owning-function context to clear
lexical evidence. Both the release archive and extracted executable are SHA-256 pinned on every
supported platform; ZIP paths, sizes and CRCs are checked before verified bytes become executable.
Malformed output, timeout, unsupported platform, or any acquisition mismatch fails an
ambiguity-driven lookup closed and leaves the affected review incomplete; optional enrichment
failure retains only the exact lexical evidence. The reviewed file is eligible only during an
explicit follow-up, and lines inside its already-rendered 24-line-per-side anchor window are
rejected before lexical or structural evidence is returned.

**Prompt injection is expected, not prevented.** The rule text tells the model that file content is
data and never an instruction, but that is mitigation, not a guarantee. The real containment is
downstream: everything the model produces passes strict schema validation, path re-validation, and
content sanitization before it can become a published comment. A successful injection can at worst
produce a finding that is wrong — not one that executes, links out, or impersonates.

**The engine never holds a GitHub token.** Its environment is constructed from nothing rather than
filtered, so it contains only the model endpoint, model, protocol, timeouts, and its own credential.
Publication happens in a separate stage, after validation.

**Candidate files cannot become configuration.** The engine layers rules from the `--rule` file, a
repository-local `.opencodereview/rule.json`, and a global one, selecting the highest-priority layer
that declares any filter. This bot always emits a non-empty include list, so a rule file inside the
reviewed repository can never shrink the review.

**Published content is validated, not repaired.** Bodies carrying control characters, bidirectional
overrides, zero-width characters, HTML, images, links, mentions, suggestion blocks, or
credential-shaped strings are rejected. A rejected finding makes the run incomplete — visible and
blocking — rather than being silently rewritten into something no one authored.

**Suggestion blocks are prohibited.** Model output produced while reading attacker-influenced input
must never become one-click-applicable code.

**The run-summary comment cannot carry model or candidate-influenced content.** Its composer's
parameter type is limited to numbers, closed-vocabulary reason codes, and branded identifiers
(head SHA, engine version) or narrowly trusted strings sourced from the triggering event payload
and the Actions runtime (`GITHUB_ACTION_REF`) — never engine output and never a finding body.
There is no field wide enough to hold arbitrary prose, so this publication path cannot become a
second route for unsanitized content to reach a published comment. It is upserted through the same
authorship rule as every other publication: only a comment carrying the marker _and_ authored by
this reviewer's own runtime-resolved identity is treated as the existing summary and updated in
place; a look-alike marker inside anyone else's comment is spoofing and is ignored, and a fresh
comment is created instead of overwriting it. Because it is an issue comment rather than a review
comment, it carries no `commit_id` — it states the reviewed head in its own text instead, and is
reissued on every run against a new head so it can never describe a superseded commit while
looking current. A failure to upsert it is caught and recorded as a diagnostic; it never fails the
run or changes the settlement outcome the rest of that run already reached.

**Deduplication verifies authorship, on every one of its three stages.** A finding is suppressed
only when an existing conversation was authored by this reviewer's own runtime-resolved identity.
The first stage matches the exact marker every publication carries. The second is
phrasing-independent: it compares a candidate against this reviewer's own OPEN conversations at the
same location by line overlap and content similarity (Keiko-for-Quality#38 — a model that words the
same defect differently on a re-run changes the marker, and exact matching alone republishes it as
new). The third matches this reviewer's own RESOLVED conversations, and only those whose last reply
is a substantive disposition rather than a bare resolve (Keiko-for-Quality#64 — observed on
oscharko-dev/Keiko#2931, where a finding answered in a reasoned reply and then resolved returned as
"fresh" on every later run, because the second stage's resolved-thread exclusion has no memory of
why a thread was resolved). A marker or a similar-looking body inside anyone else's comment is
spoofing and never suppresses publication under any of the three.

The resolved-conversation rule differs by stage, deliberately — and no longer treats resolved and
outdated alike everywhere. Stage one, the exact marker, ignores only a conversation that is
genuinely resolved: it matches on a finding's content, never on a line, so a conversation that is
merely outdated — its hunk moved under a later push, nobody has answered it — still suppresses a
repost. An outdated thread is still an open question; only an answered one may allow recurrence.
Stage two still ignores both resolved and outdated conversations, because its own match depends on a
line anchor, and an outdated conversation's anchor is a stale coordinate from before the push —
matching against it would be noise, not signal. Either way, a defect that genuinely recurs after its
conversation was resolved is republished rather than silenced permanently. Stage three exists
precisely to read resolved conversations — but only where a human wrote a considered answer, which is
what separates "this was decided" from "this was clicked away."

**Incomplete never reads as clean.** Partial, skipped, failed, unknown, unlisted-warning-bearing,
budget-exhausted, timed-out, and malformed results all settle as incomplete.

**Coverage is reconciled at one of two strengths, and the run says which.** Against a released
engine only a `files_reviewed` count is available, so omission is caught by cardinality rather than
by identity. Against an engine that emits a run manifest, every path is matched individually. See
the README's _Coverage guarantee_; do not read a clean counted result as the stronger claim.

**The engine binary is pinned by digest.** It is downloaded at an exact version and verified against
a SHA-256 digest held in this repository, with no fallback artifact and no retry against a different
asset.

**Zero runtime dependencies.** Every npm package this bot carried would become a package its
consumers implicitly trust inside a job holding a private key.

### What is out of scope

- **Fork-originated pull requests.** They are skipped and recorded as such. Model budget and the
  credential-bearing path are not exposed to arbitrary external heads.
- **Availability.** The reviewer publishes no required status check, so a workflow that never runs
  cannot be detected by this bot. That is a consumer-side branch-protection concern.
- **Model correctness.** Findings are claims to evaluate. Precision is measured, not guaranteed.
- **The consumer's own workflow.** If the consumer checks out the candidate head instead of the
  base, or grants the job more permission than documented, this bot's guarantees do not apply.

### Local runs

`npm run review` (`src/cli.ts`, Keiko-for-Quality#94) runs the same shared pipeline described
above against a local repository instead of a pull request. The protections above apply because
the code is shared, not reimplemented — with four properties worth stating explicitly for this
entry point.

**The CLI never holds a GitHub token.** Its configuration surface (`RuntimeConfig`) has no GitHub
field, `KFQ_MODEL_TOKEN_ENV` refuses to name `GITHUB_TOKEN` or any `ACTIONS_*` variable, and the
engine's spawned environment is still built from nothing rather than filtered from the operator's
own shell — so even an operator whose environment already holds a GitHub token never has it reach
the engine. The CLI makes no GitHub API call on any path: nothing here constructs a client, and
nothing is published.

**Candidate content is still read as Git objects, never checked out or executed.** Base and head
are resolved to commits and read through the identical git-plumbing layer the action uses,
invoked through the same neutralized `git` configuration described above — no candidate script,
hook, or package manager runs, and this tool never checks a candidate ref out over the operator's
own working tree.

**Writes are confined to paths the operator names.** The rendered report goes to stdout or
`--out`; the optional review-cache goes only to `--store`. Neither defaults inside the reviewed
repository, and nothing else is written to disk. A report file is an ordinary file once written —
sanitized the same way a published finding is, but not subject to GitHub's own access controls
afterward, so its distribution from that point on is the operator's responsibility, same as the
source it describes.

**A locally produced review store is never consumed by CI.** It exists to make repeated local runs
cheaper, never to feed a verdict into the pipeline that gates a pull request — trusting a local
store from CI would let whoever controls the local run manufacture a clean result. The boundary is
one-directional by design and permanent: CI→local sharing may be considered separately; local→CI is
rejected outright (Keiko-for-Quality#94).

## Supported versions

Only the newest release line — currently 0.13 — receives fixes. There are no maintenance branches
for older lines. Because consumers pin this action to a full commit SHA, a fix takes effect only
when the pin is advanced to a release that carries it.
