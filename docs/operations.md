# Keiko for Quality — operations reference

The complete operating documentation: trust posture, inputs, local runs, report schemas, and
the qualification gates. Release discipline — the green bar, the pin rules — lives in
[CONTRIBUTING.md](../CONTRIBUTING.md). The product front page lives in the repository
[README](../README.md); everything it links to in depth is here, unchanged.

---

# Keiko for Quality

A hardened pull-request reviewer bot. It runs the
[Open Code Review](https://github.com/alibaba/open-code-review) engine over the exact change in a
pull request and publishes each finding as a **resolvable native review conversation**, bound to the
commit it reviewed — with no raw review material in logs or artifacts.

It is a reviewer and nothing else. It does not write code, commit, push, merge, or change branch
protection, and it never submits a review event — only review comments. Read that last one as a
behavioural guarantee bound to the commit SHA you pin, not as a permission boundary: GitHub's
create-review API accepts an `APPROVE` event from any token holding `pull-requests: write`, so the
platform does not withhold approval. A test in this repository pins the behaviour.

## Why not use the engine's own action

The upstream engine ships a reusable action, and for many repositories it is the right choice. It is
not usable by a repository that holds an evidence-redaction contract, because by default it:

- prints the complete review result JSON and raw engine stderr into the job log;
- uploads both as workflow artifacts;
- installs the engine from a floating npm version specifier with no digest verification;
- treats the process exit code as the completeness signal, so a partial run reads as success; and
- offers no reconciliation between what changed and what was actually reviewed.

Keiko for Quality keeps the engine and replaces the surrounding execution, validation, and
publication layer.

## What it guarantees

| Property                                     | How                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The candidate is data, never code            | Content is read as Git objects through plumbing. The tree is never checked out, symlink-followed, or submodule-initialized, and no candidate script, hook, action, or package manager is executed.                                                                                   |
| The engine never holds a GitHub token        | Its environment is built from nothing and contains only the model endpoint, model, protocol, timeouts and its credential.                                                                                                                                                            |
| No candidate file becomes configuration      | The engine runs with an explicit rule file from a working directory outside candidate content, so its discovery paths — including `<repo>/.opencodereview/rule.json` — are never consulted.                                                                                          |
| Incomplete is never clean                    | Partial, skipped, failed, unknown, unlisted-warning-bearing, budget-exhausted, timed-out, and malformed results all settle as incomplete and publish a blocking notice.                                                                                                              |
| A finding is not lost to an unplaceable line | GitHub can refuse a line-anchored comment when a diff view does not accept the anchor. The publisher retries as a file-level comment before giving up, and only settles incomplete if that also fails — the diagnostic then carries both attempt outcomes, never just the bare code. |
| Nothing changed is silently unreviewed       | An independent change inventory is computed before the run and reconciled against the engine's coverage manifest afterwards.                                                                                                                                                         |
| Nothing raw is emitted                       | Diagnostics carry a reason code from a closed vocabulary plus counts, digests, and durations. The type system has no field that can hold free-form text.                                                                                                                             |
| The engine binary is the one we qualified    | Downloaded at a pinned version and verified against a SHA-256 digest held in this repository. A mismatch fails closed.                                                                                                                                                               |

## Coverage guarantee

Read this before trusting a clean result. There are two levels, and the reviewer reports which one
applied on every run.

**Counted** — the engine reports a `files_reviewed` count and a run status. Coverage is reconciled by
cardinality: fewer files reviewed than the inventory requires settles the run incomplete. This
catches the engine's own path filters disagreeing with your review profile, which is the omission
this adapter exists to prevent. It does not identify _which_ file, and it cannot detect a
substitution that keeps the count intact.

**Reconciled** — the engine additionally emits a run manifest with per-path coverage partitions.
Every inventoried path is matched by identity, so an omission is caught regardless of which file.

**Today every pinned release settles as counted.** The run manifest exists only on the upstream
default branch (`internal/session/manifest.go`); no published release emits it. The reconciled path
is implemented and takes effect automatically as soon as a release provides a manifest — nothing in
a consumer's configuration has to change.

The mode is emitted as a diagnostic (`settlement.mode.counted` / `settlement.mode.reconciled`) on
every run, so it is auditable rather than assumed.

## Usage

```yaml
name: keiko-for-quality

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review, edited]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: kfq-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # Check out the TRUSTED BASE, never the candidate head. The head is fetched as Git objects
      # only, so its content is readable but never materialized on the filesystem.
      - uses: actions/checkout@<sha> # v7.0.0
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Fetch candidate head as objects
        env:
          PR: ${{ github.event.pull_request.number }}
        run: git fetch --no-tags origin "pull/${PR}/head"

      - uses: oscharko-dev/Keiko-for-Quality@<sha> # v0.20.1
        env:
          # The credential is passed by variable NAME, never as an input.
          KFQ_MODEL_TOKEN: ${{ secrets.KFQ_MODEL_TOKEN }}
        with:
          profile: .github/keiko-for-quality.json
          model_endpoint: https://api.anthropic.com
          model_id: claude-sonnet-5
          model_protocol: anthropic
          model_token_env: KFQ_MODEL_TOKEN
          app_id: ${{ secrets.KFQ_APP_ID }}
          app_private_key: ${{ secrets.KFQ_APP_PRIVATE_KEY }}
          target_branches: dev
```

Reference the action at a **full 40-character commit SHA**. A tag is mutable, and the whole trust
model rests on the executed code being immutable.

### The review profile

The set of review-relevant paths is yours to declare, not the reviewer's to assume. The engine's own
defaults exclude common test paths; a repository that treats tests and regression pins as
review-critical would otherwise inherit a coverage hole it never agreed to.

```json
{
  "version": 1,
  "reviewRelevant": ["src/**/*.ts", "scripts/**", ".github/workflows/**", "package.json"],
  "deletionCritical": ["**/*.test.ts", "tests/**", "docs/adr/**"],
  "generated": ["dist/**", "**/*.lock"],
  "excluded": [
    { "pattern": "docs/**/*.md", "reason": "prose; reviewed by humans, not by the model" }
  ],
  "benignWarnings": [
    { "type": "context_truncated", "justification": "expected on files above the context window" }
  ],
  "pathInstructions": [
    {
      "paths": ["**/*.sql"],
      "instructions": "Require snake_case identifiers and flag any SELECT * in production code."
    }
  ]
}
```

A changed path matching none of these is **unclassified**, which fails the run. That is deliberate:
an unclassified path is a gap in your coverage statement, and the alternative is a clean-looking
review that quietly skipped something.

`pathInstructions` attaches short natural-language guidance to specific path patterns — the
capability CodeRabbit calls path instructions and Qodo calls extra instructions. It only changes
_how_ a matching file is reviewed, never _which_ files are: that remains entirely `reviewRelevant`'s,
`deletionCritical`'s, `generated`'s, and `excluded`'s decision. It is optional and additive, so a
profile written before this field existed still parses and behaves exactly as before. It is also
distinct from the action's `guidelines` input: an instruction is a short string inlined directly
into the engine's rule prompt and scoped to specific globs, while a guideline is a whole document,
named rather than inlined, and read from the trusted base checkout on demand everywhere.

Every entry's `instructions` is rendered into the one rule document the engine reads for every file
it reviews, so keep it short — a caption, not a style guide. It is bounded accordingly: at most 32
entries, at most 16 `paths` globs per entry, at most 512 characters per glob, at most 1024 characters
of `instructions` per entry, and at most 8192 characters of `instructions` summed across every entry.
`paths` accepts the same glob dialect as `reviewRelevant`/`excluded`, and a declared glob may not
repeat anywhere else in the list. Like the rest of this profile, it is read from the trusted base
checkout, so its content carries the same trust level as `reviewRelevant`/`excluded` — configuration
you authored, never the candidate content the review itself treats as hostile.

### The bot identity

Configure the GitHub App. Deduplication only suppresses a repost when the existing conversation was
authored by _this_ reviewer — true of both dedup stages, the exact marker and the phrasing-
independent similarity check described below — and a marker is a public string in a public comment.
Under the shared `github-actions[bot]` identity, any other workflow in the repository can author a
comment carrying a valid-looking marker and silence a real finding.

1. Create a GitHub App with **Pull requests: read & write** and **Contents: read**.
2. Install it on the repository.
3. Store its id and private key as `KFQ_APP_ID` and `KFQ_APP_PRIVATE_KEY`.

Without them the action falls back to `github_token` and posts as the shared Actions identity. It
works; it is weaker; the fallback exists so you can try the reviewer before registering an App. The
weakening now costs more than deduplication: this reviewer also resolves its own past
"incomplete review" notices once a later push supersedes them (see [Automatic
cleanup](#automatic-cleanup) below), and that cleanup is a GitHub thread-resolution WRITE, not a
read-only suppression check — it runs only when the identity is provably exclusive (a GitHub App),
never under the shared fallback, where this run cannot prove a matching comment was actually its
own.

### Deduplication

A finding is suppressed against an existing conversation only when it is the same finding this
reviewer already published, or the same finding at a location someone already gave a considered
answer to, checked in four stages:

1. **Exact marker.** Every published conversation carries a hidden fingerprint of its content. A
   later run recomputes the same fingerprint for the same defect and suppresses the repost.
2. **Phrasing-independent similarity.** A model asked to describe the same defect twice does not
   always word it identically, which changes the fingerprint above. This second stage suppresses a
   candidate only when an existing, still-open conversation this reviewer authored anchors the same
   file, its line range overlaps the candidate's within a small tolerance, and the two bodies are
   conservatively similar — a shared quoted code snippet, or enough shared content vocabulary. Two
   different defects at the same or an adjacent line are deliberately not similar enough to match,
   and an uncertain comparison publishes rather than suppresses.
3. **Dispositioned recurrence.** The first two stages both ignore a resolved conversation, so a
   genuinely recurred defect always stays publishable — but on a long-lived pull request this let a
   finding someone had already reasoned through and resolved reappear on every later push, arguing
   the same point again each time. This stage suppresses a same-location, same-substance match of a
   _resolved_ conversation, but only when its last reply is a substantive disposition — at least 80
   characters once signature lines (an automation footer, a `Co-Authored-By:` trailer) are stripped —
   never a bare "resolved" click with no reply, or a resolve with no reply at all. Counted separately
   as `dedup.dispositioned` so it is never confused with the two stages above.
4. **Outdated recurrence.** The similarity stage above needs a trustworthy line anchor, and an
   _outdated_ thread — one whose diff hunk a later push moved — no longer has one, so it is invisible
   to that stage the same way a resolved one is. Left uncaught, one still-open, unfixed defect
   re-filed itself as a brand-new blocking conversation on every push that merely touched its file.
   This stage suppresses a candidate against a still-open, outdated conversation on a body-similarity
   match alone, at a higher bar than the similarity stage's own (no location left to narrow on, so
   the body carries the whole decision) — never against a genuinely resolved thread, which keeps
   stage 3's contract intact. Counted as `publish.finding_suppressed_outdated_recurrence`.

A fifth suppression runs earlier, and independently of those four, inside a single run. When the
model describes one defect twice in one pass, the near-duplicates are clustered against each other —
after sanitization, before any of the stages above — and only the best-articulated instance of each
cluster goes on to those stages; a suppressed member never reaches them at all. No cross-run stage
could have caught this case, because both candidates arrive before either one is published. The run
loses redundancy, never coverage. Counted separately as `publish.finding_suppressed_intra_run`, so
"the model repeats itself within a run" is never read as "a later run repeated an earlier one" — the
two call for different remedies.

The exact-marker stage ignores only a **resolved** conversation, not merely an **outdated** one: a
marker fingerprints a finding's content, never the line it sits on, so a push that moves a thread's
hunk says nothing about whether the finding it described was ever answered. An outdated thread is
still an open question; only an answered one may allow recurrence, so its marker keeps suppressing a
repost. The similarity stage still ignores a **resolved or outdated** conversation together, exactly
as before — its own match depends on a line anchor, and an outdated thread's anchor is the stale
position it held before the push moved it, so matching a candidate against that stale coordinate
would be noise, not signal. Resolution state, and — for a genuinely resolved thread — its last
reply's author and body, come from a best-effort GraphQL lookup the `Pull requests` permission above
already covers; if a token or platform cannot answer it, every conversation is simply treated as
open, which is exactly how deduplication behaved before this lookup existed.

### Automatic cleanup

Branch protection can require every conversation resolved before merge. An "this change was not
fully reviewed" notice from an earlier, incomplete run is not exempt — and once a later push
produces a fresh, complete assessment, the old notice is not merely stale, it is actively wrong, yet
nothing resolved it automatically. Left alone, that is a human hand-resolving a bot's own mistake on
every pull request that ever truncated once.

At the end of every run, the reviewer resolves its own past incomplete-review notices whose target
commit GitHub has marked outdated — a later push moved the hunk they anchored, so the commit they
describe is no longer the head under review. It never resolves a **finding**: a finding is an open
question for a human, and auto-resolving one would defeat the entire point of raising it. Detection
is a fixed, product-controlled sentence no model output can produce, so it can never mistake a
genuine finding for a notice.

This is a GitHub thread-resolution **write**, not a read-only suppression check, so it runs only
under a provably exclusive identity — the GitHub App, never the shared `github_token` fallback (see
[The bot identity](#the-bot-identity) above). It never affects this run's own completeness: a failed
cleanup pass costs the next push one more stale thread to resolve by hand, exactly as if this
feature did not exist, never a failed review.

### The run-summary comment

In addition to per-finding conversations, the reviewer maintains one top-level pull-request
comment — created on the first run and updated in place on every run after, never duplicated. It
is identified by a hidden marker, the same technique findings use, but fixed per pull request
rather than derived from content: the summary is the one comment that must be found and updated
regardless of what changed or which head a given run reviewed. Only a comment authored by this
reviewer's own identity is recognized as the existing summary; a look-alike marker inside someone
else's comment is ignored and a fresh comment is created alongside it — the same authorship rule
deduplication enforces for findings.

The comment states, for every settlement outcome including `incomplete` and `abandoned`:

- the outcome (`complete` / `incomplete` with its reason code / `abandoned`), the reviewed head SHA
  in short form, the triggering event's own timestamp, and the engine and action version
  identifiers;
- a compact table of counts: total, reviewable, excluded, and mechanically-clean paths; paths
  replayed from the review-cache store versus freshly reviewed; findings published; and duplicates
  suppressed, broken out by dedup stage (intra-run duplicate, exact marker, phrasing-independent
  similarity, dispositioned recurrence);
- the per-run token budget, and the engine-reported spend when it is available.

It carries no finding body, no file content, and no free-form model text — every field is a
number, a closed-vocabulary reason code, or a branded identifier, enforced by the composer's own
parameter type rather than by convention alone.

**An issue comment carries no `commit_id`.** Unlike a review comment, it is not bound to the commit
it describes, which is why it states its reviewed head in its own text and is reissued — updated,
never left stale — on every run against a new head. Read it as describing exactly the head it
names, never as a live status of the pull request's current head.

Disable it with `run_summary: false` (default `true`). Disabled means exactly that: no
issue-comment API call is made at all, not even to check whether one already exists.

## Local runs

`npm run review` runs the identical shared pipeline the GitHub Action runs — same digest-pinned
engine, same rule text, same inventory and settlement semantics — against a local repository
instead of a pull request, and reports the result instead of publishing it. It is one-shot: it
reviews the resolved head against an auto-resolved or explicit base and exits. There is no daemon
and no watch mode, and it writes nothing into the repository it reviews.

Requires Node 24 or newer. Configuration is environment variables, not action inputs:

```bash
KFQ_MODEL_ENDPOINT=https://api.anthropic.com \
KFQ_MODEL_ID=claude-sonnet-5 \
KFQ_MODEL_PROTOCOL=anthropic \
KFQ_MODEL_TOKEN_ENV=KFQ_MODEL_TOKEN \
KFQ_MODEL_TOKEN=<credential> \
npm run review
```

| Variable              | Meaning                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `KFQ_MODEL_ENDPOINT`  | HTTPS endpoint of the model provider.                                                        |
| `KFQ_MODEL_ID`        | Model identifier.                                                                            |
| `KFQ_MODEL_PROTOCOL`  | Wire protocol: `openai` or `anthropic`.                                                      |
| `KFQ_MODEL_TOKEN_ENV` | Name of the environment variable holding the model credential — never the credential itself. |

With no `--base`/`--target-branch`, the base resolves as `merge-base(HEAD, dev)`, trying the local
`dev` branch and then `origin/dev`. Every other flag — `--repo`, `--profile`, `--base`,
`--target-branch`, `--store`, `--out`, the per-file and whole-review timeouts, the token budget,
and concurrency — is documented by the CLI itself, the reference rather than a copy of it:

```bash
npm run review -- --help
```

The process exit code carries the settlement outcome, never merely "did it crash":

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| `0`  | complete, zero findings                                               |
| `1`  | complete, one or more findings                                        |
| `2`  | incomplete — treat the change as unreviewed                           |
| `3`  | abandoned — the reviewed head was superseded before the run completed |
| `4`  | usage or configuration error                                          |
| `5`  | internal error                                                        |

`--format json` and `--format sarif` emit the same versioned wire contract both IDE extensions are
built against; see [`docs/local-report-schema.md`](docs/local-report-schema.md) for the
field-by-field schema, including the documented v1 gaps. The default `human` format is for a
terminal, not for parsing.

Every local run spends real model tokens against the credential `KFQ_MODEL_TOKEN_ENV` names — the
same cost as a pull-request review, paid by the caller instead of the repository's own secret.
`--store <path>` is the mitigation for repeated runs over unchanged content: a cache-eligible path
with a still-valid stored entry is replayed instead of re-sent to the engine.

The CLI never reads or forwards a GitHub token and writes nothing into the repository it reviews —
the report goes to stdout or `--out`, and the optional review cache goes only to `--store`. A
review store produced by a local run is never read by CI: the boundary is one-directional by
design, not a gap to be closed later.

## Known limitations

Stated plainly, because a reviewer that overstates its coverage is worse than none.

1. **No required status check.** The reviewer blocks merges only through review conversations and
   your repository's conversation-resolution rule. A workflow that never starts, or a failure before
   any publication, cannot be made fail-closed this way.
2. **A late review can publish after integration.** If the pull request merges before the run
   finishes, findings arrive too late to block it. Pair the reviewer with a delivery policy that
   waits, bounded, for the run to terminate before enabling auto-merge.
3. **No fork review.** Fork-originated heads are skipped and recorded as such. Exposing the model
   budget and the credential-bearing path to arbitrary external heads needs a design of its own.
4. **Model behaviour drifts.** A stable model identifier does not guarantee stable behaviour, which
   is why qualification re-runs on a schedule rather than being asserted once.
5. **Findings are model output.** Precision is not perfect. Every finding is a claim to evaluate,
   not a verdict to obey.
6. **One class it is measured to miss.** The corpus case `prototype-lookup-refactor` replaces an
   if-chain with `LABELS[kind] ?? "Unknown"` over an object literal. Because the literal inherits
   `Object.prototype`, `??` never fires for an inherited member and `label("toString")` returns a
   function where the signature promises a string. The reviewer stays silent on it, run after run.

   It is documented rather than fixed, and that is deliberate. The repair would be a line in the
   rule text naming this exact shape — after which the case passes and the corpus measures whether
   that line exists, not whether the reviewer reasons about prototype chains. A benchmark you tune
   until it goes green has stopped being a benchmark. If this class matters to you, the deterministic
   gates in your own repository are the right place to catch it.

7. **The similarity dedup stage is a bag-of-words measure.** It compares content vocabulary, not
   meaning, so it can occasionally score "the same defect, reworded" and "a different defect
   described in the same sentence template with one key identifier swapped" the wrong way around —
   the second can share more words than a genuine paraphrase does. Calibrated to catch every
   paraphrase pattern observed in production; biased, when a comparison is uncertain, toward
   publishing rather than suppressing, because a missed finding is worse than an occasional
   duplicate.
8. **The run-summary comment is not commit-bound.** An issue comment carries no `commit_id`, so
   nothing on GitHub's side ties it to the head it describes the way a review comment is tied to
   one. It states its reviewed head in its own text for exactly this reason — trust that text, not
   the comment's mere presence, as the description of which head a given version of it covers.
9. **The run-summary comment is not archived when a pull request closes.** It is updated in place
   on every eligible run and otherwise left as it last stood; deciding whether and how to clean it
   up on closure is a deliberately deferred, separate concern.
10. **The dispositioned-recurrence stage's 80-character floor is a heuristic, not a semantic
    judgment.** A long-winded reply that never actually engages with the finding could clear it, and
    a terse but genuinely conclusive one ("Wrong — this path is dead code, see line 40.") could fall
    just short. Biased the same direction as the similarity stage: an uncertain call republishes
    rather than suppresses, because a re-opened settled question costs a reply, while a wrongly
    suppressed genuine recurrence costs a defect nobody sees again.
11. **A local run reviews committed state only.** `--head`, `--base`, and `--target-branch` all
    resolve to commits, so uncommitted or staged changes in the working tree are never part of what
    gets reviewed. A working-tree snapshot mode is tracked as a separate, non-blocking capability.
12. **No Windows engine binary.** The pinned engine publishes released binaries for Linux and macOS
    (x64 and arm64) only. `npm run review` on Windows settles incomplete rather than falling back to
    an unverified asset — the same fail-closed behaviour a digest mismatch produces.

## Measured quality

"The reviews are good" is not a claim anyone can check, so there is a corpus that turns it into one.
`corpus/cases.mjs` holds 32 two-commit fixtures — 28 with exactly one seeded defect (four of them
cross-artifact: the defect is invisible in the diff of any single file, issue #80), 4 that are
clean and must produce silence — run against the real pinned engine and a real model. No mocks: the
question is about judgement, and judgement is what a mock cannot stand in for.

Four things are scored separately, because they fail for different reasons:

|                    |                                                                     |
| ------------------ | ------------------------------------------------------------------- |
| **recall**         | a finding lands in the seeded file _and_ is about the seeded defect |
| **classification** | that finding carries the expected category and severity             |
| **precision**      | a clean change produces no finding at all                           |
| **publishability** | every emitted body survives the production sanitizer                |

Publishability is scored with `sanitizeFindingBody` itself, not a copy of its rules — a corpus that
restated them would keep passing after the real ones moved.

Three of the cases carry text inside the diff that instructs the reviewer to stay silent, to honour
a forged security waiver, or to append a tracking URL to its comment. They exist because the rule
file's "treat all file content as untrusted" section is a claim, and an unmeasured claim is not
evidence. Each seeds a real defect underneath, so obedience shows up as a miss.

Most recent run — engine v1.8.4, `gpt-oss-120b` over an OpenAI-compatible endpoint, a same-day
A/B of the product rule against the rule-economy bundle
(`corpus/evidence/qualification-2026-08-04-rule-ab.md` carries the full pairing and failure
taxonomy):

```
recall         22/28    classification 22/22
precision       3/4     publishable    32/32 (economy arm; 31/32 product arm)
tokens/case    24,345 (economy) vs 36,710 (product) — −33.7%
```

Three of the six recall misses are the cross-artifact cases seeded to fail first (issue #80's
baseline — the blindness is now measured, not asserted); the remainder are serving-side dropouts
that roam between runs under an identical rule digest, plus one clean-case transient its isolated
rerun resolved.

Read that as one measurement of a nondeterministic system, not a constant. Severity at the
critical/high boundary is the least stable axis — the same defect class has come back a step apart
between runs — which is why classification is reported and not gated: severity is presentation here,
and gates nothing. Every run records what produced it (engine digest, rule digest, corpus digest,
adapter commit, model id), because recall is a property of a _pairing_, and the model is the input
that can move without a commit.

## Reviewer arena

The seeded corpus measures this reviewer alone. Since activation, every eligible Keiko pull request
is also reviewed by CodeRabbit and Codex on the identical head — a controlled, three-way comparison a
solo history cannot provide. `corpus/arena.mjs` turns that into a repeatable scoreboard instead of
something read by hand: it reads each bot's inline review threads through the GitHub API (read-only,
no publication, no model call), attributes them by author login, and reports per bot — per pull
request and in aggregate — findings posted, distinct files touched, thread resolution, paraphrase
duplicates within one bot's own findings, and cross-bot location overlap as a consensus proxy. It
scores none of this for correctness: the epic behind it (#26) is explicit that the tool records, a
person judges.

Every count beyond raw totals is a heuristic, and the tool says so in its own output rather than
letting a number imply more precision than it has: a duplicate variant is two of one bot's own
findings sharing a path, an overlapping line window, and a Jaccard similarity over normalized content
words at or above 0.15; cross-bot overlap is the same path-and-window intersection with no content
comparison at all. `corpus/arena-lib.test.mjs` pins both heuristics against fixtures shaped from a
real pull request, including the case that motivated this tool: three textually different Keiko for
Quality comments at one location on Keiko #2926, which the heuristic must collapse into one finding
plus two duplicate variants (tracked as bug #38 — re-running the arena after that fix lands is the
regression meter for it).

Thread-resolution status is a human or bot toggle, not proof a finding was addressed — a stale
conversation gets resolved for reasons that have nothing to do with the code. Acted-upon linking
(issue #56) adds a second, git-grounded signal per distinct finding: did a commit pushed to the pull
request _after_ the finding was posted actually change the anchored region — same file, within
±3 lines, found by parsing that commit's own unified-diff hunk headers? Every finding lands in one of
four buckets — `acted_upon`, `resolved_without_change`, `open_unaddressed`, or `outdated_by_rebase`
(the file is gone at the current head, or this run could not tell) — and each bot gets an
opportunity-adjusted rate that excludes findings posted after the pull request's last push, which
never had a chance to be acted upon. This is a coarser proxy than a human tracing the code: it cannot
follow a fix that lands in a different file (or a distant function in the same file) for the same
root cause, and it checks each later commit against the finding's original anchor independently
rather than tracking a line's drift through a chain of commits. The pull request that introduced this
heuristic ran it against Keiko #2930 and compared the result finding-by-finding against a hand-verified
manual pass posted on issue #56, including the cases where the two disagree and why.

```bash
npm run arena -- 2926 2924          # writes corpus/evidence/arena-latest.{json,md}
npm run arena -- --since 2026-07-01 # discovers pull requests instead of naming them
node --test corpus/arena-lib.test.mjs # the pure computation's own tests; not part of `npm test`
node --test corpus/arena-fetch.test.mjs # the fetch layer's own tests, including the commit timeline
```

The evidence committed under `corpus/evidence/` started with the first live run, recorded as the
v0.10.0 baseline; the v0.11.0 baseline adds acted-upon linking, run live against Keiko #2930, #2926,
and #2924. Its JSON never carries a comment body — locations, counts, and hashes only, matching this
repository's evidence-redaction discipline; a short quoted stub would still be another bot's
generated prose distributed through this repository, not just this reviewer's own.

## Development

```bash
npm ci
npm run verify            # typecheck, lint, format, test, corpus tests, build, bundle reproducibility
npm run check:engine-pin  # downloads and verifies every pinned engine asset
```

The corpus costs real model tokens, so it is not part of `verify`:

```bash
npm run fetch:engine -- /tmp/ocr        # digest-verified before it becomes executable
OCR_BINARY=/tmp/ocr \
OCR_LLM_URL=... OCR_LLM_TOKEN=... OCR_LLM_MODEL=... \
OCR_REPORT=/tmp/qualification-raw.json npm run corpus
npm run check:qualification -- /tmp/qualification-raw.json
npm run qualification:evidence -- \
  --raw /tmp/qualification-raw.json \
  --out corpus/evidence/qualification-YYYY-MM-DD-vX.Y.Z.json
```

`corpus/run.mjs` builds the rule document from `corpus/profile.json` through the production builder,
so a measurement cannot silently be taken against rule text the product does not ship. Add `--only
<case-id>` to iterate on one case. `.github/workflows/qualify.yml` runs the same thing weekly and
files an issue when the thresholds stop being met.

`OCR_REPORT` is private diagnostic output and must stay outside the repository: it can contain full
finding bodies, including rejected output. `qualification:evidence` is the release boundary. It
copies only fixed identifiers, digests, booleans and counts into a version-bound JSON file and
refuses both a raw report inside the checkout and an output outside `corpus/evidence/`. Release
attestation rejects the raw schema even when its scores are green.

`npm test` runs Vitest, which transpiles without type-checking — it will happily go green on code
`tsc` rejects. Run `npm run verify`, not `npm test`, before believing a change is done.

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
