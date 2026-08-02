# Third-Party Notices

Keiko for Quality is licensed under the Apache License, Version 2.0. This document records
third-party software the product depends on, and the precise nature of each dependency.

## Open Code Review (review engine)

- **Project:** [alibaba/open-code-review](https://github.com/alibaba/open-code-review)
- **Copyright:** Copyright 2026 alibaba/open-code-review Contributors
- **License:** Apache License, Version 2.0
- **Pinned release:** see [`engine/pinned-release.json`](engine/pinned-release.json)

### Nature of the dependency

The engine is **executed as a separate process**, not linked, vendored, bundled, or redistributed.
At run time Keiko for Quality downloads the pinned upstream release binary for the host platform
directly from the upstream GitHub release and verifies it against a SHA-256 digest recorded in this
repository. No engine source or binary is contained in this repository or in any Keiko for Quality
release artifact.

Because the engine is invoked as an independent executable and its output is consumed over a
documented interface, this is an arm's-length combination. The Apache-2.0 terms of the engine apply
to the engine; they do not extend to this repository's own source. The attribution above is provided
because it is due, not because a distribution obligation is triggered — Keiko for Quality distributes
no part of the engine.

### Why the binary release rather than the npm package

Upstream also publishes `@alibaba-group/open-code-review` on npm, and the upstream GitHub Action
installs it with a floating version specifier. Keiko for Quality does not use that channel: a
floating specifier cannot be digest-verified, and this product's threat model requires that the
executed engine be byte-identical to the artifact its qualification corpus was run against.

## Runtime dependencies

**None.** Keiko for Quality has zero production npm dependencies. GitHub API access, GitHub App
token minting, action input and output handling, and archive verification are implemented against
the Node.js standard library.

This is a deliberate supply-chain position: the reviewer runs inside consumers' CI with access to a
model credential and write access to pull-request conversations, so every transitive package it
carried would become a package those consumers implicitly trust.

## Development dependencies

Development-only tooling — TypeScript, ESLint, Prettier, Vitest, esbuild, and their transitive
dependencies — is not distributed in any release artifact and is not present at run time. Their
licenses are recorded in `package-lock.json` and resolvable through the npm registry.
