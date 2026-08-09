# Completion gate — 2026-08-09, v0.21.2 release evidence (precision wave)

RC tree 4e3ad1a, shipped CLI, Keiko#3011. The verification pass adds one model call per file
whose claims need whole-file evidence, so this gate also carries the wave's price: **203,691
tokens against v0.21.1's 148,918 on the identical pull request — +37%.** That is what removing
the dominant false-positive class costs on a 19-file review, stated here rather than discovered
later. Completion itself is unaffected. Verbatim report:

Measures one thing only: how often a review of a real, full-size pull request RUNS TO
COMPLETION. Not recall, not precision. See corpus/completion-gate-lib.mjs's header for why a
rate, and not a single verdict, is the answerable form of this question.

- Reviewer under test: keiko-for-quality 0.21.2
- Reviewer tree: 4e3ad1abb534 (clean)
- Model: gpt-oss-120b (openai)
- Targets: PR #3011 (19 files)
- **Completion rate: 100.0%** (1/1 graded attempts, threshold 80.0%) — GREEN
- Measurement failures (excluded from the rate): 0
- Total spend (tokens): 203691

## PR #3011

- Run 1: complete, reviewed 19/19, 1 finding(s), spend 203691
