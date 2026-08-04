# Live telemetry — the Keiko#2981 double run, and the black-hole pattern it names (2026-08-04)

Two consecutive full reviews of the same 55-file pull request, ten minutes apart, both incomplete,
7.12M tokens total, one published finding — whose semantics were inverted. This document records
the measurement that drove three same-day fixes. Redaction discipline as everywhere in this
directory: counts, digests, ids — no finding bodies, no model text.

## The two runs

| Metric                               |                                   Run 1 (`d31ec242`, 10:44Z) | Run 2 (`71feaf0a`, 10:54Z) |
| ------------------------------------ | -----------------------------------------------------------: | -------------------------: |
| Reviewable / freshly reviewed        |                                                      55 / 55 |                    55 / 55 |
| Store entries loaded                 |                                                            0 |                      **0** |
| Engine tokens (wire)                 |                                                    3,561,471 |                  3,562,109 |
| Requests (incl. one resume)          |                                                     290 + 66 |                   305 + 52 |
| Cached tokens / `cache_key_rejected` |                                                      0 / 4+4 |                    0 / 4+4 |
| Outcome                              |                     incomplete (`engine_status_not_success`) |          incomplete (same) |
| Findings published                   | 1 (unaudited: `classify.skipped_budget`, remaining −594,611) |                          0 |
| Duration                             |                                                        248 s |                     ~250 s |

Competing coverage on the same pull request: CodeRabbit was rate-limited (no review); a second
competitor published seven findings — including a P1 redirect/trust-boundary issue and a weakened
accessibility assertion — concentrated in paths late in the dispatch order that the truncated runs
plausibly never reached in depth.

## The causal chain (three links, each fixed the same day)

1. **The allotment under-priced the run 1.2x** (2.97M priced vs 3.56M real; the older 40k/file
   constant was corpus-calibrated on single-file cases). The engine's `--max-tokens-budget` stop
   fired mid-run → incomplete. Fixed: `PER_FILE_TOKENS` 40k→64k (live median of n=3 file-cost
   points: 32k, 65k, 200k), floor 80k→150k — at 64k/file this run's allotment is 4.68M and it
   completes.
2. **An incomplete counted-mode run persists nothing** (the documented #75 inertness: no path
   identities without a run manifest), so run 2 loaded an empty store and re-paid the full 3.56M.
   Not separately fixed — completing run 1 (link 1) is the fix; the follow-up push then replays.
3. **The one finding published was unaudited** — the v0.12.0 audit guard subtracted from the
   engine's overshot allotment (remaining −594,611). Already fixed on dev before this run
   (guard subtracts from the consumer ceiling); the fix reaches production with the v0.13.0 pin.
   The finding's semantics were also inverted (a shrinking i18n-literal baseline read as a
   regression) — fixed on the consumer side with a `pathInstructions` entry declaring the
   baseline's direction of progress.

## Accumulated live cost points (v0.12.0, four runs)

| Run             | Files |    Tokens | Tokens/file | Character        |
| --------------- | ----: | --------: | ----------: | ---------------- |
| Keiko#2971      |     5 |   998,192 |       ~200k | dense TS code    |
| Keiko#2980      |     1 |    31,778 |         32k | profile JSON     |
| Keiko#2981 (×2) |    55 | 2 × 3.56M |        ~65k | mixed feature PR |
| Keiko#2982      |     1 |    13,971 |         14k | profile JSON     |

Provider caching remains dead on this deployment in every run (`cache_key_rejected` on each
invocation, `cached_tokens` 0 throughout) — reduction must come from what is sent, and from not
re-sending (completing runs so the store can answer the next push).

## What held

Eligibility gating, the honest incomplete notice ("treat this pull request as unreviewed"), the
self-healing cache-key latch, duplicate suppression (zero duplicate comments across both runs),
and the summary's candid budget line ("80000 allotted, 3562109 reported") all behaved exactly as
designed. The product told the truth about its own failure — the failure was priced, not hidden.
