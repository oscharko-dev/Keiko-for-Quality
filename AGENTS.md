# AGENTS.md — Working on Keiko for Quality

README.md, CONTRIBUTING.md, and SECURITY.md are thorough, and the source carries long comments
that explain the reasoning behind most decisions. Read those first. This file holds only what
reading them will not surface in time to save you the cost of finding out the hard way.

## `npm run review`

`src/cli.ts` is the local CLI entry point (epic #94, issue #96). Run `npm run review -- --help`
for the full flag, environment-variable, and exit-code reference; see the README's "Local runs"
section for prerequisites and trust posture. Do not restate either here.

Issue #95 landed `performLocalReview` in `src/review.ts`, so the CLI runs a real review end to
end, through the same shared pipeline `performReview` runs — same digest-pinned engine, same rule
text, same settlement semantics. Issue #99 landed the other end of that sharing:
`corpus/real-diffs.mjs` now drives `performLocalReview` too, instead of hand-rolling its own engine
invocation, so a change to the shared pipeline is proven by one measurement covering both the CLI
and a real commit, not two separate ones. `corpus/run.mjs` (the seeded-defect qualification
harness) still drives the engine through its own harness code — its own migration is a
deliberately separate, not-yet-scoped decision, left alone so the qualification that shipped each
release keeps the same measurement basis it was recorded under (see `corpus/run.mjs`'s own header
comment).

## Four commands spend real money

`npm run corpus`, `npm run corpus:real`, `npm run corpus:seed`, and `npm run corpus:completion`
call a real model over a real endpoint — `corpus:real` against however many commits you point it
at (its own header comment records a real multi-file commit running to several hundred thousand
tokens), `corpus:seed` once per attempt per seed case, and `corpus:completion` **the most of all**:
one full-size pull-request review per run, measured at 1.1M–1.7M tokens each on Keiko#3011. Every
one of them has a `--dry-run` or a cost line; use it first. None is part of `verify` for that
reason. Do not run any of them without the user's explicit go-ahead, and do not reach for one to
"double check" an ordinary change — the deterministic half of the corpus (inventory, placement,
sanitization, settlement) already runs under `npm test`, and both gates' grading logic is
hermetically covered by `corpus/seed-gate.test.mjs` and `corpus/completion-gate.test.mjs`.

## Recall gates cannot see a reviewer that does not finish

The corpus and the consumer-seed gate both ask "does it FIND the defect?", and both run on one- or
two-file diffs. On 2026-08-06 both were green while production could not complete a nineteen-file
review at all — Keiko#3011 burned 1.76M tokens in CI and settled `engine_error`, and 1.63M locally
and settled `coverage_gap`. Neither gate could have caught either, because neither had ever run a
review large enough to fail that way. Green was true and useless.

`npm run corpus:completion` is the answer to that, and it measures a different quantity: the
**rate** at which reviews of real, full-size pull requests run to completion. Read it as a rate and
never as a verdict — a re-run of that same pull request settled `complete` minutes later with the
new retry path never firing, same input, same model. `incomplete-never-clean` stays correct; an
engine that genuinely cannot finish a file should say so. But a reviewer that says it nine times in
ten is worthless however honest each label is. The rate is the product; the label is its honesty.

The free half of the corpus is inside `verify`: `test:corpus` runs the hermetic `corpus/*.test.mjs`
suites under `node --test`, in the chain between `npm test` and `build`, so a red corpus test fails
the local bar and there is no separate run to remember. It has not always been in the chain: on #53
a green verify masked a defused pin until a direct `node --test` run surfaced it, and closing that
gap is what the step is in the chain for.

What did not go away is a naming collision worth knowing before you trust a green CI page: the CI
job named `verify` is not the script named `verify`. The job runs typecheck, lint, format check,
`npm test` and `check:bundle` as separate steps, and `test:corpus` is not among them; the job that
does execute the corpus suites is CI's `SonarCloud` job, through `test:coverage`, and it is skipped
on pull requests from forks because a fork receives no secrets. So on a fork pull request nothing
required exercises the corpus at all, and `npm run verify` locally is the only place it is
guaranteed to run. Read the `verify` job named in the `dist/index.js` section below the same way:
that is the CI job, not the script.

## Every live run this project makes uses `gpt-oss-120b`

Qualification runs, corpus runs, live telemetry, and the reviews this product publishes on its own
consumer repository all run against **`gpt-oss-120b`** over an OpenAI-compatible endpoint. Not as a
default to be overridden when something else is convenient — as the pinned dimension of every
measurement this repository records.

Read the scope precisely, because it is narrow. This is **not** a claim that the product only works
with one model: `model_id` is a consumer input, the protocol adapter supports openai and anthropic,
and what any other consumer configures is their decision and none of this repository's business.
The rule binds what **we** measure and what **we** deploy, nothing else.

Why it is a rule rather than a habit: a qualification is a property of the _pairing_ — engine, rule
text, and model together. Recall and precision measured against a model this project does not run
say nothing about the reviewer that ships, so a run against the wrong model is not a slightly-less
useful measurement, it is not a measurement. On 2026-08-05 a full 32-case v0.14.0 qualification was
run against a different chat model, at real cost, purely because that model happened to be listed
first in a consumer's gateway config; the correct model was already named in the previous release's
own evidence file. That run was discarded and redone. Nothing in this repository stopped it,
which is why this section exists.

In practice: set `OCR_LLM_MODEL=gpt-oss-120b` explicitly before any `npm run corpus` or
`corpus:real`, and never infer the model from the ordering in a config file. `qualify.yml` pins it
for the scheduled run so the weekly re-qualification cannot drift; `corpus/run.mjs` refuses a
different model unless the caller sets `OCR_ALLOW_MODEL_DEVIATION=1`, which exists for a deliberate
cross-model experiment and records itself in the run's own binding line.

## The rule text and the sanitizer must move together

`src/engine/rule-file.ts`'s `CATCH_ALL_RULE` tells the model what it may write. `src/publish/
sanitize.ts` decides what actually gets published. When the two disagree, a correct finding is
discarded before publication and the run reports incomplete — not an error you will see, a finding
you will never see (this has happened: a report about a Windows-incompatible null device was lost
because the rule invited a `<path>` placeholder the sanitizer's HTML check rejects). The only thing
keeping the two aligned is `src/engine/rule-file.test.ts`: it holds hand-written example findings
in the exact shape the rule prescribes and round-trips them through `sanitizeFindingBody` itself —
the real sanitizer, not a copy of its rules. Nothing extracts those examples from the rule text
automatically, so they stay representative only if you keep them so: touch the rule text or a
sanitizer check, and update an example there in the same change. That test failing is the
alignment mechanism, not a formality.

## The include/exclude precedence trap

`classify()` (`src/inventory/classify.ts`) and the engine's own `--rule` filtering resolve an
include/exclude overlap in opposite directions, and getting this wrong has already broken
production once (`fix(engine): stop excluding paths the profile calls review-relevant`, on this
reviewer's first live run against Keiko).

- `classify()` checks `generated` first, then review-relevance, and falls back to `excluded` only
  last — a path the profile calls review-relevant is reviewed even when some exclusion also
  matches it.
- The engine selects the highest-priority rule layer that declares any filter, and inside that
  layer exclude beats include.

`buildRuleFile()` (`src/engine/rule-file.ts`) resolves the mismatch by forwarding only
`profile.generated` to the engine's `exclude` — never `profile.excluded`. Forwarding `excluded`
made the engine drop paths (`docs/qa/**/*.md` in Keiko's own profile, among others) that the
inventory still counted as reviewable, so every touching pull request settled incomplete. If you
change `classify()` or `buildRuleFile()`, re-read the other one before you do: the comment in
`rule-file.ts` names this exact incident, and `rule-file.test.ts` pins the direction, not the
absence of overlap.

## `dist/index.js` is a committed artifact — rebuild it or CI fails

Consumers execute `dist/index.js` (`action.yml` → `runs.main`), and the file is tracked in git.
`npm test`, `typecheck` and `lint` all pass without it being current, so a source change without
`npm run build` looks green locally and then fails CI's `verify` job at `check:bundle`
("dist/index.js is stale"). Worse than the red check is the near-miss it guards against: a pinned
SHA whose executed bundle differs from its reviewed source. Run `npm run verify` — not the
individual commands — before calling any change done, and commit the regenerated `dist/index.js`
with the source that produced it. This exact miss has already cost a CI round in this repository.

## Releases go through `scripts/release.mjs` — never by hand

Every step of a release is in that script, and the reason is one specific failure: the GitHub
Release object for a pushed tag was skipped three times running (v0.21.0, v0.21.1, v0.21.2)
before anyone noticed the repository's front page still advertising v0.20.1. Nothing failed when
that step was missed — no red check, no broken consumer, because consumers pin SHAs and every pin
was correct. What went stale was the only thing a human reads to decide WHAT to pin. A step that
fails silently belongs in a program, not in a memory or a checklist.

```bash
npm run release -- prep    --version X.Y.Z          # version, README pin comment, build, verify, commit
npm run release -- attest  --version X.Y.Z          # validate clean-RC gates, verify, evidence-only commit
npm run release -- release --version X.Y.Z          # release branch off main, dev's tree, identity asserted
npm run release -- publish --version X.Y.Z --sha <main-squash>   # signed tag + GitHub Release + check
npm run release -- repin   --version X.Y.Z --sha <main-squash>   # this repo's self-review pin
npm run release:check                               # any time: newest tag must have a Release
```

Four things the script refuses rather than warns about, each an error already made here:

- **No gate evidence, no release.** `prep` first creates the clean versioned RC. Qualification,
  historical replay, seed and completion run on that commit. The raw qualification `OCR_REPORT`
  stays outside the repository; `npm run qualification:evidence` converts it to the only redacted
  JSON schema `attest` accepts. Attestation then accepts only the four new version-scoped evidence
  files and refuses a report whose version, commit, model or promotion verdict does not match.
  `release` additionally proves the measured RC is an ancestor of `dev` and that only those evidence
  files changed afterwards.
- **`npm run verify` is never piped.** A pipeline exits with its LAST command's status, so
  `npm run verify | tail` reads a red chain as green. That shipped a stale `dist/` on 2026-08-08.
- **The release tree must equal `dev`'s tree**, asserted with `rev-parse HEAD^{tree}`. Its executable
  source must equal the measured RC; only the attested release-evidence delta may follow that RC.
- **The consumer's `uses:` and `ACTION_PIN` move together.** The consumer workflow's own sync
  check fails the run when they disagree; the script counts both rewrites so a half-rewrite stops
  before it is pushed.

The phases are separate because two of them wait on a pull request merging. A script that polled
for that would be claiming to have verified something it only waited for.

## Landing changes here

- **`dev` is the integration branch and the default.** Ordinary work targets `dev`; native
  auto-merge is enabled, so arm it after opening the pull request and the platform integrates once
  the required checks are green and every conversation is resolved.
- **`main` is the release line.** It advances only through a release pull request carrying `dev`'s
  tree — version bump, the README quickstart's `# vX.Y.Z` comment moved with it, regenerated
  `dist/index.js`, a fresh qualification-corpus run recorded in the PR, and a GREEN consumer-seed
  gate (`npm run corpus:seed -- --repo <consumer-checkout>`, evidence in
  `corpus/evidence/seed-gate-*.md`) run with the release candidate's own tree — and every merge to
  `main` is tagged `vX.Y.Z`. The seed gate exists because the corpus measures synthetic fixtures;
  the gate proves the shipping reviewer still finds a planted defect in the consumer's real code,
  through the real CLI surface. No release without it. Since 2026-08-06 a release also carries a
  **completion measurement** (`npm run corpus:completion`, evidence in
  `corpus/evidence/completion-*.md`): the seed gate proves the reviewer can find things, and only
  this one proves it can finish. Both, or no release. Consumers pin full tag SHAs, so `main` is the audit trail ("every
  commit is a qualified release"), not a consumer surface. From the second release
  onward that pull request comes from a `release/vX.Y.Z` branch cut from `main`, not from `dev`
  directly: each release squash leaves a commit on `main` whose content already exists in `dev`'s
  own history, so git reports a conflict on files both sides touched since an older merge base.
  `dev` is always the correct side of that false conflict, and neither remedy is available here —
  merging `main` into `dev` and rebasing `dev` both break linear history and the no-force-push
  rule. So the release branch takes `dev`'s tree WHOLE (`git checkout origin/dev -- .`), and the
  release must assert `HEAD^{tree}` equals `origin/dev^{tree}` before opening the pull request, so
  what ships is the qualified tree rather than the outcome of a hand-resolved merge.
- Both branches carry identical protection: signed commits, linear history, no force pushes,
  conversation resolution, and the required checks `verify`, `engine pin`, and
  `SonarCloud Code Analysis` (verified against the live branch protection). `action smoke` runs on
  every pull request but is _not_ required.
- The scheduled re-qualification (`qualify.yml`) measures `main` explicitly — consumers run
  releases, and drift on `dev` is caught by the corpus run the release rule demands instead.
- Branch names follow `type/slug` (`feat/…`, `fix/…`, `ci/…`, `docs/…`, `release/…`).

## Everything else

Zero runtime dependencies, reject-rather-than-repair, branded types at every trust boundary, no
output outside the diagnostics sink, incomplete-never-clean, and the rest of this repository's
non-negotiable rules are stated once, correctly, in CONTRIBUTING.md. This file does not restate
them.
