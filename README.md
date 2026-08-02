# Keiko for Quality

A hardened pull-request reviewer bot. It runs the
[Open Code Review](https://github.com/alibaba/open-code-review) engine over the exact change in a
pull request and publishes each finding as a **resolvable native review conversation**, bound to the
commit it reviewed — with no raw review material in logs or artifacts.

Version 0.1 is a reviewer. It does not write code, commit, push, merge, change branch protection, or
approve pull requests.

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

| Property                                  | How                                                                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The candidate is data, never code         | Content is read as Git objects through plumbing. The tree is never checked out, symlink-followed, or submodule-initialized, and no candidate script, hook, action, or package manager is executed. |
| The engine never holds a GitHub token     | Its environment is built from nothing and contains only the model endpoint, model, protocol, timeouts and its credential.                                                                          |
| No candidate file becomes configuration   | The engine runs with an explicit rule file from a working directory outside candidate content, so its discovery paths — including `<repo>/.opencodereview/rule.json` — are never consulted.        |
| Incomplete is never clean                 | Partial, skipped, failed, unknown, unlisted-warning-bearing, budget-exhausted, timed-out, and malformed results all settle as incomplete and publish a blocking notice.                            |
| Nothing changed is silently unreviewed    | An independent change inventory is computed before the run and reconciled against the engine's coverage manifest afterwards.                                                                       |
| Nothing raw is emitted                    | Diagnostics carry a reason code from a closed vocabulary plus counts, digests, and durations. The type system has no field that can hold free-form text.                                           |
| The engine binary is the one we qualified | Downloaded at a pinned version and verified against a SHA-256 digest held in this repository. A mismatch fails closed.                                                                             |

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

      - uses: oscharko-dev/Keiko-for-Quality@<sha> # v0.1.0
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
  ]
}
```

A changed path matching none of these is **unclassified**, which fails the run. That is deliberate:
an unclassified path is a gap in your coverage statement, and the alternative is a clean-looking
review that quietly skipped something.

### The bot identity

Configure the GitHub App. Deduplication only suppresses a repost when the existing conversation was
authored by _this_ reviewer — and a marker is a public string in a public comment. Under the shared
`github-actions[bot]` identity, any other workflow in the repository can author a comment carrying a
valid-looking marker and silence a real finding.

1. Create a GitHub App with **Pull requests: read & write** and **Contents: read**.
2. Install it on the repository.
3. Store its id and private key as `KFQ_APP_ID` and `KFQ_APP_PRIVATE_KEY`.

Without them the action falls back to `github_token` and posts as the shared Actions identity. It
works; it is weaker; the fallback exists so you can try the reviewer before registering an App.

## Known limitations

Stated plainly, because a reviewer that overstates its coverage is worse than none.

1. **No required status check.** Version 0.1 blocks merges only through review conversations and
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

## Development

```bash
npm ci
npm run verify          # typecheck, lint, format, test, build, bundle reproducibility
npm run check:engine-pin  # downloads and verifies every pinned engine asset
```

`npm test` runs Vitest, which transpiles without type-checking — it will happily go green on code
`tsc` rejects. Run `npm run verify`, not `npm test`, before believing a change is done.

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
