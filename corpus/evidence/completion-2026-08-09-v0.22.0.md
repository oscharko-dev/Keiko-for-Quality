# Completion gate — 2026-08-09

Measures one thing only: how often a review of a real, full-size pull request RUNS TO
COMPLETION. Not recall, not precision. See corpus/completion-gate-lib.mjs's header for why a
rate, and not a single verdict, is the answerable form of this question.

- Reviewer under test: keiko-for-quality 0.21.2
- Reviewer tree: a053051af5e9 (clean)
- Model: gpt-oss-120b (openai)
- Targets: PR #3011 (19 files)
- **Completion rate: 100.0%** (1/1 graded attempts, threshold 80.0%) — GREEN
- Measurement failures (excluded from the rate): 0
- Total spend (tokens): 241006

## PR #3011

- Run 1: complete, reviewed 19/19, 1 finding(s), spend 241006
