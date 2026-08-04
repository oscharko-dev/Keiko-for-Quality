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

## Two commands spend real money

`npm run corpus` and `npm run corpus:real` call a real model over a real endpoint — the second one
against however many commits you point it at, and its own header comment records a real multi-file
commit running to several hundred thousand tokens. Neither is part of `verify` for that reason.
Do not run either without the user's explicit go-ahead, and do not reach for one to "double check"
an ordinary change — the deterministic half of the corpus (inventory, placement, sanitization,
settlement) already runs under `npm test`.

The free half of the corpus is invisible to `verify` too: the hermetic `corpus/*.test.mjs` suites
run under `node --test`, which only the coverage lane executes — `npm run verify` can be green over
a red corpus test (it happened on #53: a green verify masked a defused pin until the direct run
surfaced it). After touching anything under `corpus/`, run `node --test corpus/*.test.mjs`
yourself before claiming green.

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

## Landing changes here

- **`dev` is the integration branch and the default.** Ordinary work targets `dev`; native
  auto-merge is enabled, so arm it after opening the pull request and the platform integrates once
  the required checks are green and every conversation is resolved.
- **`main` is the release line.** It advances only through a release pull request carrying `dev`'s
  tree —
  version bump, regenerated `dist/index.js`, and a fresh qualification-corpus run recorded in the
  PR — and every merge to `main` is tagged `vX.Y.Z`. Consumers pin full tag SHAs, so `main` is the
  audit trail ("every commit is a qualified release"), not a consumer surface. From the second release
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
