# AGENTS.md — Working on Keiko for Quality

README.md, CONTRIBUTING.md, and SECURITY.md are thorough, and the source carries long comments
that explain the reasoning behind most decisions. Read those first. This file holds only what
reading them will not surface in time to save you the cost of finding out the hard way.

## `npm run review` does not work

It runs `node --experimental-strip-types src/cli.ts`. `src/cli.ts` does not exist — there is no
local CLI entry point today. To exercise a review by hand, call `performReview` (exported from
`src/index.ts`) directly, or follow the `action-smoke` job in `.github/workflows/ci.yml`, which
drives the built `dist/index.js` with a constructed `GITHUB_EVENT_PATH`.

## Two commands spend real money

`npm run corpus` and `npm run corpus:real` call a real model over a real endpoint — the second one
against however many commits you point it at, and its own header comment records a real multi-file
commit running to several hundred thousand tokens. Neither is part of `verify` for that reason.
Do not run either without the user's explicit go-ahead, and do not reach for one to "double check"
an ordinary change — the deterministic half of the corpus (inventory, placement, sanitization,
settlement) already runs under `npm test`.

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
- **`main` is the release line.** It advances only through a release pull request from `dev` —
  version bump, regenerated `dist/index.js`, and a fresh qualification-corpus run recorded in the
  PR — and every merge to `main` is tagged `vX.Y.Z`. Consumers pin full tag SHAs, so `main` is the
  audit trail ("every commit is a qualified release"), not a consumer surface.
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
