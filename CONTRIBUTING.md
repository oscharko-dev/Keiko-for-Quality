# Contributing

## The green bar

```bash
npm ci
npm run verify
```

`verify` runs typecheck, lint, format check, tests, the corpus tests, build, and the bundle
reproducibility check.

**`npm test` alone is not the bar.** Vitest transpiles without type-checking, so it will go green on
code `tsc` rejects and lint refuses. That has already happened once in this repository's short
history; run `verify`.

## Rules that are not negotiable

These follow from what this product is, not from taste.

- **No runtime dependencies.** The bot runs in other people's CI next to a private key. Every
  package it carries becomes one they implicitly trust. Development dependencies are fine.
- **No output outside the diagnostics sink.** The sink's field types cannot hold free-form text,
  which is what makes "no raw content in logs" a property of the code rather than a habit. A
  `console.*` call bypasses that; lint rejects it.
- **Validate at the boundary, with a branded type.** Anything arriving from a diff, the engine, an
  event payload, or the GitHub API passes a validator that returns a branded type. A plain `string`
  will not type-check where a `CommitSha` is expected, so a forgotten check is a compile error.
- **Reject rather than repair.** When published content fails validation, the run settles as
  incomplete. Silently rewriting model output publishes something no one authored.
- **Incomplete may never read as clean.** Any new failure path must settle as incomplete. If you add
  a state the settlement logic does not know, it must fail closed by default.
- **A test must be able to fail.** Before trusting a test that guards a security property, break the
  property and confirm that exactly that test goes red. A test that passes either way proves
  nothing.
- **Every live run we make uses `gpt-oss-120b`.** Qualifications, corpus runs, live telemetry, and
  the reviews this product publishes on its own consumer repository. A qualification is a property
  of the _pairing_ — engine, rule text, and model together — so numbers measured against a model we
  do not run are not weaker evidence, they are none. This binds what **we** measure and deploy, and
  says nothing about what a consumer configures: `model_id` is their input and their decision.
  `corpus/run.mjs` enforces it; see AGENTS.md for the incident that turned it into a rule.

## Advancing the engine pin

The pinned engine is part of the qualified configuration: a different binary invalidates the
evidence the previous one produced.

1. Update the version and **every** platform digest in `src/engine/pinned-release.ts` from the
   upstream release's `sha256sum.txt`.
2. Run `npm run check:engine-pin`, which downloads and verifies every platform — not just yours.
3. Re-run the qualification corpus and record the result.

## Advancing the ast-grep pin

Structural repository retrieval uses a separately pinned ast-grep release when lexical
exact-commit results are ambiguous and may use it to enrich clear hits with bounded owning-function
context. The closed runtime-fact detector uses that same pin against one complete bounded immutable
blob over stdin and can select only versioned catalog text at the exact finding anchor; it never executes candidate code. An unavailable enrichment keeps the exact lexical evidence; an unavailable parser needed
to disambiguate code fails closed. Non-code manifests and lockfiles remain bounded lexical
evidence instead of being routed into an unsupported parser. Update every archive and
extracted-binary digest in
`src/publish/ast-grep-pin.ts`, then run `npm run check:ast-grep-pin`. That explicit audit downloads
and verifies every supported platform; ordinary `npm run verify` deliberately stays offline. The
complete pin is folded into review-cache publication semantics automatically. Because structural
retrieval can change finding evidence, re-run the qualification corpus before shipping a new pin.

## Cutting a release

Run `scripts/release.mjs`, never the steps by hand — AGENTS.md's own section explains which
failure that script exists to make impossible. The phases below are what it does, listed so a
reader knows what is being checked on their behalf.

1. **Run prep on a clean, final source branch.** It moves package/README to the target version,
   builds, verifies and signs the release-candidate commit. Land that candidate on `dev`.
2. **Run all four release measurements** on that clean candidate: qualification, historical replay,
   consumer seed and completion. Keep the raw qualification `OCR_REPORT` outside the repository,
   then create its public record with the `qualification:evidence` command documented in
   `docs/operations.md`. Leave the four new version-scoped reports uncommitted, then run `attest`.
   Attestation accepts no other dirty path; accepts only the explicitly redacted qualification
   schema; binds every report to the candidate and pinned model; requires green
   qualification/seed/completion plus a historical precision gain with at least 75% fixed-finding
   retention and 75% decision coverage. The only exception is the explicit `recovery` channel:
   it still requires the complete, bound historical report and all three safety gates, but may
   record exactly `historical_holdout_fixed_retention_low` as **quality promotion withheld**. It
   never calls that evidence green and rejects every other quality failure. Then it runs the full
   verification chain and signs an evidence-only commit. Land that commit on `dev`. Never pipe `npm run verify` into anything — a
   pipeline exits with its last command's status, so `npm run verify | tail` reads a red chain as
   green. This has shipped a stale bundle once.
3. **Release pull request into `main`,** whose tree must be `dev`'s tree, whole. Before creating it,
   the script proves that the measured candidate is an ancestor of `dev` and that only the target
   version's evidence changed afterwards:
   `git rm -rq . && git checkout origin/dev -- .`, then assert
   `git rev-parse HEAD^{tree}` equals `git rev-parse origin/dev^{tree}`.
4. **Signed tag on the squash commit:** `git tag -s vX.Y.Z <sha> -m "…" && git push origin vX.Y.Z`.
   Consumers pin the SHA, so this is what makes the version name mean something.
5. **GitHub Release for that tag** — the step easiest to forget, because nothing fails without it:
   `gh release create vX.Y.Z --verify-tag --latest --title "…" --notes "…"`. Without it the
   repository's "Latest" keeps naming an older version while the tags have moved on. Missed for
   three consecutive releases (v0.21.0 through v0.21.2) before anyone noticed, which is exactly
   how silent steps behave.
6. **Repin both consumers.** In the consumer workflow `uses:` and `ACTION_PIN` move together — its
   own sync check fails the run otherwise.

## Commits and pull requests

- English only, in code, comments, commit messages, and pull requests.
- Conventional-ish imperative subjects: `feat(publish): …`, `fix(engine): …`.
- Explain _why_ in the body. The what is in the diff.
- A behavioural change updates the README or SECURITY.md where it changes what the bot promises.
