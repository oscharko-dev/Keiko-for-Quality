# Completion gate — 2026-08-11

Measures one thing only: how often a review of a real, full-size pull request RUNS TO
COMPLETION. Not recall, not precision. See corpus/completion-gate-lib.mjs's header for why a
rate, and not a single verdict, is the answerable form of this question.

- Reviewer under test: keiko-for-quality 0.23.0
- Reviewer tree: 9e6adf12ad5f (clean)
- Model: gpt-oss-120b (openai)
- Targets: PR #3011 (19 files)
- **Completion rate: 100.0%** (3/3 graded attempts, threshold 80.0%) — GREEN
- Measurement failures (excluded from the rate): 0
- Total spend (tokens): 5331758

## PR #3011

- Run 1: complete, reviewed 19/19, 0 finding(s), spend 1623039
- Run 2: complete, reviewed 19/19, 2 finding(s), spend 1855279
- Run 3: complete, reviewed 19/19, 0 finding(s), spend 1853440
