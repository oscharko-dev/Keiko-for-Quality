# Completion gate — 2026-08-09

Measures one thing only: how often a review of a real, full-size pull request RUNS TO
COMPLETION. Not recall, not precision. See corpus/completion-gate-lib.mjs's header for why a
rate, and not a single verdict, is the answerable form of this question.

- Reviewer under test: keiko-for-quality 0.21.2
- Reviewer tree: d62c468a1452 (DIRTY — not release evidence)
- Model: gpt-oss-120b (openai)
- Targets: PR #3011 (19 files)
- **Completion rate: 100.0%** (1/1 graded attempts, threshold 80.0%) — GREEN
- Measurement failures (excluded from the rate): 0
- Total spend (tokens): 248210

## PR #3011

- Run 1: complete, reviewed 19/19, 2 finding(s), spend 248210

## What this measures against

The same pull request v0.21.2's evidence used, so the numbers are directly comparable:

| version                     | what the model sees                            | tokens      | findings |
| --------------------------- | ---------------------------------------------- | ----------- | -------- |
| v0.21.1                     | changed hunks only                             | 148,918     | —        |
| v0.21.2                     | changed hunks + a whole-file verification pass | 203,691     | 1        |
| every file whole (rejected) | the complete file, always                      | 296,123     | 1        |
| **this change**             | the complete file where the change earns it    | **248,210** | **2**    |

The third row is why the ratio rule exists. Sending every file whole cost +45% and bought nothing
on the files where it was absurd — `keiko-contracts/src/index.test.ts` is 68,791 characters carrying
a 627-character change, 110 characters of file per character of diff. The rule keeps fourteen of
this pull request's nineteen files whole and sends the other five down the path that shipped in
v0.21.2, where the verification pass still runs. No band is worse off than before.

Completion is unaffected: 19/19 files, complete, on the first attempt.

**What this does NOT measure.** Whether the findings are better. That is the precision gate's
question, it needs a live window, and the before-value it will be read against is recorded in
`harvest-2026-08-09-baseline-window.md`. Two findings instead of one is not evidence of anything
on its own.
