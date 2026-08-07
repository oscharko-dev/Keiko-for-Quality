# Completion gate — 2026-08-07, v0.20.0 release evidence (single-shot mode, KFQ_SINGLE_SHOT=1)

Run with the release candidate's tree (feat/single-shot-review), through the shipped CLI, on
the consumer pull request the agentic loop failed twice. Mode note: this measurement is of the
single-shot runner this release ships behind KFQ_SINGLE_SHOT=1 — the configuration both
consumer workflows enable with this release's pin. Full harness report follows verbatim.

Measures one thing only: how often a review of a real, full-size pull request RUNS TO
COMPLETION. Not recall, not precision. See corpus/completion-gate-lib.mjs's header for why a
rate, and not a single verdict, is the answerable form of this question.

- Reviewer under test: keiko-for-quality 0.19.2
- Reviewer tree: 512b9292502a (DIRTY — not release evidence)
- Model: gpt-oss-120b (openai)
- Targets: PR #3011 (19 files)
- **Completion rate: 100.0%** (3/3 graded attempts, threshold 80.0%) — GREEN
- Measurement failures (excluded from the rate): 0
- Total spend (tokens): 412229

## PR #3011

- Run 1: complete, reviewed 19/19, 1 finding(s), spend 139872
- Run 2: complete, reviewed 19/19, 1 finding(s), spend 135516
- Run 3: complete, reviewed 19/19, 1 finding(s), spend 136841
