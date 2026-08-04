# Live telemetry — the first v0.12.0 run, and what it measured (2026-08-04)

The consumer pinned v0.12.0 at 08:10Z (Keiko#2979). The first run under that pin carrying the W0
spend surface is run `30894184694` (Keiko#2971, head `aecd70ac6fcb`, 08:57Z, settled complete).
One run is one data point, not a baseline — but this single run answers two questions the whole
optimization program was waiting on, and exposes one defect. Redaction discipline as everywhere in
this directory: counts, digests, ids — no finding bodies, no model text.

## The run, in numbers

| Metric                                  |                                                Value |
| --------------------------------------- | ---------------------------------------------------: |
| Reviewable / freshly reviewed           |                                                5 / 5 |
| Findings published                      |                                                    0 |
| Engine tokens (wire)                    |                                              998,192 |
| Requests (wire)                         |                                                   89 |
| Prompt / completion tokens              |                                     974,102 / 24,090 |
| Cached tokens (provider-reported)       |                                                **0** |
| `cache_key_rejected`                    | 4 per engine invocation (2 invocations — one resume) |
| Allotted budget (`--max-tokens-budget`) |                                               80,000 |
| Duration                                |                                                130 s |

The review store was empty at load (`cache.store_loaded entries:0`): the W6 rule change altered
the rule digest, which keys the store — a designed, once-per-rule-change invalidation. All five
files re-reviewed fresh after a push, at 998k tokens, and produced zero findings.

## Answer 1: provider prompt caching is dead on this deployment

The serving gateway rejects `prompt_cache_key` with 400 — `model.usage` counted
`cache_key_rejected: 4` on each engine invocation (four in-flight requests carried the key before
the first 400 returned; the proxy's self-healing latch then disabled injection for the remainder
of that proxy's lifetime, exactly as designed). Key-less requests report
`prompt_tokens_details.cached_tokens: 0` throughout — the deployment either does not cache prompt
prefixes or does not discount them. Either way: **no measurable cache relief exists on
gpt-oss-120b behind this gateway.** W4's injection mechanics are healthy; the provider does not
play. Every optimization from here must reduce what is _sent_, not hope for discounts on what is
_resent_.

Infrastructure note for the operator, not for this codebase: a deployment with real prefix
caching (or the anthropic protocol path, which has `cache_control`) would discount roughly the
rule share below on every turn past a file's first.

## Answer 2: where 998k tokens actually go

89 requests over 5 files is ~18 model turns per file; every turn resends the full growing
context. The serialized rule file for the consumer's live profile measures **17,061 bytes ≈ 4.6k
tokens** (measured today by serializing `buildRuleFile` over Keiko's committed profile). That
makes the rule share of this run ≈ 89 × 4.6k ≈ **410k of 974k prompt tokens (~42%)**; the rest is
file content and per-turn tool history, both engine-internal. This is also why CP-B measured
−33.7% for the rule-economy bundle on the corpus (single-file cases, rule-dominated) while the
live share sits near 42%: rule compression round 2 is worth roughly −10% live, not another −30%.

## The defect: the allotment under-estimates real spend ~12x, and that kills the audit

`computeAllottedBudget` priced this run at the 80,000-token floor (5 files × 40k `PER_FILE_TOKENS`

- 412 changed lines × 60, ×1.3 margin — under the floor). The engine reported 998,192 — **12.5x
  the allotment — and settled complete**, because `--max-tokens-budget` only stops the engine's
  dispatch loop from _selecting new files_; with five files dispatched immediately, the ceiling
  governs nothing. The summary states both numbers honestly ("80000 allotted, 998192 reported").

The damage is downstream: `auditFreshSurvivors` (v0.12.0's classification audit) guards on
`allotted − engine − classify`, which was **−918k** here. Had this run produced findings, every
one would have been published unaudited (`classify.skipped_budget`). Since live runs evidently
exceed the floor as a matter of course, the v0.12.0 audit is structurally disabled in production —
three individually reasonable parts (corpus-calibrated constants, dispatch-only enforcement,
guard arithmetic) composing to a dead feature. The change-level pass guard shares the same
arithmetic (`CHANGE_PASS_RESERVE_TOKENS` against the same `remaining`).

Fix direction (this wave): the guards' protective purpose is "the audit must not be the reason
the _consumer's_ ceiling is exceeded" — so they must subtract from `config.tokenBudget` (the
consumer's declared ceiling; 6,000,000 in the live workflow), not from the engine's size-scaled
stop-loss. Recalibrating `PER_FILE_TOKENS` itself waits for more than one live data point.

## Latency (issue #59, accumulating)

20 harvested runs: duration median 4,571 ms / p95 129,951 ms over n=7 complete runs. The p95 IS
this run — 130 s for 5 fresh files, far under the ADR-0170 35-minute arming bound. Replay-backed
runs settle in ~2–4.5 s. n remains below the 5-real-PR bar the issue sets; the harvest continues.
