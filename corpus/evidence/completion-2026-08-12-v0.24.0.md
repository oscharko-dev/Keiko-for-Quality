# Completion gate — 2026-08-12

Measures one thing only: how often a review of a real, full-size pull request RUNS TO
COMPLETION. Not recall, not precision. See corpus/completion-gate-lib.mjs's header for why a
rate, and not a single verdict, is the answerable form of this question.

- Reviewer under test: keiko-for-quality 0.24.0
- Reviewer tree: ce83f1825f88 (clean)
- Model: gpt-oss-120b (openai)
- Targets: PR #2970 (41 files), PR #3011 (19 files), PR #3089 (79 files)
- **Completion rate: 100.0%** (3/3 graded attempts, threshold 80.0%) — GREEN
- Measurement failures (excluded from the rate): 0
- Total spend (tokens): 4150337

## PR #2970

- Run 1: complete, reviewed 36/36, 5 finding(s), spend 1439736

## PR #3011

- Run 1: complete, reviewed 19/19, 5 finding(s), spend 829438

## PR #3089

- Run 1: complete, reviewed 71/71, 7 finding(s), spend 1881163
