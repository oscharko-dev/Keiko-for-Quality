<p align="center">
  <img src="design-system/assets/keiko-logo.svg" alt="Keiko for Quality logo" width="144">
</p>

<h1 align="center">Keiko for Quality</h1>

<p align="center"><strong>Ex experientia disco</strong></p>

<p align="center">
  Governed AI code review for GitHub pull requests.<br>
  It reads content, publishes review conversations, and changes nothing else.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-4EBA87.svg"></a>
  <a href="https://github.com/oscharko-dev/Keiko-for-Quality/actions/workflows/ci.yml"><img alt="Keiko Banking Grade CI contract" src="https://github.com/oscharko-dev/Keiko-for-Quality/actions/workflows/ci.yml/badge.svg?branch=dev"></a>
</p>

<!-- Review-record card, rendered on a schedule by the quality-cards workflow from GitHub API
     data. When quality.keiko.dev is deployed, only the URLs below change to
     https://quality.keiko.dev/widget/oscharko-dev/Keiko-for-Quality.svg . -->
<p align="center">
  <a href="https://github.com/oscharko-dev/Keiko-for-Quality/pulls?q=is%3Apr"><picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/oscharko-dev/Keiko-for-Quality/quality-cards/cards/oscharko-dev/Keiko-for-Quality-light.svg">
    <img src="https://raw.githubusercontent.com/oscharko-dev/Keiko-for-Quality/quality-cards/cards/oscharko-dev/Keiko-for-Quality.svg" width="340" alt="Reviewed by Keiko for Quality — current trailing-30-day PR settlements, findings, released historical-holdout precision, and data timestamp">
  </picture></a>
</p>

<p align="center">
  <sub>Scheduled 30-day snapshot, refreshed every three hours. The card prints its exact data time;
  unknown or incomplete populations appear as an em dash.</sub>
</p>

<p align="center">
  <a href="#overview">Overview</a>
  ·
  <a href="#monitoring">Monitoring</a>
  ·
  <a href="#quickstart">Quickstart</a>
  ·
  <a href="#trust-and-privacy">Trust &amp; privacy</a>
  ·
  <a href="docs/operations.md">Operations</a>
</p>

## Overview

Keiko for Quality turns eligible pull requests into focused, traceable code reviews. It examines
the exact change, checks claims against source evidence, and publishes defensible findings as
native, resolvable GitHub conversations bound to the reviewed commit.

The product is designed for signal, not comment volume:

- **Review where work happens** — findings stay anchored to the relevant file and line.
- **Evidence before publication** — malformed, unsupported, or unsafe output is withheld.
- **One clear run record** — the maintained summary shows coverage, findings, suppression, and
  spend as redacted counts.
- **Honest coverage** — an unfinished review is reported as incomplete, never as clean.

Keiko for Quality is a reviewer only. It never writes code, commits, pushes, merges, approves, or
changes branch protection.

## Monitoring

The monitoring card answers four practical questions without turning operational proxies into
quality claims:

- **Does it finish?** One current, maintained run summary per PR is counted when its own event
  timestamp is in the exact trailing 30 days. `PRs complete` is the share whose real settlement is
  `complete`; the chip shows the newest real settlement.
- **What is it finding?** Findings are review threads created in that same window, excluding fixed
  incomplete-review notices.
- **What measured quality has actually shipped?** `HOLDOUT PREC` is the chronological holdout
  precision from the newest published release's historical replay, labelled with that release
  version. It is a measurement, not a promotion badge: a recovery release may publish only while
  its historical quality promotion is explicitly withheld. The present population is Keiko-based
  and is not claimed as universal accuracy.
- **Is the snapshot fresh?** `DATA AS OF` is the exact UTC collection time, so a failed scheduled
  refresh cannot continue looking current.

Workflow success and thread-resolution percentage are not displayed as quality. If GitHub cannot
provide a complete paginated population, if a bot summary cannot be parsed, or if released evidence
cannot be bound to one immutable release artifact, the affected metric becomes an em dash instead of
a plausible-looking partial value. The pull request's run summary remains the authority for one
specific review.

## Quickstart

