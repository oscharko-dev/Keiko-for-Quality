# Qualification — v0.19.2 release candidate (2026-08-06)

Fourth wave of the day. One full 39-case run against `gpt-oss-120b` on the release tree, isolated
opinions per failure. Redaction discipline as everywhere here.

## What this release changes

v0.19.2 is the Keiko#3011 response, and unlike the three waves before it, none of its changes
touch qualified configuration — no rule text, no cases, no sanitizer. What changed is the adapter's
behaviour when the engine's own run goes imperfectly:

- **A malformed finding no longer discards a finished review.** `parseFindings` built its list with
  a single `.map()`, so one structurally invalid finding — the pinned model does emit
  `start_line: 0` — threw a `ValidationError` out of `parseEngineResult`. That error is not an
  `EngineRunError`, so it bypassed the resume path entirely and surfaced as
  `settlement.incomplete.engine_error`. In CI on Keiko#3011 that discarded a nineteen-file review
  after 146 seconds, 188 requests and 1.76M tokens. The refusal is now scoped to the element that
  earned it, counted as `engine.result.findings_rejected`.
- **A finished run retries the files it named as failed.** `engine.resume_skipped_run_completed`
  refused every retry of a finished run — a rule measured against a FULL re-dispatch (Keiko#3002:
  ~all files, ~0.76M tokens, identical failures) and generalised one step too far. When the engine
  names its casualties (`subtask_error` carries the file), the gap has an identity, and rounds now
  continue while it SHRINKS, capped at three, each priced from the gap it dispatches.

## Binding

engine `484a232e017c` (v1.8.4) · rule `5e302d88128a` · cases `437536225fb1` · scorer
`acd8bfc4ef45` · model gpt-oss-120b (openai) · adapter: dev tip carrying #155, #156, #158.

Rule, cases and scorer digests are byte-identical to the v0.19.1 qualification — this wave and that
one are directly comparable, which is the point of leaving qualified configuration alone.

## Scoreboard

recall **27/29** · classified **27/27** · precision **10/10** · publishable **39/39** ·
2,207,077 tokens (56,592 per case) · 1 finding not about its seeded defect.

Identical recall, classification, precision and publishability to the v0.19.1 wave, under an
identical binding.

## Per failure

| case                     | Main run    | Isolated       | Note                                          |
| ------------------------ | ----------- | -------------- | --------------------------------------------- |
| `unevidenced-claim`      | UNEVIDENCED | FAIL, **PASS** | known rotator; passed isolated in v0.19.1 too |
| `workflow-head-checkout` | MISS (6.6k) | FAIL, **PASS** | **first isolated pass today** (17.1k)         |

`workflow-head-checkout` is the case the v0.19.1 evidence flagged: "if it stays dry next wave, it
needs the clean-reset-style calibration pass rather than more draws." It did not stay dry. Its
isolated pass here (17,070 tokens — a real review, not an instant exit) is the first of the day
after 0/2 that morning, under a binding whose rule, cases and scorer digests are unchanged since.
That is a rotator, not a broken case, and the calibration pass the previous evidence pre-authorised
is therefore NOT taken. It stays on the known-rotator list and keeps its watch.

## What this wave does NOT establish

The corpus measures recall and precision on synthetic fixtures. It cannot see whether a review of a
real, full-size pull request finishes at all — the failure that actually took Keiko#3011 down
twice. That question now has its own instrument (`npm run corpus:completion`) and its own evidence
file; this document deliberately does not speak for it.

## Spend

Main run 2,207,077 tokens; four isolated opinions add ~154k. Standing development authorization.
