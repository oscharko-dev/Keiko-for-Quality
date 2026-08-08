# Completion gate — 2026-08-08, v0.21.0 release evidence (design-system wave)

RC tree b1764bb, shipped CLI, Keiko#3011. Verbatim report:

Measures one thing only: how often a review of a real, full-size pull request RUNS TO
COMPLETION. Not recall, not precision. See corpus/completion-gate-lib.mjs's header for why a
rate, and not a single verdict, is the answerable form of this question.

- Reviewer under test: keiko-for-quality 0.21.0
- Reviewer tree: b1764bbb6cd6 (clean)
- Model: gpt-oss-120b (openai)
- Targets: PR #3011 (19 files)
- **Completion rate: 100.0%** (1/1 graded attempts, threshold 80.0%) — GREEN
- Measurement failures (excluded from the rate): 0
- Total spend (tokens): 146908

## PR #3011

- Run 1: complete, reviewed 19/19, 1 finding(s), spend 146908
