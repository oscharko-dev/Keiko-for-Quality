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

**Deduplication verifies authorship.** A finding is suppressed only when an existing conversation
carrying its marker was authored by this reviewer's own runtime-resolved identity. A marker inside
anyone else's comment is spoofing and never suppresses publication.

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

- **Fork-originated pull requests.** They are skipped in version 0.1. Model budget and the
  credential-bearing path are not exposed to arbitrary external heads.
- **Availability.** Version 0.1 publishes no required status check, so a workflow that never runs
  cannot be detected by this bot. That is a consumer-side branch-protection concern.
- **Model correctness.** Findings are claims to evaluate. Precision is measured, not guaranteed.
- **The consumer's own workflow.** If the consumer checks out the candidate head instead of the
  base, or grants the job more permission than documented, this bot's guarantees do not apply.

## Supported versions

Version 0.1 is the current release line and the only one receiving fixes.
