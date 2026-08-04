# Live telemetry — the v0.11.0 baseline (2026-08-04)

The "before" picture, extracted from real consumer runs with `npm run live:telemetry` against
`oscharko-dev/Keiko`, six workflow runs, read-only and without a single model call. It exists so
the v0.12.0 measurement has something honest to be compared against, and it is committed rather
than described because a baseline nobody can re-read is not a baseline.

## What a v0.11.0 run could tell an operator about its own cost

Nothing.

| field | v0.11.0 |
| --- | --- |
| engine tokens | `n/a` |
| classify tokens | `n/a` |
| total tokens | `n/a` |
| requests / prompt / completion tokens | `n/a` |
| cached tokens, cached share | `n/a` |
| published findings, suppression counters | `n/a` |
| duration | reported |
| cache hits / misses | reported |

`n/a` here means the diagnostic never fired, which the extractor deliberately keeps distinct from a
reported zero — a run that measured nothing must never read as a run that measured zero. Every
cost field is in the first state. The run-summary comment's "reported" figure, where it appeared at
all, was the classification audit's own bill rather than the review's, which is the defect
v0.12.0's `run.spend` exists to close.

## What the two genuinely reviewed runs in this sample did report

| run | outcome | duration | cache hits | cache misses |
| ---: | --- | ---: | ---: | ---: |
| 30889585349 | complete | 1,988 ms | 1 | 0 |
| 30889033210 | complete | 90,903 ms | 0 | 6 |

Duration median 46,445 ms, p95 90,903 ms over n=2 — the first real numbers for the latency
baseline issue (#59), and small enough that they are a starting point, not a percentile anyone
should plan against yet.

The pair is also the clearest available illustration of what the review store is worth: a run that
replayed its single eligible file finished in under two seconds without reaching the model at all,
while a run that had to review six files fresh took forty-six times as long. Nothing about the
first run's cost was visible in tokens, because under v0.11.0 no run's was.

The remaining four runs in the sample were skipped at eligibility (dependabot heads, and the pin
change's own closing event), so they report neither cost nor coverage — correctly, since no review
happened.

## How to reproduce and extend

```bash
npm run live:telemetry -- --repo oscharko-dev/Keiko --limit 20 \
  --out corpus/evidence/live-telemetry-<version>.json \
  --md corpus/evidence/live-telemetry-<version>.md
```

The next capture belongs after v0.12.0 has reviewed real pull requests. It should carry what this
one structurally could not: engine and classification spend as separate figures, the provider's
cached-prompt share (the number that decides whether the `prompt_cache_key` injection is doing
anything), tokens per published finding, and the suppression counters — including the intra-run
stage, whose whole purpose is invisible in any measurement taken before it existed.
