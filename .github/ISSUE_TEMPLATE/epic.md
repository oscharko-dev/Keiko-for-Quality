---
name: Epic
about: Plan a coordinated delivery wave with child issues
title: "Epic: "
labels: ["type: epic", "status: new"]
assignees: ""
---

## Summary

Describe the strategic outcome, consumer/maintainer value, and why this epic exists.

## Product Thesis

Explain the product belief this epic validates and the trust or capability it should create.

## Non-goals

- This epic does not:

## Architecture Invariants

- The candidate head is read as Git objects only — never checked out, symlink-followed, or
  executed — and the engine never holds a GitHub token.
- Diagnostics carry a reason code from the closed vocabulary in `src/diagnostics/reason-codes.ts`
  plus counts, digests, and durations; no field may hold free-form text.
- The engine binary executes only after its SHA-256 digest is verified against the pin in
  `src/engine/pinned-release.ts`; a mismatch fails the run closed.
- Incomplete never reads as clean, and coverage is reconciled — by count today, by identity once
  the engine ships a run manifest — before a run may settle complete.
- The bot remains a reviewer only: it publishes review comments bound to the reviewed commit,
  never a review event, and it never emits a committable suggestion block.

## Reuse And No-Duplication Gate

- Before any new implementation is planned, inspect the existing git-plumbing layer, the
  inventory/reconciliation logic, the diagnostics sink and closed vocabulary, the
  publish/sanitization pipeline, the engine wrapper, and the config/profile loader for a helper
  that already does most of this.
- Existing functionality must be reused, extended, or generalized when it can meet the target
  outcome without weakening the redaction contract, the digest pin, or any trust boundary.
- New functionality is allowed only for capability gaps that remain after the existing-capability
  review is recorded in the epic or a required child issue.
- This repository must not grow a second diagnostics vocabulary, a second sanitizer, or a second
  engine wrapper when the existing one can be extended through a documented contract.

## Target Outcome

1. Outcome 1.
2. Outcome 2.
3. Outcome 3.

## Planned Update Impact

Summarize the expected consumer impact for the epic. Child issues and PRs own the final detail.

- Consumer-visible change summary:
- README / SECURITY.md sections expected to change:
- Action inputs, outputs, or the review profile schema expected to change:
- Engine pin expected to advance: yes/no, and to which version:
- Version bump expected: `major | minor | patch`:
- Consumer action required (e.g. re-pin the SHA, update the review profile):

## Child Issues

- [ ] Child issues are created from the current `Feature / Task` template, not as free-form
      issues.
- [ ] Every executable child issue starts with `Parent Epic: #<epic_number>`.
- [ ] Every executable child issue is added as a GitHub sub-issue of this epic so the hierarchy is
      visible without relying on a Markdown link.
- [ ] Child issues are ordered under this epic in the required implementation sequence.

## Required Implementation Order

1. First child issue.
2. Second child issue.
3. Final verification child issue.

## Definition of Done

- [ ] `main` is green on `verify` and `engine pin` **before** any closeout evidence document is
      written. Evidence composed over a red branch is void — it describes a state the repository
      never reached. Fix the branch, then write the evidence; do not write it now and annotate it
      later.
- [ ] Every child was closed only after each of its acceptance criteria had a test that failed
      before the change and passed after. A criterion carried by a test that passes with and
      without the change is not closed, whatever the child issue says.
- [ ] Children were composed by merges, not accumulated as direct commits. An epic whose children
      never met in a merge has never been integrated, and its green children say nothing about it.
- [ ] All child issues are closed with acceptance criteria and expected verification updated.
- [ ] Required GitHub checks (`verify`, `engine pin`) are green on implementation PRs before merge.
- [ ] Reuse, extension, or generalization decisions are recorded for every implemented child issue.
- [ ] Final closure evidence is recorded in the epic or final child issue.
- [ ] Known limitations and follow-ups are documented in
      [Operations](https://github.com/oscharko-dev/Keiko-for-Quality/blob/dev/docs/operations.md#known-limitations)
      or a follow-up issue.

## Expected Verification

- [ ] Each child issue defines its own relevant verification gates.
- [ ] Required GitHub checks: `verify` and `engine pin` on every implementation PR.
- [ ] Each implementation PR records whether existing functionality was reused, extended,
      generalized, or why a new implementation was required.
- [ ] Security review when the candidate-is-data boundary, the engine's environment construction,
      the publication/sanitization path, deduplication authorship, or credential handling changes.
- [ ] Final regression evidence captured in the final child issue.

## Review Settlement and Formal Issue Completion

- [ ] Implementation PRs wait for required GitHub checks before merge.
- [ ] All actionable review findings are fixed or explicitly dispositioned before merge.
- [ ] Child issue Acceptance Criteria and Expected Verification checkboxes are updated only when
      evidence exists.
- [ ] New follow-up issues are either added as sub-issues in the correct order or explicitly
      deferred to a separate epic with rationale.
- [ ] The epic remains open until all child issues are closed and final closure evidence is
      recorded.

## Stop Conditions

- [ ] Stop if the implementation would expand beyond this epic's stated scope.
- [ ] Stop if required acceptance criteria are missing, contradictory, or no longer match the
      linked child issues.
- [ ] Stop if the work requires the model credential, the App private key, candidate/repository
      content, or other token-bearing artifacts outside a redacted diagnostic.
- [ ] Stop if two parallel agents would need to edit the same file scope.
- [ ] Stop if existing functionality can satisfy the outcome through reuse, extension, or
      generalization; update the epic or child issue with the reuse plan instead of implementing a
      duplicate subsystem.
- [ ] Stop if the change would weaken the redaction contract, the candidate-is-data boundary, the
      digest pin, coverage reconciliation, or required `verify`/`engine pin` guarantees.
- [ ] Stop after three CI or review-finding repair attempts with different root causes and report
      the blocker.

## Language and Professional Standard

- All issue work, PR descriptions, code comments, configuration properties, schema fields, README
  updates, Markdown files, and GitHub comments must be written in professional English.
- Use accurate product terminology; when limitations exist, state them precisely without
  prototype-only, placeholder, fake, or informal framing.
- Build production-ready, state-of-the-art solutions while keeping implementation simple,
  maintainable, and focused on the issue scope.
- Be creative and innovative where it improves product quality, but avoid unnecessary special
  cases, speculative abstractions, and process overhead.
