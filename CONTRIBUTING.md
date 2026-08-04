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

## Advancing the engine pin

The pinned engine is part of the qualified configuration: a different binary invalidates the
evidence the previous one produced.

1. Update the version and **every** platform digest in `src/engine/pinned-release.ts` from the
   upstream release's `sha256sum.txt`.
2. Run `npm run check:engine-pin`, which downloads and verifies every platform — not just yours.
3. Re-run the qualification corpus and record the result.

## Commits and pull requests

- English only, in code, comments, commit messages, and pull requests.
- Conventional-ish imperative subjects: `feat(publish): …`, `fix(engine): …`.
- Explain _why_ in the body. The what is in the diff.
- A behavioural change updates the README or SECURITY.md where it changes what the bot promises.
