# Completion measurement — v0.19.2 (2026-08-06)

The first measurement of a question this repository could not previously answer: **how often does a
review of a real, full-size pull request run to completion?** Two runs of the same two consumer
pull requests, before and after the v0.19.2 adapter fixes.

Read the number as a rate, never as a verdict. `incomplete-never-clean` remains correct — an engine
that genuinely cannot finish a file should say so — but a reviewer that says it nine times in ten
is worthless regardless of how honest each label is. The rate is the product; the label is only its
honesty.

## Result

|                     | before v0.19.2                          | after (partial)   |
| ------------------- | --------------------------------------- | ----------------- |
| **Completion rate** | **25.0%** (1/4)                         | **50.0%** (2/4)   |
| PR #3011 (19 files) | 1 of 2                                  | **2 of 2**        |
| PR #3008 (12 files) | 0 of 2                                  | 0 of 2            |
| Incomplete reasons  | 2× `coverage_gap`, 1× `budget_exceeded` | 2× `coverage_gap` |
| Spend               | 11,621,818 tokens                       | 16,028,633 tokens |

Threshold is 80%. **Both runs are RED**, and this document does not round that up.

## What the second measurement does and does not include

It carries the parser fix (#155), the targeted gap resume (#155), the multi-round loop and the
coverage-counting fix (#156). It does **not** carry #158 — the fix for the exact failure mode that
still dominates it. Both remaining incompletes are PR #3008, whose targeted rounds were starved:

```
engine.status.completed_with_errors → 12 files, 4 subtask errors
engine.resumed_gap_targeted         → targeted 4, covered 8, remaining 398912
engine.resume_failed                → spent 2575985
engine.resume_gap_not_shrinking     → before 4, after 4
settlement.incomplete.coverage_gap  → gap 4, reviewable 12, reviewed 8
```

Four files to review, 399k tokens to do it in, and the round threw. #158 prices a round from the
gap it dispatches instead of from what the first attempt left over. **The next measurement is the
one that tests it**, and it has not been run.

## The mechanism, working, on a real pull request

```
engine.status.completed_with_errors → 19 files, 1 subtask_error
engine.resumed_gap_targeted         → round 1, targeted 1, covered 18
engine.status.success               → 1 file, 0 warnings
settlement.complete
```

That run would previously have settled `incomplete.coverage_gap` over one file out of nineteen.

## What this measurement found in its own instrument

Three defects, all in code written the same day, all found by running it against reality:

1. A run that reviewed **18 of 19** files reported `reviewed 1` — `dispatchedMinusFailed` excludes
   memoized paths from `coveredPaths` by design, the report added back only review-_cache_ hits,
   and a resume-credited path was neither. Fixed in #156.
2. One targeted round is not enough: 19 files, 2 lost, the retry recovered **one**, and the review
   settled incomplete over the single file still missing. Rounds now continue while the gap
   shrinks (#156).
3. A `budget_exceeded` produced by measuring under the CLI's 2M developer default while the
   consumer's workflow passes 6M — a harness artifact wearing a product failure's label (#156).

## Honest limits

- Four graded attempts is a small sample. It is enough to refute "the reviewer finishes reliably"
  and not enough to certify any particular rate.
- Two pull requests, one consumer, one model. Nothing here generalises beyond that pairing.
- Every run is a full-size review, so the measurement costs more than everything else in this
  repository combined. That is the price of asking the question at all.

## Spend

27,650,451 tokens across both measurements. Standing development authorization.
