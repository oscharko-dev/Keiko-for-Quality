---
name: Feature / Task
about: Propose a new feature, implementation task, or chore
title: ""
labels: ["type: task", "status: new"]
assignees: ""
---

Parent Epic: #<epic_number>

## Purpose

Describe the goal of this issue and the consumer, maintainer, or governance outcome it must
create.

## Parent Epic Linkage

- [ ] `Parent Epic: #<epic_number>` is present and points to the governing open epic.
- [ ] This issue is linked as a GitHub sub-issue of the parent epic, not only referenced in
      Markdown.

## Existing Capability Review

- [ ] The existing git-plumbing layer, inventory/reconciliation logic, diagnostics sink and closed
      vocabulary, publish/sanitization pipeline, engine wrapper, and config/profile loader were
      inspected before implementation.
- [ ] The issue identifies what will be reused, extended, generalized, or left untouched.
- [ ] Any new implementation is justified as a real capability gap, not a parallel implementation
      of existing behavior.
- [ ] Refactoring or consolidation was considered when existing functionality is close but not yet
      shaped for this issue.

## Expected Verification

- [ ] Required GitHub checks: `verify` and `engine pin`.
- [ ] Reuse/extension/generalization evidence or gap rationale is documented in the issue or
      linked PR.
- [ ] `npm run check:bundle` when the change touches the build, bundling, or anything under
      `dist/` — consumers execute the bundle, not `src/`.
- [ ] `npm run check:engine-pin` when the engine version or any platform digest in
      `src/engine/pinned-release.ts` changes.
- [ ] The qualification corpus (`npm run corpus`) when the rule text, the sanitizer, the
      reconciliation logic, or anything else that could move recall or precision changes; record
      the result even though it is not part of `verify`.
- [ ] `action smoke` (CI) when `action.yml` inputs/outputs, eligibility rules, or the diagnostics a
      consumer sees change.
- [ ] Security review when the candidate-is-data boundary, the engine's environment construction,
      the publication/sanitization path, deduplication authorship, or credential handling changes.

## Review Settlement and Formal Issue Completion

- [ ] The implementation PR waits for required GitHub checks before merge.
- [ ] All actionable review findings are fixed or explicitly dispositioned in the PR before merge.
- [ ] Acceptance Criteria and Expected Verification checkboxes are updated only when evidence
      exists.
- [ ] Required documentation, PR evidence, issue comments, migration notes, logs, or follow-up
      issues are completed when requested by this issue.
- [ ] The issue remains open until implementation is merged, review findings are settled, and
      closure evidence is recorded.

## Stop Conditions

- [ ] Stop if the implementation would expand beyond this issue's stated scope.
- [ ] Stop if required acceptance criteria are missing, contradictory, or no longer match the
      linked epic.
- [ ] Stop if the work requires the model credential, the App private key, candidate/repository
      content, or other token-bearing artifacts outside a redacted diagnostic.
- [ ] Stop if two parallel agents would need to edit the same file scope.
- [ ] Stop if existing functionality can satisfy the issue outcome through reuse, extension, or
      generalization; update the issue or PR with the reuse plan instead of implementing a
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

## Scope

Clearly define what is in scope. Remember: no implementation happens without an issue.

## Out of Scope

List items that are explicitly not part of this issue. Use follow-up issues for deferred scope.

## Update Impact

Complete this section for every change that is release-impacting for a consumer of the action. Use
`Not release-impacting` only when the change has no observable effect on inputs, outputs,
diagnostics, the review profile schema, the engine pin, or a documented guarantee or limitation.

- Consumer-visible change: `not-release-impacting` or a one-line description.
- README / SECURITY.md sections updated:
- Action inputs/outputs affected:
- Diagnostic reason codes affected:
- Engine pin advanced: yes/no, and to which version:
- Version bump: `major | minor | patch`:
- Consumer action required (e.g. re-pin the SHA, update the review profile):

## Deliverables

- [ ] Deliverable 1
- [ ] Deliverable 2

## Acceptance Criteria

- [ ] Criteria 1
- [ ] Criteria 2

## Engineering Notes

Add specific constraints, known implementation risks, and any CONTRIBUTING.md rule or
README/SECURITY.md guarantee this issue touches.