1. Create or install the GitHub App and add the model and App credentials described in
   [Operations](docs/operations.md#the-bot-identity).
2. Copy [`examples/review-profile.json`](examples/review-profile.json) to
   `.github/keiko-for-quality.json` and adapt the paths to your repository.
3. Add this trusted-base workflow and replace both `<sha>` placeholders with full 40-character
   commit SHAs:

   ```yaml
   name: keiko-for-quality

   on:
     pull_request_target:
       types: [opened, synchronize, reopened, ready_for_review, edited, converted_to_draft, closed]

   permissions:
     contents: read
     pull-requests: write

   concurrency:
     # Title/body edits get an isolated no-review run; retargets still replace the active review.
     group: >-
       kfq-${{ github.event.pull_request.number }}-${{
         github.event.action == 'edited' && github.event.changes.base == null && github.run_id ||
         'review'
       }}
     cancel-in-progress: true

   jobs:
     review:
       # Keep the base-ref guard and target_branches below identical.
       if: >-
         github.event.pull_request.state == 'open' &&
         github.event.pull_request.draft == false &&
         github.event.pull_request.head.repo.full_name == github.repository &&
         github.event.pull_request.base.ref == 'dev' &&
         (github.event.action != 'edited' || github.event.changes.base != null)
       runs-on: ubuntu-latest
       timeout-minutes: 30
       steps:
         - uses: actions/checkout@<sha> # v7.0.0
           with:
             ref: ${{ github.event.pull_request.base.sha }}
             fetch-depth: 0
             persist-credentials: false

         - name: Fetch candidate head as Git objects
           env:
             GH_TOKEN: ${{ github.token }}
             PR: ${{ github.event.pull_request.number }}
             SERVER_URL: ${{ github.server_url }}
           run: |
             auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
             GIT_CONFIG_COUNT=1 \
               GIT_CONFIG_KEY_0="http.${SERVER_URL}/.extraheader" \
               GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \
               git fetch --no-tags --no-recurse-submodules origin "pull/${PR}/head"

         - uses: oscharko-dev/Keiko-for-Quality@<sha> # v0.24.0
           env:
             KFQ_MODEL_TOKEN: ${{ secrets.KFQ_MODEL_TOKEN }}
           with:
             profile: .github/keiko-for-quality.json
             model_endpoint: https://api.anthropic.com
             model_id: claude-sonnet-5
             model_protocol: anthropic
             model_token_env: KFQ_MODEL_TOKEN
             app_id: ${{ secrets.KFQ_APP_ID }}
             app_private_key: ${{ secrets.KFQ_APP_PRIVATE_KEY }}
             # Keep this value aligned with the base-ref guard above.
             target_branches: dev
   ```

Change the base-ref guard and `target_branches` together. The profile classifies review-relevant
paths, generated artifacts, and intentional exclusions; any changed path it leaves unclassified
makes the run incomplete. Open a ready, same-repository pull request against a configured target
branch to start the first review.

## Trust and privacy

- Review-relevant source, pull-request intent, and bounded repository context are sent to the
  model endpoint you configure. Use only a provider authorized to process that code.
- Candidate content is read as immutable Git objects. It is never checked out, executed,
  symlink-followed, or used as repository configuration.
- The engine receives the model credential, but never a GitHub token. Publication happens later,
  through a separate validated path.
- Pull-request review runs do not write raw model responses to logs or artifacts. Their diagnostics
  contain closed reason codes, counts, digests, and durations; published findings are strictly
  validated and sanitized.
- Fork-originated pull requests are outside the credential-bearing review path. Model correctness
  is measured, not guaranteed: every finding remains a claim for the team to evaluate.

These guarantees depend on the trusted-base workflow above and immutable action pins. See
[SECURITY.md](SECURITY.md) for the complete threat model.

## Run outcomes

| Outcome    | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| Complete   | The run finished under its reported coverage mode; it may still have findings. |
| Incomplete | The review could not prove a trustworthy full result; treat it as unreviewed.  |
| Abandoned  | A newer head superseded the commit before publication completed.               |
| Skipped    | The pull request was not eligible for review.                                  |

## Learn more

- [Operations](docs/operations.md) — inputs, GitHub App setup, local runs, reports, and gates
- [Example review profile](examples/review-profile.json) — a safe starting point for path scope
- [Security policy](SECURITY.md) — threat model and vulnerability reporting
- [Contributing](CONTRIBUTING.md) — quality bar and release discipline
- [Design system](design-system/) — the shared Keiko visual language

<details>
<summary>Build and code-quality evidence</summary>

<p>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko-for-Quality"><img alt="SonarCloud Duplicated Lines Density" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko-for-Quality&metric=duplicated_lines_density"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko-for-Quality"><img alt="SonarCloud Coverage" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko-for-Quality&metric=coverage"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko-for-Quality"><img alt="SonarCloud Reliability Rating" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko-for-Quality&metric=reliability_rating"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko-for-Quality"><img alt="SonarCloud Security Rating" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko-for-Quality&metric=security_rating"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko-for-Quality"><img alt="SonarCloud Maintainability Rating" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko-for-Quality&metric=sqale_rating"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko-for-Quality"><img alt="SonarCloud Technical Debt" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko-for-Quality&metric=sqale_index"></a>
  <a href="https://sonarcloud.io/project/overview?id=oscharko-dev_Keiko-for-Quality"><img alt="SonarCloud Vulnerabilities" src="https://sonarcloud.io/api/project_badges/measure?project=oscharko-dev_Keiko-for-Quality&metric=vulnerabilities"></a>
</p>

</details>

---

<p align="center">
  <sub>Part of <a href="https://github.com/oscharko-dev/Keiko">Keiko</a>.</sub>
</p>
